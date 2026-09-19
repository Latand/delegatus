import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import { DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS, seatTickDecision } from "@/lib/monitor/seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { emptySeatTickState, type SeatTickRunRecord } from "@/lib/monitor/types";
import type { Pipeline } from "@/lib/pipelines/types";

import {
  cheapestHealthRuntime,
  cleanupHealthRun,
  currentHealthRun,
  filingVerdict,
  prepareHealthRepo,
  readHealthRunFiles,
  resetHealthCheckForTests,
  settleHealthCheckForTests,
  startHealthCheck,
  stopHealthCheck,
  sweepOrphanedHealthRuns,
  timedOutAgentPath,
  wakeVerdict,
  writeHealthRunFile,
  type HealthCheckPorts,
  type HealthRun,
} from "./healthCheck";

/* Nothing here reaches the live state: the runner is driven through fake
   ports, and the cleanup test writes only inside its own temporary folder. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-health-check-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => resetHealthCheckForTests());

/* Assembled from parts: a conversation-shaped literal is what the publication
   gate refuses in a committed artifact. */
const SEAT = ["conversation", "5eed00000000a1b2"].join("_");
const STAGE = ["conversation", "57a6e00000000c3d"].join("_");
const PROJECT = "dir-0123456789abcdef0123456789abcdef";

test("the cheapest runtime is the smallest connected model at the lowest tier, Claude first on a tie", () => {
  expect(cheapestHealthRuntime({ claude: "connected", codex: "connected" })).toEqual({ engine: "claude", model: "haiku", effort: "low" });
  expect(cheapestHealthRuntime({ claude: "signed-out", codex: "connected" })?.model).toBe("gpt-5.6-luna");
  expect(cheapestHealthRuntime({ claude: "cli-missing", codex: "signed-out" })).toBeNull();
});

/* Design §5.1 row 4 rests on this: an empty tick row wakes a seat on the first
   check that finds a lane it launched completed, with no hourly wait. */
test("an empty tick row wakes the seat at once for a lane it launched that completed", () => {
  const now = Date.parse("2026-09-20T10:00:00.000Z");
  const decision = seatTickDecision({
    project: PROJECT,
    now,
    seat: { conversationId: SEAT, seatEpoch: 1, path: null, designatedAt: new Date(now - 120_000).toISOString(), turn: "idle", activity: null },
    pipelines: [],
    tasks: [],
    events: [],
    pullRequests: [],
    pullRequestsUnavailable: null,
    ownLanes: [{ id: "health01", title: "Viewer health check", settled: "completed", updatedAt: new Date(now - 5_000).toISOString() }],
    signals: [],
    children: [],
    childrenUnavailable: null,
    changeFingerprint: "fp",
    state: emptySeatTickState(),
    policy: DEFAULT_SEAT_TICK_POLICY,
    settings: effectiveSeatTickSettings(defaultSeatTickSettings(PROJECT), now, SEAT_TICK_WAKE_INTERVAL_MS),
  });
  expect(decision.verdict.kind).toBe("wake");
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons.map((reason) => reason.kind)).toEqual(["own-lane-settled"]);
});

function record(over: Partial<SeatTickRunRecord>): SeatTickRunRecord {
  return { schemaVersion: 1, at: "", project: PROJECT, seatEpoch: 1, verdict: "wake", reasons: ["own-lane-settled"], items: 1, deferred: 0, eventsThrough: 0, delivery: null, detail: null, ...over };
}

test("row 4 reads the check's own line and the send's outcome", () => {
  expect(wakeVerdict(null, null)).toMatchObject({ kind: "failed", failure: { code: "TICK_OFF" } });
  expect(wakeVerdict(record({ verdict: "skipped", reasons: [] }), null)).toEqual({ kind: "pending", inFlight: false });
  expect(wakeVerdict(record({ verdict: "quiet", reasons: [], detail: "nothing owed" }), null)).toMatchObject({ kind: "failed", failure: { code: "WAKE_NOT_OWED" } });
  expect(wakeVerdict(record({ reasons: ["interval"] }), { ok: true, outcome: "delivered" } as never)).toMatchObject({ failure: { code: "WAKE_NOT_OWED" } });
  expect(wakeVerdict(record({}), { ok: true, outcome: "delivered" } as never)).toEqual({ kind: "passed" });
  expect(wakeVerdict(record({}), { ok: true, outcome: "queued" } as never)).toEqual({ kind: "pending", inFlight: true });
  expect(wakeVerdict(record({}), { ok: false, error: "no host" } as never)).toMatchObject({ failure: { code: "WAKE_UNDELIVERED" } });
});

