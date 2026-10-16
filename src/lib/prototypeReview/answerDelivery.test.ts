import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import * as settlement from "@/lib/runtime/sendSettlement";
import * as runtime from "@/lib/runtime/client";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { runPrototypeAnswer } from "@/lib/externalRelay/prototypeAnswer";
import { teamStore, resetTeamStoreForTests } from "@/lib/team/store";
import { loadTasks, mutateTasks, saveTasks, TASKS_FILE } from "@/lib/tasks/store";
import { patchTask } from "@/lib/tasks/commands";
import type { BoardTask } from "@/lib/tasks/types";
import { attemptPrototypeDelivery, decidePrototype, prototypeDelivery, type PrototypeDeliveryPorts } from "./decision";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { mintSession, MEMBER_COOKIE } from "@/lib/team/sessions";
import { LEGACY_FIXTURE_TITLE, planGhostSettlement, applyGhostSettlement } from "@/lib/tasks/ghostSettlement";
import { operatorDecisions, seatDecisionNotices, withPrototypeReviewSummaries } from "./read";
import { prototypeReviewNotices } from "./model";
import { resetPrototypeDeliveryWorkerForTests, settlePrototypeDeliveriesForTests, sweepPrototypeDeliveries } from "./deliveryWorker";
import { clearSeatRoundsForTests, insertSeatRound, findSeatRound, loadSeatRounds, mutateSeatRound, SEAT_ROUNDS_LIMIT } from "./seatRounds";
import { telegramPostSignals } from "./telegramPostSignals";
import { prototypeWorld } from "./world";
import type { PrototypeDecision, PrototypeReviewRound } from "./types";

const NOW = Date.parse("2026-10-16T08:00:00Z");
const ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = "123456";
const request = () => new NextRequest("http://localhost", { headers: { host: "localhost" } });
const world = { ...prototypeWorld, orchestrator: () => "conversation_old" };
function round(taskId: string | null = null): PrototypeReviewRound {
  return { id: ID, taskId, project: "project-a", title: "Choose delivery", createdAt: new Date(NOW).toISOString(),
    source: { conversationId: "conversation_old" }, publicationKey: "answer-delivery", inputDigest: "fixture", variants: [],
    questions: [{ id: "where", text: "Where?", options: [{ label: "Here", recommended: true }, { label: "Later" }] }] };
}
function task(rounds = [round("task-a")]): BoardTask {
  return { id: "task-a", project: "project-a", status: "assigned", placement: "unplaced", text: "Deliver answer", assignments: [],
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), prototypeReviews: rounds };
}
function decision(): PrototypeDecision {
  return { chosen: [], comment: "Keep this answer.", at: new Date(NOW).toISOString(), revision: 1, decidedBy: { kind: "operator" },
    delivery: { state: "failed", conversationId: "conversation_old", clientMessageId: `prototype-decision:${ID}`, text: "Saved complete answer", dispatchedAt: new Date(NOW).toISOString(), operationId: "operation-old" } };
}
function ports(): PrototypeDeliveryPorts {
  return { world, now: () => NOW, delivery: { recover: async () => null, send: async () => ({ state: "failed" }), retry: async () => ({ state: "failed" }) } };
}
let root: string;
const previousState = process.env.LLV_STATE_DIR;
beforeEach(async () => {
  setSystemTime(NOW);
  await resetPrototypeDeliveryWorkerForTests(); resetTeamStoreForTests();
  root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "answer-state-")); process.env.LLV_STATE_DIR = root;
  saveTasks([]); clearSeatRoundsForTests();
});
afterEach(async () => {
  await resetPrototypeDeliveryWorkerForTests(); resetTeamStoreForTests();
  setSystemTime();
  process.env.LLV_STATE_DIR = previousState; fs.rmSync(root, { recursive: true, force: true });
});

