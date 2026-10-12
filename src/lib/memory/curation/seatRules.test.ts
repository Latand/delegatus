import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnedRulesBlock, projectView, leaveLessons, recordLessonRequest, roleMemoryCollection, roleScope } from "../roleStore";
import { applyCuration, revertCuratorPass, type CurationApply } from "./apply";
import { claimPass, patchPass } from "./store";
import { CURATOR_CHECKLIST } from "./brief";

const project = "curator-seat";
let attempt = 0;
let sandbox: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "curator-seat-"));
  process.env.LLV_STATE_DIR = sandbox;
});

function seed(role: string, rule: string) {
  const source = { project, pipelineId: "curator-source", stageId: "build", attempt: ++attempt, roleId: "builder", fixRound: false, conversationId: "writer" };
  recordLessonRequest({ ...source, at: "2026-10-12T00:00:00.000Z" });
  return leaveLessons({ request: source, source, lessons: [{ scope: "role", role, rule, why: "A repeated workflow missed a check before its next action." }], none: null }).left[0]!.id;
}
function scopes(orders: Record<string, string[]>): CurationApply["scopes"] {
  return Object.entries(orders).map(([scope, order]) => {
    const held = roleMemoryCollection()!.get(`s:${scope}`);
    return { scope, revision: held?.kind === "scope" ? held.revision : 0, order };
  });
}
afterEach(() => {
  process.env.LLV_STATE_DIR = previous;
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test.each(["orchestrator", "maintainer"])("curator can retain and rank active %s rules", role => {
  const ids = ["Inspect the transcript tail before reporting an agent as stalled.", "Present reviewed prototype variants before starting implementation."].map(rule => seed(role, rule));
  const scope = roleScope(project, role);
  const pass = claimPass({ project, repoDir: sandbox, now: Date.now() })!;
  const held = roleMemoryCollection()!.get(`s:${scope}`);
  if (held?.kind !== "scope") throw new Error("fixture scope missing");
  applyCuration(pass, { scopes: [{ scope, revision: held.revision, order: [...ids].reverse() }] });
  expect(projectView(project).scopes.find(entry => entry.scope === scope)!.active.map(rule => rule.id).sort()).toEqual([...ids].sort());
  const block = learnedRulesBlock(project, role);
  expect(block.indexOf(`[${ids[1]}]`)).toBeLessThan(block.indexOf(`[${ids[0]}]`));
});

test.each(["orchestrator", "maintainer"])("curator can move into %s, widen, merge, archive and undo", role => {
  const one = seed("builder", "Inspect the transcript tail before reporting an agent as stalled.");
  const two = seed(role, "Read the newest transcript messages before classifying an agent as stalled.");
  const builder = roleScope(project, "builder"), target = roleScope(project, role), wide = `role:*:${role}`;
  const pass = claimPass({ project, repoDir: sandbox, now: Date.now() })!;
  applyCuration(pass, { scopes: scopes({ [builder]: [], [target]: [one, two] }), move: [{ id: one, to: target, note: "The seat owns this reporting check." }] });
  applyCuration(pass, { scopes: scopes({ [target]: [], [wide]: [one, two] }), move: [one, two].map(id => ({ id, to: wide, note: "This reporting check applies to this role in every project." })) });
  applyCuration(pass, { scopes: scopes({ [wide]: [one] }), merge: [{ into: one, from: [two], rule: "Inspect recent transcript messages before reporting an agent as stalled.", note: "Both rules cover the same reporting check." }] });
  expect(() => applyCuration(pass, { scopes: scopes({ [wide]: [], ["role:*:reviewer"]: [one] }), move: [{ id: one, to: "role:*:reviewer", note: "Attempt a move to a clean role." }] })).toThrow("target role reads no learned rules");
  applyCuration(pass, { scopes: scopes({ [wide]: [] }), archive: [{ id: one, reason: "stale", note: "The reporting workflow now performs this check." }] });
  patchPass(pass.id, { state: "succeeded", endedAt: new Date().toISOString() });
  expect(revertCuratorPass(pass.id).skipped).toEqual([]);
  const view = projectView(project);
  expect(view.scopes.find(entry => entry.scope === builder)!.active.map(rule => rule.id)).toEqual([one]);
  expect(view.scopes.find(entry => entry.scope === target)!.active.map(rule => rule.id)).toEqual([two]);
  expect(view.scopes.find(entry => entry.scope === wide)!.active).toEqual([]);
});

test("the curator brief names both readers and directs it to the seat's mandate", () => {
  expect(CURATOR_CHECKLIST).toContain("orchestrator seat and the board maintainer read rules");
  expect(CURATOR_CHECKLIST).toContain("get_orchestrator full:true");
  expect(CURATOR_CHECKLIST).not.toContain("no learned-rule level");
});
