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
import { afterEach, beforeEach, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { handleRuntimeAdmissionQuery, handleRuntimeCommand, type RuntimeHttpDependencies } from "./http";
import { MAX_STRUCTURED_IMAGES } from "./runtimeImageStore";
import type { AgentRegistry } from "@/lib/agent/registry";
import { ingressStopFor, resetIngressStopsForTests, type IngressStop } from "./ingressStop";

/** A Viewer page's request: a browser stamps `sec-fetch-site` on every fetch. */
function request(body: unknown, headers: Record<string, string> = { host: "127.0.0.1", "sec-fetch-site": "same-origin" }): NextRequest {
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
    that produces it and nothing else. The two answered before the command is
    parsed have no key yet, so they carry no stop. */
const refusals: Array<[string, RuntimeHttpDependencies, string, IngressStop | null]> = [
  ["runtime events disabled",
    { enabled: () => false, structuredEnabled: () => true, client: () => admittingClient },
    "runtime events are disabled", null],
  ["structured hosts disabled",
    { enabled: () => true, structuredEnabled: () => false, client: () => admittingClient },
    "structured hosts are disabled", null],
  ["no structured delivery ownership",
    {
      enabled: () => true,
      structuredEnabled: () => true,
      client: () => admittingClient,
      enqueue: async () => null,
    },
    "structured delivery ownership is unavailable for this conversation", { boundary: "admission", reason: "ownership-unavailable" }],
  ["no runtime host socket",
    { enabled: () => true, structuredEnabled: () => true, client: () => null },
    "runtime host socket is unavailable", { boundary: "dispatch", reason: "host-unavailable" }],
];

beforeEach(() => resetIngressStopsForTests(() => {}));

test.each(refusals)("a send refused before dispatch answers refused with its reason (%s)", async (_name, dependencies, reason, stop) => {
  const response = await handleRuntimeCommand(request(send), "send", dependencies);
  expect(response.status).toBe(503);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toEqual({ error: reason, delivery: "refused", ...(stop ? { stop } : {}) });
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
      stop: { boundary: "intake", reason: "inbox-unavailable" },
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
  const body = await response.json() as Record<string, unknown>;
  expect(body.delivery).toBeUndefined();
  expect(body.stop).toEqual({ boundary: "intake", reason: "command-invalid" });
});

/* 2026-11-09: a keyed send whose image or file was refused answered before the
   route knew its key, so it left no stop and no diagnostic line, and a lost
   refusal read the same as a request that never arrived. */
const PNG = "iVBORw0KGgo=";
const intakeRefusals: Array<[string, Record<string, unknown>, number, IngressStop["reason"]]> = [
  ["an unsupported image type", { images: [{ mime: "image/tiff", base64: "aGVsbG8=" }] }, 415, "image-refused"],
  ["too many images", { images: Array.from({ length: MAX_STRUCTURED_IMAGES + 1 }, () => ({ mime: "image/png", base64: PNG })) }, 413, "image-refused"],
  ["an unreadable image", { images: [{ mime: "image/png", base64: "not base64!" }] }, 400, "image-refused"],
  ["a malformed file", { files: [{ name: "fixture-notes.txt", base64: 7 }] }, 400, "file-refused"],
  ["an empty message", { text: "" }, 400, "command-invalid"],
];

test.each(intakeRefusals)("a keyed send refused at intake for %s keeps its status, logs one stop and is found by the lookup", async (_name, overrides, status, reason) => {
  const lines: Array<[string, Record<string, unknown>]> = [];
  resetIngressStopsForTests((line, fields) => lines.push([line, fields]));
  const key = `intake-${reason}-${status}`;
  const response = await handleRuntimeCommand(request({ ...send, text: "secret intake words", idempotencyKey: key, ...overrides }), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => admittingClient,
    enqueue: async () => { throw new Error("intake refusals never reach admission"); },
  });
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(body.stop).toEqual({ boundary: "intake", reason });
  expect(body.delivery).toBeUndefined();
  expect(lines).toHaveLength(1);
  expect(lines[0]![1]).toEqual({
    conversationId: send.conversationId, clientMessageId: key, kind: "send",
    boundary: "intake", reason, status, delivery: null, ingressAt: expect.any(String), at: expect.any(String),
  });
  expect(JSON.stringify(lines)).not.toContain("secret intake words");
  expect(JSON.stringify(lines)).not.toContain("fixture-notes");
  const lookup = await handleRuntimeAdmissionQuery(new NextRequest(
    `http://127.0.0.1/api/runtime/send?conversationId=${send.conversationId}&clientMessageId=${key}`, { headers: { host: "127.0.0.1" } }), {
    enabled: () => true,
    registry: () => ({ deliveryAdmissionForKey: () => ({ outcome: "not-executed" }) }) as unknown as AgentRegistry,
    query: async () => { throw new Error("nothing was admitted"); },
    sendInFlight: () => false,
  });
  expect(await lookup.json()).toEqual({ outcome: "not-executed", conversationId: send.conversationId, clientMessageId: key,
    stop: { boundary: "intake", reason, status, at: expect.any(String) } });
});

test("an intake refusal without a valid key records no stop", async () => {
  const lines: unknown[] = [];
  resetIngressStopsForTests((...args) => lines.push(args));
  const response = await handleRuntimeCommand(request({ conversationId: send.conversationId, text: "continue", idempotencyKey: "has space",
    images: [{ mime: "image/tiff", base64: "aGVsbG8=" }] }), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => admittingClient,
  });
  expect(response.status).toBe(415);
  expect((await response.json() as Record<string, unknown>).stop).toBeUndefined();
  expect(lines).toEqual([]);
  expect(ingressStopFor(send.conversationId, "has space")).toBeNull();
});

