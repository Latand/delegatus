import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { recordOperatorRequest, readRequests } from "@/lib/activity/requestLedger";
import type { RegistryFile } from "@/lib/agent/registry";
import { internalServiceHeaders, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

import { handleRuntimeCommand, type RuntimeHttpDependencies } from "./http";

/* The activity ledger at the structured send ingress: the operator's own send
   is one row, an agent or a Viewer service writes none, and a ledger that
   cannot be written never refuses the send. */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "http-activity-ledger-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
let ledgerDir: string;
let reports: string[];

/** A Viewer page's request, which a browser stamps with `sec-fetch-site`;
    `browser: false` is a script's, which carries none. */
function request(body: unknown, headers: Record<string, string> = {}, browser = true): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", "user-agent": PHONE, ...(browser ? { "sec-fetch-site": "same-origin" } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

function dependencies(enqueued: unknown[]): RuntimeHttpDependencies {
  return {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    recordOperatorActivity: () => null,
    recordOperatorRequest: (req, input) => recordOperatorRequest(req, input, {
      dir: () => ledgerDir,
      registrySnapshot: () => ({ conversations: {} }) as unknown as RegistryFile,
      report: (event, fields) => reports.push(`${event}:${String(fields.outcome)}`),
    }),
    enqueue: async (input) => {
      enqueued.push(input);
      return { ok: false, status: 409, error: "fixture host refused" } as never;
    },
    retireReplySuggestions: () => ({ cleared: false, pending: false }),
  };
}

const rows = () => readRequests(0, Date.now() + 60_000, { dir: () => ledgerDir }).rows.map(({ at, project, surface, kind }) => ({ at, project, surface, kind }));

beforeEach(() => {
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
    { authorization: "Bearer fixture-token" },
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
