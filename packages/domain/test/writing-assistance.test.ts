import { describe, expect, it } from "vitest";
import {
  classifyWritingChange,
  findProtectedSpans,
  resolveWritingEdits,
  validateFormattedTranscript,
  type ProposedWritingEdit,
} from "../src/writing-assistance.js";

function proposal(
  original: string,
  replacement: string,
  overrides: Partial<ProposedWritingEdit> = {},
): ProposedWritingEdit {
  return {
    original,
    replacement,
    category: "grammar",
    confidence: "high",
    semanticImpact: "none",
    explanation: null,
    ...overrides,
  };
}

function protectedTexts(text: string, vocabulary: string[] = []): string[] {
  return findProtectedSpans(text, vocabulary).map((span) =>
    text.slice(span.start, span.end),
  );
}

describe("findProtectedSpans", () => {
  it("protects code, paths, identifiers, flags, constants, versions and URLs", () => {
    const text =
      "Run `pnpm test` in apps/server/src then call refreshToken() on user_id with --force, GET https://x.dev/a?b=1 returns 401 on v2.3.1 for AuthService.verify and MAX_RETRIES";
    expect(protectedTexts(text)).toEqual(
      expect.arrayContaining([
        "`pnpm test`",
        "apps/server/src",
        "refreshToken()",
        "user_id",
        "--force",
        "GET",
        "https://x.dev/a?b=1",
        "401",
        "v2.3.1",
        "AuthService.verify",
        "MAX_RETRIES",
      ]),
    );
  });

  it("protects user vocabulary only on word boundaries", () => {
    const text = "Ask Hermes, not Hermeslike tools.";
    expect(protectedTexts(text, ["Hermes"])).toEqual(["Hermes"]);
  });

  it("does not protect ordinary prose or list numbers", () => {
    expect(protectedTexts("1. check the login flow and fix it")).toEqual([]);
  });
});

describe("classifyWritingChange", () => {
  it.each([
    ["are", "is", "agreement"],
    ["expire", "expires", "agreement"],
    ["acessing", "accessing", "spelling"],
    ["the user", "The user", "surface"],
    ["endpoint", "endpoint.", "surface"],
    ["talking", "token", "content"],
    ["allow", "deny", "content"],
    ["is not", "is", "content"],
  ] as const)("%s → %s is %s", (from, to, kind) => {
    expect(classifyWritingChange(from, to)).toBe(kind);
  });
});

describe("resolveWritingEdits", () => {
  const base = {
    behavior: "automatic" as const,
    vocabulary: [],
    complete: true,
  };

  it("auto-applies the safe agreement fix from the spec", () => {
    const target = "The user are authenticated before accessing the endpoint.";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("user are", "user is")],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "are",
        replacement: "is",
        start: target.indexOf("are"),
        disposition: "apply",
      }),
    ]);
  });

  it("splits a bundled multi-word fix into safe per-word edits", () => {
    const target = "Voce pode verificar a configuracao do servidor?";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal(
          "Voce pode verificar a configuracao",
          "Você pode verificar a configuração",
          { category: "spelling" },
        ),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "Voce",
        replacement: "Você",
        disposition: "apply",
      }),
      expect.objectContaining({
        original: "configuracao",
        replacement: "configuração",
        start: target.indexOf("configuracao"),
        disposition: "apply",
      }),
    ]);
  });

  it("keeps a bundled rewrite whole when any word changes meaning", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "Voce pode apagar a configuracao do servidor?",
      proposals: [
        proposal(
          "Voce pode apagar a configuracao",
          "Você pode salvar a configuração",
          {
            category: "spelling",
          },
        ),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        disposition: "suggest",
        semanticImpact: "possible",
      }),
    ]);
  });

  it("auto-applies removing an accidentally repeated word", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "Check the the cache before the deploy.",
      proposals: [proposal("the the cache", "the cache")],
    });
    expect(edits).toEqual([
      expect.objectContaining({ disposition: "apply", semanticImpact: "none" }),
    ]);
  });

  it("only suggests removing a repeat that can be grammatical or is not adjacent", () => {
    const grammatical = resolveWritingEdits({
      ...base,
      target: "I had had enough of the flaky test.",
      proposals: [proposal("had had", "had")],
    });
    expect(grammatical.map((edit) => edit.disposition)).toEqual(["suggest"]);
    const distant = resolveWritingEdits({
      ...base,
      target: "Check the cache before the deploy.",
      proposals: [proposal("the deploy", "deploy")],
    });
    expect(distant.map((edit) => edit.disposition)).toEqual(["suggest"]);
  });

  it("never auto-applies a content-word swap even at high confidence", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "The authentication talking expires before the refresh request.",
      proposals: [
        proposal("talking", "token", {
          category: "speech-recognition",
          semanticImpact: "none",
        }),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "talking",
        replacement: "token",
        disposition: "suggest",
        semanticImpact: "possible",
      }),
    ]);
  });

  it("drops edits that touch protected identifiers, paths or numbers", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "Call refreshTokne() in src/athu.ts with 3000 retries.",
      proposals: [
        proposal("refreshTokne()", "refreshToken()", { category: "spelling" }),
        proposal("src/athu.ts", "src/auth.ts", { category: "spelling" }),
        proposal("3000", "300", { category: "spelling" }),
      ],
    });
    expect(edits).toEqual([]);
  });

  it("drops ambiguous, missing and overlapping originals", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "the cat and the dog",
      proposals: [
        proposal("the", "The", { category: "capitalization" }),
        proposal("bird", "Bird"),
        proposal("the cat", "The kitty", { category: "word-choice" }),
        proposal("cat and", "cats and"),
      ],
    });
    expect(edits.map((edit) => edit.replacement)).toEqual(["The kitty"]);
  });

  it("only suggests when the behavior is suggest or the sentence is unfinished", () => {
    const proposals = [proposal("user are", "user is")];
    const target = "The user are authenticated";
    expect(
      resolveWritingEdits({
        ...base,
        behavior: "suggest",
        target,
        proposals,
      })[0]?.disposition,
    ).toBe("suggest");
    expect(
      resolveWritingEdits({ ...base, complete: false, target, proposals })[0]
        ?.disposition,
    ).toBe("suggest");
    expect(
      resolveWritingEdits({ ...base, behavior: "off", target, proposals }),
    ).toEqual([]);
  });

  it("only auto-applies when the model reports no semantic impact", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "It work fine.",
      proposals: [
        proposal("It work", "It works", { semanticImpact: "possible" }),
      ],
    });
    expect(edits[0]?.disposition).toBe("suggest");
  });
});

