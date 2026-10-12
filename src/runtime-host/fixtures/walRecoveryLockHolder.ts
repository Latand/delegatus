import fs from "node:fs";
import { dlopen, ptr } from "bun:ffi";

/* Holds, from its own process, the byte-range locks a SQLite connection holds
   on the wal-index while it runs WAL recovery: the write lock through the last
   reader slot exclusively, and the shared "some connection is here" byte. The
   locks are the real fcntl ones SQLite contends on; holding them directly
   keeps recovery "in progress" for as long as the test needs. Linux only:
   the flock layout below is the 64-bit Linux one. */
const [shm, holdMs] = [process.argv[2]!, Number(process.argv[3] ?? 0)];
const WAL_INDEX_PAGE_BYTES = 32768, WAL_WRITE_LOCK_BYTE = 120, WAL_LOCK_BYTES = 8, WAL_PRESENCE_BYTE = 128;
const F_SETLK = 6, F_RDLCK = 0, F_WRLCK = 1;
const libc = dlopen("libc.so.6", { fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" } });
const fd = fs.openSync(shm, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
// A recovering connection has already mapped the first index page.
fs.ftruncateSync(fd, WAL_INDEX_PAGE_BYTES);
function lock(type: number, start: number, length: number): void {
  const flock = Buffer.alloc(32);
  flock.writeInt16LE(type, 0);
  flock.writeBigInt64LE(BigInt(start), 8);
  flock.writeBigInt64LE(BigInt(length), 16);
  if (libc.symbols.fcntl(fd, F_SETLK, ptr(flock)) !== 0) throw new Error("the wal-index lock was refused");
}
lock(F_WRLCK, WAL_WRITE_LOCK_BYTE, WAL_LOCK_BYTES);
lock(F_RDLCK, WAL_PRESENCE_BYTE, 1);
console.log("held");
// Exiting drops the locks, as the end of recovery does.
if (holdMs > 0) setTimeout(() => process.exit(0), holdMs);
else setInterval(() => { /* held until the test stops this process */ }, 1000);
