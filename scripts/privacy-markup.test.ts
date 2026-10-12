import { expect, test } from "bun:test";

import { privacyMarkupSpans, stripPrivacyHtml } from "./privacy-markup";

function project(text: string, spans: Iterable<{ start: number; end: number }>) {
  const kept = Array.from({ length: text.length }, (_, index) => index);
  for (const { start, end } of [...spans].reverse()) kept.splice(start, end - start);
  return { text: kept.map((index) => text[index]).join(""), offsets: kept };
}

test("HTML and email projections preserve regex spans, text and source offsets", () => {
  const cases = ["", "<<>tail<", "before<inner<end>after>", "<unclosed_~*[]`suffix", "💡<x>é_[tail]"];
  let generated = [""];
  for (let length = 1; length <= 5; length += 1) {
    generated = generated.flatMap((prefix) => ["<", ">", "_", "[", "a", "💡"].map((char) => prefix + char));
    cases.push(...generated);
  }
  for (const text of cases) {
    expect(stripPrivacyHtml(text)).toBe(text.replaceAll(/<[^>]*>/g, ""));
    const reference = [...text.matchAll(/<[^>]*>|[\[\]*_`~]/g)]
      .map((match) => ({ start: match.index, end: match.index + match[0].length }));
    const actual = [...privacyMarkupSpans(text, true)];
    expect(actual).toEqual(reference);
    expect(project(text, actual)).toEqual(project(text, reference));
  }
});

test("unclosed markup keeps the suffix with bounded CPU growth", () => {
  function measure(size: number) {
    const text = "<".repeat(size) + "_tail";
    const start = process.cpuUsage();
    for (let repeat = 0; repeat < 8; repeat += 1) {
      expect(stripPrivacyHtml(text)).toBe(text);
      expect([...privacyMarkupSpans(text, true)]).toEqual([{ start: size, end: size + 1 }]);
    }
    const used = process.cpuUsage(start);
    return used.user + used.system;
  }
  measure(4096); // Warm the interpreter before comparing sizes.
  const small = measure(32_768);
  const large = measure(262_144);
  expect(large).toBeLessThan(small * 16 + 50_000);
  expect(large).toBeLessThan(500_000);
});
