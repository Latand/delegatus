import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { resourceWorkerRequestProblem } from "@/lib/resourceWorkerRequest";
import { readSession } from "@/lib/session/reader";
import { projectTimeline } from "@/lib/timeline";
import type { FileEntry } from "@/lib/types";
import { compactText } from "@/lib/view/compactText";

import {
  antigravityHeadFromRecords,
  antigravitySessionIdFromPath,
  antigravityStopReason,
  antigravityToolName,
  antigravityTurnState,
  isAntigravityTranscriptPath,
} from "./antigravityNative";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-antigravity-native-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const AT = "2026-11-23T20:00:00.000Z";
const rec = (type: string, data: Record<string, unknown> = {}, timestamp = AT) => ({
  type,
  data,
  id: crypto.randomUUID(),
  timestamp,
  parentId: null,
});

test("only a session directory's own events.jsonl is an Antigravity transcript", () => {
  const root = path.join(sandbox, "sessions");
  const session = crypto.randomUUID();
  expect(isAntigravityTranscriptPath(root, path.join(root, session, "events.jsonl"))).toBe(true);
  expect(isAntigravityTranscriptPath(root, path.join(root, "ag-review-session.1", "events.jsonl"))).toBe(true);
  expect(isAntigravityTranscriptPath(root, path.join(root, session, "delivery-acceptance.sqlite"))).toBe(false);
  expect(isAntigravityTranscriptPath(root, path.join(root, session, "nested", "events.jsonl"))).toBe(false);
  expect(isAntigravityTranscriptPath(root, path.join(root, ".hidden", "events.jsonl"))).toBe(false);
  expect(isAntigravityTranscriptPath(root, path.join(root, "bad..session", "events.jsonl"))).toBe(false);
  expect(isAntigravityTranscriptPath(root, path.join(root, "has space", "events.jsonl"))).toBe(false);
  expect(isAntigravityTranscriptPath(root, path.join(root, "a".repeat(129), "events.jsonl"))).toBe(false);
  expect(antigravitySessionIdFromPath(path.join(root, session.toUpperCase(), "events.jsonl"))).toBe(session);
  expect(antigravitySessionIdFromPath(path.join(root, "ag-review-session.1", "events.jsonl"))).toBe("ag-review-session.1");
  expect(antigravitySessionIdFromPath(path.join(root, "bad..session", "events.jsonl"))).toBeNull();
  expect(antigravitySessionIdFromPath(path.join(root, session, "delivery-acceptance.sqlite"))).toBeNull();
});

