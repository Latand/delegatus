import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-controller-"));
const RESTORE = { LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
process.env.OPENCLAW_STATE_DIR = path.join(SANDBOX, "openclaw");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
/* A scanner root of this sandbox's own, and the one directory a fixture child's
   transcript may live in (#1783). A spawned child whose transcript the Viewer
   cannot resolve is never offered as harvestable work, so a fixture that writes
   its children nowhere the scanner looks stops exercising the harvest at all.
   `OPENCLAW_STATE_DIR` is resolved per call, which is what lets a test process
   own a root; `os.homedir()` does not read `HOME`, so the other roots stay the
   operator's whatever this file sets. */
const SESSIONS = path.join(SANDBOX, "openclaw", "agents", "fixtures", "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });

const { SEAT_TICK_NO_SELF_SCHEDULE } = await import("./report");
const { reconcileSeatTick, runSeatTickCheck, SEAT_TICK_WAKE_UNRESOLVED_REF, startSeatTick, stopSeatTick, wakeReached } = await import("./seatTickController");
const { writeDrain, drainFile, releaseDrain } = await import("@/lib/selfUpdate/drain");
const { DEFAULT_SEAT_TICK_POLICY } = await import("./seatTick");
const { seatMcpHealth } = await import("./seatMcpHealth");
const { viewerMcpTransportForLaunch } = await import("@/lib/agent/spawnPolicy");
const { defaultSeatTickSettings } = await import("./seatTickSettings");
const { openPullRequestsForRepo } = await import("./githubEvidence");
const { confirmedClaudeWakeDelivery, journalReceipt, settleRecordFromJournal, wakeStateFromRecord } = await import("./seatTickSources");
const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
const { resolveOriginalSend, resolveSendReceipt, SEND_UNRECORDED_REASON, SEND_UNVERIFIED_REASON, SEND_DISCARDED_REASON } = await import("@/lib/runtime/sendSettlement");
const { DELIVERY_FENCED_BY_SETTLEMENT, StructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryQueue");
const { createFakeDeliveryLedger, FakeEngineHost } = await import("@/lib/runtime/fixtures/fakeEngineHost");
const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
const { RUNTIME_IDEMPOTENCY_KEY_LIMIT } = await import("@/lib/runtime/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { deliverConversationMessage } = await import("@/lib/delivery");
const { readSeatTickState, writeSeatTickState } = await import("./seatTickState");
const { appendSeatTickRecord, readSeatTickRecords } = await import("./journalStore");
const { SeatTickAccounting, outcomeIdentity } = await import("./seatTickAccounting");
const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
const { statePath } = await import("@/lib/configDir");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { sessionKeyFromTranscript } = await import("@/lib/agent/sessionKey");
const { projectForCwd } = await import("@/lib/scanner/describe");
const { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SHIPPED_CLOCK_OPENING, ORCHESTRATOR_SEAT_TICK_CONTRACT, ORCHESTRATOR_SYSTEM_PROMPT, ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE } = await import("@/lib/orchestrator/prompt");
import type { AgentHostStatus, DurableMembershipInput } from "@/lib/agent/registry";
import type { SeatTickSettings } from "./seatTickSettings";
import type { SeatTickControllerDependencies } from "./seatTickController";
import type { GithubRunner, OpenPullRequest, OpenPullRequestsUnavailable } from "./githubEvidence";
import type { SeatTickWakeState, SeatTickWithdrawal } from "./seatTickSources";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { mcpLauncherImports } from "@/runtime-host/mcpRuntimeRelease";
import type { RuntimeReceiptStatus } from "@/lib/runtime/contracts";
import type { HostState } from "@/lib/runtime/engineHost";
import {
  emptySeatTickState,
  type SeatTickCard,
  type SeatTickOutstandingWake,
  type SeatTickProjectState,
  type SeatTickRunRecord,
} from "./types";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { LifecycleEvent } from "@/lib/lifecycle/journal";
import type { ConversationMessage, DeliveryOutcome } from "@/lib/delivery";

const PROJECT = "viewer";
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const SUCCESSOR = ["conversation", "5b7729fbc9e0f4c2"].join("_");
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const MINUTE = 60_000;
const WALL_DATE = Date;

afterEach(() => {
  globalThis.Date = WALL_DATE;
  stopSeatTick();
  setAgentRegistryForTests(null);
});
afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Harness {
  deps: SeatTickControllerDependencies;
  sent: ConversationMessage[];
  journal: SeatTickRunRecord[];
  cards: { project: string; card: SeatTickCard }[];
  written: SeatTickProjectState[];
  withdrawn: { wake: SeatTickOutstandingWake; reason: string }[];
  seat: { conversationId: string; seatEpoch: number; path: string | null; designatedAt?: string | null; mandate?: string; promptVersion?: number | null } | null;
  /** Every liveness read the check made, in order (#1465). */
  liveness: { project?: string; conversationId?: string }[];
  /** Registry snapshot reads the check made (#1465). */
  snapshots: number;
}

type PipelineFixture = { id: string; state: string; createdAt: string; movedAt: string | null; branch?: string; closedAt?: string | null; project?: string;
  deliveryBranch?: string;
  deliveryPr?: number;
  /** The conversation that created the lane (#1749), as the store records it.
      Null is a lane nobody's seat launched. */
  src?: string | null;
  /** The newest attempt's state, when the case is a stage that stopped rather
      than a lane that completed. */
  attemptState?: string;
  /** What the lane parked on, for the cases that read it (#1799). */
  stateDetail?: string | null;
  attemptConversationId?: string };

function pipelineRecord(entry: PipelineFixture) {
  return {
    id: entry.id,
    task: `lane ${entry.id}`,
    taskIds: [],
    project: entry.project ?? PROJECT,
    repoDir: "/srv/repo",
    worktreeDir: "/srv/worktree",
    branch: entry.branch ?? "topic",
    ...(entry.deliveryBranch ? { delivery: { target: { repository: PROJECT, remote: "origin", branch: `refs/heads/${entry.deliveryBranch}`, ...(entry.deliveryPr ? { pr: entry.deliveryPr } : {}) } } } : {}),
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [],
    runs: entry.movedAt ? [{ stageId: "build", attempts: [{ n: 1, state: entry.attemptState ?? "passed", startedAt: entry.movedAt, completedAt: entry.movedAt, ...(entry.attemptConversationId ? { conversationId: entry.attemptConversationId } : {}) }] }] : [],
    cursor: entry.attemptConversationId ? { stageId: "build", state: entry.attemptState ?? "running" } : null,
    state: entry.state,
    pausedState: null,
    stateDetail: entry.stateDetail ?? null,
    srcPath: null,
    srcConversationId: entry.src ?? null,
    createdAt: entry.createdAt,
    closedAt: entry.closedAt ?? null,
  };
}

function harness(options: {
  seat?: { conversationId: string; seatEpoch: number; path: string | null; designatedAt?: string | null; mandate?: string; promptVersion?: number | null } | null;
  /** Whether an orchestrator ever held the project (#2170); absent, the
      source is not wired, as in a harness written before it existed. */
  seatEverHeld?: boolean;
  turn?: "busy" | "idle";
  seatActivity?: Partial<AgentLivenessRecord> | null;
  pipelines?: PipelineFixture[];
  tasks?: { id: string; status: "inbox" | "assigned" | "blocked" | "done" }[];
  events?: LifecycleEvent[];
  state?: Partial<SeatTickProjectState>;
  delivery?: DeliveryOutcome;
  deliveryThrows?: boolean;
  /** What the layer holding a retained wake says has become of it. */
  wakeState?: SeatTickWakeState;
  /** What taking that wake back out of the holder's queue achieves. */
  withdrawal?: SeatTickWithdrawal;
  /** The holder cannot be reached at all, for either question. */
  holderThrows?: boolean;
  /** The project's own tick settings (#1275); the default is the tick as it
      shipped. */
  settings?: SeatTickSettings;
  /** What `gh` reports open in the project's repository (#1289). */
  openPullRequests?: OpenPullRequest[];
  /** The `gh` read failing rather than answering (#1289). Distinct from an
      empty answer on purpose: that is what the check may go quiet on. */
  pullRequestsUnavailable?: OpenPullRequestsUnavailable;
  /** The `gh` seam itself, one level below the option above, so a command that
      throws, a child killed at its timeout and output nobody can attribute
      reach the check the way they reach it in production — through the real
      parse — rather than as a verdict the test picked for it. */
  githubRun?: GithubRunner;
  archivedPipelines?: PipelineFixture[];
  /** The board write failing rather than landing: `throws` is the state dir
      gone or the file locked, `refused` is the create the board declined. Both
      leave the condition uncarded, which is what the tick may not remember as
      having been reported (#1298). */
  cardWrite?: "throws" | "refused";
  /** A real, isolated registry holding the seat's spawned children (#1465).
      Absent, the stub registry below answers with an empty snapshot. */
  registry?: InstanceType<typeof AgentRegistry>;
  /** The liveness plane's verdict for a child conversation, by id (#1465). */
  childActivity?: Record<string, Partial<AgentLivenessRecord>>;
  /** A durable row store of this test's own, in place of the in-memory one,
      so a fresh controller can read what an earlier check wrote (#1465). */
  stateFile?: string;
  /** The check's clock, when a test advances it across ticks (#1465). */
  now?: number;
  /** The transport, one level below `delivery`: a layer that reserves, then
      answers or throws, the way the production one does (#1465). */
  deliverWith?: (message: ConversationMessage) => Promise<DeliveryOutcome>;
  /** Ask the production `wakeState` — the durable delivery record under the
      wake's own key — instead of the stub (#1465). Needs `registry`. */
  realWakeState?: boolean;
  /** The runtime host's delivery journal — faked in memory, or the real one
      behind a client — beside the real record and the real settlement: with
      it, `realWakeState` asks exactly what production asks, in the order
      production asks it. */
  journal?: { client: RuntimeHostClient };
  /** The settlement's clock, when it must differ from the check's: the record
      stamps a reservation with the wall clock, so a check whose own clock has
      been advanced past a fresh reservation would end it on sight. */
  settlementNow?: () => number;
  /** Deployments `deploy_exact_sha` attributed to a seat (#2063). */
  seatDeployments?: { deploymentId: string; conversationId: string }[];
  /** The deployment ledger, by id (#2063): phase and whether it is terminal. */
  deployments?: Record<string, { phase: string; terminal: boolean; revision: string; error?: string | null }>;
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const withdrawn: { wake: SeatTickOutstandingWake; reason: string }[] = [];
  const livenessReads: { project?: string; conversationId?: string }[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, withdrawn, liveness: livenessReads, snapshots: 0, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
  const localStateFile = options.stateFile ?? path.join(fs.mkdtempSync(path.join(SANDBOX, "controller-state-")), "seat-tick.json");
  if (!options.stateFile) writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: result.seat?.seatEpoch ?? null, ...options.state, accounting: undefined }, localStateFile);

  const pipelines = (options.pipelines ?? []).map(pipelineRecord);
  /* Lanes the hot store has already let go of: a settled record leaves after
     three days and the pull request it left open does not (#1289). */
  const archived = (options.archivedPipelines ?? []).map(pipelineRecord);

  const tasks = (options.tasks ?? []).map((entry) => ({
    id: entry.id,
    project: PROJECT,
    status: entry.status,
    text: `card ${entry.id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  }));

  result.deps = {
    policy: DEFAULT_SEAT_TICK_POLICY,
    readState: (project) => {
      if (!options.stateFile && project !== PROJECT && !readSeatTickState(project, localStateFile).lastCheckAt) {
        writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: result.seat?.seatEpoch ?? null, ...options.state, accounting: undefined }, localStateFile);
      }
      return readSeatTickState(project, localStateFile);
    },
    writeState: (project, row) => {
      written.push(row);
      writeSeatTickState(project, row, localStateFile);
    },
    appendRecord: (record) => { journal.push(record); },
    ensureCard: (project, card) => {
      cards.push({ project, card });
      if (options.cardWrite === "throws") throw new Error("the board file cannot be written");
      return options.cardWrite !== "refused";
    },
    deliver: async (message) => {
      sent.push(message);
      if (options.deliverWith) return options.deliverWith(message);
      if (options.deliveryThrows) throw new Error("the delivery layer is unavailable");
      return options.delivery ?? { ok: true, target: "structured", outcome: "delivered", structured: true };
    },
    proposalIssues: async () => [{ number: 1245, title: "the native seat tick", labels: ["design"], updatedAt: null }],
    sources: {
      seatFor: () => ({ active: result.seat as never, pending: null, history: [] }),
      ...(options.seatEverHeld === undefined ? {} : { seatEverHeld: () => options.seatEverHeld! }),
      activeSeats: () => [PROJECT],
      pipelines: () => pipelines as never,
      archivedPipelines: () => archived as never,
      tasks: () => tasks as never,
      registry: () => {
        if (options.registry) {
          const registry = options.registry;
          return {
            pageSeatChildren: registry.pageSeatChildren.bind(registry),
            seatTickConversation: registry.seatTickConversation.bind(registry),
            seatMcpReceipt: registry.seatMcpReceipt.bind(registry),
            conversationDeliverySnapshot: registry.conversationDeliverySnapshot.bind(registry),
            conversation: (id: string) => registry.conversation(id as never),
            conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
            readOnlySnapshot: () => { result.snapshots += 1; return registry.readOnlySnapshot(); },
          } as never;
        }
        return {
          pageSeatChildren: () => ({ file: EMPTY_SNAPSHOT, keys: [], after: null, complete: true, evidenceGap: false }),
          seatTickConversation: () => ({ id: CONVERSATION, turn: { state: options.turn ?? "idle" } }),
          conversation: () => ({ turn: { state: options.turn ?? "idle" } }),
          conversationForPath: () => null,
          readOnlySnapshot: () => { result.snapshots += 1; return EMPTY_SNAPSHOT; },
        } as never;
      },
      liveness: async (request) => {
        livenessReads.push({ ...(request.project ? { project: request.project } : {}), ...(request.conversationId ? { conversationId: request.conversationId } : {}) });
        const child = request.conversationId ? options.childActivity?.[request.conversationId] : undefined;
        if (child) return [{ conversationId: request.conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy", ...child } as AgentLivenessRecord];
        return request.conversationId && options.seatActivity
          ? [{ lifecycle: "running", reason: "host_alive_turn_active", ...options.seatActivity } as AgentLivenessRecord]
          : [];
      },
      lifecycleJournal: () => ({ version: 1, lastSeq: options.events?.at(-1)?.seq ?? 0, events: options.events ?? [], retired: [] }),
      latestDeployment: () => ({ state: "unreadable", error: "no ledger" }) as never,
      seatDeployments: (conversationId) => (options.seatDeployments ?? [])
        .filter((row) => row.conversationId === conversationId)
        .map((row) => ({ ...row, project: PROJECT, revision: options.deployments?.[row.deploymentId]?.revision ?? "", requestedAt: new Date(NOW - 10 * MINUTE).toISOString() })),
      deployment: (deploymentId) => {
        const row = options.deployments?.[deploymentId];
        return { state: "ok", value: row ? { deploymentId, error: null, updatedAt: new Date(NOW - 2 * MINUTE).toISOString(), ...row } : undefined } as never;
      },
      retirementReport: () => null,
      settings: () => options.settings ?? defaultSeatTickSettings(PROJECT),
      openPullRequests: async (request) => {
        if (options.githubRun) return openPullRequestsForRepo({ ...request, run: options.githubRun });
        return options.pullRequestsUnavailable
          ? { ok: false, unavailable: options.pullRequestsUnavailable }
          : { ok: true, pullRequests: options.openPullRequests ?? [] };
      },
      wakeState: async (wake) => {
        if (options.realWakeState && options.journal) {
          const client = options.journal.client;
          const now = options.settlementNow ?? (() => options.now ?? NOW);
          return wakeStateFromRecord(wake, {
            lookup: (binding) => resolveOriginalSend(binding, { registry: options.registry, client }),
            settle: (operationId) => resolveSendReceipt(operationId, { registry: options.registry, client, now }),
            journal: (operationId) => journalReceipt(operationId, client),
            confirmed: confirmedClaudeWakeDelivery,
            settleFromJournal: (target, receipt) => settleRecordFromJournal(options.registry!, target, receipt),
          });
        }
        if (options.realWakeState) {
          let evidence: Awaited<ReturnType<typeof resolveOriginalSend>> | null = null;
          return wakeStateFromRecord(wake, {
            lookup: async (binding) => (evidence = await resolveOriginalSend(binding, { registry: options.registry, client: null })),
            settle: async () => evidence?.kind === "found" && evidence.current.readable ? evidence.current.value : null,
            /* No runtime host to reach: the journal cannot be asked. */
            journal: async () => { throw new Error("runtime host socket is unavailable"); },
          });
        }
        if (options.holderThrows) throw new Error("the layer holding the wake cannot be read");
        return options.wakeState ?? "retained";
      },
      withdrawWake: async (wake, reason) => {
        if (options.holderThrows) throw new Error("the layer holding the wake cannot be read");
        withdrawn.push({ wake, reason });
        return options.withdrawal ?? "withdrawn";
      },
      now: () => options.now ?? NOW,
    },
  };
  return result;
}

/** What a registry with nothing in it answers a snapshot read with. */
const EMPTY_SNAPSHOT = { entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {}, heldDeliveries: {}, deliveryOperationOwners: {} };

/**
 * The runtime host's delivery journal, in memory: what `operation-status`
 * answers for each operation, and every transition written to it. Unreachable
 * answers the way the socket does when a request times out.
 */
interface FakeJournal {
  client: RuntimeHostClient;
  operations: Map<string, { status: RuntimeReceiptStatus; reason: string | null }>;
  transitions: { operationId: string; status: string; reason: string | null }[];
  unreachable: boolean;
}

function fakeJournal(): FakeJournal {
  const journal: FakeJournal = { operations: new Map(), transitions: [], unreachable: false, client: null as never };
  const receipt = (operationId: string) => {
    const held = journal.operations.get(operationId)!;
    return { operationId, receipt: { operationId, idempotencyKey: "", conversationId: "", kind: "send", status: held.status, reason: held.reason }, replayed: false };
  };
  journal.client = {
    operationStatus: async (operationId: string) => {
      if (journal.unreachable) throw new Error("runtime host request timed out");
      return journal.operations.has(operationId) ? receipt(operationId) : null;
    },
    transitionOperation: async (operationId: string, status: RuntimeReceiptStatus, details?: { reason?: string | null }) => {
      if (journal.unreachable) throw new Error("runtime host request timed out");
      if (!journal.operations.has(operationId)) throw new Error("operation not found");
      journal.operations.set(operationId, { status, reason: details?.reason ?? null });
      journal.transitions.push({ operationId, status, reason: details?.reason ?? null });
      return receipt(operationId);
    },
  } as unknown as RuntimeHostClient;
  return journal;
}

/** The real runtime journal behind the same client shape production uses. */
function journalClient(journal: InstanceType<typeof RuntimeJournal>): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    waitEvents: async (after: number) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) =>
      (options?.currentRetryLeaf ? journal.currentRetryResult(operationId) : journal.operationResult(operationId)),
    readSession: async (identity) => journal.readSession(identity),
    claimDeliveryAction: async (operationId, action) => journal.claimDeliveryAction(operationId, action),
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
    retryOperation: async (operationId, nextIdempotencyKey) => journal.retryOperation(operationId, nextIdempotencyKey),
  } as RuntimeHostClient;
}

const OVERDUE = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
const RECENT = { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() };

/** A wake the layer accepted and kept, as the row remembers it: which layer is
    holding it, and what its landing would stamp. */
function outstandingWake(over: Partial<SeatTickOutstandingWake> = {}): SeatTickOutstandingWake {
  return {
    clientMessageId: "seat-tick:viewer:7:first:interval:fp-1",
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["interval"], fingerprint: "fp-1", eventsThrough: 44, children: [] },
    ...over,
  };
}
const OPEN_LANE = [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T11:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }];

function terminalEvent(seq: number): LifecycleEvent {
  return {
    id: `event-${seq}`,
    seq,
    at: new Date(NOW - MINUTE).toISOString(),
    type: "review_verdict",
    state: "completed",
    project: PROJECT,
    pipelineId: "pipeline_a1",
    stageId: "review",
    attempt: 1,
    conversationId: null,
    role: "reviewer",
    summary: "the round passed",
  };
}

/* ------------------------------------------------------------------------- *
 * The tick settings a project decides for itself (#1275).
 * ------------------------------------------------------------------------- */

function offSettings(over: Partial<SeatTickSettings> = {}): SeatTickSettings {
  return {
    ...defaultSeatTickSettings(PROJECT),
    enabled: false,
    reason: "the only open lane is a draft nothing can discharge",
    updatedAt: "2026-08-28T11:00:00.000Z",
    setBy: { kind: "manager", conversationId: CONVERSATION, project: PROJECT, seatEpoch: 7 },
    ...over,
  };
}

/* ------------------------------------------------------------------------- *
 * #1285 / #1289, end to end: a wake names what is owed now, and silence means
 * nothing is.
 * ------------------------------------------------------------------------- */

/** A lane that ran and finished, with the branch its pull request is the head
    of. Whether it is still open is the whole question both halves turn on. */
const FINISHED_LANE = [{
  id: "pipeline_z9",
  state: "completed",
  createdAt: "2026-08-27T09:00:00.000Z",
  movedAt: "2026-08-27T22:00:00.000Z",
  branch: "topic-merge-queue",
  closedAt: "2026-08-27T22:00:00.000Z",
}];
const FINISHED_PR_CREATED = "2026-08-27T10:00:00.000Z";

/* The same lane five days on: out of the hot store, into the archive, and the
   pull request it left open is still the seat's next obligation. Every route
   into this case is a tick that was not able to say so earlier — ticking off,
   a seat busy for days, a `gh` nobody could reach — so the first check that
   CAN must not be the one that reports quiet. */
const ARCHIVED_LANE = [{
  id: "pipeline_z9",
  state: "completed",
  createdAt: "2026-08-22T09:00:00.000Z",
  movedAt: "2026-08-22T22:00:00.000Z",
  branch: "topic-merge-queue",
  closedAt: "2026-08-22T22:00:00.000Z",
}];

/** The same standing outage every test below reports on: unreadable for four
    hours, and never yet put in front of anybody. */
function standingGap(over: Partial<SeatTickProjectState["pullRequestGap"] & object> = {}) {
  return {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * MINUTE).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString(),
    attempts: 23,
    reported: false,
    ...over,
  };
}


/* ------------------------------------------------------------------------- *
 * The agent-authored monitor prompt on the wake the scheduler fires (#1280).
 *
 * The seat cannot schedule itself — that is settled, and stays settled. What
 * it can do is say what the schedule the Viewer arms for it should look at,
 * and these cases are about that instruction surviving the two boundaries a
 * session-scheduled prompt never survived: the next check, and a rotation.
 * ------------------------------------------------------------------------- */

const MONITOR_PROMPT = "before the items, check whether last night's digest actually sent";
const PROMPT_HEADING = "Standing monitor note for this project";

function seatTickNoteRevisionForTest(note: string): string {
  return createHash("sha256").update(note).digest("hex").slice(0, 32);
}

function promptSettings(): SeatTickSettings {
  return {
    ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: MONITOR_PROMPT,
    updatedAt: "2026-08-28T11:00:00.000Z",
    setBy: { kind: "manager", conversationId: CONVERSATION, project: PROJECT, seatEpoch: 7 },
  };
}

/* ------------------------------------------------------------------------- *
 * The note a seat already holds is not echoed back (#2030).
 *
 * One seat's 110 wakes carried its own 1.24 KB note every time, 33 of them
 * identical to the wake before. These checks run the production controller
 * against one durable row, so "already shown" is decided the way production
 * decides it: by what the last LANDED wake recorded, for this seat epoch.
 * ------------------------------------------------------------------------- */

/** A lane ledger the size an orchestrator seat actually keeps there (2.26 KB
    measured), one line per lane. */
const LEDGER_NOTE = Array.from({ length: 24 }, (_, lane) =>
  `lane ${lane + 1}: pipeline_${String(lane).padStart(4, "0")}ab — review round 2 of 4, PR open, waiting on CI; next: merge on green.`,
).join("\n");

/** Five open lanes whose last move lands between the two checks, so the second
    wake is owed for the same reason the first was and shows the same board. */
function busyBoard(movedAt: number): PipelineFixture[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `pipeline_${String(index).padStart(4, "0")}ab`,
    state: "running",
    createdAt: "2026-08-28T09:00:00.000Z",
    movedAt: new Date(movedAt - index * MINUTE).toISOString(),
    branch: `pipeline/lane-${index}`,
  }));
}

/** A seat delivered the current default, whose mandate states the contract. */
const CURRENT_SEAT = { conversationId: CONVERSATION, seatEpoch: 7, path: null, mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: ORCHESTRATOR_PROMPT_VERSION };

/* ------------------------------------------------------------------------- *
 * Replacing and clearing the prompt while a wake is outstanding (#1280).
 *
 * The delivery layer's idempotency key is what says which two sends are the
 * same message, and it refuses a CHANGED payload under a key it is already
 * holding. The prompt reached the delivered text while the key ignored it, so a
 * wake carrying one prompt that the layer held, followed by the record being
 * changed to another, produced the same key with different text at the very
 * next check — refused, and refused again, until the outstanding wake settled
 * on its own. Replacing and withdrawing a standing instruction is the ordinary
 * use of the field, so these cases are the ordinary path.
 * ------------------------------------------------------------------------- */

const REPLACEMENT_PROMPT = "the digest is fine now; watch the deploy ledger for a rollback that nobody chased";

/** The one rule of the delivery layer these cases turn on: a key it is already
    holding may be replayed with the SAME text, and is refused different text.
    One instance spans both checks, the way the layer's reservation does. */
function reservationLayer(outcome: DeliveryOutcome) {
  const held = new Map<string, string>();
  const accepted: ConversationMessage[] = [];
  const refused: string[] = [];
  return {
    accepted,
    refused,
    deliver: async (message: ConversationMessage): Promise<DeliveryOutcome> => {
      const key = message.clientMessageId ?? "";
      const existing = held.get(key);
      if (existing !== undefined && existing !== message.text) {
        refused.push(key);
        return { ok: false, outcome: "failed", error: "a different payload under a client message id already held", status: 409 };
      }
      held.set(key, message.text);
      accepted.push(message);
      return outcome;
    },
  };
}

const HELD: DeliveryOutcome = { ok: true, target: null, outcome: "held" };

/** A first check whose wake the layer accepts and keeps, so the second check
    runs against a wake that is genuinely still outstanding. */
async function heldWake(layer: ReturnType<typeof reservationLayer>, settings: SeatTickSettings) {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, deliver: layer.deliver });
  expect(record!.delivery!.outcome).toBe("held");
  return record!.delivery!.clientMessageId;
}

/** The next check, with the wake the first one left outstanding on the row. */
async function nextCheck(layer: ReturnType<typeof reservationLayer>, outstanding: string, settings: SeatTickSettings) {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake({ clientMessageId: outstanding }) },
    settings,
  });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, deliver: layer.deliver });
  return record!;
}

/* ------------------------------------------------------------------------- *
 * Standalone spawned children (#1465).
 *
 * A manager that works through plain `spawn_agent` children has no pipeline
 * lane the tick can see, so before this the interval wake could never fire and
 * a finished worker was never announced. Every case below runs the real
 * controller over a real, isolated registry holding real lineage edges,
 * receipts, turn observations and host entries — the same durable facts the
 * production check reads — with only the dispatch transport substituted.
 * ------------------------------------------------------------------------- */

interface ChildFixture {
  dir: string;
  cwd: string;
  project: string;
  /** The check's clock: three minutes past the fixture's own writes, so a
      `starting` receipt the spawn path never advanced has outlived its
      admission lease and is no evidence of a host. */
  now: number;
  /** The row the seat starts from, already on disk. */
  seed(over?: Partial<SeatTickProjectState>): void;
  row(): SeatTickProjectState;
  acknowledged(): string[];
  registry: InstanceType<typeof AgentRegistry>;
  seat: { conversationId: string; seatEpoch: number; path: string | null };
  stateFile: string;
  spawn(options: {
    title: string;
    engine?: "claude" | "copilot";
    turn?: "busy" | "idle" | "terminal" | "unknown";
    terminalAt?: string | null;
    host?: AgentHostStatus | null;
    cwd?: string;
    parent?: string | null;
    memberships?: DurableMembershipInput[];
    /** No conversation record at all: a reservation nothing has settled. */
    unobserved?: boolean;
    /** The conversation exists, but no scanner turn observation reached it. */
    unreconciled?: boolean;
    /** The launch finished and its host later died. */
    completedReceipt?: boolean;
    /** Where this child's transcript is, as the Viewer would find it (#1783).
        `rooted` is a real spawn's; `outside-roots` is a file the scanner never
        looks at; `missing` is a path the transcript has gone from. The last
        two are the same fact to the seat — it can never read or harvest that
        child — and between them they are sixteen of the sixty-seven children
        owed on the board #1783 was filed from. */
    transcript?: "rooted" | "outside-roots" | "missing";
  }): { id: string; launchId: string; path: string };
}

/** A registry of this test's own, holding one seat and whatever children the
    test spawns under it. The project is the one the child's cwd resolves to
    through the real attribution path, so the seat's project and its children's
    agree exactly the way a real spawn's do. */
function childFixture(name: string, gitRepository = false, sqliteMode: "sqlite" | "off" = "sqlite", onRead?: (collection: string, count: number) => void): ChildFixture {
  const dir = fs.mkdtempSync(path.join(SANDBOX, `${name}-`));
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  if (gitRepository) {
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(cwd, ".git", "config"), '[remote "origin"]\n  url = https://example.invalid/fixtures/' + path.basename(dir) + '.git\n');
  }
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode, onSqliteRowPayloadRead: onRead });
  const seatPath = path.join(dir, `${crypto.randomUUID()}.jsonl`);
  const seatConversation = registry.ensureConversation("claude", seatPath, null);
  const project = projectForCwd(cwd);
  if (!project) throw new Error("fixture cwd resolves to no project");
  const now = Date.now() + 3 * MINUTE;
  const stateFile = path.join(dir, "seat-tick.json");
  const fixture: ChildFixture = {
    dir,
    cwd,
    project,
    now,
    registry,
    seat: { conversationId: seatConversation.id, seatEpoch: 7, path: seatPath },
    stateFile,
    seed(over = {}) {
      writeSeatTickState(project, {
        ...emptySeatTickState(),
        seatEpoch: 7,
        lastWakeAt: new Date(now - 61 * MINUTE).toISOString(),
        /* The proposal slot is not due, so an empty board is quiet rather than
           a proposal: what these cases test is the harvest, not the slot. */
        lastProposalAt: new Date(now - MINUTE).toISOString(),
        ...over,
      }, stateFile);
    },
    row: () => readSeatTickState(project, stateFile),
    acknowledged: () => new SeatTickAccounting(`${stateFile}.sqlite`, project).collection.snapshot()
      .flatMap((row) => row.kind === "outcome" && row.status === "acknowledged" ? [row.input.conversationId] : row.kind === "legacy" && row.reconciled ? [row.conversationId] : []),
    spawn(options) {
      const childCwd = options.cwd ?? cwd;
      const engine = options.engine ?? "claude";
      /* Under a scanner root and on disk, the way a real spawn's transcript is
         (#1783): the harvest skips a child the Viewer cannot resolve. */
      const placement = options.transcript ?? "rooted";
      const root = placement === "outside-roots" ? dir : SESSIONS;
      const childPath = engine === "copilot"
        ? path.join(root, crypto.randomUUID(), "events.jsonl")
        : path.join(root, `${crypto.randomUUID()}.jsonl`);
      fs.mkdirSync(path.dirname(childPath), { recursive: true });
      if (placement !== "missing") fs.writeFileSync(childPath, engine === "copilot" ? [
        { type: "assistant.turn_start", timestamp: new Date(now - 5 * MINUTE).toISOString() },
        { type: "assistant.turn_end", timestamp: new Date(now - 5 * MINUTE).toISOString() },
        { type: "session.shutdown", timestamp: new Date(now - 5 * MINUTE).toISOString() },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n" : "");
      const observedChild = options.unobserved ? null : registry.ensureConversation(engine, childPath, null);
      const parent = options.parent === undefined ? seatConversation.id : options.parent;
      const begun = registry.beginSpawnRequest({
        engine,
        cwd: childCwd,
        transport: "structured",
        ...(observedChild ? { conversationId: observedChild.id } : {}),
        ...(parent ? { parentConversationId: parent as never, parentSource: "explicit" } : {}),
        launchProfile: { title: options.title },
        ...(options.memberships ? { memberships: options.memberships } : {}),
      });
      const child = observedChild ?? { id: begun.receipt.conversationId, generations: [] };
      if (options.completedReceipt) {
        registry.completeSpawn(begun.receipt.launchId, {
          key: sessionKeyFromTranscript(engine, childPath)!,
          artifactPath: childPath,
          cwd: childCwd,
          accountId: null,
          status: "dead",
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: null,
        });
      }
      if (!options.unobserved && !options.unreconciled) {
        registry.reconcileConversations([{
          engine,
          path: childPath,
          accountId: null,
          launchProfile: emptyLaunchProfile({ cwd: childCwd, title: options.title }),
          turn: { state: options.turn ?? "busy", source: "assistant", terminalAt: options.terminalAt ?? null },
          observedAt: new Date(now - 5 * MINUTE).toISOString(),
        }]);
      }
      if (options.host) {
        registry.upsert({
          key: sessionKeyFromTranscript(engine, childPath)!,
          artifactPath: childPath,
          cwd: childCwd,
          accountId: null,
          status: options.host,
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: null,
        });
      }
      if (!options.unobserved && !options.unreconciled && (options.turn === "terminal" || options.turn === "idle")) {
        const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
        ledger.append(child.generations[0]!.id, { kind: "turn-started", turnId: "turn-one", seq: 1 });
        ledger.append(child.generations[0]!.id, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
      }
      return { id: child.id, launchId: begun.receipt.launchId, path: childPath };
    },
  };
  return fixture;
}

function childRig(fixture: ChildFixture, over: Parameters<typeof harness>[0] = {}): Harness {
  return harness({ seat: fixture.seat, registry: fixture.registry, stateFile: fixture.stateFile, now: fixture.now, ...over });
}

/** An instant `minutes` before the fixture's clock, for terminal outcomes. */
function ago(fixture: ChildFixture, minutes: number): string {
  return new Date(fixture.now - minutes * MINUTE).toISOString();
}

/* ------------------------------------------------------------------------- *
 * The receipt boundary (#1465, on the #1490 contract). Every case here asks
 * the PRODUCTION `wakeState` — the durable delivery record under the key the
 * tick bound before the send — over the isolated registry, with no runtime
 * host to reach.
 * ------------------------------------------------------------------------- */

/** A wake the delivery record is holding for this seat under the tick's own
    key, in the state the case names, with a plan that harvests one child. */
function recordedWake(fixture: ChildFixture, options: {
  key?: string;
  state: "assigned" | "delivered" | "lost" | "unverified" | "none";
  operationId?: string | null;
  children?: string[];
}): SeatTickOutstandingWake {
  const key = options.key ?? "seat-tick:record:7:first:child-terminal:fp-1";
  const operationId = options.operationId === undefined ? "op-record-1" : options.operationId;
  if (options.state !== "none") {
    const reservation = fixture.registry.holdDelivery(
      fixture.seat.conversationId as never,
      "wake text",
      key,
      "text",
      [],
      null,
      operationId ? { operationId, kind: "send", policy: "queue" } : {},
    );
    if (options.state === "delivered") fixture.registry.recordDeliveryOutcome(reservation.id, "delivered", null, "delivered");
    if (options.state === "lost") fixture.registry.recordDeliveryOutcome(reservation.id, "failed", "fenced before actuation", "lost");
    if (options.state === "unverified") fixture.registry.recordDeliveryOutcome(reservation.id, "failed", "the host took it and died", "unverified");
  }
  return {
    clientMessageId: key,
    conversationId: fixture.seat.conversationId,
    seatEpoch: 7,
    operationId,
    commit: { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-1", eventsThrough: 3, children: options.children ?? [] },
  };
}

/** Exercise the public delivery adapter's refusal before any reservation. */
function refuseBeforeReservation(status: 409 | 503): (message: ConversationMessage) => Promise<DeliveryOutcome> {
  return (message) => deliverConversationMessage(message, {
    recover: async () => ({ path: message.path, conversationId: message.conversationId as never, spawned: false, target: null }),
    enqueueStructured: async () => status === 503 ? null : {
      ok: false, structured: true, outcome: "failed", error: "conversation cannot be resumed", status,
    },
  });
}

/* ---------------------------------------------------------------------------
 * A wake stranded by a seat that has been replaced (#1594).
 *
 * The production shape, exactly: an attempt prepared for epoch 140, refused by
 * the route before it reserved anything, holding no operation, answered
 * `uncertain` by the record under its key — and a project whose seat is now
 * epoch 155 on another conversation. `uncertain` is terminal in the sense that
 * matters here: nothing will ever look at that send again, so the answer cannot
 * improve, and before this the attempt withheld every later wake for as long as
 * the row lived. Thirty-four hours of a silent tick, on a tick that was
 * enabled, checking every five minutes and deciding `wake` every time.
 * ------------------------------------------------------------------------- */

/** A second conversation in the fixture's registry, idle and seatable: a
    rotation moves the seat to a DIFFERENT conversation, which is what makes an
    epoch superseded rather than re-designated. */
function successorSeat(fixture: ChildFixture, seatEpoch: number): { conversationId: string; seatEpoch: number; path: string } {
  const seatPath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  const conversation = fixture.registry.ensureConversation("claude", seatPath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: seatPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "successor seat" }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: new Date(fixture.now - 5 * MINUTE).toISOString(),
  }]);
  return { conversationId: conversation.id, seatEpoch, path: seatPath };
}

/** The stranded attempt, built the way production built it: one check whose
    transport refused before reserving, then a delivery record under the same
    key that ended the send without proving arrival. */
async function strandOneWake(fixture: ChildFixture, seatEpoch: number): Promise<SeatTickOutstandingWake> {
  fixture.seed({ seatEpoch });
  await runSeatTickCheck(fixture.project, childRig(fixture, {
    seat: { ...fixture.seat, seatEpoch },
    deliverWith: refuseBeforeReservation(409),
  }).deps);
  const stranded = fixture.row().outstandingWake!;
  const held = fixture.registry.holdDelivery(stranded.conversationId as never, stranded.text!, stranded.clientMessageId,
    "text", [], null, { operationId: "unverified-operation", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(held.id, "failed", "arrival unverified", "unverified");
  return stranded;
}

/** A retired attempt seeded straight onto the row, for the checks that follow
    the retirement rather than make it. */
function retiredEntry(over: Partial<SeatTickOutstandingWake> = {}) {
  return {
    wake: outstandingWake({ seatEpoch: 7, operationId: null, text: "the predecessor's wake",
      preparedAt: new Date(NOW - 70 * MINUTE).toISOString(), dispatch: { token: "dispatch-token", state: "refused" as const }, ...over }),
    retiredAt: new Date(NOW - 65 * MINUTE).toISOString(),
    supersededBy: { conversationId: SUCCESSOR, seatEpoch: 8 },
    reason: "seat-superseded" as const,
  };
}

/* ------------------------------------------------------------------------- *
 * The manager wake that never came back. A wake the transport reserved and
 * then lost to a runtime-host timeout was ended `unverified` by the tick's own
 * settlement deadline, and every later check deferred the project's wake
 * behind it. Every case here runs the real delivery record, the real
 * settlement and an in-memory runtime journal side by side, the way
 * production does, with a fresh controller per check — so a Viewer restart
 * between two checks changes nothing about what they conclude.
 * ------------------------------------------------------------------------- */

const TRANSPORT_TIMEOUT = "runtime host request timed out";
const SEAT_TICK_COMMAND = { kind: "send", policy: "interrupt-active", origin: { kind: "agent", role: "seat-tick" } };

/** The transport as it behaved on 2026-09-11: the record reserved the key and
    claimed its attempt, the command never came back, and the layer answered
    the tick with a bare 503 carrying no operation — which is the shape every
    structured refusal reaches the tick in. */
function reservedThenTimedOut(fixture: ChildFixture, onReserved?: (operationId: string) => void): (message: ConversationMessage) => Promise<DeliveryOutcome> {
  return async (message) => {
    const held = fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, SEAT_TICK_COMMAND as never);
    const claimed = fixture.registry.beginDeliveryAttempt(held.id, held.generationId!);
    if (!claimed) throw new Error("fixture: the delivery attempt could not be claimed");
    onReserved?.(held.command.operationId);
    return { ok: false, outcome: "failed", error: TRANSPORT_TIMEOUT, status: 503 };
  };
}

/** A send the runtime host admitted and rejected on the spot. The layer
    records the failure without a disposition — it proved nothing about the
    journal — and answers the tick a bare 409, while the journal itself holds
    the operation as `rejected`. */
function admittedAndRejected(fixture: ChildFixture, journal: FakeJournal, reason: string): (message: ConversationMessage) => Promise<DeliveryOutcome> {
  return async (message) => {
    const held = fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, SEAT_TICK_COMMAND as never);
    const claimed = fixture.registry.beginDeliveryAttempt(held.id, held.generationId!);
    if (!claimed) throw new Error("fixture: the delivery attempt could not be claimed");
    journal.operations.set(held.command.operationId, { status: "rejected", reason });
    fixture.registry.recordDeliveryOutcome(claimed.id, "failed", reason);
    return { ok: false, outcome: "failed", error: reason, status: 409 };
  };
}

interface StrandedWake {
  fixture: ChildFixture;
  journal: FakeJournal;
  child: { id: string };
  operationId: string;
  wake: SeatTickOutstandingWake;
  /** The check that ended the send and fenced the project behind it. */
  fenced: Harness;
  /** A further check of this same project, `minutes` after the send — same
      seat, same cadence, same journal, a fresh controller. */
  rig: (minutes: number, extra?: Parameters<typeof harness>[0]) => Harness;
}

/** The row and the record exactly as production holds them, reached
    causally: the send that timed out, the check inside the settlement window,
    and the check past it that ended the send unrecorded. */
async function strandedManagerWake(name: string, over: {
  /** The seat epoch the row and every rig in this fixture carry (#1672). */
  seatEpoch?: number;
  /** The project's last proven wake — the anchor the attempt's key is derived
      from, which in #1672 was eight days and eight epochs old. */
  lastWakeAt?: string;
  /** The project's own cadence, which the age bound is two of (#1746). */
  wakeIntervalMinutes?: number;
  /** A standing instruction on the project's row, whose digest is part of
      every wake's identity (#1280) and part of what took the live key past the
      bound the journal admits (#1771). */
  monitorPrompt?: string;
} = {}): Promise<StrandedWake> {
  const fixture = childFixture(name);
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const seatEpoch = over.seatEpoch ?? 7;
  fixture.seed({ seatEpoch, ...(over.lastWakeAt ? { lastWakeAt: over.lastWakeAt } : {}) });
  const seat = { ...fixture.seat, seatEpoch };
  const settings = over.wakeIntervalMinutes === undefined && over.monitorPrompt === undefined
    ? undefined
    : {
      ...defaultSeatTickSettings(fixture.project),
      ...(over.wakeIntervalMinutes === undefined ? {} : { wakeIntervalMinutes: over.wakeIntervalMinutes, reason: "this project batches its wakes" }),
      ...(over.monitorPrompt === undefined ? {} : { monitorPrompt: over.monitorPrompt }),
    };
  const rig = (minutes: number, extra: Parameters<typeof harness>[0] = {}) =>
    childRig(fixture, { realWakeState: true, journal, seat, ...(settings ? { settings } : {}), now: fixture.now + minutes * MINUTE, ...extra });
  const journal = fakeJournal();
  let operationId = "";
  const sent = rig(0, { deliverWith: reservedThenTimedOut(fixture, (id) => { operationId = id; }) });
  expect(await runSeatTickCheck(fixture.project, sent.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "failed" } });
  expect(fixture.row().outstandingWake).toMatchObject({ operationId: null, dispatch: { state: "refused" }, preparedAt: new Date(fixture.now).toISOString() });
  /* Inside the settlement window the record is still in flight, so the
     attempt is retained and the next wake waits behind it. */
  const within = rig(5);
  expect(await runSeatTickCheck(fixture.project, within.deps)).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
  expect(within.journal.map((line) => line.verdict)).toEqual(["wake"]);
  /* Past it, the tick's own settlement ends the send. The journal holds no
     record of the operation, so the record reads failed, unverified,
     unrecorded — the production row to the letter. */
  const fenced = rig(11);
  await runSeatTickCheck(fixture.project, fenced.deps);
  const snapshot = fixture.registry.readOnlySnapshot();
  expect(Object.values(snapshot.heldDeliveries).find((row) => row.command.operationId === operationId)).toMatchObject({ state: "failed", attempts: 1, error: SEND_UNRECORDED_REASON });
  expect(snapshot.deliveryOperationOwners[operationId]).toMatchObject({ terminalState: "failed", terminalDisposition: "unverified" });
  return { fixture, journal, child, operationId, wake: fixture.row().outstandingWake!, fenced, rig };
}

/** The facts a later check must leave exactly as they were. */
function frozen(fixture: ChildFixture) {
  const row = fixture.row();
  return { outstandingWake: row.outstandingWake, retiredWakes: row.retiredWakes, lastWakeAt: row.lastWakeAt, eventsThrough: row.eventsThrough };
}

/* ------------------------------------------------------------------------- *
 * The re-raise through the real transport (#1672). A released attempt leaves
 * its key bound in the runtime journal to the operation the journal refused,
 * and the delivery record re-arms that same operation under that key: sent
 * again as the same message it can only replay the refusal, every check, and
 * deliver nothing. The wake raised in its place has to be a new message to
 * both layers, and exactly one.
 * ------------------------------------------------------------------------- */

/** The seat with a live structured host, in the registry and in a real
    runtime journal, which is what the transport's admission requires. */
function hostedSeat(fixture: ChildFixture): { journal: InstanceType<typeof RuntimeJournal>; client: RuntimeHostClient; sessionId: string } {
  const conversation = fixture.registry.conversation(fixture.seat.conversationId as never)!;
  const generation = conversation.generations.at(-1)!;
  const sessionKey = { engine: "claude" as const, sessionId: generation.id };
  fixture.registry.upsert({
    key: sessionKey,
    artifactPath: fixture.seat.path!,
    cwd: fixture.cwd,
    accountId: null,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "fixture:seat-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(fixture.dir, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey,
      hostKind: "claude-broker",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: fixture.seat.path!,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  return { journal, client: journalClient(journal), sessionId: generation.id };
}

/** The production send path end to end: `deliverConversationMessage` into
    `enqueueStructuredMessage`, reserving in the real record and admitting in
    the real journal. Only the dead-host recovery is stubbed, to the seat. */
function realTransport(fixture: ChildFixture, client: RuntimeHostClient): (message: ConversationMessage) => Promise<DeliveryOutcome> {
  return (message) => deliverConversationMessage(message, {
    recover: async () => ({ path: fixture.seat.path!, conversationId: fixture.seat.conversationId as never, spawned: false, target: null }),
    enqueueStructured: (request) => enqueueStructuredMessage(request, {
      enabled: () => true,
      client: () => client,
      registry: () => fixture.registry,
      kick: () => {},
      requestMigrationTick: () => {},
    }),
  });
}

/* ------------------------------------------------------------------------- *
 * The bound on the KEY (#1771).
 *
 * What the live seat did on 2026-09-18: one wake landed at 09:54Z and none
 * ever again, through idle stretches of 70 and 120 minutes on a twenty-minute
 * cadence, while `seat_tick_settings` reported the project fenced by a wake
 * prepared under the SAME original key hour after hour. The key ran 211
 * characters — a 37-character project name, the stamp of the last landed wake,
 * two reasons, the state fingerprint and the monitor prompt's digest — and the
 * runtime journal refuses any key over 200 inside its own admission, before it
 * writes an operation, an outbox effect or a ledger entry. So nothing reached
 * the conversation, nothing landed, the stamp never moved, and the age-bound
 * retirement then appended the released-wake digest and made the replacement
 * key LONGER than the key it replaced. The loop could not end on its own.
 *
 * Both cases run the production controller over this test's own registry, row,
 * delivery record and runtime journal, in its own sandbox.
 * ------------------------------------------------------------------------- */

const MUTE_PROMPT = "before the items, check the deploy ledger for a rollback nobody chased";

/** A send command shaped as the delivery layer shapes one, for asking the real
    journal — the production validator — what it makes of a key. */
function admissionCommand(conversationId: string, idempotencyKey: string, text: string) {
  return {
    kind: "send" as const,
    conversationId,
    idempotencyKey,
    text,
    contentDigest: structuredContentDigest({ text, images: [] }),
    policy: "interrupt-active" as const,
  };
}

/* ------------------------------------------------------------------------- *
 * What a wake is FOR, when the seat has its own board (#1749).
 *
 * The shape the issue was filed on: a seat at epoch 173 woken six times, each
 * wake listing five children of seats retired a fortnight earlier and holding
 * thirty-odd more back, while the lane that seat had launched sat completed
 * with its pull request unmerged and two others stood parked. Every case below
 * drives the production controller over its own registry, row and state
 * directory.
 * ------------------------------------------------------------------------- */

/** The lane fixture for a seat's own settled work: the store's `src` names the
    seat's conversation, which is the whole of what makes it the seat's. */
function ownLane(fixture: ChildFixture, over: Partial<PipelineFixture> = {}): PipelineFixture {
  return {
    id: "pipeline_own_lane",
    state: "completed",
    createdAt: ago(fixture, 120),
    movedAt: ago(fixture, 2),
    project: fixture.project,
    src: fixture.seat.conversationId,
    ...over,
  };
}

/* ------------------------------------------------------------------------- *
 * One line per child, and only children a seat can act on (#1783).
 *
 * The shape this was filed on, read out of production state before anything
 * was changed: 209 owed outcome rows standing for 67 children, one child
 * holding 63 of them; 130 of the rows frozen with no terminal instant at all;
 * 16 of the children with a transcript this Viewer cannot resolve; and 773
 * conversations carrying one single `observedAt`, which is the instant a sweep
 * writes and the instant #1749's age test was reading. Every case below drives
 * the production controller over its own registry, row and state directory.
 * ------------------------------------------------------------------------- */

/** Age the child's own record — the file a sweep never touches (#1783). */
function ageTranscript(fixture: ChildFixture, transcriptPath: string, minutes: number): void {
  const at = new Date(fixture.now - minutes * MINUTE);
  fs.utimesSync(transcriptPath, at, at);
}

/** What a host-retirement sweep does to a child: the conversation row is
    re-observed and rewritten NOW, while the child's transcript gains no
    record and its work stays where it ended (#1783). */
function sweepRegistryRow(fixture: ChildFixture, child: { path: string }, title: string): void {
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title }),
    turn: { state: "terminal", source: "assistant", terminalAt: null },
    observedAt: new Date(fixture.now).toISOString(),
  }]);
}

/* ------------------------------------------------------------------------- *
 * The two paths that still reached the item list (#1783, round two).
 *
 * Read out of production state before anything was changed here. The wake of
 * 2026-09-18 21:55Z, to a seat designated at 09:46 that morning, listed five
 * children and held seventeen back. Three of them were architect runs whose
 * ledgers hold ended turns and whose conversation rows still say `busy` with
 * no host behind them: their accounting rows carry `terminalAt: null`, their
 * transcripts were last written to on the 24th of August, and the age test —
 * reading the terminal instant alone — found nothing to compare and listed
 * them. The other two came through the stall path, which read neither clock
 * nor transcript: one last written to four days before the designation, one
 * whose transcript is not under any scanner root this Viewer has.
 *
 * Both are the same list of children asked the same question, so both cases
 * below drive the production controller over its own registry, accounting row
 * and state directory, once per path.
 * ------------------------------------------------------------------------- */

/** The agenda a wake carries: the bullets under `Items:` and no further —
    the contract at the foot of every message is bulleted too. */
function agendaOf(text: string): string[] {
  const lines = text.split("\nItems:\n")[1]!.split("\n");
  const end = lines.findIndex((line) => !line.startsWith("- "));
  return end === -1 ? lines : lines.slice(0, end);
}

/** The shape all three cases are built from: a worker whose structured host
    wrote an ended turn to its ledger and then died over the open turn, so the
    accounting owes an outcome for it while the registry still reports it busy
    with nothing running it. Every child in the evidence is one of these. */
function endedTurnUnderADeadHost(fixture: ChildFixture, child: { id: string }, status: "completed" | "error", seq: number): void {
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: `turn-${seq}`, seq });
  ledger.append(generation, { kind: "turn-ended", turnId: `turn-${seq}`, status, seq: seq + 1 });
}

/* ------------------------------------------------------------------------- *
 * One standing card per project, and a refusal that ends the attempt.
 *
 * Observed in production: a seat whose host had been gone for a fortnight was
 * sent a wake every check, the re-dispatch was refused with "conversation
 * migration prevents resume succession", the attempt fenced the project for its
 * whole age bound, retired, and the next check raised a fresh one — minting a
 * new "wake unresolved" card per attempt, 35 of them on one board. These drive
 * the production controller with the real card writer over a board file.
 * ------------------------------------------------------------------------- */

const STANDING_BOARD = () => path.join(process.env.LLV_STATE_DIR!, "tasks.json");

async function unresolvedCardsOn(project: string): Promise<{ id: string; text: string }[]> {
  const { loadTasks } = await import("@/lib/tasks/store");
  return loadTasks(STANDING_BOARD())
    .filter((task) => task.project === project && task.status !== "done" && task.text.includes("monitor-ref: seat-tick-wake-unresolved"))
    .map((task) => ({ id: task.id, text: task.text }));
}

/** One project's checks over one durable row, each at its own instant. */
function standingProject(label: string) {
  const project = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const stateFile = path.join(fs.mkdtempSync(path.join(SANDBOX, "standing-")), "seat-tick.json");
  writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, accounting: undefined }, stateFile);
  const lane = [{ ...OPEN_LANE[0]!, project }];
  const check = async (at: number, over: Parameters<typeof harness>[0] = {}) => {
    const rig = harness({ pipelines: lane, settings: defaultSeatTickSettings(project), stateFile, now: at, ...over });
    const record = await runSeatTickCheck(project, { ...rig.deps, ensureCard: undefined });
    return { rig, record: record!, row: readSeatTickState(project, stateFile) };
  };
  return { project, stateFile, check };
}

const MIGRATION_REFUSAL: DeliveryOutcome = { ok: false, outcome: "failed", error: "conversation migration prevents resume succession", status: 503 };

/* ---------------------------------------------------------------------------
 * The report ledger through the controller (docs/design/orchestrator-reports.md
 * §5.1, §3.8): deploy snapshots are taken in the pass before anything is
 * decided or sent, the lifecycle projection runs before the journal is read,
 * and a wake credited a check late is settled by a coversOwed report filed
 * before the credit.
 * ------------------------------------------------------------------------- */

const REPORT_SHA = "dddddddd".padEnd(40, "7");
const reportDeploys = {
  seatDeployments: [{ deploymentId: "deploy-d", conversationId: CONVERSATION }],
  deployments: { "deploy-d": { phase: "succeeded", terminal: true, revision: REPORT_SHA } },
};
const settledLane = { id: "pipeline_l", state: "completed", createdAt: new Date(NOW - 90 * MINUTE).toISOString(), movedAt: new Date(NOW - 3 * MINUTE).toISOString(), src: CONVERSATION };

function reportPort(log: () => import("@/lib/bridge/types").BridgeReportV1[]) {
  return {
    log,
    enabled: () => true,
    operatorLocale: () => "uk" as const,
  };
}

// Controller regressions for idle-seat wakes (#2346).
function idleWakeRig(f: ChildFixture, now: () => number) {
  globalThis.Date = new Proxy(WALL_DATE, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [now()]); },
    get(target, key, receiver) { return key === "now" ? now : Reflect.get(target, key, receiver); },
  });
  f.registry.reconcileConversations([{
    engine: "claude", path: f.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.cwd, title: "seat" }),
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now()).toISOString() },
    observedAt: new Date(now()).toISOString(),
  }]);
  expect(f.registry.conversation(f.seat.conversationId as never)!.turn.state).toBe("idle");
  const rig = childRig(f, { settings: { ...defaultSeatTickSettings(f.project), wakeIntervalMinutes: 5 } });
  rig.deps.sources!.now = now;
  rig.deps.maintenance = null;
  return rig;
}
function finishIdleWorker(f: ChildFixture, child: { id: string; path: string }, now: number) {
  f.registry.reconcileConversations([{
    engine: "claude", path: child.path, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.cwd, title: "worker" }),
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now).toISOString() },
    observedAt: new Date(now).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = f.registry.conversation(child.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "work", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "work", status: "completed", seq: 2 });
}
export { afterAll, afterEach, describe, expect, spyOn, test, fs, os, path, createHash, spawn, Database, SANDBOX, RESTORE, SESSIONS, SEAT_TICK_NO_SELF_SCHEDULE, reconcileSeatTick, runSeatTickCheck, SEAT_TICK_WAKE_UNRESOLVED_REF, startSeatTick, stopSeatTick, wakeReached, writeDrain, drainFile, releaseDrain, DEFAULT_SEAT_TICK_POLICY, seatMcpHealth, viewerMcpTransportForLaunch, defaultSeatTickSettings, openPullRequestsForRepo, confirmedClaudeWakeDelivery, journalReceipt, settleRecordFromJournal, wakeStateFromRecord, FileClaudeDeliveryLedger, resolveOriginalSend, resolveSendReceipt, SEND_UNRECORDED_REASON, SEND_UNVERIFIED_REASON, SEND_DISCARDED_REASON, DELIVERY_FENCED_BY_SETTLEMENT, StructuredDeliveryQueue, createFakeDeliveryLedger, FakeEngineHost, enqueueStructuredMessage, structuredContentDigest, RUNTIME_IDEMPOTENCY_KEY_LIMIT, RuntimeJournal, deliverConversationMessage, readSeatTickState, writeSeatTickState, appendSeatTickRecord, readSeatTickRecords, SeatTickAccounting, outcomeIdentity, FileRuntimeEventStore, statePath, AgentRegistry, setAgentRegistryForTests, emptyLaunchProfile, sessionKeyFromTranscript, projectForCwd, ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SHIPPED_CLOCK_OPENING, ORCHESTRATOR_SEAT_TICK_CONTRACT, ORCHESTRATOR_SYSTEM_PROMPT, ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, mcpLauncherImports, emptySeatTickState, PROJECT, CONVERSATION, SUCCESSOR, NOW, MINUTE, WALL_DATE, pipelineRecord, harness, EMPTY_SNAPSHOT, fakeJournal, journalClient, OVERDUE, RECENT, outstandingWake, OPEN_LANE, terminalEvent, offSettings, FINISHED_LANE, FINISHED_PR_CREATED, ARCHIVED_LANE, standingGap, MONITOR_PROMPT, PROMPT_HEADING, seatTickNoteRevisionForTest, promptSettings, LEDGER_NOTE, busyBoard, CURRENT_SEAT, REPLACEMENT_PROMPT, reservationLayer, HELD, heldWake, nextCheck, childFixture, childRig, ago, recordedWake, refuseBeforeReservation, successorSeat, strandOneWake, retiredEntry, TRANSPORT_TIMEOUT, SEAT_TICK_COMMAND, reservedThenTimedOut, admittedAndRejected, strandedManagerWake, frozen, hostedSeat, realTransport, MUTE_PROMPT, admissionCommand, ownLane, ageTranscript, sweepRegistryRow, agendaOf, endedTurnUnderADeadHost, STANDING_BOARD, unresolvedCardsOn, standingProject, MIGRATION_REFUSAL, REPORT_SHA, reportDeploys, settledLane, reportPort, idleWakeRig, finishIdleWorker };
export type { AgentHostStatus, DurableMembershipInput, SeatTickSettings, SeatTickControllerDependencies, GithubRunner, OpenPullRequest, OpenPullRequestsUnavailable, SeatTickWakeState, SeatTickWithdrawal, RuntimeHostClient, RuntimeReceiptStatus, HostState, SeatTickCard, SeatTickOutstandingWake, SeatTickProjectState, SeatTickRunRecord, AgentLivenessRecord, LifecycleEvent, ConversationMessage, DeliveryOutcome, Harness, PipelineFixture, FakeJournal, ChildFixture, StrandedWake };
