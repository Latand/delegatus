import { createInterface } from "node:readline";
import type { ImportRequest } from "./memory/importTypes";

process.env.LLV_STATE_OWNER = "viewer";
const { runMemoryImportWork, MemoryImportError, MemoryImportRecoveryError } = await import("./memory/importWork");

// One request per leased helper. The guardian contains it on Viewer death,
// demotion, cancellation and deadline. Every reply is bounded metadata.
for await (const line of createInterface({ input: process.stdin })) {
  try {
    if (Buffer.byteLength(line) > 64 * 1024) throw Error("invalid request");
    const parsed = JSON.parse(line);
    if (parsed.kind === "refresh-index") {
      const roots = parsed.roots;
      if (roots !== undefined && (!roots || !Array.isArray(roots.claudeHomes) || !Array.isArray(roots.skillRoots)
        || typeof roots.codexHome !== "string" || ![...roots.claudeHomes, ...roots.skillRoots].every(value => typeof value === "string")
        || Object.keys(roots).some(key => !["claudeHomes", "skillRoots", "codexHome"].includes(key)))) throw Error("invalid roots");
      const { refreshMemoryIndexLocally, memoryIndex } = await import("./memory/service");
      try { process.stdout.write(JSON.stringify({ refresh: await refreshMemoryIndexLocally(roots) }) + "\n"); }
      finally { memoryIndex().close(); }
      break;
    }
    const request = parsed as ImportRequest;
    const run = request.advance ? (await import("./memory/importLifecycle")).advanceMemoryImportWork : runMemoryImportWork;
    const result = await run(request, { phase: phase => { process.stdout.write(JSON.stringify({ phase }) + "\n"); } });
    const { kind, id, state, at, previous, backup, files, candidates, parts, reason } = result;
    // The durable record also holds roots and generation history; those do not
    // belong in this bounded counts-only helper reply.
    process.stdout.write(JSON.stringify({ result: { kind, id, state, at, previous, backup, files, candidates, parts, ...(reason ? { reason } : {}) } }) + "\n");
  } catch (error) {
    const recovery = error instanceof MemoryImportRecoveryError ? { reason: error.reason, statusPersistenceFailed: error.statusPersistenceFailed, sourceRestorationFailed: error.sourceRestorationFailed } : undefined;
    process.stdout.write(JSON.stringify({ error: error instanceof MemoryImportError ? error.reason : "failed", ...(recovery ? { recovery } : {}) }) + "\n");
    process.exitCode = 1;
  }
  break;
}
