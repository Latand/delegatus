import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { performanceSpans } from "@/lib/performanceSpans";

/** A durable quarantine intent. The tree moves to `trash`, inside `gate`; the
 * pass closes the gate (mode 000) before its final holder scan and owner read,
 * and removes the tree from inside it, its own cwd being the trash. A process
 * of the installation user cannot newly reach the tree by either path once the
 * gate is closed, nor through this process's /proc links, which it seals for
 * that window, so no holder can arrive between that observation and removal.
 * Root bypasses directory permissions; a root holder is only seen if it held
 * the tree before the gate closed. */
export type GatedTrashRow = {
  directory: string; gate: string; trash: string; identity: string; uid: number;
  /** Set durably before the first unlink, after the tree's inventory: a partial
   * tree is never restored, and a replay removes only what that inventory lists. */
  deleting?: boolean;
  /** An adopted journal from before gates existed: its trash path and row. A
   * hold returns the tree there and puts that journal back. */
  legacyTrash?: string;
  legacyRow?: Record<string, unknown>;
  /** The release's revision and its age when it left its path. */
  context?: { sha: string; age?: number };
};
export type GatedTrashOutcome = { removed: true } | { removed: false; reason: string };
export type GatedTrashOptions = {
  /** Runs after the rename with the gate open; a reason restores the tree. */
  beforeGate?: (trash: string) => Promise<string | null>;
  /** Runs with the gate closed. Throwing restores the tree, then rethrows. */
  observe: (trash: string, gate: string) => Promise<string | null>;
  /** Runs with the gate closed and cwd at the trash: pass "." paths. */
  validate?: (root: ".") => boolean;
  /** Entries removed before the rest, relative to the trash. */
  first?: string[];
  /** Removes one entry, named relative to the trash (the process cwd). */
  remove?: (entry: string) => Promise<void>;
};

const trashName = (directory: string) => `.delegatus-trash-${path.basename(directory)}-`;
const sibling = (entry: string, directory: string) => path.dirname(entry) === path.dirname(directory)
  && path.basename(entry).startsWith(trashName(directory));

export const isGatedTrashRow = (row: unknown): row is GatedTrashRow => {
  const value = row as Partial<GatedTrashRow> | null;
  return !!value && typeof value.gate === "string" && typeof value.trash === "string" && typeof value.directory === "string"
    && typeof value.identity === "string" && Number.isSafeInteger(value.uid)
    && sibling(value.gate, value.directory) && value.trash === path.join(value.gate, path.basename(value.directory))
    && (value.legacyTrash === undefined || typeof value.legacyTrash === "string" && sibling(value.legacyTrash, value.directory));
};

/** Journal, then rename the tree out of its path. Null when it is not a plain directory. */
export function quarantineTree(directory: string, journal: string, context?: GatedTrashRow["context"]): GatedTrashRow | null {
  const original = fs.lstatSync(directory);
  if (!original.isDirectory() || original.isSymbolicLink()) return null;
  const gate = path.join(path.dirname(directory), `${trashName(directory)}${randomUUID()}`);
  const row: GatedTrashRow = { directory, gate, trash: path.join(gate, path.basename(directory)),
    identity: `${original.dev}:${original.ino}`, uid: original.uid, ...(context ? { context } : {}) };
  writeJsonDurably(journal, row);
  fs.mkdirSync(gate, { mode: 0o700 });
  fs.renameSync(directory, row.trash);
  return row;
}

/** Move the trash of a journal written before gates existed behind a gate,
 * after the checks its own replay made. Null leaves it untouched. */
export function adoptLegacyTrash(journal: string, row: { directory: string; trash: string; uid: number; identity: string; context?: { sha: string } } & Record<string, unknown>,
  unchanged: (trash: string) => boolean): GatedTrashRow | null {
  if (!sibling(row.trash, row.directory)) return null;
  const stat = fs.lstatSync(row.trash, { throwIfNoEntry: false });
  if (!stat) { fs.unlinkSync(journal); return null; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || identityOf(stat) !== row.identity || stat.uid !== row.uid
    || (process.getuid && stat.uid !== process.getuid()) || stat.dev !== fs.statSync(path.dirname(row.trash)).dev || !unchanged(row.trash)) return null;
  const gate = path.join(path.dirname(row.directory), `${trashName(row.directory)}${randomUUID()}`);
  const adopted: GatedTrashRow = { directory: row.directory, gate, trash: path.join(gate, path.basename(row.directory)),
    identity: row.identity, uid: row.uid, legacyTrash: row.trash, legacyRow: row, ...(row.context ? { context: row.context } : {}) };
  writeJsonDurably(journal, adopted);
  fs.mkdirSync(gate, { mode: 0o700 });
  fs.renameSync(row.trash, adopted.trash);
  return adopted;
}

