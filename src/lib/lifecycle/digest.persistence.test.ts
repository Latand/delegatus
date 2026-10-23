import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetLegacyDocumentStoresForTests, setLegacyDocumentWriteHookForTests } from "@/lib/state/legacyDocumentStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import { injectStateWriteFaultForTests, readStateCollectionRevision, readStateImport } from "@/lib/state/sqliteStateStore";
import { HOT_STATE_BACKEND } from "@/lib/state/hotStateAuthority";

import { digestScopeKey, lifecycleDigestStore, pollLifecycleDigest, readDigestSubscriber, seedLifecycleDigestCursor } from "./digest";
import { appendLifecycleEvents } from "./journal";

const T0 = Date.parse("2026-07-26T09:00:00.000Z");
const originalState = process.env.LLV_STATE_DIR;
const roots: string[] = [];

afterEach(() => {
  setLegacyDocumentWriteHookForTests(null);
  injectStateWriteFaultForTests(null);
  resetLegacyDocumentStoresForTests();
  if (originalState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalState;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(subscriberId = "subscriber-a", scope: { project?: string; pipelineId?: string; conversationId?: string } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "digest-persistence-"));
  roots.push(directory);
  process.env.LLV_STATE_DIR = directory;
  const file = path.join(directory, "lifecycle-digests.json");
  const database = path.join(directory, "state.sqlite");
  const subscriber = { cursorSeq: 7, lastRelayAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() };
  const request = { subscriberId, ...scope };
  const key = digestScopeKey(request);
  const text = JSON.stringify({ version: 1, subscribers: { [key]: subscriber } });
  fs.writeFileSync(file, text);
  return { directory, file, database, subscriber, key, rowKey: JSON.stringify(key), text, request };
}

async function child(source: string) {
  const process = Bun.spawn([globalThis.process.execPath, "-e", `
    import { lifecycleDigestStore, digestScopeKey, readDigestSubscriber, pollLifecycleDigest } from ${JSON.stringify(new URL("./digest.ts", import.meta.url).href)};
    import { waitForStateLock } from ${JSON.stringify(new URL("../state/lockWait.ts", import.meta.url).href)};
    const file = ${JSON.stringify(path.join(globalThis.process.env.LLV_STATE_DIR!, "lifecycle-digests.json"))};
    ${source}
  `], { env: { ...globalThis.process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, signal: process.signalCode, stdout, stderr };
}

test("imports cursor and throttle state once, preserving bytes and fencing legacy writers", () => {
  const f = fixture();
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
  expect(fs.statSync(f.file).isDirectory()).toBe(true);
  const archive = fs.readdirSync(f.directory).find(name => name.startsWith("lifecycle-digests.json.imported-"))!;
  expect(fs.readFileSync(path.join(f.directory, archive), "utf8")).toBe(f.text);
  expect(readStateImport(f.database, "lifecycle_digests")?.rowCount).toBe(1);
  expect(() => fs.writeFileSync(f.file, "{}")).toThrow();
  resetLegacyDocumentStoresForTests();
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
});

test("unpromoted reads leave legacy state in place and refuse cursor writes", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.directory, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:1", revision: "a".repeat(40), hotStateBackend: HOT_STATE_BACKEND,
  }));
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
  expect(() => seedLifecycleDigestCursor("new-subscriber", T0)).toThrow("waiting for release promotion");
  expect(fs.readFileSync(f.file, "utf8")).toBe(f.text);
  expect(readStateImport(f.database, "lifecycle_digests")).toBeNull();
});

test("NUL-filled legacy cursors record a gap and restart from an empty subscriber set", () => {
  const f = fixture();
  fs.writeFileSync(f.file, Buffer.alloc(64));
  const result = lifecycleDigestStore.importLegacy(f.file);
  expect(result.incident?.kind).toBe("legacy-unreadable");
  expect(readStateImport(f.database, "lifecycle_digests")?.gap).toBe("legacy-unreadable");
  expect(readDigestSubscriber("subscriber-a")).toBeNull();
  const archive = fs.readdirSync(f.directory).find(name => name.startsWith("lifecycle-digests.json.unreadable-"))!;
  expect(fs.readFileSync(path.join(f.directory, archive))).toEqual(Buffer.alloc(64));
});

test("failed digest verification preserves the source and leaves the import unmarked", () => {
  const f = fixture();
  expect(() => lifecycleDigestStore.importLegacy(f.file, { reconcile: true, hooks: {
    beforeVerify: (execute) => execute("UPDATE state_rows SET value_json='{}' WHERE collection='lifecycle_digests'"),
  } })).toThrow();
  expect(readStateImport(f.database, "lifecycle_digests")).toBeNull();
  expect(fs.readFileSync(f.file, "utf8")).toBe(f.text);
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
});

