import crypto from "node:crypto";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  orchestratorSeatFor,
} from "@/lib/orchestrator/seats";
import * as taskStore from "@/lib/tasks/store";

import { POST as rotatePost } from "../rotate/route";
import { GET as seatGet, POST as seatPost } from "./route";

/*
 * BLOCKING 1 (#758 review), the route half: the DESIGNATION surface refuses a
 * caller that names itself as an agent conversation via the forwarded launch
 * capability, before the body is read and before anything durable changes.
 * The binding half — that the MCP tools actually forward that capability — is
 * proven in `src/lib/mcp/orchestratorTools.test.ts`.
 *
 * ROTATION is the deliberate exception (#1402), and the route itself is what
 * proves it here: the identical request that the seat route refuses as an agent
 * reaches the rotation command, which answers on its own terms.
 * The accepted end-to-end rotation, with the caller attributed, lives in
 * `src/lib/orchestrator/rotationAuthority.test.ts` — this file must not run a
 * real spawn.
 */

let sandbox = "";
let previousStateDir: string | undefined;
let previousHome: string | undefined;
const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  previousHome = process.env.HOME;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-route-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.HOME = sandbox;
  setCallerConversationResolverForTests((digest) =>
    digest === crypto.createHash("sha256").update(WORKER_CAPABILITY).digest("hex")
      ? "conversation_worker"
      : null);
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function agentRequest(pathname: string, body: unknown): NextRequest {
  return new NextRequest(`http://127.0.0.1${pathname}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: WORKER_CAPABILITY,
    },
    body: JSON.stringify(body),
  });
}

test("a capability-presenting agent is refused DESIGNATION at the seat route, and no seat state changes", async () => {
  const seat = await seatPost(agentRequest("/api/orchestrator/seat", {
    project: "proj-a",
    mandate: "mine now",
    clientRequestId: "req_00000001",
  }));
  expect(seat.status).toBe(403);
  expect(await seat.json()).toMatchObject({ error: expect.stringContaining("an agent may not perform it") });

  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending).toBeNull();
});

test("REGRESSION (#1402): the same agent request is ADMITTED by the rotation route, which answers about the seat whoever asked", async () => {
  const rotate = await rotatePost(agentRequest("/api/orchestrator/rotate", {
    project: "proj-a",
    clientRequestId: "req_00000002",
  }));

  /* Not 403 and not the operator-only sentence: nothing is designated for this
     project, so the rotation command's own refusal is what comes back. */
  expect(rotate.status).toBe(409);
  expect(await rotate.json()).toMatchObject({ code: "no_incumbent" });

  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending).toBeNull();
});

test("REGRESSION (#1757): the seat read carries the last FAILED attempt, so its reason survives leaving the pending position", async () => {
  beginOrchestratorSeatIntent({
    project: "proj-a",
    mandate: "own the board",
    clientRequestId: "req_00000010",
    mode: "spawn",
    now: "2026-09-18T09:46:49.000Z",
  });
  failOrchestratorSeatIntent("proj-a", "req_00000010", "the runtime host never answered", "2026-09-18T09:47:31.000Z");

  const answer = await seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat?project=proj-a"));

  expect(answer.status).toBe(200);
  /* Nothing pending — the record is complete — and the reason is still on the
     surface the panel reads. */
  expect(await answer.json()).toMatchObject({
    pending: null,
    lastFailure: {
      error: "the runtime host never answered",
      clientRequestId: "req_00000010",
      designatedAt: "2026-09-18T09:46:49.000Z",
      terminalizedAt: "2026-09-18T09:47:31.000Z",
    },
  });
});

test("the seat read reports the Viewer MCP definition resolved for the project cwd", async () => {
  const project = path.join(sandbox, "project");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });

  const missing = await seatGet(new NextRequest(`http://127.0.0.1/api/orchestrator/seat?project=proj-a&cwd=${encodeURIComponent(project)}`));
  expect(await missing.json()).toMatchObject({ viewerMcpRegistered: false });

  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({
    mcpServers: { viewer: { type: "stdio", command: "project-viewer" } },
  }));
  const registered = await seatGet(new NextRequest(`http://127.0.0.1/api/orchestrator/seat?project=proj-a&cwd=${encodeURIComponent(project)}`));
  expect(await registered.json()).toMatchObject({ viewerMcpRegistered: true });
});

/* #1841 — the Overview spans every project and names none, so it reads the
   seat conversations alone; the per-project read carries the same set, so a
   dashboard whose Tasks panel is in its «all» scope needs no second request. */
