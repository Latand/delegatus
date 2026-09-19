import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  foldBackgroundTaskRecords,
  emptyBackgroundTaskLedger,
  pendingBackgroundTasks,
  readBackgroundTaskLedger,
  runningBackgroundTasks,
} from "./backgroundTasks";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "llv-background-tasks-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const T0 = Date.parse("2026-09-19T12:15:00.000Z");
const iso = (ts: number) => new Date(ts).toISOString();

/* Shapes read from real stage transcripts; ids are invented. */
function bashStart(ts: number, taskId: string) {
  return {
    type: "user",
    timestamp: iso(ts),
    message: { role: "user", content: [{ tool_use_id: `toolu_${taskId}`, type: "tool_result", content: `Command running in background with ID: ${taskId}.` }] },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId },
  };
}

function notice(taskId: string, status: string | null) {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    ...(status ? [`<status>${status}</status>`] : []),
    "<summary>done</summary>",
    "</task-notification>",
  ].join("\n");
}

function delivered(ts: number, taskId: string, status: string | null) {
  return { type: "user", timestamp: iso(ts), message: { role: "user", content: notice(taskId, status) } };
}

function queuedMidTurn(ts: number, taskId: string, status: string) {
  return { type: "attachment", timestamp: iso(ts), attachment: { type: "queued_command", prompt: notice(taskId, status) } };
}

function enqueued(ts: number, taskId: string, status: string) {
  return { type: "queue-operation", operation: "enqueue", timestamp: iso(ts), content: notice(taskId, status) };
}

function wakeup(ts: number, scheduledFor: number) {
  return [
    {
      type: "assistant",
      timestamp: iso(ts),
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_wake", name: "ScheduleWakeup", input: { delaySeconds: 1500 } }] },
    },
    {
      type: "user",
      timestamp: iso(ts + 5),
      message: { role: "user", content: [{ tool_use_id: "toolu_wake", type: "tool_result", content: "Next wakeup scheduled." }] },
      toolUseResult: { scheduledFor, clampedDelaySeconds: 1500, wasClamped: false },
    },
  ];
}

test("a background command is running from its start record until its notification is delivered", () => {
  const started = [bashStart(T0, "bq1")];
  expect(runningBackgroundTasks(started, "claude", T0 + 60_000)).toEqual([
    { id: "bq1", kind: "command", startedAt: T0, expiresAt: null },
  ]);
  /* Enqueued is not delivered: the agent still owes the turn that reads it. */
  expect(runningBackgroundTasks([...started, enqueued(T0 + 1_000, "bq1", "completed")], "claude", T0 + 60_000)).toHaveLength(1);
  expect(runningBackgroundTasks([...started, delivered(T0 + 1_000, "bq1", "completed")], "claude", T0 + 60_000)).toEqual([]);
  expect(runningBackgroundTasks([...started, queuedMidTurn(T0 + 1_000, "bq1", "killed")], "claude", T0 + 60_000)).toEqual([]);
});

test("a monitor's event notices end nothing; its status notice or its own timeout does", () => {
  const start = {
    type: "user",
    timestamp: iso(T0),
    message: { role: "user", content: [{ tool_use_id: "toolu_m", type: "tool_result", content: "Monitor started (task bm1)." }] },
    toolUseResult: { taskId: "bm1", timeoutMs: 600_000, persistent: false },
  };
  expect(runningBackgroundTasks([start, delivered(T0 + 1_000, "bm1", null)], "claude", T0 + 60_000)).toHaveLength(1);
  expect(runningBackgroundTasks([start, delivered(T0 + 1_000, "bm1", "completed")], "claude", T0 + 60_000)).toEqual([]);
  expect(runningBackgroundTasks([start], "claude", T0 + 600_000 + 3 * 60_000)).toEqual([]);
  const persistent = { ...start, toolUseResult: { taskId: "bm1", timeoutMs: 600_000, persistent: true } };
  expect(runningBackgroundTasks([persistent], "claude", T0 + 5 * 3_600_000)).toHaveLength(1);
});

