import { hardenedRedact } from "@/lib/view/compactText";
import { credentialSpans, maskedSlice } from "./credentialMask";
export { credentialMask, maskedSlice, withoutSeparators } from "./credentialMask";

/** A shorter piece of a credential at a text boundary identifies nothing. */
const PARTIAL = 12;
const SEGMENT = String.raw`[^\s/\\"'<>|*?()\[\]{},;:]+`;
const FILE_URL = /\bfile:\/\/[^\s"'<>)\]]+/gi;
/** A path separator as text can carry it: a slash or a backslash, the doubled
 * backslash and the escaped slash of JSON text ("C:\\\\Users", "\\/home"), a UNC
 * opening ("\\\\server") and its JSON form, and a percent-encoded one ("%2Fhome"). */
const SEP = String.raw`(?:\\{1,4}\/?|\/|%2[Ff]|%5[Cc])`;
/** A home-relative path ("~/x", "~operator/x") or an absolute one, a root file
 * ("/secret.txt"), a drive file ("C:\\private.txt") and a UNC path included,
 * whatever its first segment is made of ("/12345/private.txt"). A URL's path and
 * a slash inside a word ("and/or", "1/2") start after another character. A path
 * after a colon is matched too ("HOME:/home/…", "PATH=/usr/bin:/opt/…"): a URL's
 * "scheme://" opens with two slashes, which never start a path here. */
const LOCAL_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}_./\\~%-])(?:~[\p{L}\p{N}._-]*(?:${SEP}${SEGMENT})+|[A-Za-z]:(?:${SEP}${SEGMENT})+|(?:${SEP}(?=[^\s/\\]*[\p{L}\p{N}])${SEGMENT})+)(?:${SEP})?`, "gu");
/** A path under a machine root, after any character ("log-/home/…", "v2/Users/…",
 * "x_\\/home\\/…"), except inside a URL, whose own path may name the same words. */
const ROOTED_PATH = new RegExp(String.raw`${SEP}(?:home|Users|root|etc|var|tmp|srv|opt|mnt|media|private|Volumes|run|usr|nix|snap|workspace|data)(?:${SEP}${SEGMENT})+(?:${SEP})?`, "gu");

const URL_BEFORE = /\b[a-z][a-z0-9+.-]*:\/\/\S*$/iu;

/** Machine, config, transcript and worktree paths say where this installation
 * lives. They never reach the voice provider, a card or speech. */
export function withoutLocalPaths(text: string): string {
  return text.replace(FILE_URL, "[path]").replace(LOCAL_PATH, "[path]")
    .replace(ROOTED_PATH, (path, at: number, whole: string) => URL_BEFORE.test(whole.slice(0, at).split(/[\s"'<>(),;]/u).at(-1) ?? "") ? path : "[path]");
}

/** Credential families an added tool's answer can carry beyond the shared
 * redactor's: a Telegram bot token, a password in a URL's user part, GitLab
 * and Stripe secret keys, and a secret assigned to a key that names one
 * anywhere in it ("aws_secret_access_key = …", "DB_PASSWORD: …"). */
const BOT_TOKEN = /(?<![\p{L}\p{N}_])\d{6,12}:[A-Za-z0-9_-]{30,}/gu;
// Built from pieces, as compactText.ts builds its token families, so the publication gate does not read the
// pattern's own source as a credential.
const URL_PASSWORD = new RegExp([String.raw`(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)`, String.raw`[^\s/@]+`, String.raw`(?=@)`].join(""), "gi");
const VENDOR_KEY = new RegExp(String.raw`\b(?:` + [
  String.raw`glpat-[A-Za-z0-9_-]{20,}`,
  String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
].join("|") + String.raw`)`, "g");
const SECRET_KEY_WORDS = [
  "secret", "pass" + "word", "passwd", "pwd", String.raw`token(?!s\b)`, String.raw`api[_-]?key`,
  String.raw`access[_-]?key`, String.raw`private[_-]?key`, "credentials?",
].join("|");
const NAMED_SECRET = new RegExp([
  String.raw`((?<![\w.-])[\w.-]{0,48}?(?:${SECRET_KEY_WORDS})[\w.-]{0,48}["']?`,
  String.raw`[ \t]*[:=][ \t]*)`,
  String.raw`(["']?)(?!\[redacted\])[^\s"',}]{6,}`,
].join(""), "gi");

/* A passphrase may hold spaces: after a key that names one, the whole quoted value, or the rest of the line up to
   a separator, is the secret. */
const PASSPHRASE = new RegExp([
  String.raw`((?<![\w.-])[\w.-]{0,48}?(?:${["pass" + "word", "pass" + "phrase", "passwd", "pwd"].join("|")})[\w.-]{0,48}["']?`,
  String.raw`[ \t]*[:=][ \t]*)`,
  String.raw`(?:"[^"\n]+"|'[^'\n]+'|[^\s"',;}][^\n"',;}]*)`,
].join(""), "gi");

/** Text a provider, a model or a report supplied, before it is stored or
 * answered to the browser: no credential family and no active credential. */
export function withoutCredentials(text: string, secrets: readonly string[]): string {
  const clean = hardenedRedact(text).replace(BOT_TOKEN, "[redacted]").replace(URL_PASSWORD, "$1[redacted]")
    .replace(VENDOR_KEY, "[redacted]").replace(PASSPHRASE, "$1[redacted]").replace(NAMED_SECRET, "$1$2[redacted]");
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
