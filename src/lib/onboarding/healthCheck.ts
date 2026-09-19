import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { EngineReadiness } from "@/lib/accounts/engineConnection";
import { effortScale } from "@/lib/agent/efforts";
import type { SpawnReceipt } from "@/lib/agent/registry";
import type { DeliveryOutcome } from "@/lib/delivery";
import type { SeatTickRunRecord } from "@/lib/monitor/types";
import type { CreatePipelineRequest, Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { modelSizeClass } from "@/lib/roles/costHints";
import type { RoleEngine } from "@/lib/roles/types";

import viewerPackageManifest from "../../../package.json";

/**
 * The setup guide's health check (#1876, design §5): one throw-away pipeline on
 * the cheapest model this machine can run, and a test orchestrator that pipeline
 * belongs to. Each row is a durable fact the Viewer records, never the agent's
 * own claim:
 *
 *  1. An agent starts: the test orchestrator's launch and then the stage's
 *     launch each gain a conversation with a transcript on disk.
 *  2. A message reaches it: the stage's launch receipt says its prompt was
 *     delivered into the live host.
 *  3. The stage reports back: the attempt settles `passed` on its own
 *     `stage_report`, and the pipeline completes.
 *  4. The orchestrator is woken: one real seat tick check of the scratch
 *     project decides `wake` for "a lane you launched is completed" and the
 *     delivery reaches the idle test orchestrator.
 *  5. Your orchestrators are filed under the right project: every active seat's
 *     key still names the project its folder resolves to now (#1874).
 *
 * Row 4 runs the production check (`runSeatTickCheck`: the gather, the
 * decision, the send) with the test orchestrator handed in as the scratch
 * project's seat through the check's sources, and on a tick row of its own.
 * Nothing is written to the seat store: a seat cannot be ended outside
 * `src/lib/orchestrator/` (only a rotation or a stillborn rollback removes
 * one), so a designated scratch seat would outlive the run and be woken by the
 * real tick every day. What this leaves unproven is the seat store's own
 * lookup, which row 5 reads for every real seat.
 *
 * The check never touches the user's projects, never wakes a real seat, and
 * cleans up after itself whatever happens: the pipeline is closed, both hosts
 * stopped, the worktree and its branch removed, both conversations archived
 * off the scratch board and its task cards hidden.
 */

/* ── Rows, codes, bounds ──────────────────────────────────────────────── */

export const HEALTH_ROWS = ["spawn", "delivery", "report", "wake", "filing"] as const;
export type HealthRowId = typeof HEALTH_ROWS[number];
export type HealthRowState = "waiting" | "running" | "passed" | "failed" | "skipped";

export const HEALTH_FAILURE_CODES = [
  "CLI_MISSING",
  "ENGINE_NOT_CONNECTED",
  "ACCOUNT_EXHAUSTED",
  "SPAWN_TIMEOUT",
  "DELIVERY_FAILED",
  "MCP_UNREACHABLE",
  "REPORT_TIMEOUT",
  "TICK_OFF",
  "WAKE_NOT_OWED",
  "WAKE_UNDELIVERED",
  "SEAT_MISFILED",
] as const;
export type HealthFailureCode = typeof HEALTH_FAILURE_CODES[number];

/** Bounds per row (design §5.1). The spawn bound applies to each of the two
    launches; filing is a pure read. */
export const HEALTH_ROW_BOUND_MS: Record<HealthRowId, number> = {
  spawn: 60_000,
  delivery: 30_000,
  report: 120_000,
  wake: 60_000,
  filing: 0,
};
export const HEALTH_RUN_BOUND_MS = 5 * 60_000;
const POLL_MS = 1_000;

export type HealthRuntime = { engine: RoleEngine; model: string; effort: string };

export type HealthFailure = {
  code: HealthFailureCode;
  /** Values the row's sentences name: engine, bin, time, project. */
  params: Record<string, string>;
  /** The machine detail behind "Show details", redacted. */
  detail: string;
  /** The conversation "Open the agent" opens, when one exists. */
  agentPath: string | null;
  /** The account "Open Accounts" focuses, for an exhausted one. */
  accountId: string | null;
};

export type HealthRow = {
  id: HealthRowId;
  state: HealthRowState;
  startedAt: string | null;
  finishedAt: string | null;
  failure: HealthFailure | null;
  /** Why a row was skipped: row 5 with no orchestrator on this install. */
  note: "no-seat" | null;
};

export type HealthRunState = "running" | "passed" | "failed" | "stopped";

export type HealthRun = {
  id: string;
  state: HealthRunState;
  startedAt: string;
  finishedAt: string | null;
  runtime: HealthRuntime;
  rows: HealthRow[];
  /** Cleanup is part of the run: a step that could not be undone is named. */
  cleanup: { done: boolean; problems: string[] };
  version: string;
};

/* ── The cheapest runtime ─────────────────────────────────────────────── */

const CHEAPEST_MODEL: Record<RoleEngine, string> = { claude: "haiku", codex: "gpt-5.6-luna" };

/**
 * The smallest size class among connected engines at the lowest tier of its
 * scale; Claude before Codex on a tie. Null when no engine can run a launch.
 */
export function cheapestHealthRuntime(readiness: Record<RoleEngine, EngineReadiness>): HealthRuntime | null {
  const candidates = (["claude", "codex"] as const)
    .filter((engine) => readiness[engine] === "connected")
    .map((engine) => {
      const model = CHEAPEST_MODEL[engine];
      const effort = effortScale(engine, model)?.[0] ?? "low";
      return { engine, model, effort, size: modelSizeClass(model) };
    });
  if (!candidates.length) return null;
  const best = candidates.reduce((held, candidate) => candidate.size < held.size ? candidate : held);
  return { engine: best.engine, model: best.model, effort: best.effort };
}

/* ── What each row observes, as pure functions ────────────────────────── */

const ENGINE_BIN: Record<RoleEngine, string> = { claude: "claude", codex: "codex" };

function failure(code: HealthFailureCode, detail: string, extra: Partial<Omit<HealthFailure, "code" | "detail">> = {}): HealthFailure {
  return { code, detail, params: extra.params ?? {}, agentPath: extra.agentPath ?? null, accountId: extra.accountId ?? null };
}

/** An engine that cannot run a launch, as the row 1 failure it is. */
export function readinessFailure(runtime: HealthRuntime, readiness: EngineReadiness): HealthFailure | null {
  if (readiness === "connected") return null;
  const params = { engine: runtime.engine === "claude" ? "Claude" : "Codex", bin: ENGINE_BIN[runtime.engine] };
  return readiness === "cli-missing"
    ? failure("CLI_MISSING", `engine readiness: ${readiness}`, { params })
    : failure("ENGINE_NOT_CONNECTED", `engine readiness: ${readiness}`, { params });
}

/** The newest attempt of the pipeline's one stage. */
export function healthAttempt(pipeline: Pipeline | null): PipelineStageAttempt | null {
  return pipeline?.runs[0]?.attempts.at(-1) ?? null;
}

/** The agent a SPAWN_TIMEOUT can point at: only one whose transcript exists
    has a card to open. */
export function timedOutAgentPath(attempt: PipelineStageAttempt | null, transcriptExists: (file: string) => boolean): string | null {
  return attempt?.agentPath && transcriptExists(attempt.agentPath) ? attempt.agentPath : null;
}

/**
 * Row 1 for the stage: the attempt holds a conversation whose transcript exists.
 * `pending` while it may still come; a failure once the pipeline says why it
 * cannot.
 */
export function stageSpawnVerdict(
  pipeline: Pipeline | null,
  runtime: HealthRuntime,
  transcriptExists: (file: string) => boolean,
): { kind: "passed" } | { kind: "pending" } | { kind: "failed"; failure: HealthFailure } {
  const attempt = healthAttempt(pipeline);
  if (attempt?.conversationId && attempt.agentPath && transcriptExists(attempt.agentPath)) return { kind: "passed" };
  const params = { engine: runtime.engine === "claude" ? "Claude" : "Codex", bin: ENGINE_BIN[runtime.engine] };
  const limited = (attempt?.usageLimitedAccounts ?? []).filter((entry) => !entry.engine || entry.engine === runtime.engine);
  if (limited.length) {
    const reset = limited.map((entry) => entry.resetsAt).filter((at): at is number => typeof at === "number").sort((a, b) => a - b)[0];
    return {
      kind: "failed",
      failure: failure("ACCOUNT_EXHAUSTED", `usage-limited accounts: ${limited.length}`, {
        params: { ...params, time: reset ? new Date(reset * 1000).toISOString() : "" },
        accountId: limited[0]!.accountId,
      }),
    };
  }
  const detail = pipeline?.stateDetail ?? "";
  if (/command was not found/.test(detail)) return { kind: "failed", failure: failure("CLI_MISSING", detail, { params }) };
  if (/account is signed in/.test(detail)) return { kind: "failed", failure: failure("ENGINE_NOT_CONNECTED", detail, { params }) };
  return { kind: "pending" };
}

const PROMPT_DELIVERED: ReadonlySet<SpawnReceipt["state"]> = new Set(["prompt-delivered", "path-pending", "completed"]);

/** Row 2: the stage launch's receipt records its prompt as delivered. */
export function deliveryVerdict(receipt: Pick<SpawnReceipt, "state" | "error"> | null): { kind: "passed" } | { kind: "pending" } | { kind: "failed"; detail: string } {
  if (!receipt) return { kind: "pending" };
  if (PROMPT_DELIVERED.has(receipt.state)) return { kind: "passed" };
  if (receipt.state === "failed" || receipt.state === "conflicted") return { kind: "failed", detail: `launch receipt ${receipt.state}: ${receipt.error ?? "no reason recorded"}` };
  return { kind: "pending" };
}

/** Row 3: the attempt settled `passed` and the pipeline completed. */
export function reportVerdict(pipeline: Pipeline | null): { kind: "passed" } | { kind: "pending" } | { kind: "failed"; detail: string } {
  const attempt = healthAttempt(pipeline);
  if (!pipeline || !attempt) return { kind: "pending" };
  if (attempt.state === "passed" && pipeline.state === "completed") return { kind: "passed" };
  if (attempt.state === "failed" || attempt.state === "needs_decision" || pipeline.state === "needs_decision") {
    return { kind: "failed", detail: `attempt ${attempt.state}, pipeline ${pipeline.state}${pipeline.stateDetail ? `: ${pipeline.stateDetail}` : ""}` };
  }
  return { kind: "pending" };
}

/** Why the stage did not report: no `viewer` MCP server in its session, or a
    model that ended its turn without calling the tool. */
export function reportFailure(detail: string, mcpRegistered: boolean | null, agentPath: string | null): HealthFailure {
  return mcpRegistered === false
    ? failure("MCP_UNREACHABLE", `${detail}; the viewer MCP server is not registered for the stage's folder`, { agentPath })
    : failure("REPORT_TIMEOUT", detail, { agentPath });
}

/** Undelivered outcomes: the send was taken and has not reached the seat yet. */
const IN_FLIGHT = new Set(["held", "queued", "delivering", "pending"]);

/**
 * Row 4 from one check's journal line and the send's own outcome. `pending`
 * means the check skipped a busy seat, or the send is still in flight; the
 * caller retries inside the row's bound.
 */
export function wakeVerdict(
  record: SeatTickRunRecord | null,
  outcome: DeliveryOutcome | null,
): { kind: "passed" } | { kind: "pending"; inFlight: boolean } | { kind: "failed"; failure: HealthFailure } {
  if (record === null) return { kind: "failed", failure: failure("TICK_OFF", "the seat tick policy is off (LLV_SEAT_TICK_CHECK_MINUTES=0)") };
  const line = `verdict ${record.verdict}${record.reasons.length ? ` (${record.reasons.join(", ")})` : ""}${record.detail ? `: ${record.detail}` : ""}${record.delivery ? `; delivery ${record.delivery.outcome}` : ""}`;
  if (record.verdict === "skipped") return { kind: "pending", inFlight: false };
  if (record.verdict !== "wake" || !record.reasons.includes("own-lane-settled")) {
    return { kind: "failed", failure: failure("WAKE_NOT_OWED", line) };
  }
  if (outcome?.ok && !IN_FLIGHT.has(outcome.outcome ?? "delivered")) return { kind: "passed" };
  if (outcome?.ok) return { kind: "pending", inFlight: true };
  return { kind: "failed", failure: failure("WAKE_UNDELIVERED", line) };
}

export type SeatFiling = { project: string; displayName: string; misfiledTo: string | null };

/** Row 5: every active seat whose key owes a succession is misfiled. */
export function filingVerdict(seats: readonly SeatFiling[] | null): { kind: "passed" } | { kind: "skipped" } | { kind: "failed"; failure: HealthFailure } {
  if (seats === null) return { kind: "failed", failure: failure("SEAT_MISFILED", "the orchestrator seat record could not be read") };
  if (!seats.length) return { kind: "skipped" };
  const misfiled = seats.filter((seat) => seat.misfiledTo !== null);
  if (!misfiled.length) return { kind: "passed" };
  const first = misfiled[0]!;
  return {
    kind: "failed",
    failure: failure("SEAT_MISFILED", misfiled.map((seat) => `${seat.project} -> ${seat.misfiledTo}`).join("; "), { params: { project: first.displayName } }),
  };
}

/* ── The runner ───────────────────────────────────────────────────────── */

export const HEALTH_SEAT_PROMPT = [
  "You are a test seat for the Viewer's health check.",
  "When you receive a wake, reply with the single word ok.",
  "Do nothing else: call no tools and change no files.",
].join("\n");

export const HEALTH_STAGE_PROMPT = "Health check from the Viewer. Do nothing in the repository. Call stage_report with verdict pass, findings [], summary \"ok\".";

export const HEALTH_PIPELINE_TASK = "Viewer health check";

export type HealthSeat = { conversationId: string; path: string; cwd: string; project: string };

/** Everything the runner touches, so a test drives each row to each outcome. */
export interface HealthCheckPorts {
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
  readiness(engine: RoleEngine): EngineReadiness;
  /** The scratch repository: created on first use, committed, no origin. */
  prepareRepo(): { repoDir: string; baseRef: string };
  /** Launch the test orchestrator; answers its conversation id or a refusal. */
  spawnSeat(input: { runtime: HealthRuntime; cwd: string; clientAttemptId: string }): Promise<{ conversationId: string } | { error: string; code: string | null; reason: EngineReadiness | null }>;
  /** The seat conversation once its transcript exists on disk, else null. */
  seatMaterialized(conversationId: string): HealthSeat | null;
  seatBusy(conversationId: string): boolean;
  /** A marker that moves when the seat starts or ends a turn. */
  seatTurnMark(conversationId: string): string;
  createPipeline(request: CreatePipelineRequest): Promise<{ pipeline?: Pipeline; error?: string; code?: string; details?: { reason?: string } }>;
  pipeline(id: string): Pipeline | null;
  receipt(launchId: string): Pick<SpawnReceipt, "state" | "error"> | null;
  transcriptExists(file: string): boolean;
  viewerMcpRegistered(engine: RoleEngine, cwd: string): boolean | null;
  runTick(seat: HealthSeat, stateDir: string): Promise<{ record: SeatTickRunRecord | null; outcome: DeliveryOutcome | null }>;
  seatFilings(): SeatFiling[] | null;
  cleanup(input: { pipelineId: string | null; seatConversationId: string | null; stateDir: string; repoDir: string | null }): Promise<string[]>;
  recordResult(run: HealthRun): void;
  redact(text: string): string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function freshRows(): HealthRow[] {
  return HEALTH_ROWS.map((id) => ({ id, state: "waiting" as const, startedAt: null, finishedAt: null, failure: null, note: null }));
}

class RunStopped extends Error {}

type ActiveRun = { run: HealthRun; stop: () => void; stopped: boolean; done: Promise<void> };

const registry = globalThis as typeof globalThis & { __llvHealthCheck?: { active: ActiveRun | null; last: HealthRun | null } };
function store(): { active: ActiveRun | null; last: HealthRun | null } {
  registry.__llvHealthCheck ??= { active: null, last: null };
  return registry.__llvHealthCheck;
}

/** Copies, so a caller never holds the live record the runner mutates. */
function snapshot(run: HealthRun): HealthRun {
  return structuredClone(run);
}

/** The run in progress, or the last one this process finished. */
export function currentHealthRun(id?: string | null): HealthRun | null {
  const { active, last } = store();
  const run = active?.run ?? last;
  if (!run || (id && run.id !== id)) return null;
  return snapshot(run);
}

/**
 * Start a run, or answer the one already running (one at a time per install).
 * Null when no engine is connected: the step shows its own empty state.
 */
export function startHealthCheck(ports: HealthCheckPorts): HealthRun | null {
  const state = store();
  if (state.active) return snapshot(state.active.run);
  const runtime = cheapestHealthRuntime({ claude: ports.readiness("claude"), codex: ports.readiness("codex") });
  if (!runtime) return null;
  const run: HealthRun = {
    id: ports.newId(),
    state: "running",
    startedAt: iso(ports.now()),
    finishedAt: null,
    runtime,
    rows: freshRows(),
    cleanup: { done: false, problems: [] },
    version: String((viewerPackageManifest as { version?: unknown }).version ?? "unknown"),
  };
  let stop = () => {};
  const active: ActiveRun = { run, stop: () => stop(), stopped: false, done: Promise.resolve() };
  const stopped = new Promise<never>((_, reject) => { stop = () => { active.stopped = true; reject(new RunStopped()); }; });
  stopped.catch(() => {});
  state.active = active;
  active.done = executeHealthCheck(run, ports, stopped).finally(() => {
    state.last = run;
    if (state.active === active) state.active = null;
  });
  return snapshot(run);
}

/** Stop the running check; its cleanup still runs. */
export function stopHealthCheck(id: string): HealthRun | null {
  const { active } = store();
  if (!active || active.run.id !== id) return currentHealthRun(id);
  active.stop();
  return snapshot(active.run);
}

/** Test seam: wait for the run in progress to finish, cleanup included. */
export async function settleHealthCheckForTests(): Promise<void> {
  await store().active?.done;
}

export function resetHealthCheckForTests(): void {
  registry.__llvHealthCheck = { active: null, last: null };
}

async function executeHealthCheck(run: HealthRun, ports: HealthCheckPorts, stopped: Promise<never>): Promise<void> {
  const row = (id: HealthRowId) => run.rows.find((entry) => entry.id === id)!;
  const begin = (id: HealthRowId) => { const entry = row(id); entry.state = "running"; entry.startedAt = iso(ports.now()); };
  const pass = (id: HealthRowId) => { const entry = row(id); entry.state = "passed"; entry.finishedAt = iso(ports.now()); };
  const fail = (id: HealthRowId, found: HealthFailure): never => {
    const entry = row(id);
    entry.state = "failed";
    entry.finishedAt = iso(ports.now());
    entry.failure = { ...found, detail: ports.redact(found.detail) };
    throw new RowFailed();
  };
  const runDeadline = ports.now() + HEALTH_RUN_BOUND_MS;
  /* Every wait races the Stop button and the whole-run bound. */
  const wait = async (ms: number) => {
    /* Past the whole-run bound the row in progress fails on its own code;
       only the Stop button reads as stopped. */
    if (ports.now() >= runDeadline) throw new Error("the whole check passed its 5-minute bound");
    await Promise.race([ports.sleep(ms), stopped]);
  };
  /** Poll `probe` until it settles or `boundMs` passes; `null` means it did not. */
  const until = async <T>(boundMs: number, probe: () => T | null | Promise<T | null>): Promise<T | null> => {
    const deadline = ports.now() + boundMs;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (ports.now() >= deadline) return null;
      await wait(POLL_MS);
    }
  };

  const stateDir = path.join("health-runs", run.id);
  let pipelineId: string | null = null;
  let seatConversationId: string | null = null;
  let repoDir: string | null = null;
  try {
    const { runtime } = run;
    const agentParams = { engine: runtime.engine === "claude" ? "Claude" : "Codex", bin: ENGINE_BIN[runtime.engine] };

    /* 1. Two agents start: the test orchestrator, then the stage it launches. */
    begin("spawn");
    const ready = readinessFailure(runtime, ports.readiness(runtime.engine));
    if (ready) fail("spawn", ready);
    const repo = ports.prepareRepo();
    repoDir = repo.repoDir;
    const spawned = await ports.spawnSeat({ runtime, cwd: repo.repoDir, clientAttemptId: `health-seat-${run.id}` });
    if ("error" in spawned) {
      const refused = spawned.reason && spawned.reason !== "connected" ? readinessFailure(runtime, spawned.reason) : null;
      fail("spawn", refused ?? failure("SPAWN_TIMEOUT", `the test orchestrator's launch was refused: ${spawned.error}`, { params: agentParams }));
      return;
    }
    seatConversationId = spawned.conversationId;
    const seat = await until(HEALTH_ROW_BOUND_MS.spawn, () => ports.seatMaterialized(spawned.conversationId));
    if (!seat) fail("spawn", failure("SPAWN_TIMEOUT", "the test orchestrator's transcript did not appear within 60 seconds", { params: agentParams }));
    const created = await ports.createPipeline({
      task: HEALTH_PIPELINE_TASK,
      repoDir: repo.repoDir,
      baseBranch: "main",
      baseRef: repo.baseRef,
      src: seat!.path,
      publication: "internal",
      autoStart: true,
      stages: [{ id: "check", kind: "run", engine: runtime.engine, model: runtime.model, effort: runtime.effort, access: "read-only", "prompt": HEALTH_STAGE_PROMPT, next: null }],
    });
    if (!created.pipeline) {
      const reason = created.details?.reason;
      const refused = reason === "cli-missing" || reason === "signed-out" ? readinessFailure(runtime, reason) : null;
      fail("spawn", refused ?? failure("SPAWN_TIMEOUT", `the pipeline was refused: ${created.error ?? "no reason"}`, { params: agentParams }));
      return;
    }
    pipelineId = created.pipeline.id;
    const started = await until(HEALTH_ROW_BOUND_MS.spawn, () => {
      const verdict = stageSpawnVerdict(ports.pipeline(pipelineId!), runtime, ports.transcriptExists);
      return verdict.kind === "pending" ? null : verdict;
    });
    if (!started) fail("spawn", failure("SPAWN_TIMEOUT", `the stage agent did not start within 60 seconds${ports.pipeline(pipelineId)?.stateDetail ? `: ${ports.pipeline(pipelineId)!.stateDetail}` : ""}`, { params: agentParams, agentPath: timedOutAgentPath(healthAttempt(ports.pipeline(pipelineId)), ports.transcriptExists) }));
    if (started!.kind === "failed") fail("spawn", started!.failure);
    pass("spawn");

    /* 2. The stage's prompt was delivered into its live host. */
    begin("delivery");
    const stageAgent = () => healthAttempt(ports.pipeline(pipelineId!));
    const delivered = await until(HEALTH_ROW_BOUND_MS.delivery, () => {
      const launchId = stageAgent()?.launchId;
      const verdict = deliveryVerdict(launchId ? ports.receipt(launchId) : null);
      return verdict.kind === "pending" ? null : verdict;
    });
    if (!delivered) fail("delivery", failure("DELIVERY_FAILED", "the stage's launch receipt did not record a delivered prompt within 30 seconds", { agentPath: stageAgent()?.agentPath ?? null }));
    if (delivered!.kind === "failed") fail("delivery", failure("DELIVERY_FAILED", delivered!.detail, { agentPath: stageAgent()?.agentPath ?? null }));
    pass("delivery");

    /* 3. The stage reported and settled. */
    begin("report");
    const reported = await until(HEALTH_ROW_BOUND_MS.report, () => {
      const verdict = reportVerdict(ports.pipeline(pipelineId!));
      return verdict.kind === "pending" ? null : verdict;
    });
    if (!reported || reported.kind === "failed") {
      const detail = reported?.kind === "failed" ? reported.detail : "the stage did not settle within 120 seconds";
      const cwd = ports.pipeline(pipelineId)?.worktreeDir ?? repo.repoDir;
      fail("report", reportFailure(detail, ports.viewerMcpRegistered(runtime.engine, cwd), stageAgent()?.agentPath ?? null));
    }
    pass("report");

    /* 4. The test orchestrator is woken for the lane it launched. It must be
       between turns first, or the check rightly skips it as busy. */
    begin("wake");
    const wakeDeadline = ports.now() + HEALTH_ROW_BOUND_MS.wake;
    let verdict: ReturnType<typeof wakeVerdict> = { kind: "pending", inFlight: false };
    let turnBefore = "";
    while (verdict.kind === "pending" && !verdict.inFlight && ports.now() < wakeDeadline) {
      if (ports.seatBusy(seat!.conversationId)) { await wait(POLL_MS); continue; }
      turnBefore = ports.seatTurnMark(seat!.conversationId);
      const { record, outcome } = await ports.runTick(seat!, stateDir);
      verdict = wakeVerdict(record, outcome);
      if (verdict.kind === "pending" && !verdict.inFlight) await wait(POLL_MS);
    }
    if (verdict.kind === "pending" && verdict.inFlight) {
      /* Taken and not yet delivered: the seat's own turn moving is the proof. */
      const moved = await until(Math.max(0, wakeDeadline - ports.now()), () => ports.seatTurnMark(seat!.conversationId) !== turnBefore ? true : null);
      verdict = moved ? { kind: "passed" } : { kind: "failed", failure: failure("WAKE_UNDELIVERED", "the wake was queued and the test orchestrator's turn did not move within 60 seconds") };
    }
    if (verdict.kind === "pending") fail("wake", failure("WAKE_NOT_OWED", "the test orchestrator stayed busy for the whole row, so every check skipped it"));
    if (verdict.kind === "failed") fail("wake", verdict.failure);
    pass("wake");

    /* 5. The user's own seats, read only. */
    begin("filing");
    const filed = filingVerdict(ports.seatFilings());
    if (filed.kind === "failed") fail("filing", filed.failure);
    if (filed.kind === "skipped") {
      const entry = row("filing");
      entry.state = "skipped";
      entry.note = "no-seat";
      entry.finishedAt = iso(ports.now());
    } else pass("filing");
    run.state = "passed";
  } catch (error) {
    if (error instanceof RowFailed) run.state = "failed";
    else if (error instanceof RunStopped) {
      run.state = "stopped";
      for (const entry of run.rows) if (entry.state === "running") { entry.state = "waiting"; entry.startedAt = null; }
    } else {
      run.state = "failed";
      const open = run.rows.find((entry) => entry.state === "running") ?? run.rows[0]!;
      open.state = "failed";
      open.finishedAt = iso(ports.now());
      const code: HealthFailureCode = open.id === "spawn" ? "SPAWN_TIMEOUT" : open.id === "delivery" ? "DELIVERY_FAILED" : open.id === "report" ? "REPORT_TIMEOUT" : open.id === "wake" ? "WAKE_UNDELIVERED" : "SEAT_MISFILED";
      open.failure = failure(code, ports.redact(error instanceof Error ? error.message : String(error)));
    }
  } finally {
    try {
      run.cleanup.problems = (await ports.cleanup({ pipelineId, seatConversationId, stateDir, repoDir })).map((problem) => ports.redact(problem));
    } catch (error) {
      run.cleanup.problems = [ports.redact(error instanceof Error ? error.message : String(error))];
    }
    run.cleanup.done = true;
    run.finishedAt = iso(ports.now());
    try {
      ports.recordResult(run);
    } catch {
      /* The marker is a hint for the menu; the run's answer stands without it. */
    }
  }
}

class RowFailed extends Error {}

/* ── Production ports ─────────────────────────────────────────────────── */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Agent Log Viewer", "-c", "user.email=health-check@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The scratch repository: `state/onboarding/viewer-health-check`, its own
    project, with a committed README and no origin. */
export function prepareHealthRepo(repoDir: string): { repoDir: string; baseRef: string } {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "--initial-branch=main", ".");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Viewer health check\n\nA scratch repository the setup guide's health check runs one tiny pipeline in.\n", "utf8");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Viewer health check: scratch repository");
  }
  return { repoDir, baseRef: git(repoDir, "rev-parse", "HEAD") };
}

