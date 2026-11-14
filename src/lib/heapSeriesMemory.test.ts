import { expect, test } from "bun:test";
import { createHeapSeriesProcReader, HEAP_SERIES_PROC_MAX_BYTES } from "./heapSeriesMemory";

const status = "VmRSS:\t120 kB\nRssAnon:\t80 kB\nRssFile:\t30 kB\nRssShmem:\t10 kB\n";
const rollup = "Anonymous: 75 kB\nPrivate_Dirty: 60 kB\n";

test("Linux counters use bytes and read only the two bounded proc sources", async () => {
  const files: string[] = [];
  const read = createHeapSeriesProcReader(async file => {
    files.push(file); return file.endsWith("status") ? status : rollup;
  }, "linux");
  expect(await read()).toEqual({
    procStatus: { vmRssBytes: 120 * 1024, rssAnonBytes: 80 * 1024, rssFileBytes: 30 * 1024, rssShmemBytes: 10 * 1024 },
    smapsRollup: { anonymousBytes: 75 * 1024, privateDirtyBytes: 60 * 1024 },
  });
  expect(files.sort()).toEqual(["/proc/self/smaps_rollup", "/proc/self/status"]);
});

test.each(["darwin", "win32"] as const)("%s has null proc fields and performs no proc read", async platform => {
  let calls = 0;
  const read = createHeapSeriesProcReader(async () => { calls++; throw Error("absent"); }, platform);
  expect(await read()).toEqual({ procStatus: null, smapsRollup: null });
  expect(calls).toBe(0);
});

test.each(["status", "smaps_rollup"])("a missing %s does not hide the other source", async missing => {
  const read = createHeapSeriesProcReader(async file => {
    if (file.endsWith(missing)) throw Error("unavailable");
    return file.endsWith("status") ? status : rollup;
  }, "linux");
  const result = await read();
  expect(result.procStatus === null).toBe(missing === "status");
  expect(result.smapsRollup === null).toBe(missing === "smaps_rollup");
});

test("malformed, absent and overflowing counters stay null; zero is a measurement", async () => {
  const read = createHeapSeriesProcReader(async file => file.endsWith("status")
    ? "VmRSS: 99999999999999999999999 kB\nRssAnon: -4 kB\nRssShmem: 0 kB\n"
    : "Anonymous: 4 MB\nPrivate_Dirty: 0 kB\n", "linux");
  expect(await read()).toEqual({ procStatus: { vmRssBytes: null, rssAnonBytes: null, rssFileBytes: null, rssShmemBytes: 0 },
    smapsRollup: { anonymousBytes: null, privateDirtyBytes: 0 } });
});

test("oversized source is discarded independently", async () => {
  const read = createHeapSeriesProcReader(async file => file.endsWith("status")
    ? status + "x".repeat(HEAP_SERIES_PROC_MAX_BYTES) : rollup, "linux");
  expect(await read()).toEqual({ procStatus: null, smapsRollup: { anonymousBytes: 75 * 1024, privateDirtyBytes: 60 * 1024 } });
});

test("a timed-out read stays single-flight until its native operation finishes", async () => {
  const held = Promise.withResolvers<string>();
  let calls = 0;
  const read = createHeapSeriesProcReader(file => {
    if (file.endsWith("status")) { calls++; return held.promise; }
    return Promise.resolve(rollup);
  }, "linux", 5);
  expect((await read()).procStatus).toBeNull();
  expect((await read()).procStatus).toBeNull();
  expect(calls).toBe(1);
  held.resolve(status);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect((await read()).procStatus?.vmRssBytes).toBe(120 * 1024);
  expect(calls).toBe(2);
});
