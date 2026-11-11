import fs from "node:fs";
import { cacheCounter } from "../cacheTelemetry";

export interface CachedJsonFile<T> {
  read(file: string): T;
  invalidate(): void;
}

function fileToken(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

/** One snapshot per owner. A path switch, invalidation or unstable observation
 * evicts it. The bound decoder owns defaults/errors, including unavailable
 * input (null); this cache never removes or repairs the source file. */
export function cachedJsonFile<T>(decode: (raw: string | null) => T, owner = "state/cachedJsonFile"): CachedJsonFile<T> {
  let memo: { token: string; value: T } | null = null;
  const result: CachedJsonFile<T> = {
    read(file) {
      const before = fileToken(file);
      if (before !== null && memo?.token === before) return memo.value;
      memo = null;
      counter.set(0, 0);
      if (before === null) return decode(null);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        return decode(null);
      }
      const value = decode(raw);
      if (fileToken(file) === before) { memo = { token: before, value }; counter.set(1, raw.length * 2); }
      return value;
    },
    invalidate() { memo = null; counter.set(0, 0); },
  };
  const counter = cacheCounter(result, "snapshot", owner, "source-utf16");
  return result;
}
