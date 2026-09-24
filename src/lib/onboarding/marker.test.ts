import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { applyOnboardingPatch, parseOnboardingPatch, readOnboardingMarker, resolveOnboardingMarker, writeLastHealth, writeOnboardingMarker } from "./marker";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-onboarding-marker-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const NOW = "2026-09-19T10:00:00.000Z";

test("an install that already holds Viewer state is marked existing-install and the guide stays shut", () => {
  const file = path.join(sandbox, "existing.json");
  const marker = resolveOnboardingMarker(() => true, () => NOW, file);
  expect(marker).toMatchObject({ dismissedAt: NOW, completedAt: null, reason: "existing-install" });
  expect(readOnboardingMarker(file)).toEqual(marker);
});

test("a first run leaves the marker absent, and a failed evidence read counts as an existing install", () => {
  const file = path.join(sandbox, "first.json");
  expect(resolveOnboardingMarker(() => false, () => NOW, file)).toBeNull();
  expect(fs.existsSync(file)).toBe(false);
  const broken = path.join(sandbox, "broken-evidence.json");
  expect(resolveOnboardingMarker(() => { throw new Error("store unreadable"); }, () => NOW, broken)?.reason).toBe("existing-install");
});

test("a guide in progress is never re-decided, and a damaged marker reads as dismissed", () => {
  const file = path.join(sandbox, "progress.json");
  writeOnboardingMarker(applyOnboardingPatch(null, { steps: { engines: "done" } }, NOW), file);
  const marker = resolveOnboardingMarker(() => true, () => NOW, file);
  expect(marker).toMatchObject({ dismissedAt: null, reason: null, steps: { engines: "done", agents: null } });
  fs.writeFileSync(file, "{");
  expect(readOnboardingMarker(file)?.dismissedAt).not.toBeNull();
});

test("the health result round-trips, and every unusable shape reads as none at all", () => {
  const file = path.join(sandbox, "last-health.json");
  const written = writeLastHealth({ at: NOW, result: "failed", failedCode: "SEAT_UNREADABLE" }, file);
  expect(written.lastHealth).toEqual({ at: NOW, result: "failed", failedCode: "SEAT_UNREADABLE" });
  expect(readOnboardingMarker(file)?.lastHealth).toEqual({ at: NOW, result: "failed", failedCode: "SEAT_UNREADABLE" });
  /* A code the reader does not know is still a string it keeps; a missing one
     is null. Both are valid for a passed run. */
  expect(writeLastHealth({ at: NOW, result: "passed", failedCode: null }, file).lastHealth?.failedCode).toBeNull();
  /* Writing the result never disturbs what the guide already recorded. */
  writeOnboardingMarker(applyOnboardingPatch(readOnboardingMarker(file), { steps: { check: "done" } }, NOW), file);
  expect(writeLastHealth({ at: NOW, result: "stopped", failedCode: null }, file).steps.check).toBe("done");

  /* Each rejection branch, written straight into the marker on disk. */
  const marker = readOnboardingMarker(file)!;
  const stored = (lastHealth: unknown) => {
    fs.writeFileSync(file, JSON.stringify({ ...marker, lastHealth }) + "\n", "utf8");
    return readOnboardingMarker(file)?.lastHealth ?? null;
  };
  expect(stored({ at: NOW, result: "passed", failedCode: null })).toEqual({ at: NOW, result: "passed", failedCode: null });
  expect(stored(null)).toBeNull();
  expect(stored(["passed"])).toBeNull();
  expect(stored({ at: NOW, result: "cancelled", failedCode: null })).toBeNull();
  expect(stored({ at: "not a time", result: "passed", failedCode: null })).toBeNull();
  expect(stored({ result: "passed", failedCode: null })).toBeNull();
  /* A failedCode of the wrong type is dropped without losing the result. */
  expect(stored({ at: NOW, result: "failed", failedCode: 7 })).toEqual({ at: NOW, result: "failed", failedCode: null });
  /* And none of it disturbs the rest of the marker. */
  expect(readOnboardingMarker(file)?.steps.check).toBe("done");
});

test("patches are validated and applied", () => {
  expect(parseOnboardingPatch({ completed: true, steps: { agents: "done" } })).toEqual({ completed: true, steps: { agents: "done" } });
  expect(parseOnboardingPatch({ steps: { welcome: "done" } })).toBe("unknown step: welcome");
  expect(parseOnboardingPatch({ dismissed: false })).toBe("dismissed must be true");
  expect(parseOnboardingPatch({ extra: 1 })).toBe("unknown field: extra");
  expect(applyOnboardingPatch(null, { dismissed: true }, NOW)).toMatchObject({ dismissedAt: NOW, completedAt: null });
});

test("slice 3: the six step ids round-trip, and a marker written with three reads the new ids as not visited", () => {
  const file = path.join(sandbox, "six-steps.json");
  const patch = parseOnboardingPatch({ steps: { engines: "done", agents: "done", phone: "skipped", voice: "done", tour: "done", check: null } });
  expect(typeof patch).toBe("object");
  writeOnboardingMarker(applyOnboardingPatch(null, patch as Exclude<typeof patch, string>, NOW), file);
  expect(readOnboardingMarker(file)?.steps).toEqual({ engines: "done", agents: "done", phone: "skipped", voice: "done", tour: "done", check: null });

  const old = path.join(sandbox, "three-steps.json");
  fs.writeFileSync(old, JSON.stringify({ schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, steps: { engines: "done", agents: "done", check: null }, lastHealth: null }));
  expect(readOnboardingMarker(old)?.steps).toEqual({ engines: "done", agents: "done", phone: null, voice: null, tour: null, check: null });
});
