import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { beginProjectCatalogScan } from "@/lib/scanner/projectCatalog";
import type { ConversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { publishTranscriptIndexFeed } from "@/lib/scanner/discover";
import { SNIPPET_MATCH_CLOSE, SNIPPET_MATCH_OPEN, snippetSegments } from "./snippet";
import { scheduleTranscriptIndex, waitForTranscriptIndexIdleForTests } from "./transcriptFeed";
import {
  indexTranscriptSources,
  InvalidTranscriptSearchCursorError,
  readTranscriptActivity,
  searchTranscripts,
  TRANSCRIPT_RELEVANCE_PAGE_BYTES,
  transcriptSearchWorkerPath,
  type TranscriptIndexSource,
  type TranscriptSearchItem,
} from "./transcriptSearch";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-transcript-search-"));
const previousEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
};

function source(pathname: string, engine: "claude" | "codex" | "copilot", project: string): TranscriptIndexSource {
  const stat = fs.statSync(pathname);
  return { path: pathname, engine, project, size: stat.size, mtimeMs: stat.mtimeMs };
}

let stateSequence = 0;
beforeEach(() => {
  process.env.HOME = path.join(sandbox, "home");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  // A previous test's background worker must never open the next test's index.
  process.env.LLV_STATE_DIR = path.join(sandbox, `state-${++stateSequence}`);
  process.env.TMPDIR = path.join(sandbox, "tmp");
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("indexes Claude and Codex message bodies with jump metadata", async () => {
  const claude = path.join(sandbox, "claude-session.jsonl");
  const codex = path.join(sandbox, "codex-session.jsonl");
  fs.writeFileSync(claude, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T09:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Prepare the cobalt daily report" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T09:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "The cobalt report is ready" }] },
    }),
  ].join("\n") + "\n");
  fs.writeFileSync(codex, [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/fixture" } }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-20T10:00:00.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Cobalt appears inside the Codex answer" }],
      },
    }),
  ].join("\n") + "\n");

  await indexTranscriptSources([
    source(claude, "claude", "project-a"),
    source(codex, "codex", "project-b"),
  ], { complete: true });
  const result = searchTranscripts({ query: "cobalt", limit: 10 });

  expect(result.items).toHaveLength(3);
  expect(result.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      speaker: "user",
      timestamp: Date.parse("2026-08-20T09:00:00.000Z") / 1_000,
      transcriptPath: claude,
      byteOffset: 0,
      lineNumber: 1,
      project: "project-a",
      engine: "claude",
      snippet: expect.stringContaining("cobalt"),
    }),
    expect.objectContaining({
      speaker: "assistant",
      transcriptPath: codex,
      lineNumber: 2,
      project: "project-b",
      engine: "codex",
    }),
  ]));
  expect(result.stats).toEqual({
    conversationsIndexed: 2,
    messagesIndexed: 3,
    fieldsSearched: ["message.body"],
    tokenizer: "FTS5 unicode61, remove_diacritics=0, tokenchars=#_",
  });
});

test("indexes only Copilot user and assistant message content", async () => {
  const transcript = path.join(sandbox, "copilot-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user.message", timestamp: "2026-08-20T11:00:00.000Z", data: { content: "cobalt request from user" } }),
    JSON.stringify({ type: "model.message", timestamp: "2026-08-20T11:00:01.000Z", data: { content: "hidden_private_model_marker" } }),
    JSON.stringify({ type: "assistant.message", timestamp: "2026-08-20T11:00:02.000Z", data: { content: [{ type: "text", text: "cobalt answer from assistant" }] } }),
  ].join("\n") + "\n");

  await indexTranscriptSources([source(transcript, "copilot", "copilot-project")], { complete: true });

  const indexed = searchTranscripts({ query: "cobalt" });
  expect(indexed.total).toBe(2);
  expect(indexed.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ speaker: "user", engine: "copilot", transcriptPath: transcript }),
    expect.objectContaining({ speaker: "assistant", engine: "copilot", transcriptPath: transcript }),
  ]));
  expect(searchTranscripts({ query: "hidden_private_model_marker" }).total).toBe(0);
});

test("production scanner feed publishes Copilot transcripts for body indexing", async () => {
  const transcript = path.join(sandbox, "copilot-catalog-session", "events.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user.message", timestamp: "2026-08-20T11:00:00.000Z", data: { content: "feed_copilot_user_marker" } }),
    JSON.stringify({ type: "model.message", timestamp: "2026-08-20T11:00:01.000Z", data: { content: "feed_copilot_private_model_marker" } }),
    JSON.stringify({ type: "assistant.message", timestamp: "2026-08-20T11:00:02.000Z", data: { content: "feed_copilot_assistant_marker" } }),
  ].join("\n") + "\n");
  const catalog: ConversationCatalogEntry[] = [{
    path: transcript, root: "copilot-sessions", name: "session", project: "copilot-feed",
    title: "Copilot fixture", firstPrompt: "feed_copilot_user_marker", engine: "copilot",
    kind: "session", fmt: "copilot", mtime: Date.parse("2026-08-20T11:00:02.000Z") / 1_000,
    size: fs.statSync(transcript).size,
  }];
  publishTranscriptIndexFeed(catalog, true, beginProjectCatalogScan(false), undefined,
    (feed) => scheduleTranscriptIndex(feed, { force: true }));
  await waitForTranscriptIndexIdleForTests();

  expect(searchTranscripts({ query: "feed_copilot_user_marker" }).items).toMatchObject([
    expect.objectContaining({ speaker: "user", engine: "copilot", transcriptPath: transcript }),
  ]);
  expect(searchTranscripts({ query: "feed_copilot_assistant_marker" }).items).toMatchObject([
    expect.objectContaining({ speaker: "assistant", engine: "copilot", transcriptPath: transcript }),
  ]);
  expect(searchTranscripts({ query: "feed_copilot_private_model_marker" }).total).toBe(0);
});

test("matches Cyrillic hashtags and underscore tags as exact FTS tokens", async () => {
  const transcript = path.join(sandbox, "tagged-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T11:00:00.000Z",
      message: { role: "user", content: "Підготуй #тег за правилом cron_tag_sample" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T11:00:01.000Z",
      message: { role: "assistant", content: "Окрема #тегування використовує cron_tag_sample_extra" },
    }),
  ].join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "reports")], { complete: true });

  const hashtag = searchTranscripts({ query: "#тег" });
  const underscore = searchTranscripts({ query: "cron_tag_sample" });

  expect(hashtag.items).toHaveLength(1);
  expect(hashtag.items[0]).toMatchObject({ speaker: "user", transcriptPath: transcript });
  expect(underscore.items).toHaveLength(1);
  expect(underscore.items[0]).toMatchObject({ speaker: "user", transcriptPath: transcript });
});

test("returns bounded non-overlapping result pages", async () => {
  const transcript = path.join(sandbox, "paged-session.jsonl");
  fs.writeFileSync(transcript, Array.from({ length: 3 }, (_value, index) => JSON.stringify({
    type: index % 2 ? "assistant" : "user",
    timestamp: `2026-08-20T12:00:0${index}.000Z`,
    message: { content: `paginated cobalt message ${index}` },
  })).join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "pages")], { complete: true });

  const first = searchTranscripts({ query: "cobalt", limit: 2 });
  const second = searchTranscripts({ query: "cobalt", limit: 2, cursor: first.nextCursor });

  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  expect(first.total).toBe(3);
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((item) => item.byteOffset)).size).toBe(3);
});

