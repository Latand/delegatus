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
 * when a root contains them, its type and size are bounded, and a text file
 * is scanned with the redactor's own secret patterns. A refusal names the
 * class of what it found and never the value.
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
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".txt", ".log", ".json", ".csv", ".html"]);
const ALLOWED: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS);

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
    ?? first(SECRET_VALUE_RE, "credential_assignment", (match) => credentialShaped(match[0].slice(match[1]!.length + match[2]!.length + match[3]!.length)), unquotedKeys);
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
  const value = raw.trim().replace(/^["']|["']$/g, "").replace(/^(?:Bearer|Basic|Token)\s+/i, "");
  if (value.length < 8 || /^[[<{$*%]/.test(value) || /^x+$/i.test(value)) return false;
  return /[A-Za-z]/.test(value) && /\d/.test(value);
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

  let real: string;
  try {
    real = fs.realpathSync.native(requested);
  } catch {
    throw new DocumentRefusal("document_invalid", `${requested} does not exist or cannot be read on the Viewer host`);
  }
  const realDot = dotSegment(real);
  if (realDot !== null) throw new DocumentRefusal("document_forbidden_path", `${requested} resolves through ${realDot}; files in dot-directories are never sent`);
  if (forbiddenDirectories(environment).some((forbidden) => within(real, forbidden))) {
    throw new DocumentRefusal("document_forbidden_path", `${requested} is inside the Delegatus state directory, which is never sent`);
  }
  const realRoots = roots.map((root) => realOrSelf(root));
  if (!realRoots.some((root) => within(real, root) && real !== root)) {
    throw new DocumentRefusal("document_outside_roots", `${requested} is not under a document root (${roots.join(", ")}); write the report under one of them`);
  }

  const extension = extensionOf(real);
  if (!ALLOWED.has(extension)) {
    throw new DocumentRefusal("document_type", `${extension || "a file without an extension"} is not a document type the bot sends; allowed: ${DOCUMENT_EXTENSIONS.join(" ")}`);
  }
  const filename = shown === undefined || shown === null ? path.basename(requested) : shown;
  if (typeof filename !== "string" || filename.trim() === "" || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename) || filename.startsWith(".")) {
    throw new DocumentRefusal("document_invalid", "document.filename must be a plain file name without slashes or a leading dot");
  }
  if (!ALLOWED.has(extensionOf(filename))) {
    throw new DocumentRefusal("document_type", `the shown filename must end in one of ${DOCUMENT_EXTENSIONS.join(" ")}`);
  }

  let bytes: Buffer;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new DocumentRefusal("document_invalid", `${requested} is not a regular file`);
    /* A second name for a file elsewhere would carry it past the root check. */
    if (stat.nlink > 1) throw new DocumentRefusal("document_forbidden_path", `${requested} is hard-linked to another name, so where it lives cannot be checked`);
    if (stat.size === 0) throw new DocumentRefusal("document_invalid", `${requested} is empty`);
    if (stat.size > DOCUMENT_MAX_BYTES) throw new DocumentRefusal("document_too_large", `${requested} is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB`);
    bytes = fs.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof DocumentRefusal) throw error;
    throw new DocumentRefusal("document_invalid", `${requested} cannot be read on the Viewer host`);
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch { /* already closed */ }
  }
  if (bytes.length === 0) throw new DocumentRefusal("document_invalid", `${requested} is empty`);
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new DocumentRefusal("document_too_large", `${requested} is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB`);

  const signature = extension === ".pdf" ? bytes.subarray(0, 5).toString("latin1") === "%PDF-"
    : extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : extension === ".jpg" || extension === ".jpeg" ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : true;
  if (!signature) throw new DocumentRefusal("document_type", `${requested} does not hold what its ${extension} extension says`);

  if (TEXT_EXTENSIONS.has(extension)) {
    const hit = documentSecret(bytes.toString("utf8"));
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
