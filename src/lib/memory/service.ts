import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { guardedContext } from "@/lib/stateOwnership";
import { MemoryIndex } from "./index";
import { discoverMemorySources, type MemoryRoots } from "./sources";

const host = globalThis as typeof globalThis & { __delegatusMemoryIndexes?: Map<string, MemoryIndex> };

export function memoryIndex(): MemoryIndex {
  const stores = host.__delegatusMemoryIndexes ??= new Map();
  const directory = stateDir();
  let index = stores.get(directory);
  if (!index) { index = new MemoryIndex(); stores.set(directory, index); }
  return index;
}

async function defaultRoots(): Promise<MemoryRoots> {
  const home = os.homedir();
  const claudeHome = process.env.LLV_CLAUDE_HOME || path.join(home, ".claude");
  const codexHome = process.env.LLV_CODEX_HOME || path.join(home, ".codex");
  const managed = path.join(path.dirname(stateDir()), "accounts", "claude");
  let homes: string[] = [];
  try {
    homes = (await fs.readdir(managed, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(managed, entry.name));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Memory root discovery failed"); }
  // Enumerating known homes avoids account-list helpers that can recover removals.
  return {
    claudeHomes: [claudeHome, ...homes], codexHome,
    skillRoots: [path.join(home, ".agents", "skills"), path.join(codexHome, "skills"), path.join(claudeHome, "skills"), ...homes.map(home => path.join(home, "skills"))],
  };
}

/** Refresh on the existing scan cadence. A test/build cannot discover live memories. */
export async function refreshMemoryIndex(roots?: MemoryRoots) {
  if (!roots && guardedContext()) return;
  const inventory = await discoverMemorySources(roots ?? await defaultRoots());
  return memoryIndex().refresh(inventory.sources, { complete: inventory.complete });
}