test("mixed ages follow message time across engines and scopes, including duplicate representatives and undated records", async () => {
  const now = Date.UTC(2026, 7, 20) / 1_000;
  const ages = [42, 65, 38, 49, 12, 12, 51, 2];
  const sources: TranscriptIndexSource[] = [];
  for (const [index, age] of ages.entries()) {
    const engine = index % 2 ? "codex" : "claude";
    const pathname = path.join(sandbox, `age-${index}.jsonl`);
    const timestamp = new Date((now - age * 86400) * 1000).toISOString();
    // Increasing body length makes relevance produce the unsorted age sequence.
    const body = `zircon ${index} ${"filler ".repeat(index)}`;
    fs.writeFileSync(pathname, ["user", "assistant"].map((speaker) => JSON.stringify(engine === "claude"
      ? { type: speaker, timestamp, message: { content: body } }
      : { type: "event_msg", timestamp, payload: { type: speaker === "user" ? "user_message" : "agent_message", message: body } }
    )).join("\n") + "\n");
    sources.push({ ...source(pathname, engine, "ages"), mtimeMs: (now - index) * 1000 });
  }
  await indexTranscriptSources(sources);
  const db = new Database(statePath("transcript-search.sqlite"), { readonly: true });
  try {
    expect(legacySearch(db, "zircon", "user").items.map((item) => (now - item.timestamp!) / 86400)).toEqual(ages);
  } finally { db.close(); }
  for (const speaker of ["user", undefined] as const) {
    const items = everyPage("zircon", speaker, undefined, 3).items;
    expect(items.map((item) => (now - item.timestamp!) / 86400)).toEqual(
      (speaker ? ages : ages.flatMap((age) => [age, age])).sort((a, b) => a - b),
    );
  }

  const replay = path.join(sandbox, "age-replay.jsonl");
  fs.writeFileSync(replay, JSON.stringify({ type: "user", timestamp: new Date((now - 86400) * 1000).toISOString(), message: { content: "zircon 0" } }) + "\n");
  const undated = path.join(sandbox, "age-undated.jsonl");
  fs.writeFileSync(undated, JSON.stringify({ type: "user", message: { content: "zircon undated" } }) + "\n");
  await indexTranscriptSources([
    { ...source(replay, "claude", "ages"), mtimeMs: (now - 70 * 86400) * 1000 },
    { ...source(undated, "claude", "ages"), mtimeMs: (now - 20 * 86400) * 1000 },
  ]);
  const items = everyPage("zircon", "user", undefined, 2).items;
  expect(items[0]).toMatchObject({ transcriptPath: replay, timestamp: now - 86400, duplicateCount: 2 });
  expect(items.map((item) => (now - item.timestamp!) / 86400)).toEqual([1, 2, 12, 12, 20, 38, 49, 51, 65]);
});

test("a cursor continues its original match set when files grow and new duplicate groups arrive", async () => {
  const pathname = path.join(sandbox, "growing.jsonl");
  const line = (index: number) => JSON.stringify({ type: "user", timestamp: new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(), message: { content: `topaz entry ${index}` } }) + "\n";
  fs.writeFileSync(pathname, Array.from({ length: 6 }, (_, i) => line(i)).join(""));
  await indexTranscriptSources([{ ...source(pathname, "claude", "paging"), mtimeMs: 1000 }]);
  const original = searchTranscripts({ query: "topaz" });
  const first = searchTranscripts({ query: "topaz", limit: 2 });
  fs.appendFileSync(pathname, line(6));
  const replay = path.join(sandbox, "growing-replay.jsonl");
  fs.writeFileSync(replay, line(7).replace("entry 7", "entry 2") + line(8).replace("entry 8", "entry 5") + line(0).replace("entry 0", "late backfill"));
  await indexTranscriptSources([
    { ...source(pathname, "claude", "paging"), mtimeMs: 2000 },
    { ...source(replay, "claude", "paging"), mtimeMs: 3000 },
  ]);
  const items = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = searchTranscripts({ query: "topaz", limit: 2, cursor });
    expect(page.total).toBe(original.total);
    items.push(...page.items);
    cursor = page.nextCursor;
    expect(items.length).toBeLessThanOrEqual(original.total);
  }
  expect(items).toEqual(original.items);
  expect(searchTranscripts({ query: "topaz" }).total).toBe(8);
});

test("undated fallback times and tied IDs survive append, and deleted IDs are never reused", async () => {
  const pathname = path.join(sandbox, "undated-growth.jsonl");
  const line = (body: string) => JSON.stringify({ type: "user", message: { content: body } }) + "\n";
  fs.writeFileSync(pathname, line("opal first") + line("opal second") + line("opal third"));
  await indexTranscriptSources([{ ...source(pathname, "claude", "ties"), mtimeMs: 10_000 }]);
  const original = searchTranscripts({ query: "opal" });
  const first = searchTranscripts({ query: "opal", limit: 1 });
  fs.appendFileSync(pathname, line("opal fourth"));
  await indexTranscriptSources([{ ...source(pathname, "claude", "ties"), mtimeMs: 20_000 }]);
  const rest = searchTranscripts({ query: "opal", cursor: first.nextCursor });
  expect([...first.items, ...rest.items]).toEqual(original.items);
  expect(rest.items.map((item) => item.timestamp)).toEqual([10, 10]);
  expect(searchTranscripts({ query: "opal" }).items[0].timestamp).toBe(20);

  await indexTranscriptSources([], { complete: true });
  fs.writeFileSync(pathname, line("opal replacement"));
  await indexTranscriptSources([{ ...source(pathname, "claude", "ties"), mtimeMs: 1000 }]);
  expect(searchTranscripts({ query: "opal", cursor: first.nextCursor }).items).toEqual([]);
  expect(searchTranscripts({ query: "opal" }).total).toBe(1);
});

test("common queries sort only a bounded page of groups", async () => {
  const count = 4000;
  await indexTranscriptSources([{
    path: path.join(sandbox, "many-matches.jsonl"), project: "many", engine: "codex", size: count, mtimeMs: 1000,
  }], { readMessages: async function* () {
    for (let index = 0; index < count; index += 1) {
      yield { body: `garnet entry ${index}`, speaker: "user", timestamp: index % 97, byteOffset: index, lineNumber: index + 1 };
    }
  } });
  const originalSort = Array.prototype.sort;
  const sizes: number[] = [];
  Array.prototype.sort = function(compare) {
    sizes.push(this.length);
    return originalSort.call(this, compare);
  };
  try {
    const first = searchTranscripts({ query: "garnet", limit: 100 });
    const second = searchTranscripts({ query: "garnet", limit: 100, cursor: first.nextCursor });
    expect(first.total).toBe(count);
    expect(second.items).toHaveLength(100);
    expect(new Set([...first.items, ...second.items].map((item) => item.byteOffset)).size).toBe(200);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(101);
  } finally {
    Array.prototype.sort = originalSort;
  }
});

test("rejects legacy, malformed and cross-query cursors", async () => {
  const pathname = path.join(sandbox, "cursor-validation.jsonl");
  fs.writeFileSync(pathname, ["one", "two"].map((body) => JSON.stringify({ type: "user", message: { content: `jade ${body}` } })).join("\n") + "\n");
  await indexTranscriptSources([source(pathname, "claude", "cursors")]);
  const cursor = searchTranscripts({ query: "jade", limit: 1 }).nextCursor!;
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString());
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const invalid of ["broken", encode(null), encode({ version: 1, offset: 1, scope: payload.scope }),
    encode({ ...payload, timestamp: null }), encode({ ...payload, id: payload.throughId + 1 })]) {
    expect(() => searchTranscripts({ query: "jade", cursor: invalid })).toThrow(InvalidTranscriptSearchCursorError);
  }
  expect(() => searchTranscripts({ query: "other", cursor })).toThrow(InvalidTranscriptSearchCursorError);
  expect(() => searchTranscripts({ query: "jade", project: "cursors", cursor })).toThrow(InvalidTranscriptSearchCursorError);
});

