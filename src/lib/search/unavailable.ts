const DIAGNOSTIC_CODES = new Set([
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CORRUPT", "SQLITE_NOTADB",
  "SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_ERROR",
  "EACCES", "EPERM", "ENOENT", "EMFILE", "ENFILE", "ENOSPC",
]);

/** Keep a diagnostic without publishing SQL, paths, queries or exception text.
 * A JSON 503 is an answered domain failure, so MCP stops transport recovery. */
export function searchUnavailable(index: "memory" | "transcript", error: unknown): Response {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  console.error("[search unavailable]", index, typeof code === "string" && DIAGNOSTIC_CODES.has(code) ? code : "unexpected");
  return Response.json({
    code: index === "memory" ? "MEMORY_SEARCH_UNAVAILABLE" : "TRANSCRIPT_SEARCH_UNAVAILABLE",
    error: `${index === "memory" ? "Memory" : "Transcript"} search is unavailable; retry later or check index diagnostics.`,
  }, { status: 503 });
}
