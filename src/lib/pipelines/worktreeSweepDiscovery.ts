import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ListedWorktree } from "./worktreeSweep";

export type SweepInventory = { root: string; listed: ListedWorktree[]; failed?: boolean }[];

/** Advisory registration inventory, owned by one sweep helper for one pass.
 * No checkout contents, pipeline records or removal verdicts live here.
 * A new helper rediscovers and resumes the persisted pending queue.
 */
export class WorktreeSweepDiscovery {
  private saved?: { inputs: string; stamp: string; inventory: SweepInventory };
  constructor(private readonly maxEntries = 16_384, private readonly maxBytes = 4 * 1024 * 1024) {}

  async read(inputs: readonly string[], continuing: boolean, load: (observe: (roots: readonly string[]) => void) => Promise<SweepInventory>): Promise<SweepInventory> {
    const key = JSON.stringify(inputs);
    if (inputs.length > this.maxEntries || Buffer.byteLength(key) > this.maxBytes) {
      this.saved = undefined;
      return load(() => {});
    }
    const saved = this.saved;
    if (continuing && saved?.inputs === key && this.stamp(inputs, saved.inventory) === saved.stamp) return saved.inventory;
    this.saved = undefined;
    let before: string | null = null;
    const inventory = await load(roots => { before = this.stamp(inputs, roots.map(root => ({ root, listed: [] }))); });
    if (inventory.every(row => !row.failed) && inventory.reduce((sum, row) => sum + row.listed.length, 0) <= this.maxEntries
      && Buffer.byteLength(JSON.stringify(inventory)) <= this.maxBytes) {
      const stamp = this.stamp(inputs, inventory);
      if (stamp !== null && stamp === before) this.saved = { inputs: key, stamp, inventory };
    }
    return inventory;
  }

  /** Parent membership plus registration files detect additions, removals,
   * HEAD/lock changes and root replacement without spawning Git per slice.
   * Missing registration directories are stamped too (main-only repos).
   * A failed read disables reuse. Contents are never walked or watched.
   */
  private stamp(inputs: readonly string[], inventory: SweepInventory): string | null {
    const hash = createHash("sha256");
    let bytes = 0;
    const append = (value: string) => {
      bytes += Buffer.byteLength(value) + 1;
      if (bytes > this.maxBytes) throw new Error("discovery stamp exceeded its bound");
      hash.update(value).update("\0");
    };
    const stat = (file: string) => {
      try {
        const row = fs.lstatSync(file, { bigint: true });
        append(`${row.dev}:${row.ino}:${row.size}:${row.mtimeNs}:${row.ctimeNs}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        append("missing");
      }
    };
    try {
      for (const input of inputs) { stat(input); stat(path.join(input, ".git")); }
      for (const { root } of inventory) {
        stat(path.join(root, ".git/HEAD"));
        stat(path.join(root, ".git/packed-refs"));
        const refs = [path.join(root, ".git/refs")];
        let refEntries = 0;
        while (refs.length) {
          const directory = refs.pop()!;
          stat(directory);
          let children: fs.Dirent[];
          try { children = fs.readdirSync(directory, { withFileTypes: true }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++refEntries > this.maxEntries) return null;
            const file = path.join(directory, child.name);
            append(child.name); stat(file);
            if (child.isDirectory()) refs.push(file);
          }
        }
        const registrations = path.join(root, ".git/worktrees");
        stat(registrations);
        let names: string[];
        try { names = fs.readdirSync(registrations).sort(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (names.length > this.maxEntries) return null;
        for (const name of names) {
          append(name);
          const directory = path.join(registrations, name);
          for (const file of ["", "HEAD", "locked", "gitdir", "commondir"]) stat(path.join(directory, file));
        }
      }
      return hash.digest("hex");
    } catch { return null; }
  }
}