test("collapses resume-replayed bodies after whitespace normalization and keeps the newest rollout", async () => {
  const oldest = path.join(sandbox, "rollout-oldest.jsonl");
  const middle = path.join(sandbox, "rollout-middle.jsonl");
  const newest = path.join(sandbox, "rollout-newest.jsonl");
  fs.writeFileSync(oldest, JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-20T08:00:00.000Z",
    payload: { type: "user_message", message: "  resume   cobalt\nrequest  " },
  }) + "\n");
  fs.writeFileSync(middle, [
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:00:00.000Z",
      payload: { type: "user_message", message: "resume cobalt\trequest" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:01:00.000Z",
      payload: { type: "agent_message", message: "resume cobalt request" },
    }),
  ].join("\n") + "\n");
  fs.writeFileSync(newest, [
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:00:00.000Z",
      payload: { type: "user_message", message: "resume cobalt request" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:02:00.000Z",
      payload: { type: "user_message", message: "Resume cobalt request" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:03:00.000Z",
      payload: { type: "user_message", message: "cobalt follow-up" },
    }),
  ].join("\n") + "\n");
  const sources = [
    { ...source(oldest, "codex", "resume"), mtimeMs: 1_000 },
    { ...source(middle, "codex", "resume"), mtimeMs: 2_000 },
    { ...source(newest, "codex", "resume"), mtimeMs: 3_000 },
  ];
  await indexTranscriptSources(sources, { complete: true });

  const first = searchTranscripts({ query: "cobalt", limit: 2 });
  const second = searchTranscripts({ query: "cobalt", limit: 2, cursor: first.nextCursor });
  const items = [...first.items, ...second.items];
  const replay = items.find((item) => item.duplicateCount === 3);

  expect(first.total).toBe(4);
  expect(second.total).toBe(4);
  expect(first.items).toHaveLength(2);
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(replay).toMatchObject({
    speaker: "user",
    transcriptPath: newest,
    duplicateCount: 3,
  });
  expect(items.filter((item) => item.duplicateCount === 1)).toHaveLength(3);
  expect(new Set(items.map((item) => `${item.speaker}:${item.transcriptPath}:${item.lineNumber}`)).size).toBe(4);
  expect(first.stats).toMatchObject({ conversationsIndexed: 3, messagesIndexed: 6 });
});

test("migrates a version-one index in bounded batches without reopening unchanged files", async () => {
  const filename = statePath("transcript-search.sqlite");
  const transcript = path.join(sandbox, "legacy-migration.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "legacy cobalt body" } }) + "\n");
  const legacySource = source(transcript, "codex", "legacy");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.exec(`
    CREATE TABLE transcript_files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      project TEXT NOT NULL,
      engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex')),
      messages_count INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE transcript_messages (
      id INTEGER PRIMARY KEY,
      transcript_path TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant')),
      timestamp INTEGER,
      byte_offset INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      body TEXT NOT NULL,
      UNIQUE(transcript_path, message_index),
      FOREIGN KEY(transcript_path) REFERENCES transcript_files(path) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE transcript_messages_fts USING fts5(
      body,
      tokenize = "unicode61 remove_diacritics 0 tokenchars '#_'"
    );
    PRAGMA user_version = 1;
  `);
  db.query("INSERT INTO transcript_files VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    legacySource.path,
    legacySource.size,
    legacySource.mtimeMs,
    legacySource.project,
    legacySource.engine,
    513,
    1,
  );
  const insertMessage = db.query(
    "INSERT INTO transcript_messages VALUES (?, ?, ?, 'user', ?, ?, ?, ?)",
  );
  const insertFts = db.query("INSERT INTO transcript_messages_fts(rowid, body) VALUES (?, ?)");
  for (let index = 0; index < 513; index += 1) {
    const body = `legacy cobalt body ${index}`;
    insertMessage.run(index + 1, legacySource.path, index, index + 1, index, index + 1, body);
    insertFts.run(index + 1, body);
  }
  db.close();

  const migrationReadSizes: number[] = [];
  const originalQuery = Database.prototype.query;
  Database.prototype.query = function query(this: Database, sql: string) {
    const statement = originalQuery.call(this, sql);
    if (!sql.includes("SELECT id, body FROM transcript_messages WHERE body_hash IS NULL")) return statement;
    const originalAll = statement.all.bind(statement);
    statement.all = ((...bindings: Parameters<typeof statement.all>) => {
      const rows = originalAll(...bindings);
      migrationReadSizes.push(rows.length);
      return rows;
    }) as typeof statement.all;
    return statement;
  } as typeof Database.prototype.query;
  try {
    expect(searchTranscripts({ query: "cobalt" }).total).toBe(513);
  } finally {
    Database.prototype.query = originalQuery;
  }

  const migrated = new Database(filename, { readonly: true, strict: true });
  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(5);
  expect(migrated.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM transcript_messages WHERE body_hash IS NULL OR length(body_hash) != 64",
  ).get()?.count).toBe(0);
  migrated.close();

  let opens = 0;
  const readMessages = async function* () {
    opens += 1;
    yield { body: "unexpected", speaker: "user" as const, timestamp: null, byteOffset: 0, lineNumber: 1 };
  };
  const indexed = await indexTranscriptSources([legacySource], { complete: true, readMessages });

  expect(migrationReadSizes).toEqual([256, 256, 1]);
  expect(indexed).toMatchObject({ filesRead: 0, filesSkipped: 1, failures: [] });
  expect(opens).toBe(0);
});

test("upgrades version two with file-time fallbacks and a persistent ID watermark", async () => {
  const pathname = path.join(sandbox, "version-two.jsonl");
  fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: "beryl undated" } }) + "\n");
  await indexTranscriptSources([{ ...source(pathname, "claude", "migration"), mtimeMs: 12_345 }]);
  const filename = statePath("transcript-search.sqlite");
  const old = new Database(filename);
  old.exec("ALTER TABLE transcript_messages DROP COLUMN sort_timestamp; DROP TABLE transcript_search_sequence; PRAGMA user_version = 2;");
  old.close();
  expect(searchTranscripts({ query: "beryl" }).items[0].timestamp).toBe(12.345);
  const upgraded = new Database(filename, { readonly: true });
  try {
    expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(upgraded.query("SELECT last_id FROM transcript_search_sequence").get()).toEqual({ last_id: 1 });
  } finally { upgraded.close(); }
});

test("failed reindex rolls back retained rows, FTS changes and the ID watermark together", async () => {
  const pathname = path.join(sandbox, "failed-reindex.jsonl");
  fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: "beryl original" } }) + "\n");
  const originalSource = { ...source(pathname, "claude", "rollback"), mtimeMs: 1000 };
  await indexTranscriptSources([originalSource]);
  const original = searchTranscripts({ query: "beryl" });
  const result = await indexTranscriptSources([{ ...originalSource, mtimeMs: 2000 }], {
    readMessages: async function* () {
      yield { body: "beryl replacement", speaker: "user", timestamp: null, byteOffset: 0, lineNumber: 1 };
      throw new Error("fixture read interrupted");
    },
  });
  expect(result.failures).toHaveLength(1);
  expect(searchTranscripts({ query: "beryl" })).toEqual(original);
  expect(searchTranscripts({ query: "replacement" }).total).toBe(0);
  const db = new Database(statePath("transcript-search.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT last_id FROM transcript_search_sequence").get()).toEqual({ last_id: 1 });
  } finally { db.close(); }
});

test("searches all projects by default and explains a scoped empty result", async () => {
  const firstPath = path.join(sandbox, "first-project.jsonl");
  const secondPath = path.join(sandbox, "second-project.jsonl");
  fs.writeFileSync(firstPath, JSON.stringify({ type: "user", message: { content: "shared heliotrope term" } }) + "\n");
  fs.writeFileSync(secondPath, JSON.stringify({ type: "assistant", message: { content: "shared heliotrope term" } }) + "\n");
  await indexTranscriptSources([
    source(firstPath, "claude", "project-a"),
    source(secondPath, "claude", "project-b"),
  ], { complete: true });

  expect(searchTranscripts({ query: "heliotrope" }).items).toHaveLength(2);
  expect(searchTranscripts({ query: "heliotrope", project: "project-a" }).items)
    .toEqual([expect.objectContaining({ project: "project-a" })]);

  const empty = searchTranscripts({ query: "missing", project: "project-a" });
  expect(empty.items).toEqual([]);
  expect(empty.stats).toEqual({
    conversationsIndexed: 2,
    messagesIndexed: 2,
    fieldsSearched: ["message.body"],
    tokenizer: "FTS5 unicode61, remove_diacritics=0, tokenchars=#_",
  });
});

