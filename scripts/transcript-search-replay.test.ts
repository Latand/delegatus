import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baselinePage, recordedCalls, runReplay, seededSample } from "./transcript-search-replay";

test("extracts recorded Claude and Codex calls from invented fixtures", () => {
  const timestamp = "2026-09-01T00:00:00Z";
  const args = { query: "orion quartz", clientRequestId: "fixture-call" };
  const fixtures = [
    { timestamp, message: { content: [{ type: "tool_use", name: "mcp__viewer__search_transcripts", input: args }] } },
    { timestamp, payload: { type: "item_completed", item: { type: "McpToolCall", server: "viewer", tool: "search_transcripts", arguments: args } } },
    { timestamp, payload: { type: "mcp_tool_call_end", invocation: { server: "viewer", tool: "search_transcripts", arguments: args } } },
  ];
  for (const fixture of fixtures) expect(recordedCalls(fixture)).toEqual([{ tool: "search_transcripts", args, timestamp: Date.parse(timestamp) / 1000 }]);
  expect(recordedCalls({ timestamp, payload: { type: "mcp_tool_call_begin" } })).toEqual([]);
  expect(recordedCalls({ timestamp: "invalid", message: {} })).toEqual([]);
});

test("sampling is reproducible without mutating the inputs", () => {
  const values = Array.from({ length: 100 }, (_, i) => i);
  expect(seededSample(values, 10, 7)).toEqual(seededSample(values, 10, 7));
  expect(new Set(seededSample(values, 10, 7)).size).toBe(10);
  expect(values[0]).toBe(0);
});

test("baseline excludes future and issuing messages and uses newest body representatives", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE transcript_files(path TEXT, project TEXT);
    CREATE TABLE transcript_messages(id INTEGER PRIMARY KEY, speaker TEXT, body_hash TEXT, sort_timestamp REAL, transcript_path TEXT);
    CREATE VIRTUAL TABLE transcript_messages_fts USING fts5(body);
    INSERT INTO transcript_files VALUES('older','orion'),('newer','orion'),('issuer','orion'),('future','orion');
    INSERT INTO transcript_messages VALUES(1,'user','copy',10,'older'),(2,'user','copy',20,'newer'),(3,'user','self',10,'issuer'),(4,'user','later',100,'future');
    INSERT INTO transcript_messages_fts VALUES('quartz orion'),('quartz orion'),('quartz orion'),('quartz orion');`);
  try {
    expect(baselinePage(db, { query: "quartz orion", timestamp: 30, source: "issuer" })).toEqual({ total: 1, paths: ["newer"] });
    expect(baselinePage(db, { query: "quartz", timestamp: 30, source: "issuer", project: "unknown" }).total).toBe(0);
  } finally { db.close(); }
});

test("replay refuses linked indexes and copies inside a repository before opening SQLite", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-replay-guard-"));
  try {
    process.env.LLV_STATE_DIR = root;
    const original = path.join(root, "original.sqlite");
    const index = path.join(root, "transcript-search.sqlite");
    fs.writeFileSync(original, "invented fixture");
    fs.symlinkSync(original, index);
    await expect(runReplay([])).rejects.toThrow("separate regular index copy");
    fs.unlinkSync(index);
    fs.linkSync(original, index);
    await expect(runReplay([])).rejects.toThrow("separate regular index copy");
    fs.mkdirSync(path.join(root, ".git"));
    await expect(runReplay([])).rejects.toThrow("inside a repository");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
