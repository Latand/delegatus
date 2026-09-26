import crypto from "node:crypto";

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { internalServiceHeaders, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { readDeputies } from "@/lib/orchestrator/deputies";
import { setDeputyRootResolverForTests } from "@/lib/orchestrator/deputyAsker";

import { POST } from "./route";

/*
 * Who may start the orchestrator's parallel self (docs/design/ghost-seat.md
 * §5). A deputy holds the seat's authority, so an agent that could start one
 * would hand itself the manager surface in one move, and its words would reach
 * the deputy as the operator's. The route admits the operator's browser and
 * the voice gateway (the root session) and refuses every other caller before
 * the body is read and before anything durable is written.
 */

let sandbox = "";
let previousStateDir: string | undefined;
let previousHome: string | undefined;
const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");
const ROOT_CAPABILITY = crypto.randomBytes(32).toString("base64url");
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  previousHome = process.env.HOME;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ghost-route-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.HOME = sandbox;
  setCallerConversationResolverForTests((value) =>
    value === digest(WORKER_CAPABILITY) ? "conversation_worker"
      : value === digest(ROOT_CAPABILITY) ? "conversation_root"
        : null);
  setDeputyRootResolverForTests(() => "conversation_root");
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  setDeputyRootResolverForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function ask(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/orchestrator/ghost", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify({ project: "proj-a", text: "file a task", clientRequestId: "ask-1" }),
  });
}

test("a worker presenting its capability is refused, and no deputy record is written", async () => {
  const response = await POST(ask({ [VIEWER_SPAWN_CAPABILITY_HEADER]: WORKER_CAPABILITY, ...internalServiceHeaders("mcp") }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "asker_refused" });
  expect(readDeputies()).toEqual([]);
});

test("an MCP call that names no conversation is refused: nobody could be named as the ask's author", async () => {
  const response = await POST(ask(internalServiceHeaders("mcp")));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "asker_refused" });
});

test("the voice gateway and the operator's browser are admitted and reach the command", async () => {
  /* No seat is designated in the sandbox, so the command's own refusal is
     what comes back: the admission let both through. */
  for (const headers of [{ [VIEWER_SPAWN_CAPABILITY_HEADER]: ROOT_CAPABILITY, ...internalServiceHeaders("mcp") }, {}]) {
    const response = await POST(ask(headers));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "seat_not_found" });
  }
});