test("does not reopen an unchanged transcript on the next index pass", async () => {
  const transcript = path.join(sandbox, "unchanged-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "fixture" } }) + "\n");
  const indexedSource = source(transcript, "claude", "performance");
  let opens = 0;
  const readMessages = async function* () {
    opens += 1;
    yield {
      body: "incremental heliotrope fixture",
      speaker: "user" as const,
      timestamp: null,
      byteOffset: 0,
      lineNumber: 1,
    };
  };

  const first = await indexTranscriptSources([indexedSource], { complete: true, readMessages });
  const second = await indexTranscriptSources([indexedSource], { complete: true, readMessages });
  await indexTranscriptSources([{ ...indexedSource, project: "performance-renamed" }], { complete: true, readMessages });

  expect(first).toMatchObject({ filesRead: 1, filesSkipped: 0 });
  expect(second).toMatchObject({ filesRead: 0, filesSkipped: 1 });
  expect(opens).toBe(1);
  expect(searchTranscripts({ query: "heliotrope", project: "performance" }).projectScope).toMatchObject({ resolved: null });
  expect(searchTranscripts({ query: "heliotrope", project: "performance-renamed" }).items).toHaveLength(1);
});

test("indexes Codex event messages while collapsing their response-item mirrors", async () => {
  const transcript = path.join(sandbox, "codex-event-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-20T13:00:00.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate user body" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T13:00:00.001Z",
      payload: { type: "user_message", message: "duplicate user body" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T13:00:01.000Z",
      payload: { type: "agent_message", message: "event-only answer with #тег" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-20T13:00:02.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "duplicated assistant body" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T13:00:02.001Z",
      payload: { type: "agent_message", message: "duplicated assistant body" },
    }),
  ].join("\n") + "\n");

  await indexTranscriptSources([source(transcript, "codex", "events")], { complete: true });

  expect(searchTranscripts({ query: '"duplicate"' }).items).toHaveLength(1);
  expect(searchTranscripts({ query: '"duplicated"' }).items).toHaveLength(1);
  expect(searchTranscripts({ query: "#тег" }).items)
    .toEqual([expect.objectContaining({ speaker: "assistant", lineNumber: 3 })]);
  expect(searchTranscripts({ query: "body" }).stats.messagesIndexed).toBe(3);
});

test("serves the committed index while a changed transcript is rebuilding", async () => {
  const transcript = path.join(sandbox, "rebuilding-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "old marigold body" } }) + "\n");
  await indexTranscriptSources([source(transcript, "claude", "rebuild")], { complete: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "new marigold body" } }) + "\n");
  const changed = source(transcript, "claude", "rebuild");
  changed.mtimeMs += 1_000;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readMessages = async function* () {
    markStarted();
    await gate;
    yield {
      body: "new marigold body",
      speaker: "user" as const,
      timestamp: null,
      byteOffset: 0,
      lineNumber: 1,
    };
  };
  const rebuilding = indexTranscriptSources([changed], { complete: true, readMessages });
  await started;

  // The rebuild is held at its gate, so this answer can only come from the committed index.
  const during = searchTranscripts({ query: "old" });

  expect(during.items).toHaveLength(1);
  release();
  await rebuilding;
  expect(searchTranscripts({ query: "old" }).items).toEqual([]);
  expect(searchTranscripts({ query: "new" }).items).toHaveLength(1);
});

test("continues the backfill when one discovered transcript becomes unreadable", async () => {
  const vanished = path.join(sandbox, "vanished-session.jsonl");
  const readable = path.join(sandbox, "readable-session.jsonl");
  fs.writeFileSync(vanished, "fixture\n");
  fs.writeFileSync(readable, "fixture\n");
  const sources = [
    source(vanished, "claude", "resilient"),
    source(readable, "claude", "resilient"),
  ];
  const readMessages = async function* (indexed: TranscriptIndexSource) {
    if (indexed.path === vanished) throw new Error("transcript disappeared");
    yield {
      body: "resilient periwinkle body",
      speaker: "assistant" as const,
      timestamp: null,
      byteOffset: 0,
      lineNumber: 1,
    };
  };

  const indexed = await indexTranscriptSources(sources, { complete: true, readMessages });

  expect(indexed.failures).toEqual([{ path: vanished, error: "transcript disappeared" }]);
  expect(searchTranscripts({ query: "periwinkle" }).items)
    .toEqual([expect.objectContaining({ transcriptPath: readable })]);
});

test("speaker=user searches only the operator's own messages", async () => {
  const transcript = path.join(sandbox, "speaker-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T15:00:00.000Z",
      message: { content: "find the marigold invoice I sent" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T15:00:04.000Z",
      message: { content: "the marigold invoice is attached" },
    }),
  ].join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "speakers")], { complete: true });

  const mine = searchTranscripts({ query: "marigold", speaker: "user" });
  const theirs = searchTranscripts({ query: "marigold", speaker: "assistant" });
  const both = searchTranscripts({ query: "marigold" });

  expect(mine.total).toBe(1);
  expect(mine.items).toEqual([expect.objectContaining({ speaker: "user" })]);
  expect(theirs.total).toBe(1);
  expect(theirs.items).toEqual([expect.objectContaining({ speaker: "assistant" })]);
  expect(both.total).toBe(2);
  /* The zero answer stays trustworthy: the corpus line reports the whole
     index, not the filtered slice. */
  expect(searchTranscripts({ query: "absent", speaker: "user" }).stats.messagesIndexed).toBe(2);
});

test("a cursor minted for one speaker scope cannot replay under another", async () => {
  const transcript = path.join(sandbox, "speaker-pages.jsonl");
  fs.writeFileSync(transcript, Array.from({ length: 4 }, (_value, index) => JSON.stringify({
    type: index % 2 ? "assistant" : "user",
    timestamp: `2026-08-20T16:00:0${index}.000Z`,
    message: { content: `periwinkle page ${index}` },
  })).join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "speaker-pages")], { complete: true });

  const first = searchTranscripts({ query: "periwinkle", speaker: "user", limit: 1 });
  expect(first.total).toBe(2);
  expect(first.nextCursor).not.toBeNull();

  const second = searchTranscripts({ query: "periwinkle", speaker: "user", limit: 1, cursor: first.nextCursor });
  expect(second.items).toEqual([expect.objectContaining({ speaker: "user" })]);
  expect(second.nextCursor).toBeNull();

  expect(() => searchTranscripts({ query: "periwinkle", limit: 1, cursor: first.nextCursor }))
    .toThrow(InvalidTranscriptSearchCursorError);
  expect(() => searchTranscripts({ query: "periwinkle", speaker: "assistant", limit: 1, cursor: first.nextCursor }))
    .toThrow(InvalidTranscriptSearchCursorError);
});

test("snippets mark matched terms with sentinels a message body cannot contain", async () => {
  const transcript = path.join(sandbox, "snippet-markers.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T17:00:00.000Z",
    message: { content: "read rows[0] then log the cobalt totals" },
  }) + "\n");
  await indexTranscriptSources([source(transcript, "claude", "markers")], { complete: true });

  const snippet = searchTranscripts({ query: "cobalt" }).items[0]!.snippet;

  expect(snippetSegments(snippet)).toEqual(expect.arrayContaining([
    { text: "cobalt", match: true },
  ]));
  /* The brackets the operator typed stay plain text — the defect the sentinel
     delimiters exist to kill. */
  expect(snippet).toContain("rows[0]");
  expect(snippetSegments(snippet).filter((segment) => segment.match))
    .toEqual([{ text: "cobalt", match: true }]);
});

