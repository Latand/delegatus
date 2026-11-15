import { expect, test } from "bun:test";
import { createMediaTextStream } from "./mediaTextStream";

test("ordinary JSON, prose, UTF-8 and incomplete namespace prefixes retain exact text", () => {
  for (const text of ['{ "image description": "ordinary data" }', "I am", "Медіа й дані лишаються текстом.", "data:image", "media", "media_", "media_kit", "m"]) {
    const stream = createMediaTextStream();
    expect(Array.from(text, char => stream.write(char)).join("") + stream.finish()).toBe(text);
  }
});

test("bounded JSON suppression resumes after large, nested or cancelled image envelopes", () => {
  const pixels = "aW1hZ2U=".repeat(2048);
  for (const parts of [
    ['{"type":"image","data":"', pixels, '"} caption.'],
    ['{"type":"image","data":"', pixels],
    ["[".repeat(65), pixels, "]".repeat(65)],
    ['{"type":"image"]', pixels, "}"],
  ]) {
    const stream = createMediaTextStream();
    const safe = parts.map(part => stream.write(part)).join("") + stream.finish();
    expect(safe).not.toContain(pixels);
    expect(safe.length).toBeLessThan(100);
    expect(stream.write("ordinary text.") + stream.finish()).toBe("ordinary text.");
  }
});
