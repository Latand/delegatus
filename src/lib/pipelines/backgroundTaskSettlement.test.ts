import { afterAll, afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreateFlowRequest, Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

/* Isolated state only: this suite drives the production pipeline controller
   over a store of its own and must never read or write the operator's. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "llv-background-settlement-"));
process.env.LLV_STATE_DIR = path.join(ROOT, "state");
const { createPipelineFromRequest, reportStageCompletion, tickPipelines } = await import("./engine");
const { durableStageTurnEvidence } = await import("./durableEvidence");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
const { flowTurn } = await import("@/lib/flows/decisions");
const { tickFlow } = await import("@/lib/flows/engine");
type PipelinePorts = import("./engine").PipelinePorts;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => setSystemTime());

const STAGE_CONVERSATION = "conversation_stage_bg";
const BASE_SHA = "9".repeat(40);
const STAGE_HEAD = "7".repeat(40);
const TASK_ID = "bqx7task1";
const MONITOR_ID = "bmx7mon1";
const agent = { kind: "agent", role: "builder", conversationId: STAGE_CONVERSATION } as const;

let transcript = "";
let fileSerial = 0;

beforeEach(() => {
  fileSerial += 1;
  transcript = path.join(ROOT, `stage-${fileSerial}.jsonl`);
  fs.writeFileSync(transcript, "");
});

function fenced(status: "pass" | "fail", finding?: string): string {
  const verdict = status === "pass"
    ? { status, findings: [], confidence: 0.9 }
    : { status, findings: [finding ?? "P1 — not finished"], confidence: 0.9 };
  return ["```json", JSON.stringify(verdict), "```"].join("\n");
}

/** Records in the shape Claude Code writes them, as read from the two stage
    transcripts behind #1441; every id and path here is invented. */
const records = {
  prompt(ts: number, text: string) {
    return { type: "user", timestamp: iso(ts), message: { role: "user", content: text } };
  },
  toolUse(ts: number, id: string, name: string, input: Record<string, unknown>) {
    return {
      type: "assistant",
      timestamp: iso(ts),
      message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
    };
  },
  toolResult(ts: number, id: string, text: string, toolUseResult: Record<string, unknown>) {
    return {
      type: "user",
      timestamp: iso(ts),
      message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text }] },
      toolUseResult,
    };
  },
  backgroundStart(ts: number, taskId = TASK_ID, toolUseId = "toolu_bg_start_1") {
    return [
      records.toolUse(ts, toolUseId, "Bash", { command: "bun run build", run_in_background: true }),
      records.toolResult(ts + 20, toolUseId, `Command running in background with ID: ${taskId}. You will be notified when it completes.`, {
        stdout: "",
        stderr: "",
        interrupted: false,
        backgroundTaskId: taskId,
      }),
    ];
  },
  monitorStart(ts: number, taskId = MONITOR_ID, toolUseId = "toolu_monitor_1") {
    return [
      records.toolUse(ts, toolUseId, "Monitor", { command: "until test -f done; do sleep 2; done", timeout_ms: 600_000 }),
      records.toolResult(ts + 10, toolUseId, `Monitor started (task ${taskId}, expires in 10m unless the source ends first).`, {
        taskId,
        timeoutMs: 600_000,
        persistent: false,
      }),
    ];
  },
  notification(ts: number, taskId: string, status: string | null, toolUseId = "toolu_bg_start_1") {
    const body = [
      "<task-notification>",
      `<task-id>${taskId}</task-id>`,
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      ...(status ? [`<status>${status}</status>`] : []),
      `<summary>${status ? "Background command completed" : "Monitor event: \"build\""}</summary>`,
      "</task-notification>",
    ].join("\n");
    return [
      { type: "queue-operation", operation: "enqueue", timestamp: iso(ts), content: body },
      { type: "queue-operation", operation: "dequeue", timestamp: iso(ts + 5) },
      { type: "user", timestamp: iso(ts + 10), message: { role: "user", content: body } },
    ];
  },
  monitorExpiry(ts: number, taskId = MONITOR_ID, toolUseId = "toolu_monitor_1") {
    const body = [
      "<task-notification>",
      `<task-id>${taskId}</task-id>`,
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      "<summary>[Monitor expired after 5m with no events delivered]</summary>",
      "</task-notification>",
    ].join("\n");
    return [
      { type: "queue-operation", operation: "enqueue", timestamp: iso(ts), content: body },
      { type: "queue-operation", operation: "dequeue", timestamp: iso(ts + 5) },
      { type: "user", timestamp: iso(ts + 10), message: { role: "user", content: body } },
    ];
  },
  /** After a restart the harness reports every task the previous process
      left without a record in one notification: several ids, one status, and
      a scan marker that names no task. */
  orphanNotification(ts: number, taskIds: readonly string[]) {
    const body = [
      "<task-notification>",
      ...taskIds.map((id) => `<task-id>${id}</task-id>`),
      "<task-id>__orphan_summary__:shell</task-id>",
      "<status>stopped</status>",
      `<summary>${taskIds.length} background shell command task(s) from the previous session have no completion record. They have been marked stopped. Task ids: ${taskIds.join(", ")}.</summary>`,
      "</task-notification>",
    ].join("\n");
    return [
      { type: "queue-operation", operation: "enqueue", timestamp: iso(ts), content: body },
      { type: "queue-operation", operation: "dequeue", timestamp: iso(ts + 5) },
      { type: "user", timestamp: iso(ts + 10), message: { role: "user", content: body } },
    ];
  },
  endTurn(ts: number, text: string) {
    return {
      type: "assistant",
      timestamp: iso(ts),
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    };
  },
};

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function append(...lines: Array<Record<string, unknown> | Array<Record<string, unknown>>>): void {
  fs.appendFileSync(transcript, lines.flat().map((line) => `${JSON.stringify(line)}\n`).join(""));
}

