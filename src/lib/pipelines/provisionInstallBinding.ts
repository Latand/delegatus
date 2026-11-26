import { createRequire } from "node:module";

const requireRuntime = createRequire(import.meta.url);
const CREATE_RULESET = 444;
const ADD_RULE = 445;
const RESTRICT_SELF = 446;
const RULE_PATH_BENEATH = 1;
const QUERY_ABI = 1;
const NO_NEW_PRIVILEGES = 38;
// Write, remove, create, refer and truncate. Reads keep using the checkout's
// normal path, including workspace members and file dependencies.
const WRITE_RIGHTS = BigInt(0x7ff2);
const ZERO = BigInt(0);

/** Restrict the subprocess to already-open directories before any Bun write.
 * A later path replacement cannot inherit rights attached to the old inode. */
export function restrictInstallWrites(descriptors: readonly number[]): boolean {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return false;
  try {
    const ffi = requireRuntime(`bun:${"ffi"}`) as typeof import("bun:ffi");
    const { i32, i64, u64 } = ffi.FFIType;
    const library = ffi.dlopen("libc.so.6", {
      syscall: { args: [i32, u64, u64, u64, u64], returns: i64 },
      prctl: { args: [i32, u64, u64, u64, u64], returns: i32 },
      close: { args: [i32], returns: i32 },
    });
    const { syscall, prctl, close } = library.symbols;
    try {
      if (Number(syscall(CREATE_RULESET, ZERO, ZERO, BigInt(QUERY_ABI), ZERO)) < 3) return false;
      if (descriptors.length === 0) return true;
      const rules = Buffer.alloc(8);
      rules.writeBigUInt64LE(WRITE_RIGHTS);
      const fd = Number(syscall(CREATE_RULESET, BigInt(ffi.ptr(rules)), BigInt(rules.length), ZERO, ZERO));
      if (fd < 0) return false;
      try {
        for (const descriptor of descriptors) {
          const beneath = Buffer.alloc(12);
          beneath.writeBigUInt64LE(WRITE_RIGHTS);
          beneath.writeInt32LE(descriptor, 8);
          if (Number(syscall(ADD_RULE, BigInt(fd), BigInt(RULE_PATH_BENEATH), BigInt(ffi.ptr(beneath)), ZERO)) !== 0) return false;
        }
        return prctl(NO_NEW_PRIVILEGES, BigInt(1), ZERO, ZERO, ZERO) === 0
          && Number(syscall(RESTRICT_SELF, BigInt(fd), ZERO, ZERO, ZERO)) === 0;
      } finally { close(fd); }
    } finally { library.close(); }
  } catch { return false; }
}
