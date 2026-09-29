import fs from "node:fs";
import path from "node:path";

import { knownProviderSecretOffset } from "@/lib/accounts/providerSecretRedaction";
import { BEARER_TOKEN, TOKEN_FAMILY_PATTERN } from "@/lib/view/compactText";

import {
  DOCUMENT_CAPTION_MAX_CHARS,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_ROOTS_MAX,
  type TelegramBotErrorCode,
} from "./contracts";

/**
 * Which files `telegram_bot_send_document` may post, decided on the Viewer
 * host before Telegram is contacted.
 *
 * A document can be any file, so the path an agent names is never trusted: it
 * must resolve (symlinks followed) under a document root the operator set, it
 * may not pass through a dot-directory or the Delegatus state directory even
 * when a root contains them, and the file actually opened is checked again,
 * so a directory swapped for a link between the check and the open cannot
 * carry it out. Its type and size are bounded, the name it is shown under
 * keeps its type, and a text file is scanned, in UTF-8 and UTF-16, with the
 * redactor's own secret patterns. A refusal names the class of what it found
 * and never the value. `telegram_bot_send_media` opens its photos through the
 * same {@link readUnderRoots}.
 */

export class DocumentRefusal extends Error {
  constructor(
    readonly code: TelegramBotErrorCode,
    message: string,
    readonly secretClass?: string,
  ) {
    super(message);
    this.name = "DocumentRefusal";
  }
}

export type DocumentEnvironment = { home: string; stateDir: string };

export type LoadedDocument = { file: File; filename: string; caption: string | null; bytes: number };

const MIME: Record<(typeof DOCUMENT_EXTENSIONS)[number], string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
/* What a file is, by its extension. The shown name may change the extension
   only within its class: a text file is never shown as a PDF or an image,
   and an image is never shown as text, which would skip the text scan. */
const TYPE_CLASS: Record<(typeof DOCUMENT_EXTENSIONS)[number], "text" | "pdf" | "image"> = {
  ".md": "text",
  ".markdown": "text",
  ".txt": "text",
  ".log": "text",
  ".json": "text",
  ".csv": "text",
  ".html": "text",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
};
const ALLOWED: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS);

function typeClass(extension: string): "text" | "pdf" | "image" | null {
  return ALLOWED.has(extension) ? TYPE_CLASS[extension as keyof typeof TYPE_CLASS] : null;
}

/** `<home>/handoff`, the one root when the operator has set none. */
export function defaultDocumentRoots(home: string): string[] {
  return [path.join(home, "handoff")];
}

function segments(pathname: string): string[] {
  return pathname.split(/[\\/]+/).filter((segment) => segment !== "");
}

function dotSegment(pathname: string): string | null {
  return segments(pathname).find((segment) => segment.startsWith(".")) ?? null;
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realOrSelf(pathname: string): string {
  try { return fs.realpathSync.native(pathname); } catch { return path.resolve(pathname); }
}

/** The state directory by its name and by what it resolves to. */
function forbiddenDirectories(environment: DocumentEnvironment): string[] {
  const named = path.resolve(environment.stateDir);
  return [...new Set([named, realOrSelf(named)])];
}

/**
 * The operator's roots as they will be stored: absolute, normalized, no dot
 * component, not inside the state directory, de-duplicated. An empty list
 * returns to the default.
 */
export function normalizeDocumentRoots(value: unknown, environment: DocumentEnvironment): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new DocumentRefusal("document_roots_invalid", "document roots are a list of absolute directory paths");
  if (value.length > DOCUMENT_ROOTS_MAX) throw new DocumentRefusal("document_roots_invalid", `at most ${DOCUMENT_ROOTS_MAX} document roots`);
  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > 4096) {
      throw new DocumentRefusal("document_roots_invalid", "each document root is a non-empty absolute directory path");
    }
    const trimmed = entry.trim();
    if (!path.isAbsolute(trimmed)) throw new DocumentRefusal("document_roots_invalid", `${trimmed} is not an absolute path`);
    const dot = dotSegment(trimmed);
    if (dot !== null) throw new DocumentRefusal("document_roots_invalid", `${trimmed} passes through ${dot}; dot-directories are never shared`);
    const resolved = path.resolve(trimmed);
    if (segments(resolved).length === 0) throw new DocumentRefusal("document_roots_invalid", "the filesystem root cannot be a document root");
    const real = realOrSelf(resolved);
    if (forbiddenDirectories(environment).some((forbidden) => within(resolved, forbidden) || within(real, forbidden))) {
      throw new DocumentRefusal("document_roots_invalid", `${trimmed} is inside the Delegatus state directory, which is never shared`);
    }
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

