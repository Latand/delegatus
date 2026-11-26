import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

import { recordOperatorRequest, readRequests } from "@/lib/activity/requestLedger";
import type { RegistryFile } from "@/lib/agent/registry";
import { internalServiceHeaders, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

import { handleRuntimeAdmissionQuery, handleRuntimeCommand, type RuntimeHttpDependencies } from "./http";
import { resetIngressStopsForTests } from "./ingressStop";

/* The activity ledger at the structured send ingress: the operator's own send
   is one row, an agent or a Viewer service writes none, and a ledger that
   cannot be written never refuses the send. */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "http-activity-ledger-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
let ledgerDir: string;
let reports: string[];

/** A Viewer page's request, which carries the session cookie its navigation
    opened; `browser: false` is a script's, which carries none. */
function request(body: unknown, headers: Record<string, string> = {}, browser = true): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", "user-agent": PHONE, ...(browser ? { cookie: `llv_operator=${soloBrowserSession()}`, "sec-fetch-site": "same-origin" } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

function dependencies(enqueued: unknown[]): RuntimeHttpDependencies {
  return {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    recordOperatorRequest: (req, input) => recordOperatorRequest(req, input, {
      dir: () => ledgerDir,
      registrySnapshot: () => ({ conversations: {} }) as unknown as RegistryFile,
      report: (event, fields) => reports.push(`${event}:${String(fields.outcome)}`),
    }),
    enqueue: async (input) => {
      enqueued.push(input);
      return { ok: false, status: 409, error: "fixture host refused" } as never;
    },
    recordOperatorAdmission: () => false,
  };
}

const rows = () => readRequests(0, Date.now() + 60_000, { dir: () => ledgerDir }).rows.map(({ at, project, surface, kind }) => ({ at, project, surface, kind }));

beforeEach(() => {
  resetIngressStopsForTests(() => {});
  process.env.LLV_STATE_DIR = path.join(sandbox, `state-${Math.random().toString(36).slice(2)}`);
  ledgerDir = path.join(process.env.LLV_STATE_DIR, "activity");
  reports = [];
  setCallerConversationResolverForTests(() => "conversation_agent");
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
});

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("an operator send writes one row with its surface, and its retry shares it", async () => {
  const enqueued: unknown[] = [];
  const body = { conversationId: "conversation_direct", text: "ship the fix", idempotencyKey: "operator-send-1" };
  await handleRuntimeCommand(request(body), "send", dependencies(enqueued));
  await handleRuntimeCommand(request(body), "send", dependencies(enqueued));
  expect(enqueued).toHaveLength(2);
  expect(rows()).toEqual([{ at: expect.any(Number), project: null, surface: "phone", kind: "message" }]);
  const text = fs.readFileSync(path.join(ledgerDir, fs.readdirSync(ledgerDir)[0]!), "utf8");
  expect(text).not.toContain("ship the fix");
  expect(text).not.toContain("conversation_direct");
});

test("an agent naming itself and a Viewer service write no row", async () => {
  const enqueued: unknown[] = [];
  await handleRuntimeCommand(request(
    { conversationId: "conversation_direct", text: "relay", idempotencyKey: "agent-send-1" },
    { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) },
  ), "send", dependencies(enqueued));
  await handleRuntimeCommand(request(
    { conversationId: "conversation_direct", text: "monitor note", idempotencyKey: "service-send-1" },
    internalServiceHeaders("monitor"),
  ), "send", dependencies(enqueued));
  /* Both sends still went through; neither is the operator's time. */
  expect(enqueued).toHaveLength(2);
  expect(rows()).toEqual([]);
});

test("a script holding the operator's token is admitted as an API client: no operator origin, no row", async () => {
  /* An agent posting relays over ssh to another host's Viewer: no capability
     of its own, and no fetch metadata, which only a browser sends. */
  const enqueued: Array<{ origin?: unknown }> = [];
  await handleRuntimeCommand(request(
    { conversationId: "conversation_direct", text: "relay from another host", idempotencyKey: "script-send-1" },
    {},
    false,
  ), "send", dependencies(enqueued as unknown[]));
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]!.origin).toEqual({ kind: "agent", role: "api-client" });
  expect(rows()).toEqual([]);
});