/* The old SQL remains a relevance-order reproduction oracle. The newest
   variant independently checks the production heap and duplicate selection. */
function legacySearch(
  db: Database,
  rawQuery: string,
  speaker?: "user" | "assistant",
  project?: string,
  newest = false,
): { total: number; items: Omit<TranscriptSearchItem, never>[] } {
  const query = rawQuery.trim().split(/\s+/).filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
  const filters: Array<{ clause: string; binding: string }> = [];
  if (project) filters.push({ clause: " AND f.project = ?", binding: project });
  if (speaker) filters.push({ clause: " AND m.speaker = ?", binding: speaker });
  const where = filters.map((filter) => filter.clause).join("");
  const bindings = [query, ...filters.map((filter) => filter.binding)];
  const total = (db.query(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT m.speaker, m.body_hash
      FROM transcript_messages_fts
      JOIN transcript_messages AS m ON m.id = transcript_messages_fts.rowid
      JOIN transcript_files AS f ON f.path = m.transcript_path
      WHERE transcript_messages_fts MATCH ?${where}
      GROUP BY m.speaker, m.body_hash
    ) AS collapsed
  `).get(...bindings) as { count: number }).count;
  const rows = db.query(`
    WITH ranked AS (
      SELECT
        m.id, m.speaker, ${newest ? "m.sort_timestamp" : "m.timestamp"} AS timestamp,
        m.transcript_path, m.byte_offset, m.line_number, f.project, f.engine, f.mtime_ms,
        COUNT(*) OVER (PARTITION BY m.speaker, m.body_hash) AS duplicate_count,
        ROW_NUMBER() OVER (
          PARTITION BY m.speaker, m.body_hash
          ORDER BY ${newest ? "m.sort_timestamp DESC, m.id DESC" : "f.mtime_ms DESC, COALESCE(m.timestamp, 0) DESC, m.id DESC"}
        ) AS duplicate_rank
      FROM transcript_messages_fts
      JOIN transcript_messages AS m ON m.id = transcript_messages_fts.rowid
      JOIN transcript_files AS f ON f.path = m.transcript_path
      WHERE transcript_messages_fts MATCH ?${where}
    )
    SELECT
      snippet(transcript_messages_fts, 0, '${SNIPPET_MATCH_OPEN}', '${SNIPPET_MATCH_CLOSE}', '…', 24) AS snippet,
      ranked.speaker, ranked.duplicate_count, ranked.timestamp, ranked.transcript_path,
      ranked.byte_offset, ranked.line_number, ranked.project, ranked.engine
    FROM ranked
    JOIN transcript_messages_fts ON transcript_messages_fts.rowid = ranked.id
    WHERE ranked.duplicate_rank = 1 AND transcript_messages_fts MATCH ?
    ORDER BY ${newest ? "ranked.timestamp DESC, ranked.id DESC" : "bm25(transcript_messages_fts), ranked.mtime_ms DESC, COALESCE(ranked.timestamp, 0) DESC, ranked.id DESC"}
    LIMIT ? OFFSET ?
  `).all(...bindings, query, 10_000, 0) as Array<{
    snippet: string;
    speaker: "user" | "assistant";
    duplicate_count: number;
    timestamp: number | null;
    transcript_path: string;
    byte_offset: number;
    line_number: number;
    project: string;
    engine: "claude" | "codex";
  }>;
  return {
    total,
    items: rows.map((row) => ({
      snippet: row.snippet,
      speaker: row.speaker,
      duplicateCount: row.duplicate_count,
      timestamp: row.timestamp,
      transcriptPath: row.transcript_path,
      byteOffset: row.byte_offset,
      lineNumber: row.line_number,
      project: row.project,
      engine: row.engine,
    })),
  };
}

function everyPage(query: string, speaker: "user" | "assistant" | undefined, project: string | undefined, limit: number) {
  const items: TranscriptSearchItem[] = [];
  let cursor: string | null = null;
  let total = 0;
  let pages = 0;
  do {
    const page = searchTranscripts({ query, speaker, project, limit, cursor });
    items.push(...page.items);
    total = page.total;
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 500) throw new Error("pagination did not terminate");
  } while (cursor);
  return { items, total };
}

test("newest-first heap, collapse and paging agree with an independent SQL ordering oracle", async () => {
  /* A seeded corpus dense in the ways that exercise every tie-break: an
     eight-word vocabulary so scores collide, bodies repeated across files with
     whitespace variants so groups span transcripts, five distinct mtimes
     shared by many files, some records without timestamps. */
  let seed = 1_429;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const words = ["cobalt", "marigold", "saffron", "report", "ledger", "totals", "weekly", "draft"];
  const pool: string[] = [];
  const sources: TranscriptIndexSource[] = [];
  for (let file = 0; file < 24; file += 1) {
    const engine = file % 2 ? "codex" : "claude";
    const lines: string[] = [];
    for (let index = 0; index < 4 + (file % 9); index += 1) {
      let body: string;
      if (pool.length && random() < 0.35) {
        body = pool[Math.floor(random() * pool.length)]!.replace(" ", random() < 0.5 ? "  " : "\n");
      } else {
        body = Array.from({ length: 1 + Math.floor(random() * 6) }, () => words[Math.floor(random() * words.length)]!).join(" ");
        pool.push(body);
      }
      const speaker = index % 3 === 0 ? "user" : "assistant";
      const timestamp = random() < 0.15
        ? undefined
        : new Date(Date.UTC(2026, 7, 20, 0, 0, Math.floor(random() * 3_600))).toISOString();
      lines.push(JSON.stringify(engine === "claude"
        ? { type: speaker, ...(timestamp ? { timestamp } : {}), message: { content: body } }
        : {
          type: "event_msg",
          ...(timestamp ? { timestamp } : {}),
          payload: { type: speaker === "user" ? "user_message" : "agent_message", message: body },
        }));
    }
    const pathname = path.join(sandbox, `differential-${file}.jsonl`);
    fs.writeFileSync(pathname, lines.join("\n") + "\n");
    sources.push({ ...source(pathname, engine, `project-${file % 3}`), mtimeMs: 1_000 + (file % 5) * 1_000 });
  }
  await indexTranscriptSources(sources, { complete: true });

  const db = new Database(statePath("transcript-search.sqlite"), { readonly: true, strict: true });
  try {
    let compared = 0;
    let collapsed = 0;
    for (const query of ["cobalt", "cobalt report", "ledger", "weekly totals draft"]) {
      for (const speaker of [undefined, "user", "assistant"] as const) {
        for (const project of [undefined, "project-1"]) {
          const expected = legacySearch(db, query, speaker, project, true);
          const actual = everyPage(query, speaker, project, 3);
          expect(actual.total).toBe(expected.total);
          expect(actual.items).toEqual(expected.items);
          compared += expected.items.length;
          collapsed += expected.items.filter((item) => item.duplicateCount > 1).length;
        }
      }
    }
    /* The pin only means something if the corpus produced the cases. */
    expect(compared).toBeGreaterThan(100);
    expect(collapsed).toBeGreaterThan(10);
  } finally {
    db.close();
  }
});

test("message time precedes file time, with persistent IDs breaking equal-time ties", async () => {
  /* Two-token bodies with one hit each score identically under bm25, so only
     the tie-break decides the order. */
  const older = path.join(sandbox, "tie-older.jsonl");
  const newer = path.join(sandbox, "tie-newer.jsonl");
  fs.writeFileSync(older, JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T10:00:00.000Z",
    message: { content: "cobalt gamma" },
  }) + "\n");
  fs.writeFileSync(newer, [
    JSON.stringify({ type: "user", timestamp: "2026-08-20T08:00:00.000Z", message: { content: "cobalt alpha" } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-20T09:00:00.000Z", message: { content: "cobalt beta" } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-20T09:00:00.000Z", message: { content: "cobalt delta" } }),
  ].join("\n") + "\n");
  await indexTranscriptSources([
    { ...source(older, "claude", "ties"), mtimeMs: 1_000 },
    { ...source(newer, "claude", "ties"), mtimeMs: 3_000 },
  ], { complete: true });

  const items = searchTranscripts({ query: "cobalt" }).items;

  expect(items.map((item) => [path.basename(item.transcriptPath), item.lineNumber])).toEqual([
    ["tie-older.jsonl", 1],
    ["tie-newer.jsonl", 3],
    ["tie-newer.jsonl", 2],
    ["tie-newer.jsonl", 1],
  ]);
});

async function rankedFixture(rows: Array<[string, string[]]>) {
  const sources = rows.concat([["filler", Array.from({ length: 100 }, (_, i) => `mundane fixture ${i}`)]]).map(([name, bodies]) => {
    const pathname = path.join(sandbox, `${name}.jsonl`);
    fs.writeFileSync(pathname, bodies.map((content, i) => JSON.stringify({ type: "user", timestamp: new Date((100 + i) * 1000).toISOString(), message: { content } })).join("\n") + "\n");
    return source(pathname, "claude", "ranked-fixture");
  });
  await indexTranscriptSources(sources, { complete: true });
  return sources;
}

test("relevance covers a conversation across messages and selects complementary fragments", async () => {
  await rankedFixture([["complete", ["cobalt plan", "quartz solution"]], ["partial", ["cobalt repeat", "cobalt repeated again"]]]);
  const page = searchTranscripts({ query: "cobalt quartz", order: "relevance" });
  expect(page.items[0].transcriptPath).toEndWith("complete.jsonl");
  expect(page.items[0].matched).toEqual(["cobalt*", "quartz*"]);
  expect(page.items[0].missing).toEqual([]);
  expect(page.items[0].fragments).toHaveLength(1);
  expect(page.items[1].missing).toEqual(["quartz*"]);
  expect(page.strongTotal).toBe(1);
  expect(searchTranscripts({ query: "cobalt quartz", order: "newest" }).total).toBe(0);
});

test("disjoint rare words remain weak with the full query denominator on every page", async () => {
  const words = "cobalt quartz zircon opal beryl topaz garnet".split(" ");
  await rankedFixture(words.map((word) => [word, [`${word} unrelated answer`]]));
  let cursor: string | null = null;
  const paths = new Set<string>();
  do {
    const page = searchTranscripts({ query: words.join(" "), order: "relevance", limit: 1, cursor });
    expect(page.total).toBe(7);
    expect(page.strongTotal).toBe(0);
    expect(page.interpretedAs?.units).toHaveLength(7);
    expect(page.interpretedAs?.ignored).toEqual([]);
    expect(page.items[0].matched).toHaveLength(1);
    expect(page.items[0].missing).toHaveLength(6);
    paths.add(page.items[0].transcriptPath);
    cursor = page.nextCursor;
  } while (cursor);
  expect(paths.size).toBe(7);
});

test("quoted phrases, hyphenated terms and paths stay atomic when no strong hit exists", async () => {
  await rankedFixture([["split", ["cobalt unrelated answer", "quartz different task", "sign unrelated", "in different", "src unrelated", "search different", "ts elsewhere"]]]);
  for (const query of ['"cobalt quartz"', "sign-in", "src/search.ts"]) {
    const page = searchTranscripts({ query, order: "relevance" });
    expect(page.total).toBe(0);
    expect(page.strongTotal).toBe(0);
    expect(page.items).toEqual([]);
    expect(page.interpretedAs?.units).toHaveLength(1);
  }
});

test("relevance byte paging bounds long tokens and multibyte snippets without losing jump coordinates", async () => {
  const rows: Array<[string, string[]]> = Array.from({ length: 20 }, (_, i) => [
    `long-${i}-${"p".repeat(120)}`, [`cobalt ${i} ${"z".repeat(120000)}`, `quartz ${i} ${"界😀".repeat(30000)}`],
  ]);
  const sources = await rankedFixture(rows);
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = searchTranscripts({ query: "cobalt quartz", order: "relevance", limit: 100, cursor });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(TRANSCRIPT_RELEVANCE_PAGE_BYTES);
    for (const item of page.items) {
      expect(seen.has(item.transcriptPath)).toBe(false);
      seen.add(item.transcriptPath);
      expect(sources.some((s) => s.path === item.transcriptPath)).toBe(true);
      for (const fragment of [item, ...item.fragments!]) {
        expect(Buffer.byteLength(JSON.stringify(fragment.snippet))).toBeLessThanOrEqual(512);
        expect(fragment.snippet).not.toContain("\uFFFD");
        expect(fragment.snippet).toEndWith("…");
        expect(fragment.lineNumber).toBeGreaterThan(0);
        const record = JSON.parse(fs.readFileSync(item.transcriptPath).subarray(fragment.byteOffset).toString().split("\n")[0]);
        expect(record.message.content).toContain(fragment.snippet.replaceAll(SNIPPET_MATCH_OPEN, "").replaceAll(SNIPPET_MATCH_CLOSE, "").slice(0, -1));
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(20);
});

test("copies fold by lead snippet, common units are reported, and pages stay compact", async () => {
  await rankedFixture([["one", ["cobalt resolution"]], ["copy", ["cobalt resolution"]], ["other", ["cobalt different resolution"]]]);
  const page = searchTranscripts({ query: "the mundane cobalt", order: "relevance" });
  expect(page.interpretedAs?.ignored).toEqual(["the", "mundan*"]);
  expect(page.total).toBe(3);
  expect(page.items).toHaveLength(2);
  expect(page.items.find((i) => i.duplicateCount === 2)?.alsoIn).toMatchObject({ count: 1 });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(6144);
});

test("relevance groups copies across page boundaries before returning bounded links", async () => {
  const rows: Array<[string, number, string]> = [
    ["new-copy", 300, "cobalt repeated answer"],
    ["old-copy", 100, "cobalt repeated answer"],
    ["unique", 200, "cobalt unique answer"],
    ...Array.from({ length: 100 }, (_, i) => [`filler-${i}`, 400 + i, `filler material ${i}`] as [string, number, string]),
  ];
  const sources = rows.map(([name, timestamp, body]) => {
    const pathname = path.join(sandbox, `${name}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({
      type: "user", timestamp: new Date(timestamp * 1_000).toISOString(), message: { content: body },
    }) + "\n");
    return { ...source(pathname, "claude", "ranked-fixture"), mtimeMs: timestamp * 1_000 };
  });
  await indexTranscriptSources(sources, { complete: true });

  const first = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 });
  expect(first.items[0]).toMatchObject({ duplicateCount: 2, alsoIn: { count: 1 } });
  expect(first.items[0]!.alsoIn!.transcriptPaths).toContain(sources[1]!.path);
  expect(first.items[0]!.transcriptPath).toBe(sources[0]!.path);
  const second = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1, cursor: first.nextCursor });
  expect(second.items.map((item) => item.transcriptPath)).toContain(sources[2]!.path);

  const many = Array.from({ length: 40 }, (_, i) => [`copy-${i}`, 1_000 + i, "cobalt repeated answer"] as [string, number, string]);
  const manySources = many.map(([name, timestamp, body]) => {
    const pathname = path.join(sandbox, `${name}.jsonl`);
    fs.writeFileSync(pathname, JSON.stringify({
      type: "user", timestamp: new Date(timestamp * 1_000).toISOString(), message: { content: body },
    }) + "\n");
    return { ...source(pathname, "claude", "many-copies"), mtimeMs: timestamp * 1_000 };
  });
  await indexTranscriptSources(manySources, { complete: true });
  const crowded = searchTranscripts({ query: "cobalt", order: "relevance", project: "many-copies", limit: 6 });
  expect(crowded.items[0]).toMatchObject({ duplicateCount: 40, alsoIn: { count: 39 } });
  expect(crowded.items[0]!.alsoIn!.transcriptPaths).toHaveLength(3);
});