test.each(["recommended", "explicit"])("B: verified Telegram member is persisted for %s replies", async kind => {
  const skip = kind === "recommended";
  if (!skip) teamStore().insertMember({ id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Owner", role: "owner", status: "active", color: "sky", telegram: null, createdAt: new Date(NOW).toISOString(), createdBy: "claim", revokedAt: null });
  teamStore().insertMember({ id: MEMBER, name: "Replying member", role: skip ? "owner" : "member", status: "active", color: "sky", telegram: { userId: OWNER, username: null, firstName: null, linkedAt: new Date(NOW).toISOString() }, createdAt: new Date(NOW).toISOString(), createdBy: "claim", revokedAt: null });
  insertSeatRound(round());
  let actor: PrototypeDecision["decidedBy"];
  const p = ports();
  p.delivery.send = async saved => { actor = saved.decidedBy; return { state: "sent" }; };
  const input = { reviewId: ID, chosen: [], comment: "", ...(skip ? { skip: true as const } : { answers: [{ questionId: "where", options: [1] }] }) };
  const result = await runPrototypeAnswer({ round: round(), input }, "message-a", () => {}, { world, delivery: p.delivery, telegramUserId: OWNER }).done;
  expect(result.status).toBe("done");
  await settlePrototypeDeliveriesForTests();
  expect(actor).toEqual({ kind: "member", memberId: MEMBER });
  expect(findSeatRound(ID)!.decision!.decidedBy).toEqual(actor);
});

test("B: the real conversation ingress keeps its member gate for legacy and revoked actors", async () => {
  teamStore().insertMember({ id: MEMBER, name: "Owner", role: "owner", status: "active", color: "sky", telegram: null, createdAt: new Date(NOW).toISOString(), createdBy: "claim", revokedAt: null });
  for (const actor of [{ kind: "operator" as const }, { kind: "member" as const, memberId: "m_missing" }]) {
    const response = await conversationHostPOST(new NextRequest("http://localhost/api/conversation-host", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ conversationId: "conversation_old", text: "answer" }) }), { actor });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("member_required");
  }
});

test.each(["safe", "unknown"])("B: terminal reservation is authoritative over a queued journal, disposition=%s", async kind => {
  const duplicateRisk = kind === "unknown";
  const receipt = spyOn(settlement, "resolveSendReceipt").mockResolvedValue({ operationId: "operation-old", kind: "send", state: "failed", duplicateRisk, resend: duplicateRisk ? "verify-first" : "safe", reason: "failed", conversationId: "conversation_old", clientMessageId: "key", acceptedAt: null, settledAt: null, evidence: "delivery-record" });
  const client = spyOn(runtime, "runtimeHostClient").mockReturnValue({ operationStatus: async () => ({ operationId: "operation-old", receipt: { status: "queued" } }) } as never);
  try { expect((await prototypeDelivery.recover(decision()))?.state).toBe(duplicateRisk ? "uncertain" : "failed"); }
  finally { client.mockRestore(); receipt.mockRestore(); }
});

test.each([settlement.SEND_UNVERIFIED_REASON, settlement.SEND_UNRECORDED_REASON, settlement.SEND_UNSETTLEABLE_REASON])("B: an unknown-outcome terminal journal remains uncertain: %s", async reason => {
  const receipt = spyOn(settlement, "resolveSendReceipt").mockResolvedValue({ operationId: "operation-old", kind: "send", state: "failed", duplicateRisk: true, resend: "verify-first", reason, conversationId: "conversation_old", clientMessageId: "key", acceptedAt: null, settledAt: null, evidence: "delivery-record" });
  const client = spyOn(runtime, "runtimeHostClient").mockReturnValue({ operationStatus: async () => ({ operationId: "operation-old", receipt: { status: "failed", reason } }) } as never);
  try {
    expect((await prototypeDelivery.recover(decision()))?.state).toBe("uncertain");
    expect((await prototypeDelivery.retire?.(decision()))?.state).toBe("uncertain");
  } finally { client.mockRestore(); receipt.mockRestore(); }
});

