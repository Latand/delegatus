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

function expiredMonitorNotice(taskId: string) {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    "<summary>[Monitor expired after 5m with no events delivered]</summary>",
    "</task-notification>",
  ].join("\n");
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
  expect(runningBackgroundTasks([start], "claude", T0 + 600_000)).toEqual([]);
  const persistent = { ...start, toolUseResult: { taskId: "bm1", timeoutMs: 600_000, persistent: true } };
  expect(runningBackgroundTasks([persistent], "claude", T0 + 5 * 3_600_000)).toHaveLength(1);
});

test("a monitor expiry notice ends only the named watch while its source can still run", () => {
  const expired = {
    type: "user",
    timestamp: iso(T0),
    message: { role: "user", content: [{ tool_use_id: "toolu_expired", type: "tool_result", content: "Monitor started (task bm-expired)." }] },
    toolUseResult: { taskId: "bm-expired", timeoutMs: 300_000, persistent: false },
  };
  const live = {
    type: "user",
    timestamp: iso(T0 + 1),
    message: { role: "user", content: [{ tool_use_id: "toolu_live", type: "tool_result", content: "Monitor started (task bm-live)." }] },
    toolUseResult: { taskId: "bm-live", timeoutMs: 300_000, persistent: true },
  };
  const expiry = { type: "user", timestamp: iso(T0 + 300_000), message: { role: "user", content: expiredMonitorNotice("bm-expired") } };

  expect(runningBackgroundTasks([expired, live, expiry], "claude", T0 + 300_001)).toEqual([
    { id: "bm-live", kind: "monitor", startedAt: T0 + 1, expiresAt: null },
  ]);
});

/* After a restart the harness reports every task the previous process left
   without a record in one notification, under one status, with a scan marker. */
function orphanNotice(taskIds: readonly string[]) {
  return [
    "<task-notification>",
    ...taskIds.map((id) => `<task-id>${id}</task-id>`),
    "<task-id>__orphan_summary__:shell</task-id>",
    "<status>stopped</status>",
    `<summary>${taskIds.length} background shell command task(s) from the previous session have no completion record. They have been marked stopped. Task ids: ${taskIds.join(", ")}.</summary>`,
    "</task-notification>",
  ].join("\n");
}

test("one orphan notification ends every task it lists and names no task of its own", () => {
  const started = [bashStart(T0, "bq1"), bashStart(T0 + 1, "bq2"), bashStart(T0 + 2, "bq3")];
  const orphaned = { type: "user", timestamp: iso(T0 + 60_000), message: { role: "user", content: orphanNotice(["bq1", "bq2", "bq3"]) } };
  const ledger = foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), [...started, orphaned]);
  expect(pendingBackgroundTasks(ledger, T0 + 120_000)).toEqual([]);
  expect(ledger.ended).toEqual(["bq1", "bq2", "bq3"]);
  expect(ledger.lastReportedAt).toBe(T0 + 60_000);
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

test("a TaskStop no-task result ends only the printed monitor id", () => {
  const started = [
    {
      type: "user", timestamp: iso(T0),
      message: { role: "user", content: [{ tool_use_id: "toolu_old", type: "tool_result", content: "Monitor started (task bm-old)." }] },
      toolUseResult: { taskId: "bm-old", timeoutMs: 300_000, persistent: true },
    },
    {
      type: "user", timestamp: iso(T0 + 1),
      message: { role: "user", content: [{ tool_use_id: "toolu_current", type: "tool_result", content: "Monitor started (task bm-current)." }] },
      toolUseResult: { taskId: "bm-current", timeoutMs: 300_000, persistent: true },
    },
  ];
  const stop = {
    type: "assistant", timestamp: iso(T0 + 1_500),
    message: { role: "assistant", content: [{ id: "toolu_stop", type: "tool_use", name: "TaskStop", input: { task_id: "bm-old" } }] },
  };
  const stopMiss = {
    type: "user", timestamp: iso(T0 + 2_000),
    message: { role: "user", content: [{ tool_use_id: "toolu_stop", type: "tool_result", content: "<tool_use_error>No task found with ID: bm-old</tool_use_error>" }] },
    toolUseResult: { stderr: "No task found with ID: bm-old" },
  };

  expect(runningBackgroundTasks([...started, stop, stopMiss], "claude", T0 + 3_000)).toEqual([
    { id: "bm-current", kind: "monitor", startedAt: T0 + 1, expiresAt: null },
  ]);
});