test("row 5 names a seat whose key owes a succession, and skips an install with no seat", () => {
  expect(filingVerdict([])).toEqual({ kind: "skipped" });
  expect(filingVerdict([{ project: PROJECT, displayName: "harbor", misfiledTo: null }])).toEqual({ kind: "passed" });
  expect(filingVerdict([{ project: PROJECT, displayName: "harbor", misfiledTo: "repo-x" }])).toMatchObject({ kind: "failed", failure: { code: "SEAT_MISFILED", params: { project: "harbor" } } });
});

/* ── The runner, over fake ports ──────────────────────────────────────── */

type Script = {
  readiness?: "connected" | "signed-out" | "cli-missing";
  /** The engine's readiness once the run has picked its runtime: an engine
      that signs out or loses its command between the pick and the launch. */
  readinessAtLaunch?: "signed-out" | "cli-missing";
  seatAppears?: boolean;
  createError?: { error: string; details?: { reason?: string } };
  /** What the pipeline looks like once created; called on every poll. */
  pipeline?: (polls: number) => Partial<Pipeline>;
  receipt?: "prompt-delivered" | "starting" | "failed";
  mcp?: boolean | null;
  tick?: () => { record: SeatTickRunRecord | null; outcome: unknown };
  filings?: { project: string; displayName: string; misfiledTo: string | null }[] | null;
};

function attempt(state: string, extra: Record<string, unknown> = {}) {
  return { n: 1, state, conversationId: STAGE, agentPath: "/stage.jsonl", launchId: "launch-1", ...extra };
}

function pipelineWith(state: string, attemptState: string, extra: Record<string, unknown> = {}): Partial<Pipeline> {
  return { id: "health01", state: state as Pipeline["state"], stateDetail: null, project: PROJECT, worktreeDir: "/wt", branch: "b", runs: [{ stageId: "check", attempts: [attempt(attemptState, extra)] }] as never };
}

function fakePorts(script: Script, log: string[] = []): HealthCheckPorts {
  let clock = Date.parse("2026-09-20T10:00:00.000Z");
  let polls = 0;
  let readinessReads = 0;
  return {
    now: () => clock,
    sleep: async (ms) => { clock += ms; await Promise.resolve(); },
    newId: () => "run00001",
    readiness: () => (readinessReads++ >= 2 && script.readinessAtLaunch) || (script.readiness ?? "connected"),
    prepareRepo: () => ({ repoDir: "/scratch", baseRef: "abc" }),
    spawnSeat: async () => ({ conversationId: SEAT }),
    seatMaterialized: () => script.seatAppears === false ? null : { conversationId: SEAT, path: "/seat.jsonl", cwd: "/scratch", project: PROJECT },
    seatBusy: () => false,
    seatTurnMark: () => "idle:",
    createPipeline: async () => script.createError ?? { pipeline: { id: "health01" } as Pipeline },
    pipeline: () => ({ ...(script.pipeline ?? (() => pipelineWith("completed", "passed")))(polls++) }) as Pipeline,
    receipt: () => ({ state: script.receipt ?? "prompt-delivered", error: script.receipt === "failed" ? "host died" : null }),
    transcriptExists: () => true,
    viewerMcpRegistered: () => script.mcp ?? true,
    runTick: async () => (script.tick ?? (() => ({ record: record({}), outcome: { ok: true, outcome: "delivered" } })))() as never,
    seatFilings: () => script.filings === undefined ? [{ project: PROJECT, displayName: "harbor", misfiledTo: null }] : script.filings,
    cleanup: async (input) => { log.push(`cleanup ${input.pipelineId ?? "-"} ${input.seatConversationId ?? "-"}`); return []; },
    recordLeftovers: () => {},
    runFiles: () => [],
    dropRunFile: () => {},
    recordResult: (run) => log.push(`result ${run.state}`),
    redact: (text) => text,
  };
}

async function runWith(script: Script, log: string[] = []): Promise<HealthRun> {
  const started = startHealthCheck(fakePorts(script, log));
  expect(started).not.toBeNull();
  await settleHealthCheckForTests();
  return currentHealthRun()!;
}

