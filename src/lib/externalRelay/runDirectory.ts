import fs from "node:fs";
import path from "node:path";
import { homeDirectory } from "@/lib/platformHome";

/** HOME is mounted at the same path for the Viewer and native host CLIs.
 * Container /tmp and configurable state/cache roots need not be shared. */
export function ownerRunRoot(): string {
  return path.join(homeDirectory(), ".cache", "delegatus", "relay-runs");
}

export async function createOwnerRunDirectory(root = ownerRunRoot()): Promise<string> {
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.promises.mkdtemp(path.join(root, "llv-external-relay-"));
  // Resolve once at creation so the prompt, staged files, and upload all use
  // the same physical run root when an ancestor such as ~/.cache is a link.
  return fs.promises.realpath(directory);
}

/** Resolve a retained owner run once and verify that it is a direct child of
 * the current physical run root before recovery reuses it. */
export async function resolveOwnerRunDirectory(directory: string, rootPath = ownerRunRoot()): Promise<string> {
  const [root, real] = await Promise.all([fs.promises.realpath(rootPath), fs.promises.realpath(directory)]);
  if (path.dirname(real) !== root || !path.basename(real).startsWith("llv-external-relay-")) {
    throw new Error("external relay owner run directory is outside its root");
  }
  return real;
}

/** Synchronous counterpart for bounded cleanup after the run has settled. */
export function isOwnerRunDirectory(directory: string, rootPath = ownerRunRoot()): boolean {
  try {
    const root = fs.realpathSync(rootPath);
    const real = fs.realpathSync(directory);
    return path.dirname(real) === root && path.basename(real).startsWith("llv-external-relay-");
  } catch {
    return false;
  }
}

export function removeOwnerRunDirectory(directory: string, rootPath = ownerRunRoot()): void {
  if (isOwnerRunDirectory(directory, rootPath)) fs.rmSync(directory, { recursive: true, force: true });
}
