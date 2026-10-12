import { expect, test } from "bun:test";
import { classifyPaths, releaseCut, releaseState, type ReleaseInput } from "./policy";

import { ready, hour } from "./policy.fixture";
test("30 visible changes trigger a release after twelve hours; 29 wait", async () => {
  expect((await releaseState(ready())).state).toBe("due");
  const input = ready(); input.changes.pop();
  expect((await releaseState(input)).state).toBe("not-due");
});

test("twelve hour rolling gap caps amount releases at twice a day; requests keep blockers", async () => {
  const input = ready(); input.lastTag.at = input.now - 11 * hour;
  expect((await releaseState(input)).reason).toBe("gap");
  input.lastTag.at = input.now - 12 * hour;
  expect((await releaseState(input)).state).toBe("due");
  input.lastTag.at = input.now; input.changes = []; input.requested = true;
  expect((await releaseState(input)).state).toBe("due");
  input.mergeEnabled = false;
  expect((await releaseState(input)).blocker).toBe(3);
});

test("documentation, fixtures, tooling and release PRs do not trigger", async () => {
  expect(classifyPaths(["README.md", "docs/help.md"])).toBe("docs");
  expect(classifyPaths(["scripts/check.ts", "src/a.test.ts"])).toBe("internal");
  expect(classifyPaths(["src/a.ts"], "Release 1.2.0 (#12)")).toBe("release");
  const input = ready(); input.changes = input.changes.map(c => ({ ...c, files: ["scripts/check.ts"] }));
  expect((await releaseState(input)).state).toBe("not-due");
});

test.each([
  [1, { enabled: false }], [2, { tickEnabled: false }], [3, { mergeEnabled: false }],
  [4, { live: true }], [4, { mainVersion: "1.1.0" }], [4, { registryHasTag: false }],
  [5, { checks: "red" }], [5, { checks: "pending" }],
  [6, { deployments: [{ revision: "bad", at: hour }, { revision: "one", at: 2 * hour }] }],
  [7, { hold: "incident" }], [8, { deployments: [] }],
  [9, { deploying: true }], [9, { draining: true }],
  [10, { tools: ["tesseract"] }], [10, { tools: ["pdftocairo"] }], [10, { tools: ["Chrome"] }],
] as [number, Partial<ReleaseInput>][]) ("blocker %s refuses a launch", async (blocker, patch) => {
  expect((await releaseState({ ...ready(), ...patch })).blocker).toBe(blocker);
});

test("soak picks the newest six-hour revision retained by every later deployment", async () => {
  const isAncestor = (a: string, b: string) => a === b || a === "old";
  const deployments = [{ revision: "old", at: 0 }, { revision: "bad", at: 7 * hour }, { revision: "old", at: 10 * hour }];
  expect((await releaseCut(deployments, isAncestor, 14 * hour))?.revision).toBe("old");
  expect((await releaseState({ ...ready(), deployments, isAncestor })).blocker).toBe(6);
  deployments.push({ revision: "fixed", at: 20 * hour });
  const fixed = (a: string, b: string) => isAncestor(a, b) || b === "fixed";
  expect((await releaseState({ ...ready(), deployments, isAncestor: fixed })).blocker).toBeNull();
  expect((await releaseCut(deployments, fixed, 26 * hour))?.revision).toBe("fixed");
  expect(await releaseCut([{ revision: "one", at: hour }], fixed, 7 * hour - 1)).toBeNull();
});

test("failure and decline cool down; a declined cut stays refused, a request bypasses cooldown", async () => {
  const input = ready(); input.settled = { cut: "one", at: input.now, outcome: "declined" };
  expect((await releaseState(input)).reason).toBe("declined-cut");
  input.settled.outcome = "failed";
  expect((await releaseState(input)).reason).toBe("gap");
  input.requested = true;
  expect((await releaseState(input)).state).toBe("due");
});
