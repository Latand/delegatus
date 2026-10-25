import { hardenedRedact } from "@/lib/view/compactText";
import { credentialSpans, encodedForms, maskedSlice } from "./credentialMask";
export { credentialMask, encodedForms, maskedSlice, withoutSeparators } from "./credentialMask";

/** A shorter piece of a credential at a text boundary identifies nothing. */
const PARTIAL = 12;
/** A file URL, or a URI that opens a local file in an editor ("vscode://file/home/…"), names a path whole. */
const FILE_URL = /\b(?:file:\/{1,3}|[a-z][a-z0-9+.-]*:\/\/file\/)[^\s"'<>)\]]+/gi;
/** A path separator as text can carry it: a slash or a backslash, the doubled
 * backslash and the escaped slash of JSON text ("C:\\\\Users", "\\/home"), a UNC
 * opening ("\\\\server") and its JSON form, a JSON unicode escape ("\\u002F"), an HTML
 * entity ("&#x2F;", "&#47;", "&sol;") and a percent-encoded one, encoded once or again
 * ("%2Fhome", "%252Fhome"). */
const SEP = String.raw`(?:\\{1,2}u00(?:2[Ff]|5[Cc])|\\{1,4}\/?|\/|%(?:25)*(?:2[Ff]|5[Cc])|&#[xX]0*(?:2[Ff]|5[Cc]);|&#0*(?:47|92);|&(?:sol|bsol);)`;
/** One path segment: it ends where a separator in any of those forms starts ("home&#x2F;…", "home%2F…"). */
const SEGMENT = String.raw`(?:(?!${SEP})[^\s/\\"'<>|*?()\[\]{},;:])+`;
/** Under a home or a drive a folder name may hold spaces ("C:\\Users\\Fixture Name\\…"): a word after a space
 * still belongs to the path when another separator follows it. */
const SPACED = String.raw`${SEGMENT}(?:[ \t]${SEGMENT}(?=${SEP}))*`;
const ROOTS = "home|Users|root|etc|var|tmp|srv|opt|mnt|media|private|Volumes|run|usr|nix|snap|workspace|data";
/** A home-relative path ("~/x", "~operator/x") or an absolute one, a root file
 * ("/secret.txt"), a drive file ("C:\\private.txt") and a UNC path included,
 * whatever its first segment is made of ("/12345/private.txt"). A URL's path and
 * a slash inside a word ("and/or", "1/2") start after another character. A path
 * after a colon is matched too ("HOME:/home/…", "PATH=/usr/bin:/opt/…"): a URL's
 * "scheme://" opens with two slashes, which never start a path here. */
const LOCAL_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}_./\\~%-])(?:~[\p{L}\p{N}._-]*(?:${SEP}${SEGMENT})+|[A-Za-z]:(?:${SEP}${SPACED})+|(?:${SEP}(?=[^\s/\\]*[\p{L}\p{N}])${SEGMENT})+)(?:${SEP})?`, "gu");
/** A home-relative path glued to a word ("x~operator/.ssh"). */
const GLUED_HOME = new RegExp(String.raw`(?<=[\p{L}\p{N}_])~[\p{L}\p{N}._-]*(?:${SEP}${SEGMENT})+(?:${SEP})?`, "gu");
/** A path under a machine root, after any character ("log-/home/…", "v2/Users/…",
 * "x_\\/home\\/…"), except in a URL's own path, which may name the same words. */
const ROOTED_PATH = new RegExp(String.raw`(?:\b[A-Za-z]:)?${SEP}(?:${ROOTS})(?:${SEP}${SPACED})+(?:${SEP})?`, "gu");
/** A JSON string that opens with a home, a drive or a UNC path is a path to its closing quote, spaces and all. */
const QUOTED_PATH = new RegExp(String.raw`"(?:~[\p{L}\p{N}._-]*${SEP}|[A-Za-z]:${SEP}|${SEP}(?:${ROOTS})${SEP}|\\{2,8}[\p{L}\p{N}?.$])(?:[^"\\\n]|\\.)*"`, "gu");