/* The scan runs synchronously in the request that sends the file, so every
   pattern here must stay linear at the 20 MB limit. The redactor's patterns
   are reshaped here where a match could start at every offset of a run and
   read to its end, which is quadratic.

   An assignment's key is the whole `[\w.-]` run before `:`/`=`, taken
   atomically (a lookahead's capture is never backtracked into), only where a
   run starts, and at most 128 characters, since a longer run is data. It
   must end with a credential keyword or go on past one after `_`/`-`
   (`SECRET_KEY`); read backwards, that costs one step per character of the
   key. `credentialKey` then sorts the keys that matched. */
const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w.-])(?=([\w.-]{1,128}))\1(?![\w.-])(?=\s*[:=])` +
    String.raw`(?<=(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token)(?:[_-][\w-]*)?)` +
    String.raw`(\s*[:=]\s*)(["']?)[^\s"',}]+`,
  "gi",
);
/* A header never spans lines, so it is read per line; `(^|\n)\s*` let each
   newline of a blank run rescan the rest of the run. */
const AUTHORIZATION_LINE = /^[ \t]*(?:proxy-)?authorization[ \t]*:[^\r\n]*/gim;
const COOKIE_LINE = /^[ \t]*(?:set-)?cookie[ \t]*:[^\r\n]*/gim;
/* `\b` holds after every `-` of a run such as `eyJ-eyJ-…`, and each of those
   starts read to the run's end; a JWT starts where its run starts. */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
/* The userinfo of a URL, a user and a password before the host, as a
   `DATABASE_URL` carries it. A password holds no `/`, and every scheme does,
   so each start reads at most to the next one. */
const URL_USERINFO = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/([^\s:/@]+):([^\s@/]{4,})@/gi;

/** What a text file carries that must not reach a chat, by class, with the
    line it starts on. Null when nothing matched. */
export function documentSecret(text: string): { secretClass: string; line: number } | null {
  /* The assignment pattern reads `key: value`; a JSON key is quoted, so the
     quotes come off keys (never across a line) before that one check. */
  const unquotedKeys = text.replace(/"([\w.-]+)"([ \t]*:)/g, "$1$2");
  const first = (pattern: RegExp, secretClass: string, accept: (match: RegExpExecArray) => boolean = () => true, subject = text) => {
    const scan = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (let match = scan.exec(subject); match; match = scan.exec(subject)) {
      if (accept(match)) return { secretClass, line: subject.slice(0, match.index).split("\n").length };
      if (match[0] === "") scan.lastIndex += 1;
    }
    return null;
  };
  /* The opening line of the redactor's armored block: a key cut off before
     its END line is still a key, and a header needs no scan to the end. */
  const found = first(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private_key")
    ?? first(TOKEN_FAMILY_PATTERN, "api_token")
    ?? first(/\b\d{5,20}:[A-Za-z0-9_-]{30,64}\b/, "bot_token")
    ?? first(JWT, "jwt")
    ?? first(BEARER_TOKEN, "bearer_token")
    ?? first(AUTHORIZATION_LINE, "authorization_header", (match) => credentialShaped(match[0].slice(match[0].indexOf(":") + 1)))
    ?? first(COOKIE_LINE, "cookie_header", (match) => match[0].slice(match[0].indexOf(":") + 1).trim().length >= 8)
    ?? first(URL_USERINFO, "url_credentials", (match) => urlPassword(match[1]!, match[2]!))
    ?? first(ASSIGNMENT, "credential_assignment", (match) => assignedCredential(match, unquotedKeys), unquotedKeys);
  if (found) return found;
  /* Records that cannot be read refuse the document, as the redactor
     withholds a text it cannot check. */
  let offset: number;
  try { offset = knownProviderSecretOffset(text); } catch { offset = 0; }
  if (offset !== -1) return { secretClass: "provider_credential", line: text.slice(0, offset).split("\n").length };
  return null;
}

/* Passwords a connection string in a README or a compose file stands in with. */
const URL_PLACEHOLDERS = new Set(["password", "pass", "passwd", "pwd", "secret", "changeme"]);

function urlPassword(user: string, password: string): boolean {
  if (/^[[<{$*%]/.test(password) || /^x+$/i.test(password)) return false;
  const lower = password.toLowerCase();
  return lower !== user.toLowerCase() && !URL_PLACEHOLDERS.has(lower) && !NOT_A_CREDENTIAL.has(lower);
}

/**
 * A value after a credential keyword that reads as a credential: long enough,
 * letters and digits mixed, and not a placeholder, a redaction marker or a
 * reference to one (`[redacted]`, `<token>`, `${TOKEN}`, `***`).
 */
function credentialShaped(raw: string): boolean {
  /* Nothing below adds or drops a digit; most keyword lines stop here. */
  if (!/\d/.test(raw)) return false;
  const value = raw.trim().replace(/^["']|["']$/g, "").replace(/^(?:Bearer|Basic|Token)\s+/i, "");
  if (value.length < 8 || /^[[<{$*%]/.test(value) || /^x+$/i.test(value)) return false;
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/* Words a report writes after a credential keyword that say something about
   the credential rather than being it. */
const NOT_A_CREDENTIAL = new Set([
  "none", "null", "nil", "true", "false", "yes", "no", "undefined", "empty", "unset", "blank",
  "required", "optional", "redacted", "hidden", "masked", "omitted", "removed", "rotated",
  "revoked", "expired", "invalid", "valid", "missing", "present", "set", "not", "never",
  "same", "default", "unknown", "n/a", "tbd", "todo", "string", "text", "value", "example",
  "placeholder",
]);

/* A key may go on past its keyword (`SECRET_KEY`, `DJANGO_SECRET_KEY`,
   `DB_PASSWORD_B64`), but not when what follows says the value is about the
   credential rather than the credential itself (`TOKEN_URL`, `PASSWORD_POLICY`). */
const KEY_ENDS_WITH_KEYWORD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token)$/i;
const KEY_GOES_ON = /(?:secret|password|passwd|pwd|token|api[_-]?key)[_-][\w-]*$/i;
const SECRET_NAMING_KEY = /secret|password|passwd|pwd|api[_-]?key/i;
const DESCRIBING_SUFFIX = new Set([
  "name", "names", "file", "path", "dir", "url", "uri", "endpoint", "host", "port", "type", "kind",
  "policy", "hint", "length", "len", "count", "limit", "ttl", "expiry", "expires", "expiration",
  "timeout", "id", "arn", "ref", "env", "var", "field", "header", "prefix", "suffix", "mode", "format",
  "version", "rotation", "provider", "backend", "store", "manager", "label", "description", "enabled",
  "required", "min", "max", "size", "algorithm", "scheme", "location",
]);

/**
 * How a key names a credential: `named` ends with a credential keyword;
 * `continued` goes on past `secret`/`password`/`api_key` into a suffix that
 * does not describe it; `loose` is a key prose and configuration use for
 * things other than a secret (`token`, `authorization`, `bearer`, `TOKEN_TYPE`,
 * `PASSWORD_POLICY`), where only a credential-shaped value counts.
 */
function credentialKey(key: string): "named" | "continued" | "loose" | null {
  if (KEY_ENDS_WITH_KEYWORD.test(key)) return /^(?:token|authorization|bearer)$/i.test(key) ? "loose" : "named";
  if (!KEY_GOES_ON.test(key)) return null;
  const suffix = key.split(/[_-]/).pop()!.toLowerCase();
  return DESCRIBING_SUFFIX.has(suffix) || !SECRET_NAMING_KEY.test(key) ? "loose" : "continued";
}

/* Read at the end of a value, in place: the rest of its line holds nothing
   but closing punctuation, or the next assignment on it starts. */
const LINE_ENDS = /(?:[`"'.,;:!?)\]}]|[^\S\n])*(?:\n|$)/y;
const NEXT_ASSIGNMENT = /[`"']?(?:[,;&]|[^\S\n])+[\w.-]+[^\S\n]*[:=]/y;

/**
 * `ASSIGNMENT` matched `key: value` under a credential key. A value shaped
 * like a credential (letters and digits) is one wherever it stands. A bare
 * word counts too, as the redactor's own pattern does (`password: hunter`,
 * `secret=swordfish`), unless the key is `loose`, or the word is a
 * placeholder, a reference to a variable, a path or a URL. The word must
 * stand where a value stands, at the end of its line or before the next
 * assignment, so prose such as `Password: reset by the operator` reads as
 * prose. A key that goes on past its keyword needs a longer word.
 */
function assignedCredential(match: RegExpExecArray, subject: string): boolean {
  const key = match[1]!;
  const kind = credentialKey(key);
  if (kind === null) return false;
  const raw = match[0].slice(key.length + match[2]!.length + match[3]!.length);
  if (credentialShaped(raw)) return true;
  if (kind === "loose") return false;
  const value = /^`?([^&;`]*)/.exec(raw)![1]!.replace(/[.,:;!?)\]]+$/, "");
  if (value.length < (kind === "continued" ? 8 : 4)) return false;
  /* Read from the subject in place, and no further than the next assignment
     needs: the rest of a long line, copied once per keyword on it, made the
     scan quadratic. Checked first because most keyword lines are prose. */
  const end = match.index + match[0].length;
  const tail = raw.slice(raw.indexOf(value) + value.length);
  LINE_ENDS.lastIndex = end;
  NEXT_ASSIGNMENT.lastIndex = end;
  const standsAlone = /^[`"'.,;:!?)\]}]*$/.test(tail) && LINE_ENDS.test(subject);
  if (!standsAlone && !(tail === ""
    ? NEXT_ASSIGNMENT.test(subject)
    : /^[`"']?[\s,;&]+[\w.-]+\s*[:=]/.test(tail + subject.slice(end, end + 256).split("\n", 1)[0]))) return false;
  if (/^[[<{$*%/~]/.test(value) || /^x+$/i.test(value) || value.includes("://")) return false;
  if (NOT_A_CREDENTIAL.has(value.toLowerCase()) || /^\d{1,5}$/.test(value)) return false;
  /* `process.env.KEY`, `config.secret`, `YOUR_API_KEY`, `os.environ[…]`. */
  return !(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(value) || /[([]/.test(value));
}

/**
 * Every way the bytes of a text file may be read as text: UTF-8 always;
 * UTF-16 when a byte-order mark or the zero bytes of mostly-ASCII UTF-16
 * say so; and, when the bytes hold zeros at all, the bytes with the zeros
 * dropped, which reads the ASCII in UTF-16 or UTF-32 of either byte order
 * whatever the heuristic concluded.
 */
function documentTexts(bytes: Buffer): string[] {
  const texts = [new TextDecoder("utf-8").decode(bytes)];
  /* Over the whole file: text appended in UTF-16 after an ASCII start (a
     PowerShell `>>` onto an existing log) has its zeros past any sample. */
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = bytes.indexOf(0); index !== -1 && index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const pairs = Math.max(1, Math.floor(bytes.length / 2));
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
  const guessed = oddZeros > pairs / 4 && evenZeros < oddZeros / 4 ? "utf-16le" : evenZeros > pairs / 4 && oddZeros < evenZeros / 4 ? "utf-16be" : null;
  const encoding = bom ?? guessed;
  if (encoding) texts.push(new TextDecoder(encoding).decode(bytes));
  if (evenZeros + oddZeros > 0) texts.push(bytes.toString("latin1").replace(/\u0000/g, ""));
  return texts;
}

/** {@link documentSecret} over every reading of a text file's bytes. */
export function documentBytesSecret(bytes: Buffer): { secretClass: string; line: number } | null {
  for (const text of documentTexts(bytes)) {
    const hit = documentSecret(text);
    if (hit) return hit;
  }
  return null;
}

function extensionOf(name: string): string {
  return path.extname(name).toLowerCase();
}

/** Where a checked path may not be: a dot-directory, the state directory, or
    anywhere but strictly under a root. */
function refusePlace(real: string, requested: string, realRoots: readonly string[], roots: readonly string[], environment: DocumentEnvironment): void {
  const realDot = dotSegment(real);
  if (realDot !== null) throw new DocumentRefusal("document_forbidden_path", `${requested} resolves through ${realDot}; files in dot-directories are never sent`);
  if (forbiddenDirectories(environment).some((forbidden) => within(real, forbidden))) {
    throw new DocumentRefusal("document_forbidden_path", `${requested} is inside the Delegatus state directory, which is never sent`);
  }
  if (!realRoots.some((root) => within(real, root) && real !== root)) {
    throw new DocumentRefusal("document_outside_roots", `${requested} is not under a document root (${roots.join(", ")}); write the file under one of them`);
  }
}

/**
 * The path the kernel holds for an open descriptor, or null where the
 * platform cannot say (no `/proc`). A file unlinked after the open reads with
 * a ` (deleted)` suffix, which then matches no checked path.
 */
function openedPath(descriptor: number): string | null {
  try { return fs.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { return null; }
}

/**
 * Opens `requested` and reads it when it lives under one of `roots`: the path
 * is checked as resolved, then the descriptor actually opened is checked
 * again. `O_NOFOLLOW` covers only the last component, so a parent directory
 * swapped for a link after `realpath` would otherwise open a file anywhere.
 * On Linux the opened path is read back from `/proc/self/fd`; elsewhere the
 * path is resolved again and must still name the opened file (device and
 * inode). `O_NONBLOCK` keeps a FIFO from holding the Viewer at the open.
 */
export function readUnderRoots<Admitted = void>(
  requested: string,
  roots: readonly string[],
  environment: DocumentEnvironment,
  maxBytes: number,
  /** Refuses by the resolved path, after the place checks and before the open. */
  admit: (real: string) => Admitted = () => undefined as Admitted,
): { real: string; bytes: Buffer; admitted: Admitted } {
  /* `..` starts with a dot too, so traversal is refused by the same rule. */
  const requestedDot = dotSegment(requested);
  if (requestedDot !== null) throw new DocumentRefusal("document_forbidden_path", `${requested} passes through ${requestedDot}; files in dot-directories are never sent`);

  let real: string;
  try {
    real = fs.realpathSync.native(requested);
  } catch {
    throw new DocumentRefusal("document_invalid", `${requested} does not exist or cannot be read on the Viewer host`);
  }
  const realRoots = roots.map((root) => realOrSelf(root));
  refusePlace(real, requested, realRoots, roots, environment);
  const admitted = admit(real);

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(descriptor);
    const opened = openedPath(descriptor);
    if (opened !== null) {
      refusePlace(opened, requested, realRoots, roots, environment);
      if (opened !== real) throw new DocumentRefusal("document_forbidden_path", `${requested} changed while it was being opened`);
    } else {
      let again: string | null;
      try { again = fs.realpathSync.native(requested); } catch { again = null; }
      const named = again === real ? fs.statSync(again) : null;
      if (!named || named.dev !== stat.dev || named.ino !== stat.ino) throw new DocumentRefusal("document_forbidden_path", `${requested} changed while it was being opened`);
    }
    if (!stat.isFile()) throw new DocumentRefusal("document_invalid", `${requested} is not a regular file`);
    /* A second name for a file elsewhere would carry it past the root check. */
    if (stat.nlink > 1) throw new DocumentRefusal("document_forbidden_path", `${requested} is hard-linked to another name, so where it lives cannot be checked`);
    if (stat.size === 0) throw new DocumentRefusal("document_invalid", `${requested} is empty`);
    if (stat.size > maxBytes) throw new DocumentRefusal("document_too_large", `${requested} is larger than ${maxBytes / 1024 / 1024} MB`);
    /* Read to the bound, never past it: the file may grow after the fstat. */
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (let read = fs.readSync(descriptor, chunk, 0, chunk.length, null); read > 0; read = fs.readSync(descriptor, chunk, 0, chunk.length, null)) {
      total += read;
      if (total > maxBytes) throw new DocumentRefusal("document_too_large", `${requested} is larger than ${maxBytes / 1024 / 1024} MB`);
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    if (total === 0) throw new DocumentRefusal("document_invalid", `${requested} is empty`);
    return { real, bytes: Buffer.concat(chunks, total), admitted };
  } catch (error) {
    if (error instanceof DocumentRefusal) throw error;
    throw new DocumentRefusal("document_invalid", `${requested} cannot be read on the Viewer host`);
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch { /* already closed */ }
  }
}

/**
 * Checks and loads one document. Throws a {@link DocumentRefusal} for every
 * reason not to send it; nothing here contacts Telegram.
 */
export function loadDocument(input: unknown, roots: readonly string[], environment: DocumentEnvironment): LoadedDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DocumentRefusal("document_invalid", "document needs {path, filename?, caption?}");
  }
  const { path: requested, filename: shown, caption } = input as { path?: unknown; filename?: unknown; caption?: unknown };
  if (typeof requested !== "string" || requested.trim() === "" || !path.isAbsolute(requested)) {
    throw new DocumentRefusal("document_invalid", "document.path must be an absolute path on the Viewer host");
  }
  if (caption !== undefined && caption !== null && typeof caption !== "string") throw new DocumentRefusal("document_invalid", "document.caption must be text");
  if (typeof caption === "string" && caption.length > DOCUMENT_CAPTION_MAX_CHARS) {
    throw new DocumentRefusal("text_too_long", `document caption exceeds ${DOCUMENT_CAPTION_MAX_CHARS} characters`);
  }
  /* `..` starts with a dot too, so traversal is refused by the same rule. */
  const requestedDot = dotSegment(requested);
  if (requestedDot !== null) throw new DocumentRefusal("document_forbidden_path", `${requested} passes through ${requestedDot}; files in dot-directories are never sent`);
  const filename = shown === undefined || shown === null ? path.basename(requested) : shown;
  if (typeof filename !== "string" || filename.trim() === "" || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename) || filename.startsWith(".")) {
    throw new DocumentRefusal("document_invalid", "document.filename must be a plain file name without slashes or a leading dot");
  }

  const { bytes, admitted: { extension, kind } } = readUnderRoots(requested, roots, environment, DOCUMENT_MAX_BYTES, (real) => {
    /* The resolved name decides the type, so a link cannot lend another. */
    const extension = extensionOf(real);
    const realKind = typeClass(extension);
    if (realKind === null) {
      throw new DocumentRefusal("document_type", `${extension || "a file without an extension"} is not a document type the bot sends; allowed: ${DOCUMENT_EXTENSIONS.join(" ")}`);
    }
    const shownKind = typeClass(extensionOf(filename));
    if (shownKind === null) {
      throw new DocumentRefusal("document_type", `the shown filename must end in one of ${DOCUMENT_EXTENSIONS.join(" ")}`);
    }
    if (shownKind !== realKind) {
      throw new DocumentRefusal("document_type", `the shown filename must keep the file's type: ${extension} is ${realKind} and ${extensionOf(filename)} is ${shownKind}`);
    }
    return { extension, kind: realKind };
  });

  const signature = extension === ".pdf" ? bytes.subarray(0, 5).toString("latin1") === "%PDF-"
    : extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : extension === ".jpg" || extension === ".jpeg" ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : true;
  if (!signature) throw new DocumentRefusal("document_type", `${requested} does not hold what its ${extension} extension says`);

  /* By the real file's class, so no shown name can skip it. */
  if (kind === "text") {
    const hit = documentBytesSecret(bytes);
    if (hit) {
      throw new DocumentRefusal(
        "document_secret",
        `${requested} contains what looks like a secret (${hit.secretClass}, line ${hit.line}); remove it and write the file again`,
        hit.secretClass,
      );
    }
  }

  const type = MIME[extension as keyof typeof MIME];
  return {
    file: new File([Uint8Array.from(bytes)], filename, { type }),
    filename,
    caption: typeof caption === "string" && caption !== "" ? caption : null,
    bytes: bytes.length,
  };
}
