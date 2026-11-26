import { expect, spyOn, test } from "bun:test";
import type { TempSweepRoot } from "@/lib/tempSweep";
import { readHostMemoryReading, type HostTmpPorts } from "./hostTmpUsage";
import { TMPFS_MAGIC, memoryPressureLine, observeMemoryPressure, memoryThresholds } from "./memoryPressure";

/* A Docker install: the container's own /tmp is an overlay, PID 1's root is
   refused to the service user, and the host /tmp is a tmpfs. */
const DOCKER = { LLV_DOCKER_NSENTER_SHIMS: "1" };
const HOST = "mnt:[100]", SANDBOX = "mnt:[200]";
const OVERLAY_MAGIC = 0x794c7630;
const meminfo = () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 90 kB\n";
const agent = (pid: number, namespace: string): TempSweepRoot => ({ path: "/tmp", via: `/proc/${pid}/root`, anchor: { pid, namespace } });

function ports(extra: Partial<HostTmpPorts> = {}) {
  const seen: string[] = [];
  let closed = 0, opened = 0;
  const value: HostTmpPorts = {
    env: DOCKER, meminfo, hostNamespace: () => HOST, available: () => true, agentRoots: () => [],
    statfs: directory => {
      seen.push(directory);
      if (directory === "/tmp") return { type: OVERLAY_MAGIC, blocks: 300_000, bfree: 200_000, bsize: 4096 };
      if (directory === "/proc/1/root/tmp") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return { type: TMPFS_MAGIC, blocks: 2000, bfree: 500, bsize: 4096 };
    },
    // What the production opener returns where no reader could be borrowed.
    open: async () => { opened++; return { roots: [{ path: "/tmp", via: "" }, { path: "/tmp", via: "/proc/1/root", anchor: { pid: 1, namespace: HOST } }], close: async () => { closed++; } }; },
    ...extra,
  };
  return { value, seen, counts: () => ({ opened, closed }) };
}
const hostTmp = { usedBytes: 1500 * 4096, totalBytes: 2000 * 4096, tmpfs: true, view: "host" as const };

test("the host /tmp is read through an agent in the host namespace, past a sandboxed one", async () => {
  const fixture = ports({ agentRoots: () => [agent(7, SANDBOX), agent(42, HOST)] });
  const reading = await readHostMemoryReading(fixture.value);
  expect(reading?.tmp).toEqual(hostTmp);
  expect(reading?.ram).toEqual({ usedBytes: 600 * 1024, totalBytes: 1000 * 1024 });
  expect(fixture.seen).toEqual(["/proc/42/root/tmp"]);
  expect(fixture.counts()).toEqual({ opened: 0, closed: 0 });
});

test("with no agent running the host /tmp is read through a borrowed reader, which is released", async () => {
  let closed = 0;
  const fixture = ports({ open: async () => ({ roots: [{ path: "/tmp", via: "" }, agent(55, HOST)], close: async () => { closed++; } }) });
  expect((await readHostMemoryReading(fixture.value))?.tmp).toEqual(hostTmp);
  expect(fixture.seen).toEqual(["/proc/55/root/tmp"]);
  expect(closed).toBe(1);
});

test("with PID 1 refused and no view, /tmp is unreadable and the container's own is never reported", async () => {
  const fixture = ports();
  const reading = (await readHostMemoryReading(fixture.value))!;
  expect(reading.tmp).toBeNull();
  expect(fixture.seen).toEqual(["/proc/1/root/tmp"]);
  expect(fixture.counts()).toEqual({ opened: 1, closed: 1 });
  expect(memoryPressureLine(observeMemoryPressure(reading, null, "2026-11-26T10:00:00Z", memoryThresholds({})))).toContain("/tmp unreadable");
});

test("an unknown host namespace, a view that went away and a failing reader all leave /tmp unreadable", async () => {
  const unknown = ports({ hostNamespace: () => null, agentRoots: () => [agent(42, HOST)] });
  expect((await readHostMemoryReading(unknown.value))?.tmp).toBeNull();
  expect(unknown.seen).toEqual([]);
  expect(unknown.counts().opened).toBe(0);

  // The agent exits between the check and the read: its reading is dropped.
  let checks = 0;
  const gone = ports({ agentRoots: () => [agent(42, HOST)], available: root => root.anchor?.pid === 42 && ++checks === 1 });
  expect((await readHostMemoryReading(gone.value))?.tmp).toBeNull();
  expect(gone.seen).toEqual(["/proc/42/root/tmp"]);

  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const failing = ports({ open: async () => { throw new Error("no reader"); } });
    const reading = await readHostMemoryReading(failing.value);
    expect(reading?.tmp).toBeNull();
    expect(reading?.swap.totalBytes).toBe(100 * 1024);
    expect(warned).toHaveBeenCalled();
  } finally { warned.mockRestore(); }
});

test("outside the image the process's own /tmp is the machine's, and a missing meminfo reads as nothing", async () => {
  const native = ports({ env: {} });
  expect((await readHostMemoryReading(native.value))?.tmp).toMatchObject({ view: "own", tmpfs: false });
  expect(native.seen).toEqual(["/tmp"]);
  expect(native.counts().opened).toBe(0);
  expect(await readHostMemoryReading(ports({ meminfo: () => { throw new Error("no proc"); } }).value)).toBeNull();
});