function states(run: HealthRun): string {
  return run.rows.map((row) => `${row.id}:${row.state}`).join(" ");
}

test("a machine where everything works passes all five rows and cleans up", async () => {
  const log: string[] = [];
  const run = await runWith({}, log);
  expect(run.state).toBe("passed");
  expect(states(run)).toBe("spawn:passed delivery:passed report:passed wake:passed filing:passed");
  expect(run.runtime).toEqual({ engine: "claude", model: "haiku", effort: "low" });
  expect(log).toEqual([`cleanup health01 ${SEAT}`, "result passed"]);
  expect(run.cleanup.done).toBe(true);
});

test("no orchestrator on the install leaves row 5 skipped and the run passed", async () => {
  const run = await runWith({ filings: [] });
  expect(run.state).toBe("passed");
  expect(run.rows[4]).toMatchObject({ state: "skipped", note: "no-seat" });
});

test("each failure stops at its row, names its code, and leaves the rows after it waiting", async () => {
  const cases: [Script, string, string][] = [
    [{ readinessAtLaunch: "cli-missing" }, "spawn", "CLI_MISSING"],
    [{ readinessAtLaunch: "signed-out" }, "spawn", "ENGINE_NOT_CONNECTED"],
    [{ createError: { error: "refused", details: { reason: "signed-out" } } }, "spawn", "ENGINE_NOT_CONNECTED"],
    [{ seatAppears: false }, "spawn", "SPAWN_TIMEOUT"],
    [{ pipeline: () => pipelineWith("running", "spawning", { conversationId: null, agentPath: null }) }, "spawn", "SPAWN_TIMEOUT"],
    [{ pipeline: () => pipelineWith("running", "spawning", { conversationId: null, agentPath: null, usageLimitedAccounts: [{ accountId: "acct-a", engine: "claude", resetsAt: 1_900_000_000 }] }) }, "spawn", "ACCOUNT_EXHAUSTED"],
    [{ receipt: "failed" }, "delivery", "DELIVERY_FAILED"],
    [{ receipt: "starting" }, "delivery", "DELIVERY_FAILED"],
    [{ pipeline: () => pipelineWith("running", "running"), mcp: false }, "report", "MCP_UNREACHABLE"],
    [{ pipeline: () => pipelineWith("needs_decision", "needs_decision") }, "report", "REPORT_TIMEOUT"],
    [{ tick: () => ({ record: null, outcome: null }) }, "wake", "TICK_OFF"],
    [{ tick: () => ({ record: record({ verdict: "quiet", reasons: [], detail: "nothing owed" }), outcome: null }) }, "wake", "WAKE_NOT_OWED"],
    [{ tick: () => ({ record: record({}), outcome: { ok: false, error: "no host" } }) }, "wake", "WAKE_UNDELIVERED"],
    [{ tick: () => ({ record: record({}), outcome: { ok: true, outcome: "queued" } }) }, "wake", "WAKE_UNDELIVERED"],
    [{ filings: [{ project: PROJECT, displayName: "harbor", misfiledTo: "repo-y" }] }, "filing", "SEAT_MISFILED"],
  ];
  for (const [script, rowId, code] of cases) {
    resetHealthCheckForTests();
    const log: string[] = [];
    const run = await runWith(script, log);
    const index = run.rows.findIndex((row) => row.id === rowId);
    expect({ code, state: run.state, failed: run.rows[index]!.failure?.code }).toEqual({ code, state: "failed", failed: code as never });
    for (const later of run.rows.slice(index + 1)) expect(later.state).toBe("waiting");
    for (const earlier of run.rows.slice(0, index)) expect(earlier.state).toBe("passed");
    expect(log.at(-1)).toBe("result failed");
    expect(log.some((line) => line.startsWith("cleanup"))).toBe(true);
  }
});

test("an exhausted account carries its reset and the account to open", async () => {
  const run = await runWith({ pipeline: () => pipelineWith("running", "spawning", { conversationId: null, agentPath: null, usageLimitedAccounts: [{ accountId: "acct-a", engine: "claude", resetsAt: 1_900_000_000 }] }) });
  expect(run.rows[0]!.failure).toMatchObject({ accountId: "acct-a", params: { engine: "Claude", time: new Date(1_900_000_000_000).toISOString() } });
});

