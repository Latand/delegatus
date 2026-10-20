import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeCodexStructuredUserText, decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { collectStructuredUserMetadata, maybeCollectStructuredUserMetadata } from "./structuredUserMetadataRetention";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { structuredUserReferenceKey, decodeCodexStructuredUserText as decodeWire } from "@/lib/runtime/codexStructuredUserText";

async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "metadata-retention-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try { await work(root); }
  finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
}
const listedAt = Date.parse("2026-10-01T00:00:00Z");
const old = new Date("2026-01-01T00:00:00Z");
async function age(root: string) {
  for (const name of await readdir(join(root, "structured-user-metadata"))) {
    if (name.endsWith(".json")) await utimes(join(root, "structured-user-metadata", name), old, old);
  }
}

test("collection removes only old unreferenced metadata and retained rollouts still decode", async () => {
  const root = await mkdtemp(join(tmpdir(), "metadata-retention-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const kept = await encodeCodexStructuredUserText("kept fixture", undefined, null, { kind: "agent", role: "reviewer" });
    await encodeCodexStructuredUserText("orphan fixture", "a".repeat(64));
    const dir = join(root, "structured-user-metadata");
    const old = new Date("2026-01-01T00:00:00Z");
    for (const name of await readdir(dir)) await utimes(join(dir, name), old, old);
    const transcript = join(root, "rollout.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: kept } }));
    const info = await stat(transcript);
    const feed = { complete: true, listedAt: Date.parse("2026-10-01T00:00:00Z"), sources: [
      { path: transcript, size: info.size, mtimeMs: info.mtimeMs, engine: "codex" as const, project: "repo-fixture" },
    ] };
    const result = await collectStructuredUserMetadata(feed);
    expect(result.removed).toBe(1);
    expect((await readdir(dir)).filter(name => name.endsWith(".json"))).toHaveLength(1);
    expect(decodeCodexStructuredUserText(kept).origin).toEqual({ kind: "agent", role: "reviewer" });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("incomplete, missing, superseded and changed reference inventories never delete records", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("protected fixture");
  await age(root);
  expect(await collectStructuredUserMetadata({ complete: false, listedAt, sources: [] })).toEqual({ removed: 0, complete: false });
  expect(await collectStructuredUserMetadata({ complete: true, listedAt, sources: [] }, { current: () => false })).toEqual({ removed: 0, complete: false });
  await expect(collectStructuredUserMetadata({ complete: true, listedAt, sources: [
    { path: join(root, "missing.jsonl"), size: 1, mtimeMs: 1, engine: "codex", project: "repo-fixture" },
  ] })).rejects.toThrow();
  expect(decodeCodexStructuredUserText(wire).text).toBe("protected fixture");
}));

test("archived copies and split markers are roots; unchanged sources reuse their persisted projection", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("archive fixture", "c".repeat(64));
  await age(root);
  const archives = join(root, "archived_sessions");
  await mkdir(archives);
  const path = join(archives, "rollout.jsonl");
  const line = (padding: string) => JSON.stringify({ padding, type: "event_msg", payload: { type: "user_message", message: wire } });
  // Put the first Unicode escape of ctx= across the 64 KiB boundary in
  // an actual JSON rollout record, with a fully escaped reference.
  const raw = line("x".repeat(65_535 - line("").indexOf("ctx=")));
  const ref = decodeWire(wire).metadataRef!;
  const escaped = raw.replace(`ctx=${ref}`, text => text.replace(/./g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
  expect(JSON.parse(escaped).payload.message).toBe(wire);
  await writeFile(path, escaped);
  const feed = { complete: true, listedAt, sources: [] };
  expect((await collectStructuredUserMetadata(feed, { roots: [archives] })).removed).toBe(0);
  const cache = join(root, "structured-user-reference-index");
  const name = (await readdir(cache))[0]!;
  const before = await stat(join(cache, name));
  expect((await collectStructuredUserMetadata(feed, { roots: [archives] })).removed).toBe(0);
  expect((await stat(join(cache, name))).mtimeMs).toBe(before.mtimeMs);
  expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("c".repeat(64));
}));

test("a transcript changed during discovery refuses collection before deletion", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("changing source fixture", "f".repeat(64));
  await age(root);
  const path = join(root, "changing.jsonl");
  await writeFile(path, "fixture");
  const original = fs.createReadStream;
  const stream = spyOn(fs, "createReadStream").mockImplementation((...args) => {
    const result = original(...args);
    result.once("data", () => fs.appendFileSync(path, wire));
    return result;
  });
  try {
    await expect(collectStructuredUserMetadata({ complete: true, listedAt, sources: [
      { path, size: 7, mtimeMs: 0, engine: "codex", project: "repo-fixture" },
    ] })).rejects.toThrow("changed");
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("f".repeat(64));
  } finally { stream.mockRestore(); }
}));

test("a source append after census and before unlink preserves its metadata", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("late reference fixture", "7".repeat(64));
  await age(root);
  const source = join(root, "late-reference.jsonl");
  await writeFile(source, "initial");
  const metadataDir = join(root, "structured-user-metadata");
  const original = io.stat;
  let changed = false;
  const statSpy = spyOn(io, "stat").mockImplementation((async (path: string) => {
    const result = await original(path);
    if (!changed && String(path).startsWith(metadataDir) && String(path).endsWith(".json")) {
      changed = true;
      await writeFile(source, wire, { flag: "a" });
    }
    return result;
  }) as typeof io.stat);
  try {
    await expect(collectStructuredUserMetadata({ complete: true, listedAt, sources: [
      { path: source, size: 7, mtimeMs: 0, engine: "codex", project: "repo-fixture" },
    ] })).rejects.toThrow("changed");
    expect(changed).toBeTrue();
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("7".repeat(64));
  } finally { statSpy.mockRestore(); }
}));