test("B: proven non-execution follows the current seat after recovery, retaining the saved bytes", async () => {
  insertSeatRound({ ...round(), decision: decision() });
  const p = ports();
  let currentSeat = "conversation_old";
  p.world = { ...world, orchestrator: () => currentSeat };
  p.delivery.recover = async () => { currentSeat = "conversation_new"; return { state: "failed", operationId: "operation-old" }; };
  const recipients: string[] = [];
  p.delivery.send = async saved => { recipients.push(saved.delivery.conversationId!); expect(saved.delivery.text).toBe("Saved complete answer"); return { state: "sent" }; };
  p.delivery.retry = async () => { recipients.push("retried-old"); return { state: "sent" }; };
  await attemptPrototypeDelivery(null, ID, p);
  expect(recipients).toEqual(["conversation_new"]);
});

test.each(["pending", "uncertain"] as const)("B: %s execution on a replaced seat is never blindly resent", async state => {
  insertSeatRound({ ...round(), decision: decision() });
  const p = ports(); p.world = { ...world, orchestrator: () => "conversation_new" };
  p.delivery.recover = async () => ({ state, operationId: "operation-old" });
  let sends = 0; p.delivery.send = p.delivery.retry = async () => { sends++; return { state: "sent" }; };
  await attemptPrototypeDelivery(null, ID, p);
  expect(sends).toBe(0);
  expect(findSeatRound(ID)!.decision!.delivery.conversationId).toBe("conversation_old");
});

test("B: automatic attempts and pending age are durably bounded, and the next seat wake carries the answer", async () => {
  insertSeatRound(round());
  decidePrototype(request(), null, { reviewId: ID, chosen: [], skip: true, comment: "Preserve my note." }, world);
  const p = ports(); let sends = 0;
  p.delivery.send = async () => { sends++; return { state: "failed" }; };
  for (let i = 0; i < 25; i++) await sweepPrototypeDeliveries(p, { force: true });
  expect(sends).toBeLessThanOrEqual(10);
  const saved = findSeatRound(ID)!;
  const signals = telegramPostSignals("project-a", [], [saved]);
  expect(signals.some(s => s.label.includes(saved.decision!.delivery.text) && s.actionable)).toBe(true);
  await resetPrototypeDeliveryWorkerForTests();
  await sweepPrototypeDeliveries(p, { force: true });
  expect(sends).toBeLessThanOrEqual(10);
});

test("B: queued replies reach attention after their durable age limit", async () => {
  const saved = decision(); saved.delivery.state = "pending";
  insertSeatRound({ ...round(), decision: saved });
  const p = ports(); p.now = () => NOW + 31 * 60_000;
  p.delivery.recover = async () => ({ state: "pending", operationId: "operation-old" });
  await sweepPrototypeDeliveries(p, { force: true });
  expect(telegramPostSignals("project-a", [], [findSeatRound(ID)!]).some(s => s.label.includes(saved.delivery.text))).toBe(true);
});