test.each(["beforeVerify", "afterCommit", "afterRename"] as const)("a killed importer recovers at %s without a second import", async (seam) => {
  const f = fixture();
  const crashed = await child(`lifecycleDigestStore.importLegacy(file, { reconcile: true, hooks: { ${seam}: () => process.kill(process.pid, "SIGKILL") } });`);
  expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
  // Activation finishes retirement even when a readable commit already exists.
  await waitForStateLock("digest.recover.test", () => lifecycleDigestStore.importLegacy(f.file));
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
  expect(readStateImport(f.database, "lifecycle_digests")?.rowCount).toBe(1);
  expect(fs.statSync(f.file).isDirectory()).toBe(true);
});

test("concurrent first readers agree on the one committed import", async () => {
  const f = fixture();
  const source = `await waitForStateLock("digest.import.test", () => lifecycleDigestStore.importLegacy(file)); console.log(JSON.stringify(readDigestSubscriber("subscriber-a")));`;
  const results = await Promise.all([child(source), child(source)]);
  for (const result of results) {
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(f.subscriber);
  }
  expect(readStateImport(f.database, "lifecycle_digests")?.rowCount).toBe(1);
  expect(fs.readdirSync(f.directory).filter(name => name.startsWith("lifecycle-digests.json.imported-"))).toHaveLength(1);
});

test("a killed cursor transaction retains the previous cursor and throttle", async () => {
  const f = fixture();
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
  const revision = readStateCollectionRevision(f.database, "lifecycle_digests");
  const crashed = await child(`lifecycleDigestStore.patchRows(file, 1, tx => {
    tx.put({ key: JSON.stringify(digestScopeKey({ subscriberId: "subscriber-a" })), value: { cursorSeq: 99 } });
    process.kill(process.pid, "SIGKILL");
  });`);
  expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
  expect(readStateCollectionRevision(f.database, "lifecycle_digests")).toBe(revision);
  expect(seedLifecycleDigestCursor("subscriber-b", T0).cursorSeq).toBe(0);
});

const scopes = [
  { name: "ordinary", subscriberId: "subscriber-a", scope: {} },
  { name: "NUL", subscriberId: "subscriber\u0000a", scope: {} },
  { name: "high surrogate", subscriberId: String.fromCharCode(0xd800), scope: {} },
  { name: "low surrogate", subscriberId: String.fromCharCode(0xdc00), scope: {} },
  { name: "scoped surrogates", subscriberId: "subscriber-a", scope: {
    project: String.fromCharCode(0xd800), pipelineId: "pipeline\u0000a", conversationId: String.fromCharCode(0xdc00),
  } },
];

for (const { name, subscriberId, scope } of scopes) {
  test(`rollback mirror preserves newer SQLite cursors for ${name} keys`, () => {
    const f = fixture(subscriberId, scope);
    lifecycleDigestStore.importLegacy(f.file);
    lifecycleDigestStore.checkpointRollbackMirror(f.file);
    const mirror = JSON.parse(fs.readFileSync(f.file, "utf8"));
    expect(mirror.subscribers[f.key]).toEqual(f.subscriber);
    const newer = { ...f.subscriber, cursorSeq: 9 };
    lifecycleDigestStore.patchRows(f.file, 1, tx => tx.put({ key: f.rowKey, value: newer }));
    mirror.subscribers[f.key].cursorSeq = 8;
    mirror.subscribers[digestScopeKey({ subscriberId: "subscriber-b" })] = { ...f.subscriber, cursorSeq: 4 };
    fs.writeFileSync(f.file, JSON.stringify(mirror));
    const result = lifecycleDigestStore.importLegacy(f.file);
    expect(result.incident?.summary?.conflicts).toEqual([f.rowKey]);
    expect(lifecycleDigestStore.read(f.file).subscribers[f.key]).toEqual(newer);
    expect(readDigestSubscriber("subscriber-b")?.cursorSeq).toBe(4);
    expect(fs.statSync(f.file).isDirectory()).toBe(true);
  });
}

