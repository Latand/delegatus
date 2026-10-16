import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { DeliveryEffectPages } from "./deliveryEffectPages";
import { RuntimeHostUnavailableError, type RuntimeHostClient, type RuntimeEffectPage } from "./client";
import type { RuntimePendingEffect } from "./contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
const effect: RuntimePendingEffect = { id: "effect:one", kind: "runtime.send", eventSeq: 1, payload: { kind: "send", operationId: "one", conversationId: "conversation-a", text: "message", policy: "queue" } };
function fixture() {
  let now = 0, retries = 0;
  let answer: RuntimeEffectPage | Error = { version: "generation-1:1", effects: [effect] };
  const known: Array<string | undefined> = [];
  const client = { effectPage: async (_kinds: unknown, _after: unknown, version?: string) => { known.push(version); if (answer instanceof Error) throw answer; return answer; } } as RuntimeHostClient;
  const cache = new DeliveryEffectPages(client, () => { retries++; }, () => now);
  return { cache, known, retries: () => retries, advance(ms: number) { now += ms; }, answer(value: typeof answer) { answer = value; } };
}
test("unchanged pages reuse the last validated list and a new generation replaces it", async () => {
  const f = fixture();
  expect(await f.cache.read()).toEqual([effect]);
  f.answer({ version: "generation-1:1", unchanged: true });
  expect(await f.cache.read()).toEqual([effect]);
  expect(f.known).toEqual([undefined, "generation-1:1"]);
  f.answer({ version: "generation-2:1", effects: [] });
  expect(await f.cache.read()).toEqual([]);
});
test("one transport timeout keeps known effects and schedules a retry; age expires the fallback", async () => {
  const f = fixture();
  await f.cache.read();
  f.answer(new RuntimeHostUnavailableError("runtime host request timed out"));
  f.advance(10_000);
  expect(await f.cache.read()).toEqual([effect]);
  expect(f.retries()).toBe(1);
  f.advance(20_001);
  await expect(f.cache.read()).rejects.toThrow("runtime host request timed out");
  expect(f.retries()).toBe(1);
});
test("cold caches, deterministic refusals and unmatched versions remain unavailable evidence", async () => {
  const f = fixture();
  f.answer(new RuntimeHostUnavailableError("runtime host request timed out"));
  await expect(f.cache.read()).rejects.toThrow("timed out");
  f.answer({ effects: [effect], version: "generation-1:1" });
  await f.cache.read();
  f.answer(new RuntimeHostUnavailableError("journal refused", "REFUSED"));
  await expect(f.cache.read()).rejects.toThrow("journal refused");
  f.answer({ version: "other", unchanged: true });
  await expect(f.cache.read()).rejects.toThrow("no matching cache");
});
test("LRU evicts after 32 pages and does not renew stale evidence on failure", async () => {
  const f = fixture();
  for (let cursor=0; cursor<33; cursor++) await f.cache.read(undefined, cursor);
  f.answer(new RuntimeHostUnavailableError("runtime host is unavailable"));
  await expect(f.cache.read(undefined, 0)).rejects.toThrow("unavailable");
  expect(await f.cache.read(undefined, 1)).toEqual([effect]);
  f.advance(30_001);
  await expect(f.cache.read(undefined, 1)).rejects.toThrow("unavailable");
});
test("conditional host reads materialize only changes and old array readers retain their contract", async () => {
  const journal = new RuntimeJournal(":memory:");
  const host = new RuntimeHost(journal, undefined, undefined, true);
  try {
    const command = { operationId: "one", kind: "send" as const, conversationId: "conversation-a", text: "message", policy: "queue" as const, idempotencyKey: "one" };
    journal.append({ scope: "session:conversation-a", kind: "session-status", payload: { conversationId: "conversation-a", sessionKey: { engine: "codex", sessionId: "fixture" }, hostKind: "codex-app-server", host: "hosted", turn: "idle" } });
    journal.executeOperation(command);
    const request = { id: "read-1", method: "effect-batch" as const, params: { kinds: ["runtime.send"], conditional: true } };
    const first = (await host.handle(request)).result as { version: string; effects: RuntimePendingEffect[] };
    expect(first.effects.map(effect => effect.payload.operationId)).toEqual(["one"]);
    const repeated = await host.handle({ ...request, id: "read-2", params: { ...request.params, knownVersion: first.version } });
    expect(repeated.result).toEqual({ version: first.version, unchanged: true });
    journal.transitionOperation("one", "delivered");
    const moved = (await host.handle({ ...request, id: "read-3", params: { ...request.params, knownVersion: first.version } })).result as { effects: RuntimePendingEffect[] };
    expect(moved.effects).toEqual([]);
    expect((await host.handle({ id: "legacy", method: "effect-batch" })).result).toEqual([]);
  } finally { journal.close(); }
});

