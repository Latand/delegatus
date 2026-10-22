import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CUE_ASSET_DIR, EVENT_PRIORITY, eventRank, isPriorityCue, TYPING_SLICES, typingAsset, typingAssetAll } from "./cues";

const CUES_DIR = path.join(process.cwd(), "public", CUE_ASSET_DIR);

describe("the kept typing effect", () => {
  test("a slice is drawn deterministically from the eight", () => {
    expect(typingAsset(() => 0)).toBe(`${CUE_ASSET_DIR}/tool-tick-1.mp3`);
    expect(typingAsset(() => 0.5)).toBe(`${CUE_ASSET_DIR}/tool-tick-5.mp3`);
    expect(typingAsset(() => 0.9999)).toBe(`${CUE_ASSET_DIR}/tool-tick-8.mp3`);
  });

  test("warming covers every slice", () => {
    expect(typingAssetAll()).toEqual(TYPING_SLICES.map((file) => `${CUE_ASSET_DIR}/${file}`));
    expect(TYPING_SLICES).toHaveLength(8);
  });

  test("the eight slices ship byte for byte, and they are the only cue files left", () => {
    /* The operator kept the original typing (2026-10-22); every other sound is
       synthesized, so the retired sample cues are gone from the bundle. */
    expect(fs.readdirSync(CUES_DIR).sort()).toEqual([...TYPING_SLICES].sort());
    const digests = TYPING_SLICES.map((file) => createHash("sha256").update(fs.readFileSync(path.join(CUES_DIR, file))).digest("hex").slice(0, 16));
    expect(digests).toEqual([
      "b7500cee6254ed51",
      "f502703f9a405336",
      "730a20f01effb152",
      "248a0ec10735638a",
      "46015e6e80838bcd",
      "56e65dbb262b43b6",
      "5a8936d0a5dc357a",
      "4170d83d5607c79d",
    ]);
  });
});

describe("the event lane's order", () => {
  test("S6 > S7 > S8 > S5 > S4 > S9 > S3", () => {
    expect(EVENT_PRIORITY).toEqual(["your-move", "fault", "reply", "released", "landed", "launched", "step"]);
    expect(eventRank("your-move")).toBeGreaterThan(eventRank("fault"));
    expect(eventRank("launched")).toBeGreaterThan(eventRank("step"));
  });

  test("only the two sounds that need the operator duck the music", () => {
    expect(isPriorityCue("your-move")).toBe(true);
    expect(isPriorityCue("fault")).toBe(true);
    for (const cue of ["typing", "distant-typing", "reply", "released", "landed", "launched", "step"] as const) expect(isPriorityCue(cue)).toBe(false);
  });
});
