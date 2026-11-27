import { createRequire } from "node:module";

const requireRuntime = createRequire(import.meta.url);

/** Publish a directory without replacing an entry that appears at the target
 * between an earlier stat and the rename. */
export function renameDirectoryNoReplace(source: string, target: string): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("exclusive directory installation is unavailable");
  const ffi = requireRuntime(`bun:${"ffi"}`) as typeof import("bun:ffi");
  const { ptr, i32, u32 } = ffi.FFIType;
  const from = Buffer.from(source + "\0");
  const to = Buffer.from(target + "\0");
  if (process.platform === "linux") {
    const library = ffi.dlopen("libc.so.6", { renameat2: { args: [i32, ptr, i32, ptr, u32], returns: i32 } });
    try { return library.symbols.renameat2(-100, ffi.ptr(from), -100, ffi.ptr(to), 1) === 0; }
    finally { library.close(); }
  }
  const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", { renamex_np: { args: [ptr, ptr, u32], returns: i32 } });
  try { return library.symbols.renamex_np(ffi.ptr(from), ffi.ptr(to), 4) === 0; }
  finally { library.close(); }
}