/** Recovery measures and inspects a quarantine left by an interrupted pass. */
export function reopenGate(row: GatedTrashRow) {
  const gate = fs.lstatSync(row.gate, { throwIfNoEntry: false });
  if (gate?.isDirectory() && !gate.isSymbolicLink() && (!process.getuid || gate.uid === process.getuid())) fs.chmodSync(row.gate, 0o700);
}

const identityOf = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;
const removeEntry = (entry: string) => fs.promises.rm(entry, { recursive: true, force: true });

type Prctl = (option: number, value: number) => number;
let prctl: Prctl | null | undefined;
function loadPrctl(): Prctl | null {
  if (prctl !== undefined) return prctl;
  prctl = null;
  if (!process.versions.bun) return prctl;
  try {
    const ffi = process.getBuiltinModule("bun:ffi") as typeof import("bun:ffi");
    for (const name of ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"]) {
      try {
        const lib = ffi.dlopen(name, { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } });
        prctl = (option, value) => Number(lib.symbols.prctl(option, value, 0, 0, 0));
        break;
      } catch { /* Try the next C library name. */ }
    }
  } catch { /* No FFI: links stay unsealed and removal is refused. */ }
  return prctl;
}
const PR_GET_DUMPABLE = 3; const PR_SET_DUMPABLE = 4;
/** Linux /proc/<pid>/cwd and fd links reach a directory without its path, so
 * a closed gate alone does not keep a same-user process out of a tree this
 * process sits in. While a process is not dumpable, no unprivileged process
 * can follow its links. Returns the undo, or null when Linux links cannot be
 * sealed. Other platforms have no such links. */
export function sealProcessLinks(): (() => void) | null {
  if (process.platform !== "linux") return () => {};
  const call = loadPrctl();
  if (!call) return null;
  const before = call(PR_GET_DUMPABLE, 0);
  if (call(PR_SET_DUMPABLE, 0) !== 0 || call(PR_GET_DUMPABLE, 0) !== 0) return null;
  return () => { if (before === 1) call(PR_SET_DUMPABLE, 1); };
}

