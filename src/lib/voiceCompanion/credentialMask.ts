const REDACTED = "[redacted]";

/** Characters a transcript puts between the fragments of one word: spaces,
 * tabs, line breaks and the invisible format characters. */
function separator(code: number): boolean {
  return code <= 0x20 || code === 0x85 || code === 0xa0 || code === 0xad || code === 0x1680 || (code >= 0x2000 && code <= 0x200f)
    || (code >= 0x2028 && code <= 0x202f) || (code >= 0x205f && code <= 0x2064) || code === 0x3000 || code === 0xfeff;
}
/** A text with its separators taken out: a credential laid out in pieces reads whole. */
export function withoutSeparators(text: string): string {
  return Array.from(text).filter(char => !separator(char.charCodeAt(0))).join("");
}
/** The forms a known credential takes when a tool's answer encodes it: JSON string escaping, percent-encoding (as
 * `encodeURIComponent` writes it and in lower-case hex), and base64 and base64url. A credential inside longer encoded
 * data starts at any byte, so each of the three base64 alignments contributes the characters the credential alone
 * decides: the edges it shares with its neighbours are left out. A form shorter than eight characters is dropped. */
const FORMS = new Map<string, string[]>();
export function encodedForms(secret: string): string[] {
  if (secret.length < 8) return [];
  const held = FORMS.get(secret);
  if (held) return held;
  const bytes = Buffer.from(secret, "utf8");
  const percent = encodeURIComponent(secret);
  const forms = new Set([JSON.stringify(secret).slice(1, -1), percent, percent.replace(/%[0-9A-F]{2}/gu, code => code.toLowerCase())]);
  for (let pad = 0; pad < 3; pad += 1) {
    const text = Buffer.concat([Buffer.alloc(pad), bytes]).toString("base64");
    const core = text.slice(Math.ceil(pad * 8 / 6), Math.floor((pad + bytes.length) * 8 / 6));
    forms.add(core);
    forms.add(core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  forms.delete(secret);
  const found = [...forms].filter(form => form.length >= 8);
  // Bounded: the installation holds a handful of credentials, and a rotated one leaves.
  if (FORMS.size >= 64) FORMS.delete(FORMS.keys().next().value!);
  FORMS.set(secret, found);
  return found;
}
/** The shortest beginning of a credential still arriving at the end of a
 * stream that is withheld. A beginning this short names a format at most. */
const STREAM_TAIL = 3;
/** Which characters of a text belong to a credential in use. The text is read
 * with its separators taken out and each find is laid back over the original
 * positions, separators inside it included: a credential said in pieces with
 * a space, a tab or a line break before each piece is found whole. `edge` is
 * the shortest piece at either end of the text that counts as one arriving or
 * one whose beginning is gone. */
export function credentialSpans(text: string, secrets: readonly string[], edge: number): Uint8Array {
  const mask = new Uint8Array(text.length);
  let joined = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) if (!separator(text.charCodeAt(index))) { joined += text[index]; at.push(index); }
  for (const raw of secrets) {
    const sought = withoutSeparators(raw);
    if (sought.length < 8) continue;
    for (let found = joined.indexOf(sought); found !== -1; found = joined.indexOf(sought, found + 1)) mask.fill(1, at[found], at[found + sought.length - 1] + 1);
    for (let length = Math.min(sought.length - 1, joined.length); length >= edge; length -= 1)
      if (joined.endsWith(sought.slice(0, length))) { mask.fill(1, at[joined.length - length]); break; }
    // The record keeps a bounded history, so a credential's beginning may have left it.
    for (let length = Math.min(sought.length - 1, joined.length); length >= edge; length -= 1)
      if (joined.startsWith(sought.slice(-length))) { mask.fill(1, 0, at[length - 1] + 1); break; }
  }
  return mask;
}
/** One speaker's transcript read as one text across all of its segments:
 * which characters belong to a credential in use. A credential cut into
 * fragments of any length, across any number of segments and with separators
 * between them, is found whole; its beginning is withheld while it is still
 * arriving, and a separator that follows never shows it again. */
export function credentialMask(stream: string, secrets: readonly string[]): Uint8Array {
  return credentialSpans(stream, secrets, STREAM_TAIL);
}
/** A slice of a masked stream, each masked run said once. */
export function maskedSlice(stream: string, mask: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let at = start; at < end; at += 1) {
    if (!mask[at]) text += stream[at];
    else if (at === start || !mask[at - 1]) text += REDACTED;
  }
  return text;
}