test("the seat read answers the cross-project seat conversations, with a project and without one (#1841)", async () => {
  const seat = (project: string, n: number, path: string, now: string) => {
    const clientRequestId = `req_${project}_0000${n}`;
    beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId, mode: "spawn", now });
    completeOrchestratorSeatIntent({ project, clientRequestId, conversationId: `conversation_${project}_${n}`, path, engine: "claude", now });
  };
  seat("proj-a", 1, "/seats/a1.jsonl", "2026-09-18T14:02:00.000Z");
  seat("proj-a", 2, "/seats/a2.jsonl", "2026-09-19T03:10:00.000Z");
  seat("proj-b", 1, "/seats/b1.jsonl", "2026-09-19T04:00:00.000Z");

  const expected = {
    conversationIds: expect.arrayContaining(["conversation_proj-a_2", "conversation_proj-b_1"]),
    paths: expect.arrayContaining(["/seats/a2.jsonl", "/seats/b1.jsonl"]),
    previous: { conversationIds: ["conversation_proj-a_1"], paths: ["/seats/a1.jsonl"] },
  };

  const scoped = await seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat?project=proj-a"));
  expect(scoped.status).toBe(200);
  const scopedBody = await scoped.json() as { all: unknown; seat: { conversationId: string } | null };
  expect(scopedBody.all).toMatchObject(expected);
  /* The project's own answer is unchanged by carrying it. */
  expect(scopedBody.seat?.conversationId).toBe("conversation_proj-a_2");

  const everywhere = await seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat?scope=all"));
  expect(everywhere.status).toBe(200);
  expect(await everywhere.json()).toEqual({ all: expected });
});

/*
 * #1841 — the status read is a POLL, and every surface in the tab shares it:
 * what it costs per tick is part of the answer. The record is ONE document, so
 * the whole answer comes out of one parse of it, and the task store — the
 * larger read — is touched once, only when there is a seat to find notes for.
 */
test("the status read parses the seat record once, and reads the task store once (#1841)", async () => {
  const seatsRead = (paths: readonly string[]) => paths.filter((each) => each.endsWith("orchestrator-seats.json")).length;
  const reads = async (run: () => unknown): Promise<string[]> => {
    const paths: string[] = [];
    const real = fs.readFileSync;
    (fs as unknown as { readFileSync: unknown }).readFileSync = ((target: never, ...rest: never[]) => {
      paths.push(String(target));
      return (real as unknown as (...args: never[]) => never)(target, ...rest);
    }) as never;
    try {
      await run();
    } finally {
      (fs as unknown as { readFileSync: unknown }).readFileSync = real;
    }
    return paths;
  };

  /* A seated project with a retired predecessor: every branch of the answer —
     the seat, the previous seats, their notes tasks, the cross-project set. */
  const seat = (n: number, conversationPath: string, now: string) => {
    const clientRequestId = `req_reads_0000${n}`;
    beginOrchestratorSeatIntent({ project: "proj-a", mandate: "own the board", clientRequestId, mode: "spawn", now });
    completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId, conversationId: `conversation_reads_${n}`, path: conversationPath, engine: "claude", now });
  };
  seat(1, "/seats/r1.jsonl", "2026-09-18T14:02:00.000Z");
  seat(2, "/seats/r2.jsonl", "2026-09-19T03:10:00.000Z");

  /* The task store is counted by CALLS: the store caches its collection, so how
     much FILE work one read of it costs depends on what ran before, while how
     many times the route asks for it does not. */
  const store = spyOn(taskStore, "loadTasks");
  try {
    let status = 0;
    const answer = await reads(async () => { status = (await seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat?project=proj-a"))).status; });
    expect(status).toBe(200);
    /* One parse of the record for the seat, the previous seats and the
       cross-project set; one read of the store for their notes. */
    expect(seatsRead(answer)).toBe(1);
    expect(store.mock.calls.length).toBe(1);

    /* The cross-project scope reads the record once too, and asks the task
       store for nothing: it answers with conversations, not notes. */
    store.mockClear();
    const everywhere = await reads(() => seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat?scope=all")));
    expect(seatsRead(everywhere)).toBe(1);
    expect(store.mock.calls.length).toBe(0);

    /* And a project with no seat and nothing retired reads the record once and
       the store not at all. */
    store.mockClear();
    const vacant = await reads(() => seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat?project=proj-vacant")));
    expect(seatsRead(vacant)).toBe(1);
    expect(store.mock.calls.length).toBe(0);
  } finally {
    store.mockRestore();
  }
});

/* A project is still required of the read that answers about one. */
test("the seat read still refuses a request that names neither a project nor the cross-project scope", async () => {
  const answer = await seatGet(new NextRequest("http://127.0.0.1/api/orchestrator/seat"));
  expect(answer.status).toBe(400);
  expect(await answer.json()).toMatchObject({ error: "project is required" });
});
