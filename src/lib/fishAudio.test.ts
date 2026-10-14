import { expect, test } from "bun:test";
import { fishAudioFreeDate, ttsProviderName } from "./fishAudio";

test("every read-aloud provider is shown under its display name", () => {
  expect(["openai", "elevenlabs", "soniox", "fishaudio"].map(ttsProviderName)).toEqual(["OpenAI", "ElevenLabs", "Soniox", "Fish Audio"]);
  expect(ttsProviderName("other")).toBe("other");
});

test("the free-until date holds together on one line in each language", () => {
  expect(fishAudioFreeDate("en")).toBe("November 30, 2026");
  expect(fishAudioFreeDate("uk")).toBe("30 листопада 2026");
  for (const locale of ["en", "uk"]) expect(fishAudioFreeDate(locale)).not.toContain(" ");
});
