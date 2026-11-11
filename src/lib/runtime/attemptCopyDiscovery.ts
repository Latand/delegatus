import { createRequire } from "node:module";
import fs from "node:fs";

type Page = { names: string[]; cursor: string; done: boolean; read: number; bytes: number };

/** Kernel directory positions avoid reading or sorting the backlog before a
 * page. Bind the cookie to the directory generation: after any mutation we
 * start a new bounded scan; already registered rows make replay idempotent.
 * A 4 KiB read and its unconsumed tail are persisted together. In particular,
 * libc telldir tokens belong to a DIR stream and cannot survive a restart.
 * Unknown platforms retain legacy data rather than inventing a cursor. */
export function discoverAttemptCopies(directory: string, checkpoint: string, now: () => number, deadline: number): Page {
  if (now() >= deadline) return { names: [], cursor: checkpoint, done: false, read: 0, bytes: 0 };
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("legacy attempt copy discovery requires native directory positions");
  const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
  const readSymbol = process.platform === "darwin" ? "__getdirentries64" : "getdirentries64";
  const libc = ffi.dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    [readSymbol]: { args: ["i32", "ptr", "u64", "ptr"], returns: "i64" },
    lseek: { args: ["i32", "i64", "i32"], returns: "i64" },
  });
  const signature = () => {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attempt copy discovery parent changed");
    return [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":");
  };
  const generation = signature();
  let offset = BigInt(0), pending = Buffer.alloc(0);
  try {
    const previous = JSON.parse(checkpoint);
    if (previous.generation === generation && /^\d{1,19}$/.test(previous.offset) && typeof previous.pending === "string"
      && previous.pending.length <= 5464) {
      offset = BigInt(previous.offset); pending = Buffer.from(previous.pending, "base64");
    }
  } catch { /* A legacy lexical checkpoint starts one new bounded scan. */ }
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const names: string[] = [];
  let read = 0, done = false, bytes = 0;
  try {
    if (BigInt(libc.symbols.lseek!(fd, offset, 0) as number | bigint) !== offset) throw new Error("attempt copy discovery seek failed");
    const fill = () => {
      const buffer = Buffer.alloc(4096), base = Buffer.alloc(8);
      bytes = Number(libc.symbols[readSymbol]!(fd, ffi.ptr(buffer), BigInt(4096), ffi.ptr(base)));
      if (bytes < 0 || bytes > buffer.length) throw new Error("attempt copy discovery read failed");
      pending = buffer.subarray(0, bytes); done = bytes === 0;
      offset = BigInt(libc.symbols.lseek!(fd, BigInt(0), 1) as number | bigint);
      if (offset < BigInt(0)) throw new Error("attempt copy discovery position unavailable");
    };
    const nameOffset = process.platform === "darwin" ? 21 : 19;
    let consumed = 0;
    while (read < 32 && now() < deadline) {
      if (consumed === pending.length) {
        if (bytes || done) break;
        fill(); consumed = 0;
        if (done) break;
      }
      if (consumed + nameOffset >= pending.length) throw new Error("attempt copy discovery truncated record");
      const length = pending.readUInt16LE(consumed + 16);
      const end = pending.indexOf(0, consumed + nameOffset);
      if (length <= nameOffset || consumed + length > pending.length || end < 0 || end >= consumed + length)
        throw new Error("attempt copy discovery invalid record");
      const name = pending.toString("utf8", consumed + nameOffset, end);
      consumed += length;
      read++;
      if (name !== "." && name !== "..") names.push(name);
    }
    if (signature() !== generation) throw new Error("attempt copy discovery parent changed during page");
    return { names, cursor: JSON.stringify({ generation, offset: String(offset), pending: pending.subarray(consumed).toString("base64") }), done, read, bytes };
  } finally { fs.closeSync(fd); libc.close(); }
}
