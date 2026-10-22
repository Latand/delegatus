/**
 * Inbox file-attachment policy shared by the server (admission before anything
 * is written) and the client (attach-time refusals) so both refuse the same
 * thing for the same reason. The sibling of `imagePolicy.ts` for everything an
 * image is not: a PDF, a log, an archive. No node: imports here — this module
 * is bundled into client components too.
 *
 * Large files use the streamed upload path; messages carry references to
 * completed uploads. Small files retain the inline JSON path.
 */
export const MAX_INBOX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_INBOX_FILES = 5;
export const MAX_INBOX_FILES_TOTAL_BYTES = 200 * 1024 * 1024;
/** Keep the browser and JSON parser's working set small. Older clients may
 * still send their original 20 MiB inline files. */
export const STREAM_INBOX_FILE_BYTES = 1024 * 1024;
export const MAX_INLINE_INBOX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_INBOX_FILES_TOTAL_BYTES = 40 * 1024 * 1024;

export interface ComposerUploadRef {
  id: string;
  bytes: number;
  sha256: string;
}

export function isComposerUploadRef(value: unknown): value is ComposerUploadRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as ComposerUploadRef;
  return /^[a-f0-9]{32}$/.test(ref.id) && Number.isSafeInteger(ref.bytes)
    && ref.bytes > 0 && ref.bytes <= MAX_INBOX_FILE_BYTES && /^[a-f0-9]{64}$/.test(ref.sha256);
}

export function sameComposerUploadRef(left: ComposerUploadRef | undefined, right: ComposerUploadRef | undefined): boolean {
  return left === undefined || right === undefined ? left === right
    : left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;
}

export interface ComposerFilePayload {
  name: string;
  base64: string;
  upload?: ComposerUploadRef;
}

export function composerFilePayload(file: ComposerFilePayload): ComposerFilePayload {
  return { name: file.name, base64: file.base64, ...(file.upload ? { upload: file.upload } : {}) };
}

/** Whole megabytes, for a refusal the operator reads rather than decodes. */
export function attachmentMegabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024) * 10) / 10);
}

const NAME_MAX = 100;

/**
 * The basename an upload is stored under: the operator's own filename wherever
 * it is safe to keep it, because the path is what the agent is told to open and
 * `звіт.pdf` names the file where `file-1724.bin` names nothing.
 *
 * Separators and control characters are removed rather than escaped, whitespace
 * collapses to `_` so one path stays one whitespace-free token in the delivered
 * message, and a name that reduces to nothing addressable (`.`, `..`, empty)
 * becomes a literal. The caller still resolves the joined path and refuses
 * anything outside the inbox — this is the first fence, not the only one.
 */
export function inboxAttachmentName(raw: string): string {
  const tail = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = tail.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, "_").trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return "attachment";
  if (cleaned.length <= NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, NAME_MAX - ext.length) + ext;
}
