/* Serialize the startup interval across adoption and readiness waits. The
   kernel releases a POSIX lock when its holder dies, including SIGKILL. */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

export function lockLauncherStartup(recordFile) {
  // Node launchers still revalidate their record after every startup wait.
  // Bun supplies the kernel fence for its relaunch-capable POSIX launcher.
  if (!process.versions.bun || process.platform === "win32") return { release() {} };
  const { dlopen, FFIType } = createRequire(import.meta.url)(`bun:${"ffi"}`);
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  mkdirSync(dirname(recordFile), { recursive: true, mode: 0o700 });
  const fd = openSync(join(dirname(recordFile), `${basename(recordFile).replace("launcher-", "startup-")}.lock`), "a", 0o600);
  if (library.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    library.close();
    throw new Error("Another launcher is starting this installation.");
  }
  let held = true;
  return { release() {
    if (!held) return;
    held = false;
    closeSync(fd);
    library.close();
  } };
}
