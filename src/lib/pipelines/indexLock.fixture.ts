import { spyOn } from "bun:test";
import fs from "node:fs";

/** Enumerate the fixture's processes while reading their real kernel evidence. */
export function fixtureIndexLockCensus(pids: ReadonlySet<number> = new Set([process.pid]), opaquePid?: () => number | undefined) {
  const read = fs.promises.readdir;
  return spyOn(fs.promises, "readdir").mockImplementation(((...args: unknown[]) => {
    if (args[0] === "/proc" && args.length === 1) return Promise.resolve([...pids].map(String));
    const hidden = opaquePid?.();
    if (hidden !== undefined && args[0] === `/proc/${hidden}/fd`) {
      return Promise.reject(Object.assign(new Error("fixture descriptor table unavailable"), { code: "EACCES" }));
    }
    return Reflect.apply(read, fs.promises, args);
  }) as typeof fs.promises.readdir);
}