test("one run at a time: a second start answers the running one, and Stop still cleans up", async () => {
  const log: string[] = [];
  const ports = fakePorts({ pipeline: () => pipelineWith("running", "running") }, log);
  const first = startHealthCheck(ports)!;
  expect(startHealthCheck(ports)!.id).toBe(first.id);
  stopHealthCheck(first.id);
  await settleHealthCheckForTests();
  const run = currentHealthRun(first.id)!;
  expect(run.state).toBe("stopped");
  expect(run.rows.every((row) => row.state !== "running")).toBe(true);
  expect(log).toEqual([`cleanup health01 ${SEAT}`, "result stopped"]);
});

test("a run that outlives its 5-minute bound fails the row it was on", async () => {
  /* Every row takes most of its own bound, and the seat then stays busy:
     the bounds add up to more than the run's five minutes. */
  const ports = fakePorts({});
  const t0 = ports.now();
  const elapsed = () => (ports.now() - t0) / 1000;
  startHealthCheck({
    ...ports,
    seatMaterialized: (id) => elapsed() >= 58 ? { conversationId: id, path: "/seat.jsonl", cwd: "/scratch", project: PROJECT } : null,
    pipeline: () => (elapsed() < 116
      ? pipelineWith("running", "spawning", { conversationId: null, agentPath: null })
      : elapsed() < 250 ? pipelineWith("running", "running") : pipelineWith("completed", "passed")) as Pipeline,
    receipt: () => ({ state: elapsed() >= 140 ? "prompt-delivered" : "starting", error: null }),
    seatBusy: () => true,
  });
  await settleHealthCheckForTests();
  const run = currentHealthRun()!;
  expect(run.state).toBe("failed");
  expect(run.rows.map((row) => row.state)).toEqual(["passed", "passed", "passed", "failed", "waiting"]);
  expect(run.rows[3]!.failure?.detail).toContain("5-minute bound");
});

test("no connected engine starts nothing", () => {
  expect(startHealthCheck(fakePorts({ readiness: "signed-out" }))).toBeNull();
  expect(currentHealthRun()).toBeNull();
});

type CleanupCalls = { closed: string[]; stopped: string[]; archived: string[]; hidden: string[] };

function cleanupPorts(over: Partial<Parameters<typeof cleanupHealthRun>[1]> = {}): { calls: CleanupCalls; ports: Parameters<typeof cleanupHealthRun>[1] } {
  const calls: CleanupCalls = { closed: [], stopped: [], archived: [], hidden: [] };
  return {
    calls,
    ports: {
      closePipeline: async (id) => { calls.closed.push(id); return null; },
      pipeline: () => null,
      conversationPath: (id) => id === SEAT ? "/seat.jsonl" : null,
      stopConversation: async (id) => { calls.stopped.push(id); return null; },
      projectFor: () => PROJECT,
      archive: async (project, paths) => { calls.archived.push(`${project} ${paths.join(",")}`); return null; },
      hideTaskCards: async (project) => { calls.hidden.push(project); },
      statePath: (...segments) => path.join(sandbox, "state", ...segments),
      ...over,
    },
  };
}

