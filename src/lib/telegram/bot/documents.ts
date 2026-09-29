import fs from "node:fs";
import path from "node:path";

import { redactKnownProviderSecrets } from "@/lib/accounts/providerSecretRedaction";
import { SECRET_VALUE_RE } from "@/lib/review";
import {
  AUTHORIZATION_HEADER,
  BEARER_TOKEN,
  COOKIE_HEADER,
  JWT_PATTERN,
  TOKEN_FAMILY_PATTERN,
} from "@/lib/view/compactText";

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

/* The redactor's assignment pattern, anchored where a key can start. Its key
   opens with `[\w.-]*`, which the engine retries at every offset of a word
   run, so a megabyte of base64 took minutes on the request that scanned it;
   the lookbehind lets only the run's first character start a match. */
const ASSIGNMENT = new RegExp(`(?<![\\w.-])${SECRET_VALUE_RE.source}`, SECRET_VALUE_RE.flags);

/** What a text file carries that must not reach a chat, by class, with the
    line it starts on. Null when nothing matched. */
export function documentSecret(text: string): { secretClass: string; line: number } | null {
  /* The assignment pattern reads `key: value`; a JSON key is quoted, so the
     quotes come off keys (never across a line) before that one check. */
  const unquotedKeys = text.replace(/"([\w.-]+)"([ \t]*:)/g, "$1$2");
  const first = (pattern: RegExp, secretClass: string, accept: (match: RegExpExecArray) => boolean = () => true, subject = text) => {
    const scan = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (let match = scan.exec(subject); match; match = scan.exec(subject)) {
      if (accept(match)) return { secretClass, line: subject.slice(0, match.index + (match[1]?.length ?? 0)).split("\n").length };
      if (match[0] === "") scan.lastIndex += 1;
    }
    return null;
  };
  /* The opening line of the redactor's armored block: a key cut off before
     its END line is still a key, and a header needs no scan to the end. */
  const found = first(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private_key")
    ?? first(TOKEN_FAMILY_PATTERN, "api_token")
    ?? first(/\b\d{5,20}:[A-Za-z0-9_-]{30,64}\b/, "bot_token")
    ?? first(JWT_PATTERN, "jwt")
    ?? first(BEARER_TOKEN, "bearer_token")
    ?? first(AUTHORIZATION_HEADER, "authorization_header", (match) => credentialShaped(match[0].slice(match[0].indexOf(":") + 1)))
    ?? first(COOKIE_HEADER, "cookie_header", (match) => match[0].slice(match[0].indexOf(":") + 1).trim().length >= 8)
    ?? first(ASSIGNMENT, "credential_assignment", (match) => assignedCredential(match, unquotedKeys), unquotedKeys);
  if (found) return found;
  let scrubbed: string;
  try { scrubbed = redactKnownProviderSecrets(text); } catch { scrubbed = ""; }
  if (scrubbed !== text) return { secretClass: "provider_credential", line: firstDifferentLine(text, scrubbed) };
  return null;
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

/**
 * `SECRET_VALUE_RE` matched `key: value`. A value shaped like a credential
 * (letters and digits) is one wherever it stands. A bare word counts too, as
 * the redactor's own pattern does (`password: hunter`, `secret=swordfish`),
 * unless the key is only `token`/`authorization`/`bearer`, which prose uses
 * loosely, or the word is a placeholder, a reference to a variable or a path.
 * The word must stand where a value stands, at the end of its line or before
 * the next assignment, so prose such as `Password: reset by the operator`
 * reads as prose.
 */
function assignedCredential(match: RegExpExecArray, subject: string): boolean {
  const key = match[1]!;
  const raw = match[0].slice(key.length + match[2]!.length + match[3]!.length);
  if (credentialShaped(raw)) return true;
  if (/^(?:token|authorization|bearer)$/i.test(key)) return false;
  const value = /^`?([^&;`]*)/.exec(raw)![1]!.replace(/[.,:;!?)\]]+$/, "");
  if (value.length < 4) return false;
  /* Only to the end of this line: the rest of a 20 MB file, copied and split
     once per keyword line, made the scan quadratic. Checked first because
     most keyword lines are prose and fail it. */
  const end = match.index + match[0].length;
  const lineEnd = subject.indexOf("\n", end);
  const after = raw.slice(raw.indexOf(value) + value.length) + subject.slice(end, lineEnd === -1 ? subject.length : lineEnd);
  if (!/^[`"'.,;:!?)\]}\s]*$/.test(after) && !/^[`"']?[\s,;&]+[\w.-]+\s*[:=]/.test(after)) return false;
  if (/^[[<{$*%/~]/.test(value) || /^x+$/i.test(value)) return false;
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
  const sample = bytes.subarray(0, 64 * 1024);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) {
      if (index % 2 === 0) evenZeros += 1;
      else oddZeros += 1;
    }
  }
  const pairs = Math.max(1, Math.floor(sample.length / 2));
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

function firstDifferentLine(left: string, right: string): number {
  const a = left.split("\n");
  const b = right.split("\n");
  const index = a.findIndex((line, position) => line !== b[position]);
  return index === -1 ? 1 : index + 1;
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