test("the measured prototype ignores absent vocabulary units explicitly without widening newest", async () => {
  await rankedFixture([["one", ["cobalt resolution"]]]);
  const page = searchTranscripts({ query: "cobalt never_indexed_token", order: "relevance" });
  expect(page.interpretedAs).toEqual({ units: ["cobalt*"], ignored: ["never_indexed_token"] });
  expect(page.strongTotal).toBe(1);
  expect(searchTranscripts({ query: "cobalt never_indexed_token", order: "newest" }).total).toBe(0);
  const absent = searchTranscripts({ query: "never_indexed_token the", order: "relevance" });
  expect(absent.total).toBe(0);
  expect(absent.strongTotal).toBe(0);
});

test("relevance cursors freeze ranking and folding across appends and reject the other order", async () => {
  const sources = await rankedFixture([["one", ["cobalt first"]], ["two", ["cobalt second"]], ["three", ["cobalt third"]]]);
  const expected = searchTranscripts({ query: "cobalt", order: "relevance" }).items.map((i) => i.transcriptPath);
  const first = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 });
  fs.appendFileSync(sources[0].path, JSON.stringify({ type: "user", timestamp: new Date(500_000).toISOString(), message: { content: "cobalt newest" } }) + "\n");
  await indexTranscriptSources([source(sources[0].path, "claude", "ranked-fixture")]);
  const items = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1, cursor });
    items.push(...next.items); cursor = next.nextCursor;
  }
  expect(items.map((i) => i.transcriptPath)).toEqual(expected);
  expect(() => searchTranscripts({ query: "cobalt", order: "newest", cursor: first.nextCursor })).toThrow(InvalidTranscriptSearchCursorError);
  expect(() => searchTranscripts({ query: "quartz", order: "relevance", cursor: first.nextCursor })).toThrow(InvalidTranscriptSearchCursorError);
});

