import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

type DirectoryWatch = { directory: string; entries?: readonly string[]; content?: boolean | "authority" };
export type AttemptMutationWatch = string | DirectoryWatch | { file: string };

/** Watch the names that bind a path, including the nearest existing parent
 * of a missing component. Unrelated entries in its ancestors carry no proof. */
export function attemptPathWatches(files: readonly string[], content: boolean | "authority" = true): AttemptMutationWatch[] {
  const requested = new Map<string, Set<string>>();
  const watches: AttemptMutationWatch[] = [];
  for (const file of files) {
    for (let child = path.resolve(file), parent = path.dirname(child); child !== parent; child = parent, parent = path.dirname(child)) {
      if (!requested.has(parent)) requested.set(parent, new Set());
      requested.get(parent)!.add(path.basename(child));
    }
  }
  for (const [directory, entries] of requested) {
    try {
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (stat?.isDirectory() && !stat.isSymbolicLink()) watches.push({ directory, entries: [...entries], content });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return watches;
}

/** Synchronous validators read independent trees. A write during a later read
 * must invalidate an earlier one too. Keep a private kernel change queue for
 * the whole validation, then drain it immediately before dispatch.
 * Read/access events are excluded; overflow, unmount and watch loss all refuse.
 * No watcher or descriptor survives the synchronous fence. */
export function attemptMutationCurrent(directories: readonly AttemptMutationWatch[], validate: () => boolean, budgetMs = 30_000, authority?: () => boolean): boolean {
  if (process.platform !== "linux")
    throw new AttemptTempBudgetDeferred("attempt mutation fence unavailable on this platform");
  const until = performance.now() + Math.max(0, Math.min(30_000, budgetMs));
  const requested = new Map<string, DirectoryWatch[]>();
  const files = new Set<string>();
  for (const watch of directories) {
    if (typeof watch !== "string" && "file" in watch) { files.add(watch.file); continue; }
    const directory = typeof watch === "string" ? watch : watch.directory;
    if (!requested.has(directory)) requested.set(directory, []);
    requested.get(directory)!.push(typeof watch === "string" ? { directory } : watch);
  }
  const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
  const library = ffi.dlopen("libc.so.6", {
    inotify_init1: { args: ["i32"], returns: "i32" },
    inotify_add_watch: { args: ["i32", "cstring", "u32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
  });
  // IN_NONBLOCK | IN_CLOEXEC. A child can never inherit this fence.
  const fd = library.symbols.inotify_init1(0x800 | 0x80000);
  const watched = new Map<number, DirectoryWatch[]>();
  let mountFd: number | undefined;
  let unavailable: string | undefined;
  const changed = (reason = "filesystem proof changed"): false => {
    if (authority) throw new AttemptTempBudgetDeferred(`attempt mutation fence ${reason}`);
    return false;
  };
  try {
    if (fd < 0) throw new AttemptTempBudgetDeferred("attempt mutation fence unavailable");
    // inotify does not report a mount covering a watched directory. procfs
    // exposes namespace changes through POLLPRI, independent of device ids.
    mountFd = fs.openSync("/proc/self/mountinfo", fs.constants.O_RDONLY);
    const mountPoll = Buffer.alloc(8);
    mountPoll.writeInt32LE(mountFd, 0); mountPoll.writeInt16LE(2, 4);
    for (const [directory, rules] of requested) {
      if (performance.now() >= until) throw new AttemptTempBudgetDeferred("attempt mutation fence time budget exhausted");
      // MODIFY, ATTRIB, MOVED_FROM/TO, CREATE, DELETE, DELETE_SELF, MOVE_SELF;
      // ONLYDIR and DONT_FOLLOW prevent a replacement link changing the watch.
      // Structural proofs depend on entries, links and metadata. Writes to
      // ordinary checkout files and unrelated SQLite rows carry no proof.
      // MASK_ADD preserves the union when two paths name the same inode.
      const mask = rules.some(rule => rule.content !== false) ? 0xfc6 : 0xfc4;
      const wd = library.symbols.inotify_add_watch(fd, Buffer.from(directory + "\0"), mask | 0x1000000 | 0x2000000 | 0x20000000);
      if (wd < 0) { unavailable = "attempt mutation fence directory watch unavailable"; continue; }
      watched.set(wd, [...(watched.get(wd) ?? []), ...rules]);
    }
    // File watches also see writes through hardlinks outside the tree. A
    // directory watch alone sees only operations through its own child name.
    for (const file of files) {
      if (performance.now() >= until) throw new AttemptTempBudgetDeferred("attempt mutation fence time budget exhausted");
      const wd = library.symbols.inotify_add_watch(fd, Buffer.from(file + "\0"), 0xfc6 | 0x2000000 | 0x20000000);
      if (wd < 0) { unavailable = "attempt mutation fence marker watch unavailable"; continue; }
      watched.set(wd, [...(watched.get(wd) ?? []), { directory: file }]);
    }
    // Preserve an ordinary authority/protection refusal, including quarantine
    // restoration, when it already proves this dispatch ineligible. A missing
    // watch is a distinct deferral only if the observations otherwise admit.
    if (!validate()) return false;
    // Row-scoped authority is read after all tree/checkout observations.
    // Database writes prompt another row check, rather than invalidating an
    // unrelated root. Filesystem proof stays watched during those reads too.
    if (authority && !authority()) throw new AttemptTempBudgetDeferred("attempt mutation fence authority changed");
    if (unavailable) throw new AttemptTempBudgetDeferred(unavailable);
    if (performance.now() >= until) throw new AttemptTempBudgetDeferred("attempt mutation fence time budget exhausted");
    const buffer = Buffer.allocUnsafe(4096);
    let authorityChanged = false;
    while (performance.now() < until) {
      let count: number;
      try { count = fs.readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
          if (authorityChanged) {
            if (!authority || !authority()) throw new AttemptTempBudgetDeferred("attempt mutation fence authority changed");
            authorityChanged = false;
            continue;
          }
          return library.symbols.poll(ffi.ptr(mountPoll), BigInt(1), 0) === 0 || changed("mount namespace changed");
        }
        throw new AttemptTempBudgetDeferred("attempt mutation fence change queue unavailable");
      }
      if (!count) return changed("change queue closed");
      for (let offset = 0; offset < count;) {
        if (offset + 16 > count) return changed("change queue invalid");
        const wd = buffer.readInt32LE(offset), length = buffer.readUInt32LE(offset + 12);
        if (offset + 16 + length > count || !watched.has(wd)) return changed("change queue overflow or watch lost");
        const name = buffer.subarray(offset + 16, offset + 16 + length).toString().replace(/\0.*$/, "");
        // Self events and overflow/watch loss always invalidate. Ancestors
        // observe only names used by discovery, aliases or authority files.
        const mask = buffer.readUInt32LE(offset + 4);
        const matching = watched.get(wd)!.filter(rule => !rule.entries || rule.entries.includes(name));
        if (name && mask === 2 && matching.length && matching.every(rule => rule.content === "authority" || rule.content === false)) {
          authorityChanged ||= matching.some(rule => rule.content === "authority");
        } else if (!name || matching.some(rule => rule.content !== false || (mask & ~2) !== 0)) {
          return changed();
        }
        offset += 16 + length;
      }
    }
    throw new AttemptTempBudgetDeferred("attempt mutation fence time budget exhausted");
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    if (mountFd !== undefined) fs.closeSync(mountFd);
    library.close();
  }
}
