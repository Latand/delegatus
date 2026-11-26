import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, open, promises as fs } from "node:fs";
import path from "node:path";
import { tryLockFenceExclusive } from "@/runtime-host/fenceLock";

export type ProvisioningLockKind = "checkout" | "repo" | "add";
export type ProvisioningGrant = { fd?: number; close(): void };

/** Resolve missing suffixes against the nearest known physical directory. */
export async function physicalProvisioningPath(filename: string): Promise<string> {
  let current = path.resolve(filename);
  const missing: string[] = [];
  for (;;) {
    try {
      await fs.lstat(current);
      const physical = await fs.realpath(current);
      const stat = await fs.stat(physical);
      if (!stat.isDirectory()) throw new Error("checkout path is not a directory");
      return path.join(physical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling alias never proves that its name is available.
      if (await fs.lstat(current).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      })) throw new Error("checkout path cannot be verified");
      const parent = path.dirname(current);
      if (parent === current) throw new Error("checkout parent cannot be verified");
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function provisioningStripe(physical: string): number {
  const key = process.platform === "darwin" ? physical.normalize("NFD").toLowerCase() : physical;
  return createHash("sha256").update(key).digest()[0]!;
}

const controlled = new Set<string>();

/** The returned grant is registered before returning to the awaiting caller. */
export async function tryProvisioningLock(root: string, kind: ProvisioningLockKind, stripe: number, native: boolean,
  signal: AbortSignal, own: (grant: ProvisioningGrant) => void): Promise<ProvisioningGrant | null> {
  const filename = path.join(root, "controller-locks", kind, String(stripe));
  if (!native) {
    signal.throwIfAborted();
    if (controlled.has(filename)) return null;
    controlled.add(filename);
    let open = true;
    const grant: ProvisioningGrant = { close() {
      if (!open) return;
      open = false;
      controlled.delete(filename);
    } };
    own(grant);
    return grant;
  }
  if (process.platform === "win32") throw new Error("pipeline Git checkout custody requires inherited POSIX locks");
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const fd = await new Promise<number>((resolve, reject) => {
    open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600,
      (error, descriptor) => error ? reject(error) : resolve(descriptor));
  });
  let acquired = false;
  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.nlink !== 1) throw new Error("invalid provisioning lock file");
    signal.throwIfAborted();
    if (!tryLockFenceExclusive({ fd, filename })) return null;
    acquired = true;
    let open = true;
    // Close this descriptor without LOCK_UN. An admitted add's inherited
    // descriptor must keep the same open file description (and lock) alive.
    const grant: ProvisioningGrant = { fd, close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    } };
    own(grant);
    return grant;
  } finally {
    if (!acquired) closeSync(fd);
  }
}
