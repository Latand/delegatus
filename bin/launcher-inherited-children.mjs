// execve preserves children and replaces Bun's child watchers. Take custody
// before this image spawns anything, and wait only on those inherited PIDs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const inherited = new Set();
const key = "LLV_LAUNCHER_INHERITED_CHILDREN";
try {
  const record = JSON.parse(process.env[key] || "null");
  if (record?.ownerPid === process.pid && Array.isArray(record.pids)) {
    for (const pid of record.pids) if (Number.isSafeInteger(pid) && pid > 1) inherited.add(pid);
  }
} catch { /* Older images have no explicit handoff. */ }
delete process.env[key];

if (process.platform === "linux") {
  // Also collect children left by an older launcher that supplied no handoff.
  // This keyed kernel read includes exited children without scanning /proc.
  let children = "";
  try { children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8"); }
  catch { /* The explicit handoff still works without procfs. */ }
  for (const value of children.trim().split(/\s+/)) {
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 1) inherited.add(pid);
  }
}

if (inherited.size && process.versions.bun && process.platform !== "win32") {
  const { dlopen, FFIType } = createRequire(import.meta.url)(`bun:${"ffi"}`);
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  let timer;
  const reap = () => {
    for (const pid of inherited) {
      // WNOHANG never stops or waits synchronously for a running child. An
      // exact PID cannot consume a new ChildProcess's exit notification.
      if (library.symbols.waitpid(pid, null, 1) !== 0) inherited.delete(pid);
    }
    if (inherited.size) return;
    clearInterval(timer);
    library.close();
  };
  reap();
  if (inherited.size) { timer = setInterval(reap, 100); timer.unref(); }
}

/** Carry unfinished waits through another exec, including on macOS. The
 * successor consumes this before any of its children can inherit it. */
export function launcherChildHandoff(child) {
  return { [key]: JSON.stringify({ ownerPid: process.pid, pids: [...inherited, child.pid] }) };
}