test("a Viewer page's send keeps the operator origin and writes its row", async () => {
  const enqueued: Array<{ origin?: unknown }> = [];
  await handleRuntimeCommand(request(
    { conversationId: "conversation_direct", text: "go on", idempotencyKey: "page-send-1" },
  ), "send", dependencies(enqueued as unknown[]));
  expect(enqueued[0]!.origin).toEqual({ kind: "operator" });
  expect(rows()).toHaveLength(1);
});

test("a ledger that cannot be written still admits the send", async () => {
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(ledgerDir, "not a directory");
  const enqueued: unknown[] = [];
  const response = await handleRuntimeCommand(request(
    { conversationId: "conversation_direct", text: "go on", idempotencyKey: "operator-send-2" },
  ), "send", dependencies(enqueued));
  expect(enqueued).toHaveLength(1);
  expect(response.status).toBe(409);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toStartWith("request_not_stored:");
});

/* 2026-11-09: one operator send passed this ingress, left its ledger row and
   its admission marker, and never got a delivery reservation. Nothing said
   which step stopped it, so a lookup under its key could not tell a refusal
   from a request that never arrived. The step that stops a message between
   the bookkeeping and the reservation is now named on the response, and the
   lookup returns it beside the absence it proves. */
async function lookup(conversationId: string, clientMessageId: string): Promise<Record<string, unknown>> {
  const response = await handleRuntimeAdmissionQuery(new NextRequest(
    `http://127.0.0.1/api/runtime/send?conversationId=${conversationId}&clientMessageId=${clientMessageId}`,
    { method: "GET", headers: { host: "127.0.0.1" } },
  ), {
    enabled: () => true,
    registry: () => ({ deliveryAdmissionForKey: () => ({ outcome: "not-executed" as const }) }) as never,
    query: async () => { throw new Error("an absent key has no operation to query"); },
    sendInFlight: () => false,
  });
  return await response.json() as Record<string, unknown>;
}

test("bookkeeping that fails after the ledger row is a refusal, and the lookup names where it stopped", async () => {
  const enqueued: unknown[] = [];
  const failing: RuntimeHttpDependencies = {
    ...dependencies(enqueued),
    recordOperatorAdmission: () => { throw new Error("admission marker store is unavailable"); },
  };
  const body = { conversationId: "conversation_direct", text: "the words that must not vanish", idempotencyKey: "bookkeeping-stop" };
  const response = await handleRuntimeCommand(request(body), "send", failing);
  expect(rows()).toHaveLength(1);
  expect(enqueued).toEqual([]);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "the send could not be recorded before delivery",
    retryable: true,
    delivery: "refused",
    stop: { boundary: "bookkeeping", reason: "bookkeeping-failed" },
  });
  expect(await lookup(body.conversationId, body.idempotencyKey)).toEqual({
    outcome: "not-executed", conversationId: body.conversationId, clientMessageId: body.idempotencyKey,
    stop: { boundary: "bookkeeping", reason: "bookkeeping-failed", status: 503, at: expect.any(String) },
  });
});

test("an admission that throws after the ledger row stays uncertain, and the lookup still names its stop", async () => {
  const body = { conversationId: "conversation_direct", text: "go on", idempotencyKey: "admission-throw" };
  const response = await handleRuntimeCommand(request(body), "send", {
    ...dependencies([]),
    enqueue: async () => { throw new Error("registry writer is busy"); },
  });
  expect(rows()).toHaveLength(1);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "registry writer is busy",
    delivery: "uncertain",
    stop: { boundary: "admission", reason: "outcome-unknown" },
  });
  /* The registry decides the verdict; the stop only explains it. */
  expect(await lookup(body.conversationId, body.idempotencyKey)).toMatchObject({
    outcome: "not-executed",
    stop: { boundary: "admission", reason: "outcome-unknown", status: 503 },
  });
});

test("a key that never reached the route answers not-executed with no stop: the transport-loss case", async () => {
  expect(await lookup("conversation_direct", "never-arrived")).toEqual({
    outcome: "not-executed", conversationId: "conversation_direct", clientMessageId: "never-arrived",
  });
});