export async function productionHealthCheckPorts(): Promise<HealthCheckPorts> {
  const [
    { engineReadiness },
    { agentRegistry },
    { statePath },
    { createPipelineFromRequest, patchPipeline, getPipeline },
    { requestPipelineTick },
    { runSeatTickCheck },
    { defaultSeatTickSources },
    { readSeatTickState, writeSeatTickState },
    { deliverConversationMessage },
    { viewerMcpRegistered },
    { projectForCwd },
    { activeOrchestratorSeatsOrUnknown },
    { projectSuccessionFor },
    { redactMonitorText },
    { writeLastHealth },
  ] = await Promise.all([
    import("@/lib/accounts/engineConnection"),
    import("@/lib/agent/registry"),
    import("@/lib/configDir"),
    import("@/lib/pipelines/engine"),
    import("@/lib/pipelines/controllerSignal"),
    import("@/lib/monitor/seatTickController"),
    import("@/lib/monitor/seatTickSources"),
    import("@/lib/monitor/seatTickState"),
    import("@/lib/delivery"),
    import("@/lib/agent/spawnPolicy"),
    import("@/lib/scanner/describe"),
    import("@/lib/orchestrator/seats"),
    import("@/lib/projects/succession"),
    import("@/lib/monitor/redact"),
    import("./marker"),
  ]);
  const conversation = (id: string) => agentRegistry().conversation(id as `conversation_${string}`);
  const conversationCwd = (id: string): string | null => conversation(id)?.generations.at(-1)?.launchProfile?.cwd?.trim() || null;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: () => crypto.randomUUID().slice(0, 8),
    readiness: (engine) => engineReadiness(engine, null),
    prepareRepo: () => prepareHealthRepo(statePath("onboarding", "viewer-health-check")),
    spawnSeat: async ({ runtime, cwd, clientAttemptId }) => {
      const response = await spawnInProcess({
        engine: runtime.engine,
        model: runtime.model,
        effort: runtime.effort,
        cwd,
        "prompt": HEALTH_SEAT_PROMPT,
        title: "Viewer health check: test orchestrator",
        clientAttemptId,
      });
      const conversationId = typeof response.body.conversationId === "string" ? response.body.conversationId : "";
      if (response.status < 300 && response.body.ok !== false && conversationId) return { conversationId };
      const details = response.body.details as { reason?: EngineReadiness } | undefined;
      return {
        error: typeof response.body.error === "string" ? response.body.error : `spawn answered HTTP ${response.status}`,
        code: typeof response.body.code === "string" ? response.body.code : null,
        reason: details?.reason ?? null,
      };
    },
    seatMaterialized: (id) => {
      const found = conversation(id);
      const file = found?.generations.at(-1)?.path?.trim();
      const cwd = conversationCwd(id);
      if (!found || !file || !cwd || !fs.existsSync(file)) return null;
      const project = found.projectOwnership?.project ?? projectForCwd(cwd);
      return project ? { conversationId: found.id, path: file, cwd, project } : null;
    },
    seatBusy: (id) => agentRegistry().seatTickConversation(id)?.turn.state === "busy",
    seatTurnMark: (id) => {
      const turn = agentRegistry().seatTickConversation(id)?.turn;
      return turn ? `${turn.state}:${turn.terminalAt ?? ""}` : "";
    },
    createPipeline: async (request) => {
      const result = await createPipelineFromRequest(request);
      if (result.pipeline && result.pipeline.state !== "draft") requestPipelineTick();
      return result;
    },
    pipeline: (id) => getPipeline(id),
    receipt: (launchId) => agentRegistry().readOnlySnapshot().receipts[launchId] ?? null,
    transcriptExists: (file) => fs.existsSync(file),
    viewerMcpRegistered: (engine, cwd) => engine === "claude" ? viewerMcpRegistered(process.env.HOME?.trim() || "", cwd) : null,
    runTick: async (seat, stateDir) => {
      /* The production check, over the scratch project alone: the test
         orchestrator is its seat, on a tick row of this run's own, and the
         send is the real one. Board cards are not written: the scratch board
         is archived when the run ends. */
      const sources = defaultSeatTickSources();
      const file = statePath("onboarding", stateDir, "seat-tick.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const now = new Date().toISOString();
      const scratchSeat = {
        project: seat.project,
        seatEpoch: 1,
        conversationId: seat.conversationId,
        path: seat.path,
        mandate: HEALTH_SEAT_PROMPT,
        promptVersion: null,
        predecessorConversationId: null,
        state: "active" as const,
        intent: { clientRequestId: `health-seat-${stateDir}`, mode: "spawn" as const, launchId: null, error: null },
        designatedAt: now,
        activatedAt: now,
      };
      let outcome: DeliveryOutcome | null = null;
      const record = await runSeatTickCheck(seat.project, {
        sources: {
          ...sources,
          seatFor: (project) => project === seat.project ? { active: scratchSeat, pending: null, history: [] } : { active: null, pending: null, history: [] },
          activeSeats: () => [seat.project],
        },
        reconcileSeat: () => null,
        readState: (project) => readSeatTickState(project, file),
        writeState: (project, row) => writeSeatTickState(project, row, file),
        appendRecord: () => {},
        ensureCard: () => true,
        deliver: async (message) => {
          outcome = await deliverConversationMessage(message);
          return outcome;
        },
      });
      return { record, outcome };
    },
    seatFilings: () => {
      const seats = activeOrchestratorSeatsOrUnknown();
      if (seats === null) return null;
      return seats.map((seat) => {
        const cwd = seat.conversationId ? conversationCwd(seat.conversationId) : null;
        const owed = projectSuccessionFor(seat.project, cwd);
        return { project: seat.project, displayName: owed?.displayName ?? (cwd ? path.basename(cwd) : seat.project), misfiledTo: owed?.target ?? null };
      });
    },
    cleanup: (input) => cleanupHealthRun(input, {
      closePipeline: async (id) => {
        const closed = await patchPipeline(id, { action: "close", acknowledgeHosts: true });
        return closed.error ?? null;
      },
      pipeline: (id) => getPipeline(id),
      conversationPath: (id) => conversation(id)?.generations.at(-1)?.path ?? null,
      statePath,
    }),
    recordResult: (run) => {
      const failed = run.rows.find((entry) => entry.state === "failed");
      writeLastHealth({ at: run.finishedAt ?? new Date().toISOString(), result: run.state, failedCode: failed?.failure?.code ?? null });
    },
    redact: (text) => redactMonitorText(text),
  };
}

