import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { assertStateChildSuccess } from "@/lib/state/stateChildResult.fixture";
import type { ConversationCatalogEntry } from "./conversationCatalog";
import { ConversationSearchProjection, conversationSearchMatchSql } from "./conversationSearchProjection";

const roots: string[] = [];
const stores: ConversationSearchProjection[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(limits?: { entries: number; bytes: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-projection-"));
  roots.push(root);
  const filename = path.join(root, "text.sqlite");
  const store = new ConversationSearchProjection(filename, limits);
  stores.push(store);
  return { root, filename, store };
}
function row(n: number): ConversationCatalogEntry {
  return { path: `/catalog/${n}.jsonl`, root: "codex-sessions", name: `${n}`, project: "selected", title: "Catalog", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", size: 100, mtime: 1 };
}
const text = async (entry: ConversationCatalogEntry) => ({ title: `Title ${entry.name}`, firstPrompt: "Бурштин orchard" });

test("a large warm catalog and a new snapshot decode no transcript text; only changed identities hydrate", async () => {
  const { store } = fixture();
  const catalog = Array.from({ length: 2051 }, (_, n) => row(n));
  let reads = 0;
  const readText = async (entry: ConversationCatalogEntry) => { reads++; return text(entry); };
  expect(await store.search(catalog, "БУРШТИН orchard", { readText })).toHaveLength(catalog.length);
  reads = 0;
  expect(await store.search(catalog.map(entry => ({ ...entry })), "БУРШТИН orchard", { readText })).toHaveLength(catalog.length);
  expect(reads).toBe(0);
  for (const change of [{ size: 101 }, { mtime: 2 }, { engine: "claude" as const }, { title: "new source" }, { kind: "subagent" }]) {
    await store.search([{ ...catalog[0], ...change }], "orchard", { readText });
  }
  expect(reads).toBe(5);
});

test("title overrides, project moves, scope changes and removed rows use current metadata", async () => {
  const { store } = fixture();
  const catalog = [row(1), row(2)];
  let reads = 0;
  const readText = async (entry: ConversationCatalogEntry) => { reads++; return text(entry); };
  await store.search(catalog, "orchard", { readText });
  expect(await store.search([catalog[0]], "renamed", { readText, projectTitle: entry => { entry.title = "Renamed"; } })).toEqual([{ ...catalog[0], title: "Renamed" }]);
  expect(await store.search([catalog[0]], "renamed", { readText })).toEqual([]);
  expect(await store.search([{ ...catalog[0], project: "moved" }], "moved", { readText })).toHaveLength(1);
  expect(await store.search([], "orchard", { readText })).toEqual([]);
  expect(reads).toBe(2);
});

test("byte and entry eviction preserve complete results above either ceiling", async () => {
  for (const limits of [{ entries: 2, bytes: 1_000_000 }, { entries: 100, bytes: 1000 }]) {
    const { store, filename } = fixture(limits);
    const catalog = Array.from({ length: 55 }, (_, n) => row(n));
    for (let round = 0; round < 2; round++) expect(await store.search(catalog, "orchard", { readText: text })).toHaveLength(55);
    const db = new Database(filename, { readonly: true });
    try {
      const totals = db.query<{ rows: number; bytes: number }, []>("SELECT rows,bytes FROM meta").get()!;
      expect(totals.rows).toBeLessThanOrEqual(limits.entries);
      expect(totals.rows).toBeGreaterThan(0);
      expect(totals.bytes).toBeLessThanOrEqual(limits.bytes);
      expect(db.query("SELECT count(*) AS rows,sum(bytes) AS bytes FROM texts").get()).toEqual({ rows: totals.rows, bytes: totals.rows ? totals.bytes : null });
      const plans = [
        db.query(`EXPLAIN QUERY PLAN ${conversationSearchMatchSql(1)}`).all('["orchard"]', row(0).path),
        db.query(`EXPLAIN QUERY PLAN ${conversationSearchMatchSql(3)}`).all('["orchard"]', row(0).path, row(0).path, row(1).path),
        db.query("EXPLAIN QUERY PLAN SELECT bytes FROM texts ORDER BY seq,path LIMIT 24").all(),
      ];
      expect(JSON.stringify(plans[0])).toContain("sqlite_autoindex_texts_1");
      expect(JSON.stringify(plans[1])).toContain("sqlite_autoindex_texts_1");
      expect(JSON.stringify(plans[2])).toContain("text_eviction");
    } finally { db.close(); }
  }
});

test("repeated searches retain future cached rows while misses are hydrated", async () => {
  for (const limits of [{ entries: 24, bytes: 1_000_000 }, { entries: 100, bytes: 10_000 }]) {
    const { store, filename } = fixture(limits);
    const catalog = Array.from({ length: 55 }, (_, n) => row(n));
    let reads = 0;
    const readText = async (entry: ConversationCatalogEntry) => { reads++; return text(entry); };
    expect(await store.search(catalog, "orchard", { readText })).toHaveLength(55);
    expect(reads).toBe(55);
    const db = new Database(filename, { readonly: true });
    let retained = 0;
    try { retained = db.query<{ rows: number; bytes: number }, []>("SELECT rows,bytes FROM meta").get()!.rows; }
    finally { db.close(); }
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThanOrEqual(limits.entries);
    reads = 0;
    expect(await store.search(catalog, "orchard", { readText })).toHaveLength(55);
    expect(reads).toBe(55 - retained);
    const after = new Database(filename, { readonly: true });
    try {
      const totals = after.query<{ rows: number; bytes: number }, []>("SELECT rows,bytes FROM meta").get()!;
      expect(totals.rows).toBeLessThanOrEqual(limits.entries);
      expect(totals.bytes).toBeLessThanOrEqual(limits.bytes);
    } finally { after.close(); }
  }
});

test("foreground search runs between publication batches and returns complete scoped matches", async () => {
  const { store } = fixture();
  const catalog = Array.from({ length: 48 }, (_, n) => row(n));
  let firstBatchEntered!: () => void;
  const firstReady = new Promise<void>(resolve => { firstBatchEntered = resolve; });
  let releaseFirstBatch!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
  let secondBatchEntered = false;
  const preparation = store.prepare(catalog, { readText: async entry => {
    if (entry === catalog[0]) { firstBatchEntered(); await firstHeld; }
    if (entry === catalog[24]) secondBatchEntered = true;
    return text(entry);
  } });
  await firstReady;
  // Admit foreground work before publication can enqueue its next batch.
  const foreground = store.search([catalog[47]], "orchard", { readText: text });
  releaseFirstBatch();
  try {
    expect(await foreground).toHaveLength(1);
    expect(secondBatchEntered).toBe(false);
    await preparation;
  } finally {
    releaseFirstBatch();
    await preparation.catch(() => {});
  }
  expect(await store.search(catalog, "orchard", { readText: text })).toHaveLength(48);
});

test("publication queue cancellation and a following scoped search settle without restarting", async () => {
  const { store } = fixture();
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const active = store.search([row(1)], "orchard", { signal: controller.signal, readText: async entry => { entered(); await held; return text(entry); } });
  await ready;
  const queued = store.search([row(2)], "orchard", { readText: text });
  const preparation = store.prepare([row(3)], { readText: text });
  controller.abort();
  release();
  try {
    await expect(active).rejects.toHaveProperty("name", "AbortError");
    expect(await queued).toHaveLength(1);
    await preparation;
    expect(await store.search([row(4)], "orchard", { readText: text })).toHaveLength(1);
  } finally {
    release();
    await Promise.all([active.catch(() => {}), queued.catch(() => {}), preparation.catch(() => {})]);
  }
});

test("an unrelated publication read failure leaves warm scopes available and retryable", async () => {
  const { store } = fixture();
  const selected = row(1);
  const unrelated = { ...row(2), project: "other" };
  await store.search([selected], "orchard", { readText: text });
  await expect(store.prepare([selected, unrelated], { readText: async entry => {
    if (entry.path === unrelated.path) throw new Error("unrelated EACCES");
    return text(entry);
  } })).rejects.toThrow("conversation search projection preparation failed");
  const warm = await store.search([selected], "orchard", { readText: async () => { throw new Error("warm scope reopened its transcript"); } });
  expect(warm).toHaveLength(1);
  expect(warm[0].title).toBe("Title 1");
  await store.prepare([selected, unrelated], { readText: text });
  const retried = await store.search([unrelated], "orchard", { readText: async () => { throw new Error("successful retry was not retained"); } });
  expect(retried).toHaveLength(1);
  expect(retried[0].title).toBe("Title 2");
});

test("failed hydration and cancellation never publish partial text; an identical retry recovers", async () => {
  const { store } = fixture();
  await expect(store.search([row(1)], "orchard", { readText: async () => { throw new Error("read refused"); } })).rejects.toThrow("read refused");
  const controller = new AbortController();
  await expect(store.search([row(1)], "orchard", { signal: controller.signal, readText: async entry => { controller.abort(); return text(entry); } })).rejects.toHaveProperty("name", "AbortError");
  let reads = 0;
  expect(await store.search([row(1)], "orchard", { readText: async entry => { reads++; return text(entry); } })).toHaveLength(1);
  expect(reads).toBe(1);
});

test("queued cancellation answers before the active read finishes and never starts another read", async () => {
  const { store } = fixture();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = store.search([row(1)], "orchard", { readText: async entry => { entered(); await held; return text(entry); } });
  const controller = new AbortController();
  let second: Promise<ConversationCatalogEntry[]> | undefined;
  try {
    await ready;
    second = store.search([row(2)], "orchard", { signal: controller.signal, readText: async () => { throw new Error("cancelled job read a transcript"); } });
    controller.abort();
    await expect(second).rejects.toHaveProperty("name", "AbortError");
  } finally {
    release();
    await first;
    await second?.catch(() => {});
  }
});

test("the queue refuses its 65th request and cancelled queued work never hydrates", async () => {
  const { store } = fixture();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const first = store.search([row(1)], "orchard", { readText: async entry => { entered(); await held; return text(entry); } });
  const queued: Promise<unknown>[] = [];
  let reads = 0;
  try {
    await ready;
    for (let n = 0; n < 63; n++) queued.push(store.search([row(n + 2)], "orchard", {
      signal: controller.signal, readText: async entry => { reads++; return text(entry); },
    }).catch(error => error));
    await expect(store.search([row(99)], "orchard")).rejects.toThrow("conversation search queue is full");
  } finally {
    controller.abort();
    release();
    await first;
    await Promise.all(queued);
  }
  expect(reads).toBe(0);
});

test("SQLite admission yields while a peer holds the write lock, then resumes", async () => {
  const { store, filename } = fixture();
  await store.search([row(1)], "orchard", { readText: text });
  const peer = new Database(filename);
  peer.exec("BEGIN IMMEDIATE");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 2000);
  let pending: Promise<ConversationCatalogEntry[]> | undefined;
  try {
    pending = store.search([row(2)], "orchard", { readText: text, signal: controller.signal });
    while (!stateLockWaitsInFlight().some(wait => wait.callSite === "catalog.search.update")) {
      controller.signal.throwIfAborted();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    peer.exec("COMMIT");
    expect(await pending).toHaveLength(1);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (peer.inTransaction) peer.exec("ROLLBACK");
    peer.close();
    await pending?.catch(() => {});
  }
});

test("persisted text survives a real process restart", async () => {
  const { filename, root } = fixture();
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "conversationSearchProjection.fixture.ts"), filename, mode], {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, LLV_STATE_DIR: path.join(root, "state") },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assertStateChildSuccess(code, stderr);
    return JSON.parse(stdout);
  };
  expect(await run("seed")).toEqual({ reads: 1, matches: 1, retained: 1 });
  expect(await run("reopen")).toEqual({ reads: 0, matches: 1, retained: 1 });
  fs.unlinkSync(filename);
  expect(await run("capped-seed")).toEqual({ reads: 3, matches: 2, retained: 2 });
  expect(await run("capped-reopen")).toEqual({ reads: 0, matches: 2, retained: 2 });
});