test("B: a new process cannot reset an exhausted decision's retry budget", async () => {
  const saved = decision(); delete saved.delivery.operationId; delete saved.delivery.dispatchedAt;
  insertSeatRound({ ...round(), decision: saved });
  const run = async () => {
    const child = Bun.spawn([process.execPath, new URL("./answerDeliveryChild.fixture.ts", import.meta.url).pathname], {
      env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).not.toContain("error:"); expect(code).toBe(0);
    return JSON.parse(stdout).attempts as number;
  };
  expect(await run()).toBe(10);
  expect(await run()).toBe(0);
});

test("C: badge notices and the panel include the same undelivered task and seat rounds", () => {
  const saved = decision(); saved.delivery.failingSince = "2026-10-16T07:00:00Z";
  const t = task([{ ...round("task-a"), decision: saved }]); saveTasks([t]);
  const seat = { ...round(), id: "pr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decision: structuredClone(saved) };
  insertSeatRound(seat);
  const notices = prototypeReviewNotices([t], seatDecisionNotices("project-a"));
  const panel = operatorDecisions("project-a", [t]).decisions;
  expect(notices.map(n => n.reviewId).sort()).toEqual([ID, seat.id]);
  expect(panel.map(r => r.id).sort()).toEqual(notices.map(n => n.reviewId).sort());
  expect(panel.every(r => r.decision?.delivery.phase === "attention")).toBe(true);
});

test.each(["pending", "failed", "uncertain", "no-orchestrator"] as const)("D: %s decided rounds block both task commands and direct store completion", state => {
  const saved = decision(); saved.delivery.state = state;
  const t = task([{ ...round("task-a"), decision: saved }, { ...round("task-a"), id: "pr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
  expect(patchTask([t], t.id, { status: "done" }, new Date(NOW).toISOString())).toMatchObject({ ok: false, status: 409, code: "TASK_DECISION_UNDELIVERED" });
  saveTasks([t]);
  expect(() => mutateTasks(tasks => { tasks[0]!.status = "done"; return { tasks, result: null }; })).toThrow("undelivered");
  expect(loadTasks()[0]!.status).toBe("assigned");
  const delivered = task([{ ...round("task-a"), decision: { ...saved, delivery: { ...saved.delivery, state: "sent" } } }]);
  expect(patchTask([delivered], delivered.id, { status: "done" }, new Date(NOW).toISOString()).ok).toBe(true);
});


test.each(["pending", "failed", "uncertain", "no-orchestrator"] as const)("D: direct store completion refuses a %s decided round atomically", state => {
  const saved = decision(); saved.delivery.state = state;
  saveTasks([task([{ ...round("task-a"), decision: saved }])]);
  expect(() => mutateTasks(tasks => { tasks[0]!.status = "done"; return { tasks, result: null }; })).toThrow("undelivered");
  expect(loadTasks()[0]!.status).toBe("assigned");
});

test("C: historical undelivered rounds survive beside a newer unanswered form in the summary and panel", () => {
  const saved = decision(); saved.delivery.failingSince = "2026-10-16T07:00:00Z";
  const next = { ...round("task-a"), id: "pr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  const t = task([{ ...round("task-a"), decision: saved }, next]);
  const summarized = withPrototypeReviewSummaries([t], new Map(), NOW);
  const notices = prototypeReviewNotices(summarized as BoardTask[], [], NOW);
  expect(notices.map(n => n.reviewId).sort()).toEqual([ID, next.id]);
  expect(operatorDecisions("project-a", [t]).decisions.map(r => r.id).sort()).toEqual([ID, next.id]);
});

test("B: an authenticated member can recover a legacy saved reply without changing its answer or key", () => {
  teamStore().insertMember({ id: MEMBER, name: "Owner", role: "owner", status: "active", color: "sky", telegram: null, createdAt: new Date(NOW).toISOString(), createdBy: "claim", revokedAt: null });
  const cookie = mintSession(teamStore(), MEMBER, "claim", { surface: "desktop", browser: "chrome" }, NOW).value;
  const saved = decision(); saved.delivery.failures = 460;
  insertSeatRound({ ...round(), decision: saved });
  const req = new NextRequest("http://localhost", { headers: { host: "localhost", cookie: `${MEMBER_COOKIE}=${cookie}` } });
  decidePrototype(req, null, { reviewId: ID, retry: true }, world);
  const adopted = findSeatRound(ID)!.decision!;
  expect(adopted.decidedBy).toEqual({ kind: "member", memberId: MEMBER });
  expect(adopted.delivery.clientMessageId).toBe(saved.delivery.clientMessageId);
  expect(adopted.delivery.text).toBe(saved.delivery.text);
  expect(adopted.comment).toBe(saved.comment);
});

test.each(["fenced", "accepted", "unavailable"])("B: replacement seat admission waits for old execution to be %s", async outcome => {
  insertSeatRound({ ...round(), decision: decision() });
  let transitioned = false;
  const client = spyOn(runtime, "runtimeHostClient").mockReturnValue({
    operationStatus: async () => transitioned ? outcome === "accepted" ? { operationId: "operation-old", receipt: { status: "delivering" } } : null : { operationId: "operation-old", receipt: { status: "queued" } },
    transitionOperation: async (_id: string, _state: string, detail: { reason: string }, guard: { fromStatuses: string[] }) => {
      expect(guard.fromStatuses).toEqual(["pending", "queued"]); transitioned = true;
      if (outcome !== "fenced") throw new Error("fence refused");
      return { operationId: "operation-old", receipt: { status: "failed", reason: detail.reason } };
    },
  } as never);
  const recipients: string[] = [];
  const p = ports(); p.world = { ...world, orchestrator: () => "conversation_new" };
  p.delivery = { ...prototypeDelivery, recover: async () => ({ state: "failed", operationId: "operation-old" }),
    send: async saved => { recipients.push(saved.delivery.conversationId!); return { state: "sent" }; },
    retry: async () => { recipients.push("retried-old"); return { state: "sent" }; } };
  try {
    await attemptPrototypeDelivery(null, ID, p);
    expect(recipients).toEqual(outcome === "fenced" ? ["conversation_new"] : []);
  } finally { client.mockRestore(); }
});

test("D: automatic ghost settlement keeps a task with a saved undelivered answer", () => {
  const saved = decision();
  const t = task([{ ...round("task-a"), decision: saved }]);
  t.text = LEGACY_FIXTURE_TITLE; t.origin = { kind: "launch", key: "launch-fixture", refinement: "pending" };
  const input = { tasks: [t], pipelineTaskIds: new Set<string>(), seatIdentities: new Set<string>(), transcriptOf: () => ({ mtimeMs: null }), nowMs: NOW, idleMs: 0 };
  const plan = planGhostSettlement(input);
  expect(applyGhostSettlement([t], plan, input, new Date(NOW).toISOString()).settled).toEqual([]);
});

test.each(["seat", "task"])("B: %s delivery storage waits off the loop for a peer SQLite lock", async kind => {
  if (kind === "seat") insertSeatRound(round()); else saveTasks([task()]);
  const taskId = kind === "seat" ? null : "task-a";
  decidePrototype(request(), taskId, { reviewId: ID, chosen: [], skip: true, comment: "" }, world);
  const database = kind === "seat" ? path.join(root, "state.sqlite") : path.join(path.dirname(TASKS_FILE), "state.sqlite");
  const ready = path.join(root, "holder-ready");
  const child = Bun.spawn([process.execPath, new URL("../state/lockWait.fixture.ts", import.meta.url).pathname, "hold", database, ready, path.join(root, "go"), "500"], { env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
  let ticks = 0;
  const timer = setInterval(() => { if (stateLockWaitsInFlight().length) ticks++; }, 5);
  try {
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(ready)) { if (child.exitCode !== null || performance.now() > deadline) throw new Error("peer lock did not become ready"); await Bun.sleep(5); }
    await attemptPrototypeDelivery(taskId, ID, ports());
    expect(ticks).toBeGreaterThan(5);
    expect(await child.exited).toBe(0);
  } finally { clearInterval(timer); if (child.exitCode === null) child.kill(); await child.exited; }
}, 10000);


test("B: retention keeps every undelivered answer and retires only confirmed delivery", () => {
  for (let i = 0; i < SEAT_ROUNDS_LIMIT; i++) {
    const id = `pr_${i.toString(16).padStart(32, "0")}`;
    insertSeatRound({ ...round(), id, createdAt: new Date(NOW + i * 1000).toISOString(), decision: decision() });
  }
  expect(() => insertSeatRound(round())).toThrow();
  expect(loadSeatRounds()).toHaveLength(SEAT_ROUNDS_LIMIT);
  const first = `pr_${"0".repeat(32)}`;
  mutateSeatRound(first, round => { round.decision!.delivery.state = "sent"; });
  expect(insertSeatRound(round())).toEqual([first]);
  expect(findSeatRound(ID)).toBeDefined();
}, 15000);
