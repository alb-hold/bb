import { Buffer } from "node:buffer";
import {
  addWritingUsage,
  getWritingUsage,
  setAiServiceSelection,
  updateWritingAssistanceSettings,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  cleanFormattedReply,
  parseCorrectionReply,
  utcDay,
} from "../../src/services/ai/writing-assistance.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function audio(): File {
  return new File([Buffer.alloc(64, 1)], "dictation-1.webm", {
    type: "audio/webm",
  });
}

async function postSegment(
  harness: TestAppHarness,
  fields: { durationMs?: string; context?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.set("file", audio());
  form.set("durationMs", fields.durationMs ?? "4000");
  form.set("context", fields.context ?? "");
  return harness.app.request("/api/v1/writing-assistance/dictation-segments", {
    body: form,
    method: "POST",
  });
}

async function postCorrection(
  harness: TestAppHarness,
  body: { target: string; context?: string; complete?: boolean },
): Promise<Response> {
  return harness.app.request("/api/v1/writing-assistance/corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: body.target,
      context: body.context ?? "",
      complete: body.complete ?? true,
    }),
  });
}

function editsReply(edits: unknown[]): string {
  return JSON.stringify({ edits });
}

describe("writing assistance corrections", () => {
  it("applies safe edits and only suggests meaning changes", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        complete: async () =>
          `<think>checking</think>${editsReply([
            {
              original: "user are",
              replacement: "user is",
              category: "grammar",
              confidence: "high",
              semanticImpact: "none",
              explanation: "agreement",
            },
            {
              original: "talking",
              replacement: "token",
              category: "speech-recognition",
              confidence: "high",
              semanticImpact: "none",
              explanation: null,
            },
            {
              original: "refreshTokn()",
              replacement: "refreshToken()",
              category: "spelling",
              confidence: "high",
              semanticImpact: "none",
              explanation: null,
            },
          ])}`,
      });
      const target =
        "The user are sure the talking from refreshTokn() expires.";
      const response = await postCorrection(harness, { target });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        status: "ok",
        edits: [
          expect.objectContaining({
            original: "are",
            replacement: "is",
            disposition: "apply",
          }),
          expect.objectContaining({
            original: "talking",
            replacement: "token",
            disposition: "suggest",
          }),
        ],
      });
      expect(service.completeCalls[0]?.prompt).toContain(target);
      expect(getWritingUsage(harness.deps.db, utcDay()).corrections).toBe(1);
    });
  });

  it("degrades to a skipped result instead of failing the composer", async () => {
    await withTestHarness({}, async (harness) => {
      const none = await (
        await postCorrection(harness, { target: "Hi there." })
      ).json();
      expect(none).toMatchObject({ status: "skipped", reason: "unavailable" });

      registerFakeAiService(harness.deps.aiServices, {
        complete: async () => "Sure! Here are some thoughts.",
      });
      const unreadable = await (
        await postCorrection(harness, { target: "Hi there." })
      ).json();
      expect(unreadable).toMatchObject({ status: "skipped", reason: "failed" });

      setAiServiceSelection(harness.deps.db, "writing", { mode: "off" });
      const off = await (
        await postCorrection(harness, { target: "Hi there." })
      ).json();
      expect(off).toMatchObject({ status: "skipped", reason: "off" });
    });
  });

  it("stops calling the service once the daily request limit is reached", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        complete: async () => editsReply([]),
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyCorrectionLimit: 1,
      });
      expect(
        (await (await postCorrection(harness, { target: "One." })).json())
          .status,
      ).toBe("ok");
      const limited = await (
        await postCorrection(harness, { target: "Two." })
      ).json();
      expect(limited).toMatchObject({ status: "skipped", reason: "budget" });
      expect(service.completeCalls).toHaveLength(1);
    });
  });

  it("does not call the service when typing correction is off", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices);
      updateWritingAssistanceSettings(harness.deps.db, {
        typingCorrection: "off",
      });
      const off = await (
        await postCorrection(harness, { target: "Hi." })
      ).json();
      expect(off).toMatchObject({ status: "skipped", reason: "off" });
      expect(service.completeCalls).toHaveLength(0);
    });
  });

  it("rejects oversized targets at the boundary", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await postCorrection(harness, {
        target: "a".repeat(2_001),
      });
      expect(response.status).toBe(400);
    });
  });
});

