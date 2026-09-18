/**
 * The send route publishes its own three-valued delivery classification (#1593).
 *
 * All five exits above the delivery attempt answer 503, and so does the one
 * trailing `catch` where the command may already be on the wire. Byte-identical
 * on the wire, they are opposite facts: the five are proofs of absence — no
 * journal row, no operation id, nothing handed to a host — while the catch is
 * the Viewer saying it cannot tell. Read through the production handler, so
 * what these cases assert is what a browser receives.
 */
import { afterEach, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { handleRuntimeCommand, type RuntimeHttpDependencies } from "./http";

function request(body: unknown, headers: Record<string, string> = { host: "127.0.0.1" }): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const send = { conversationId: "conversation_fixture", text: "continue", idempotencyKey: "send-fixture" };

const admittingClient = {
  command: async () => ({
    operationId: "operation-fixture",
    replayed: false,
    receipt: {
      operationId: "operation-fixture",
      idempotencyKey: send.idempotencyKey,
      conversationId: send.conversationId,
      kind: "send" as const,
      status: "pending" as const,
      at: "2026-09-18T00:00:00.000Z",
      revision: 1,
    },
  }),
} as unknown as RuntimeHostClient;

/** The route's five pre-enqueue refusals, each reached through the dependency
    that produces it and nothing else. */
const refusals: Array<[string, RuntimeHttpDependencies, string]> = [
  ["runtime events disabled",
    { enabled: () => false, structuredEnabled: () => true, client: () => admittingClient },
    "runtime events are disabled"],
  ["structured hosts disabled",
    { enabled: () => true, structuredEnabled: () => false, client: () => admittingClient },
    "structured hosts are disabled"],
  ["operator activity not recordable",
    {
      enabled: () => true,
      structuredEnabled: () => true,
      client: () => admittingClient,
      recordOperatorActivity: () => { throw new Error("activity store unavailable"); },
    },
    "direct operator activity could not be recorded"],
  ["no structured delivery ownership",
    {
      enabled: () => true,
      structuredEnabled: () => true,
      client: () => admittingClient,
      enqueue: async () => null,
    },
    "structured delivery ownership is unavailable for this conversation"],
  ["no runtime host socket",
    { enabled: () => true, structuredEnabled: () => true, client: () => null },
    "runtime host socket is unavailable"],
];

test.each(refusals)("a send refused before dispatch answers refused with its reason (%s)", async (_name, dependencies, reason) => {
  const response = await handleRuntimeCommand(request(send), "send", dependencies);
  expect(response.status).toBe(503);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toEqual({ error: reason, delivery: "refused" });
  /* Nothing was admitted, so nothing may name an identity the caller could
     mistake for one — and the reason is the whole sentence the operator reads,
     so it carries no path, no id and no account. */
  expect(body.operationId).toBeUndefined();
  expect(body.receipt).toBeUndefined();
  expect(reason).not.toMatch(/[/\\]|conversation_|operation-/);
  expect(reason.length).toBeLessThan(80);
});

test("the one 503 that may already be on the wire stays uncertain, and so does an idempotency conflict", async () => {
  const dead = { command: async () => { throw new Error("host write failed"); } } as unknown as RuntimeHostClient;
  const uncertain = await handleRuntimeCommand(request(send), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => dead,
  });
  expect(uncertain.status).toBe(503);
  expect(await uncertain.json()).toMatchObject({ delivery: "uncertain" });

  const conflicting = {
    command: async () => { throw new RuntimeHostUnavailableError("conflict", "idempotency-conflict"); },
  } as unknown as RuntimeHostClient;
  const conflict = await handleRuntimeCommand(request(send), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => conflicting,
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ delivery: "uncertain" });
});

test("an admitted send is not classified as refused", async () => {
  const response = await handleRuntimeCommand(request(send), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => admittingClient,
  });
  expect(response.status).toBe(202);
  const body = await response.json() as Record<string, unknown>;
  expect(body.delivery).toBeUndefined();
  expect(body).toMatchObject({ operationId: "operation-fixture", receipt: { status: "pending" } });
});

/** An isolated config root whose inbox cannot be written: `<root>/inbox/files`
    is a FILE, so staging a batch under it fails with ENOTDIR — a real inbox
    failure that is not a batch conflict, reached with nothing mocked. The
    migration sentinel is written first so resolving the inbox never reads the
    operator's own directories. */
function unwritableInboxRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-refused-inbox-"));
  const inbox = path.join(root, "agent-log-viewer", "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, ".migrated-from-legacy"), "test\n");
  fs.writeFileSync(path.join(inbox, "files"), "not a directory\n");
  return root;
}

const configHome = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = configHome;
});

test("a send whose attachments cannot be saved to the inbox is refused, not left unclassified", async () => {
  const root = unwritableInboxRoot();
  process.env.XDG_CONFIG_HOME = root;
  try {
    const response = await handleRuntimeCommand(request({
      ...send,
      idempotencyKey: "send-fixture-attachment",
      files: [{ name: "notes.txt", base64: Buffer.from("attachment bytes").toString("base64") }],
    }), "send", { enabled: () => true, structuredEnabled: () => true, client: () => admittingClient });
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    /* The sixth exit of the same shape as the five: nothing journaled, no
       operation minted, nothing on any wire. It keeps `retryable`, which says
       the operator may try again — never that something went out. */
    expect(body).toEqual({
      error: "the attachments could not be saved to the inbox",
      retryable: true,
      delivery: "refused",
    });
    expect(body.operationId).toBeUndefined();
    expect(body.receipt).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a validation refusal keeps its own status and is not dressed as a delivery classification", async () => {
  const response = await handleRuntimeCommand(request({ ...send, text: "" }), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => admittingClient,
  });
  expect(response.status).toBe(400);
  expect((await response.json() as Record<string, unknown>).delivery).toBeUndefined();
});
