import fs from "node:fs";
import path from "node:path";
import { homeDirectory } from "@/lib/platformHome";

const ownerRunPrefix = "llv-external-relay-";

/** HOME is mounted at the same path for the Viewer and native host CLIs.
 * Container /tmp and configurable state/cache roots need not be shared. */
export function ownerRunRoot(): string {
  return path.join(homeDirectory(), ".cache", "delegatus", "relay-runs");
}

export async function createOwnerRunDirectory(root = ownerRunRoot()): Promise<string> {
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  // Give the prompt, staging and upload the same path through a cache alias.
  const canonicalRoot = await fs.promises.realpath(root);
  return fs.promises.mkdtemp(path.join(canonicalRoot, ownerRunPrefix));
}

function ownerRunEntry(directory: string, root: string, parent: string): string | null {
  const name = path.basename(directory);
  return parent === root && name.startsWith(ownerRunPrefix) ? path.join(root, name) : null;
}

/** Resolve the parent of a retained run so a cache alias is allowed.
 * Recovery requires the run's own directory entry. */
export async function resolveOwnerRunDirectory(directory: string, rootPath = ownerRunRoot()): Promise<string> {
  const [root, parent] = await Promise.all([fs.promises.realpath(rootPath), fs.promises.realpath(path.dirname(directory))]);
  const entry = ownerRunEntry(directory, root, parent);
  if (!entry || !(await fs.promises.lstat(entry)).isDirectory()) {
    throw new Error("external relay owner run directory is outside its root");
  }
  return entry;
}

export function removeOwnerRunDirectory(directory: string, rootPath = ownerRunRoot()): void {
  let entry: string | null;
  try {
    entry = ownerRunEntry(directory, fs.realpathSync(rootPath), fs.realpathSync(path.dirname(directory)));
    if (!entry || !fs.lstatSync(entry).isDirectory()) return;
  } catch {
    return;
  }
  fs.rmSync(entry, { recursive: true, force: true });
}
