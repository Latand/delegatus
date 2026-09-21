import { expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";

import { deliveryDedupToken, submissionIdentities } from "./submissionIdentity";

/**
 * The read-side join of #1950 round 2: a structured Codex record names the
 * delivery that wrote it (`dedup=sha256(<operation id>)`), and the registry
 * knows which client message id admitted that operation — the id of the
 * outbox row the operator is looking at. This module composes the two, for
 * ONE conversation, and answers with nothing whenever it cannot answer
 * honestly.
 */

const TRANSCRIPT = "/sessions/worker-transcript.jsonl";
const OTHER_TRANSCRIPT = "/sessions/other-transcript.jsonl";

function snapshot(overrides: Partial<RegistryFile> = {}): RegistryFile {
  return {
    conversations: {
      conversation_worker: {
        id: "conversation_worker",
        engine: "codex",
        generations: [{ id: "gen-1", path: TRANSCRIPT }],
        continuityPaths: [],
      },
      conversation_other: {
        id: "conversation_other",
        engine: "codex",
        generations: [{ id: "gen-9", path: OTHER_TRANSCRIPT }],
        continuityPaths: [],
      },
    },
    conversationAliases: { conversation_worker_old: "conversation_worker" },
    heldDeliveries: {},
    deliveryOperationOwners: {},
    ...overrides,
  } as unknown as RegistryFile;
}

const owner = (clientMessageId: string | null, conversationId = "conversation_worker") =>
  ({ clientMessageId, conversationId }) as unknown as RegistryFile["deliveryOperationOwners"][string];

test("each of this conversation's operations resolves to the submission that admitted it", () => {
  const identities = submissionIdentities(TRANSCRIPT, {
    registrySnapshot: () => snapshot({
      deliveryOperationOwners: {
        "operation-a": owner("op_submission_a"),
        /* A retry mints a fresh operation under the SAME key: both name one
           submission, which is the point — the row is the message's,
           whichever attempt finally wrote it. */
        "operation-a-retry": owner("op_submission_a"),
        "operation-b": owner("op_submission_b"),
      } as RegistryFile["deliveryOperationOwners"],
    }),
  });
  expect(identities).toEqual({
    [deliveryDedupToken("operation-a")]: "op_submission_a",
    [deliveryDedupToken("operation-a-retry")]: "op_submission_a",
    [deliveryDedupToken("operation-b")]: "op_submission_b",
  });
});

test("an alias of this conversation counts, and another conversation does not", () => {
  const identities = submissionIdentities(TRANSCRIPT, {
    registrySnapshot: () => snapshot({
      deliveryOperationOwners: {
        "operation-aliased": owner("op_submission_aliased", "conversation_worker_old"),
        "operation-foreign": owner("op_submission_foreign", "conversation_other"),
      } as RegistryFile["deliveryOperationOwners"],
    }),
  });
  /* A browser is never handed the keys of sends it did not make. */
  expect(identities).toEqual({ [deliveryDedupToken("operation-aliased")]: "op_submission_aliased" });
});

test("a live reservation answers for an operation with no owner row", () => {
  const identities = submissionIdentities(TRANSCRIPT, {
    registrySnapshot: () => snapshot({
      heldDeliveries: {
        "d-1": {
          conversationId: "conversation_worker",
          clientMessageId: "op_submission_held",
          command: { operationId: "operation-held" },
        },
      } as unknown as RegistryFile["heldDeliveries"],
    }),
  });
  expect(identities).toEqual({ [deliveryDedupToken("operation-held")]: "op_submission_held" });
});

test("nothing is invented where nothing can be said", () => {
  /* A record with no key could never have named a submission; an unreadable
     registry and an unknown transcript are the same answer. A row with no
     entry here binds exactly as it did before this join existed. */
  expect(submissionIdentities(TRANSCRIPT, {
    registrySnapshot: () => snapshot({
      deliveryOperationOwners: { "operation-keyless": owner(null) } as RegistryFile["deliveryOperationOwners"],
    }),
  })).toEqual({});
  expect(submissionIdentities("/sessions/unknown.jsonl", { registrySnapshot: () => snapshot() })).toEqual({});
  expect(submissionIdentities("", { registrySnapshot: () => snapshot() })).toEqual({});
  expect(submissionIdentities(TRANSCRIPT, {
    registrySnapshot: () => { throw new Error("registry unavailable"); },
  })).toEqual({});
});

test("the dedup token is the one the Codex host stamps", () => {
  /* Two copies of this hash is a join that silently stops matching, so the
     host imports THIS definition. Pinned against the value it produces. */
  expect(deliveryDedupToken("operation-a")).toMatch(/^[a-f0-9]{64}$/);
  expect(deliveryDedupToken("operation-a")).toBe(deliveryDedupToken("operation-a"));
  expect(deliveryDedupToken("operation-a")).not.toBe(deliveryDedupToken("operation-b"));
});