test("a peer replacing an untouched row during hydration cannot supply another version's matches", async () => {
  const { store, filename } = fixture();
  const catalog = [row(1), row(2)];
  await store.search(catalog, "orchard", { readText: text });
  const peer = new Database(filename);
  let replaced = false;
  let reads = 0;
  try {
    const matches = await store.search([catalog[0], { ...catalog[1], size: 101 }], "orchard", {
      readText: async entry => {
        reads++;
        if (!replaced) {
          replaced = true;
          peer.query("UPDATE texts SET size=999,promptFold='unrelated text' WHERE path=?").run(catalog[0].path);
        }
        return text(entry);
      },
    });
    expect(matches).toHaveLength(2);
    expect(reads).toBe(3);
  } finally { peer.close(); }
});

test("a failed open is retryable and an unsupported persisted schema is refused without rewriting it", async () => {
  const { store, filename } = fixture();
  fs.mkdirSync(filename);
  await expect(store.search([row(1)], "orchard", { readText: text })).rejects.toThrow();
  fs.rmdirSync(filename);
  expect(await store.search([row(1)], "orchard", { readText: text })).toHaveLength(1);
  store.close();
  const peer = new Database(filename);
  peer.exec("PRAGMA user_version=77");
  peer.close();
  const bytes = fs.readFileSync(filename);
  await expect(store.search([row(1)], "orchard", { readText: text })).rejects.toThrow("unsupported conversation search projection version");
  expect(fs.readFileSync(filename)).toEqual(bytes);
});
