import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DurableWriteOptions {
  /** Indentation passed to `JSON.stringify`; `0` writes one compact line.
      Defaults to 2, the shape every durable record has used. */
  space?: number;
}

/**
 * Atomic, durable JSON state write: temp file, fsync, rename, fsync the
 * directory. A plain `writeFileSync` + `rename` publishes a name that may point
 * at unwritten data after a crash, which for an append-only durable record is
 * indistinguishable from losing history.
 *
 * Mirrors the pattern the board and account stores already use, factored out so
 * every durable state file in `state/` is written the same way.
 */
export function writeJsonDurably(target: string, value: unknown, options: DurableWriteOptions = {}): void {
  const space = options.space ?? 2;
  writeTextDurably(target, `${space > 0 ? JSON.stringify(value, null, space) : JSON.stringify(value)}\n`);
}

/** fsync one file by path, for a writer that owns its own temp-and-rename steps.
    On Windows a directory cannot be opened for fsync at all, and NTFS journals
    the rename itself, so the directory step is skipped there: throwing after
    the rename already happened reported every durable write as failed. A file
    is flushed there only through a handle with write access (EPERM otherwise). */
export function fsyncPath(filename: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && fs.statSync(filename).isDirectory()) return;
  const descriptor = fs.openSync(filename, platform === "win32" ? "r+" : "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** The same durable write for a body that is already serialized. */
export function writeTextDurably(target: string, text: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, target);
    fsyncPath(path.dirname(target));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Read a rebuildable cache (#1870 slice 10). The value, or `undefined` when
 * the file is absent, unreadable, or does not parse. A file that does not
 * parse (torn by a crash, NUL-filled after a power loss) is discarded so the
 * owner's next write rebuilds it; a cache is never served as an error.
 *
 * The discard removes only the file that was read: a writer that renamed a
 * good copy into place in between keeps its copy.
 */
export function readJsonCache(target: string): unknown {
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, "r");
  } catch {
    return undefined;
  }
  let identity: fs.Stats;
  let text: string;
  try {
    identity = fs.fstatSync(descriptor);
    text = fs.readFileSync(descriptor, "utf8");
  } catch {
    return undefined;
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    discardCache(target, identity);
    return undefined;
  }
}

function discardCache(target: string, read: fs.Stats): void {
  try {
    const current = fs.lstatSync(target);
    if (current.ino !== read.ino || current.dev !== read.dev) return;
    fs.unlinkSync(target);
    console.error(`[state cache] discarded unreadable ${path.basename(target)}; it is rebuilt on the next write`);
  } catch {
    /* Already replaced or removed: nothing left to discard. */
  }
}
