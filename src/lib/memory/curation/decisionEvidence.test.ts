import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentRegistry, closeAgentRegistryForTests } from "@/lib/agent/registry";
import { selfFile } from "@/lib/links/self";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { decidePrototype } from "@/lib/prototypeReview/decision";
import { findSeatRound, insertSeatRound, mutateSeatRound } from "@/lib/prototypeReview/seatRounds";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { loadPrototypeTask, saveTasks, TASKS_FILE } from "@/lib/tasks/store";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { GET as searchMemory, POST as openMemory } from "@/app/api/search/memory/route";
import { legatusDecisionRule } from "../legatusCitation";
import { learnedRulesForLaunchProfile, roleMemoryProfileForIdentity } from "../roleLaunch";
import { alwaysOn } from "../roleSelect";
import { leaveLessonForSeat } from "../roleStage";
import { deleteRule, projectScope, projectView, roleMemoryCollection, roleScope } from "../roleStore";
import { CURATION_INTERVAL_MS, type RoleMemoryRule } from "../roleTypes";
import { applyCuration, type CurationApply } from "./apply";
import { LEGATUS_SCOPE, decisionRuleSource } from "./decisionEvidence";
import { readCuration } from "./read";
import { claimPass, patchPass } from "./store";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

const START = Date.parse("2026-10-11T08:00:00.000Z");
const at = (delta = 0) => new Date(START + delta).toISOString();
const project = "project-review";
const formProject = "project-design";
const serviceProject = "legatus:fixture-install";
const conversation = "conversation_legatus_test";
const why = "Earlier decisions repeatedly favored the established review surface.";
const rule = "Use the existing review surface when it can present the complete choice.";
const words = "Keep the existing review surface.";
let sandbox: string;
let previousState: string | undefined;

beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "decision-evidence-"));
  process.env.LLV_STATE_DIR = sandbox;
  setSystemTime(START);
});

