import fs from "node:fs";

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
export function cachedJsonFile<T>(decode: (raw: string | null) => T): CachedJsonFile<T> {
  let memo: { token: string; value: T } | null = null;
  return {
    read(file) {
      const before = fileToken(file);
      if (before !== null && memo?.token === before) return memo.value;
      memo = null;
      if (before === null) return decode(null);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        return decode(null);
      }
      const value = decode(raw);
      if (fileToken(file) === before) memo = { token: before, value };
      return value;
    },
    invalidate() { memo = null; },
  };
}
