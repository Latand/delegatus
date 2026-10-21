import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { runtimeReceiptForSend } from "@/lib/runtime/sendSettlement";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";

import { ComposerSubmissionPayloads, type ComposerPayloadReceipt } from "./composerSubmissionPayloads";

const dom = new Window();
Object.assign(globalThis, { window: dom, navigator: dom.navigator });
const storage = installComposerStorageForTests();
afterAll(() => storage.uninstall());
afterEach(() => storage.reset());

const CONVERSATION = "conversation_payload_outcome";
const KEY = "client-key-outcome";
const OPERATION = "operation-outcome";

function journal(revision: number, status: string, over: Partial<ComposerPayloadReceipt> = {}): ComposerPayloadReceipt {
  return { conversationId: CONVERSATION, idempotencyKey: KEY, operationId: OPERATION, revision, status,
    at: "2026-09-28T10:00:00.000Z", ...over };
}

/** The delivery record's answer, as the operation query hands it out: its own
    revision counter, which starts at 1 whatever the journal reached. */
function recordOutcome(state: "delivered" | "failed", reason: string | null = null, operationId = OPERATION): ComposerPayloadReceipt {
  return runtimeReceiptForSend({ operationId, conversationId: CONVERSATION, clientMessageId: KEY, kind: "send", state, reason,
    acceptedAt: "2026-09-28T10:00:00.000Z", settledAt: "2026-09-28T10:05:00.000Z", duplicateRisk: false,
    resend: "not-needed", evidence: "delivery-record" }) as ComposerPayloadReceipt;
}

async function admitted(payloads: ComposerSubmissionPayloads) {
  const ref = await payloads.retain({ conversationId: CONVERSATION, key: KEY }, { text: "ship it", images: [], files: [] });
  await payloads.seal(ref, { route: "runtime", body: { conversationId: CONVERSATION, idempotencyKey: KEY, text: "ship it" } });
  expect(await payloads.beginAttempt(ref)).toBe(true);
  expect(await payloads.observe(ref, journal(1, "queued"))).toBe(true);
  expect(await payloads.observe(ref, journal(3, "delivering"))).toBe(true);
  return ref;
}

test.each([
  ["delivered", recordOutcome("delivered")],
  ["discarded", recordOutcome("failed", "delivery-discarded")],
] as const)("the admitted operation's %s outcome settles the payload past a higher open journal revision", async (_, outcome) => {
  const payloads = new ComposerSubmissionPayloads("llv-composer-outcome");
  const ref = await admitted(payloads);
  expect(outcome.revision).toBe(1);

  expect(await payloads.observe(ref, outcome)).toBe(true);
  const current = (await payloads.restore(ref))!.receipt!;
  expect(current).toMatchObject({ operationId: OPERATION, status: outcome.status, revision: 1 });
  /* A second copy of the same answer adds nothing. */
  expect(await payloads.observe(ref, outcome)).toBe(false);
  expect(await payloads.settle(ref, current)).toBe(true);
  expect(await payloads.restore(ref)).toBeNull();
});

test("the outcome stays the answer when a lower open journal revision arrives after it", async () => {
  const payloads = new ComposerSubmissionPayloads("llv-composer-outcome-first");
  const ref = await payloads.retain({ conversationId: CONVERSATION, key: KEY }, { text: "ship it", images: [], files: [] });
  await payloads.seal(ref, { route: "runtime", body: { conversationId: CONVERSATION, idempotencyKey: KEY, text: "ship it" } });
  expect(await payloads.beginAttempt(ref)).toBe(true);
  expect(await payloads.observe(ref, recordOutcome("delivered"))).toBe(true);
  expect(await payloads.observe(ref, journal(3, "delivering"))).toBe(true);
  const current = (await payloads.restore(ref))!.receipt!;
  expect(current).toMatchObject({ status: "delivered", revision: 1 });
  expect(await payloads.settle(ref, current)).toBe(true);
});

test("a lower revision that does not end the message, or names another operation, is still refused", async () => {
  const payloads = new ComposerSubmissionPayloads("llv-composer-outcome-fence");
  const ref = await admitted(payloads);

  expect(await payloads.observe(ref, recordOutcome("failed", "connection lost"))).toBe(false);
  expect(await payloads.observe(ref, journal(2, "queued"))).toBe(false);
  expect(await payloads.observe(ref, recordOutcome("delivered", null, "operation-foreign"))).toBe(false);
  const current = (await payloads.restore(ref))!.receipt!;
  expect(current).toMatchObject({ status: "delivering", revision: 3 });
  expect(await payloads.settle(ref, current)).toBe(false);
  expect(await payloads.restore(ref)).not.toBeNull();
});


test("a completed upload reference survives recovery and cannot be omitted from the sealed command", async () => {
  const payloads = new ComposerSubmissionPayloads("llv-composer-streamed-upload");
  const upload = { id: "a".repeat(32), bytes: 100 * 1024 * 1024, sha256: "b".repeat(64) };
  const files = [{ id: "recording", name: "recording.ogg", mime: "audio/ogg", base64: "", upload }];
  const ref = await payloads.retain({ conversationId: CONVERSATION, key: "streamed-upload" }, { text: "inspect", images: [], files });
  await expect(payloads.seal(ref, { route: "runtime", body: {
    conversationId: CONVERSATION, idempotencyKey: "streamed-upload", text: "inspect",
    files: [{ name: "recording.ogg", base64: "" }],
  } })).rejects.toThrow("missing original attachment");
  await payloads.seal(ref, { route: "runtime", body: {
    conversationId: CONVERSATION, idempotencyKey: "streamed-upload", text: "inspect", files,
  } });
  const recovered = new ComposerSubmissionPayloads("llv-composer-streamed-upload");
  expect((await recovered.restore(ref))?.submission.files[0]?.upload).toEqual(upload);
});
