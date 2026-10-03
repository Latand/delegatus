import { expect, test } from "bun:test";

import { seatTurnProgressing } from "@/lib/monitor/seatTick";
import type { SeatTickSeatInput } from "@/lib/monitor/types";
import { emptyBackgroundTaskLedger, foldBackgroundTaskRecords } from "@/lib/pipelines/backgroundTasks";

import type { RuntimeSession } from "@/lib/runtime/contracts";
import { deputySeatBusy, readDeputySeatBusy, type DeputySeatBusySources } from "./deputySeatBusy";

const now = Date.parse("2026-10-02T12:00:00Z");
const idle = { host: "hosted", turn: "idle" } as const;
const started = (result: object) => ({ type: "user", timestamp: "2026-10-02T11:59:30Z", toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "started" }] } });

test("an active runtime turn stays busy between tool calls even when the tick cannot prove progress", () => {
  for (const activity of [null, { lifecycle: "stalled", turnState: "busy" }]) {
    const tick = { turn: "busy", activity } as SeatTickSeatInput;
    // Observation: the former command reused this tick verdict and refused.
    expect(seatTurnProgressing(tick)).toBe(false);
    expect(deputySeatBusy({ host: "hosted", turn: "running" }, null, now)).toBe(true);
  }
  expect(deputySeatBusy({ host: "hosted", turn: "interrupt_requested" }, null, now)).toBe(true);
});

test("a finished turn with an owned command or monitor is busy until completion or expiry", () => {
  for (const result of [{ backgroundTaskId: "job-a" }, { taskId: "job-a", timeoutMs: 60_000, persistent: false }]) {
    const ledger = foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), [started(result)]);
    expect(deputySeatBusy(idle, ledger, now)).toBe(true);
    const ended = foldBackgroundTaskRecords(ledger, [{ type: "user", timestamp: "2026-10-02T12:00:00Z", message: {
      content: "<task-notification><task-id>job-a</task-id><status>completed</status></task-notification>",
    } }]);
    expect(deputySeatBusy(idle, ended, now)).toBe(false);
  }
  const expired = foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), [started({ taskId: "job-a", timeoutMs: 10_000, persistent: false })]);
  expect(deputySeatBusy(idle, expired, now)).toBe(false);
});

test("idle, dead and missing hosts cannot fork; a future wakeup is idle", () => {
  const ledger = foldBackgroundTaskRecords(emptyBackgroundTaskLedger(), [started({ backgroundTaskId: "job-a" })]);
  expect(deputySeatBusy(idle, null, now)).toBe(false);
  expect(deputySeatBusy(null, ledger, now)).toBe(false);
  expect(deputySeatBusy({ host: "dead", turn: "running" }, ledger, now)).toBe(false);
  const wakeup = emptyBackgroundTaskLedger();
  wakeup.wakeup = { id: "future", kind: "wakeup", startedAt: now, expiresAt: now + 60_000 };
  expect(deputySeatBusy(idle, wakeup, now)).toBe(false);
});


test("the shared server read uses the seat's runtime identity and refuses unavailable background evidence", async () => {
  let session = { ...idle, sessionKey: { engine: "claude" }, artifactPath: "/fixture/seat.jsonl" } as RuntimeSession;
  let ledger: ReturnType<typeof emptyBackgroundTaskLedger> | null = emptyBackgroundTaskLedger();
  const reads: string[] = [];
  const sources: DeputySeatBusySources = {
    seat: () => ({ conversationId: "seat-a" }),
    session: async (id) => { reads.push(id); return session; },
    ledger: async (path) => { reads.push(path); return ledger; }, now: () => now,
  };
  expect(await readDeputySeatBusy("project-a", sources)).toEqual({ conversationId: "seat-a", busy: false });
  expect(reads).toEqual(["seat-a", "/fixture/seat.jsonl"]);
  ledger = null;
  await expect(readDeputySeatBusy("project-a", sources)).rejects.toThrow("background activity is unavailable");
  session = { ...session, turn: "running" };
  expect(await readDeputySeatBusy("project-a", sources)).toEqual({ conversationId: "seat-a", busy: true });
  await expect(readDeputySeatBusy("project-a", { ...sources, session: async () => { throw new Error("unavailable"); } })).rejects.toThrow("unavailable");
});
