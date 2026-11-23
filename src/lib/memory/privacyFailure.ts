/** Only these static diagnostics may cross the worker boundary or enter logs.
 * Never retain an exception message, stack, path, SQL statement or rule text. */
const failures = {
  "store-busy": true,
  "worker-timeout": true,
  "window-exhausted": false,
  "worker-queue-full": true,
  "worker-exited": false,
  "worker-io": false,
  "worker-retirement-timeout": true,
  "store-changed": true,
  "store-unreadable": false,
  "worker-unavailable": false,
  "worker-invalid-reply": false,
  "worker-input-too-large": false,
  "worker-shutdown": false,
  "access-denied": false,
  "store-corrupt": false,
  "store-io": false,
  "disk-full": false,
  "file-limit": false,
  "store-open-failed": false,
  "path-missing": false,
  "syntax-error": false,
  "type-error": false,
  "range-error": false,
} as const;
export type PrivacyFailure = keyof typeof failures;
export function privacyFailureCode(value: unknown): PrivacyFailure | undefined {
  return typeof value === "string" && Object.hasOwn(failures, value) ? value as PrivacyFailure : undefined;
}
export class PrivacyWorkError extends Error {
  constructor(readonly failure: PrivacyFailure) { super(failure); }
}
export const transientPrivacyFailure = (failure: PrivacyFailure) => failures[failure];

export function privacyFailureOf(error: unknown, fallback: PrivacyFailure = "worker-unavailable"): PrivacyFailure {
  if (error instanceof PrivacyWorkError) return privacyFailureCode(error.failure) ?? fallback;
  if (!error || typeof error !== "object") return fallback;
  const fields = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; failure?: unknown };
  // A shared resident can belong to another compiled route bundle. Validate
  // its static category without relying on constructor identity across bundles.
  const carried = privacyFailureCode(fields.failure) ?? privacyFailureCode(
    fields.cause && typeof fields.cause === "object" ? (fields.cause as { failure?: unknown }).failure : undefined);
  if (carried) return carried;
  if (fields.name === "StateLockDeferredError" || fields.name === "FileTransactionAdmissionError") return "store-busy";
  if (["SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_BUSY"].includes(String(fields.code))) return "store-busy";
  if (["ETIMEDOUT", "ETIME"].includes(String(fields.code)) || fields.name === "TimeoutError") return "worker-timeout";
  if (["EACCES", "EPERM"].includes(String(fields.code))) return "access-denied";
  if (["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(String(fields.code))) return "store-corrupt";
  if (["EIO", "SQLITE_IOERR"].includes(String(fields.code))) return "store-io";
  if (["ENOSPC", "SQLITE_FULL"].includes(String(fields.code))) return "disk-full";
  if (["EMFILE", "ENFILE"].includes(String(fields.code))) return "file-limit";
  if (fields.code === "SQLITE_CANTOPEN") return "store-open-failed";
  if (fields.code === "ENOENT") return "path-missing";
  // SQLite and the collection adapter sometimes supply only a message. Match
  // their fixed diagnostics; never copy any part of that message to output.
  if (typeof fields.message === "string") {
    if (/^(?:database is (?:locked|busy)|role memory busy)$/.test(fields.message)) return "store-busy";
    if (fields.message === "role_memory SQLite row is malformed" || fields.message.startsWith("corrupt role_memory SQLite row:")) return "store-corrupt";
  }
  if (fields.name === "SyntaxError") return "syntax-error";
  if (fields.name === "TypeError") return "type-error";
  if (fields.name === "RangeError") return "range-error";
  return fallback;
}
