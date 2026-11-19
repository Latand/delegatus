import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type Directory = { names: Map<string, Set<string>> };
type Artifact = { canonical: string | null; names: [Directory, string][] };

const MAX_PATHS = 65_536;
const MAX_DIRECTORIES = 16_384;
const MAX_COMPONENTS = 128;
const MOUNT_POLL = 2; // POLLPRI
// Linux event header plus a conservatively sized, padded filename.
const MAX_EVENT_BYTES = 16 + 4096;
// Local filesystems whose directory bindings are observed by inotify.
// Network and synthetic filesystems can change without sending these events.
const WATCHABLE_FILESYSTEMS = new Set([
  0xef53, // ext2/3/4
  0x9123683e, // btrfs
  0x58465342, // xfs
  0x01021994, // tmpfs
  0x794c7630, // overlayfs
  0x2fc12fc1, // zfs
]);

/** Reverse lookup of the current realpaths of registered host artifacts.
 * The kernel queue is drained synchronously before using the index, including
 * when a separate process retargets a link without touching the registry. */
export class NativeCallerArtifacts {
  private readonly library;
  private readonly pointer;
  private readonly mountPoll = Buffer.alloc(8);
  private readonly events = Buffer.allocUnsafe(8192);
  private readonly directories = new Map<string, Directory>();
  private readonly watches = new Map<number, Set<Directory>>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly byCanonical = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private readonly fd: number;
  private readonly mountFd: number;

  constructor() {
    const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
    this.pointer = ffi.ptr;
    this.library = ffi.dlopen("libc.so.6", {
      inotify_init1: { args: ["i32"], returns: "i32" },
      inotify_add_watch: { args: ["i32", "cstring", "u32"], returns: "i32" },
      poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    });
    this.fd = this.library.symbols.inotify_init1(0x800 | 0x80000); // NONBLOCK | CLOEXEC
    try {
      if (this.fd < 0) throw new Error("native caller artifact watch unavailable");
      this.mountFd = fs.openSync("/proc/self/mountinfo", fs.constants.O_RDONLY);
      this.mountPoll.writeInt32LE(this.mountFd);
      this.mountPoll.writeInt16LE(MOUNT_POLL, 4);
    } catch (error) {
      if (this.fd >= 0) fs.closeSync(this.fd);
      this.library.close();
      throw error;
    }
  }

  close(): void {
    try { fs.closeSync(this.fd); }
    finally {
      try { fs.closeSync(this.mountFd); }
      finally { this.library.close(); }
    }
  }

  private watch(parent: string, name: string, spelling: string, artifact: Artifact): void {
    let directory = this.directories.get(parent);
    if (!directory) {
      if (this.directories.size >= MAX_DIRECTORIES) throw new Error("native caller artifact watch limit");
      if (!WATCHABLE_FILESYSTEMS.has(fs.statfsSync(parent).type >>> 0)) throw new Error("native caller artifact filesystem unavailable");
      // ATTRIB, MOVED_FROM/TO, CREATE, DELETE, DELETE_SELF, MOVE_SELF.
      // ONLYDIR and DONT_FOLLOW ensure the final directory is physical.
      const descriptor = this.library.symbols.inotify_add_watch(this.fd, Buffer.from(parent + "\0"), 0xfc4 | 0x1000000 | 0x2000000);
      if (descriptor < 0) throw new Error("native caller artifact directory unavailable");
      directory = { names: new Map() };
      this.directories.set(parent, directory);
      const watchers = this.watches.get(descriptor) ?? new Set();
      watchers.add(directory);
      this.watches.set(descriptor, watchers);
    }
    const spellings = directory.names.get(name) ?? new Set();
    if (spellings.has(spelling)) return;
    spellings.add(spelling);
    directory.names.set(name, spellings);
    artifact.names.push([directory, name]);
  }

