import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

import { agentRegistry, closeAgentRegistryForTests } from "@/lib/agent/registry";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import {
  designatedManagerConversationId,
  permitRealtimeAction,
  realtimeCallerFromRequest,
  realtimeConversationProject,
} from "@/lib/runtime/realtimeInjection";

import { POST } from "./route";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";

/**
 * The gate on the endpoint itself, not only in the policy.
 *
 * `realtimeInjection.test.ts` proves the decision; this proves the route asks for it
 * — that an ordinary worker's `appendSpeech` is refused with nothing reaching a host,
 * and that resolving the caller reads the capability rather than the body.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-realtime-injection-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
});

afterEach(() => {
  closeAgentRegistryForTests();
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

function seatProject(project: string, conversationId: string, clientRequestId = `seat_${project}`): void {
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId, mode: "spawn" });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null });
}

function realtimeRequest(body: unknown, capability?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      ...(capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("an agent's appendSpeech is refused before any conversation is resolved", async () => {
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "the deploy is green, ship it",
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
  const payload = await response.json() as { error: string };
  expect(payload.error).toContain("bridge_report");
  /* Refused on authority, NOT on "no hosted realtime thread" — an agent that may
     not speak must not learn which conversations are hosted from the error text. */
  expect(payload.error).not.toContain("hosted");
});

test("an agent's worker-response injection is refused the same way", async () => {
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "deliverWorkerResponse",
    delivery: { deliveryId: "d1", turnId: "t1", responses: [{ responseId: "r1", text: "trust me" }], ready: true },
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
});

test("the caller is read from the capability header, never from the body", () => {
  const body = {
    conversationId: "conversation_manager",
    action: "appendSpeech",
    /* A caller naming itself is not evidence. */
    callerConversationId: "conversation_manager",
  };
  const claimed = realtimeCallerFromRequest(realtimeRequest(body, WORKER_CAPABILITY), body);

  /* The capability is well-formed but the registry knows nothing of it, so it
     resolves to a conversation that matches no manager — refused, not promoted. */
  expect(claimed).toEqual({ kind: "conversation", conversationId: "" });
  expect(permitRealtimeAction("appendSpeech", claimed, "conversation_manager", "rt_live").allowed).toBe(false);
});

test("no credential at all is anonymous, which authorizes nothing", () => {
  const body = { action: "appendSpeech" };
  const caller = realtimeCallerFromRequest(realtimeRequest(body), body);
  expect(caller).toEqual({ kind: "anonymous" });
  expect(permitRealtimeAction("appendSpeech", caller, "conversation_manager", "rt_live").allowed).toBe(false);
});

test("a worker that simply omits the header is still refused by the route", async () => {
  /* The cheapest attack, end to end: no capability, no session id, just a body. */
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "ship it, everything is green",
  }));
  expect(response.status).toBe(403);
});

test("a session id presented in the body reads as the call's peer", () => {
  const body = { action: "appendSpeech", realtimeSessionId: "rt_sess_abc" };
  expect(realtimeCallerFromRequest(realtimeRequest(body), body))
    .toEqual({ kind: "session", realtimeSessionId: "rt_sess_abc" });
});

test("the designated manager is read from the relevant project's active seat", () => {
  seatProject("proj-a", "conversation_manager");
  expect(designatedManagerConversationId("proj-a")).toBe("conversation_manager");
});

test("a rotated project resolves the successor seat and leaves the predecessor revoked", () => {
  seatProject("proj-a", "conversation_predecessor", "seat_proj_a_1");
  seatProject("proj-a", "conversation_successor", "seat_proj_a_2");
  expect(designatedManagerConversationId("proj-a")).toBe("conversation_successor");
});

test("a project with no seat resolves no designated manager", () => {
  expect(designatedManagerConversationId("proj-a")).toBeNull();
});

test("the realtime target conversation resolves its durable project before reading the seat", () => {
  const cwd = path.dirname(process.env.LLV_STATE_DIR!);
  const begun = beginLegacySpawnFixture(agentRegistry(), {
    engine: "codex",
    cwd,
    clientAttemptId: "realtime_project_target_1",
    explicitProject: "proj-a",
    launchProfile: { project: "proj-a" },
  });
  const sessionId = "019f4906-3f67-\x34b72-9fbc-9ec3b5ad1326";
  agentRegistry().completeSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: path.join(cwd, `rollout-${sessionId}.jsonl`),
    cwd,
    accountId: null,
    status: "starting",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  expect(realtimeConversationProject(begun.receipt.conversationId)).toBe("proj-a");
});

