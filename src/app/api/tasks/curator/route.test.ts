import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curator-route-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
const scanner = await import("@/lib/scanner");
const route = await import("./route");
const { loadTasks, saveTasks } = await import("@/lib/tasks/store");

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("curator reads propose inputs and only an explicit POST creates a task, preserving existing sources", async () => {
  const now = new Date().toISOString();
  const transcript = path.join(sandbox, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: now,
    message: { content: [{ type: "text", text: "Please implement a deploy retry." }] } }) + "\n");
  const entry: FileEntry = { path: transcript, name: "session.jsonl", root: "claude-projects", project: "fixture",
    title: "Fixture", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: Date.now() / 1000,
    size: fs.statSync(transcript).size, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null };
  const existing: BoardTask = { id: "retained", project: "fixture", status: "inbox", text: "Original task", placement: "unplaced",
    assignments: [], createdAt: now, updatedAt: now,
    source: { path: transcript, ts: now, text: "Original source", fingerprint: "retained-source", engine: "claude" } };
  saveTasks([existing]);
  const before = loadTasks();
  const scan = spyOn(scanner, "listFiles").mockResolvedValue([entry]);
  const url = "http://localhost/api/tasks/curator";
  const post = (proposals: unknown[]) => route.POST(new NextRequest(url, { method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" }, body: JSON.stringify({ proposals }) }));
  try {
    const read = await route.GET(new NextRequest(url, { headers: { host: "localhost", origin: "http://localhost" } }));
    expect(read.status).toBe(200);
    const { inputs } = await read.json();
    expect(inputs).toHaveLength(1);
    expect(loadTasks()).toEqual(before);
    const proposal = { inputId: inputs[0].id, title: "Add a deploy retry" };
    const applied = await post([proposal]);
    expect(applied.status).toBe(200);
    const result = await applied.json();
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ text: proposal.title, source: { path: transcript, ts: now, text: "Please implement a deploy retry.", engine: "claude" } });
    expect(loadTasks().find(task => task.id === existing.id)).toEqual(before[0]);
    const replay = await post([proposal]);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: [], skipped: [{ reason: "duplicate" }] });
    expect(loadTasks()).toHaveLength(2);
  } finally {
    scan.mockRestore();
  }
});