function harness() {
  let wall = Date.parse("2026-09-19T12:15:00.000Z");
  const requests: string[] = [];
  const stops: string[] = [];
  let head = BASE_SHA;
  let spawns = 0;
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${head}\trefs/heads/${loadPipelines()[0]?.branch ?? "pipeline/test"}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: () => ({ engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: "Builder guidance" }),
    spawnAgent: async (_input, onReserved) => {
      spawns += 1;
      onReserved({ launchId: `launch-${spawns}`, conversationId: STAGE_CONVERSATION, accountId: "default" });
      return {
        launchId: `launch-${spawns}`,
        conversationId: STAGE_CONVERSATION,
        sessionId: `session-${spawns}`,
        /* Quoted so the publication gate does not read the key as a transcript line. */
        "transcript": transcript,
        paneId: null,
        accountId: "default",
      };
    },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    paneAgentAlive: async () => false,
    stopStageAgent: async (target) => {
      stops.push(`${target.stageId}:${target.attempt}`);
      return { outcome: "not-running" };
    },
    stopStagePane: async () => ({ outcome: "not-running" }),
    stageHostResident: async () => true,
    monotonicNow: () => wall,
    worktreePresent: () => true,
    /* A finished structured agent is hosted and idle, and the runtime ledger
       answers null for it: only the transcript says how the turn stands. */
    conversationAgentActive: async () => null,
    runtimeHostEpoch: async () => 1_020,
    conversationDeliveryOutstanding: () => false,
    transcriptPresent: () => true,
    resumeSeveredTurn: async (input) => {
      requests.push(input.text);
      return true;
    },
    /* The production reader over the real transcript file. */
    durableTurnEvidence: durableStageTurnEvidence,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: () => null,
    pathForConversation: (id) => id === STAGE_CONVERSATION ? transcript : null,
    sourcePathAllowed: (pathname) => pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => pathname === transcript
      ? STAGE_CONVERSATION
      : pathname === "/claude/creator.jsonl" ? "conversation_creator" : null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async (request: CreateFlowRequest) => ({ flow: { id: "flow-1", implementerPath: request.implementerPath } as unknown as Flow }),
    patchFlow: () => ({}),
    closeFlow: async () => {},
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date(wall).toISOString(),
  };
  return {
    ports,
    requests,
    stops,
    now: () => wall,
    advance: (milliseconds: number) => { wall += milliseconds; },
    setHead: (sha: string) => { head = sha; },
  };
}

/** A pipeline whose one stage is running on a pane-less structured host. */
async function runningStage(h: ReturnType<typeof harness>) {
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Finish the lane",
    spec: "AC1",
    repoDir: "/repo",
    src: "/claude/creator.jsonl",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
    ],
  } as never, h.ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  expect(running.runs[0]!.attempts[0]).toMatchObject({ state: "running", paneId: null, conversationId: STAGE_CONVERSATION });
  append(records.prompt(h.now() + 1_000, "Build"));
  return running;
}

