import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { measureAudioSeconds } from "../../src/services/ai/audio-duration.js";

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url)),
  );
}

function element(
  id: number[],
  payload: number[],
  unknownSize = false,
): number[] {
  const size = unknownSize
    ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    : [
        0x10 | (payload.length >> 24),
        (payload.length >> 16) & 0xff,
        (payload.length >> 8) & 0xff,
        payload.length & 0xff,
      ];
  return [...id, ...size, ...payload];
}

function liveWebm(blocks: number[][], codec = "A_OPUS"): Uint8Array {
  const codecId = [...codec].map((char) => char.charCodeAt(0));
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    element([0xae], element([0x86], codecId)),
  );
  const cluster = element(
    [0x1f, 0x43, 0xb6, 0x75],
    [
      ...element([0xe7], [0x00]),
      ...blocks.flatMap((block) => element([0xa3], block)),
    ],
    true,
  );
  return Uint8Array.from([
    ...element(
      [0x1a, 0x45, 0xdf, 0xa3],
      element([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d]),
    ),
    ...element([0x18, 0x53, 0x80, 0x67], [...tracks, ...cluster], true),
  ]);
}

function opusBlock(toc: number[], flags = 0x80): number[] {
  return [0x81, 0x00, 0x00, flags, ...toc, 0x00, 0x00];
}

describe("measureAudioSeconds", () => {
  it.each([
    ["chromium-mediarecorder-3s.webm", 3],
    ["tone-3s.webm", 3],
    ["tone-3s.ogg", 3],
    ["tone-3s.m4a", 3],
    ["tone-3s-fragmented.mp4", 3],
    ["tone-3s-he-aac.m4a", 3],
    ["tone-3s.mp3", 3],
    ["tone-1s.wav", 1],
  ])("measures %s from its encoded frames", (name, seconds) => {
    const measured = measureAudioSeconds(fixture(name));
    expect(measured).not.toBeNull();
    expect(measured!).toBeGreaterThanOrEqual(seconds);
    expect(measured!).toBeLessThan(seconds * 1.1);
  });

  it("counts every Opus frame in a live recording with unknown-size segment and cluster", () => {
    const twentyMs = opusBlock([0xf8]);
    expect(
      measureAudioSeconds(liveWebm(Array(150).fill(twentyMs))),
    ).toBeCloseTo(3, 5);
    const tenFrames = opusBlock([0xfb, 0x0a]);
    expect(
      measureAudioSeconds(liveWebm(Array(30).fill(tenFrames))),
    ).toBeCloseTo(6, 5);
    const twoFrames = opusBlock([0xf9]);
    expect(
      measureAudioSeconds(liveWebm(Array(10).fill(twoFrames))),
    ).toBeCloseTo(0.4, 5);
  });

  it("refuses laced blocks, other codecs, truncated files and unknown formats", () => {
    expect(measureAudioSeconds(liveWebm([opusBlock([0xf8], 0x82)]))).toBeNull();
    expect(
      measureAudioSeconds(liveWebm([opusBlock([0xf8])], "A_VORBIS")),
    ).toBeNull();
    const webm = fixture("tone-3s.webm");
    expect(measureAudioSeconds(webm.subarray(0, webm.length - 3))).toBeNull();
    const mp4 = fixture("tone-3s.m4a");
    expect(measureAudioSeconds(mp4.subarray(0, mp4.length - 3))).toBeNull();
    expect(measureAudioSeconds(new Uint8Array(64).fill(1))).toBeNull();
  });
});