test("empty and rate-held polls never request a durable writer", () => {
  const f = fixture();
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, subscribers: { [f.key]: { ...f.subscriber, cursorSeq: 0 } } }));
  lifecycleDigestStore.importLegacy(f.file);
  const revision = readStateCollectionRevision(f.database, "lifecycle_digests");
  let writes = 0;
  setLegacyDocumentWriteHookForTests(collection => {
    if (collection === "lifecycle_digests") {
      writes++;
      throw new Error("unexpected digest writer admission");
    }
  });
  for (const subscriberId of ["subscriber-a", "subscriber-b"]) {
    expect(pollLifecycleDigest({ subscriberId, now: T0 }).relay).toBeNull();
  }
  appendLifecycleEvents([{ key: "routine-a", type: "stage_started", at: new Date(T0).toISOString() }]);
  const holder = new Database(f.database);
  try {
    holder.exec("BEGIN IMMEDIATE");
    for (const subscriberId of ["subscriber-a", "subscriber-b"]) {
      expect(pollLifecycleDigest({ subscriberId, now: T0 + 1_000 })).toMatchObject({
        relay: null, pending: 1, heldUntil: new Date(T0 + 300_000).toISOString(),
      });
    }
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  expect(writes).toBe(0);
  expect(readStateCollectionRevision(f.database, "lifecycle_digests")).toBe(revision);
  expect(readDigestSubscriber("subscriber-b")).toBeNull();
});

for (const { name, subscriberId, scope } of scopes) {
  test(`keyed reads, polls, seeds and mirrors preserve ${name} scope keys`, async () => {
    const f = fixture(subscriberId, scope);
    appendLifecycleEvents(Array.from({ length: 8 }, (_, i) => ({
      key: `terminal-${i}`, type: "stage_completed" as const, at: new Date(T0).toISOString(), ...scope,
    })));
    const read = () => lifecycleDigestStore.read(f.file).subscribers[f.key];
    expect(read()).toEqual(f.subscriber);
    expect(pollLifecycleDigest({ ...f.request, now: T0, acknowledge: false }).cursor).toBe(8);
    expect(read()?.cursorSeq).toBe(7);
    expect(pollLifecycleDigest({ ...f.request, now: T0 }).cursor).toBe(8);
    expect(read()?.cursorSeq).toBe(8);
    const next = await child(`console.log(JSON.stringify(pollLifecycleDigest(${JSON.stringify({ ...f.request, now: T0 })})));`);
    expect(next.code, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout.trim())).toMatchObject({ cursor: 8, relay: null });
    const seededId = `${subscriberId}-seed`;
    expect(seedLifecycleDigestCursor(seededId, T0).cursorSeq).toBe(8);
    expect(readDigestSubscriber(seededId)?.cursorSeq).toBe(8);
    lifecycleDigestStore.checkpointRollbackMirror(f.file);
    const mirror = JSON.parse(fs.readFileSync(f.file, "utf8"));
    expect(mirror.subscribers[f.key]?.cursorSeq).toBe(8);
    expect(mirror.subscribers[digestScopeKey({ subscriberId: seededId })]?.cursorSeq).toBe(8);
  });
}

test("a due poll rechecks a competing acknowledgment before emitting a relay", () => {
  const f = fixture();
  lifecycleDigestStore.importLegacy(f.file);
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  let competingRelays = 0;
  setLegacyDocumentWriteHookForTests(collection => {
    if (collection !== "lifecycle_digests") return;
    setLegacyDocumentWriteHookForTests(null);
    if (pollLifecycleDigest({ subscriberId: "subscriber-b", now: T0 }).relay) competingRelays++;
  });
  expect(pollLifecycleDigest({ subscriberId: "subscriber-b", now: T0 }).relay).toBeNull();
  expect(competingRelays).toBe(1);
  expect(readDigestSubscriber("subscriber-b")?.cursorSeq).toBe(1);
});

test("a full-disk commit refuses acknowledgment and retries the same relay", () => {
  const f = fixture();
  readDigestSubscriber("subscriber-a");
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  injectStateWriteFaultForTests({ site: "commit", collection: "lifecycle_digests", times: 1,
    error: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }) });
  expect(() => pollLifecycleDigest({ subscriberId: "subscriber-b", now: T0 })).toThrow("full");
  expect(readDigestSubscriber("subscriber-b")).toBeNull();
  expect(pollLifecycleDigest({ subscriberId: "subscriber-b", now: T0 }).relay?.through).toBe(1);
  expect(readDigestSubscriber("subscriber-a")).toEqual(f.subscriber);
});

test("cursor and rate limit survive separate processes, including dry polls", async () => {
  fixture();
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  const first = await child(`console.log(JSON.stringify(pollLifecycleDigest({ subscriberId: "subscriber-b", now: ${T0} })));`);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout.trim()).cursor).toBe(1);
  appendLifecycleEvents([{ key: "routine-a", type: "stage_started", at: new Date(T0 + 1_000).toISOString() }]);
  const next = await child(`console.log(JSON.stringify(pollLifecycleDigest({ subscriberId: "subscriber-b", now: ${T0 + 2_000}, acknowledge: false })));`);
  expect(next.code, next.stderr).toBe(0);
  expect(JSON.parse(next.stdout.trim())).toMatchObject({ cursor: 1, relay: null, heldUntil: new Date(T0 + 301_000).toISOString() });
});

