/* Frozen decoder from before the scanning performance fix. The repeated
 * comparison is intentional: equivalence tests exercise the original behavior.
 *
 * The publication gate's canonical view of a text, as pure functions.
 *
 * A private value can be written so that a pattern does not see it and a
 * reader still does: an HTML entity, a percent escape, a CommonMark backslash,
 * a JSON escape, a zero-width character inside it. `scripts/privacy-
 * publication-gate.ts` decodes those forms, to a fixed point, before any of
 * its detectors run; the issue reporter's scrubber
 * (`src/lib/issueReports/scrub.ts`) reads the same view, so a report cannot
 * carry a value the gate would have found. They live here, beside
 * `staticDetectors.ts`, because the gate spawns git while it loads. */

import { decodeHTMLStrict } from "entities";

function decodePercentEncoding(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function decodeHtmlEntities(text: string, preserveLiteralUnderscores = false): string {
  if (!preserveLiteralUnderscores) return decodeHTMLStrict(text);
  let decoded = "";
  let cursor = 0;
  // The compact detector normalizes compatibility glyphs to underscores;
  // preserve their literal Markdown role while doing so in this token view.
  for (const match of text.matchAll(/&[^&;\s]*;|[\uFE33\uFE34\uFE4D-\uFE4F\uFF3F]/gu)) {
    decoded += text.slice(cursor, match.index);
    let literal = decodeHTMLStrict(match[0]);
    // Entity references produce literal text, including inside emphasis.
    if (literal.normalize("NFKC") === "_") {
      literal = "_";
      let backslashes = 0;
      for (let index = decoded.length - 1; decoded[index] === "\\"; index -= 1) backslashes += 1;
      if (backslashes % 2 === 0) decoded += "\\";
    }
    decoded += literal;
    cursor = match.index + match[0].length;
  }
  return decoded + text.slice(cursor);
}

function decodeCommonMarkEscapes(text: string): string {
  return text.replaceAll(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function removeDefaultIgnorables(text: string): string {
  return text.replaceAll(/\p{Default_Ignorable_Code_Point}/gu, "");
}

function decodeJsonStringEscapes(text: string): string {
  const escapes: Record<string, string> = {
    '\"': '\"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
  };
  return text.replaceAll(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_match, hex: string | undefined, escape: string) =>
    hex === undefined ? escapes[escape] : String.fromCharCode(parseInt(hex, 16)));
}

/** Keep source positions only for characters a decoding step leaves untouched. */
function decodeWithOffsets(
  text: string,
  decode: (value: string) => string,
  tokens: RegExp,
  offsets?: number[],
): string {
  const decoded = decode(text);
  if (!offsets || decoded === text) return decoded;
  const nextOffsets: number[] = [];
  let cursor = 0;
  const mapped = text.replace(tokens, (token: string, index: number) => {
    for (; cursor < index; cursor += 1) nextOffsets.push(offsets[cursor]);
    const replacement = decode(token);
    for (let i = 0; i < replacement.length; i += 1) {
      nextOffsets.push(replacement === token ? offsets[index + i] : -1);
    }
    cursor = index + token.length;
    return replacement;
  });
  for (; cursor < text.length; cursor += 1) nextOffsets.push(offsets[cursor]);
  offsets.length = decoded.length;
  // A decoder shape outside the mapped tokens still gets scanned in full,
  // but cannot confer a RAW exemption without proven source correspondence.
  for (let i = 0; i < decoded.length; i += 1) offsets[i] = mapped === decoded ? nextOffsets[i] : -1;
  return decoded;
}

export function decodeSensitiveText(
  text: string,
  preserveDefaultIgnorables: boolean,
  offsets?: number[],
  jsonEscapes = false,
  preserveCommonMarkEscapes = false,
): { error: boolean; text: string } {
  const strip = preserveDefaultIgnorables ? (value: string): string => value
    : (value: string): string => decodeWithOffsets(value, removeDefaultIgnorables, /\p{Default_Ignorable_Code_Point}/gu, offsets);
  let decoded = strip(text);
  for (let pass = 0; pass < 16; pass += 1) {
    const next = strip(
      decodeWithOffsets(
        decodeWithOffsets(
          decodeWithOffsets(
            jsonEscapes ? decodeWithOffsets(decoded, decodeJsonStringEscapes, /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, offsets) : decoded,
            decodePercentEncoding, /(?:%[0-9a-f]{2})+/gi, offsets,
          ),
          (value) => decodeHtmlEntities(value, preserveCommonMarkEscapes), /&[^&;\s]*;/g, offsets,
        ),
        preserveCommonMarkEscapes ? (value) => value : decodeCommonMarkEscapes,
        /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, offsets,
      ),
    );
    if (next === decoded) return { error: false, text: decoded };
    decoded = next;
  }
  return { error: true, text: decoded };
}

/** Token emphasis pairing retains escapes and underscores from literal text. */
export function canonicalSensitiveText(text: string, jsonEscapes = false, preserveCommonMarkEscapes = false): { error: boolean; text: string } {
  return decodeSensitiveText(text, false, undefined, jsonEscapes, preserveCommonMarkEscapes);
}