/* 2026-11-09: admission marks the refusals it gives before anything is
   reserved (#2020), and the route forwarded that mark for an injection only. A
   send refused the same way answered a bare 503, which the composer has to
   read as "may have been sent": it parked the message as an unknown instead
   of handing the words back with the reason. */
const refusedAdmission = (overrides: Record<string, unknown> = {}): RuntimeHttpDependencies => ({
  enabled: () => true,
  structuredEnabled: () => true,
  client: () => admittingClient,
  enqueue: async () => ({ ok: false, structured: true, outcome: "failed", status: 503,
    error: "the conversation is synchronizing; try again shortly", admission: "refused", ...overrides }) as never,
});

for (const kind of ["send", "steer"] as const) {
  test(`a ${kind} admission refused before any reservation answers refused, with its stop`, async () => {
    const response = await handleRuntimeCommand(request({ ...send, idempotencyKey: `refused-${kind}` }), kind, refusedAdmission());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "the conversation is synchronizing; try again shortly",
      delivery: "refused",
      stop: { boundary: "admission", reason: "refused-before-reservation" },
    });
    expect(ingressStopFor(send.conversationId, `refused-${kind}`)).toMatchObject({
      kind, boundary: "admission", reason: "refused-before-reservation", status: 503, delivery: "refused",
    });
  });
}

test("a seat refusal keeps its code and successor beside the refused classification", async () => {
  const response = await handleRuntimeCommand(request({ ...send, idempotencyKey: "refused-seat" }), "send", refusedAdmission({
    status: 409, error: "seat was replaced", code: "seat-replaced", successorConversationId: "conversation_successor",
  }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "seat was replaced", delivery: "refused", code: "seat-replaced", successorConversationId: "conversation_successor",
    stop: { boundary: "admission", reason: "refused-before-reservation" },
  });
});

test("an admission failure after its reservation is never called refused", async () => {
  const receipt = { operationId: "operation-reserved", idempotencyKey: "reserved-failure", conversationId: send.conversationId,
    kind: "send" as const, status: "failed" as const, at: "2026-11-09T00:00:00.000Z", revision: 2 };
  const response = await handleRuntimeCommand(request({ ...send, idempotencyKey: "reserved-failure" }), "send", {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => admittingClient,
    enqueue: async () => ({ ok: false, structured: true, outcome: "failed", status: 503,
      error: "the runtime journal did not acknowledge the admission", operationId: "operation-reserved", receipt }) as never,
  });
  const body = await response.json() as Record<string, unknown>;
  expect(body.delivery).toBeUndefined();
  expect(body).toMatchObject({ operationId: "operation-reserved", stop: { boundary: "admission", reason: "failed-after-reservation" } });
});

test("an admitted retry under a stopped key forgets the earlier stop", async () => {
  await handleRuntimeCommand(request({ ...send, idempotencyKey: "stop-then-admit" }), "send", refusedAdmission());
  expect(ingressStopFor(send.conversationId, "stop-then-admit")).not.toBeNull();
  const admitted = await handleRuntimeCommand(request({ ...send, idempotencyKey: "stop-then-admit" }), "send", {
    enabled: () => true, structuredEnabled: () => true, client: () => admittingClient,
  });
  expect(admitted.status).toBe(202);
  expect(((await admitted.json()) as Record<string, unknown>).stop).toBeUndefined();
  expect(ingressStopFor(send.conversationId, "stop-then-admit")).toBeNull();
});

test("the stop log line carries codes and ids, never the message text", async () => {
  const lines: Array<[string, Record<string, unknown>]> = [];
  resetIngressStopsForTests((line, fields) => lines.push([line, fields]));
  await handleRuntimeCommand(request({ ...send, text: "secret words stay out", idempotencyKey: "logged-stop" }), "send", refusedAdmission());
  expect(lines).toHaveLength(1);
  expect(lines[0]![1]).toEqual({
    conversationId: send.conversationId, clientMessageId: "logged-stop", kind: "send",
    boundary: "admission", reason: "refused-before-reservation", status: 503, delivery: "refused",
    ingressAt: expect.any(String), at: expect.any(String),
  });
  expect(JSON.stringify(lines)).not.toContain("secret words");
});
