import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeDrain, releaseDrain, writeDrain, DRAIN_LEASE_MS } from "./drain";

const root = mkdtempSync("/var/tmp/auto-drain-test-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("the lease survives readers, expires, and only its owner releases it", () => {
  const file = join(root, "lease.json");
  const lease = { id: "drain-a", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: 1000 + DRAIN_LEASE_MS };
  writeDrain(file, lease);
  expect(activeDrain(file, 1000)).toEqual(lease);
  releaseDrain(file, "drain-b");
  expect(activeDrain(file, 1000)).toEqual(lease);
  expect(activeDrain(file, lease.until)).toBeNull();
  releaseDrain(file, lease.id);
  expect(activeDrain(file, 1000)).toBeNull();
});
test("a torn lease holds launches for ten minutes from its mtime", () => {
  const file = join(root, "torn.json");
  writeFileSync(file, "{");
  utimesSync(file, new Date(1000), new Date(1000));
  expect(activeDrain(file, 2000)?.id).toBe("unreadable");
  expect(activeDrain(file, 1000 + DRAIN_LEASE_MS)).toBeNull();
});
