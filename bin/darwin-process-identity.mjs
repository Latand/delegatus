/* The runtime-host fence identifies a macOS process by the kernel's
   microsecond creation time. Keep the launcher independent of dist modules. */
import { createRequire } from "node:module";

let reader;
export function parseDarwinIdentity(pid, buffer, bytesRead) {
  if (!Number.isInteger(pid) || pid <= 0 || bytesRead < 136 || buffer.byteLength < 136 || buffer.readUInt32LE(12) !== pid) return null;
  const seconds = buffer.readBigUInt64LE(120); const micros = buffer.readBigUInt64LE(128);
  if (seconds === 0n || micros >= 1_000_000n) return null;
  return `${pid}:${seconds}:${micros.toString().padStart(6, "0")}`;
}
export function darwinKernelIdentity(pid) {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) return null;
  if (reader === undefined) {
    try {
      const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`);
      const library = ffi.dlopen("/usr/lib/libproc.dylib", {
        proc_pidinfo: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
      });
      reader = (candidate, buffer) => Number(library.symbols.proc_pidinfo(candidate, 3, 0n, ffi.ptr(buffer), buffer.byteLength));
    } catch { reader = null; }
  }
  if (!reader) return null;
  const buffer = Buffer.alloc(136);
  try { return parseDarwinIdentity(pid, buffer, reader(pid, buffer)); } catch { return null; }
}
