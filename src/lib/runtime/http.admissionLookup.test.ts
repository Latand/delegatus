/**
 * THE READ HALF OF THE SEND KEY.
 *
 * A browser whose `POST /api/runtime/send` response never arrived knows only
 * that it asked. The message may be durably admitted and on its way, or it may
 * never have been journaled — and finding out by posting the send again is the
 * duplicate the delivery contract forbids. `GET /api/runtime/send` answers the
 * question instead, under the ORIGINAL key, and these cases hold it to the
 * three answers a caller must be able to tell apart.
 *
 * Read through the production handler, so what is asserted is what a browser
 * receives.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { admissionInFlight, handleRuntimeAdmissionQuery, handleRuntimeCommand, type RuntimeAdmissionQueryDependencies } from "./http";
import { AgentRegistry, type DeliveryAdmissionEvidence } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-admission-lookup-"));
let registryNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const conversationId = "conversation_lookup-fixture";

function lookupRequest(query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/runtime/send?${query}`, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
}

function dependencies(
  admission: DeliveryAdmissionEvidence | (() => never),
  queryBody: Record<string, unknown> = {},
): RuntimeAdmissionQueryDependencies {
  return {
    enabled: () => true,
    registry: () => ({
      deliveryAdmissionForKey: typeof admission === "function" ? admission : () => admission,
    }) as unknown as AgentRegistry,
    query: async () => new Response(JSON.stringify(queryBody), { status: 200 }) as never,
    /* Nothing of this process's own is in flight in these cases; the race is
       its own test below, against the real claim. */
    sendInFlight: () => false,
  };
}

test("a key the journal admitted answers `admitted`, with its operation id", async () => {
  const response = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${conversationId}&clientMessageId=lost-response-1`),
    dependencies(
      { outcome: "admitted", operationId: "op-admitted", deliveryId: "delivery-1", state: "held" },
      { receipt: { operationId: "op-admitted", idempotencyKey: "lost-response-1", conversationId, kind: "send", status: "queued", at: "2026-09-20T00:00:00.000Z", revision: 1 } },
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    outcome: "admitted",
    operationId: "op-admitted",
    state: "held",
    receipt: { status: "queued", idempotencyKey: "lost-response-1" },
  });
});

test("an admitted key whose fate cannot be settled is STILL admitted, and forbids a resend", async () => {
  /* Whether the message arrived is a different question from whether it
     exists. An operation query with nothing to say must not downgrade proven
     admission into an unknown that a caller may then send again. */
  const response = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${conversationId}&clientMessageId=lost-response-2`),
    dependencies({ outcome: "admitted", operationId: "op-unsettled", deliveryId: "delivery-2", state: null }, { error: "operation not found" }),
  );
  const body = await response.json() as Record<string, unknown>;
  expect(body.outcome).toBe("admitted");
  expect(body.operationId).toBe("op-unsettled");
  expect(body.receipt).toBeUndefined();
});

test("a key the registry holds nothing for answers `not-executed`", async () => {
  /* The affirmative one: admission writes its reservation before anything
     reaches a host, and the operation owner outlives the reservation, so a
     message that ever started left one of the two behind. */
  const response = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${conversationId}&clientMessageId=never-admitted`),
    dependencies({ outcome: "not-executed" }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "not-executed", clientMessageId: "never-admitted" });
});

test("a registry that cannot be read answers `unknown`, never `not-executed`", async () => {
  /* Absence that was never observed is not evidence of absence. Reading an
     unreadable record as "never sent" is exactly how a delivered message gets
     sent a second time. */
  const response = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${conversationId}&clientMessageId=unreadable`),
    dependencies(() => { throw new Error("registry file is locked"); }),
  );
  /* 200, deliberately: the request succeeded, the QUESTION has no answer yet.
     A 503 reads as a failed lookup a client converts into a failure. */
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(body.outcome).toBe("unknown");
  expect(body.reason).toBeTruthy();
});

test("the lookup refuses a malformed key or conversation before reading anything", async () => {
  let reads = 0;
  const counting = dependencies({ outcome: "not-executed" });
  counting.registry = () => ({
    deliveryAdmissionForKey: () => { reads += 1; return { outcome: "not-executed" as const }; },
  }) as unknown as AgentRegistry;

  expect((await handleRuntimeAdmissionQuery(lookupRequest("conversationId=not-a-conversation&clientMessageId=k"), counting)).status).toBe(400);
  expect((await handleRuntimeAdmissionQuery(lookupRequest(`conversationId=${conversationId}&clientMessageId=%20`), counting)).status).toBe(400);
  expect(reads).toBe(0);
});

const artifactPath = "/sessions/33333333-3333-\x34333-8333-333333333333.jsonl";

function conversationRegistry(): { registry: AgentRegistry; conversationId: string } {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);
  return { registry, conversationId: registry.conversationForPath(artifactPath)!.id };
}

/** The lookup as the route wires it: this registry, and the process's own
    in-flight claim rather than a stub that always says "nothing is running". */
function liveDependencies(registry: AgentRegistry): RuntimeAdmissionQueryDependencies {
  return {
    enabled: () => true,
    registry: () => registry,
    query: async () => new Response(JSON.stringify({}), { status: 200 }) as never,
    sendInFlight: (conversation, key) => admissionInFlight(conversation, key),
  };
}

