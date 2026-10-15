/* This module is also the bundle's preload. Keep it independent of state and
   the application graph: containment must be armed before either is loaded. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export function mcpProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return ["Z", "X", "x"].includes(fields[0]) ? null : `${pid}:${fields[19]}`;
  } catch { return null; }
}

/** The invoking agent owns this launcher even if a sibling keeps stdin open. */
export function watchMcpOwner(onDeath) {
  const pid = process.ppid;
  const identity = mcpProcessIdentity(pid);
  const gone = () => pid <= 1 || process.ppid !== pid || (process.platform === "linux"
    && (!identity || mcpProcessIdentity(pid) !== identity));
  const timer = setInterval(() => { if (gone()) onDeath(); }, 200);
  timer.unref();
  if (gone()) onDeath();
  return () => clearInterval(timer);
}

// The launcher supplies the identity it captured before spawn. The kernel
// kills the bundle if the launcher is hard-killed, including while the bundle
// is blocked in synchronous work. Recheck after prctl to close the spawn race.
export function bindMcpChildToParent(expected = mcpProcessIdentity(process.ppid)) {
  const key = Symbol.for("delegatus.mcp.parentBound");
  if (globalThis[key]) return;
  delete process.env.LLV_MCP_PARENT_IDENTITY;
  if (process.platform === "linux") {
    const { dlopen, FFIType } = createRequire(import.meta.url)(`bun:${"ffi"}`);
    const libc = dlopen("libc.so.6", {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    });
    if (libc.symbols.prctl(1, 9, 0, 0, 0) !== 0 || mcpProcessIdentity(process.ppid) !== expected) process.exit(1);
    libc.close();
  }
  globalThis[key] = true;
  watchMcpOwner(() => process.exit(0));
}

if (process.env.LLV_MCP_PARENT_IDENTITY) bindMcpChildToParent(process.env.LLV_MCP_PARENT_IDENTITY);
