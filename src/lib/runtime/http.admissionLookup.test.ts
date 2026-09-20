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
import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { handleRuntimeAdmissionQuery, type RuntimeAdmissionQueryDependencies } from "./http";
import type { AgentRegistry } from "@/lib/agent/registry";

const conversationId = "conversation_lookup-fixture";

function lookupRequest(query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/runtime/send?${query}`, {
    method: "GET",
    headers: { host: "127.0.0.1" },
  });
}

function dependencies(
  admission: ReturnType<AgentRegistry["deliveryAdmissionForKey"]> | (() => never),
  queryBody: Record<string, unknown> = {},
): RuntimeAdmissionQueryDependencies {
  return {
    enabled: () => true,
    registry: () => ({
      deliveryAdmissionForKey: typeof admission === "function" ? admission : () => admission,
    }) as unknown as AgentRegistry,
    query: async () => new Response(JSON.stringify(queryBody), { status: 200 }) as never,
  };
}

test("a key the journal admitted answers `admitted`, with its operation id", async () => {
  const response = await handleRuntimeAdmissionQuery(
    lookupRequest(`conversationId=${conversationId}&clientMessageId=lost-response-1`),
    dependencies(
      { operationId: "op-admitted", deliveryId: "delivery-1", state: "held" },
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
    dependencies({ operationId: "op-unsettled", deliveryId: "delivery-2", state: null }, { error: "operation not found" }),
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
    dependencies(null),
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
  const counting = dependencies(null);
  counting.registry = () => ({ deliveryAdmissionForKey: () => { reads += 1; return null; } }) as unknown as AgentRegistry;

  expect((await handleRuntimeAdmissionQuery(lookupRequest("conversationId=not-a-conversation&clientMessageId=k"), counting)).status).toBe(400);
  expect((await handleRuntimeAdmissionQuery(lookupRequest(`conversationId=${conversationId}&clientMessageId=%20`), counting)).status).toBe(400);
  expect(reads).toBe(0);
});
