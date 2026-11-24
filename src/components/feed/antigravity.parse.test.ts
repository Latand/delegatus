import crypto from "node:crypto";

import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildFeed, type Item } from "./parse";

const antigravityFile = {
  path: "/srv/fixture/.config/agent-log-viewer/accounts/antigravity/default/sessions/session/events.jsonl",
  engine: "antigravity",
  fmt: "antigravity",
  activity: "recent",
} as FileEntry;

const AT = "2026-11-23T20:00:00.000Z";
const id = () => crypto.randomUUID();

function record(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data, id: id(), timestamp: AT, parentId: null });
}

function render(lines: string[], showSvc = false): Item[] {
  return buildFeed(antigravityFile, lines, showSvc, "").items;
}

function transcript(): string[] {
  const sessionId = id();
  return [
    record("session.start", {
      sessionId,
      cwd: "/srv/fixture/repo",
      model: "gemini-4-neon",
      baseModel: "gemini-4-neon",
      effort: "xhigh",
      agyVersion: "1.5.13",
    }),
    record("user.message", { content: "run the check", turnId: "turn-1" }),
    record("assistant.turn_start", { turnId: "turn-1" }),
    record("tool.execution_start", {
      turnId: "turn-1",
      toolCallId: "call_shell",
      toolName: "run_command",
      arguments: { command: "echo fixture-output" },
    }),
    record("tool.execution_complete", {
      turnId: "turn-1",
      toolCallId: "call_shell",
      toolName: "run_command",
      status: "completed",
      exitCode: 0,
      isError: false,
      output: "fixture-output",
    }),
    record("tool.execution_start", {
      turnId: "turn-1",
      toolCallId: "call_viewer",
      toolName: "mcp_viewer_list_tasks",
      arguments: { openOnly: true },
    }),
    record("tool.execution_complete", {
      turnId: "turn-1",
      toolCallId: "call_viewer",
      toolName: "mcp_viewer_list_tasks",
      status: "failed",
      isError: true,
      output: "tool refused",
    }),
    record("assistant.message", {
      turnId: "turn-1",
      model: "gemini-4-neon",
      content: "The check printed fixture-output.",
    }),
    record("assistant.turn_end", { turnId: "turn-1", stopReason: "end_turn" }),
    record("session.model_change", { model: "gemini-3.8-flash", effort: "low" }),
    record("user.message", { content: "long task", turnId: "turn-2" }),
    record("assistant.turn_start", { turnId: "turn-2" }),
    record("abort", { reason: "user_initiated" }),
    record("assistant.turn_end", { turnId: "turn-2", stopReason: "cancelled" }),
    record("user.message", { content: "third prompt", turnId: "turn-3" }),
    record("session.quota_exhausted", {
      message: "RESOURCE_EXHAUSTED: Individual quota reached",
      resetsAt: 1_800_000_000,
    }),
    record("session.error", { message: "upstream timeout" }),
    record("session.shutdown", { reason: "released" }),
  ];
}

test("Antigravity records render user, prose, normalized tools, abort, quota, and error rows", () => {
  const items = render(transcript());
  const users = items.filter((item): item is Extract<Item, { kind: "user" }> => item.kind === "user");
  expect(users.map((u) => u.text)).toEqual(["run the check", "long task", "third prompt"]);

  const prose = items.filter((item): item is Extract<Item, { kind: "prose" }> => item.kind === "prose");
  expect(prose.map((p) => p.text)).toEqual(["The check printed fixture-output."]);
  expect(prose[0]!.engine).toBe("antigravity");

  const tools = items.filter((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool");
  expect(tools.map((t) => t.tool)).toEqual(["Bash", "mcp__viewer__list_tasks"]);
  expect(tools[0]).toMatchObject({ id: "call_shell", status: "ok", command: "echo fixture-output" });
  expect(tools[1]).toMatchObject({
    id: "call_viewer",
    status: "err",
    mcp: { serverName: "viewer", toolName: "list_tasks" },
  });

  const notes = items.filter((item): item is Extract<Item, { kind: "note" }> => item.kind === "note");
  expect(notes).toHaveLength(3);
  expect(notes.some((n) => n.text.includes("RESOURCE_EXHAUSTED"))).toBe(true);
  expect(notes.some((n) => n.text.includes("upstream timeout"))).toBe(true);
});

test("duplicate tool.execution_start for the same toolCallId opens only one tool card", () => {
  const items = render([
    record("tool.execution_start", { toolCallId: "call_read", toolName: "read_file", arguments: { path: "/srv/fixture/repo/README.md" } }),
    record("tool.execution_start", { toolCallId: "call_read", toolName: "read_file", arguments: { path: "/srv/fixture/repo/README.md" } }),
    record("tool.execution_complete", { toolCallId: "call_read", toolName: "read_file", status: "completed", output: "# readme" }),
  ]);
  const tools = items.filter((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ id: "call_read", tool: "Read", status: "ok" });
});

test("unknown record types and a truncated trailing line degrade cleanly", () => {
  const items = render([
    ...transcript().slice(0, 2),
    record("session.future_event", { payload: 123 }),
    '{"type":"assistant.message","data":{"content":"truncated',
  ]);
  expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
  expect(items.some((item) => item.kind === "prose")).toBe(false);
});

test("service rows show session start, resume, and model changes when enabled", () => {
  const items = render([
    transcript()[0]!,
    record("session.resume", { model: "gemini-4-neon", effort: "high" }),
    record("session.model_change", { model: "gemini-3.8-flash", effort: "low" }),
  ], true);
  const svc = items.filter((item): item is Extract<Item, { kind: "svc" }> => item.kind === "svc").map((s) => s.text);
  expect(svc.some((text) => text.includes("gemini-4-neon · xhigh"))).toBe(true);
  expect(svc.some((text) => text.includes("gemini-4-neon · high"))).toBe(true);
  expect(svc.some((text) => text.includes("gemini-3.8-flash · low"))).toBe(true);
});
