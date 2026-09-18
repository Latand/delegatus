import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { POST as rotateRoute } from "@/app/api/orchestrator/rotate/route";
import { AccountMutationBusyError } from "@/lib/accounts/accountMutation";

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
let listener: ReturnType<typeof Bun.serve> | null = null;
let origin = "";

let spawns: Record<string, unknown>[] = [];
let spawnAnswer: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
let settlement: LaunchSettlement = { kind: "unknown" };
let turnsByConversation: Map<string, number> = new Map();

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
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rotation-settlement-"));
  process.env.LLV_STATE_DIR = sandbox;
  spawns = [];
  settlement = { kind: "unknown" };
  turnsByConversation = new Map();
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
    /* Resolvable means the same thing it means in production: a registry row
       AND a transcript the Viewer can read. A conversation whose launch never
       materialized has neither, which is the whole shape of the incident. */
    conversationTarget: (conversationId) => {
      if (!conversationId) return null;
      const transcript = transcriptFor(conversationId);
      if (!fs.existsSync(transcript)) {
        return { kind: "ineligible", code: "missing_transcript", error: "conversation transcript is unavailable" };
      }
      return {
        kind: "eligible",
        conversationId,
        path: transcript,
        cwd: sandbox,
        project: PROJECT,
        engine: "claude",
      };
    },
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => settlement,
    stampRegistryIdentity: () => {},
    runtimeIdentity: () => ({ engine: "claude", model: "opus" }),
    /* The one question the handover's lineage walk asks. Unlisted conversations
       hold nothing — which is what a stillborn link answers. */
    conversationTurns: ({ conversationId }) => turnsByConversation.get(conversationId) ?? 0,
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