test("a source append at unlink is detected and the metadata link is restored", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("unlink boundary fixture", "3".repeat(64));
  await age(root);
  const source = join(root, "unlink-boundary.jsonl");
  await writeFile(source, "initial");
  const metadataDir = join(root, "structured-user-metadata");
  const original = io.unlink;
  let changed = false;
  const unlinkSpy = spyOn(io, "unlink").mockImplementation(async (...args) => {
    if (!changed && String(args[0]).startsWith(metadataDir) && String(args[0]).endsWith(".json")) {
      changed = true;
      await writeFile(source, wire, { flag: "a" });
    }
    return original(...args);
  });
  try {
    await expect(collectStructuredUserMetadata({ complete: true, listedAt, sources: [
      { path: source, size: 7, mtimeMs: 0, engine: "codex", project: "repo-fixture" },
    ] })).rejects.toThrow("changed");
    expect(changed).toBeTrue();
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("3".repeat(64));
  } finally { unlinkSpy.mockRestore(); }
}));

test("a rollout added beneath a retained root after census preserves its metadata", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("new rollout fixture", "4".repeat(64));
  await age(root);
  const archive = join(root, "archive-root");
  await mkdir(archive);
  const metadataDir = join(root, "structured-user-metadata");
  const original = io.stat;
  let added = false;
  const statSpy = spyOn(io, "stat").mockImplementation((async (path: string) => {
    const result = await original(path);
    if (!added && String(path).startsWith(metadataDir) && String(path).endsWith(".json")) {
      added = true;
      await writeFile(join(archive, "new-rollout.jsonl"), wire);
    }
    return result;
  }) as typeof io.stat);
  try {
    await expect(collectStructuredUserMetadata({ complete: true, listedAt, sources: [] }, { roots: [archive] }))
      .rejects.toThrow("root inventory changed");
    expect(added).toBeTrue();
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("4".repeat(64));
  } finally { statSpy.mockRestore(); }
}));