test("relevance paging retains surviving conversations when the preceding hit is pruned", async () => {
  const sources = await rankedFixture([["first", ["cobalt first"]], ["second", ["cobalt second"]], ["third", ["cobalt third"]]]);
  const expected = searchTranscripts({ query: "cobalt", order: "relevance" }).items.map((i) => i.transcriptPath);
  const first = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 });
  await indexTranscriptSources(sources.filter((s) => s.path !== first.items[0].transcriptPath), { complete: true });
  const remaining: string[] = [];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1, cursor });
    remaining.push(...page.items.map((i) => i.transcriptPath));
    cursor = page.nextCursor;
  }
  expect(remaining).toEqual(expected.slice(1));
});

test("relevance paging keeps a surviving hit when tail truncation changes its score", async () => {
  const sources = await rankedFixture([
    ["one", ["cobalt A", ...Array.from({ length: 9 }, () => "unrelated detail")]],
    ["two", ["cobalt B", ...Array.from({ length: 19 }, () => "unrelated detail")]],
  ]);
  const first = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 });
  expect(first.items[0].transcriptPath).toBe(sources[0].path);
  fs.writeFileSync(sources[1].path, fs.readFileSync(sources[1].path, "utf8").split("\n")[0] + "\n");
  await indexTranscriptSources([source(sources[1].path, "claude", "ranked-fixture")]);
  const next = searchTranscripts({ query: "cobalt", order: "relevance", cursor: first.nextCursor });
  expect(next.items.map((item) => item.transcriptPath)).toEqual([sources[1].path]);
  expect(next.nextCursor).toBeNull();
});

test("newest preserves unicode61 dotted-I matches", async () => {
  await rankedFixture([["unicode", ["İstanbul itinerary"]]]);
  expect(searchTranscripts({ query: "İstanbul", order: "newest" }).total).toBe(1);
  expect(searchTranscripts({ query: "İstanbul", order: "relevance" }).total).toBe(1);
});

test("relevance vocabulary lookup follows unicode61 final-sigma and long-s folding", async () => {
  await rankedFixture([["unicode-folds", ["κόσμος itinerary", "ſample answer"]]]);
  for (const query of ["κόσμος", "ſample"]) {
    expect(searchTranscripts({ query, order: "newest" }).total).toBe(1);
    const ranked = searchTranscripts({ query, order: "relevance" });
    expect(ranked.total).toBe(1);
    expect(ranked.interpretedAs?.ignored).toEqual([]);
  }
});

test("legacy migration captures undated message time before indexing a grown source", async () => {
  const pathname = path.join(sandbox, "legacy-undated.jsonl");
  fs.writeFileSync(pathname, JSON.stringify({ type: "user", message: { content: "cobalt original" } }) + "\n");
  const original = { ...source(pathname, "claude", "legacy"), mtimeMs: 10000 };
  await indexTranscriptSources([original]);
  const db = new Database(statePath("transcript-search.sqlite"));
  db.exec(`DROP INDEX transcript_messages_search_hit;
    DROP INDEX transcript_messages_time;
    ALTER TABLE transcript_messages DROP COLUMN sort_timestamp;
    PRAGMA user_version = 2;`);
  db.close();
  fs.appendFileSync(pathname, JSON.stringify({ type: "user", message: { content: "quartz appended" } }) + "\n");
  await indexTranscriptSources([{ ...source(pathname, "claude", "legacy"), mtimeMs: 20000 }]);
  expect(searchTranscripts({ query: "cobalt", order: "newest" }).items[0].timestamp).toBe(10);
  expect(searchTranscripts({ query: "quartz", order: "newest" }).items[0].timestamp).toBe(20);
});

test("different lead bodies with the same sixteen-token snippet fold across page boundaries", async () => {
  const shared = "cobalt shared specification " + "details ".repeat(60);
  await rankedFixture([["first-copy", [shared + "stage alpha"]], ["second-copy", [shared + "stage beta"]], ["unique", ["cobalt independent answer"]]]);
  const first = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 });
  expect(first.items[0].duplicateCount).toBe(2);
  expect(first.items[0].alsoIn?.count).toBe(1);
  const next = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1, cursor: first.nextCursor });
  expect(next.items[0].snippet).toContain("independent");
  expect(next.nextCursor).toBeNull();
});

test("migrated activity date reads use the covering range index", async () => {
  await rankedFixture([["dated", ["cobalt dated answer"]]]);
  const original = Database.prototype.query;
  let activitySql = "";
  Database.prototype.query = function (this: Database, sql: string) {
    if (sql.includes("SELECT m.id, m.speaker, m.transcript_path, m.timestamp")) activitySql = sql;
    return original.call(this, sql);
  } as typeof original;
  try {
    const activity = readTranscriptActivity(0, 500);
    expect(activity.rows).toHaveLength(101);
  } finally { Database.prototype.query = original; }
  const db = new Database(statePath("transcript-search.sqlite"), { readonly: true });
  try {
    const plan = db.query<{ detail: string }, [number, number]>(`EXPLAIN QUERY PLAN ${activitySql}`).all(0, 500);
    expect(plan.map((row) => row.detail).join(" ")).toContain("USING COVERING INDEX transcript_messages_time (sort_timestamp>? AND sort_timestamp<?)");
  } finally { db.close(); }
});

test("malformed relevance cursor expressions cannot reach the FTS parser", async () => {
  await rankedFixture([["first", ["cobalt first"]], ["second", ["cobalt second"]]]);
  const first = searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 });
  const parsed = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString());
  for (const change of [{ expression: ":" }, { terms: null }, { terms: [{ term: "cobalt OR quartz", prefix: true }] }]) {
    const payload = { ...parsed, units: [{ ...parsed.units[0], ...change }] };
    const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => searchTranscripts({ query: "cobalt", order: "relevance", cursor })).toThrow(InvalidTranscriptSearchCursorError);
  }
});