/** Ticks the way the controller does across a wait: many passes, time moving. */
async function tickAcross(h: ReturnType<typeof harness>, totalMs: number, stepMs = 30_000) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    h.advance(stepMs);
    await tickPipelines([], h.ports);
  }
}

function attempt() {
  return loadPipelines()[0]!.runs[0]!.attempts[0]!;
}

test("a turn that ends on a fenced fail while its background task runs stays open, and the verdict after the notification settles it", async () => {
  const h = harness();
  await runningStage(h);

  /* The 14b93cd8 shape: the capture starts in the background and the turn
     ends on an interim fail. */
  append(
    records.backgroundStart(h.now() + 2_000),
    records.endTurn(h.now() + 3_000, `The capture is still running.\n\n${fenced("fail", "P1 — not finished: the capture is still running")}`),
  );
  await tickAcross(h, 10 * 60_000);

  const waiting = loadPipelines()[0]!;
  expect(attempt().state).toBe("running");
  expect(attempt().verdict ?? null).toBeNull();
  expect(attempt().completedAt ?? null).toBeNull();
  expect(attempt().backgroundWait?.tasks).toEqual([{ id: TASK_ID, kind: "command" }]);
  expect(waiting.state).toBe("running");
  expect(waiting.stateDetail).toStartWith(`waiting: background task ${TASK_ID}`);
  /* Nothing asked the agent for a verdict, no recovery check was spent and no
     host was stopped while it waited. */
  expect(h.requests).toEqual([]);
  expect(attempt().verdictRecovery).toBeUndefined();
  expect(h.stops).toEqual([]);

  /* The harness re-invokes the agent with the task notification, and the turn
     it starts files the stage's real answer. */
  h.setHead(STAGE_HEAD);
  append(
    records.notification(h.now() + 1_000, TASK_ID, "completed"),
    records.endTurn(h.now() + 5_000, `The capture passed.\n\n${fenced("pass")}`),
  );
  h.advance(10_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const settled = loadPipelines()[0]!;
  expect(attempt().state).toBe("passed");
  expect(attempt().verdict).toMatchObject({ status: "pass" });
  expect(attempt().backgroundWait).toBeUndefined();
  expect(settled.stateDetail ?? "").not.toStartWith("waiting: ");
});

test("a background task that never reports parks the lane at the deadline, naming it, and stops nothing", async () => {
  const h = harness();
  await runningStage(h);

  append(
    records.backgroundStart(h.now() + 2_000),
    records.endTurn(h.now() + 3_000, "The bench is running in the background; I'll pick up the table when it completes."),
  );
  await tickAcross(h, 59 * 60_000, 60_000);
  expect(attempt().state).toBe("running");
  expect(loadPipelines()[0]!.state).toBe("running");

  await tickAcross(h, 2 * 60_000, 60_000);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`background task ${TASK_ID}`);
  expect(parked.stateDetail).toContain("exceeded 60 min");
  expect(attempt().error).toBe(parked.stateDetail!);
  /* The park stamps no completion, so the terminal-host reaper leaves the
     agent and its task alone. */
  expect(attempt().completedAt ?? null).toBeNull();
  expect(h.stops).toEqual([]);
  expect(h.requests).toEqual([]);
});

test("a persistent monitor the agent keeps answering parks the lane at the whole-wait bound, naming it, and stops nothing", async () => {
  const h = harness();
  await runningStage(h);

  append(
    records.toolUse(h.now() + 2_000, "toolu_monitor_p", "Monitor", { command: "tail -f build.log", persistent: true }),
    records.toolResult(h.now() + 2_010, "toolu_monitor_p", `Monitor started (task ${MONITOR_ID}, persistent).`, {
      taskId: MONITOR_ID,
      timeoutMs: 600_000,
      persistent: true,
    }),
    records.endTurn(h.now() + 3_000, "Watching the log."),
  );
  /* An event every ten minutes re-invokes the agent, so the transcript is
     never silent for the hour the silence bound needs. */
  for (let elapsed = 0; elapsed < 3 * 60 + 50; elapsed += 10) {
    append(
      records.notification(h.now() + 1_000, MONITOR_ID, null, "toolu_monitor_p"),
      records.endTurn(h.now() + 2_000, "Another line; still watching."),
    );
    await tickAcross(h, 10 * 60_000, 5 * 60_000);
    expect(loadPipelines()[0]!.state).toBe("running");
  }
  append(
    records.notification(h.now() + 1_000, MONITOR_ID, null, "toolu_monitor_p"),
    records.endTurn(h.now() + 2_000, "Another line; still watching."),
  );
  await tickAcross(h, 20 * 60_000, 5 * 60_000);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`monitor ${MONITOR_ID}`);
  expect(parked.stateDetail).toContain("exceeded 4 h in all");
  expect(attempt().completedAt ?? null).toBeNull();
  expect(h.stops).toEqual([]);
  expect(h.requests).toEqual([]);
});

