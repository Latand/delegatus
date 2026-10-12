import { expect, test } from "bun:test";

import { canonicalSensitiveText, decodeSensitiveText } from "../src/lib/privacy/canonicalText";
import { canonicalSensitiveText as referenceCanonical, decodeSensitiveText as referenceDecode } from "./privacy-canonical-reference.fixture";

test("canonical text and source offsets match the original decoder", () => {
  const cases = [
    "", "plain boundaries", "💡é e\u0301 ＿", "\ud800\udc00\ud800",
    "%41%20%F0%9F%92%A1", "%FF %a %", "&amp;#65; &unknown; &lt;",
    "a\u200Bb\u2060c", String.raw`a\_b\*c`, String.raw`\u0041\n\uD83D\uDCA1`,
    "＿&lowbar;﹍", "%2526amp%253B", "&amp;".repeat(18) + "#65;",
    "\\_&lowbar;\\\\&lowbar;", "&#xFE33; %EF%BC%BF", "start\0end",
  ];
  // Pair transformations with untouched prefixes/suffixes, including astral
  // characters whose source offsets occupy two UTF-16 code units.
  for (const left of cases) {
    for (const right of cases) {
      const text = `${left} untouched 💡 ${right}`;
      for (const preserveIgnorables of [false, true]) {
        for (const json of [false, true]) {
          for (const preserveMarkdown of [false, true]) {
            const offsets = Array.from({ length: text.length }, (_, index) => index);
            const referenceOffsets = [...offsets];
            expect(decodeSensitiveText(text, preserveIgnorables, offsets, json, preserveMarkdown))
              .toEqual(referenceDecode(text, preserveIgnorables, referenceOffsets, json, preserveMarkdown));
            expect(offsets).toEqual(referenceOffsets);
            expect(canonicalSensitiveText(text, json, preserveMarkdown))
              .toEqual(referenceCanonical(text, json, preserveMarkdown));
          }
        }
      }
    }
  }
});
