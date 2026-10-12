import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as problems from "./roleProblems";
import { parseLessons } from "./roleStage";
import { leaveLessons, lessonRequest, recordLessonRequest, roleMemoryCollection, newRuleId } from "./roleStore";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan, seatTickSignalVersion } from "@/lib/monitor/seatTick";
import { seatTickWakePayload } from "@/lib/monitor/report";
import { seatTickStateForEpoch } from "@/lib/monitor/seatTickState";
import { runSeatTickCheck } from "@/lib/monitor/seatTickController";
import { input, NOW, PROJECT } from "@/lib/boardMaintenance/testFixture";
import { applyCuration, revertCuratorPass } from "./curation/apply";
import { claimPass, patchPass } from "./curation/store";
import { CURATION_INTERVAL_MS } from "./roleTypes";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-problems-"));
  process.env.LLV_STATE_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const problem = { statement: "The instructions and locale gate name different supported language sets.", evidence: "The locale gate lists six languages; the instructions list four." };
function report() {
  const source = { project: PROJECT, pipelineId: "problem-lane", stageId: "fix", attempt: 1, roleId: "builder", conversationId: "problem-conversation", fixRound: true };
  recordLessonRequest({ ...source, taskId: "problem-task", at: new Date(NOW).toISOString() });
  leaveLessons({ request: source, source, lessons: [], none: null, problem });
  return source;
}

test("a problem reaches the designated seat's agenda, retries until landing and survives seat succession", () => {
  const source = report();
  const sources = defaultSeatTickSources();
  const base = input();
  const signals = sources.memoryProblems!(PROJECT, []);
  expect(signals).toHaveLength(1);
  expect(signals[0].label).toContain(problem.statement);
  expect(signals[0].label).toContain(problem.evidence);
  expect(signals[0].label).toContain("ask the operator");
  const decision = seatTickDecision({ ...base, signals });
  if (decision.verdict.kind !== "wake") throw Error(`problem must wake the designated seat: ${JSON.stringify(decision.verdict)}`);
  const payload = seatTickWakePayload({ project: PROJECT, items: decision.verdict.items, reasons: decision.verdict.reasons, signals, deferred: 0 });
  expect(payload.text).toContain(problem.statement);
  expect(payload.text).toContain(problem.evidence);
  // A refusal or uncertain send makes no delivery credit and keeps the row owed.
  expect(sources.memoryProblems!(PROJECT, [])).toEqual(signals);
  const plan = seatTickWakeCommitPlan({ ...decision.verdict, items: [...payload.items] }, { fingerprint: base.changeFingerprint, eventsThrough: 0, frozenText: payload.text })!;
  const landed = seatTickWakeCommit(decision.state, plan, NOW);
  expect(sources.memoryProblems!(PROJECT, landed.itemsShown ?? [])).toEqual([]);
  const rotated = seatTickStateForEpoch(landed, 2);
  expect(sources.memoryProblems!(PROJECT, rotated.itemsShown ?? [])).toEqual([]);
  expect(lessonRequest(source.pipelineId, source.stageId, source.attempt)?.problemDeliveredAt).toBeTruthy();
  // Even after the generic agenda ledger trims this signal, its own row remembers delivery.
  expect(sources.memoryProblems!(PROJECT, [])).toEqual([]);
  expect(problems.memoryProblemSignals("another-project", [])).toEqual([]);
});

test("the production controller credits a landed problem before losing the seat epoch", async () => {
  const source = report();
  const sources = defaultSeatTickSources();
  const base = input();
  const signals = sources.memoryProblems!(PROJECT, []);
  const decision = seatTickDecision({ ...base, signals });
  if (decision.verdict.kind !== "wake") throw Error("wake expected");
  const plan = seatTickWakeCommitPlan(decision.verdict, { fingerprint: base.changeFingerprint, eventsThrough: 0 })!;
  const landed = seatTickWakeCommit(decision.state, plan, NOW);
  expect(lessonRequest(source.pipelineId, source.stageId, source.attempt)?.problemDeliveredAt).toBeUndefined();
  await runSeatTickCheck(PROJECT, {
    sources: { ...sources, now: () => NOW + 60_000 },
    readState: () => landed, writeState: () => {}, appendRecord: () => {},
    ensureCard: () => false, deliver: async () => { throw Error("no seat should receive a message"); },
    curation: null, maintenance: null,
  });
  expect(lessonRequest(source.pipelineId, source.stageId, source.attempt)?.problemDeliveredAt).toBeTruthy();
  expect(sources.memoryProblems!(PROJECT, [])).toEqual([]);
});

test("concrete file paths are steered to problem on Unix and Windows", () => {
  const paths = ["config/locales.js", ["", "workspace", "config", "locales.js"].join("/"), ["C:", "workspace", "config", "locales.js"].join("\\")];
  for (const file of paths) expect(() => problems.assertGenericRule(`Read ${file} before translation work.`, "project")).toThrow(/answer problem/);
});

test("leave_lesson accepts generic runtime and framework guidance while concrete paths remain guarded", () => {
  const rules = [
    "Before changing Node.js stream handling, test errors after the first write.",
    "Before changing Next.js route handling, test requests after the first response.",
  ];
  for (const [index, rule] of rules.entries()) {
    const parsed = parseLessons({ lesson: { scope: "role", rule, why: "A runtime boundary needs a repeatable validation check." } }, "builder");
    expect(parsed.lessons[0]?.rule).toBe(rule);
    const source = { project: PROJECT, pipelineId: `runtime-guidance-${index}`, stageId: "fix", attempt: 1, roleId: "builder", conversationId: `runtime-guidance-conversation-${index}`, fixRound: true };
    recordLessonRequest({ ...source, taskId: `runtime-guidance-task-${index}`, at: new Date(NOW).toISOString() });
    expect(leaveLessons({ request: source, source, ...parsed }).left).toHaveLength(1);
  }
  expect(() => parseLessons({ lesson: { scope: "role", rule: "Read config/locales.js before changing language handling.", why: "A runtime boundary needs a repeatable validation check." } }, "builder")).toThrow(/answer problem/);
});

