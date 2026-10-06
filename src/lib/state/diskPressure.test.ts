import { expect, test } from "bun:test";

import {
  DISK_CRITICAL_BYTES,
  DISK_RECOVERY_BYTES,
  DISK_SPACE_WAIT_PREFIX,
  DISK_WARNING_BYTES,
  diskPressureLabel,
  diskPressureWakeReady,
  diskVolumes,
  observeDiskPressure,
  worktreeDiskWait,
  type DiskProbe,
} from "./diskPressure";

/* Every volume here is a fake probe answer: nothing reads a real disk. */
const GiB = 1024 ** 3;
const probe = (free: Record<string, number>): DiskProbe => (directory) => {
  const volume = Object.keys(free).find((prefix) => directory.startsWith(prefix));
  return volume ? { volume, freeBytes: free[volume]! } : null;
};

test("roots on one volume are one row at the lowest free space, with a level per threshold", () => {
  const volumes = diskVolumes([
    { role: "state", directory: "/srv/state" },
    { role: "worktrees", directory: "/srv/lanes/a" },
    { role: "temp", directory: "/tmp/x" },
    { role: "temp", directory: "/elsewhere" },
  ], probe({ "/srv": DISK_WARNING_BYTES - 1, "/tmp": DISK_CRITICAL_BYTES - 1 }));
  expect(volumes).toEqual([
    { roles: ["state", "worktrees"], freeBytes: DISK_WARNING_BYTES - 1, level: "warning" },
    { roles: ["temp"], freeBytes: DISK_CRITICAL_BYTES - 1, level: "critical" },
    { roles: ["temp"], freeBytes: null, level: "unknown" },
  ]);
});

test("a new worktree waits only below the critical threshold, naming the volume", () => {
  expect(worktreeDiskWait("/srv/repo", "/srv/repo-pipeline-a", probe({ "/": DISK_WARNING_BYTES - 1 }))).toBeNull();
  const wait = worktreeDiskWait("/srv/repo", "/srv/repo-pipeline-a", probe({ "/": GiB / 2 }));
  expect(wait).toStartWith(DISK_SPACE_WAIT_PREFIX);
  expect(wait).toContain("0.50 GiB free");
  expect(wait).toContain("retries automatically");
});

test("one episode lasts while free space moves below the recovery level, and a later crossing opens another", () => {
  const low = (free: number) => [{ roles: ["worktrees"], freeBytes: free, level: free < DISK_CRITICAL_BYTES ? "critical" as const : free < DISK_WARNING_BYTES ? "warning" as const : "ok" as const }];
  const first = observeDiskPressure(low(5 * GiB), null, "2026-10-06T10:00:00.000Z");
  expect(first.episode).toBe("2026-10-06T10:00:00.000Z");
  const measured = { ...first, consumers: [{ kind: "worktrees" as const, bytes: 40 * GiB, measuredAt: first.at }] };
  const lower = observeDiskPressure(low(GiB), measured, "2026-10-06T10:05:00.000Z");
  expect(lower.episode).toBe(first.episode);
  expect(lower.consumers).toEqual(measured.consumers);
  /* Back above the warning threshold but under the recovery level: the same episode. */
  const wobble = observeDiskPressure(low(DISK_WARNING_BYTES + 1), lower, "2026-10-06T10:10:00.000Z");
  expect(wobble.episode).toBe(first.episode);
  expect(observeDiskPressure(low(DISK_WARNING_BYTES - 1), wobble, "2026-10-06T10:15:00.000Z").episode).toBe(first.episode);
  const recovered = observeDiskPressure(low(DISK_RECOVERY_BYTES), wobble, "2026-10-06T11:00:00.000Z");
  expect(recovered.episode).toBeNull();
  expect(recovered.consumers).toEqual([]);
  expect(observeDiskPressure(low(5 * GiB), recovered, "2026-10-06T12:00:00.000Z").episode).toBe("2026-10-06T12:00:00.000Z");
});

test("the wake waits for the consumer sizes, then names them with the free space", () => {
  const pressure = observeDiskPressure([{ roles: ["state", "worktrees"], freeBytes: 3 * GiB, level: "warning" }], null, "2026-10-06T10:00:00.000Z");
  expect(diskPressureWakeReady(pressure, Date.parse("2026-10-06T10:01:00.000Z"))).toBe(false);
  expect(diskPressureWakeReady(pressure, Date.parse("2026-10-06T10:15:00.000Z"))).toBe(true);
  expect(diskPressureLabel(pressure)).toContain("consumer measurement pending");
  const measured = { ...pressure, consumers: [
    { kind: "state" as const, bytes: 2 * GiB, measuredAt: pressure.at },
    { kind: "worktrees" as const, bytes: 90 * GiB, measuredAt: pressure.at },
    { kind: "temp" as const, bytes: 12 * GiB, measuredAt: pressure.at },
  ] };
  expect(diskPressureWakeReady(measured, Date.parse("2026-10-06T10:01:00.000Z"))).toBe(true);
  expect(diskPressureLabel(measured)).toBe("Disk space low: state/worktrees 3.00 GiB free; largest Delegatus consumers (allocated lower bounds): worktrees 90.00 GiB, temp 12.00 GiB, state 2.00 GiB");
  expect(diskPressureWakeReady({ ...measured, episode: null })).toBe(false);
});
