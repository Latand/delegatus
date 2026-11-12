import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

export type AttemptMutationWatch = string | { directory: string; entries: readonly string[] } | { file: string };

/** Watch the names that bind a path, including the nearest existing parent
 * of a missing component. Unrelated entries in its ancestors carry no proof. */
export function attemptPathWatches(files: readonly string[]): AttemptMutationWatch[] {
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
      if (stat?.isDirectory() && !stat.isSymbolicLink()) watches.push({ directory, entries: [...entries] });
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
export function attemptMutationCurrent(directories: readonly AttemptMutationWatch[], validate: () => boolean, budgetMs = 30_000): boolean {
  if (process.platform !== "linux")
    throw new AttemptTempBudgetDeferred("attempt mutation fence unavailable on this platform");
  const until = performance.now() + Math.max(0, Math.min(30_000, budgetMs));
  const requested = new Map<string, Set<string> | undefined>();
  const files = new Set<string>();
  for (const watch of directories) {
    if (typeof watch !== "string" && "file" in watch) { files.add(watch.file); continue; }
    const directory = typeof watch === "string" ? watch : watch.directory;
    const entries = typeof watch === "string" ? undefined : new Set(watch.entries);
    if (!requested.has(directory)) requested.set(directory, entries);
    else if (!entries) requested.set(directory, undefined);
    else for (const name of entries) requested.get(directory)?.add(name);
  }
  const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
  const library = ffi.dlopen("libc.so.6", {
    inotify_init1: { args: ["i32"], returns: "i32" },
    inotify_add_watch: { args: ["i32", "cstring", "u32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
  });
  // IN_NONBLOCK | IN_CLOEXEC. A child can never inherit this fence.
  const fd = library.symbols.inotify_init1(0x800 | 0x80000);
  const watched = new Map<number, Set<string> | undefined>();
  let mountFd: number | undefined;
  let unavailable: string | undefined;
  try {
    if (fd < 0) throw new AttemptTempBudgetDeferred("attempt mutation fence unavailable");
    // inotify does not report a mount covering a watched directory. procfs
    // exposes namespace changes through POLLPRI, independent of device ids.
    mountFd = fs.openSync("/proc/self/mountinfo", fs.constants.O_RDONLY);
    const mountPoll = Buffer.alloc(8);
    mountPoll.writeInt32LE(mountFd, 0); mountPoll.writeInt16LE(2, 4);
    for (const [directory, entries] of requested) {
      if (performance.now() >= until) throw new AttemptTempBudgetDeferred("attempt mutation fence time budget exhausted");
      // MODIFY, ATTRIB, MOVED_FROM/TO, CREATE, DELETE, DELETE_SELF, MOVE_SELF;
      // ONLYDIR and DONT_FOLLOW prevent a replacement link changing the watch.
      const wd = library.symbols.inotify_add_watch(fd, Buffer.from(directory + "\0"), 0xfc6 | 0x1000000 | 0x2000000);
      if (wd < 0) { unavailable = "attempt mutation fence directory watch unavailable"; continue; }
      if (!watched.has(wd)) watched.set(wd, entries);
      else if (!entries) watched.set(wd, undefined);
      else for (const name of entries) watched.get(wd)?.add(name);
    }
    // File watches also see writes through hardlinks outside the tree. A
    // directory watch alone sees only operations through its own child name.
    for (const file of files) {
      if (performance.now() >= until) throw new AttemptTempBudgetDeferred("attempt mutation fence time budget exhausted");
      const wd = library.symbols.inotify_add_watch(fd, Buffer.from(file + "\0"), 0xfc6 | 0x2000000);
      if (wd < 0) { unavailable = "attempt mutation fence marker watch unavailable"; continue; }
      watched.set(wd, undefined);
    }
    // Preserve an ordinary authority/protection refusal, including quarantine
    // restoration, when it already proves this dispatch ineligible. A missing
    // watch is a distinct deferral only if the observations otherwise admit.
    if (!validate()) return false;
    if (unavailable) throw new AttemptTempBudgetDeferred(unavailable);
    if (performance.now() >= until) return false;
    const buffer = Buffer.allocUnsafe(4096);
    while (performance.now() < until) {
      let count: number;
      try { count = fs.readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN")
          return library.symbols.poll(ffi.ptr(mountPoll), BigInt(1), 0) === 0;
        throw new AttemptTempBudgetDeferred("attempt mutation fence change queue unavailable");
      }
      if (!count) return false;
      for (let offset = 0; offset < count;) {
        if (offset + 16 > count) return false;
        const wd = buffer.readInt32LE(offset), length = buffer.readUInt32LE(offset + 12);
        if (offset + 16 + length > count || !watched.has(wd)) return false;
        const name = buffer.subarray(offset + 16, offset + 16 + length).toString().replace(/\0.*$/, "");
        // Self events and overflow/watch loss always invalidate. Ancestors
        // observe only names used by discovery, aliases or authority files.
        if (!name || !watched.get(wd) || watched.get(wd)!.has(name)) return false;
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