test("capitalized component filenames are refused before the lesson request is consumed", () => {
  const source = { project: PROJECT, pipelineId: "capitalized-file", stageId: "fix", attempt: 1, roleId: "builder", conversationId: "capitalized-file-conversation", fixRound: true };
  recordLessonRequest({ ...source, taskId: "capitalized-file-task", at: new Date(NOW).toISOString() });
  expect(() => parseLessons({ lesson: { scope: "role", rule: "Read PaymentForm.tsx before changing its submit handler.", why: "The specific file contains a project implementation detail." } }, "builder")).toThrow(/answer problem/);
  expect(lessonRequest(source.pipelineId, source.stageId, source.attempt)?.ruleIds).toEqual([]);
  expect(lessonRequest(source.pipelineId, source.stageId, source.attempt)?.none).toBeNull();
});

test("a curator problem in machine scope belongs to its author's project and disappears when restored", () => {
  const source = { project: PROJECT, pipelineId: "old-lane", stageId: "build", attempt: 1, roleId: "builder", conversationId: "old-conversation", fixRound: false };
  const id = roleMemoryCollection(true)!.boundedPatch(4, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope: "machine", rule: "A saved project fact that belongs on the seat agenda.", why: "The instructions disagree with a required gate.", hints: [], state: "archived", reason: "problem", problem, source, createdAt: new Date(NOW).toISOString(), changedAt: new Date(NOW).toISOString() });
    return id;
  });
  expect(problems.memoryProblemSignals(PROJECT, [])).toHaveLength(1);
  expect(problems.memoryProblemSignals("curating-another-project", [])).toEqual([]);
  const current = roleMemoryCollection()!.get(`r:${id}`);
  if (current?.kind !== "rule") throw Error("rule missing");
  roleMemoryCollection()!.boundedPatch(2, tx => tx.put({ ...current, state: "active", reason: undefined, problem: undefined }));
  expect(problems.memoryProblemSignals(PROJECT, [])).toEqual([]);
});

test("a new curator transfer after Undo is offered again even when the calls share a timestamp", () => {
  const source = { project: PROJECT, pipelineId: "repeat-lane", stageId: "build", attempt: 1, roleId: "builder", conversationId: "repeat-conversation", fixRound: false };
  const id = roleMemoryCollection(true)!.boundedPatch(4, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope: "machine", rule: "The local instruction list disagrees with the required gate.", why: "The instructions omit two required locales.", hints: [], state: "active", source, createdAt: new Date(NOW).toISOString(), changedAt: new Date(NOW).toISOString() });
    tx.put({ kind: "scope", scope: "machine", revision: 1, active: [id], history: [] });
    return id;
  });
  const transfer = (pass: NonNullable<ReturnType<typeof claimPass>>) => {
    const row = roleMemoryCollection()!.get("s:machine");
    if (row?.kind !== "scope") throw Error("scope missing");
    applyCuration(pass, { scopes: [{ scope: "machine", revision: row.revision, order: [] }], problem: [{ id, ...problem, note: "This names a concrete project discrepancy." }] }, new Date(NOW + 1).toISOString());
  };
  const first = claimPass({ project: PROJECT, repoDir: root, now: NOW })!;
  transfer(first);
  const old = problems.memoryProblemSignals(PROJECT, []);
  const shown = old.map(seatTickSignalVersion);
  expect(problems.memoryProblemSignals(PROJECT, shown)).toEqual([]);
  patchPass(first.id, { state: "succeeded", endedAt: new Date(NOW + 2).toISOString() });
  revertCuratorPass(first.id, new Date(NOW + 3).toISOString());
  expect(problems.readMemoryProblem(PROJECT, old[0].id)).toBeNull();
  const second = claimPass({ project: PROJECT, repoDir: root, now: NOW + CURATION_INTERVAL_MS + 3 })!;
  transfer(second);
  expect(problems.memoryProblemSignals(PROJECT, shown)).toHaveLength(1);
  expect(problems.readMemoryProblem(PROJECT, old[0].id)).toBeNull();
});

test("a summarized problem points to a complete local report even after delivery", () => {
  const source = report();
  const signal = problems.memoryProblemSignals(PROJECT, [])[0];
  expect(problems.readMemoryProblem(PROJECT, signal.id)).toEqual(problem);
  expect(problems.readMemoryProblem("another-project", signal.id)).toBeNull();
  const item = { kind: "signal" as const, id: signal.id, label: "Long problem evidence ".repeat(250) };
  const payload = seatTickWakePayload({ project: PROJECT, items: [item], reasons: [{ kind: "interval", detail: "a problem is owed" }], signals: [], deferred: 0 });
  expect(payload.text).toContain(`seat_tick_settings verbose:true problemId=${signal.id}`);
  problems.memoryProblemSignals(PROJECT, [seatTickSignalVersion(signal)]);
  expect(lessonRequest(source.pipelineId, source.stageId, source.attempt)?.problemDeliveredAt).toBeTruthy();
  expect(problems.readMemoryProblem(PROJECT, signal.id)).toEqual(problem);
});
