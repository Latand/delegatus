import type { SeenRequest } from "./self";

type PendingProbe = { expiry: number; seen: SeenRequest | null; arrivedHost: string | null; host: string };
const shared = globalThis as typeof globalThis & { __delegatusSelfProbes?: Map<string, PendingProbe> };
// The existing nonce owner in self.ts caps this map at 32, expires entries
// after 30 seconds and removes each probe when its HTTP request settles.
export const pendingSelfProbes = shared.__delegatusSelfProbes ??= new Map<string, PendingProbe>();

export function pendingSelfProbeHost(nonce: string): string | null {
  const probe = pendingSelfProbes.get(nonce);
  return probe && !probe.seen && probe.expiry >= Date.now() ? probe.host : null;
}