test("degraded root discovery preserves metadata and a repaired inventory can collect", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("managed account fixture", "8".repeat(64));
  await age(root);
  const source = join(root, "managed-account-rollout.jsonl");
  await writeFile(source, wire);
  const info = await stat(source);
  const feed = { complete: true, listedAt, sources: [
    { path: source, size: info.size, mtimeMs: info.mtimeMs, engine: "codex" as const, project: "repo-fixture" },
  ] };
  expect(await collectStructuredUserMetadata(feed, { rootsComplete: () => false })).toEqual({ removed: 0, complete: false });
  expect(decodeCodexStructuredUserText(wire).text).toBe("managed account fixture");
  expect((await collectStructuredUserMetadata(feed, { rootsComplete: () => true })).removed).toBe(0);
  expect(decodeCodexStructuredUserText(wire).text).toBe("managed account fixture");
}));

test("a corrupted managed-account registry keeps its rollout metadata across process restart", async () => fixture(async root => {
  const previousCodexHome = process.env.LLV_CODEX_HOME;
  process.env.LLV_CODEX_HOME = join(root, "codex-home");
  try {
    const accounts = await import("@/lib/accounts/codex");
    const accountStore = await import("@/lib/accounts/accountsStoreFixture");
    const account = accounts.createManagedCodexAccount("Retention rollout owner");
    const registry = accountStore.persistedAccountRegistry("codex");
    const wire = await encodeCodexStructuredUserText("survives degraded discovery", "5".repeat(64));
    const source = join(account.sessionsDir, "rollout.jsonl");
    await mkdir(account.sessionsDir, { recursive: true });
    await writeFile(source, wire);
    await age(root);
    accountStore.seedAccountRegistry("codex", { version: 2, active: "default", accounts: [] });

    const codexUrl = new URL("../accounts/codex.ts", import.meta.url).href;
    const retentionUrl = new URL("./structuredUserMetadataRetention.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `
      const codex = await import(${JSON.stringify(codexUrl)});
      const retention = await import(${JSON.stringify(retentionUrl)});
      const inventory = codex.codexSessionRootInventory();
      const result = await retention.collectStructuredUserMetadata(${JSON.stringify({ complete: true, listedAt, sources: [] })}, {
        roots: inventory.roots, rootsComplete: () => inventory.complete,
      });
      console.log(JSON.stringify({ complete: inventory.complete, result }));
    `], { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, parsed: JSON.parse(output.trim()) }).toEqual({ code: 0,
      parsed: { complete: false, result: { removed: 0, complete: false } } });
    expect(error).toContain("registry has an unsupported shape");
    expect(decodeCodexStructuredUserText(wire).text).toBe("survives degraded discovery");

    accountStore.seedAccountRegistry("codex", registry);
    const repaired = accounts.codexSessionRootInventory();
    expect(repaired.complete).toBeTrue();
    expect((await collectStructuredUserMetadata({ complete: true, listedAt, sources: [] }, {
      roots: repaired.roots, rootsComplete: () => repaired.complete,
    })).removed).toBe(0);
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("5".repeat(64));
  } finally {
    if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
    else process.env.LLV_CODEX_HOME = previousCodexHome;
  }
}));

test("a source changed while publication admission is held refuses deletion", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("admission race fixture", "6".repeat(64));
  await age(root);
  const source = join(root, "admission-race.jsonl");
  await writeFile(source, "initial");
  const lock = join(root, "structured-user-metadata-publication");
  let entered!: () => void, release!: () => void, census!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const checked = new Promise<void>(resolve => { census = resolve; });
  let checks = 0;
  const holder = withFileTransaction(lock, "fixture busy", async () => { entered(); await held; });
  await acquired;
  let collection: ReturnType<typeof collectStructuredUserMetadata> | undefined;
  try {
    const info = await stat(source);
    collection = collectStructuredUserMetadata({ complete: true, listedAt, sources: [
      { path: source, size: info.size, mtimeMs: info.mtimeMs, engine: "codex", project: "repo-fixture" },
    ] }, { current: () => { checks++; if (checks === 2) census(); return true; } });
    await checked;
    await writeFile(source, wire, { flag: "a" });
    release();
    await expect(collection).rejects.toThrow("changed");
    expect(checks).toBeGreaterThan(0);
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("6".repeat(64));
  } finally {
    release(); await collection?.catch(() => undefined); await holder;
  }
}));

test("collection cannot delete a record whose retry is awaiting file sync", async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("held retry fixture", "9".repeat(64));
  await age(root);
  let ready!: () => void, release!: () => void, discovered!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const census = new Promise<void>(resolve => { discovered = resolve; });
  const original = io.open;
  const open = spyOn(io, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { ready(); await held; await sync(); };
    }
    return handle;
  });
  const retry = encodeCodexStructuredUserText("held retry fixture", "9".repeat(64));
  let collection: ReturnType<typeof collectStructuredUserMetadata> | undefined;
  try {
    await entered;
    let checks = 0;
    collection = collectStructuredUserMetadata({ complete: true, listedAt, sources: [] }, {
      current: () => { if (++checks === 2) discovered(); return true; },
    });
    await census;
    release();
    expect(await retry).toBe(wire);
    expect((await collection).removed).toBe(0);
    expect(decodeCodexStructuredUserText(wire).contentDigest).toBe("9".repeat(64));
  } finally { release(); await retry; await collection; open.mockRestore(); }
}));

test("queued metadata remains live without a rollout; unavailable journal evidence refuses collection", async () => fixture(async root => {
  const { Database } = await import("bun:sqlite");
  const wire = await encodeCodexStructuredUserText("queued fixture", "d".repeat(64));
  await age(root);
  const db = new Database(join(root, "runtime-events.sqlite"));
  try {
    db.exec("CREATE TABLE native_queue_entries(state_json TEXT)");
    db.query("INSERT INTO native_queue_entries VALUES (?)").run(JSON.stringify({ versions: [{ input: [{ type: "text", text: wire }] }] }));
    expect((await collectStructuredUserMetadata({ complete: true, listedAt, sources: [] })).removed).toBe(0);
    expect(decodeCodexStructuredUserText(wire).text).toBe("queued fixture");
    db.exec("DROP TABLE native_queue_entries");
    await expect(collectStructuredUserMetadata({ complete: true, listedAt, sources: [] })).rejects.toThrow();
    expect(decodeCodexStructuredUserText(wire).text).toBe("queued fixture");
  } finally { db.close(); }
}));

for (const refused of [false, true]) test(`a retry renews grace and the daily collection bound survives restart (refused=${refused})`, async () => fixture(async root => {
  const wire = await encodeCodexStructuredUserText("retry fixture", "e".repeat(64));
  await age(root);
  expect(await encodeCodexStructuredUserText("retry fixture", "e".repeat(64))).toBe(wire);
  expect((await collectStructuredUserMetadata({ complete: true, listedAt, sources: [] })).removed).toBe(0);
  if (refused) {
    await expect(maybeCollectStructuredUserMetadata({ complete: true, listedAt, sources: [
      { path: join(root, "missing.jsonl"), size: 1, mtimeMs: 0, engine: "codex", project: "repo-fixture" },
    ] })).rejects.toThrow();
  } else await maybeCollectStructuredUserMetadata({ complete: true, listedAt, sources: [] });
  const checkpoint = await readFile(join(root, "structured-user-retention.json"), "utf8");
  const moduleUrl = new URL("./structuredUserMetadataRetention.ts", import.meta.url).href;
  // If the persisted throttle is ignored, this missing source makes the child
  // fail. The process gets no in-memory timer or cache from its predecessor.
  const child = Bun.spawn([process.execPath, "-e", `const m=await import(${JSON.stringify(moduleUrl)}); await m.maybeCollectStructuredUserMetadata({complete:true,sources:[{path:"missing-retained-fixture"}]});`],
    { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(await readFile(join(root, "structured-user-retention.json"), "utf8")).toBe(checkpoint);
  const ref = decodeWire(wire).metadataRef!;
  expect(structuredUserReferenceKey(ref)).toBeTruthy();
}));
