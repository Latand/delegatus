import { expect, test } from "bun:test";

import { kickStructuredDeliveryQueue, requestStructuredDeliveryQueue, setStructuredDeliveryKick } from "./structuredDeliverySignal";

test("route bundle realms observe the process-owned delivery kick", async () => {
  let calls = 0;
  setStructuredDeliveryKick(() => { calls += 1; });
  try {
    delete (globalThis as typeof globalThis & { __llvStructuredDeliveryKick?: unknown })
      .__llvStructuredDeliveryKick;
    await kickStructuredDeliveryQueue();
    expect(calls).toBe(1);
  } finally {
    setStructuredDeliveryKick(null);
  }
});

test("a requested wake waits only for its owner's guard and replacement clears that guard", async () => {
  let release!: () => void;
  const guard = new Promise<void>(resolve => { release = resolve; });
  let guarded = 0, drains = 0, replacement = 0;
  setStructuredDeliveryKick(() => { drains++; }, async () => { await guard; guarded++; });
  const requested = requestStructuredDeliveryQueue();
  try {
    expect(guarded).toBe(0);
    expect(drains).toBe(0);
    release(); await requested;
    expect(guarded).toBe(1);
    setStructuredDeliveryKick(() => { replacement++; });
    await requestStructuredDeliveryQueue();
    expect(guarded).toBe(1);
    expect(replacement).toBe(1);
    setStructuredDeliveryKick(null);
    await requestStructuredDeliveryQueue();
    expect(replacement).toBe(1);
  } finally { release(); await requested; setStructuredDeliveryKick(null); }
});

test("a guard past its acknowledgement budget retains one owner across requests and late replacement", async () => {
  let release!: () => void, releaseNext!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const next = new Promise<void>(resolve => { releaseNext = resolve; });
  let calls = 0, nextCalls = 0;
  setStructuredDeliveryKick(() => {}, () => { calls++; return held; });
  try {
    const expired = requestStructuredDeliveryQueue(1_000);
    expect(requestStructuredDeliveryQueue(0)).toBe(expired);
    await expired;
    for (let index = 0; index < 128; index++) expect(requestStructuredDeliveryQueue(0)).toBe(expired);
    expect(calls).toBe(1);
    setStructuredDeliveryKick(() => {}, () => { nextCalls++; return next; });
    const replacement = requestStructuredDeliveryQueue();
    await Promise.resolve();
    release(); await held; await Promise.resolve();
    expect(requestStructuredDeliveryQueue()).toBe(replacement);
    expect(nextCalls).toBe(1);
    releaseNext(); await replacement;
  } finally { release(); releaseNext(); await held; await next; setStructuredDeliveryKick(null); }
});