test("v4 to v5 creates vocab without rewriting messages or the FTS index", async () => {
  await rankedFixture([["one", ["cobalt resolution"]]]);
  const db = new Database(statePath("transcript-search.sqlite"));
  const before = db.query("SELECT id, body_hash FROM transcript_messages ORDER BY id").all();
  db.exec("DROP TABLE transcript_messages_vocab; PRAGMA user_version = 4"); db.close();
  expect(searchTranscripts({ query: "cobalt", order: "relevance" }).total).toBe(1);
  const upgraded = new Database(statePath("transcript-search.sqlite"), { readonly: true });
  expect(upgraded.query("SELECT id, body_hash FROM transcript_messages ORDER BY id").all()).toEqual(before);
  const deadline = performance.now() + 5_000;
  let vocabulary: unknown = null;
  while (!vocabulary && performance.now() < deadline) {
    const exists = upgraded.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_messages_vocab'").get();
    if (exists) vocabulary = upgraded.query("SELECT term FROM transcript_messages_vocab WHERE term = 'cobalt'").get();
    if (vocabulary) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  expect(vocabulary).toEqual({ term: "cobalt" });
  upgraded.close();
});

test("first search stays responsive while a v4 copy builds its covering indexes", async () => {
  const pathname = path.join(sandbox, "large-v4.jsonl");
  fs.writeFileSync(pathname, Array.from({ length: 20_000 }, (_, i) => JSON.stringify({
    type: "user", timestamp: new Date((1_700_000_000 + i) * 1_000).toISOString(),
    message: { content: `cobalt migration fixture ${i}` },
  })).join("\n") + "\n");
  await indexTranscriptSources([source(pathname, "claude", "migration-fixture")], { complete: true });
  const db = new Database(statePath("transcript-search.sqlite"));
  db.exec(`
    DROP TABLE transcript_messages_vocab;
    DROP INDEX IF EXISTS transcript_messages_search_hit;
    DROP INDEX IF EXISTS transcript_messages_time;
    ALTER TABLE transcript_messages DROP COLUMN sort_timestamp;
    PRAGMA user_version = 4;
  `);
  db.close();

  let timerFiredAt = 0;
  const started = performance.now();
  const timer = setTimeout(() => { timerFiredAt = performance.now(); }, 0);
  expect(searchTranscripts({ query: "cobalt", order: "relevance", limit: 1 }).total).toBe(1);
  const firstSearchMs = performance.now() - started;
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  clearTimeout(timer);
  expect(timerFiredAt).toBeGreaterThan(0);
  expect(firstSearchMs).toBeLessThan(350);

  const deadline = performance.now() + 5_000;
  let built = false;
  while (!built && performance.now() < deadline) {
    const check = new Database(statePath("transcript-search.sqlite"), { readonly: true });
    check.exec("PRAGMA busy_timeout = 5000");
    built = Boolean(check.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='transcript_messages_search_hit'").get())
      && Boolean(check.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_messages_vocab'").get());
    check.close();
    if (!built) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  expect(built).toBe(true);
});

test("newest word forms include all old unquoted matches and order added inflections by time", async () => {
  await rankedFixture([["forms", ["login original", "logins later", "сохранённых record", "картки record", "#1533 record"]]]);
  const page = searchTranscripts({ query: "logins", order: "newest" });
  expect(page.items.map((i) => i.timestamp)).toEqual([101, 100]);
  for (const query of ["сохраненные", "картка", "1533"]) expect(searchTranscripts({ query }).total).toBeGreaterThan(0);
});


test("failed background workers report failure and a subsequent search retries migration", async () => {
  process.env.LLV_STATE_DIR = path.join(sandbox, "failed-worker-state");
  await rankedFixture([["worker-failure", ["cobalt quartz answer"]]]);
  const db = new Database(statePath("transcript-search.sqlite"));
  db.exec("DROP TABLE transcript_messages_vocab; DROP INDEX transcript_messages_search_hit;");
  db.close();
  const cwd = process.cwd();
  const isolatedCwd = path.join(sandbox, "broken-worker");
  fs.mkdirSync(path.join(isolatedCwd, "src/lib"), { recursive: true });
  fs.writeFileSync(path.join(isolatedCwd, "src/lib/transcriptSearchIndex.worker.ts"), "process.exit(17);\n");
  const error = console.error;
  const failures: string[] = [];
  console.error = (message) => failures.push(String(message));
  try {
    process.chdir(isolatedCwd);
    const partial = searchTranscripts({ query: "cobalt quartz", order: "relevance" });
    expect(partial.interpretedAs?.units).toHaveLength(2);
    expect(partial.items[0].missing).toHaveLength(1);
    expect(partial.strongTotal).toBe(0);
    const deadline = performance.now() + 5000;
    while (!failures.length && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failures[0]).toContain("status 17");
    process.chdir(cwd);
    searchTranscripts({ query: "cobalt quartz", order: "relevance" });
    while (performance.now() < deadline) {
      const probe = new Database(statePath("transcript-search.sqlite"), { readonly: true });
      const ready = probe.query("SELECT 1 FROM sqlite_master WHERE name='transcript_messages_search_hit'").get();
      probe.close();
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(searchTranscripts({ query: "cobalt quartz", order: "relevance" }).items[0].missing).toEqual([]);
  } finally {
    process.chdir(cwd);
    console.error = error;
  }
});

test.skipIf(!process.env.LLV_TRANSCRIPT_STANDALONE_DIR)("the real standalone worker migrates v4 and preserves IDs, hashes, FTS and ranked coverage", async () => {
  await rankedFixture([["standalone", ["cobalt plan", "quartz solution"]]]);
  const db = new Database(statePath("transcript-search.sqlite"));
  const before = db.query("SELECT id, body_hash FROM transcript_messages ORDER BY id").values();
  const fts = db.query("SELECT rowid, body FROM transcript_messages_fts ORDER BY rowid").values();
  db.exec(`DROP TABLE transcript_messages_vocab;
    DROP INDEX transcript_messages_search_hit;
    DROP INDEX transcript_messages_time;
    ALTER TABLE transcript_messages DROP COLUMN sort_timestamp;
    PRAGMA user_version = 4;`);
  db.close();
  const cwd = process.cwd();
  try {
    process.chdir(process.env.LLV_TRANSCRIPT_STANDALONE_DIR!);
    expect(transcriptSearchWorkerPath()).toEndWith(".next/server/transcript-search-index-worker.js");
    searchTranscripts({ query: "cobalt quartz", order: "relevance" });
    const deadline = performance.now() + 10000;
    let ready = false;
    while (!ready && performance.now() < deadline) {
      const probe = new Database(statePath("transcript-search.sqlite"), { readonly: true });
      probe.exec("PRAGMA busy_timeout = 5000");
      ready = Boolean(probe.query("SELECT 1 FROM sqlite_master WHERE name='transcript_messages_body_hash'").get());
      if (ready) {
        expect(probe.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
        expect(probe.query("SELECT id, body_hash FROM transcript_messages ORDER BY id").values()).toEqual(before);
        expect(probe.query("SELECT rowid, body FROM transcript_messages_fts ORDER BY rowid").values()).toEqual(fts);
        expect(probe.query("SELECT COUNT(*) AS n FROM transcript_messages_vocab").get()).toMatchObject({ n: expect.any(Number) });
      }
      probe.close();
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ready).toBe(true);
    const page = searchTranscripts({ query: "cobalt quartz", order: "relevance" });
    expect(page.strongTotal).toBe(1);
    expect(page.items[0].missing).toEqual([]);
    expect(page.items[0].fragments).toHaveLength(1);
  } finally { process.chdir(cwd); }
});