describe("dictation segments", () => {
  it("transcribes, formats, validates and records usage", async () => {
    await withTestHarness({}, async (harness) => {
      updateWritingAssistanceSettings(harness.deps.db, {
        vocabulary: ["Hermes"],
      });
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () =>
          "first check authentication second verify refresh tokens third add integration tests",
        complete: async () =>
          "1. Check authentication.\n2. Verify refresh tokens.\n3. Add integration tests.",
      });
      const response = await postSegment(harness, {
        context: "Plan for Hermes:",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        raw: "first check authentication second verify refresh tokens third add integration tests",
        text: "1. Check authentication.\n2. Verify refresh tokens.\n3. Add integration tests.",
        formatted: true,
      });
      expect(service.transcribeCalls[0]?.options.hint).toBe(
        "Terms: Hermes. Plan for Hermes:",
      );
      const usage = getWritingUsage(harness.deps.db, utcDay());
      expect(usage).toMatchObject({
        dictationSegments: 1,
        audioSeconds: 4,
        formattings: 1,
      });
      expect(usage.estimatedCostMicros).toBeGreaterThan(0);
    });
  });

  it("keeps the transcript when formatting adds words the speaker did not say", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "add integration tests",
        complete: async () =>
          "Add comprehensive integration tests for every endpoint.",
      });
      await expect((await postSegment(harness)).json()).resolves.toEqual({
        raw: "add integration tests",
        text: "add integration tests",
        formatted: false,
      });
    });
  });

  it("does not ask for formatting a segment too long for the reply limit", async () => {
    await withTestHarness({}, async (harness) => {
      const long = Array.from(
        { length: 80 },
        (_, index) => `word${index}`,
      ).join(" ");
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => long,
      });
      await expect((await postSegment(harness)).json()).resolves.toEqual({
        raw: long,
        text: long,
        formatted: false,
      });
      expect(service.completeCalls).toHaveLength(0);
    });
  });

  it("keeps the transcript when formatting drops a negation", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "do not run the migration",
        complete: async () => "Run the migration.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "do not run the migration",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when a list drops a spoken quantity", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () =>
          "check the first endpoint then preserve seven retries",
        complete: async () => "1. Check the endpoint.\n2. Preserve retries.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "check the first endpoint then preserve seven retries",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when a list drops a quantity spoken as its next number", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "first check auth second run two migrations",
        complete: async () => "1. Check auth.\n2. Run migrations.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "first check auth second run two migrations",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when the writing service fails or formatting is off", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
        complete: async () => {
          throw new Error("down");
        },
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "hello there",
        formatted: false,
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dictationFormatting: false,
      });
      await postSegment(harness);
      expect(service.completeCalls).toHaveLength(1);
    });
  });

  it("refuses new audio once the daily dictation minutes are used", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices);
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyDictationMinutes: 1,
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 60 });
      const response = await postSegment(harness);
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        code: "budget_exhausted",
      });
      expect(service.transcribeCalls).toHaveLength(0);
    });
  });

  it("refuses a segment longer than the minutes left today", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyDictationMinutes: 1,
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 50 });
      expect((await postSegment(harness, { durationMs: "4000" })).status).toBe(
        200,
      );
      const refused = await postSegment(harness, { durationMs: "8000" });
      expect(refused.status).toBe(429);
      await expect(refused.json()).resolves.toMatchObject({
        code: "budget_exhausted",
      });
      expect(service.transcribeCalls).toHaveLength(1);
    });
  });

  it("validates the segment duration", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices);
      expect((await postSegment(harness, { durationMs: "abc" })).status).toBe(
        400,
      );
      expect(
        (await postSegment(harness, { durationMs: "999999" })).status,
      ).toBe(400);
    });
  });
});

describe("writing assistance settings route", () => {
  it("round-trips settings and rejects unknown values", async () => {
    await withTestHarness({}, async (harness) => {
      const put = await harness.app.request(
        "/api/v1/writing-assistance/settings",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "developer",
            vocabulary: ["bb", "Hermes"],
          }),
        },
      );
      expect(put.status).toBe(200);
      await expect(put.json()).resolves.toMatchObject({
        settings: { mode: "developer", vocabulary: ["bb", "Hermes"] },
      });
      const bad = await harness.app.request(
        "/api/v1/writing-assistance/settings",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "shouty" }),
        },
      );
      expect(bad.status).toBe(400);
      const view = await (
        await harness.app.request("/api/v1/writing-assistance")
      ).json();
      expect(view.settings.mode).toBe("developer");
    });
  });
});

describe("reply parsing", () => {
  it("keeps valid edits and drops malformed ones", () => {
    expect(
      parseCorrectionReply(
        'Here you go: {"edits":[{"original":"a","replacement":"b","category":"spelling","confidence":"high","semanticImpact":"none"},{"original":"","replacement":"x"}]}',
      ),
    ).toEqual([
      {
        original: "a",
        replacement: "b",
        category: "spelling",
        confidence: "high",
        semanticImpact: "none",
        explanation: null,
      },
    ]);
    expect(parseCorrectionReply("no json")).toBeNull();
  });

  it("keeps the complete edits of a reply cut off by the output limit", () => {
    const edit =
      '{"original":"acessing","replacement":"accessing","category":"spelling","confidence":"high","semanticImpact":"none","explanation":"typo {x}"}';
    expect(
      parseCorrectionReply(`{"edits":[${edit},{"original":"user are","repla`),
    ).toEqual([
      {
        original: "acessing",
        replacement: "accessing",
        category: "spelling",
        confidence: "high",
        semanticImpact: "none",
        explanation: "typo {x}",
      },
    ]);
    expect(parseCorrectionReply('{"edits":[{"original":"a')).toEqual([]);
  });

  it("unwraps fenced formatting replies", () => {
    expect(cleanFormattedReply("```\nHello there.\n```")).toBe("Hello there.");
    expect(cleanFormattedReply("   ")).toBeNull();
  });
});
