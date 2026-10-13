import { expect, test } from "bun:test";
import { lookupRuntimeAdmission, type RuntimeAdmissionLookup } from "./useRuntime";
import { observeRuntimeAdmission } from "./runtimeAdmissionObservation";

test("automatic observation and retry share a read until its last view releases it", async () => {
  let calls = 0, release!: (answer: RuntimeAdmissionLookup) => void;
  let transportSignal: AbortSignal | undefined;
  const lookup = async (_conversation: string, _key: string, signal?: AbortSignal) => {
    calls += 1; transportSignal = signal;
    return new Promise<RuntimeAdmissionLookup>(resolve => { release = resolve; });
  };
  const automatic = new AbortController(), retry = new AbortController();
  const first = observeRuntimeAdmission("conversation-share", "message-share", lookup, automatic.signal);
  const second = observeRuntimeAdmission("conversation-share", "message-share", lookup, retry.signal);
  await Promise.resolve();
  expect(calls).toBe(1);
  automatic.abort();
  expect(await first).toEqual({ outcome: "unknown" });
  expect(transportSignal!.aborted).toBe(false);
  release({ outcome: "admitted", operationId: "operation-share" });
  expect(await second).toEqual({ outcome: "admitted", operationId: "operation-share" });
});

test("a cancelled read that ignores abort cannot be joined on visibility recovery", async () => {
  const owner = new AbortController();
  let calls = 0;
  const lookup = async (): Promise<RuntimeAdmissionLookup> => {
    calls += 1;
    return calls === 1 ? new Promise(() => {}) : { outcome: "not-executed" };
  };
  const first = observeRuntimeAdmission("conversation-cancel", "message-cancel", lookup, owner.signal);
  await Promise.resolve(); owner.abort();
  expect(await first).toEqual({ outcome: "unknown" });
  expect(await observeRuntimeAdmission("conversation-cancel", "message-cancel", lookup)).toEqual({ outcome: "not-executed" });
  expect(calls).toBe(2);
});

test.each(["conversation", "key", "operation", "kind"])("admission evidence rejects a foreign %s", async mismatch => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ outcome: "admitted", operationId: "operation-original", receipt: {
    conversationId: mismatch === "conversation" ? "conversation-other" : "conversation-original",
    idempotencyKey: mismatch === "key" ? "key-other" : "key-original",
    operationId: mismatch === "operation" ? "operation-other" : "operation-original",
    kind: mismatch === "kind" ? "interrupt" : "send", status: "delivered", revision: 3, at: new Date().toISOString(),
  } })) as unknown as typeof fetch;
  try { expect(await lookupRuntimeAdmission("conversation-original", "key-original")).toEqual({ outcome: "unknown" }); }
  finally { globalThis.fetch = previous; }
});

test("the admission HTTP read carries cancellation and a finite timeout", async () => {
  const previous = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input, init) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }) as typeof fetch;
  const owner = new AbortController();
  try {
    const answer = lookupRuntimeAdmission("conversation-bounded", "key-bounded", owner.signal);
    expect(signal).toBeInstanceOf(AbortSignal);
    owner.abort();
    expect(await answer).toEqual({ outcome: "unknown" });
    expect(signal!.aborted).toBe(true);
  } finally { globalThis.fetch = previous; }
});
