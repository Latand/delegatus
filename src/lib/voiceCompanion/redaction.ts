import { hardenedRedact } from "@/lib/view/compactText";
import { credentialSpans, maskedSlice } from "./credentialMask";
export { credentialMask, maskedSlice, withoutSeparators } from "./credentialMask";

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

/** Text a provider, a model or a report supplied, before it is stored or
 * answered to the browser: no credential family and no active credential. */
export function withoutCredentials(text: string, secrets: readonly string[]): string {
  const clean = hardenedRedact(text);
  // A transcript arrives in fragments and is cut into segments, so a credential
  // can lie across a boundary: its beginning ends one text, its rest opens the next.
  return maskedSlice(clean, credentialSpans(clean, secrets, PARTIAL), 0, clean.length);
}

/** Every string of a value, at any depth. Contract keys are preserved; raw
 * provider arguments can opt into cleaning their untrusted parameter names. */
export function cleanStrings<T>(value: T, clean: (text: string) => string, cleanKeys = false): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map(row => cleanStrings(row, clean, cleanKeys)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, row]) => [cleanKeys ? clean(key) : key, cleanStrings(row, clean, cleanKeys)])) as T;
  return value;
}
