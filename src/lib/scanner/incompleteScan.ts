/** An inventory whose derivation is still incomplete must never prove absence. */
export class FileScanIncompleteError extends Error {
  readonly code = "FILE_SCAN_INCOMPLETE";
  constructor() {
    super("filesystem scan incomplete");
    this.name = "FileScanIncompleteError";
  }
}

export const FILE_SCAN_RETRY_SECONDS = 5;

/** Next instrumentation and route bundles can instantiate different classes. */
export function isFileScanIncompleteError(error: unknown): error is FileScanIncompleteError {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "FILE_SCAN_INCOMPLETE";
}
