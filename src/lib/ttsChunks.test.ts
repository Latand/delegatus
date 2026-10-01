import { describe, expect, test } from "bun:test";

import { MAX_TTS_TEXT_LENGTH } from "./tts";
import { chunkSpeech, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS } from "./ttsChunks";

function sentences(count: number, word = "sentence"): string {
  return Array.from({ length: count }, (_, index) => `This is ${word} number ${index} in the answer.`).join(" ");
}

describe("chunkSpeech (#1022)", () => {
  test("a message that fits one chunk stays a single request", () => {
    const text = "Short answer that fits in one synthesis request.";
    expect(chunkSpeech(text)).toEqual([{ index: 0, text, start: 0, end: text.length }]);
  });

  test("empty and whitespace-only messages produce no chunks", () => {
    expect(chunkSpeech("")).toEqual([]);
    expect(chunkSpeech("   \n\n\t ")).toEqual([]);
  });

  test("every chunk is an exact slice of the source, in order and without gaps in the text", () => {
    const source = sentences(80);
    const chunks = chunkSpeech(source);
    expect(chunks.length).toBeGreaterThan(1);
    let previousEnd = -1;
    for (const chunk of chunks) {
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(chunk.start).toBeGreaterThan(previousEnd);
      previousEnd = chunk.end;
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    /* Nothing is dropped: the spoken words survive the split. */
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(source);
  });

  test("chunks stay inside the size band and never break a word", () => {
    const chunks = chunkSpeech(sentences(120));
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^\s|\s$/);
      expect(chunk.text[0]).toMatch(/\S/);
    }
  });

  test("splits on sentence boundaries, not mid-sentence", () => {
    const chunks = chunkSpeech(sentences(40));
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text).toMatch(/[.!?…]["'”’)\]]*$/);
  });

  test("prefers a paragraph break once the chunk is long enough", () => {
    const source = `${sentences(12, "alpha")}\n\n${sentences(12, "beta")}`;
    const chunks = chunkSpeech(source);
    const crossing = chunks.filter((chunk) => chunk.text.includes("alpha") && chunk.text.includes("beta"));
    expect(crossing).toEqual([]);
  });

  test("a URL is never cut, not even by the dots inside it", () => {
    const url = "https://example.com/docs/v1.2.3/guide.html?query=a.b.c#section.4";
    const source = `${sentences(20, "before")} ${url} ${sentences(20, "after")}`;
    const chunks = chunkSpeech(source);
    expect(chunks.filter((chunk) => chunk.text.includes(url))).toHaveLength(1);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/https:\/\/example\.com\/docs\/v1\.2\.3\/guide\.html\?query=a\.b\.c#section\.4.$/);
    }
  });

  test("an unbreakable token longer than the chunk ceiling survives whole", () => {
    const giant = `https://example.com/${"segment/".repeat(200)}end`;
    const chunks = chunkSpeech(`Look here. ${giant} Done reading.`);
    expect(chunks.some((chunk) => chunk.text.includes(giant))).toBe(true);
  });

  test("a single sentence longer than the ceiling splits on whitespace only", () => {
    const source = `${"word ".repeat(600)}end.`;
    const chunks = chunkSpeech(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^word/);
      expect(chunk.text).toMatch(/(word|end\.)$/);
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  test("no chunk can exceed what one request may carry, whatever the text is", () => {
    /* A bare blob (no scheme, no backticks) reaches the chunker intact. It has
       no word boundary to respect, and the per-request ceiling still has to
       hold or the route refuses the chunk with a 413. */
    const blob = "A".repeat(MAX_TTS_TEXT_LENGTH * 2 + 137);
    const chunks = chunkSpeech(`Here is the payload. ${blob} That was it.`);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_TTS_TEXT_LENGTH);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain(blob);
  });

});

describe("Soniox sentence policy", () => {
  test("short answers emit the first sentence, then at most three sentences", () => {
    const source = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const chunks = chunkSpeech(source, { backend: "soniox" });
    expect(chunks.map((c) => c.text)).toEqual(["First sentence.", "Second sentence. Third sentence. Fourth sentence.", "Fifth sentence."]);
    expect(chunkSpeech(source)).toHaveLength(1);
  });
  test("exact slices preserve every character across codepoint caps and paragraphs", () => {
    for (const source of ["Я".repeat(1800), "😀".repeat(1100), "word ".repeat(420), "Dr. Smith paid 3.14 dollars. He said ‘Done!’\n\nНаступний абзац. Ще речення.", "Heading\nList item\nAnother list item"]) {
      const chunks = chunkSpeech(source, { backend: "soniox", language: "uk" });
      expect(chunks.map((c) => c.text.replace(/\s/g, "")).join("")).toBe(source.replace(/\s/g, ""));
      for (const [index, chunk] of chunks.entries()) {
        expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
        expect([...chunk.text].length).toBeLessThanOrEqual(index === 0 ? 160 : 360);
        expect(new TextEncoder().encode(chunk.text).length).toBeLessThanOrEqual(4800);
        if (index) expect(chunk.start).toBeGreaterThanOrEqual(chunks[index - 1]!.end);
        expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
      }
    }
  });
  test("fallback preserves abbreviations and punctuation-free tokens", () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      const source = "Dr. Smith paid 3.14. Next sentence! Last one.";
      expect(chunkSpeech(source, { backend: "soniox" })[0]?.text).toBe("Dr. Smith paid 3.14.");
      expect(chunkSpeech("ж".repeat(900), { backend: "soniox" }).map((c) => c.text).join("")).toBe("ж".repeat(900));
    } finally { Object.defineProperty(Intl, "Segmenter", { value: original, configurable: true }); }
  });
});

test("native sentence segmentation keeps titles and decimal numbers in the first sentence", () => {
  const source = "Dr. Smith paid 3.14 dollars. He left. Another sentence.";
  expect(chunkSpeech(source, { backend: "soniox", language: "en" })[0]!.text).toBe("Dr. Smith paid 3.14 dollars.");
});
