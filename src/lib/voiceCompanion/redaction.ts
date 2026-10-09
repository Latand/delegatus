import { hardenedRedact } from "@/lib/view/compactText";

const REDACTED = "[redacted]";
/** A shorter piece of a credential at a text boundary identifies nothing. */
const PARTIAL = 12;
const SEGMENT = String.raw`[^\s/\\"'<>|*?()\[\]{},;:]+`;
const FILE_URL = /\bfile:\/\/[^\s"'<>)\]]+/gi;
/** A home-relative path or an absolute one, a root file ("/secret.txt") and a
 * drive file ("C:\\private.txt") included, whatever its first segment is made
 * of ("/12345/private.txt"). A URL's path and a slash inside a word ("and/or",
 * "1/2") start after another character. */
const LOCAL_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}_.:/\\~-])(?:~(?:[\\/]${SEGMENT})+|[A-Za-z]:(?:[\\/]${SEGMENT})+|(?:[\\/](?=[^\s/\\]*[\p{L}\p{N}])${SEGMENT})+)[\\/]?`, "gu");

/** Machine, config, transcript and worktree paths say where this installation
 * lives. They never reach the voice provider, a card or speech. */
export function withoutLocalPaths(text: string): string {
  return text.replace(FILE_URL, "[path]").replace(LOCAL_PATH, "[path]");
}

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
/** The shortest beginning of a credential still arriving at the end of a
 * stream that is withheld. A beginning this short names a format at most. */
const STREAM_TAIL = 3;
/** Which characters of a text belong to a credential in use. The text is read
 * with its separators taken out and each find is laid back over the original
 * positions, separators inside it included: a credential said in pieces with
 * a space, a tab or a line break before each piece is found whole. `edge` is
 * the shortest piece at either end of the text that counts as one arriving or
 * one whose beginning is gone. */
function credentialSpans(text: string, secrets: readonly string[], edge: number): Uint8Array {
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

/** Text a provider, a model or a report supplied, before it is stored or
 * answered to the browser: no credential family and no active credential. */
export function withoutCredentials(text: string, secrets: readonly string[]): string {
  const clean = hardenedRedact(text);
  // A transcript arrives in fragments and is cut into segments, so a credential
  // can lie across a boundary: its beginning ends one text, its rest opens the next.
  return maskedSlice(clean, credentialSpans(clean, secrets, PARTIAL), 0, clean.length);
}

/** Every string of a value, at any depth. Keys are the contract's own. */
export function cleanStrings<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map(row => cleanStrings(row, clean)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, cleanStrings(row, clean)])) as T;
  return value;
}
