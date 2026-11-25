import { closeSync, constants as FS, fstatSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { confirmPlace, fileIdentity, fsCode, lstatIfPresent, sameInode } from "./destination";
import { SecretRequestError, type FileIdentity } from "./types";

const CREATE = FS.O_RDWR | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW;
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const DARWIN_O_CLOEXEC = 0x01000000;
const DARWIN_O_SYMLINK = 0x00200000;
const DARWIN_ENOENT = 2;

function loadDarwinCalls() {
  try {
    const { dlopen, FFIType, read } = createRequire(import.meta.url)(`bun:${"ffi"}`) as typeof import("bun:ffi");
    const { i32, ptr } = FFIType;
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      // The mode argument is variadic and absent on a read-only open.
      openat: { args: [i32, ptr, i32], returns: i32 },
      renameat: { args: [i32, ptr, i32, ptr], returns: i32 },
      unlinkat: { args: [i32, ptr, i32], returns: i32 },
      __error: { args: [], returns: ptr },
    });
    return { symbols, read };
  } catch {
    throw new SecretRequestError("secret_platform_unsupported");
  }
}

let darwinCalls: ReturnType<typeof loadDarwinCalls> | undefined;
const cName = (name: string) => Buffer.from(name + "\0");

/** File mutations use the admitted directory descriptor even if a link is
 * planted at its former path after the last name check. */
export class SecretParentDirectory {
  private constructor(
    readonly handle: FileHandle, readonly place: string, readonly identity: FileIdentity,
  ) {}

  static async open(place: string, expected: FileIdentity): Promise<SecretParentDirectory> {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new SecretRequestError("secret_platform_unsupported");
    if (process.platform === "darwin") darwinCalls ??= loadDarwinCalls();
    const handle = await fs.open(place, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_DIRECTORY
      | (darwinCalls ? DARWIN_O_NOFOLLOW_ANY : 0)).catch(error => {
      if (fsCode(error) === "ENOTDIR" || fsCode(error) === "ELOOP") throw new SecretRequestError("secret_destination_link");
      throw error;
    });
    try {
      await confirmPlace(handle, place);
      if (!sameInode(await handle.stat({ bigint: true }), expected)) throw new SecretRequestError("secret_destination_changed");
      return new SecretParentDirectory(handle, place, expected);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  private entry(name: string): string {
    return path.join(darwinCalls ? this.place : `/proc/self/fd/${this.handle.fd}`, name);
  }

  async confirm() {
    await confirmPlace(this.handle, this.place);
    const named = await lstatIfPresent(this.place);
    if (!named?.isDirectory() || !sameInode(named, this.identity)) throw new SecretRequestError("secret_destination_changed");
  }

  async stat(name: string) {
    if (darwinCalls) await this.confirm();
    return lstatIfPresent(this.entry(name));
  }

  async temporaryStat(name: string) {
    if (!darwinCalls) return this.stat(name);
    // An open relative to the held directory also works after it moves.
    // O_SYMLINK returns a descriptor to a planted link itself for fstat.
    const fd = darwinCalls.symbols.openat(this.handle.fd, cName(name),
      FS.O_RDONLY | FS.O_NONBLOCK | DARWIN_O_CLOEXEC | DARWIN_O_SYMLINK);
    if (fd < 0) {
      const errno = darwinCalls.symbols.__error();
      if (errno && darwinCalls.read.i32(errno) === DARWIN_ENOENT) return null;
      throw new SecretRequestError("secret_destination_unavailable");
    }
    try { return fstatSync(fd, { bigint: true }); }
    finally { closeSync(fd); }
  }

  async create(name: string, made: (identity: FileIdentity) => void): Promise<FileHandle> {
    const entry = this.entry(name);
    await this.confirm();
    const handle = await fs.open(entry, CREATE | (darwinCalls ? DARWIN_O_NOFOLLOW_ANY : 0), 0o600);
    try {
      made(fileIdentity(await handle.stat({ bigint: true })));
      await confirmPlace(handle, path.join(this.place, name));
      await this.confirm();
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async rename(from: string, to: string) {
    if (!darwinCalls) return fs.rename(this.entry(from), this.entry(to));
    if (darwinCalls.symbols.renameat(this.handle.fd, cName(from), this.handle.fd, cName(to)) !== 0) {
      throw new SecretRequestError("secret_destination_unavailable");
    }
  }

  async unlink(name: string) {
    if (!darwinCalls) return fs.unlink(this.entry(name));
    if (darwinCalls.symbols.unlinkat(this.handle.fd, cName(name), 0) !== 0) {
      throw new SecretRequestError("secret_destination_unavailable");
    }
  }
}