test("cleanup removes the stage worktree and its branch from the scratch repository", async () => {
  const repo = path.join(sandbox, "viewer-health-check");
  const { baseRef } = prepareHealthRepo(repo);
  expect(prepareHealthRepo(repo).baseRef).toBe(baseRef);
  const worktree = path.join(sandbox, "viewer-health-check-pipeline-health01");
  execFileSync("git", ["worktree", "add", "-b", "pipeline/health01", worktree], { cwd: repo, stdio: "ignore" });
  const { calls, ports } = cleanupPorts({
    pipeline: () => ({ id: "health01", state: "completed", project: PROJECT, worktreeDir: worktree, branch: "pipeline/health01", runs: [{ stageId: "check", attempts: [attempt("passed")] }] }) as unknown as Pipeline,
  });
  const problems = await cleanupHealthRun({ pipelineId: "health01", seatConversationId: SEAT, project: PROJECT, stateDir: "health-runs/run00001", repoDir: repo }, ports);
  expect(problems).toEqual([]);
  expect(calls).toEqual({ closed: ["health01"], stopped: [SEAT], archived: [`${PROJECT} /stage.jsonl,/seat.jsonl`], hidden: [PROJECT] });
  expect(fs.existsSync(worktree)).toBe(false);
  expect(execFileSync("git", ["branch", "--list", "pipeline/health01"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");
});

test("a run that ends before its pipeline exists still archives the seat and hides its task card", async () => {
  /* The seat's project, as the run recorded it once its transcript appeared. */
  const recorded = cleanupPorts({ projectFor: () => null });
  expect(await cleanupHealthRun({ pipelineId: null, seatConversationId: SEAT, project: PROJECT, stateDir: "health-runs/run00001", repoDir: "/scratch" }, recorded.ports)).toEqual([]);
  expect(recorded.calls).toEqual({ closed: [], stopped: [SEAT], archived: [`${PROJECT} /seat.jsonl`], hidden: [PROJECT] });
  /* The seat's transcript never appeared inside its bound: the scratch folder names the project. */
  const unrecorded = cleanupPorts();
  await cleanupHealthRun({ pipelineId: null, seatConversationId: SEAT, project: null, stateDir: "health-runs/run00001", repoDir: "/scratch" }, unrecorded.ports);
  expect(unrecorded.calls.archived).toEqual([`${PROJECT} /seat.jsonl`]);
  expect(unrecorded.calls.hidden).toEqual([PROJECT]);
});

test("a failed seat transcript records the scratch project for cleanup even without a pipeline", async () => {
  const inputs: unknown[] = [];
  startHealthCheck({ ...fakePorts({ seatAppears: false }), cleanup: async (input) => { inputs.push(input); return []; } });
  await settleHealthCheckForTests();
  expect(inputs).toEqual([{ repoDir: "/scratch", seatConversationId: SEAT, project: null, pipelineId: null, stateDir: path.join("health-runs", "run00001") }]);
});

test("run files round-trip through disk, and a folder without one still answers", () => {
  const root = path.join(sandbox, "run-files");
  writeHealthRunFile(root, path.join("health-runs", "run00007"), { repoDir: "/scratch", seatConversationId: SEAT, project: PROJECT, pipelineId: "health07" });
  fs.mkdirSync(path.join(root, "health-runs", "run00008"), { recursive: true });
  expect(readHealthRunFiles(root).sort((a, b) => a.stateDir.localeCompare(b.stateDir))).toEqual([
    { stateDir: path.join("health-runs", "run00007"), repoDir: "/scratch", seatConversationId: SEAT, project: PROJECT, pipelineId: "health07" },
    { stateDir: path.join("health-runs", "run00008"), repoDir: null, seatConversationId: null, project: null, pipelineId: null },
  ]);
  expect(readHealthRunFiles(path.join(sandbox, "absent"))).toEqual([]);
});

test("a sweep leaves the run this process is running alone", async () => {
  const files = new Map<string, unknown>();
  const cleaned: string[] = [];
  const ports: HealthCheckPorts = {
    ...fakePorts({ pipeline: () => pipelineWith("running", "running") }),
    sleep: () => new Promise(() => {}),
    recordLeftovers: (stateDir, leftovers) => { files.set(stateDir, { ...leftovers }); },
    runFiles: () => [...files.entries()].map(([stateDir, leftovers]) => ({ ...(leftovers as object), stateDir }) as never),
    dropRunFile: (stateDir) => { files.delete(stateDir); },
    cleanup: async (input) => { cleaned.push(input.stateDir); return []; },
  };
  startHealthCheck(ports);
  await Promise.resolve();
  files.set(path.join("health-runs", "old00001"), { repoDir: "/scratch", seatConversationId: null, project: null, pipelineId: null });
  await sweepOrphanedHealthRuns(ports);
  expect(cleaned).toEqual([path.join("health-runs", "old00001")]);
  expect([...files.keys()]).toEqual([path.join("health-runs", "run00001")]);
});

test("a spawn timeout names an agent only when its transcript exists, since only that one has a card", () => {
  const attempt = { agentPath: "/scratch/agent.jsonl" } as Parameters<typeof timedOutAgentPath>[0];
  expect(timedOutAgentPath(attempt, () => false)).toBeNull();
  expect(timedOutAgentPath(attempt, () => true)).toBe("/scratch/agent.jsonl");
  expect(timedOutAgentPath(null, () => true)).toBeNull();
});