test("peer commits and a real journal restart invalidate the conditional version", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pages-"));
  const file = path.join(directory, "journal.sqlite");
  let journal = new RuntimeJournal(file);
  let peer: RuntimeJournal | undefined;
  try {
    const first = journal.effectPageVersion();
    peer = new RuntimeJournal(file);
    peer.append({ scope: "system:fixture", kind: "item", payload: {}, effect });
    expect(journal.effectPageVersion()).not.toBe(first);
    const beforeRestart = journal.effectPageVersion();
    peer.close(); peer = undefined;
    journal.close();
    journal = new RuntimeJournal(file);
    expect(journal.effectPageVersion()).not.toBe(beforeRestart);
    expect(journal.effectBatch(100, ["runtime.send"])).toHaveLength(1);
  } finally { peer?.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("an oversized page is served once without retaining an unbounded fallback", async () => {
  const f = fixture();
  const large = { ...effect, payload: { ...effect.payload, text: "x".repeat(2 * 1024 * 1024) } };
  f.answer({ version: "large", effects: [large] });
  expect((await f.cache.read())[0]).toBe(large);
  f.answer(new RuntimeHostUnavailableError("runtime host is unavailable"));
  await expect(f.cache.read()).rejects.toThrow("unavailable");
});

test("a late unchanged response cannot restore an older page over a newer observation", async () => {
  let release!: (page: RuntimeEffectPage) => void;
  const delayed = new Promise<RuntimeEffectPage>(resolve => { release = resolve; });
  const known: Array<string | undefined> = [];
  const newer = { ...effect, payload: { ...effect.payload, text: "new message" } };
  const client = { effectPage: async (_kinds: unknown, _after: unknown, version?: string) => {
    known.push(version);
    if (known.length === 1) return { version: "v1", effects: [effect] };
    if (known.length === 2) return delayed;
    if (known.length === 3) return { version: "v2", effects: [newer] };
    return { version: "v2", unchanged: true };
  } } as RuntimeHostClient;
  const cache = new DeliveryEffectPages(client, () => {});
  await cache.read();
  const older = cache.read();
  expect(await cache.read()).toEqual([newer]);
  release({ version: "v1", unchanged: true });
  expect(await older).toEqual([newer]);
  expect(await cache.read()).toEqual([newer]);
  expect(known).toEqual([undefined, "v1", "v1", "v2"]);
});

test("reconfigure supersedence always reads live evidence and never falls back to a stale control", async () => {
  let fail = false, reads = 0;
  const control = { ...effect, kind: "runtime.reconfigure" };
  const client = {
    effectBatch: async () => { reads++; if (fail) throw new RuntimeHostUnavailableError("runtime host request timed out"); return [control]; },
    effectPage: async () => { throw new Error("supersedence must not use a cached page"); },
  } as unknown as RuntimeHostClient;
  const cache = new DeliveryEffectPages(client, () => { throw new Error("supersedence must not schedule a cached fallback"); });
  expect(await cache.read(["runtime.reconfigure"])).toEqual([control]);
  fail = true;
  await expect(cache.read(["runtime.reconfigure"])).rejects.toThrow("timed out");
  expect(reads).toBe(2);
});