test("one orphan notification after a restart ends every task it lists, and the stage reports and settles", async () => {
  const h = harness();
  await runningStage(h);

  append(
    records.backgroundStart(h.now() + 2_000, "bqx7orph1", "toolu_bg_o1"),
    records.backgroundStart(h.now() + 3_000, "bqx7orph2", "toolu_bg_o2"),
    records.backgroundStart(h.now() + 4_000, "bqx7orph3", "toolu_bg_o3"),
    records.endTurn(h.now() + 5_000, "Three checks are running in the background."),
  );
  await tickAcross(h, 60_000);
  expect(attempt().state).toBe("running");
  expect(attempt().backgroundWait?.tasks.map((task) => task.id)).toEqual(["bqx7orph1", "bqx7orph2", "bqx7orph3"]);
  const refused = await reportStageCompletion({ verdict: "pass", summary: "done" }, agent, h.ports);
  expect(refused.code).toBe("STAGE_REPORT_BACKGROUND_TASK_RUNNING");

  /* The process restarted; the new one reports all three as stopped at once. */
  h.setHead(STAGE_HEAD);
  append(records.orphanNotification(h.now() + 1_000, ["bqx7orph1", "bqx7orph2", "bqx7orph3"]));
  h.advance(2_000);
  const accepted = await reportStageCompletion({ verdict: "pass", summary: "the checks passed before the restart" }, agent, h.ports);
  expect(accepted.code).toBeUndefined();
  expect(accepted.report?.verdict).toMatchObject({ status: "pass" });

  append(records.endTurn(h.now() + 1_000, "Done."));
  h.advance(2_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(attempt().state).toBe("passed");
  expect(attempt().backgroundWait).toBeUndefined();
});

test("a turn with no background task settles on its first end exactly as before", async () => {
  const h = harness();
  await runningStage(h);

  append(records.endTurn(h.now() + 3_000, `Not finished.\n\n${fenced("fail", "P1 — the build is red")}`));
  h.advance(5_000);
  await tickPipelines([], h.ports);

  expect(attempt().state).toBe("failed");
  expect(attempt().verdict).toMatchObject({ status: "fail" });
  expect(attempt().backgroundWait).toBeUndefined();
});

test("a background task that already reported inside the turn does not hold it", async () => {
  const h = harness();
  await runningStage(h);

  append(
    records.backgroundStart(h.now() + 2_000),
    records.notification(h.now() + 3_000, TASK_ID, "completed"),
    records.endTurn(h.now() + 5_000, `Red.\n\n${fenced("fail", "P1 — the build is red")}`),
  );
  h.advance(10_000);
  await tickPipelines([], h.ports);

  expect(attempt().state).toBe("failed");
});

test("a monitor holds the stage through its event notices and releases it on its terminal one", async () => {
  const h = harness();
  await runningStage(h);

  append(
    records.monitorStart(h.now() + 2_000),
    records.endTurn(h.now() + 3_000, `Watching the build.\n\n${fenced("fail", "P1 — waiting on the build")}`),
  );
  await tickAcross(h, 60_000);
  expect(attempt().state).toBe("running");
  expect(loadPipelines()[0]!.stateDetail).toStartWith(`waiting: monitor ${MONITOR_ID}`);

  /* An event notice carries no status: the monitor is still watching. */
  append(
    records.notification(h.now() + 1_000, MONITOR_ID, null, "toolu_monitor_1"),
    records.endTurn(h.now() + 3_000, `Half the checks passed.\n\n${fenced("fail", "P1 — still waiting")}`),
  );
  await tickAcross(h, 60_000);
  expect(attempt().state).toBe("running");

  h.setHead(STAGE_HEAD);
  append(
    records.notification(h.now() + 1_000, MONITOR_ID, "completed", "toolu_monitor_1"),
    records.endTurn(h.now() + 3_000, `All checks passed.\n\n${fenced("pass")}`),
  );
  h.advance(5_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(attempt().state).toBe("passed");
});

test("stage_report accepts after its monitor expires while the watched source remains alive", async () => {
  const h = harness();
  await runningStage(h);

  append(records.monitorStart(h.now() + 2_000));
  h.advance(3_000);
  const refused = await reportStageCompletion({ verdict: "pass", summary: "the source is still running" }, agent, h.ports);
  expect(refused.code).toBe("STAGE_REPORT_BACKGROUND_TASK_RUNNING");

  /* The Monitor lifetime ends here; this does not claim its command/source
     ended, so a separate live monitor would still hold the same stage. */
  append(records.monitorExpiry(h.now() + 300_000));
  h.advance(300_020);
  const accepted = await reportStageCompletion({ verdict: "pass", summary: "the watch expired" }, agent, h.ports);
  expect(accepted.code).toBeUndefined();
  expect(accepted.report?.verdict).toMatchObject({ status: "pass" });
});

test("stage_report refuses a verdict while a background task runs, records nothing, and accepts it once the task reports", async () => {
  const h = harness();
  await runningStage(h);

  append(records.backgroundStart(h.now() + 2_000));
  h.advance(3_000);
  const refused = await reportStageCompletion({ verdict: "fail", summary: "the capture is still running" }, agent, h.ports);
  expect(refused.report).toBeUndefined();
  expect(refused.code).toBe("STAGE_REPORT_BACKGROUND_TASK_RUNNING");
  expect(refused.status).toBe(409);
  expect(refused.error).toContain(`background task ${TASK_ID}`);
  expect(refused.error).toContain("TaskStop");
  expect(refused.error).toContain("Wait for its task notification");
  expect(attempt().report).toBeUndefined();
  expect(attempt().state).toBe("running");
  expect(loadPipelines()[0]!.stageReports ?? []).toEqual([]);

  h.setHead(STAGE_HEAD);
  append(records.notification(h.now() + 1_000, TASK_ID, "completed"));
  h.advance(2_000);
  const accepted = await reportStageCompletion({ verdict: "pass", summary: "capture passed" }, agent, h.ports);
  expect(accepted.code).toBeUndefined();
  expect(accepted.report?.verdict).toMatchObject({ status: "pass" });

  append(records.endTurn(h.now() + 1_000, "Done: the capture passed."));
  h.advance(2_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(attempt().state).toBe("passed");
});

test("stage_report is accepted once the agent stops its background task", async () => {
  const h = harness();
  await runningStage(h);

  append(
    records.backgroundStart(h.now() + 2_000),
    records.toolUse(h.now() + 3_000, "toolu_stop_1", "TaskStop", { task_id: TASK_ID }),
    records.toolResult(h.now() + 3_010, "toolu_stop_1", `{"message":"Successfully stopped task: ${TASK_ID}"}`, {
      message: `Successfully stopped task: ${TASK_ID} (bun run build)`,
      task_id: TASK_ID,
      task_type: "local_bash",
    }),
  );
  h.advance(5_000);
  const accepted = await reportStageCompletion({ verdict: "fail", findings: [{ severity: "P1", text: "the build never finished" }] }, agent, h.ports);
  expect(accepted.code).toBeUndefined();
  expect(accepted.report?.verdict).toMatchObject({ status: "fail" });
});

test("a report filed before background work started is interim, and the answer after the notification replaces it", async () => {
  const h = harness();
  await runningStage(h);

  h.advance(1_000);
  const early = await reportStageCompletion({ verdict: "pass", summary: "looks done" }, agent, h.ports);
  expect(early.report).toBeDefined();
  append(
    records.backgroundStart(h.now() + 1_000),
    records.endTurn(h.now() + 2_000, "Running the last check in the background."),
  );
  await tickAcross(h, 60_000);
  expect(attempt().state).toBe("running");

  append(
    records.notification(h.now() + 1_000, TASK_ID, "failed"),
    records.endTurn(h.now() + 3_000, `The last check failed.\n\n${fenced("fail", "P1 — the last check failed")}`),
  );
  h.advance(5_000);
  await tickPipelines([], h.ports);
  expect(attempt().state).toBe("failed");
  expect(attempt().verdict).toMatchObject({ status: "fail" });
});

test("a review flow's implementer turn reads as busy while it holds a background task", async () => {
  const flow = { implementerPath: transcript, roles: { implementer: { engine: "claude" } } } as unknown as Flow;
  const start = Date.now() - 60_000;
  append(records.prompt(start, "Fix the findings"), records.backgroundStart(start + 1_000), records.endTurn(start + 2_000, "REVIEW_READY: fixed"));
  expect((await flowTurn(flow))?.state).toBe("busy");

  append(records.notification(start + 3_000, TASK_ID, "completed"), records.endTurn(start + 4_000, "REVIEW_READY: fixed"));
  expect((await flowTurn(flow))?.state).toBe("terminal");
});

/** A review flow waiting on its implementer, driven by the production flow
    tick over this suite's transcript. Manual mode, so a READY marker only
    queues a round and launches nothing. */
function waitingFlow(createdAt: number): Flow {
  return {
    id: "flow-bg",
    template: "implement-review",
    project: "invented-project",
    cwd: ROOT,
    implementerPath: transcript,
    implementerConversationId: null,
    roles: { implementer: { engine: "claude" }, reviewer: { engine: "codex" } },
    baseRef: BASE_SHA,
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: iso(createdAt),
    closedAt: null,
  } as unknown as Flow;
}

async function tickFlowAt(flow: Flow, at: number): Promise<void> {
  setSystemTime(new Date(at));
  const entries = new Map([[transcript, { path: transcript } as unknown as FileEntry]]);
  await tickFlow(flow, [], entries, () => {});
}

test("a review flow whose implementer holds a background command that never reports shows the wait, then parks naming it", async () => {
  const start = Date.parse("2026-09-19T12:00:00.000Z");
  const flow = waitingFlow(start - 60_000);
  append(
    records.prompt(start, "Fix the findings"),
    records.backgroundStart(start + 1_000),
    records.endTurn(start + 2_000, "The suite is running in the background; I'll decide when it completes."),
  );
  const transcriptBefore = fs.readFileSync(transcript, "utf8");

  await tickFlowAt(flow, start + 5_000);
  expect(flow.state).toBe("waiting_ready");
  expect(flow.stateDetail).toStartWith("waiting: ");
  expect(flow.stateDetail).toContain(`background task ${TASK_ID}`);

  await tickFlowAt(flow, start + 5_000 + 59 * 60_000);
  expect(flow.state).toBe("waiting_ready");
  expect(flow.stateDetail).toContain(`background task ${TASK_ID}`);

  await tickFlowAt(flow, start + 5_000 + 60 * 60_000);
  expect(flow.state).toBe("needs_decision");
  expect(flow.stateDetail).toContain(`background task ${TASK_ID}`);
  expect(flow.stateDetail).toContain("exceeded 60 min");
  expect(flow.stateDetail).toContain("left running");
  expect(flow.decisionRequired).toBe(true);
  /* Parking stops nothing: no round, no relay, and the transcript untouched. */
  expect(flow.rounds).toEqual([]);
  expect(fs.readFileSync(transcript, "utf8")).toBe(transcriptBefore);
});

test("a review flow reads the implementer's READY marker on the turn after its background command reports", async () => {
  const start = Date.parse("2026-09-19T12:00:00.000Z");
  const flow = waitingFlow(start - 60_000);
  append(
    records.prompt(start, "Fix the findings"),
    records.backgroundStart(start + 1_000),
    records.endTurn(start + 2_000, "REVIEW_READY: fixed, pending the suite"),
  );
  await tickFlowAt(flow, start + 5_000);
  expect(flow.state).toBe("waiting_ready");
  expect(flow.rounds).toEqual([]);
  expect(flow.backgroundWait?.tasks).toEqual([{ id: TASK_ID, kind: "command" }]);

  append(records.notification(start + 30 * 60_000, TASK_ID, "completed"), records.endTurn(start + 30 * 60_000 + 20, "REVIEW_READY: fixed, suite green"));
  await tickFlowAt(flow, start + 31 * 60_000);
  expect(flow.state).toBe("spawn_pending");
  expect(flow.rounds.map((round) => round.readyNote)).toEqual(["fixed, suite green"]);
  expect(flow.backgroundWait ?? null).toBeNull();
  expect(flow.stateDetail).toBeNull();
});