const URL_BEFORE = /\b[a-z][a-z0-9+.-]*:\/\/\S*$/iu;
/** A separator only an encoding or a backslash writes: a URL's own path never holds one. */
const ENCODED_SEP = /%(?:25)*(?:2f|5c)|&#|&(?:sol|bsol);|\\/iu;

/** Machine, config, transcript and worktree paths say where this installation
 * lives. They never reach the voice provider, a card or speech. A path in a URL's
 * query or fragment, or one written with an encoded separator, is a local path too. */
export function withoutLocalPaths(text: string): string {
  // A path under a machine root goes first: its folder names may hold spaces, which the other forms stop at.
  return text.replace(QUOTED_PATH, '"[path]"').replace(FILE_URL, "[path]")
    .replace(ROOTED_PATH, (path, at: number, whole: string) => {
      const before = whole.slice(0, at).split(/[\s"'<>(),]/u).at(-1) ?? "";
      return URL_BEFORE.test(before) && !/[?#]/u.test(before) && !ENCODED_SEP.test(path) ? path : "[path]";
    }).replace(LOCAL_PATH, "[path]").replace(GLUED_HOME, "[path]");
}

/** Credential families an added tool's answer can carry beyond the shared
 * redactor's: a Telegram bot token, a password in a URL's user part, GitLab
 * and Stripe secret keys, and a secret assigned to a key that names one
 * anywhere in it ("aws_secret_access_key = …", "DB_PASSWORD: …"). */
const BOT_TOKEN = /(?<![\p{L}\p{N}_])\d{6,12}:[A-Za-z0-9_-]{30,}/gu;
// Built from pieces, as compactText.ts builds its token families, so the publication gate does not read the
// pattern's own source as a credential.
// The password runs to the last "@" before the host: a password may hold one ("redis://:p@ss@host").
const URL_PASSWORD = new RegExp([String.raw`(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)`, String.raw`[^\s/]+`, String.raw`(?=@)`].join(""), "gi");
const VENDOR_KEY = new RegExp(String.raw`\b(?:` + [
  String.raw`glpat-[A-Za-z0-9_-]{20,}`,
  String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
].join("|") + String.raw`)`, "g");
const SECRET_KEY_WORDS = [
  "secret", "pass" + "word", "passwd", "pwd", String.raw`token(?!s\b)`, String.raw`api[_-]?key`,
  String.raw`access[_-]?key`, String.raw`(?:private|signing|encryption|master|session)[ _-]?key`, "credentials?",
].join("|");
const NAMED_SECRET = new RegExp([
  String.raw`((?<![\w.-])[\w.-]{0,48}?(?:${SECRET_KEY_WORDS})[\w.-]{0,48}["']?`,
  String.raw`[ \t]*[:=][ \t]*)`,
  // A JSON string escape ("ab\\"cd") is part of the value, not its end.
  String.raw`(["']?)(?!\[redacted\])(?:\\.|[^\s"',}\\]){6,}`,
].join(""), "gi");

/* A passphrase may hold spaces: after a key that names one, the whole quoted value, or the rest of the line up to
   a separator, is the secret. */
const PASSPHRASE = new RegExp([
  String.raw`((?<![\w.-])[\w.-]{0,48}?(?:${["pass" + "word", "pass" + "phrase", "passwd", "pwd"].join("|")})[\w.-]{0,48}["']?`,
  String.raw`[ \t]*[:=][ \t]*)`,
  String.raw`(?:"(?:\\.|[^"\\\n])+"|'(?:\\.|[^'\\\n])+'|(?:\\.|[^\s"',;}\\])(?:\\.|[^\n"',;}\\])*)`,
].join(""), "gi");

/** Text a provider, a model or a report supplied, before it is stored or
 * answered to the browser: no credential family and no active credential. */
export function withoutCredentials(text: string, secrets: readonly string[]): string {
  // A credential in use is masked first, whole and in its encoded forms: a family below that matches its middle
  // would otherwise leave its beginning and end in place.
  let known = maskedSlice(text, credentialSpans(text, secrets, PARTIAL), 0, text.length);
  for (const form of secrets.flatMap(secret => encodedForms(secret))) known = known.replaceAll(form, "[redacted]");
  const clean = hardenedRedact(known).replace(BOT_TOKEN, "[redacted]").replace(URL_PASSWORD, "$1[redacted]")
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