/** An in-process spawn on the Viewer's own authority, the way a seat
    designation launches its orchestrator. */
async function spawnInProcess(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const [{ executeSpawnRequest }, { internalServiceHeaders }, { VIEWER_SPAWN_CAPABILITY_HEADER }, { ensureOperatorSpawnCapability }] = await Promise.all([
    import("@/lib/agent/spawnCommand"),
    import("@/lib/agent/operatorAuthority"),
    import("@/lib/agent/spawnPolicy"),
    import("@/lib/agent/operatorCapability"),
  ]);
  const request = {
    headers: new Headers({
      host: "127.0.0.1",
      ...internalServiceHeaders("orchestrator"),
      [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability(),
    }),
    json: async () => body,
  } as unknown as Parameters<typeof executeSpawnRequest>[0];
  const response = await executeSpawnRequest(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

type CleanupPorts = {
  closePipeline(id: string): Promise<string | null>;
  pipeline(id: string): Pipeline | null;
  conversationPath(id: string): string | null;
  statePath(...segments: string[]): string;
};

/**
 * Undo everything the run made, each step on its own so one that fails does
 * not keep the others from running. Answers the steps that could not be done.
 */
export async function cleanupHealthRun(
  input: { pipelineId: string | null; seatConversationId: string | null; stateDir: string; repoDir: string | null },
  ports: CleanupPorts,
): Promise<string[]> {
  const problems: string[] = [];
  const step = async (label: string, action: () => unknown | Promise<unknown>) => {
    try {
      const problem = await action();
      if (typeof problem === "string" && problem) problems.push(`${label}: ${problem}`);
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const pipeline = input.pipelineId ? ports.pipeline(input.pipelineId) : null;
  const stagePaths = (pipeline?.runs ?? []).flatMap((run) => run.attempts.map((attempt) => attempt.agentPath)).filter((file): file is string => Boolean(file));
  const seatPath = input.seatConversationId ? ports.conversationPath(input.seatConversationId) : null;
  /* Closing stops the stage host; the test orchestrator's is stopped here. */
  if (pipeline && pipeline.state !== "closed") await step("close the pipeline", () => ports.closePipeline(pipeline.id));
  if (input.seatConversationId) {
    await step("stop the test orchestrator", async () => {
      const { applyConversationAction } = await import("@/lib/conversation/actions");
      const result = await applyConversationAction({ conversationId: input.seatConversationId!, transcriptPath: seatPath ?? "", action: "kill" });
      const body = result.body as { ok?: boolean; error?: string };
      /* A host already gone is the state this step wants. */
      return result.status >= 400 && result.status !== 404 && result.status !== 409 ? body.error ?? `HTTP ${result.status}` : null;
    });
  }
  if (pipeline && input.repoDir) {
    const repoDir = input.repoDir;
    await step("remove the worktree", () => {
      if (fs.existsSync(pipeline.worktreeDir)) git(repoDir, "worktree", "remove", "--force", pipeline.worktreeDir);
      git(repoDir, "worktree", "prune");
      if (pipeline.branch && git(repoDir, "branch", "--list", pipeline.branch)) git(repoDir, "branch", "-D", pipeline.branch);
    });
  }
  const project = pipeline?.project ?? null;
  const paths = [...stagePaths, ...(seatPath ? [seatPath] : [])];
  if (project && paths.length) {
    await step("archive the conversations", async () => {
      const [{ applyBoardCommand }, { boardFor }] = await Promise.all([import("@/lib/board/command"), import("@/lib/board/store")]);
      const board = boardFor(project);
      const pending = paths.filter((file) => !board.prefs.hidden.includes(file));
      if (!pending.length) return null;
      const result = applyBoardCommand({ schemaVersion: 1, project, baseRevision: board.revision, patch: { hidden: pending } });
      return result.ok ? null : "the board refused the archive";
    });
  }
  if (project) {
    await step("hide the task cards", async () => {
      const [{ mutateTasks }, { patchTask }, { taskRevision }] = await Promise.all([
        import("@/lib/tasks/store"),
        import("@/lib/tasks/commands"),
        import("@/lib/tasks/revision"),
      ]);
      mutateTasks((tasks) => {
        let next = tasks;
        for (const task of tasks.filter((candidate) => candidate.project === project && !candidate.groupHidden)) {
          const outcome = patchTask(next, task.id, { status: "done", hide: true, expectedProject: task.project, expectedRevision: taskRevision(task) }, undefined, { actor: "operator", seatHolding: () => "free" });
          if (outcome.ok) next = outcome.tasks;
        }
        return { tasks: next === tasks ? undefined : next, result: null };
      });
    });
  }
  await step("remove the run's tick row", () => fs.rmSync(ports.statePath("onboarding", input.stateDir), { recursive: true, force: true }));
  return problems;
}
