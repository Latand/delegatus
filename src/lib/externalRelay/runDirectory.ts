import fs from "node:fs";
import path from "node:path";
import { homeDirectory } from "@/lib/platformHome";

/** HOME is mounted at the same path for the Viewer and native host CLIs.
 * Container /tmp and configurable state/cache roots need not be shared. */
export function ownerRunRoot(): string {
  return path.join(homeDirectory(), ".cache", "delegatus", "relay-runs");
}

export async function createOwnerRunDirectory(): Promise<string> {
  const root = ownerRunRoot();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  return fs.promises.mkdtemp(path.join(root, "llv-external-relay-"));
}
