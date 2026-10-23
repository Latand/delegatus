import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Next route bundles share a process but can instantiate this module separately.
// No authority key or grant ledger is stored beside agent-writable JSON.
type Owner = { key: Buffer; committed: Map<string, Set<string>> };
const host = globalThis as typeof globalThis & { __voiceToolSeals?: Owner };
const owner = host.__voiceToolSeals ??= { key: randomBytes(32), committed: new Map() };
export function seal(scope: string, value: unknown): string {
  return createHmac("sha256", owner.key).update(JSON.stringify([scope, value])).digest("hex");
}
/** Commit after the authorized atomic rename; an uncommitted temp file grants nothing. */
export function commitSeals(scope: string, macs: string[]): void {
  owner.committed.delete(scope);
  owner.committed.set(scope, new Set(macs));
  // One installation uses two scopes. Extra test/embedded stores evict fail-closed.
  while (owner.committed.size > 64) owner.committed.delete(owner.committed.keys().next().value!);
}
export function validSeal(scope: string, value: unknown, mac: unknown): boolean {
  return typeof mac === "string" && /^[a-f0-9]{64}$/.test(mac)
    && owner.committed.get(scope)?.has(mac) === true
    && timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(seal(scope, value), "hex"));
}