describe("validateFormattedTranscript", () => {
  it("accepts punctuation and a numbered list built from spoken ordinals", () => {
    expect(
      validateFormattedTranscript(
        "first check authentication second verify refresh tokens third add integration tests",
        "1. Check authentication.\n2. Verify refresh tokens.\n3. Add integration tests.",
      ),
    ).toEqual({ ok: true });
  });

  it("accepts question inference without new words", () => {
    expect(
      validateFormattedTranscript(
        "I think the access token expires too early could this explain the unauthorized response",
        "I think the access token expires too early. Could this explain the unauthorized response?",
      ),
    ).toEqual({ ok: true });
  });

  it("accepts Brazilian Portuguese and code-switching without translating", () => {
    expect(
      validateFormattedTranscript(
        "precisamos corrigir o refresh token antes do deploy",
        "Precisamos corrigir o refresh token antes do deploy.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "precisamos corrigir o refresh token",
        "We need to fix the refresh token.",
      ),
    ).toEqual({ ok: false, reason: "added-words" });
  });

  it("rejects added requirements and changed numbers", () => {
    expect(
      validateFormattedTranscript(
        "add integration tests",
        "Add comprehensive integration tests.",
      ),
    ).toEqual({ ok: false, reason: "added-words" });
    expect(
      validateFormattedTranscript(
        "set the timeout to 3000",
        "Set the timeout to 300.",
      ),
    ).toEqual({ ok: false, reason: "added-words" });
  });

  it("rejects a rewrite that loses a protected identifier", () => {
    expect(
      validateFormattedTranscript(
        "rename user_id in the schema",
        "Rename user id in the schema.",
      ),
    ).toEqual({ ok: false, reason: "protected" });
  });

  it("rejects a formatting that drops most of what was said", () => {
    expect(
      validateFormattedTranscript(
        "please make sure the login form validates the email field and shows an error",
        "Validate email.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });

  it("allows filler removal and self-corrections", () => {
    expect(
      validateFormattedTranscript(
        "um we should deploy on monday no wait on tuesday",
        "We should deploy on Tuesday.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "use the staging database quer dizer o banco de produção",
        "Use o banco de produção.",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a fluent rewrite that loses a negation", () => {
    expect(
      validateFormattedTranscript(
        "do not run the migration on production",
        "Run the migration on production.",
      ),
    ).toEqual({ ok: false, reason: "negation" });
    expect(
      validateFormattedTranscript(
        "don't delete the cache actually just clear it",
        "Delete the cache, just clear it.",
      ),
    ).toEqual({ ok: false, reason: "negation" });
    expect(
      validateFormattedTranscript(
        "não apague o arquivo de log",
        "Apague o arquivo de log.",
      ),
    ).toEqual({ ok: false, reason: "negation" });
  });

  it("rejects a reply that silently loses the end of what was said", () => {
    expect(
      validateFormattedTranscript(
        "check the login flow then verify the refresh tokens and add tests for the logout endpoint",
        "Check the login flow, then verify the refresh tokens.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });

  it("checks literal code output instead of trusting it", () => {
    const literal = { literalCode: true };
    expect(
      validateFormattedTranscript(
        "call refresh token with dash dash force",
        "call refreshToken with --force",
        [],
        literal,
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "call refresh token with dash dash force",
        "call refreshToken with --force && rm -rf build",
        [],
        literal,
      ),
    ).toEqual({ ok: false, reason: "added-words" });
    expect(
      validateFormattedTranscript(
        "do not call refresh token",
        "call refreshToken()",
        [],
        literal,
      ),
    ).toEqual({ ok: false, reason: "negation" });
  });

  it("only drops number words that enumerate the list in order", () => {
    expect(
      validateFormattedTranscript(
        "check the first endpoint then preserve seven retries",
        "1. Check the endpoint.\n2. Preserve retries.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
    expect(
      validateFormattedTranscript(
        "first check auth second run three migrations",
        "1. Check auth.\n2. Run migrations.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
    expect(
      validateFormattedTranscript(
        "primeiro verificar o login segundo rodar os testes",
        "1. Verificar o login.\n2. Rodar os testes.",
      ),
    ).toEqual({ ok: true });
  });

  it("drops list connectors and repeated words only when safe", () => {
    expect(
      validateFormattedTranscript(
        "first check auth and then second add the the tests",
        "1. Check auth.\n2. Add the tests.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "check auth and add tests",
        "Check auth, add tests.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });
});
