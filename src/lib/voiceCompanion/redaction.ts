import { hardenedRedact } from "@/lib/view/compactText";

const REDACTED = "[redacted]";
/** A shorter piece of a credential at a text boundary identifies nothing. */
const PARTIAL = 12;
const SEGMENT = String.raw`[^\s/\\"'<>|*?()\[\]{},;:]+`;
const FILE_URL = /\bfile:\/\/[^\s"'<>)\]]+/gi;
/** A home-relative path or an absolute one, a root file ("/secret.txt") and a
 * drive file ("C:\\private.txt") included. A URL's path and a slash inside a
 * word ("and/or", "1/2") start after another character. */
const LOCAL_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}_.:/\\~-])(?:~(?:[\\/]${SEGMENT})+|[A-Za-z]:(?:[\\/]${SEGMENT})+|(?:[\\/](?=[^\s/\\]*\p{L})${SEGMENT})+)[\\/]?`, "gu");

/** Machine, config, transcript and worktree paths say where this installation
 * lives. They never reach the voice provider, a card or speech. */
export function withoutLocalPaths(text: string): string {
  return text.replace(FILE_URL, "[path]").replace(LOCAL_PATH, "[path]");
}

function withoutSecret(text: string, secret: string): string {
  let clean = text.split(secret).join(REDACTED);
  if (secret.length <= PARTIAL) return clean;
  // A transcript arrives in fragments and is cut into segments, so a credential
  // can lie across a boundary: its beginning ends one text, its rest opens the next.
  for (let length = Math.min(secret.length - 1, clean.length); length >= PARTIAL; length -= 1) {
    if (clean.endsWith(secret.slice(0, length))) { clean = clean.slice(0, -length) + REDACTED; break; }
  }
  for (let length = Math.min(secret.length - 1, clean.length); length >= PARTIAL; length -= 1) {
    if (clean.startsWith(secret.slice(-length))) { clean = REDACTED + clean.slice(length); break; }
  }
  return clean;
}

/** The shortest beginning of a credential still arriving at the end of a
 * stream that is withheld. A beginning this short names a format at most. */
const STREAM_TAIL = 3;
/** One speaker's transcript read as one text across all of its segments:
 * which characters belong to a credential in use. A credential cut into
 * fragments of any length, across any number of segments, is found whole; its
 * beginning is withheld while it is still arriving. */
export function credentialMask(stream: string, secrets: readonly string[]): Uint8Array {
  const mask = new Uint8Array(stream.length);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    for (let at = stream.indexOf(secret); at !== -1; at = stream.indexOf(secret, at + 1)) mask.fill(1, at, at + secret.length);
    for (let length = Math.min(secret.length - 1, stream.length); length >= STREAM_TAIL; length -= 1)
      if (stream.endsWith(secret.slice(0, length))) { mask.fill(1, stream.length - length); break; }
    // The record keeps a bounded history, so a credential's beginning may have left it.
    for (let length = Math.min(secret.length - 1, stream.length); length >= STREAM_TAIL; length -= 1)
      if (stream.startsWith(secret.slice(-length))) { mask.fill(1, 0, length); break; }
  }
  return mask;
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
  let clean = hardenedRedact(text);
  for (const secret of secrets) if (secret.length >= 8) clean = withoutSecret(clean, secret);
  return clean;
}

/** Every string of a value, at any depth. Keys are the contract's own. */
export function cleanStrings<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map(row => cleanStrings(row, clean)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, cleanStrings(row, clean)])) as T;
  return value;
}
