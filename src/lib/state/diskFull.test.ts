import { afterEach, expect, test, setSystemTime } from "bun:test";
import { StateDiskFullError, isDiskFullError, noteStateCommit, noteStateDiskFull, setStateFreeBytesProbeForTests, stateWriteHealth, STATE_DISK_FULL_FLOOR_BYTES } from "./diskFull";
afterEach(() => { setStateFreeBytesProbeForTests(null); noteStateCommit(); });
test("disk-full classification accepts Bun, filesystem and message shapes", () => {
  for (const error of [Object.assign(new Error("full"), { code: "SQLITE_FULL", errno: 13 }),
    Object.assign(new Error("write failed"), { code: "ENOSPC" }), new Error("database or disk is full"),
    new Error("ENOSPC: write"), new Error("no space left on device")]) expect(isDiskFullError(error)).toBe(true);
  for (const code of ["SQLITE_BUSY", "SQLITE_IOERR", "EACCES"]) expect(isDiskFullError(Object.assign(new Error(code), { code }))).toBe(false);
});
test("health needs no write and clears on a successful commit", () => {
  setStateFreeBytesProbeForTests(() => STATE_DISK_FULL_FLOOR_BYTES);
  noteStateCommit();
  expect(stateWriteHealth("unused").state).toBe("ok");
  noteStateDiskFull("probe");
  expect(stateWriteHealth("unused")).toMatchObject({ state: "disk-full", since: expect.any(String) });
  noteStateCommit();
  expect(stateWriteHealth("unused").state).toBe("ok");
  setStateFreeBytesProbeForTests(() => STATE_DISK_FULL_FLOOR_BYTES - 1);
  expect(stateWriteHealth("unused").state).toBe("disk-full");
  setStateFreeBytesProbeForTests(() => null);
  expect(stateWriteHealth("unused")).toEqual({ state: "ok", freeBytes: null, since: null });
});

test("worker failure remains visible until a newer serving-process commit", async () => {
  noteStateCommit();
  setStateFreeBytesProbeForTests(() => 1024 ** 3);
  await Bun.sleep(2);
  const worker = { state: "disk-full" as const, freeBytes: 1024 ** 3, since: new Date().toISOString() };
  expect(stateWriteHealth("unused", worker).state).toBe("disk-full");
  await Bun.sleep(2);
  noteStateCommit();
  expect(stateWriteHealth("unused", worker).state).toBe("ok");
});

test("a successful commit clears a cached failure in the same millisecond", () => {
  setSystemTime(new Date("2026-10-01T20:00:00Z"));
  try {
    setStateFreeBytesProbeForTests(() => 1024 ** 3);
    noteStateDiskFull("probe");
    const observed = stateWriteHealth("unused");
    noteStateCommit();
    expect(stateWriteHealth("unused", observed).state).toBe("ok");
  } finally { setSystemTime(); }
});

// The projection worker transports only error.message; the parent restores Error.
test("classified disk-full errors survive the worker message protocol", () => {
  const classified = new StateDiskFullError("state transaction", Object.assign(new Error("full"), { code: "SQLITE_FULL" }));
  expect(isDiskFullError(new Error(classified.message))).toBe(true);
  expect(isDiskFullError(classified.message)).toBe(true);
});
