import { createHash } from "node:crypto";

// Shared by source and bundle copies in one process. Never log arguments,
// request keys or caller identities; the fingerprint identifies the durable row.
const lifecycleKey = Symbol.for("delegatus.mcp.lifecycle");
const lifecycle = globalThis[lifecycleKey] ??= { role: "mcp", claims: new Map(), waiters: new Set(), installed: false };
export function logMcpLifecycle(reason, details = {}) {
  console.error(`[mcp lifecycle] ${JSON.stringify({ pid: process.pid, role: lifecycle.role,
    parentPid: process.ppid, reason, pendingClaims: [...lifecycle.claims.values()], ...details })}`);
}
export function installMcpLifecycle(role) {
  lifecycle.role = role;
  if (lifecycle.installed) return;
  lifecycle.installed = true;
  process.once("exit", code => logMcpLifecycle("process-exit", { code }));
  process.on("uncaughtExceptionMonitor", (_error, origin) => logMcpLifecycle("uncaught-exception", { origin }));
}
export function trackMcpClaim(key, digest) {
  const token = Symbol();
  lifecycle.claims.set(token, { tool: key.slice(0, key.indexOf(":")),
    claim: createHash("sha256").update(key).digest("hex"), digest });
  return () => {
    lifecycle.claims.delete(token);
    if (!lifecycle.claims.size) for (const resolve of lifecycle.waiters) resolve();
  };
}
export async function drainMcpClaims() {
  if (!lifecycle.claims.size) return;
  await new Promise(resolve => lifecycle.waiters.add(resolve));
  lifecycle.waiters.clear();
}