const INVENTORY_LIMIT = 200_000;
const inventoryFile = (journal: string) => `${journal}.inventory`;
const entryProof = (stat: fs.BigIntStats) => stat.isDirectory() ? `d:${stat.ino}`
  : `${stat.isSymbolicLink() ? "l" : "f"}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
/** Every entry below the cwd with the proof of its content: inode, size and
 * both change times. Null past the walk bound. */
function inventory(): Map<string, string> | null {
  return performanceSpans.sync("self-update.trash-inventory", () => {
    const entries = new Map<string, string>(); const pending = ["."];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const name of fs.readdirSync(directory)) {
        if (entries.size >= INVENTORY_LIMIT) return null;
        const entry = directory === "." ? name : path.join(directory, name);
        const stat = fs.lstatSync(entry, { bigint: true });
        entries.set(entry, entryProof(stat));
        if (stat.isDirectory()) pending.push(entry);
      }
    }
    return entries;
  });
}
/** A replay may find fewer entries than the inventory, never a new or changed one. */
function remainsOfInventory(journal: string): boolean {
  let listed: Map<string, string>;
  try {
    const rows = JSON.parse(fs.readFileSync(inventoryFile(journal), "utf8"));
    if (!Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.length === 2 && row.every(value => typeof value === "string"))) return false;
    listed = new Map(rows as [string, string][]);
  } catch { return false; }
  const current = inventory();
  return !!current && [...current].every(([entry, proof]) => listed.get(entry) === proof);
}

function dropInventory(journal: string) {
  try { fs.unlinkSync(inventoryFile(journal)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function finish(row: GatedTrashRow, journal: string) {
  try { fs.rmdirSync(row.gate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  dropInventory(journal);
  fs.unlinkSync(journal);
}

function restore(row: GatedTrashRow, journal: string) {
  if (row.legacyTrash && row.legacyRow) {
    fs.renameSync(row.trash, row.legacyTrash);
    fs.rmdirSync(row.gate);
    dropInventory(journal);
    writeJsonDurably(journal, row.legacyRow);
    return;
  }
  try { fs.lstatSync(row.directory); throw new Error("original path was acquired while trash is held; preserved both paths"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  fs.renameSync(row.trash, row.directory);
  finish(row, journal);
}

/** Settle a quarantine: restore the tree when anything holds it, else remove
 * it while the gate is closed. Recovery calls this again with the same row. */
export async function settleGatedTrash(journal: string, row: GatedTrashRow, options: GatedTrashOptions): Promise<GatedTrashOutcome> {
  const legacy = row.legacyTrash ? fs.lstatSync(row.legacyTrash, { throwIfNoEntry: false }) : undefined;
  if (legacy && (!legacy.isDirectory() || legacy.isSymbolicLink() || identityOf(legacy) !== row.identity))
    return { removed: false, reason: "changed" };
  if (!fs.existsSync(row.gate)) {
    // Journaled before the gate was made, or the gate went after a removal or restore.
    if (legacy) fs.mkdirSync(row.gate, { mode: 0o700 });
    else { fs.unlinkSync(journal); return row.deleting ? { removed: true } : { removed: false, reason: "changed" }; }
  }
  const gateStat = fs.lstatSync(row.gate);
  if (!gateStat.isDirectory() || gateStat.isSymbolicLink() || (process.getuid && gateStat.uid !== process.getuid()))
    return { removed: false, reason: "changed" };
  fs.chmodSync(row.gate, 0o700);
  let moved = fs.lstatSync(row.trash, { throwIfNoEntry: false });
  if (!moved && legacy) { fs.renameSync(row.legacyTrash!, row.trash); moved = fs.lstatSync(row.trash); }
  if (!moved) {
    // Interrupted before the rename, or after the last unlink.
    finish(row, journal);
    return row.deleting ? { removed: true } : { removed: false, reason: "changed" };
  }
  if (!moved.isDirectory() || moved.isSymbolicLink() || identityOf(moved) !== row.identity || moved.uid !== row.uid)
    return { removed: false, reason: "changed" };
  const keep = (reason: string): GatedTrashOutcome => {
    if (!row.deleting) restore(row, journal);
    return { removed: false, reason };
  };
  if (!row.deleting && options.beforeGate) {
    const reason = await options.beforeGate(row.trash);
    if (reason) return keep(reason);
  }
  const previous = process.cwd();
  let reason: string | null = null;
  let failure: unknown;
  let removing = false;
  let unseal: (() => void) | null = null;
  process.chdir(row.trash);
  try {
    try {
      unseal = sealProcessLinks();
      if (!unseal) reason = "process-links-unsealed";
      else {
        fs.chmodSync(row.gate, 0o000);
        reason = await options.observe(row.trash, row.gate);
        if (!reason && identityOf(fs.lstatSync(".")) !== row.identity) reason = "changed";
        if (!reason && options.validate && !options.validate(".")) reason = "changed";
        // A replay finishes only what the interrupted removal had inventoried.
        if (!reason && row.deleting && !remainsOfInventory(journal)) reason = "changed";
        if (!reason && !row.deleting) {
          const entries = inventory();
          if (!entries) reason = "inventory-bound";
          else writeJsonDurably(inventoryFile(journal), [...entries], { space: 0 });
        }
      }
    } catch (error) { failure = error; }
    if (!reason && failure === undefined) {
      removing = true;
      if (!row.deleting) { row.deleting = true; writeJsonDurably(journal, row); }
      const remove = options.remove ?? removeEntry;
      for (const entry of options.first ?? []) {
        if (fs.lstatSync(path.dirname(entry), { throwIfNoEntry: false })?.isDirectory() && fs.existsSync(entry)) await remove(entry);
      }
      for (const entry of fs.readdirSync(".").sort()) await remove(entry);
    }
  } finally {
    process.chdir(previous);
    unseal?.();
    fs.chmodSync(row.gate, 0o700);
  }
  if (failure !== undefined) { keep("changed"); throw failure; }
  if (reason) return keep(reason);
  if (!removing) return keep("changed");
  fs.rmdirSync(row.trash);
  finish(row, journal);
  return { removed: true };
}
