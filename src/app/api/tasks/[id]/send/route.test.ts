import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { POST } from "./route";

test("task dispatch attributes an admitted agent caller and keeps human dispatch as operator", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-author-"));
  const registry = new AgentRegistry(path.join(state, "registry.json"));
  setAgentRegistryForTests(registry);
  const sender = registry.ensureConversation("codex", path.join(state, "sender.jsonl"), "default");
  setCallerConversationResolverForTests(() => sender.id);
  const task = {
    id: "task-agent-dispatch", project: "project-fixture", status: "inbox", text: "Review the handoff",
    placement: "unplaced", assignments: [], createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z",
  } as BoardTask;
  const origins: unknown[] = [];
  const dependencies = {
    loadTasks: () => [task], listFiles: async () => [entry(path.join(state, "recipient.jsonl"), "codex")],
    deliverConversationMessage: async (message: { origin?: unknown }) => {
      origins.push(message.origin);
      return { ok: true as const, outcome: "delivered-to-live" as const, target: "pane" };
    },
    mutateTasks: <R,>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }) => mutator([task]).result,
  };
  const send = (agent: boolean) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/tasks/task-agent-dispatch/send", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json",
      ...(agent ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) } : {}) },
    body: JSON.stringify({ paths: [path.join(state, "recipient.jsonl")] }),
  }), { params: Promise.resolve({ id: task.id }) }, dependencies);
  try {
    expect((await send(true)).status).toBe(200);
    expect((await send(false)).status).toBe(200);
    expect(origins[0]).toMatchObject({ kind: "agent", conversationId: sender.id });
    expect(origins[1]).toEqual({ kind: "operator" });
  } finally {
    setCallerConversationResolverForTests(null);
    setAgentRegistryForTests(null);
    fs.rmSync(state, { recursive: true, force: true });
  }
});

function entry(path: string, engine: "claude" | "codex"): FileEntry {
  return {
    path,
    root: engine === "claude" ? "claude-projects" : "codex-sessions",
    name: `${engine}.jsonl`,
    project: "project-fixture",
    title: "fixture",
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    derivationComplete: true,
    proc: "done",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("one authorized task fan-out records one durable operator gesture across retry and delivery failure", async () => {
  const task: BoardTask = {
    id: "task-fanout-one",
    project: "project-fixture",
    status: "inbox",
    text: "Dispatch this task",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };
  const files = [entry("/sessions/a.jsonl", "claude"), entry("/sessions/b.jsonl", "codex")];
  const recorded = new Map<string, unknown>();
  let deliveries = 0;
  const dependencies = {
    loadTasks: () => [task],
    listFiles: async () => files,
    deliverConversationMessage: async () => {
      deliveries += 1;
      return { ok: false as const, outcome: "failed" as const, error: "offline", status: 503 };
    },
    mutateTasks: <R>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }) => mutator([task]).result,
    recordOperatorRequest: (_request: unknown, input: { idempotencyKey?: string | null; project?: string | null; kind: string }) => {
      recorded.set(input.idempotencyKey ?? "", input);
      return null;
    },
  };
  const request = () => new NextRequest("http://127.0.0.1/api/tasks/task-fanout-one/send", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ paths: files.map((file) => file.path), clientRequestId: "task-send-gesture-one" }),
  });
  const context = { params: Promise.resolve({ id: task.id }) };

  const first = await POST.withDependencies(request(), context, dependencies);
  const retry = await POST.withDependencies(request(), context, dependencies);

  expect([first.status, retry.status]).toEqual([200, 200]);
  expect(deliveries).toBe(4);
  expect([...recorded.values()]).toEqual([{
    kind: "message",
    idempotencyKey: "task-send:task-send-gesture-one",
    project: "project-fixture",
  }]);
});

/* docs/design/linked-installs.md M.4 seam 3: handing a task to agents is
   work on it, so only the machine the task names does it. */
test("a task another linked machine runs is refused before any delivery; its own machine delivers", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-send-elsewhere-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  const self = ["0a0a0a0a", "1111", "4111", "8111", "111111111111"].join("-");
  const peer = ["0b0b0b0b", "2222", "4222", "8222", "222222222222"].join("-");
  const writeSelf = (installId: string) => {
    fs.mkdirSync(path.join(state, "links"), { recursive: true });
    fs.writeFileSync(path.join(state, "links/self.json"), JSON.stringify({ v: 1, installId, label: "fixture", publicUrl: null, check: null }));
  };
  const task = { id: "task-on-peer", project: "project-fixture", status: "inbox", text: "Runs on the peer", machine: peer,
    placement: "unplaced", assignments: [], createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" } as BoardTask;
  let deliveries = 0;
  const dependencies = {
    loadTasks: () => [task], listFiles: async () => [entry(path.join(state, "recipient.jsonl"), "codex")],
    deliverConversationMessage: async () => { deliveries++; return { ok: true as const, outcome: "delivered-to-live" as const, target: "pane" }; },
    mutateTasks: <R,>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }) => mutator([task]).result,
  };
  const send = () => POST.withDependencies(new NextRequest("http://127.0.0.1/api/tasks/task-on-peer/send", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ paths: [path.join(state, "recipient.jsonl")] }),
  }), { params: Promise.resolve({ id: task.id }) }, dependencies);
  try {
    writeSelf(self);
    const refused = await send();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "TASK_RUNS_ELSEWHERE" });
    expect(deliveries).toBe(0);
    writeSelf(peer);
    expect((await send()).status).toBe(200);
    expect(deliveries).toBe(1);
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(state, { recursive: true, force: true });
  }
});
