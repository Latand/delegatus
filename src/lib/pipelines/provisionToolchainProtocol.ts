import type { Readable } from "node:stream";
import type { PrivateInstallIntent, PrivateInstallReceipt } from "./provisionPrivateDependencies";

export const PROVISION_FRAME_LIMIT = 4096;

function validPrivateDirectory(value: unknown): value is Omit<PrivateInstallReceipt, "mode"> {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PrivateInstallReceipt>;
  return typeof row.claim === "string" && /^[a-f0-9-]{36}$/.test(row.claim) && typeof row.inputs === "string" && /^[a-f0-9]{64}$/.test(row.inputs)
    && typeof row.device === "string" && /^\d{1,24}$/.test(row.device) && typeof row.inode === "string" && /^\d{1,24}$/.test(row.inode);
}

export function validPrivateReceipt(value: unknown): value is PrivateInstallReceipt {
  return validPrivateDirectory(value) && ["staged", "handoff", "in-place", "copied"].includes((value as PrivateInstallReceipt).mode);
}

export function validPrivateIntent(value: unknown): value is PrivateInstallIntent {
  return validPrivateDirectory(value) && typeof (value as PrivateInstallIntent).nonceDigest === "string"
    && /^[a-f0-9]{64}$/.test((value as PrivateInstallIntent).nonceDigest);
}

export function provisionFrame(value: object): string {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) > PROVISION_FRAME_LIMIT) throw new Error("provisioning frame exceeds its bound");
  return frame;
}

export async function* provisionFrames(input: Readable): AsyncGenerator<Record<string, unknown>> {
  let pending = Buffer.alloc(0);
  for await (const incoming of input) {
    const bytes = Buffer.from(incoming as Uint8Array);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (pending.length + end - start >= PROVISION_FRAME_LIMIT) throw new Error("oversized provisioning frame");
      pending = Buffer.concat([pending, bytes.subarray(start, end)]);
      if (newline < 0) break;
      const value: unknown = JSON.parse(pending.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provisioning frame");
      pending = Buffer.alloc(0);
      start = newline + 1;
      yield value as Record<string, unknown>;
    }
  }
  if (pending.length) throw new Error("incomplete provisioning frame");
}