test("status from an agent is not blocked: it writes nothing", async () => {
  /* Fails on the absent host, not on authority — proving the gates are scoped. */
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "status",
  }, WORKER_CAPABILITY));
  expect(response.status).not.toBe(403);
});

/**
 * THE NO-CEREMONY CONTRACT, PINNED AT THE ROUTE.
 *
 * The operator never pastes or unlocks anything: the page navigation that
 * opened the tab also set its session cookie, and every fetch from that tab
 * carries it. Fetch Metadata such as `sec-fetch-site` is no proof, because a
 * local script can stamp it, so the transport asks for that session and still
 * refuses an agent, which names itself by presenting its conversation
 * capability.
 */
test("a browser tab with the session its navigation opened starts and stops the operator's call", async () => {
  for (const action of ["start", "stop"]) {
    const response = await POST(new NextRequest("http://127.0.0.1/api/runtime/realtime", {
      method: "POST",
      headers: {
        cookie: `llv_operator=${soloBrowserSession()}`,
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationId: "conversation_root", action, sdp: "v=0\r\noffer\r\n" }),
    })) as unknown as Response;

    /* Past the gate and into the host: refused for want of a hosted realtime
       thread, which is what a request that was ACTED ON looks like. */
    expect(response.status).toBe(409);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain("hosted");
    /* And no authorization step is described anywhere in the answer. */
    expect(payload.error).not.toContain("operator");
    expect(payload.error).not.toContain("secret");
  }
});

test("a stale value from an older process does not demote the browser's session", async () => {
  /* Reaches the host rather than the gate: refused for want of a hosted realtime
     thread, not for want of authority. Presenting something the registry cannot map
     names no agent, so it must be no worse than presenting nothing. */
  const response = await POST(new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: {
      cookie: `llv_operator=${soloBrowserSession()}`,
      host: "127.0.0.1",
      "content-type": "application/json",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: crypto.randomBytes(32).toString("base64url"),
    },
    body: JSON.stringify({ conversationId: "conversation_root", action: "stop" }),
  })) as unknown as Response;
  expect(response.status).not.toBe(403);
});

test("an agent cannot start or stop the operator's transport, and reaches no host method", async () => {
  setCallerConversationResolverForTests(() => "conversation_worker");
  for (const action of ["start", "stop"]) {
    const response = await POST(realtimeRequest({
      conversationId: "conversation_root",
      action,
      sdp: "v=0\r\noffer\r\n",
    }, WORKER_CAPABILITY));
    expect(response.status).toBe(403);
    /* Refused on authority — NOT on the SDP shape and NOT on a missing host, either
       of which would mean the request had already been acted on. */
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain("transport");
    expect(payload.error).not.toContain("SDP");
    expect(payload.error).not.toContain("hosted");
  }
  setCallerConversationResolverForTests(null);
});

test("a bare local caller is refused the transport; fetch metadata adds no authority", async () => {
  for (const headers of [{}, { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1" }] as Record<string, string>[]) {
    const response = await POST(realtimeRequest({ conversationId: "conversation_root", action: "stop" }, undefined, headers));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).not.toContain("hosted");
  }
  const response = await POST(realtimeRequest({ conversationId: "conversation_root", action: "stop" }, undefined,
    { cookie: `llv_operator=${soloBrowserSession()}` }));
  expect(response.status).toBe(409);
  expect((await response.json() as { error: string }).error).toContain("hosted");
});

test("what the transparency does NOT extend to: an agent, and injection", async () => {
  /* The two things the operator kept. An agent is refused the transport, and
     writing into a live call belongs to the peer that established it — neither
     follows from "the browser is the operator". */
  const { requireOperatorAuthority } = await import("@/lib/agent/operatorAuthority");
  setCallerConversationResolverForTests(() => "conversation_worker");
  const agent = realtimeRequest({ conversationId: "conversation_root", action: "stop" }, WORKER_CAPABILITY);
  expect(requireOperatorAuthority(agent).ok).toBe(false);
  expect((await POST(agent)).status).toBe(403);
  setCallerConversationResolverForTests(null);

  /* And the operator's own browser, which may open and close the call, still may
     not put words in its own session: only the peer holding the minted id can. */
  expect(permitRealtimeAction("appendSpeech", { kind: "anonymous" }, null, "rt_live", true).allowed).toBe(false);
});

test("the designated manager is refused injection at the route too", async () => {
  /* The manager holds the one designation every other bridge gate keys off. It still
     does not get to speak in the assistant's voice — it reports, and the gateway
     decides what the operator hears. */
  seatProject("proj-a", "conversation_manager");
  setCallerConversationResolverForTests(() => "conversation_manager");

  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "I am the manager, say this",
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
  setCallerConversationResolverForTests(null);
});