  private resolve(spelling: string, artifact: Artifact): string | null {
    // Resolve lexically one component at a time so missing paths and every
    // hop of a relative or absolute symlink have a watched dependency.
    const absolute = path.isAbsolute(spelling) ? spelling : `${process.cwd()}/${spelling}`;
    let components = absolute.split("/");
    let parent = "/";
    for (let steps = 0; components.length && steps < MAX_COMPONENTS; steps++) {
      const name = components.shift()!;
      if (!name || name === ".") continue;
      if (name === "..") { parent = path.dirname(parent); continue; }
      this.watch(parent, name, spelling, artifact);
      const next = path.join(parent, name);
      try {
        const stat = fs.lstatSync(next, { throwIfNoEntry: false });
        if (!stat) return null;
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(next);
          if (path.isAbsolute(target)) parent = "/";
          components = target.split("/").concat(components);
        } else {
          if (components.length && !stat.isDirectory()) return null;
          parent = next;
        }
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
        throw error;
      }
    }
    if (components.length) {
      try { fs.realpathSync(spelling); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") return null;
        throw error;
      }
      throw new Error("native caller artifact path exceeds the watch budget");
    }
    return parent;
  }

  add(spelling: string): void {
    if (this.artifacts.has(spelling)) return;
    if (this.artifacts.size >= MAX_PATHS) throw new Error("native caller artifact index limit");
    const artifact: Artifact = { canonical: null, names: [] };
    this.artifacts.set(spelling, artifact);
    artifact.canonical = this.resolve(spelling, artifact);
    if (artifact.canonical === null) return;
    if (fs.realpathSync(spelling) !== artifact.canonical) throw new Error("native caller artifact alias changed");
    const aliases = this.byCanonical.get(artifact.canonical) ?? new Set();
    aliases.add(spelling);
    this.byCanonical.set(artifact.canonical, aliases);
  }

  delete(spelling: string): void {
    this.dirty.delete(spelling);
    const artifact = this.artifacts.get(spelling);
    if (!artifact) return;
    this.artifacts.delete(spelling);
    for (const [directory, name] of artifact.names) {
      const spellings = directory.names.get(name)!;
      spellings.delete(spelling);
      if (!spellings.size) directory.names.delete(name);
    }
    if (artifact.canonical === null) return;
    const aliases = this.byCanonical.get(artifact.canonical)!;
    aliases.delete(spelling);
    if (!aliases.size) this.byCanonical.delete(artifact.canonical);
  }

  /** Each slice has a fixed event and path budget. Large changes stay pending
   * until preparation catches up. Queue loss or mount changes require a rebuild. */
  refresh(limit: number): boolean {
    let count: number;
    try { count = fs.readSync(this.fd, this.events, 0, this.events.length, null); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      count = 0;
    }
    for (let offset = 0; offset < count;) {
      const wd = this.events.readInt32LE(offset);
      const length = this.events.readUInt32LE(offset + 12);
      const watched = this.watches.get(wd);
      if (!watched || !length) throw new Error("native caller artifact watch lost");
      const name = this.events.toString("utf8", offset + 16, offset + 16 + length).replace(/\0.*$/, "");
      for (const directory of watched) {
        for (const spelling of directory.names.get(name) ?? []) {
          this.dirty.add(spelling);
          if (this.dirty.size > limit) throw new Error("native caller artifact paths changed together");
        }
      }
      offset += 16 + length;
    }
    // Rebinding may register new watches. Read again after any rebind before
    // using the map, so changes during the rebind are also observed.
    const unchanged = this.dirty.size === 0;
    for (const spelling of this.dirty) {
      this.delete(spelling);
      this.add(spelling);
    }
    if (this.library.symbols.poll(this.pointer(this.mountPoll), BigInt(1), 0) !== 0) throw new Error("native caller mount namespace changed");
    // A nonblocking inotify read stops at an empty queue or when the next
    // complete event will not fit. Spare space rules out the latter. Unrelated
    // events therefore need no second read merely to observe EAGAIN.
    return unchanged && this.events.length - count >= MAX_EVENT_BYTES;
  }

  aliases(transcript: string): ReadonlySet<string> | undefined {
    return this.byCanonical.get(transcript);
  }
}
