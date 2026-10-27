import fs from "node:fs";
import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { currentWaitCorrelation } from "@/lib/blockingWaits";
import { captureProcessIdentity, processIdentityMayOwn, type ProcessIdentity } from "@/lib/processIdentity";

type Writer = ProcessIdentity & { token: string; callSite: string; acquiredAt: number };

/** Diagnostic evidence only. SQLite owns admission and releases its OS lock
 * when a process dies; a stale sidecar can never prevent or grant a write. */
export function observeRegistryWriter<T extends Database>(
  db: T, filename: string, fallbackCallSite = "registry synchronous write",
): T {
  const exec = db.exec.bind(db);
  const close = db.close.bind(db);
  const sidecar = `${filename}.writer.json`;
  const identity = captureProcessIdentity(process.pid);
  let writer: Writer | null = null;
  const clear = () => {
    if (!writer) return;
    try {
      const current = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Writer;
      if (current.token === writer.token) fs.unlinkSync(sidecar);
    } catch { /* diagnostics must not change transaction outcomes */ }
    writer = null;
  };
  db.exec = ((sql: string, ...args: unknown[]) => {
    // Clear while SQLite still excludes another publisher, never after unlock.
    if (/^\s*(?:COMMIT|END|ROLLBACK)(?:\s*;?\s*)$/i.test(sql)) clear();
    const result = exec(sql, ...args as []);
    if (/^\s*BEGIN\s+IMMEDIATE\b/i.test(sql)) {
      writer = { ...identity, token: crypto.randomUUID(),
        callSite: currentWaitCorrelation()?.label ?? fallbackCallSite, acquiredAt: Date.now() };
      try { fs.writeFileSync(sidecar, JSON.stringify(writer), { mode: 0o600 }); }
      catch { /* diagnostic evidence is best effort */ }
    }
    return result;
  }) as T["exec"];
  db.close = ((...args: Parameters<Database["close"]>) => { clear(); return close(...args); }) as T["close"];
  return db;
}

export function registryWriterDetail(filename: string): string {
  try {
    const writer = JSON.parse(fs.readFileSync(`${filename}.writer.json`, "utf8")) as Writer;
    if (Number.isInteger(writer.pid) && typeof writer.callSite === "string"
      && Number.isFinite(writer.acquiredAt) && processIdentityMayOwn(writer)) {
      return `holder=${writer.callSite} pid=${writer.pid} age=${Math.max(0, Date.now() - writer.acquiredAt)}ms`;
    }
  } catch { /* external SQLite writers may not publish evidence */ }
  return "holder=unattributed SQLite writer; inspect other state database writers and retry";
}