function sendRequest(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A DELIVERED MESSAGE WHOSE EVIDENCE WAS COMPACTED IS NOT A MESSAGE THAT NEVER
 * WENT.
 *
 * Both records that prove admission are bounded: terminal operation owners are
 * kept to the newest 200 per conversation, delivered reservations to the newest
 * 100. Past that boundary a message that was delivered reads exactly like one
 * that was never journaled — and the answer used to be `not-executed`, which
 * authorizes the browser's Retry. A busy conversation could therefore send the
 * operator's message twice.
 *
 * Driven against the real registry, with the real compaction, so what is
 * asserted is the production retention rule rather than a story about it.
 */
test("a delivered key whose evidence has been compacted answers `unknown`, never `not-executed`", async () => {
  const { registry, conversationId: liveConversationId } = conversationRegistry();
  const original = registry.holdDelivery(liveConversationId as never, "the message that was delivered", "compacted-key", "text", [], null, {});
  registry.recordDeliveryOutcome(original.id, "delivered", null, "delivered");
  /* While the evidence is retained the answer is the strong one. */
  expect(registry.deliveryAdmissionForKey(liveConversationId, "compacted-key")).toMatchObject({
    outcome: "admitted",
    operationId: original.command.operationId,
  });

  /* 201 later deliveries push the original past the owner retention bound. */
  for (let index = 0; index < 201; index += 1) {
    const later = registry.holdDelivery(liveConversationId as never, `later message ${index}`, `later-${index}`, "text", [], null, {});
    registry.recordDeliveryOutcome(later.id, "delivered", null, "delivered");
  }
  expect(registry.deliveryAdmissionForKey(liveConversationId, "compacted-key")).toMatchObject({ outcome: "unknown" });

  const response = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${liveConversationId}&clientMessageId=compacted-key`),
    liveDependencies(registry),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  /* `unknown` is what the browser must hear: ask again, keep the bytes, and
     never POST this key a second time. */
  expect(body.outcome).toBe("unknown");
  expect(body.reason).toBeTruthy();

  /* The retention boundary moved, not the truth: the newest key is still
     answered from its own retained row. */
  const recent = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${liveConversationId}&clientMessageId=later-200`),
    liveDependencies(registry),
  );
  expect((await recent.json() as Record<string, unknown>).outcome).toBe("admitted");
});

/**
 * A LOOKUP THAT ARRIVES MID-ADMISSION IS NOT LOOKING AT A FINISHED RECORD.
 *
 * The reservation is written DURING the POST, not when it arrives. A browser
 * that gave up on its response and asked instead can land inside that window,
 * read a registry with nothing under the key, and — on the record alone — be
 * told the message never went, while the very request it is asking about is
 * still admitting it. The claim taken by the POST closes that window, and this
 * case holds both readings side by side at the same instant.
 */
test("a lookup racing an unfinished send under the same key answers `unknown`, and the send it raced still lands once", async () => {
  const { registry, conversationId: liveConversationId } = conversationRegistry();
  let duringSend: Record<string, unknown> | undefined;
  let duringSendWithoutTheClaim: Record<string, unknown> | undefined;

  const response = await handleRuntimeCommand(sendRequest({
    conversationId: liveConversationId,
    text: "the message whose response was lost",
    idempotencyKey: "raced-key",
  }), "send", {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    enqueue: async (input) => {
      /* Mid-admission: the POST has been accepted, nothing durable exists yet. */
      duringSend = await (await handleRuntimeAdmissionQuery(
        lookupRequest(`conversationId=${liveConversationId}&clientMessageId=raced-key`),
        liveDependencies(registry),
      )).json() as Record<string, unknown>;
      /* The same instant, read from the record alone — the answer that
         authorized a duplicate POST. */
      duringSendWithoutTheClaim = await (await handleRuntimeAdmissionQuery(
        lookupRequest(`conversationId=${liveConversationId}&clientMessageId=raced-key`),
        { ...liveDependencies(registry), sendInFlight: () => false },
      )).json() as Record<string, unknown>;
      const held = registry.holdDelivery(
        liveConversationId as never,
        input.text,
        input.clientMessageId ?? null,
        "text",
        [],
        null,
        {},
      );
      return {
        ok: true,
        structured: true,
        target: liveConversationId,
        outcome: "held",
        operationId: held.command.operationId,
      } as never;
    },
  });

  expect(response.status).toBe(202);
  expect(duringSend).toMatchObject({ outcome: "unknown" });
  expect(duringSendWithoutTheClaim).toMatchObject({ outcome: "not-executed" });

  /* The request answered, so the record may be read: one reservation, holding
     the original key and the original text, and the lookup now proves it. */
  const settled = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${liveConversationId}&clientMessageId=raced-key`),
    liveDependencies(registry),
  );
  const settledBody = await settled.json() as Record<string, unknown>;
  expect(settledBody.outcome).toBe("admitted");
  const pending = registry.pendingDeliveries(liveConversationId as never);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ clientMessageId: "raced-key", text: "the message whose response was lost" });
  expect(settledBody.operationId).toBe(pending[0]!.command.operationId);
});