test("concurrent subscribers keep separate cursor rows and seeded cursors are stable", async () => {
  fixture();
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  const results = await Promise.all(["subscriber-b", "subscriber-c"].map(id => child(`
    await waitForStateLock("digest.poll.test", () => pollLifecycleDigest({ subscriberId: ${JSON.stringify(id)}, now: ${T0} }));
  `)));
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  expect(readDigestSubscriber("subscriber-b")?.cursorSeq).toBe(1);
  expect(readDigestSubscriber("subscriber-c")?.cursorSeq).toBe(1);
  appendLifecycleEvents([{ key: "terminal-b", type: "stage_completed", at: new Date(T0 + 1_000).toISOString() }]);
  expect(seedLifecycleDigestCursor("subscriber-b", T0 + 2_000).cursorSeq).toBe(1);
});

test("concurrent acknowledgments for one scope emit one relay and refresh an existing reader", async () => {
  fixture();
  expect(seedLifecycleDigestCursor("subscriber-b", T0).cursorSeq).toBe(0);
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  const source = `console.log(JSON.stringify(await waitForStateLock("digest.poll.test", () => pollLifecycleDigest({ subscriberId: "subscriber-b", now: ${T0} }))));`;
  const results = await Promise.all([child(source), child(source)]);
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  expect(results.filter(result => JSON.parse(result.stdout.trim()).relay !== null)).toHaveLength(1);
  expect(readDigestSubscriber("subscriber-b")?.cursorSeq).toBe(1);
});

test("a failed seed leaves no subscriber and can be retried", () => {
  const f = fixture();
  lifecycleDigestStore.importLegacy(f.file);
  injectStateWriteFaultForTests({ site: "commit", collection: "lifecycle_digests", times: 1,
    error: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }) });
  expect(() => seedLifecycleDigestCursor("subscriber-b", T0)).toThrow("full");
  expect(readDigestSubscriber("subscriber-b")).toBeNull();
  expect(seedLifecycleDigestCursor("subscriber-b", T0).cursorSeq).toBe(0);
});

test("keyed readers retain the legacy normalizer for damaged subscriber fields", () => {
  const f = fixture();
  lifecycleDigestStore.importLegacy(f.file);
  lifecycleDigestStore.patchRows(f.file, 1, tx => tx.put({ key: f.rowKey, value: { cursorSeq: -1, lastRelayAt: 42 } }));
  expect(readDigestSubscriber("subscriber-a")).toEqual({ cursorSeq: 0, lastRelayAt: null, updatedAt: new Date(0).toISOString() });
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  expect(pollLifecycleDigest({ subscriberId: "subscriber-a", now: T0 }).cursor).toBe(1);
});

test("reads, seeding and acknowledgments never materialize unrelated subscribers", () => {
  const f = fixture();
  const subscribers = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [digestScopeKey({ subscriberId: `other-${i}` }), f.subscriber]));
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, subscribers }));
  lifecycleDigestStore.importLegacy(f.file);
  seedLifecycleDigestCursor("subscriber-a", T0);
  const snapshots = [...lifecycleDigestStore.collections.values()].map(collection => spyOn(collection, "snapshot").mockImplementation(() => { throw new Error("whole-store read"); }));
  try {
    expect(readDigestSubscriber("subscriber-a")?.cursorSeq).toBe(0);
    appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
    expect(pollLifecycleDigest({ subscriberId: "subscriber-a", now: T0 }).cursor).toBe(1);
    expect(seedLifecycleDigestCursor("subscriber-b", T0).cursorSeq).toBe(1);
  } finally { for (const snapshot of snapshots) snapshot.mockRestore(); }
});

test("busy storage refuses an acknowledgment without advancing the cursor", async () => {
  const f = fixture();
  readDigestSubscriber("subscriber-a");
  appendLifecycleEvents([{ key: "terminal-a", type: "stage_completed", at: new Date(T0).toISOString() }]);
  const holder = new Database(f.database);
  try {
    holder.exec("BEGIN IMMEDIATE");
    expect(() => pollLifecycleDigest({ subscriberId: "subscriber-b", now: T0 })).toThrow();
    expect(readDigestSubscriber("subscriber-b")).toBeNull();
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  await waitForStateLock("digest.poll.test", () => pollLifecycleDigest({ subscriberId: "subscriber-b", now: T0 }));
  expect(readDigestSubscriber("subscriber-b")?.cursorSeq).toBe(1);
});