test("TaskStop ends the task it names", () => {
  const stop = {
    type: "user",
    timestamp: iso(T0 + 1_000),
    message: { role: "user", content: [{ tool_use_id: "toolu_s", type: "tool_result", content: "{\"message\":\"Successfully stopped task: bq1\"}" }] },
    toolUseResult: { message: "Successfully stopped task: bq1 (bun run build)", task_id: "bq1", task_type: "local_bash" },
  };
  const ledger = foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), [bashStart(T0, "bq1"), stop]);
  expect(pendingBackgroundTasks(ledger, T0 + 2_000)).toEqual([]);
  expect(ledger.lastReportedAt).toBe(T0 + 1_000);
});

test("a scheduled wakeup is held until it is due, and a later ScheduleWakeup call replaces it", () => {
  const due = T0 + 1_500_000;
  expect(runningBackgroundTasks(wakeup(T0, due), "claude", T0 + 60_000)).toMatchObject([{ kind: "wakeup", expiresAt: due }]);
  expect(runningBackgroundTasks(wakeup(T0, due), "claude", due + 3 * 60_000)).toEqual([]);
  const cancelled = [
    ...wakeup(T0, due),
    {
      type: "assistant",
      timestamp: iso(T0 + 10_000),
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_wake_2", name: "ScheduleWakeup", input: { stop: true } }] },
    },
  ];
  expect(runningBackgroundTasks(cancelled, "claude", T0 + 60_000)).toEqual([]);
});

test("a notification quoted inside a tool result or typed by a person is not one", () => {
  const quoted = {
    type: "user",
    timestamp: iso(T0 + 1_000),
    message: { role: "user", content: [{ tool_use_id: "toolu_grep", type: "tool_result", content: notice("bq1", "completed") }] },
    toolUseResult: { stdout: notice("bq1", "completed"), stderr: "" },
  };
  const typed = { type: "user", timestamp: iso(T0 + 2_000), message: { role: "user", content: `look at this: ${notice("bq1", "completed")}` } };
  expect(runningBackgroundTasks([bashStart(T0, "bq1"), quoted, typed], "claude", T0 + 60_000)).toHaveLength(1);
});

test("Codex holds no harness-tracked background work", () => {
  expect(runningBackgroundTasks([bashStart(T0, "bq1")], "codex", T0 + 60_000)).toEqual([]);
});

test("the transcript reader folds the whole file incrementally and waits for a line to complete", async () => {
  const file = path.join(ROOT, "incremental.jsonl");
  const filler = { type: "user", timestamp: iso(T0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_f", content: "x".repeat(300_000) }] } };
  fs.writeFileSync(file, `${JSON.stringify(bashStart(T0, "bq1"))}\n${JSON.stringify(filler)}\n`);
  expect(pendingBackgroundTasks((await readBackgroundTaskLedger(file))!, T0 + 60_000).map((task) => task.id)).toEqual(["bq1"]);

  /* Far behind a bounded tail, and a half-written notification line. */
  const line = JSON.stringify(delivered(T0 + 5_000, "bq1", "completed"));
  fs.appendFileSync(file, `${JSON.stringify(filler)}\n${line.slice(0, 40)}`);
  expect(pendingBackgroundTasks((await readBackgroundTaskLedger(file))!, T0 + 60_000)).toHaveLength(1);
  fs.appendFileSync(file, `${line.slice(40)}\n`);
  expect(pendingBackgroundTasks((await readBackgroundTaskLedger(file))!, T0 + 60_000)).toEqual([]);

  /* A replaced file starts over. */
  fs.rmSync(file);
  fs.writeFileSync(file, `${JSON.stringify(bashStart(T0, "bq2"))}\n`);
  expect(pendingBackgroundTasks((await readBackgroundTaskLedger(file))!, T0 + 60_000).map((task) => task.id)).toEqual(["bq2"]);
  expect(await readBackgroundTaskLedger(path.join(ROOT, "missing.jsonl"))).toBeNull();
});
