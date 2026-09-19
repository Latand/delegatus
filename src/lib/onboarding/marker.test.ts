import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { applyOnboardingPatch, parseOnboardingPatch, readOnboardingMarker, resolveOnboardingMarker, writeOnboardingMarker } from "./marker";

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

test("patches are validated and applied", () => {
  expect(parseOnboardingPatch({ completed: true, steps: { agents: "done" } })).toEqual({ completed: true, steps: { agents: "done" } });
  expect(parseOnboardingPatch({ steps: { phone: "done" } })).toBe("unknown step: phone");
  expect(parseOnboardingPatch({ dismissed: false })).toBe("dismissed must be true");
  expect(parseOnboardingPatch({ extra: 1 })).toBe("unknown field: extra");
  expect(applyOnboardingPatch(null, { dismissed: true }, NOW)).toMatchObject({ dismissedAt: NOW, completedAt: null });
});