afterEach(() => {
  closeAgentRegistryForTests();
  setCallerConversationResolverForTests(null);
  setSystemTime();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function startSeat() {
  fs.mkdirSync(path.dirname(selfFile()), { recursive: true });
  fs.writeFileSync(selfFile(), JSON.stringify({ v: 1, installId: "fixture-install", label: "Fixture", publicUrl: null }));
  const intent = { project: serviceProject, clientRequestId: "designate-fixture", conversationId: conversation };
  beginOrchestratorSeatIntent({ ...intent, mandate: "Review the saved operator choices.", mode: "existing", now: at() });
  completeOrchestratorSeatIntent({ ...intent, path: null, now: at(1) });
}

function form(number: number, options = { title: `Review ${number}` }) {
  const id = `pr_${number.toString(16).padStart(32, "0")}`;
  const round: PrototypeReviewRound = { id, project: formProject, taskId: null, title: options.title,
    createdAt: at(), source: { conversationId: null }, publicationKey: `form-${number}`, inputDigest: "fixture", variants: [],
    questions: [{ id: "place", text: "Where does the choice belong?", options: [{ label: "Existing view", recommended: true }, { label: "Separate view" }] }] };
  insertSeatRound(round);
  return round;
}

function answer(round: PrototypeReviewRound, option: number, comment: string, stamp: number) {
  setSystemTime(START + stamp);
  const world = { ...prototypeWorld, orchestrator: () => null };
  expect(decidePrototype({ kind: "operator-in-process", authorize() {} }, null,
    { reviewId: round.id, chosen: [], answers: [{ questionId: "place", options: [option] }], comment }, world)).toBe(true);
}

function lesson() {
  return leaveLessonForSeat({ project: serviceProject, roleId: "legatus", conversationId: conversation },
    { lesson: { scope: "role", rule, why, author: "typed", origin: "decision" } }, at()).left[0]!;
}

function activeRule(id: string): RoleMemoryRule {
  const row = roleMemoryCollection()?.get(`r:${id}`);
  if (row?.kind !== "rule") throw Error("missing fixture rule");
  return row;
}

function order(scope: string, ...ids: string[]): CurationApply["scopes"] {
  const held = roleMemoryCollection()?.get(`s:${scope}`);
  return [{ scope, revision: held?.kind === "scope" ? held.revision : 0, order: [...(held?.kind === "scope" ? held.active : []), ...ids] }];
}

test("curation ranks operator answers, attributes literal quotes, runs privacy hints, and replays one write", async () => {
  lesson();
  const typed = form(1), changed = form(2), recommended = form(3), agent = form(4), legatus = form(5);
  answer(typed, 0, words, 1);
  answer(changed, 1, "", 2);
  answer(recommended, 0, "", 3);
  answer(agent, 1, words, 4);
  answer(legatus, 1, words, 5);
  mutateSeatRound(agent.id, round => { round.decision!.decidedBy = { kind: "agent", conversationId: "conversation_agent" }; });
  mutateSeatRound(legatus.id, round => { round.decision!.decidedBy = { kind: "legatus", conversationId: conversation }; });

  // A host can curate its own existing lessons and a form from another project.
  const pass = claimPass({ project: serviceProject, now: START + 6, repoDir: null })!;
  expect(pass.decisionEvidence?.map(ref => "reviewId" in ref && ref.reviewId)).toEqual([typed.id, changed.id, recommended.id]);
  const index = await readCuration(pass);
  expect(index.decisions).toMatchObject({ scope: "decisions", count: 3 });
  const page = await readCuration(pass, "decisions");
  expect(page.decisions[0]).toMatchObject({ text: [words], context: expect.stringContaining("Existing view") });

  const [first, next] = pass.decisionEvidence!;
  const live = patchPass(pass.id, { conversationId: "conversation_curator", state: "running" })!;
  const clue = ["fixture", "example.invalid"].join("@");
  const scope = projectScope(formProject);
  const input: CurationApply = {
    scopes: [...order(LEGATUS_SCOPE, `decision:${first!.id}`), ...order(scope, `decision:${next!.id}`)],
    adoptDecision: [
      { evidence: first!.id, quote: "existing review surface", to: LEGATUS_SCOPE, rule, why: `${why} ${clue}`, note: why },
      { evidence: next!.id, quote: "Separate view", to: scope, rule: "Confirm the reason for making a new surface before building it.", why, note: why },
    ],
  };
  const operation = { pass: live.id, conversationId: live.conversationId!, project: live.project,
    requestId: "curate-once", digest: "b".repeat(64), assertCurrent() {} };
  const result = applyCuration(live, input, at(7), { operation });
  expect(applyCuration(live, input, at(8), { operation })).toEqual(result);
  const t = activeRule(first!.id), c = activeRule(next!.id);
  expect(t.source).toMatchObject({ origin: "decision", project: formProject, reviewId: typed.id, author: "typed" });
  expect(t.hints).toContain("email_address");
  expect(c.source).toMatchObject({ origin: "decision", project: formProject, reviewId: changed.id, author: "clicked" });
  expect([...alwaysOn([c, t])]).toEqual([t.id]);
  expect(projectView(formProject).scopes.find(s => s.scope === LEGATUS_SCOPE)?.active[0]).toMatchObject({ decisionAuthor: "typed" });

  const revision = roleMemoryCollection()?.revision();
  expect(() => applyCuration(live, { ...input, scopes: order(LEGATUS_SCOPE), adoptDecision: input.adoptDecision!.slice(0, 1) }, at(9)))
    .toThrow("already has a rule");
  expect(roleMemoryCollection()?.revision()).toBe(revision);
  patchPass(live.id, { state: "succeeded", endedAt: at(10) });
  const later = claimPass({ project: serviceProject, now: START + CURATION_INTERVAL_MS + 20, repoDir: null })!;
  expect(later.decisionEvidence).toEqual([]);
});

test("a Legatus rewrite drops typed priority while the earlier version keeps its attribution", () => {
  lesson();
  const round = form(30);
  answer(round, 0, words, 1);
  const pass = claimPass({ project: serviceProject, now: START + 2, repoDir: null })!;
  const ref = pass.decisionEvidence![0]!;
  applyCuration(pass, { scopes: order(LEGATUS_SCOPE, `decision:${ref.id}`), adoptDecision: [
    { evidence: ref.id, quote: words, to: LEGATUS_SCOPE, rule, why, note: why },
  ] }, at(3));
  expect(alwaysOn([activeRule(ref.id)])).toContain(ref.id);

  const replacement = "Check the dedicated review surface before following the existing rule.";
  leaveLessonForSeat({ project: serviceProject, roleId: "legatus", conversationId: conversation }, {
    rewrite: { id: ref.id, rule: replacement, why: "The earlier choice was overturned by the seat." },
  }, at(4));

  const current = activeRule(ref.id);
  expect(current.source).toMatchObject({ origin: "decision", author: "typed" });
  expect(current.revisedBy).toMatchObject({ by: "agent", source: { origin: "seat", roleId: "legatus" } });
  expect(alwaysOn([current])).not.toContain(ref.id);
  const view = projectView(serviceProject).scopes.find(scope => scope.scope === LEGATUS_SCOPE)!.active.find(item => item.id === ref.id)!;
  expect(view).not.toHaveProperty("decisionAuthor");
  expect(view.revisedBy).toMatchObject({ by: "agent", roleId: "legatus" });
  expect(view.versions).toEqual([expect.objectContaining({ decisionAuthor: "typed", rule })]);
});

test("a failed first curator pass retries from the original decision scan boundary", () => {
  lesson();
  const round = form(31);
  answer(round, 0, words, 1);
  const first = claimPass({ project: serviceProject, now: START + 2, repoDir: null })!;
  expect(first.decisionEvidence?.map(ref => "reviewId" in ref && ref.reviewId)).toEqual([round.id]);
  patchPass(first.id, { state: "failed", failure: "no-account", endedAt: at(3) });

  const retry = claimPass({ project: serviceProject, now: START + CURATION_INTERVAL_MS + 20, repoDir: null })!;
  expect(retry.decisionEvidence?.map(ref => "reviewId" in ref && ref.reviewId)).toEqual([round.id]);
});

test("a successful 50-item curator batch leaves overflow eligible and deduplicates adopted evidence", () => {
  startSeat();
  const rounds = Array.from({ length: 51 }, (_, i) => form(100 + i));
  rounds.forEach((round, i) => answer(round, 0, `typed choice ${i}`, i + 1));
  const first = claimPass({ project: serviceProject, now: START + 60, repoDir: null })!;
  expect(first.decisionEvidence).toHaveLength(50);
  expect(first.decisionEvidenceHasMore).toBe(true);
  const refs = first.decisionEvidence!;
  applyCuration(first, {
    scopes: order(LEGATUS_SCOPE, ...refs.map(ref => `decision:${ref.id}`)),
    adoptDecision: refs.map((ref, i) => ({ evidence: ref.id, to: LEGATUS_SCOPE,
      rule: `Apply operator choice ${i} to the existing review surface before proceeding.`, why, note: why })),
  }, at(61));
  patchPass(first.id, { state: "succeeded", endedAt: at(62) });

  const next = claimPass({ project: serviceProject, now: START + CURATION_INTERVAL_MS + 100, repoDir: null })!;
  expect(next.decisionEvidence).toHaveLength(1);
  expect(next.decisionEvidence?.[0]).toMatchObject({ reviewId: rounds[0]!.id });
  expect(next.decisionEvidenceHasMore).toBe(false);
});

test("a saved task answer uses the current task project and the operator's custom text", () => {
  // The task store captures its default path when the module loads.
  process.env.LLV_STATE_DIR = path.dirname(TASKS_FILE);
  lesson();
  const taskId = "task-form";
  const taskProject = "project-forms";
  const original = form(1);
  const round = { ...original, id: `pr_${"2".repeat(32)}`, taskId, questions: original.questions!.map(q => ({ ...q, other: true })) };
  saveTasks([{ id: taskId, project: taskProject, status: "inbox", placement: "unplaced", text: "Review existing layout",
    assignments: [], createdAt: at(), updatedAt: at(), prototypeReviews: [round] }]);
  setSystemTime(START + 1);
  expect(decidePrototype({ kind: "operator-in-process", authorize() {} }, taskId, {
    reviewId: round.id, chosen: [], comment: "", originalReply: "Use my custom answer.",
    answers: [{ questionId: "place", options: [], other: true, customText: words }],
  }, { ...prototypeWorld, orchestrator: () => null })).toBe(true);
  expect(loadPrototypeTask(taskId)?.prototypeReviews?.[0]?.decision?.answers?.[0]?.customText).toBe(words);
  const pass = claimPass({ project: serviceProject, now: START + 2, repoDir: null })!;
  const ref = pass.decisionEvidence![0]!;
  expect(ref).toMatchObject({ reviewId: round.id, taskId, project: taskProject });
  expect(decisionRuleSource(ref, words)).toMatchObject({ reviewId: round.id, project: taskProject, author: "typed" });
});

test("a round amended by Legatus after the pass was claimed is refused at apply", () => {
  lesson();
  const round = form(1);
  answer(round, 0, words, 1);
  const pass = claimPass({ project: serviceProject, now: START + 2, repoDir: null })!;
  const ref = pass.decisionEvidence![0]!;
  mutateSeatRound(round.id, stored => { stored.decision!.decidedBy = { kind: "legatus", conversationId: conversation }; });
  expect(() => applyCuration(pass, { scopes: order(LEGATUS_SCOPE, `decision:${ref.id}`),
    adoptDecision: [{ evidence: ref.id, quote: words, to: LEGATUS_SCOPE, rule, why, note: why }] }, at(3)))
    .toThrow("operator evidence changed");
  expect(roleMemoryCollection()?.get(`r:${ref.id}`)).toBeNull();
});

test("the pass reads delivered operator messages to Legatus with channel and a hard limit", () => {
  startSeat();
  const registry = agentRegistry();
  const target = registry.ensureConversation("codex", path.join(sandbox, "legatus.jsonl"), "fixture-account");
  const intent = { project: serviceProject, clientRequestId: "rotate-fixture", conversationId: target.id };
  beginOrchestratorSeatIntent({ ...intent, mandate: "Review the saved operator choices.", mode: "existing", now: at(2) });
  completeOrchestratorSeatIntent({ ...intent, path: null, now: at(3) });
  const send = (key: string, text: string, origin: NonNullable<Parameters<typeof registry.holdDelivery>[6]>["origin"], atMs: number, delivered = true) => {
    setSystemTime(START + atMs);
    const delivery = registry.holdDelivery(target.id, text, key, "text", [], null, { operationId: `send-${key}`, origin });
    if (delivered) registry.recordDeliveryOutcome(delivery.id, "delivered");
  };
  send("typed", words, { kind: "operator" }, 5);
  send("voice", "Keep the headings short.", { kind: "operator", channel: "voice-delegatus" }, 6);
  send("agent", words, { kind: "agent", role: "builder" }, 7);
  send("pending", words, { kind: "operator" }, 8, false);
  send("prototype-decision:generated", words, { kind: "operator" }, 9);

  for (let i = 0; i < 52; i++) answer(form(i + 1), 0, "", 10 + i);
  const pass = claimPass({ project, now: START + 70, repoDir: null })!;
  const refs = pass.decisionEvidence!;
  expect(refs).toHaveLength(50);
  expect(refs.slice(0, 2)).toEqual([expect.objectContaining({ messageRef: "send-typed" }), expect.objectContaining({ messageRef: "send-voice" })]);
  expect(refs[2]).toMatchObject({ reviewId: `pr_${(52).toString(16).padStart(32, "0")}` });
  expect(decisionRuleSource(refs[0]!, "existing review")).toMatchObject({ author: "typed", origin: "decision" });
  expect(decisionRuleSource(refs[0]!, "Existing review")).toMatchObject({ author: "clicked" });
  expect(decisionRuleSource(refs[1]!, "headings short")).toMatchObject({ author: "voice" });
});

test("Legatus lessons use their own scope and a decision cites one delivered or opened active rule", async () => {
  const own = lesson();
  const saved = activeRule(own.id);
  expect(saved.scope).toBe(roleScope(serviceProject, "legatus"));
  expect(saved.source).toMatchObject({ origin: "seat", project: serviceProject, roleId: "legatus", conversationId: conversation });
  expect(saved.source).not.toHaveProperty("author");

  const round = form(1);
  answer(round, 0, words, 1);
  const pass = claimPass({ project: serviceProject, now: START + 2, repoDir: null })!;
  const ref = pass.decisionEvidence![0]!;
  applyCuration(pass, { scopes: order(LEGATUS_SCOPE, `decision:${ref.id}`), adoptDecision: [
    { evidence: ref.id, quote: words, to: LEGATUS_SCOPE, rule, why, note: why },
  ] }, at(3));

  expect(() => legatusDecisionRule(formProject, conversation, [ref.id])).toThrow("cite one active rule");
  expect(() => legatusDecisionRule(formProject, conversation, own.id)).toThrow("active rule readable");
  expect(() => legatusDecisionRule(formProject, conversation, ref.id)).toThrow("received or opened");
  const search = (p: string) => searchMemory(new Request(`http://localhost/api/search/memory?q=surface&reader=legatus&project=${p}`));
  const matches = async (p: string) => (await (await search(p)).json()).items.map((item: { id: string }) => item.id);
  expect(await matches(formProject)).toEqual([ref.id]);
  expect(await matches(serviceProject)).toEqual(expect.arrayContaining([ref.id, own.id]));

  const open = (caller?: string, reader = "legatus") => openMemory(new Request("http://localhost/api/search/memory", {
    method: "POST", headers: caller ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "k".repeat(43) } : {},
    body: JSON.stringify({ id: ref.id, requestId: "open-decision", project: formProject, reader, conversationId: conversation }),
  }));
  setCallerConversationResolverForTests(() => "conversation_other");
  expect((await open("other")).status).toBe(403);
  expect((await open(undefined, "ordinary")).status).toBe(200);
  expect(() => legatusDecisionRule(formProject, conversation, ref.id)).toThrow("received or opened");
  setCallerConversationResolverForTests(() => conversation);
  expect((await open("legatus")).status).toBe(200);

  const nextForm = form(2);
  const context = { kind: "legatus" as const, conversationId: conversation, ruleId: ref.id, authorize() {} };
  const world = { ...prototypeWorld, orchestrator: () => null };
  expect(decidePrototype(context, null, { reviewId: nextForm.id, chosen: [], skip: true, comment: "" }, world)).toBe(true);
  expect(findSeatRound(nextForm.id)?.decision?.decidedBy).toEqual({ kind: "legatus", conversationId: conversation, ruleId: ref.id });

  const profile = roleMemoryProfileForIdentity(emptyLaunchProfile({ cwd: sandbox }), "legatus", serviceProject, true)!;
  const output = await learnedRulesForLaunchProfile(profile, { engine: "codex", conversationId: "conversation_rotated", cwd: sandbox, home: sandbox });
  expect(output).toContain(`[${own.id}]`);
  expect(output).toContain(`[${ref.id}]`);
  expect(legatusDecisionRule(formProject, "conversation_rotated", ref.id)).toBe(ref.id);
  deleteRule(ref.id, at(4));
  expect(() => legatusDecisionRule(formProject, conversation, ref.id)).toThrow("active rule readable");
});

test("a partial Legatus rule open cannot authorize a citation, while a complete open can", async () => {
  lesson();
  const round = form(40);
  answer(round, 0, words, 1);
  const pass = claimPass({ project: serviceProject, now: START + 2, repoDir: null })!;
  const ref = pass.decisionEvidence![0]!;
  const longRule = "Keep the existing review surface when it presents the complete operator choice. ".repeat(3).trim();
  applyCuration(pass, { scopes: order(LEGATUS_SCOPE, `decision:${ref.id}`), adoptDecision: [
    { evidence: ref.id, quote: "existing review surface", to: LEGATUS_SCOPE, rule: longRule, why, note: why },
  ] }, at(3));

  setCallerConversationResolverForTests(() => conversation);
  const open = (requestId: string, maxBytes: number) => openMemory(new Request("http://localhost/api/search/memory", {
    method: "POST", headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: "k".repeat(43) },
    body: JSON.stringify({ id: ref.id, requestId, project: formProject, reader: "legatus", conversationId: conversation, maxBytes }),
  }));
  const partial = await (await open("partial", 320)).json() as { item: { body: string; summary: string } };
  expect(partial.item.body.length).toBeLessThan(longRule.length);
  expect(() => legatusDecisionRule(formProject, conversation, ref.id)).toThrow("received or opened");

  const complete = await (await open("complete", 16_000)).json() as { item: { body: string } };
  expect(complete.item.body).toBe(longRule);
  expect(legatusDecisionRule(formProject, conversation, ref.id)).toBe(ref.id);
});
