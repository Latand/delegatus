import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { POST as rotateRoute } from "@/app/api/orchestrator/rotate/route";
import { AccountMutationBusyError } from "@/lib/accounts/accountMutation";
import { reconcileSeatTick } from "@/lib/monitor/seatTickController";
import { DEFAULT_SEAT_TICK_POLICY } from "@/lib/monitor/seatTick";
import { defaultSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { SeatTickRunRecord } from "@/lib/monitor/types";

import {
  setSeatCommandDependenciesForTests,
  type LaunchSettlement,
  type SeatCommandDependencies,
} from "./seatCommand";
import {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorSeatFor,
  revokedOrchestratorSeatConversationsOrUnknown,
} from "./seats";

/**
 * THE MORNING NOBODY COULD RAISE AN ORCHESTRATOR (#1757).
 *
 * Three rotation attempts burnt an epoch each and left `intentHistory` holding
 * nothing newer than eight days before. The fourth seated a conversation whose
 * launch had only been ACCEPTED — a reserved id, no transcript, no registry row
 * — and then died; the seat pointed at it anyway, the operator typed two
 * messages into its composer that nothing could receive, and the next
 * handover's one instruction was to read that conversation's recent turns.
 *
 * Three claims are asserted here, and they are the whole fix:
 *
 *  1. A rotation whose successor never becomes resolvable leaves the PREVIOUS
 *     seat designated, and the attempt lands in `intentHistory` with its reason.
 *  2. A failed attempt never burns an epoch silently — including the failure
 *     the old code could not record at all, a throw out of the seat transition,
 *     which used to answer an unhandled bodyless 500 and leave the intent
 *     wedged in the blocking `pending` position with no error on it.
 *  3. The handover names the last predecessor that ACTUALLY HOLDS TURNS,
 *     skipping stillborn links in the lineage.
 *
 * WHAT DRIVES THEM: `POST /api/orchestrator/rotate` — the exported route module
 * itself, served on a loopback listener — so the rotation that runs is the
 * production one: its reconciliation, its durable intent, its handoff
 * composition, its activation. The seams are the seat command's outward
 * dependencies (spawn, deliver, summarize, launch settlement, transcript
 * turns), which is what keeps this run from starting a process or touching a
 * live host; every read and write lands in a private state directory.
 *
 * Conversation ids and project names are invented; every path is a sandbox
 * path.
 */

const PROJECT = "project-atlas";
const AT = "2026-09-18T09:46:49.000Z";
/* The lineage, oldest first: the seat that holds the story, the one that was
   seated on a launch that never drew breath, and the successor each rotation
   asks for. */
const ELDER_ID = "conversation_11111111-1111-4111-8111-111111111111";
const INCUMBENT_ID = "conversation_22222222-2222-4222-8222-222222222222";
const SUCCESSOR_ID = "conversation_33333333-3333-4333-8333-333333333333";
const SECOND_SUCCESSOR_ID = "conversation_44444444-4444-4444-8444-444444444444";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

let sandbox = "";
let previousStateDir: string | undefined;
let previousOrchestratorCwd: string | undefined;
let listener: ReturnType<typeof Bun.serve> | null = null;
let origin = "";

let spawns: Record<string, unknown>[] = [];
let spawnAnswer: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
let settlement: LaunchSettlement = { kind: "unknown" };
let turnsByConversation: Map<string, number> = new Map();
/* The launch checkout a conversation still has, when a test cares. `null` is a
   checkout that has been deleted while the conversation went on running. */
let cwdByConversation: Map<string, string | null> = new Map();

beforeAll(() => {
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/orchestrator/rotate" || request.method !== "POST") {
        return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
      }
      const answer = await rotateRoute(new NextRequest(url, {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      }));
      return new Response(await answer.text(), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${listener.port}`;
});

afterAll(() => {
  listener?.stop(true);
  listener = null;
});

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  previousOrchestratorCwd = process.env.LLV_ORCHESTRATOR_CWD;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rotation-settlement-"));
  process.env.LLV_STATE_DIR = sandbox;
  spawns = [];
  settlement = { kind: "unknown" };
  turnsByConversation = new Map();
  cwdByConversation = new Map();
  /* The launch this rotation's successor comes from: durably ACCEPTED, with a
     reserved conversation id and no transcript yet — the exact 202 the incident
     activated on. */
  spawnAnswer = async () => ({
    status: 202,
    body: { ok: true, conversationId: SUCCESSOR_ID, launchId: "launch_successor" },
  });
  setSeatCommandDependenciesForTests(dependencies());
});

afterEach(() => {
  setSeatCommandDependenciesForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousOrchestratorCwd === undefined) delete process.env.LLV_ORCHESTRATOR_CWD;
  else process.env.LLV_ORCHESTRATOR_CWD = previousOrchestratorCwd;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function transcriptFor(conversationId: string): string {
  return path.join(sandbox, `${conversationId.slice(-4)}.jsonl`);
}

/** The launch produced a transcript: from here on the Viewer can resolve this
    conversation, which is what «readable» means on every path under test. */
function materialize(conversationId: string): string {
  const transcript = transcriptFor(conversationId);
  fs.writeFileSync(transcript, "{}\n", "utf8");
  return transcript;
}

/** A spawn that settles synchronously, transcript and all. */
function settledSpawn(conversationId: string, launchId: string): () => Promise<{ status: number; body: Record<string, unknown> }> {
  return async () => ({
    status: 200,
    body: { ok: true, conversationId, path: materialize(conversationId), launchId },
  });
}

function dependencies(): SeatCommandDependencies {
  return {
    spawn: async (body) => {
      spawns.push(body);
      return spawnAnswer(body);
    },
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    /* ADOPTION eligibility, refusing exactly what production refuses: no
       transcript, or no launch cwd on disk. The second one is why this is not
       the seam the handover asks — a conversation can be perfectly readable and
       still fail here. */
    conversationTarget: (conversationId) => {
      if (!conversationId) return null;
      const transcript = transcriptFor(conversationId);
      if (!fs.existsSync(transcript)) {
        return { kind: "ineligible", code: "missing_transcript", error: "conversation transcript is unavailable" };
      }
      const cwd = cwdByConversation.has(conversationId) ? cwdByConversation.get(conversationId) ?? null : sandbox;
      if (!cwd) {
        return { kind: "ineligible", code: "invalid_cwd", error: "conversation cwd is unavailable" };
      }
      return {
        kind: "eligible",
        conversationId,
        path: transcript,
        cwd,
        project: PROJECT,
        engine: "claude",
      };
    },
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => settlement,
    stampRegistryIdentity: () => {},
    runtimeIdentity: () => ({ engine: "claude", model: "opus" }),
    /* What the VIEWER can resolve, which is what both the handover's lineage
       walk and the rollback's predecessor check ask. A transcript on disk is
       the whole bar — no cwd is consulted, exactly as `conversation_messages`
       consults none — and a conversation nobody listed holds no turns, which is
       what a stillborn link answers. */
    resolvedConversation: (conversationId) => {
      if (!conversationId) return null;
      const transcript = transcriptFor(conversationId);
      if (!fs.existsSync(transcript)) return null;
      return {
        conversationId,
        path: transcript,
        holdsTurns: (turnsByConversation.get(conversationId) ?? 0) > 0,
        cwd: cwdByConversation.has(conversationId) ? cwdByConversation.get(conversationId) ?? null : sandbox,
      };
    },
    now: () => AT,
  };
}

/** An active seat that has proved readable: a settled path, nothing
    provisional about it. */
function seatSeeded(conversationId: string, clientRequestId: string): void {
  materialize(conversationId);
  beginOrchestratorSeatIntent({
    project: PROJECT,
    mandate: "own the board",
    clientRequestId,
    mode: "spawn",
    engine: "claude",
    model: "opus",
    now: AT,
  });
  completeOrchestratorSeatIntent({
    project: PROJECT,
    clientRequestId,
    conversationId,
    path: transcriptFor(conversationId),
    now: AT,
  });
}

async function rotate(body: Record<string, unknown>): Promise<Answer> {
  const response = await fetch(new URL("/api/orchestrator/rotate", origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ project: PROJECT, ...body }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const EMPTY_REGISTRY_SNAPSHOT = {
  entries: {}, receipts: {}, lineageEdges: {}, memberships: {},
  conversations: {}, conversationAliases: {}, heldDeliveries: {}, deliveryOperationOwners: {},
};

/**
 * The seat tick's sources, reading the REAL seat store in this sandbox and
 * answering nothing from anywhere else: no board, no pipelines, no lifecycle
 * journal, no `gh`. The tick has nothing to wake anyone about here, which is
 * the point — what is under test is the reconciliation it runs BEFORE it reads
 * a seat at all.
 */
function tickSources(): SeatTickSources {
  return {
    seatFor: orchestratorSeatFor,
    activeSeats: () => [PROJECT],
    pipelines: () => [],
    archivedPipelines: () => [],
    tasks: () => [],
    registry: () => ({
      pageSeatChildren: () => ({ file: EMPTY_REGISTRY_SNAPSHOT, keys: [], after: null, complete: true, evidenceGap: false }),
      seatTickConversation: () => null,
      conversation: () => null,
      conversationForPath: () => null,
      readOnlySnapshot: () => EMPTY_REGISTRY_SNAPSHOT,
    }) as never,
    liveness: async () => [],
    lifecycleJournal: () => ({ version: 1, lastSeq: 0, events: [], retired: [] }) as never,
    latestDeployment: () => ({ state: "unreadable", error: "no ledger" }) as never,
    retirementReport: () => null,
    settings: () => defaultSeatTickSettings(PROJECT),
    openPullRequests: async () => ({ ok: true, pullRequests: [] }),
    wakeState: async () => "absent",
    withdrawWake: async () => "unknown",
    now: () => Date.parse(AT),
  };
}

/** One sweep of the production tick over this project, journaling in memory. */
async function tick(): Promise<SeatTickRunRecord[]> {
  const journal: SeatTickRunRecord[] = [];
  const records = await reconcileSeatTick({
    policy: DEFAULT_SEAT_TICK_POLICY,
    sources: tickSources(),
    ownsTraffic: () => true,
    appendRecord: (record) => { journal.push(record); },
    ensureCard: () => true,
    deliver: async () => { throw new Error("the tick must send nothing while reconciling a stillborn seat"); },
    proposalIssues: async () => [],
  });
  return records.length ? records : journal;
}

/** The successor's launch prompt, which IS the mandate the handover composed. */
function lastSpawnPrompt(): string {
  const prompt = spawns.at(-1)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

test("REGRESSION (#1757): a rotation whose successor never becomes resolvable leaves the PREVIOUS seat designated, with the reason in intentHistory", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  const seededEpoch = orchestratorSeatFor(PROJECT).active?.seatEpoch;
  turnsByConversation.set(INCUMBENT_ID, 120);

  /* The rotation the operator ordered: accepted 202, seat activated on a
     conversation that exists only as a reservation. */
  const accepted = await rotate({ clientRequestId: "req_rotation_0001" });
  expect(accepted.status).toBe(202);
  expect(orchestratorSeatFor(PROJECT).active).toMatchObject({
    conversationId: SUCCESSOR_ID,
    path: null,
  });

  /* ...and then the launch dies, exactly as it did: a runtime host that never
     answered, a transcript file that was never created. */
  settlement = { kind: "failed", error: "structured spawn transport failed: runtime host timed out" };
  spawnAnswer = async () => ({ status: 409, body: { ok: false, error: "the next attempt is refused too" } });

  const next = await rotate({ clientRequestId: "req_rotation_0002" });

  /* The rotation that found the stillborn seat rolled it back before reading an
     incumbent, so the seat the operator can actually reach holds the project
     again — at a strictly newer epoch, which is what lifts the revocation that
     ended it. */
  const afterwards = orchestratorSeatFor(PROJECT);
  expect(afterwards.active).toMatchObject({ conversationId: INCUMBENT_ID, state: "active" });
  expect(afterwards.active?.seatEpoch).toBeGreaterThan(seededEpoch ?? 0);
  expect(afterwards.active?.path).toBe(transcriptFor(INCUMBENT_ID));
  /* The restored seat is not read as revoked by the ABA guard, and the
     stillborn one is. */
  const revoked = revokedOrchestratorSeatConversationsOrUnknown();
  expect(revoked?.has(INCUMBENT_ID)).toBe(false);
  expect(revoked?.has(SUCCESSOR_ID)).toBe(true);

  /* Both burnt epochs are on the record the operator reads, each with its
     reason — the whole complaint in the issue was three that were not. */
  const stillborn = afterwards.history.find((entry) => entry.seat.conversationId === SUCCESSOR_ID);
  expect(stillborn).toBeDefined();
  expect(stillborn?.reason).toBe("terminal_error");
  expect(stillborn?.seat.intent.error).toContain("runtime host timed out");
  expect(stillborn?.seat.intent.error).toContain("before its conversation became readable");
  const refused = afterwards.history.find((entry) => entry.seat.intent.clientRequestId === "req_rotation_0002");
  expect(refused?.seat.intent.error).toContain("the next attempt is refused too");
  /* The rotation that could not replace it says so, and names the designation
     that died on the same answer — otherwise the incumbent simply changes
     identity between two calls and nothing says a rotation ever failed. */
  expect(next.status).toBe(409);
  expect(next.body.rolledBack).toMatchObject({
    conversationId: SUCCESSOR_ID,
    seatEpoch: 2,
    error: expect.stringContaining("runtime host timed out"),
  });
});

test("REGRESSION (#1757): a launch that DOES become readable confirms the seat instead of rolling it back", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 120);

  const accepted = await rotate({ clientRequestId: "req_rotation_0001" });
  expect(accepted.status).toBe(202);

  /* The launch materialized: a receipt with an artifact path, and a
     conversation the Viewer can resolve. */
  settlement = {
    kind: "settled",
    conversationId: SUCCESSOR_ID,
    path: materialize(SUCCESSOR_ID),
    launchId: "launch_successor",
  };
  spawnAnswer = async () => ({ status: 409, body: { ok: false, error: "no further rotation wanted here" } });

  await rotate({ clientRequestId: "req_rotation_0002" });

  const afterwards = orchestratorSeatFor(PROJECT);
  /* Still the successor's seat, now proved: the transcript path is recorded and
     the rollback it carried while provisional is gone. */
  expect(afterwards.active).toMatchObject({
    conversationId: SUCCESSOR_ID,
    path: transcriptFor(SUCCESSOR_ID),
  });
  /* Nothing was rolled back: no history entry names the successor, and the
     predecessor it replaced stays revoked. */
  expect(afterwards.history.filter((entry) => entry.seat.conversationId === SUCCESSOR_ID)).toEqual([]);
  expect(revokedOrchestratorSeatConversationsOrUnknown()?.has(INCUMBENT_ID)).toBe(true);
});

test("REGRESSION (#1757): a refused rotation is terminalized into intentHistory AT ONCE, without waiting for a next attempt", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 120);
  spawnAnswer = async () => ({ status: 409, body: { ok: false, error: "spawn admission refused the launch" } });

  const refused = await rotate({ clientRequestId: "req_rotation_0001" });

  expect(refused.status).toBe(409);
  const seats = orchestratorSeatFor(PROJECT);
  /* The incumbent keeps the seat, nothing blocks the next attempt, and the
     failure is history the moment it happened rather than the next time
     somebody designates — a call that may never come. */
  expect(seats.active?.conversationId).toBe(INCUMBENT_ID);
  expect(seats.pending).toBeNull();
  expect(seats.history).toHaveLength(1);
  expect(seats.history[0]).toMatchObject({
    reason: "terminal_error",
    seat: { intent: { clientRequestId: "req_rotation_0001", error: "spawn admission refused the launch" } },
  });
  /* The answer carries the very row that was written, so the caller never has
     to read back a pending slot that is deliberately empty. */
  expect(refused.body.seat).toMatchObject({ intent: { error: "spawn admission refused the launch" } });
});

test("REGRESSION (#1757): a THROW out of the seat transition is recorded and answered, and does not wedge the project", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 120);
  /* The throw the incident left in the container log, from the lock the seat
     store is written under. It used to escape the route as a bodyless 500. */
  spawnAnswer = async () => { throw new AccountMutationBusyError(); };

  const thrown = await rotate({ clientRequestId: "req_rotation_0001" });

  expect(thrown.status).toBe(503);
  expect(thrown.body).toMatchObject({ code: "seat_store_busy", retryable: true });
  expect(String(thrown.body.error)).toContain("busy");
  const seats = orchestratorSeatFor(PROJECT);
  expect(seats.active?.conversationId).toBe(INCUMBENT_ID);
  expect(seats.history).toHaveLength(1);
  expect(seats.history[0]?.seat.intent).toMatchObject({ clientRequestId: "req_rotation_0001" });
  expect(String(seats.history[0]?.seat.intent.error)).toContain("busy");

  /* And the epoch it burnt did not take the project with it: a NEW key rotates,
     rather than being refused behind a pending intent nothing would ever
     clear. */
  spawnAnswer = async () => ({
    status: 202,
    body: { ok: true, conversationId: SUCCESSOR_ID, launchId: "launch_successor" },
  });
  const retried = await rotate({ clientRequestId: "req_rotation_0002" });
  expect(retried.status).toBe(202);
  expect(orchestratorSeatFor(PROJECT).active?.conversationId).toBe(SUCCESSOR_ID);
});

test("REGRESSION (#1757): the handover names the last predecessor that HOLDS TURNS, skipping a stillborn link", async () => {
  /* The lineage the incident left behind: the elder holds the story, the seat
     being replaced holds nothing at all. */
  seatSeeded(ELDER_ID, "req_seed_00000001");
  turnsByConversation.set(ELDER_ID, 240);
  spawnAnswer = settledSpawn(INCUMBENT_ID, "launch_incumbent");
  expect((await rotate({ clientRequestId: "req_rotation_0001" })).status).toBe(200);
  expect(orchestratorSeatFor(PROJECT).active?.conversationId).toBe(INCUMBENT_ID);
  /* ...and that seat turns out to be the stillborn link: no transcript, so
     `get_conversation` answers «not found» and `conversation_messages` has
     nothing to page. */
  fs.rmSync(transcriptFor(INCUMBENT_ID), { force: true });

  spawnAnswer = settledSpawn(SECOND_SUCCESSOR_ID, "launch_second");
  const rotated = await rotate({ clientRequestId: "req_rotation_0002" });

  expect(rotated.status).toBe(200);
  const mandate = lastSpawnPrompt();
  /* The seat being replaced is still named as the seat being replaced — that is
     a fact about authority, and it does not change. */
  expect(mandate).toContain(`You are replacing orchestrator conversation ${INCUMBENT_ID}`);
  /* ...but the conversation the successor is told to READ is the one that has
     something to hand over, and the mandate says why it is not the incumbent. */
  expect(mandate).toContain("The seat you are replacing holds no readable turns");
  expect(mandate).toContain(`The last predecessor in this lineage that does is ${ELDER_ID}`);
  expect(mandate).toContain(`"conversationId":"${ELDER_ID}"`);
  expect(mandate).not.toContain(`"conversationId":"${INCUMBENT_ID}"`);
  /* ...and the successor is launched in the checkout of the predecessor it was
     told to read, rather than the rotation failing for want of one. */
  expect(spawns.at(-1)?.cwd).toBe(sandbox);
});

test("REGRESSION (#1757): a predecessor whose CHECKOUT was deleted is still the conversation the handover names", async () => {
  /* The layout the issue reports for the seat it found: an orchestrator running
     with its cwd inside a worktree checkout, and the checkout removed while it
     went on running. Its transcript is untouched and holds hundreds of turns,
     and `conversation_messages` — which never looks at a cwd — reads it. */
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 300);
  cwdByConversation.set(INCUMBENT_ID, null);
  /* Somewhere to run that is NOT the deleted checkout, which is what the
     generic resolver answers in production — and a different directory, so the
     assertion below can tell an inherited checkout from a resolved one. */
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rotation-elsewhere-"));
  process.env.LLV_ORCHESTRATOR_CWD = elsewhere;
  spawnAnswer = settledSpawn(SUCCESSOR_ID, "launch_successor");

  const rotated = await rotate({ clientRequestId: "req_rotation_0001" });

  expect(rotated.status).toBe(200);
  const mandate = lastSpawnPrompt();
  /* The handover names it, as it did before any of this — losing a readable
     predecessor to a missing directory would be a new way to lose exactly what
     the issue is about. */
  expect(mandate).toContain("Your predecessor's recent turns");
  expect(mandate).toContain(`"conversationId":"${INCUMBENT_ID}"`);
  expect(mandate).not.toContain("holds no readable turns");
  /* ...and the rotation inherits no checkout from a directory that is gone,
     falling through to the generic resolver rather than refusing: the missing
     directory is a fact about the filesystem, and not about the handover. */
  expect(spawns.at(-1)?.cwd).toBe(elsewhere);
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test("REGRESSION (#1757): a lineage with no readable turns anywhere says so, instead of naming a conversation nobody can read", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  spawnAnswer = settledSpawn(SUCCESSOR_ID, "launch_successor");

  const rotated = await rotate({ clientRequestId: "req_rotation_0001" });

  expect(rotated.status).toBe(200);
  const mandate = lastSpawnPrompt();
  expect(mandate).toContain("No conversation in this seat's lineage holds readable turns");
  expect(mandate).not.toContain("conversation_messages(");
});

test("a rotation from an incumbent that holds turns still names the incumbent — the ordinary handover is unchanged", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 41);
  spawnAnswer = settledSpawn(SUCCESSOR_ID, "launch_successor");

  const rotated = await rotate({ clientRequestId: "req_rotation_0001" });

  expect(rotated.status).toBe(200);
  const mandate = lastSpawnPrompt();
  expect(mandate).toContain("Your predecessor's recent turns");
  expect(mandate).toContain(`"conversationId":"${INCUMBENT_ID}"`);
  expect(mandate).not.toContain("holds no readable turns");
});

test("REGRESSION (#1757): the SEAT TICK rolls back a stillborn seat, with no route call in between", async () => {
  /* The incident's own window: the rotation was accepted, the seat activated on
     a reserved conversation, and then nobody called a route again for hours
     while the board went on showing that seat's composer. */
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  const seededEpoch = orchestratorSeatFor(PROJECT).active?.seatEpoch ?? 0;
  turnsByConversation.set(INCUMBENT_ID, 120);
  expect((await rotate({ clientRequestId: "req_rotation_0001" })).status).toBe(202);
  expect(orchestratorSeatFor(PROJECT).active).toMatchObject({ conversationId: SUCCESSOR_ID, path: null });

  settlement = { kind: "failed", error: "structured spawn transport failed: runtime host timed out" };

  /* The clock the release already runs, sweeping the projects that hold seats.
     Nothing else happens: no rotation, no designation, no send. */
  const records = await tick();

  const afterwards = orchestratorSeatFor(PROJECT);
  expect(afterwards.active).toMatchObject({ conversationId: INCUMBENT_ID, state: "active" });
  expect(afterwards.active?.seatEpoch).toBeGreaterThan(seededEpoch);
  const stillborn = afterwards.history.find((entry) => entry.seat.conversationId === SUCCESSOR_ID);
  expect(stillborn?.reason).toBe("terminal_error");
  expect(stillborn?.seat.intent.error).toContain("runtime host timed out");
  /* ...and the tick's own journal line says what it repaired, so the record the
     operator reads is not only the seat file. */
  expect(records.map((record) => record.detail ?? "").join(" ")).toContain("was stillborn and has been rolled back");
  expect(spawns).toHaveLength(1);
});

test("REGRESSION (#1757): the seat tick leaves an UNSETTLED launch alone — a boot window is not a failure", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 120);
  expect((await rotate({ clientRequestId: "req_rotation_0001" })).status).toBe(202);

  /* No terminal receipt: the launch is still in flight. */
  settlement = { kind: "unknown" };

  await tick();

  const afterwards = orchestratorSeatFor(PROJECT);
  expect(afterwards.active).toMatchObject({ conversationId: SUCCESSOR_ID, path: null, state: "active" });
  expect(afterwards.history.filter((entry) => entry.seat.conversationId === SUCCESSOR_ID)).toEqual([]);
});

test("REGRESSION (#1757): a rollback whose PREDECESSOR is no longer resolvable leaves the project undesignated, and says why", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 120);
  expect((await rotate({ clientRequestId: "req_rotation_0001" })).status).toBe(202);

  /* Both ends fail inside the provisional window: the launch died, and the
     predecessor it superseded stopped being resolvable while it waited — its
     card closed, its transcript gone. Designating the project back onto it
     would reach the very state this recovery exists to prevent. */
  settlement = { kind: "failed", error: "structured spawn transport failed: runtime host timed out" };
  fs.rmSync(transcriptFor(INCUMBENT_ID), { force: true });

  await tick();

  const afterwards = orchestratorSeatFor(PROJECT);
  expect(afterwards.active).toBeNull();
  const stillborn = afterwards.history.find((entry) => entry.seat.conversationId === SUCCESSOR_ID);
  expect(stillborn?.seat.intent.error).toContain(INCUMBENT_ID);
  expect(stillborn?.seat.intent.error).toContain("is no longer resolvable either");
  expect(stillborn?.seat.intent.error).toContain("left undesignated");
});

test("REGRESSION (#1757): a seat that was ALREADY provisional rolls back to the predecessor its revocation names", async () => {
  seatSeeded(INCUMBENT_ID, "req_seed_00000001");
  turnsByConversation.set(INCUMBENT_ID, 120);
  expect((await rotate({ clientRequestId: "req_rotation_0001" })).status).toBe(202);

  /* The shape a seat standing on a stillborn conversation when this recovery
     ships has: an active provisional seat, a revocation naming the predecessor
     it superseded, and no `rollbacks` entry — because nothing wrote one. */
  const file = path.join(sandbox, "orchestrator-seats.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { rollbacks: Record<string, unknown> };
  expect(Object.keys(parsed.rollbacks)).toContain(PROJECT);
  parsed.rollbacks = {};
  fs.writeFileSync(file, JSON.stringify(parsed), "utf8");

  settlement = { kind: "failed", error: "structured spawn transport failed: runtime host timed out" };

  await tick();

  const afterwards = orchestratorSeatFor(PROJECT);
  /* The lineage carried the recovery the map had lost: the predecessor holds
     the project again, at an epoch strictly newer than the revocation that
     ended it. */
  expect(afterwards.active).toMatchObject({ conversationId: INCUMBENT_ID, state: "active" });
  expect(afterwards.active?.seatEpoch).toBeGreaterThan(2);
  expect(revokedOrchestratorSeatConversationsOrUnknown()?.has(INCUMBENT_ID)).toBe(false);
  expect(afterwards.history.find((entry) => entry.seat.conversationId === SUCCESSOR_ID)?.reason).toBe("terminal_error");
});