test("an unrelated tool error cannot retire a monitor by repeating a TaskStop phrase", () => {
  const monitor = {
    type: "user", timestamp: iso(T0),
    message: { role: "user", content: [{ tool_use_id: "toolu_monitor", type: "tool_result", content: "Monitor started (task bm-live)." }] },
    toolUseResult: { taskId: "bm-live", timeoutMs: 300_000, persistent: true },
  };
  const quoted = {
    type: "user", timestamp: iso(T0 + 1_000),
    message: { role: "user", content: [{ tool_use_id: "toolu_bash", type: "tool_result", content: "No task found with ID: bm-live" }] },
    toolUseResult: { stderr: "No task found with ID: bm-live" },
  };

  expect(runningBackgroundTasks([monitor, quoted], "claude", T0 + 2_000)).toMatchObject([{ id: "bm-live" }]);
});

test("duplicate or late terminal records cannot reopen a monitor or clear its neighbour", () => {
  const terminal = { type: "user", timestamp: iso(T0), message: { role: "user", content: expiredMonitorNotice("bm-old") } };
  const lateStart = {
    type: "user", timestamp: iso(T0 + 1_000),
    message: { role: "user", content: [{ tool_use_id: "toolu_old", type: "tool_result", content: "Monitor started (task bm-old)." }] },
    toolUseResult: { taskId: "bm-old", timeoutMs: 300_000, persistent: true },
  };
  const neighbour = {
    type: "user", timestamp: iso(T0 + 2_000),
    message: { role: "user", content: [{ tool_use_id: "toolu_neighbour", type: "tool_result", content: "Monitor started (task bm-neighbour)." }] },
    toolUseResult: { taskId: "bm-neighbour", timeoutMs: 300_000, persistent: true },
  };
  const duplicate = { type: "user", timestamp: iso(T0 + 3_000), message: { role: "user", content: expiredMonitorNotice("bm-old") } };

  expect(runningBackgroundTasks([terminal, lateStart, neighbour, duplicate], "claude", T0 + 4_000)).toEqual([
    { id: "bm-neighbour", kind: "monitor", startedAt: T0 + 2_000, expiresAt: null },
  ]);
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

test("the transcript reader applies a text-only TaskStop miss incrementally to only its requested monitor", async () => {
  const file = path.join(ROOT, "incremental-task-stop-miss.jsonl");
  const old = {
    type: "user", timestamp: iso(T0),
    message: { role: "user", content: [{ tool_use_id: "toolu_old", type: "tool_result", content: "Monitor started (task bm-old)." }] },
    toolUseResult: { taskId: "bm-old", timeoutMs: 300_000, persistent: true },
  };
  const live = {
    type: "user", timestamp: iso(T0 + 1),
    message: { role: "user", content: [{ tool_use_id: "toolu_live", type: "tool_result", content: "Monitor started (task bm-live)." }] },
    toolUseResult: { taskId: "bm-live", timeoutMs: 300_000, persistent: true },
  };
  const stop = {
    type: "assistant", timestamp: iso(T0 + 2),
    message: { role: "assistant", content: [{ id: "toolu_stop", type: "tool_use", name: "TaskStop", input: { task_id: "bm-old" } }] },
  };
  const miss = {
    type: "user", timestamp: iso(T0 + 3),
    message: { role: "user", content: [{ tool_use_id: "toolu_stop", type: "tool_result", content: "<tool_use_error>No task found with ID: bm-old</tool_use_error>" }] },
    toolUseResult: "No task found with ID: bm-old",
  };

  fs.writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify(live)}\n${JSON.stringify(stop)}\n`);
  expect(pendingBackgroundTasks((await readBackgroundTaskLedger(file))!, T0 + 10).map((task) => task.id)).toEqual(["bm-old", "bm-live"]);

  fs.appendFileSync(file, `${JSON.stringify(miss)}\n`);
  expect(pendingBackgroundTasks((await readBackgroundTaskLedger(file))!, T0 + 10).map((task) => task.id)).toEqual(["bm-live"]);
});