test("discoverFilesWithProjectCatalog discovers both UUID and host-valid non-UUID Antigravity session ids", async () => {
  const { discoverFilesWithProjectCatalog } = await import("./discover");
  const sessionsRoot = path.join(sandbox, "discover-sessions");
  const validIds = [crypto.randomUUID(), "ag-review-session.1"];
  for (const id of validIds) {
    const file = path.join(sessionsRoot, id, "events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(rec("session.start", { sessionId: id, cwd: sandbox }))}\n${JSON.stringify(rec("user.message", { content: "hi" }))}\n`);
  }
  const hidden = path.join(sessionsRoot, ".hidden", "events.jsonl");
  fs.mkdirSync(path.dirname(hidden), { recursive: true });
  fs.writeFileSync(hidden, `${JSON.stringify(rec("session.start", { sessionId: ".hidden", cwd: sandbox }))}\n`);

  const snap = await discoverFilesWithProjectCatalog([["antigravity-sessions", sessionsRoot]], undefined, { persist: false });
  expect(snap.complete).toBe(true);
  expect(validIds.map((id) => snap.files.some((f) => f.path === path.join(sessionsRoot, id, "events.jsonl")))).toEqual([true, true]);
  expect(snap.files.some((f) => f.path === hidden)).toBe(false);
});

test("antigravityTurnState tracks busy tool/message records and terminal stop events", () => {
  const user = rec("user.message", { content: "run check" });
  const active = [
    user,
    rec("assistant.turn_start", { turnId: "t1" }),
    rec("tool.execution_start", { toolCallId: "c1", toolName: "bash" }),
    rec("tool.execution_complete", { toolCallId: "c1", toolName: "bash", status: "completed" }),
    rec("assistant.message", { content: "Done." }),
  ];
  expect(antigravityTurnState(active).state).toBe("busy");
  expect(turnStateFromRecords(active, "antigravity").state).toBe("busy");

  const ended = [...active, rec("assistant.turn_end", { turnId: "t1", stopReason: "end_turn" })];
  expect(antigravityTurnState(ended)).toEqual({ state: "terminal", source: "lifecycle", terminalAt: AT });
  expect(turnStateFromRecords(ended, "antigravity")).toEqual({ state: "terminal", source: "lifecycle", terminalAt: AT });

  const quotaStopped = [user, rec("assistant.turn_start"), rec("session.quota_exhausted", { message: "RESOURCE_EXHAUSTED", resetsAt: 1_800_000_000 })];
  expect(antigravityTurnState(quotaStopped).state).toBe("terminal");
  expect(antigravityTurnState([...quotaStopped, rec("user.message", { content: "retry later" })]).state).toBe("busy");

  const aborted = [user, rec("assistant.turn_start"), rec("abort", { reason: "user_initiated" })];
  expect(antigravityTurnState(aborted).state).toBe("terminal");

  expect(antigravityTurnState([]).state).toBe("unknown");
  expect(antigravityTurnState([rec("future.unknown_event")]).state).toBe("unknown");
});

test("antigravityHeadFromRecords extracts cwd, model, effort, version, and first user message", () => {
  const head = antigravityHeadFromRecords([
    rec("session.start", {
      sessionId: "s-1",
      cwd: "/srv/fixture/repo",
      model: "gemini-4-neon",
      effort: "xhigh",
      agyVersion: "1.5.13",
    }),
    rec("session.model_change", { model: "gemini-3.8-flash", effort: "low" }),
    rec("user.message", { content: "first prompt" }),
    rec("user.message", { content: "second prompt" }),
  ]);
  expect(head).toMatchObject({
    sessionId: "s-1",
    cwd: "/srv/fixture/repo",
    model: "gemini-3.8-flash",
    effort: "low",
    agyVersion: "1.5.13",
    firstUserMessage: "first prompt",
    startedAt: AT,
  });
});

test("antigravityStopReason reports quota exhaustion, error, or abort and clears on normal completion", () => {
  const quota = [
    rec("user.message", { content: "go" }),
    rec("session.quota_exhausted", { message: "Individual quota reached", resetsAt: 1_800_000_123 }),
  ];
  expect(antigravityStopReason(quota)).toEqual({
    kind: "quota_exhausted",
    message: "Individual quota reached",
    resetsAt: 1_800_000_123,
    at: AT,
  });

  expect(antigravityStopReason([
    ...quota,
    rec("user.message", { content: "again" }),
    rec("assistant.turn_end", { stopReason: "end_turn" }),
  ])).toBeNull();

  expect(antigravityStopReason([
    rec("user.message", { content: "go" }),
    rec("session.error", { message: "upstream failure" }),
  ])).toEqual({ kind: "error", message: "upstream failure", resetsAt: null, at: AT });

  expect(antigravityStopReason([
    rec("user.message", { content: "go" }),
    rec("abort", { reason: "user_initiated" }),
  ])).toEqual({ kind: "aborted", message: "user_initiated", resetsAt: null, at: AT });
});

test("antigravityToolName normalizes Viewer MCP names to mcp__viewer__<tool>", () => {
  expect(antigravityToolName("mcp_viewer_list_tasks")).toBe("mcp__viewer__list_tasks");
  expect(antigravityToolName("viewer-get_task")).toBe("mcp__viewer__get_task");
  expect(antigravityToolName("bash")).toBe("bash");
  expect(antigravityToolName("mcp_other_tool")).toBe("mcp_other_tool");
});

test("Antigravity transcripts project cleanly through readSession, compactText, projectTimeline, and resourceWorkerRequest", () => {
  const nowIso = new Date().toISOString();
  const file = path.join(sandbox, crypto.randomUUID(), "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    rec("session.start", { cwd: "/srv/fixture/repo", model: "gemini-3.8-flash", effort: "low" }, nowIso),
    rec("user.message", { content: "Summarize README" }, nowIso),
    rec("tool.execution_start", { toolCallId: "c1", toolName: "mcp_viewer_list_tasks", arguments: { openOnly: true } }, nowIso),
    rec("tool.execution_complete", { toolCallId: "c1", toolName: "mcp_viewer_list_tasks", status: "completed", output: "0 tasks" }, nowIso),
    rec("assistant.message", { content: "Summary complete." }, nowIso),
    rec("assistant.turn_end", { stopReason: "end_turn" }, nowIso),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  const stat = fs.statSync(file);
  const entry = {
    path: file,
    root: "antigravity-sessions",
    name: "events.jsonl",
    project: "fixture-proj",
    title: "Summarize README",
    engine: "antigravity",
    kind: "session",
    fmt: "antigravity",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "recent",
    proc: null,
    pid: null,
    model: "gemini-3.8-flash",
    pendingQuestion: null,
    waitingInput: null,
  } satisfies FileEntry;

  const session = readSession(file, "antigravity");
  expect(session.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "Summarize README"],
    ["assistant", "Summary complete."],
  ]);
  expect(session.tools.map((t) => [t.kind, t.name])).toEqual([
    ["tool_call", "mcp__viewer__list_tasks"],
    ["tool_result", "mcp__viewer__list_tasks"],
  ]);

  const compact = compactText(entry, 5, 500, 2_048);
  expect(compact.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "Summarize README"],
    ["assistant", "Summary complete."],
  ]);

  const timeline = projectTimeline([entry], "fixture-proj", 10);
  expect(timeline.map((event) => [event.kind, event.label])).toEqual(expect.arrayContaining([
    ["user", "Summarize README"],
    ["turn", "Summary complete."],
  ]));

  expect(resourceWorkerRequestProblem({
    type: "collect",
    fresh: false,
    identityEpoch: null,
    files: [{
      path: file,
      parent: null,
      title: "Summarize README",
      project: "fixture-proj",
      activity: "recent",
      mtime: entry.mtime,
      engine: "antigravity",
      pid: null,
      proc: null,
      conversationId: "conv-1",
    }],
    hosts: [{
      id: "antigravity:sess-1",
      engine: "antigravity",
      sessionId: "sess-1",
      pid: 42_000,
      startIdentity: "100",
      bootEpoch: null,
      cwd: "/srv/fixture/repo",
      path: file,
      conversationId: "conv-1",
      title: "Summarize README",
      role: null,
      model: "gemini-3.8-flash",
      stage: null,
      seat: false,
      turnBusy: false,
      owned: true,
    }],
  })).toBeNull();
});
