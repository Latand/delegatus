import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-controller-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
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

const { reconcileSeatTick, runSeatTickCheck, seatTickWakeUnresolvedRef, startSeatTick, stopSeatTick, wakeReached } = await import("./seatTickController");
const { DEFAULT_SEAT_TICK_POLICY } = await import("./seatTick");
const { defaultSeatTickSettings } = await import("./seatTickSettings");
const { openPullRequestsForRepo } = await import("./githubEvidence");
const { defaultSeatTickSources, journalReceipt, settleRecordFromJournal, wakeStateFromRecord } = await import("./seatTickSources");
const { resolveOriginalSend, resolveSendReceipt, SEND_UNRECORDED_REASON, SEND_UNSETTLEABLE_REASON, SEND_UNVERIFIED_REASON, SEND_DISCARDED_REASON } = await import("@/lib/runtime/sendSettlement");
const { DELIVERY_FENCED_BY_SETTLEMENT } = await import("@/lib/runtime/structuredDeliveryQueue");
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
import type { AgentHostStatus, DurableMembershipInput } from "@/lib/agent/registry";
import type { SeatTickSettings } from "./seatTickSettings";
import type { SeatTickControllerDependencies } from "./seatTickController";
import type { GithubRunner, OpenPullRequest, OpenPullRequestsUnavailable } from "./githubEvidence";
import type { SeatTickWakeState, SeatTickWithdrawal } from "./seatTickSources";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeReceiptStatus } from "@/lib/runtime/contracts";
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

afterEach(() => {
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
  seat: { conversationId: string; seatEpoch: number; path: string | null; designatedAt?: string | null } | null;
  /** Every liveness read the check made, in order (#1465). */
  liveness: { project?: string; conversationId?: string }[];
  /** Registry snapshot reads the check made (#1465). */
  snapshots: number;
}

type PipelineFixture = { id: string; state: string; createdAt: string; movedAt: string | null; branch?: string; closedAt?: string | null; project?: string;
  /** The conversation that created the lane (#1749), as the store records it.
      Null is a lane nobody's seat launched. */
  src?: string | null;
  /** The newest attempt's state, when the case is a stage that stopped rather
      than a lane that completed. */
  attemptState?: string };

function pipelineRecord(entry: PipelineFixture) {
  return {
    id: entry.id,
    task: `lane ${entry.id}`,
    taskIds: [],
    project: entry.project ?? PROJECT,
    repoDir: "/srv/repo",
    worktreeDir: "/srv/worktree",
    branch: entry.branch ?? "topic",
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [],
    runs: entry.movedAt ? [{ stageId: "build", attempts: [{ n: 1, state: entry.attemptState ?? "passed", startedAt: entry.movedAt, completedAt: entry.movedAt }] }] : [],
    cursor: null,
    state: entry.state,
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: entry.src ?? null,
    createdAt: entry.createdAt,
    closedAt: entry.closedAt ?? null,
  };
}

function harness(options: {
  seat?: { conversationId: string; seatEpoch: number; path: string | null; designatedAt?: string | null } | null;
  turn?: "busy" | "idle";
  seatActivity?: Partial<AgentLivenessRecord> | null;
  pipelines?: PipelineFixture[];
  tasks?: { id: string; status: "inbox" | "assigned" | "blocked" | "done" }[];
  events?: LifecycleEvent[];
  state?: Partial<SeatTickProjectState>;
  delivery?: DeliveryOutcome;
  deliveryThrows?: boolean;
  /** Swaps the seat after the decision, the way a rotation lands mid-check. */
  rotateBeforeSend?: { conversationId: string; seatEpoch: number; path: string | null } | null;
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
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const withdrawn: { wake: SeatTickOutstandingWake; reason: string }[] = [];
  const livenessReads: { project?: string; conversationId?: string }[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, withdrawn, liveness: livenessReads, snapshots: 0, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
  let reads = 0;
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
      seatFor: () => {
        reads += 1;
        /* Reads one and two are the opening reconcile and the gather; every
           read after them is the re-check the send takes, which is where a
           rotation must be caught. */
        const seat = reads > 2 && options.rotateBeforeSend !== undefined ? options.rotateBeforeSend : result.seat;
        return { active: seat as never, pending: null, history: [] };
      },
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

test("a quiet check writes one journal line, sends nothing, and raises no card", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, items: 0 });
  expect(rig.journal).toHaveLength(1);
  expect(rig.sent).toEqual([]);
  expect(rig.cards).toEqual([]);
});

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

test("a project whose tick is off is checked, journaled and never woken (#1275)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings: offSettings() });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  /* The line is the whole difference between a tick that is off and a tick
     that broke: one keeps writing, the other stops. */
  expect(record).toMatchObject({
    verdict: "quiet",
    delivery: null,
    detail: "ticking is off for this project: the only open lane is a draft nothing can discharge",
  });
  expect(rig.cards.map((entry) => entry.card)).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "open",
    settings: { reason: offSettings().reason, until: null, setBy: offSettings().setBy, updatedAt: "2026-08-28T11:00:00.000Z" },
    detail: "ticking is off for this project: no wake will be sent until it is turned back on",
  }]);
});

test("a tick setting that reached its expiry is written back to the default by the check that reads it (#1275)", async () => {
  const settings = offSettings({ until: new Date(NOW - MINUTE).toISOString() });
  const persisted: SeatTickSettings[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, writeSettings: (_project, row) => { persisted.push(row); } });
  /* The wake goes out — the setting lapsed — and the record on disk stops
     saying "off" beside a tick that is ticking. */
  expect(record).toMatchObject({ verdict: "wake" });
  expect(persisted).toEqual([defaultSeatTickSettings(PROJECT)]);
  expect(rig.cards[0]!.card).toMatchObject({ state: "resolved" });
});

test("the lapse ends the setting that expired and keeps the monitor prompt it never covered (#1280)", async () => {
  const settings = offSettings({ until: new Date(NOW - MINUTE).toISOString(), monitorPrompt: MONITOR_PROMPT });
  const persisted: SeatTickSettings[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, { ...rig.deps, writeSettings: (_project, row) => { persisted.push(row); } });
  /* The expiry was set on the on/off, so that is what it ended. The words the
     seat left for its own wakes were not part of it, and the wake this very
     check sent still carries them. */
  expect(persisted).toEqual([{
    ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: MONITOR_PROMPT,
    updatedAt: settings.updatedAt,
    setBy: settings.setBy,
  }]);
  expect(rig.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("the board card for a quiet tick is written, kept in step, and closed when the tick comes back (#1275)", async () => {
  const project = `card-lifecycle-${crypto.randomUUID().slice(0, 8)}`;
  const tasksFile = path.join(SANDBOX, "state", "tasks.json");
  const readCards = (): { text: string; status: string }[] => {
    const raw = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks?: { project: string; text: string; status: string }[] } : {};
    return (raw.tasks ?? []).filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));
  };

  const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
  /* The real card writer, not the harness stub: this is the board surface the
     issue asks for. */
  await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  const raised = readCards();
  expect(raised).toHaveLength(1);
  expect(raised[0]!.text).toContain("This project's seat tick is not on its default settings");
  expect(raised[0]!.text).toContain("the only open lane is a draft nothing can discharge");
  expect(raised[0]!.status).not.toBe("done");

  /* A check that finds the same setting rewrites nothing … */
  await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  expect(readCards()).toEqual(raised);

  /* … a changed setting updates the one card … */
  const slowed = harness({
    pipelines: OPEN_LANE,
    settings: { ...offSettings(), project, enabled: true, wakeIntervalMinutes: 240, reason: "batching this board", updatedAt: "2026-08-28T11:30:00.000Z" },
  });
  await runSeatTickCheck(project, { ...slowed.deps, ensureCard: undefined });
  const updated = readCards();
  expect(updated).toHaveLength(1);
  expect(updated[0]!.text).toContain("batching this board");

  /* … and the check that reads the project back on its defaults closes it. */
  const restored = harness({
    pipelines: OPEN_LANE,
    settings: { ...defaultSeatTickSettings(project), project, updatedAt: "2026-08-28T12:00:00.000Z" },
  });
  await runSeatTickCheck(project, { ...restored.deps, ensureCard: undefined });
  expect(readCards().map((task) => task.status)).toEqual(["done"]);
});

/* The card writer resolves the board file per call, not once at import.
   `mutateTasksFile`'s default is frozen the first time `@/lib/tasks/store` is
   loaded anywhere in the process, so a tick that took it would write to
   whichever state dir happened to be set THEN — in a suite, another test
   file's; in a sandboxed run, the real board outside the sandbox. Asserted
   here by moving the state dir under a running tick, which is the only way the
   two readings can be told apart within one process. */
test("a card is written to the state dir the tick is pointed at now, not the one loaded at import", async () => {
  const project = `card-statedir-${crypto.randomUUID().slice(0, 8)}`;
  const moved = fs.mkdtempSync(path.join(SANDBOX, "moved-state-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = moved;
  try {
    const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
    await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }

  const written = JSON.parse(fs.readFileSync(path.join(moved, "tasks.json"), "utf8")) as { tasks: { project: string; text: string }[] };
  const cards = written.tasks.filter((task) => task.project === project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toContain("This project's seat tick is not on its default settings");
});

test("a wake is delivered by durable conversation id, with an idempotent client message id", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]).toMatchObject({ conversationId: CONVERSATION, pid: null, images: [] });
  expect(rig.sent[0]!.clientMessageId).toBe(record!.delivery!.clientMessageId);
  expect(record!.delivery!.clientMessageId.startsWith(`seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:`)).toBe(true);
  expect(rig.written.at(-1)!.lastWakeAt).toBe(new Date(NOW).toISOString());
});

/* Two checks that found the same thing raise the same wake, so a re-send after
   a send that never landed is the replay the delivery layer treats it as —
   rather than a second copy of a message the seat may yet receive. */
test("the wake's identity comes from what it says, so an unlanded wake re-sends as a replay", async () => {
  const held = { ok: true as const, target: null, outcome: "held" as const };
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: held });
  await runSeatTickCheck(PROJECT, first.deps);
  const second = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: held });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent[0]!.clientMessageId).toBe(first.sent[0]!.clientMessageId);
});

/* The other half of the same key. An hourly wake on a board that has not moved
   carries the same reasons and the same fingerprint as the last one, so without
   the delivered-wake stamp in the key the delivery layer would swallow it as a
   replay — silence the seat cannot tell from a healthy board. */
test("the wake after a delivered one is a new message, not a replay of it", async () => {
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const before = await runSeatTickCheck(PROJECT, first.deps);
  const next = harness({
    pipelines: OPEN_LANE,
    state: { lastWakeAt: first.written.at(-1)!.lastWakeAt, lastWakeFingerprint: first.written.at(-1)!.lastWakeFingerprint },
  });
  /* An hour on, with the board in exactly the state it was left in. */
  next.deps.sources!.now = () => NOW + 61 * MINUTE;
  const after = await runSeatTickCheck(PROJECT, next.deps);
  expect(after!.verdict).toBe("wake");
  expect(after!.delivery!.clientMessageId).not.toBe(before!.delivery!.clientMessageId);
});

test("a seat that rotated between the decision and the send is never woken", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    rotateBeforeSend: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test("a seat revoked with no successor is likewise refused at the send", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, rotateBeforeSend: null });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
});

/* The finding this rule exists for: a delivery the layer accepted is not a
   delivery the seat has. A held or queued message would otherwise start the
   hourly clock and — worse — acknowledge the lane events that raised it. */
test("a held, queued, delivering or pending send is not a delivered wake", async () => {
  expect(wakeReached({ ok: true, target: null, outcome: "held" })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "queued", operationId: "op", receipt: {} as never, structured: true })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "delivering", operationId: "op", receipt: {} as never, structured: true })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "pending" })).toBe(false);
  expect(wakeReached({ ok: true, target: "pane", outcome: "delivered-to-live" })).toBe(true);
  expect(wakeReached({ ok: true, target: null, outcome: "resumed" })).toBe(true);
  expect(wakeReached({ ok: true, target: "pane" })).toBe(true);
  expect(wakeReached({ ok: false, outcome: "failed", error: "gone", status: 409 })).toBe(false);
});

test("a held wake leaves the wake stamp and the event cursor exactly where they were", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
    delivery: { ok: true, target: null, outcome: "held" },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.delivery).toMatchObject({ outcome: "held" });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written.at(-1)!.eventsThrough).toBe(12);
  expect(record!.eventsThrough).toBe(12);
});

/* The half of the epoch check the re-read before the send cannot do. The layer
   keeps a held or queued payload durably, so the seat can rotate while it
   waits — and it would then arrive at the predecessor, which is the failure
   this whole mechanism exists to end. The record names WHICH layer kept it,
   because a revocation aimed at the wrong one changes nothing. */
test("a wake the runtime host queued is written down against that operation", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-wake-1", receipt: {} as never, structured: true },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["lane-event"], fingerprint: record!.delivery!.clientMessageId.split(":").at(-1)!, eventsThrough: 44, children: [] },
  });
});

/* And the hold that never reached a host: there is no runtime operation, so the
   Viewer registry's own reservation IS the retention and the record says so by
   carrying no operation id. */
test("a wake an account migration held names no operation, because no host has it", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "held" },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ operationId: null, seatEpoch: 7 });
});

test("the next check takes that wake back out of the queue holding it, the moment the epoch moves", async () => {
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    /* The row the predecessor left: its epoch, and its unlanded wake. */
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstandingWake() },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn).toHaveLength(1);
  expect(rig.withdrawn[0]!.wake.operationId).toBe("op-wake-1");
  expect(rig.withdrawn[0]!.reason).toContain("has since been replaced");
  const revocation = rig.journal.find((line) => line.verdict === "revoked");
  expect(revocation).toMatchObject({ seatEpoch: 7, delivery: { outcome: "withdrawn" } });
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
});

/* The answer this mechanism has to be able to give. A holder that has already
   let the payload go cannot be made to take it back, and reporting that as a
   revocation would be the silent version of the very defect being prevented. */
test("a withdrawal the holder was already past is recorded as too late, never as a revocation", async () => {
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstandingWake() },
    withdrawal: "too-late",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const line = rig.journal.find((entry) => entry.delivery?.outcome === "too-late")!;
  expect(line.detail).toContain("may have received it");
  /* The predecessor may have it, so the attempt is neither credited nor
     replaced (#1465): it keeps its original key and nothing it carried is
     acknowledged. This seat is provably superseded — another conversation, at a
     higher epoch — so the attempt keeps that key as the REPLACED seat's
     obligation rather than as a fence on the successor's wake (#1594), and the
     next check asks the holder again there. */
  expect(line.verdict).toBe("retired");
  const written = rig.written.at(-1)!;
  expect(written.outstandingWake).toBeNull();
  expect(written.retiredWakes).toMatchObject([{ wake: { clientMessageId: outstandingWake().clientMessageId, commit: outstandingWake().commit } }]);
  /* And the successor, no longer waiting behind it, is woken under its own. */
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.conversationId).toBe(SUCCESSOR);
  expect(rig.sent[0]!.clientMessageId).not.toBe(outstandingWake().clientMessageId);
});

/* The same seat is not a replacement, so a wake the holder still has stays
   outstanding — that one is the replay the next check re-raises under the same
   key. */
test("a seat that is still the same seat keeps a wake its holder is still holding", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...RECENT, outstandingWake: outstanding },
    wakeState: "retained",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn).toEqual([]);
  expect(rig.journal.some((line) => line.verdict === "revoked")).toBe(false);
  /* The attempt is kept as it was, with one addition: a row written before
     the instant existed is stamped with when it was first seen (#1465), so
     the bound on an attempt nobody can account for is measured from a fact. */
  expect(rig.written.at(-1)!.outstandingWake).toEqual({ ...outstanding, preparedAt: new Date(NOW).toISOString() });
  expect(rig.cards).toEqual([]);
});

/* The other half of the same question, and the reason `queued` may be believed
   at all. A structured host admits every send as queued whether it is idle or
   mid-turn, so "did the seat get it?" is only ever answered by the layer that
   took it — and that answer has to apply the stamp and the cursor the raising
   check wrote down. Without it the hourly bound the ADR rests on is bypassed by
   a wake that was delivered and never recorded. */
test("a wake the holder delivered after the send is credited with the plan that raised it", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...RECENT, eventsThrough: 12, outstandingWake: outstanding },
    wakeState: "landed",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const landing = rig.journal.find((line) => line.verdict === "landed")!;
  expect(landing.delivery).toEqual({ clientMessageId: outstanding.clientMessageId, outcome: "landed" });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(rig.written.at(-1)!.lastWakeReasons).toEqual(["interval"]);
  expect(rig.written.at(-1)!.eventsThrough).toBe(44);
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
});

/* And the bound that landing restores: an hour has to pass from the delivery
   the holder made, not from a delivery the tick happened to observe. */
test("crediting the landing starts the hourly bound, so the same check does not wake again", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
    wakeState: "landed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.verdict).toBe("quiet");
});

/* A holder that settled the payload without delivering it woke nobody, so no
   stamp moves and the wake is owed again. */
test("a wake the holder settled unsent moves no stamp, and the same check raises it again", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, eventsThrough: 12, outstandingWake: outstandingWake() },
    wakeState: "dropped",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const dropped = rig.journal.find((line) => line.verdict === "dropped")!;
  expect(dropped.delivery).toMatchObject({ outcome: "dropped" });
  expect(dropped.eventsThrough).toBe(12);
  expect(rig.sent).toHaveLength(1);
});

/* A rotation that lands while the send is in flight is the one the row cannot
   carry to a later check, because there may not be one before the payload
   flushes. So a retained send is re-checked at once. */
test("a rotation during the send is caught by the same check that made the wake", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-inflight", receipt: {} as never, structured: true },
  });
  let reads = 0;
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.seatFor = ((project: string) => {
    reads += 1;
    /* The opening reconcile, the gather and the pre-send re-check all see the
       incumbent; the read after the send sees the successor that landed
       meanwhile. */
    return reads > 4
      ? { active: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } as never, pending: null, history: [] }
      : seatFor(project);
  }) as typeof seatFor;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn.map((entry) => entry.wake.operationId)).toEqual(["op-inflight"]);
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
});

/* A holder that cannot answer must not take the check down with it, and it is
   not evidence either way: the payload is exactly where it was, so the row
   keeps it and the next check asks again. */
test("a holder that cannot be reached is journaled, and the attempt is retained whole", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 7, outstandingWake: outstanding },
    holderThrows: true,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).not.toBe("error");
  const line = rig.journal.find((entry) => entry.delivery?.outcome === "unknown")!;
  expect(line.detail).toContain("could not be revoked");
  /* Nothing about the payload is known, so nothing about it is decided: it is
     retained exactly as it stood, under its own key, stamped with when it was
     first seen. It is retained against the seat it was addressed to, which this
     project has provably replaced (#1594), so the next check asks that same
     holder again without the successor waiting on the answer. */
  expect(line.verdict).toBe("retired");
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
  expect(rig.written.at(-1)!.retiredWakes).toEqual([
    { wake: { ...outstanding, preparedAt: new Date(NOW).toISOString() }, retiredAt: new Date(NOW).toISOString(),
      supersededBy: { conversationId: SUCCESSOR, seatEpoch: 8 }, reason: "seat-superseded" },
  ]);
  expect(rig.cards).toEqual([]);
});

/* Before #1465 this check sent the new wake and let its landing settle the old
   one. That put a second wake in flight behind one the seat may yet receive —
   the duplicate the issue's correction warns about — so a different wake now
   waits until the holder answers for the first. */
test("a different wake is withheld while the outstanding one is unresolved, and the row keeps the first (#1465)", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
    wakeState: "retained",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(record!.delivery!.clientMessageId).not.toBe(outstandingWake().clientMessageId);
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toEqual({ ...outstandingWake(), preparedAt: new Date(NOW).toISOString() });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

/* The bound made visible (#1465): an attempt a live holder still keeps past a
   whole wake interval is never ended here — that holder will deliver or fail
   it — but the wait goes on the board once, under the attempt's own key. */
test("a wake a holder still retains past the wake interval is carded once and kept (#1465)", async () => {
  const outstanding = outstandingWake({ preparedAt: new Date(NOW - 70 * MINUTE).toISOString() });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstanding);
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(rig.cards.map((entry) => entry.card)).toMatchObject([{ ref: seatTickWakeUnresolvedRef(outstanding.clientMessageId), kind: "wake-unresolved", instance: outstanding.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain('last answered "retained"');
  /* The same attempt on the next check is the same occurrence: the board's own
     create receipt collapses it, and a second attempt would be a second card. */
  const again = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  await runSeatTickCheck(PROJECT, again.deps);
  expect(again.cards.map((entry) => entry.card.instance)).toEqual([outstanding.clientMessageId]);
});

test("the same outstanding wake remains fenced under its original key (#1465)", async () => {
  const first = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-wake-1", receipt: {} as never, structured: true },
  });
  const raised = await runSeatTickCheck(PROJECT, first.deps);
  const outstanding = first.written.at(-1)!.outstandingWake!;
  expect(outstanding.clientMessageId).toBe(raised!.delivery!.clientMessageId);

  const second = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, second.deps);
  expect(record!.delivery).toEqual({ clientMessageId: outstanding.clientMessageId, outcome: "deferred-outstanding" });
  expect(second.sent).toHaveLength(0);
});

test("a delivered wake is what moves the event cursor past the events it carried", async () => {
  const rig = harness({ pipelines: OPEN_LANE, events: [terminalEvent(44)], state: { ...OVERDUE, eventsThrough: 12 } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(rig.written.at(-1)!.eventsThrough).toBe(44);
});

/* #1262, end to end: the seat's very first check, against a journal that
   already holds a day of settled work. The wake that produced the report said
   "stage_completed since the last delivered wake and 85 more" for a seat that
   had never had a delivered wake at all. */
test("a project's first check seals the cursor at the head instead of replaying the journal", async () => {
  const history = [terminalEvent(9848), terminalEvent(9850), terminalEvent(9853)];
  const rig = harness({ pipelines: OPEN_LANE, events: history, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  /* The lane is open and the hour has elapsed, so a wake is owed — but on the
     open lane, not on three days of finished stages. */
  expect(record!.reasons).toEqual(["interval"]);
  expect(rig.sent[0]!.text).not.toContain("the round passed");
  expect(record!.items).toBe(1);
  expect(record!.eventsThrough).toBe(9853);
  expect(rig.written.at(-1)!.eventsThrough).toBe(9853);
});

/* And the check after it is the one the cursor exists for: what happened since
   the tick began is still delivered, in full. */
test("the check after the seal carries the events that arrived since it", async () => {
  const history = [terminalEvent(9848), terminalEvent(9853)];
  const sealed = harness({ pipelines: OPEN_LANE, events: history, state: OVERDUE });
  await runSeatTickCheck(PROJECT, sealed.deps);
  const next = harness({
    pipelines: OPEN_LANE,
    events: [...history, terminalEvent(9854)],
    state: { ...OVERDUE, eventsThrough: sealed.written.at(-1)!.eventsThrough },
  });
  const record = await runSeatTickCheck(PROJECT, next.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(record!.eventsThrough).toBe(9854);
});

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

/* The report: three consecutive wakes whose every item named a pipeline that
   had reached a terminal state the day before. Nothing was owed on any of them,
   and establishing that was the entire cost of the wake. */
test("events belonging to a lane that has finished send nothing, and the check that read them discharges them", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    events: [terminalEvent(44), terminalEvent(45), terminalEvent(46)].map((event) => ({ ...event, pipelineId: "pipeline_z9" })),
    state: { ...OVERDUE, eventsThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, detail: "nothing owed" });
  expect(rig.sent).toEqual([]);
  /* And the backlog does not come back for a second, third and fourth wake:
     one look moved the cursor past all of it. */
  expect(rig.written.at(-1)!.eventsThrough).toBe(46);
  expect(record!.eventsThrough).toBe(46);
});

/* Twelve hours of `quiet — nothing owed` while three approved pull requests sat
   unmerged, because the tick counts open lanes and board cards and a finished
   lane is neither. */
test("a completed lane whose pull request is still open wakes the seat, naming the pull request", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    state: OVERDUE,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
  expect(rig.sent[0]!.text).toContain("[pull-request] #1289 — wake on a merge that is waiting");
});

/* And the merge is what silences it, with nothing else to turn off. */
test("once the pull request is merged the same project owes nothing again", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    openPullRequests: [],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "nothing owed" });
  expect(rig.sent).toEqual([]);

  /* And with the board empty behind it too — one finished lane and nothing
     else — the same merge leaves a project with no wake owed at all. */
  const bare = harness({
    pipelines: FINISHED_LANE,
    state: { ...OVERDUE, lastProposalAt: new Date(NOW - MINUTE).toISOString() },
    openPullRequests: [],
  });
  expect(await runSeatTickCheck(PROJECT, bare.deps)).toMatchObject({ verdict: "quiet" });
  expect(bare.sent).toEqual([]);
});

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

test("a lane the archive has taken still wakes the seat over its open pull request", async () => {
  const rig = harness({
    pipelines: [],
    archivedPipelines: ARCHIVED_LANE,
    state: OVERDUE,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
});

test("and once that pull request merges the same project goes quiet", async () => {
  const rig = harness({
    pipelines: [],
    archivedPipelines: ARCHIVED_LANE,
    state: { ...OVERDUE, lastProposalAt: new Date(NOW - MINUTE).toISOString() },
    openPullRequests: [],
  });
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * A `gh` that could not answer is journaled and retried, never spent.
 * ------------------------------------------------------------------------- */

test("a GitHub failure is journaled as an error rather than published as quiet", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    pullRequestsUnavailable: "command-failed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "error", reasons: [], items: 0 });
  expect(record!.detail).toContain("command-failed");
  expect(rig.sent).toEqual([]);
  /* The stamp and the guard are exactly where the previous check left them, so
     the hourly budget is intact and the next check asks again. */
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written.at(-1)!.wakesWithoutChange).toEqual({});
  expect(rig.written.at(-1)!.quietSince).toBeNull();
});

test("the check after the failure asks again, and wakes as soon as GitHub answers", async () => {
  const failed = harness({ pipelines: FINISHED_LANE, state: OVERDUE, pullRequestsUnavailable: "timed-out" });
  expect(await runSeatTickCheck(PROJECT, failed.deps)).toMatchObject({ verdict: "error" });

  /* The next check reads the row the failed one wrote — the wake stamp it did
     not move — and the wake is still due. */
  const recovered = harness({
    pipelines: FINISHED_LANE,
    state: failed.written.at(-1)!,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  expect(await runSeatTickCheck(PROJECT, recovered.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
});

/* The lane event goes out (#1298), and the wake it goes out on says what the
   check could not see. Withholding it was the four-hour silence: the event had
   nothing to do with GitHub, and the seat heard about neither. */
test("a lane event still wakes the seat while GitHub is unreadable, and the wake names the gap", async () => {
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, eventsThrough: 12 },
    events: [terminalEvent(44)],
    pullRequestsUnavailable: "malformed-output",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["lane-event"], items: 1 });
  /* The journal line carries the gap beside the reason, so an hour that ran on
     one blind source reads back as exactly that. */
  expect(record!.detail).toContain("malformed-output");
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
  expect(rig.sent[0]!.text).toContain("pull-requests: the open pull requests of this project's finished lanes could not be read (malformed-output)");
  /* And the reason that rests on the unreadable source is not among them: an
     empty answer nobody could read names no pull request. */
  expect(record!.reasons).not.toContain("unmerged-pr");
});

/* The acceptance case (#1298), end to end: a parked lane, a pull-request
   source that cannot be read, and a seat that used to hear nothing at all. */
test("a parked lane and an unreadable pull-request source produce a wake naming both", async () => {
  const parked = [{ id: "pipeline_p1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T09:30:00.000Z" }];
  const first = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: OVERDUE,
    pullRequestsUnavailable: "command-failed",
  });
  /* The first check is the one that establishes the stall; a lane between two
     attempts is never called stuck, so this one wakes on the interval instead
     and the parked lane is remembered for the next. */
  expect(await runSeatTickCheck(PROJECT, first.deps)).toMatchObject({ verdict: "wake" });
  expect(first.written.at(-1)!.stalledSeen).toEqual(["pipeline_p1"]);

  const rig = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: { ...first.written.at(-1)!, ...OVERDUE },
    pullRequestsUnavailable: "command-failed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(rig.sent[0]!.text).toContain("pipeline_p1");
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
});

/* The same case with the failure arriving the way production produced it: `gh`
   itself throwing, through the real seam and the real parse, rather than a
   classified result the test picked. Twenty-three checks reported `error` while
   these two lanes stood parked; the wake below is what the seat should have
   been getting all along. */
test("a gh that throws beside a parked lane still wakes the seat, and names what it could not see", async () => {
  const parked = [{ id: "pipeline_p1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T09:30:00.000Z" }];
  const run: GithubRunner = async () => { throw new Error("gh: could not authenticate"); };
  const first = harness({ pipelines: [...parked, ...FINISHED_LANE], state: OVERDUE, githubRun: run });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.written.at(-1)!.stalledSeen).toEqual(["pipeline_p1"]);

  const rig = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: { ...first.written.at(-1)!, ...OVERDUE },
    githubRun: run,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  /* The reason that stands names the parked lane … */
  expect(rig.sent[0]!.text).toContain("pipeline_p1");
  /* … the wake says which evidence it could not read … */
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
  expect(rig.sent[0]!.text).toContain("command-failed");
  /* … and the reason that rested on the failed source is not among them. */
  expect(record!.reasons).not.toContain("unmerged-pr");
  /* Nothing about the failed read was recorded as quiet. */
  expect(rig.written.at(-1)!.quietSince).toBeNull();
});

/* The three ways `gh` itself fails, each carried through the real seam and the
   real parse, each alongside a lane event that would otherwise have woken the
   seat. Each wakes on the reason that stands, names the gap it could not read,
   raises no `unmerged-pr`, and is asked again on the next check. */
test("a thrown command, a timeout and unusable output each name their gap and are asked again", async () => {
  const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  const failures: { name: string; gap: string; run: GithubRunner }[] = [
    { name: "thrown command", gap: "command-failed", run: async () => { throw new Error("gh: command not found"); } },
    { name: "timeout", gap: "timed-out", run: async () => { throw killed; } },
    /* A nonempty answer whose only row names no head branch: the shape that
       used to arrive as a successful empty list. */
    { name: "unusable output", gap: "malformed-output", run: async () => JSON.stringify([{ number: 1289, title: "no head" }]) },
  ];

  for (const failure of failures) {
    let asked = 0;
    const run: GithubRunner = async (args) => {
      asked += 1;
      return failure.run(args);
    };
    const rig = harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: { ...OVERDUE, eventsThrough: 12, wakesWithoutChange: { "lane-event": 1 }, lastWakeFingerprint: "fp-0" },
      events: [terminalEvent(44)],
      githubRun: run,
    });

    const record = await runSeatTickCheck(PROJECT, rig.deps);
    expect(`${failure.name}: ${record!.verdict}`).toBe(`${failure.name}: wake`);
    expect(`${failure.name}: ${record!.reasons.join(",")}`).toBe(`${failure.name}: lane-event`);
    expect(record!.detail).toContain(failure.gap);
    expect(rig.sent[0]!.text).toContain(failure.gap);
    expect(rig.written.at(-1)!.quietSince).toBeNull();
    /* The run of failures is on the row, and it is a fresh one: a source that
       has only just stopped answering is retried at every check. */
    expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ gap: failure.gap, attempts: 1, reported: false });
    expect(asked).toBe(1);

    /* The next check reads the row the failed one wrote and asks `gh` again,
       rather than waiting out an hour on one failure. */
    await runSeatTickCheck(PROJECT, harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: { ...rig.written.at(-1)!, ...OVERDUE },
      events: [terminalEvent(44)],
      githubRun: run,
    }).deps);
    expect(`${failure.name}: asked ${asked}`).toBe(`${failure.name}: asked 2`);
  }
});

/* The standing outage, put where an operator looks (#1298). Every one of the
   twenty-three failures was journaled, and the journal is not what anyone was
   reading — the operator read the board, and the board said nothing. */
test("a source unreadable since before the wake interval is carded once, and the row remembers", async () => {
  const gap = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * MINUTE).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString(),
    attempts: 23,
    reported: false,
  };
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const carded = rig.cards.find((entry) => entry.card.kind === "source-unreadable");
  expect(carded?.card.ref).toBe("seat-tick-source-pull-requests");
  expect(carded?.card.detail).toContain("command-failed, 24 attempt(s)");
  expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, attempts: 24, since: gap.since });

  /* And the next check says nothing further: one card per outage, whatever the
     tick then does about it. */
  const again = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...rig.written.at(-1)!, ...OVERDUE },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, again.deps);
  expect(again.cards.filter((entry) => entry.card.kind === "source-unreadable")).toEqual([]);
});

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

/* The report is remembered only once it EXISTS (#1298). The controller catches
   a failed card write on purpose — one board file nobody can write is not a
   reason to stop ticking — and the row it then persisted said the operator had
   been told. That suppressed the one report the outage owes for as long as the
   outage lasted, which is the whole failure this card was added to end. */
test("a card write that fails leaves the outage unreported, and the next check reports it", async () => {
  const gap = standingGap();
  const blocked = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
    cardWrite: "throws",
  });
  await runSeatTickCheck(PROJECT, blocked.deps);
  /* The card was attempted and the check carried on — the wake still went out
     over the reason that does not rest on the failed source. */
  expect(blocked.cards.filter((entry) => entry.card.kind === "source-unreadable")).toHaveLength(1);
  expect(blocked.sent).toHaveLength(1);
  /* And the row says what is true: nobody has been told. */
  expect(blocked.written.at(-1)!.pullRequestGap).toMatchObject({ reported: false, attempts: 24, since: gap.since });

  /* A board that refuses the create rather than throwing is the same fact
     arriving as a return value, and is remembered the same way. */
  const refused = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: blocked.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
    cardWrite: "refused",
  });
  await runSeatTickCheck(PROJECT, refused.deps);
  expect(refused.written.at(-1)!.pullRequestGap).toMatchObject({ reported: false });

  /* The retry: the same outage, a board that accepts the write, and only now
     does the row remember having said it. */
  const retried = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: refused.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, retried.deps);
  const carded = retried.cards.find((entry) => entry.card.kind === "source-unreadable");
  expect(carded?.card.detail).toContain(`${gap.since.slice(0, 16).replace("T", " ")} UTC`);
  expect(retried.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, since: gap.since });

  /* And having been reported once, it is not reported again. */
  const settled = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: retried.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, settled.deps);
  expect(settled.cards.filter((entry) => entry.card.kind === "source-unreadable")).toEqual([]);
});

/* Through the real card writer, because the defect lives in the receipt rather
   than in the decision: every outage of one source shares the card's `ref`, so
   a second outage replayed the FIRST outage's create receipt and wrote nothing
   — onto a board whose first card the operator had since completed. The row
   then remembered a report that exists nowhere. */
test("a second outage of the same source is carded again after the first card was completed", async () => {
  const project = `source-outage-${crypto.randomUUID().slice(0, 8)}`;
  const tasksFile = path.join(SANDBOX, "state", "tasks.json");
  const readCards = (): { text: string; status: string }[] => {
    const raw = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks?: { project: string; text: string; status: string }[] } : {};
    return (raw.tasks ?? []).filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));
  };
  const lanes = [...OPEN_LANE, ...FINISHED_LANE].map((lane) => ({ ...lane, project }));
  const outage = (gap: ReturnType<typeof standingGap>) => harness({
    pipelines: lanes,
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
    settings: defaultSeatTickSettings(project),
  });

  const first = outage(standingGap());
  await runSeatTickCheck(project, { ...first.deps, ensureCard: undefined });
  expect(readCards()).toHaveLength(1);
  expect(readCards()[0]!.text).toContain("Seat tick cannot read one of its evidence sources");
  expect(first.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true });

  /* The operator reads it and closes it. */
  const board = JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks: { project: string; status: string }[] };
  for (const task of board.tasks) if (task.project === project) task.status = "done";
  fs.writeFileSync(tasksFile, JSON.stringify(board));

  /* An interval later the standing source is asked again and answers, which is
     what ends the run — and leaves the next outage a run of its own. */
  const recovered = harness({
    pipelines: lanes,
    state: {
      ...OVERDUE,
      pullRequestGap: { ...first.written.at(-1)!.pullRequestGap!, lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString() },
    },
    openPullRequests: [],
    settings: defaultSeatTickSettings(project),
  });
  await runSeatTickCheck(project, { ...recovered.deps, ensureCard: undefined });
  expect(recovered.written.at(-1)!.pullRequestGap).toBeNull();
  expect(readCards().map((card) => card.status)).toEqual(["done"]);

  /* And the second outage is put in front of the operator, rather than
     replaying the receipt of a card they have already dealt with. */
  const second = standingGap({ since: new Date(NOW - 2 * 60 * MINUTE).toISOString(), attempts: 11 });
  const later = outage(second);
  await runSeatTickCheck(project, { ...later.deps, ensureCard: undefined });
  const cards = readCards();
  expect(cards).toHaveLength(2);
  const open = cards.filter((card) => card.status !== "done");
  expect(open).toHaveLength(1);
  expect(open[0]!.text).toContain(`${second.since.slice(0, 16).replace("T", " ")} UTC`);
  expect(later.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, since: second.since });
});

/* The other edge of that table, through the same seam. Exactly the empty array
   is the answer a check may go quiet on, so the refusal above must not grow
   into refusing it: a parse that read `[]` as output nobody can attribute
   would leave every project whose pull requests have all merged in a permanent
   error, which is the same confusion of an answer with a failure, running the
   other way. */
test("the empty array is the one gh answer that still earns quiet", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    githubRun: async () => "[]",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "nothing owed" });
  expect(rig.sent).toEqual([]);
  /* And the row records the quiet, which is the claim an error never makes. */
  expect(rig.written.at(-1)!.quietSince).toBe(new Date(NOW).toISOString());

  /* One usable row beside it, off the same seam and the same parse: the answer
     that is not empty wakes, so the quiet above came from the answer and not
     from a seam that had stopped reporting anything. */
  const open = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    githubRun: async () => JSON.stringify([
      { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", updatedAt: "2026-08-28T11:30:00.000Z" },
    ]),
  });
  expect(await runSeatTickCheck(PROJECT, open.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
  expect(open.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
});

/* The incident's own failure mode (#1465): a send the delivery layer refuses
   before reserving anything — the 409 when the seat cannot be resumed, the 503
   when no host owns it — leaves no record under the key and no operation to
   ask. The attempt is kept under its key, and the next check re-dispatches the
   SAME frozen payload under the SAME key: a same-identity recovery the layer's
   per-key reservation keeps from ever producing a second copy (proved below
   against the real registry), never a replacement. Kept without that, the
   attempt deferred every later wake behind it for ever. Every case asks the
   PRODUCTION `wakeState` over the isolated registry. */
test("a send the layer refused without a record is re-dispatched under its original key by the next check (#1465)", async () => {
  for (const refusal of [
    { ok: false as const, outcome: "failed" as const, error: "the conversation cannot be resumed", status: 409 },
    { ok: false as const, outcome: "failed" as const, error: "structured delivery ownership is unavailable", status: 503 },
  ]) {
    const fixture = childFixture(`refused-${refusal.status}`);
    setAgentRegistryForTests(fixture.registry);
    const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
    fixture.seed();
    const rig = childRig(fixture, { realWakeState: true, delivery: refusal });
    const record = await runSeatTickCheck(fixture.project, rig.deps);
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "failed" } });
    expect(rig.sent).toHaveLength(1);
    expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
    /* Kept under its key with its frozen payload; nothing credited, no stamp. */
    const outstanding = fixture.row().outstandingWake!;
    expect(outstanding).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId, operationId: null, text: rig.sent[0]!.text, preparedAt: new Date(fixture.now).toISOString() });
    expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
    expect(fixture.acknowledged()).toEqual([]);
    expect(rig.cards).toEqual([]);

    /* The next check: the record affirms it holds nothing under the key, so the
       same payload goes out under the same key — and lands on the ORIGINAL plan. */
    const next = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE, deliverWith: async (message) => {
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, {});
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    } });
    const retried = await runSeatTickCheck(fixture.project, next.deps);
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]).toMatchObject({ clientMessageId: outstanding.clientMessageId, text: outstanding.text, conversationId: fixture.seat.conversationId });
    expect(next.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: outstanding.clientMessageId, outcome: "landed" } });
    expect(next.journal[0]!.detail).toContain("re-dispatched under its original key");
    expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 5 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
    /* And the check itself, its landing credited, has nothing else to raise. */
    expect(retried).toMatchObject({ verdict: "quiet" });
    setAgentRegistryForTests(null);
  }
});

/* The recovery above is safe only because the delivery layer reserves one
   delivery per key. This proves that contract against the real registry, for
   every state the first attempt can be in when the same key comes back with
   the same payload: nothing here ever creates a second reservation, and a
   changed payload under a live key is refused outright. */
test("the delivery layer holds one reservation per client message id, whatever became of the first attempt (#1465)", () => {
  const fixture = childFixture("same-key-contract");
  const seat = fixture.seat.conversationId as never;
  const rows = () => Object.values(fixture.registry.readOnlySnapshot().heldDeliveries);
  const hold = (key: string, text = "wake text", operation = {}) => fixture.registry.holdDelivery(seat, text, key, "text", [], null, operation);

  /* In flight: the same key replays the same reservation. */
  const first = hold("seat-tick:contract:1");
  expect(hold("seat-tick:contract:1")).toMatchObject({ id: first.id, state: first.state });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:1")).toHaveLength(1);
  /* A changed payload under a live key is refused, never delivered beside it. */
  expect(() => hold("seat-tick:contract:1", "a different wake")).toThrow();

  /* Delivered: the same key answers with the delivered record. */
  const delivered = hold("seat-tick:contract:2", "wake text", { operationId: "op-contract-2", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(delivered.id, "delivered", null, "delivered");
  expect(hold("seat-tick:contract:2", "wake text", { operationId: "op-contract-2", kind: "send", policy: "queue" })).toMatchObject({ id: delivered.id, state: "delivered" });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:2")).toHaveLength(1);

  /* Ended unverified — the host took it and died: the same key is absorbed by
     the record that may have arrived, and nothing is re-armed. */
  const unverified = hold("seat-tick:contract:3", "wake text", { operationId: "op-contract-3", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(unverified.id, "failed", "the host took it and died", "unverified");
  expect(hold("seat-tick:contract:3", "wake text", { operationId: "op-contract-3", kind: "send", policy: "queue" })).toMatchObject({ id: unverified.id, state: "failed" });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:3")).toHaveLength(1);

  /* Proven lost — fenced before actuation: the same key re-arms the same
     reservation rather than adding one. */
  const lost = hold("seat-tick:contract:4", "wake text", { operationId: "op-contract-4", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(lost.id, "failed", "fenced before actuation", "lost");
  expect(hold("seat-tick:contract:4", "wake text", { operationId: "op-contract-4", kind: "send", policy: "queue" })).toMatchObject({ id: lost.id, state: "assigned" });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:4")).toHaveLength(1);

  /* Nothing under the key: a fresh reservation, exactly one. */
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:5")).toHaveLength(0);
  hold("seat-tick:contract:5");
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:5")).toHaveLength(1);
});

/* A refusal that began actuating, or one the record still holds, is not that
   proof: the record's answer wins and the attempt is kept. */
test("a refusal the record contradicts keeps the attempt (#1465)", async () => {
  const fixture = childFixture("refused-but-held");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    realWakeState: true,
    deliverWith: async (message) => {
      /* The layer reserved the key and queued the send, then answered a refusal
         the caller could not tell from a plain one. */
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, { operationId: "op-held-1", kind: "send", policy: "queue" });
      return { ok: false, outcome: "failed", error: "the control channel closed", status: 409 };
    },
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId });
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  /* The record holds it, so the next check re-dispatches nothing. */
  const next = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, next.deps)).toMatchObject({ delivery: { clientMessageId: record!.delivery!.clientMessageId, outcome: "deferred-outstanding" } });
  expect(next.sent).toEqual([]);
});

test("a seat mid-turn is skipped without a send and without consuming the event cursor", async () => {
  const rig = harness({
    turn: "busy",
    seatActivity: { lifecycle: "running", reason: "host_alive_turn_active" },
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "skipped", delivery: null, eventsThrough: 12 });
  expect(rig.sent).toEqual([]);
});

/* And the seat whose own host died under an open turn: the registry still says
   `busy`, so the rule this replaces would have dropped every tick forever. */
test("a busy seat the registry reports stalled is woken, which is what resumes its host", async () => {
  const rig = harness({
    turn: "busy",
    seatActivity: { lifecycle: "stalled", reason: "host_gone_turn_open" },
    pipelines: OPEN_LANE,
    state: OVERDUE,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
});

test("open work with nobody seated raises the orchestrator card and wakes nothing", async () => {
  const rig = harness({ seat: null, pipelines: OPEN_LANE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "no-seat", seatEpoch: null });
  expect(rig.cards).toHaveLength(1);
  expect(rig.cards[0]!.card.ref).toBe("orchestrator-unresolved");
  expect(rig.sent).toEqual([]);
});

test("the proactive slot delivers a proposal brief built from open issues", async () => {
  const rig = harness({});
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).toBe("proactive");
  expect(rig.sent[0]!.text).toContain("#1245 the native seat tick");
  expect(rig.sent[0]!.text).toContain("post it as a single board card in inbox");
  expect(rig.written.at(-1)!.lastProposalAt).toBe(new Date(NOW).toISOString());
});

/* An empty log reads exactly like a run that never happened — the ambiguity
   this journal exists to remove — so a check that throws still leaves a line. */
test("a check that throws still leaves one journal line, naming the failure", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, readState: () => { throw new Error("the row cannot be read"); } });
  expect(record).toMatchObject({ verdict: "error", project: PROJECT, delivery: null });
  expect(record!.detail).toContain("the check failed");
  expect(rig.journal).toHaveLength(1);
});

test("the tick is one clock in one process: a second start is refused out loud and on the record", () => {
  const refused: string[] = [];
  const journal: SeatTickRunRecord[] = [];
  const ports = {
    scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => undefined,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: (line: string) => refused.push(line),
    appendRecord: (record: SeatTickRunRecord) => { journal.push(record); },
  };
  expect(startSeatTick(ports)).toBe(true);
  expect(startSeatTick(ports)).toBe(false);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("exactly one ticker per seat");
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({ verdict: "refused" });
});

/* The refusal above only covers a second start inside ONE process, and one
   process is not one process for ever: a deploy promotes a successor beside the
   incumbent, and the predecessor keeps its armed timer. Traffic authority is
   the durable fact both of them can read, so the sweep re-asks it. */
test("a release that no longer owns traffic refuses the sweep, records it, and stops its own clock", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let swept = 0;
  rig.deps.sources!.activeSeats = () => { swept += 1; return [PROJECT]; };
  const ports = {
    scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => undefined,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
    appendRecord: () => {},
  };
  expect(startSeatTick(ports)).toBe(true);

  const records = await reconcileSeatTick({ ...rig.deps, ownsTraffic: () => false });
  expect(records).toEqual([]);
  expect(swept).toBe(0);
  expect(rig.sent).toEqual([]);
  expect(rig.journal).toHaveLength(1);
  expect(rig.journal[0]).toMatchObject({ verdict: "refused", project: "", seatEpoch: null, delivery: null });
  expect(rig.journal[0]!.detail).toContain("no longer owns viewer traffic");
  /* The clock is genuinely stopped, not merely quiet: a start is accepted again
     rather than refused as a second one. */
  expect(startSeatTick(ports)).toBe(true);
});

test("the release that does own traffic sweeps every project it has an opinion about", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const records = await reconcileSeatTick({ ...rig.deps, ownsTraffic: () => true });
  expect(records.map((record) => record.project)).toEqual([PROJECT]);
  expect(records[0]!.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
});

/* An unauthorized sweep that crashed on its own journal would be a refusal
   nobody is left with — including the clock, which must still stop. */
test("an unwritable journal does not turn the lost-authority refusal into a crash", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const records = await reconcileSeatTick({
    ...rig.deps,
    ownsTraffic: () => false,
    appendRecord: () => { throw new Error("the journal is unwritable"); },
  });
  expect(records).toEqual([]);
  expect(rig.sent).toEqual([]);
});

test("the off switch keeps the clock unstarted and says so", () => {
  const refused: string[] = [];
  expect(startSeatTick({ policy: null, log: (line) => refused.push(line) })).toBe(false);
  expect(refused[0]).toContain("LLV_SEAT_TICK_CHECK_MINUTES=0");
});

test("a check that outran its interval drops the next tick rather than queueing it", async () => {
  let fire = () => {};
  let sweeps = 0;
  let release = () => {};
  startSeatTick({
    scheduleInterval: (callback) => { fire = callback; return { unref() {} } as never; },
    sweep: () => { sweeps += 1; return new Promise<void>((resolve) => { release = resolve; }); },
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
  });
  fire();
  fire();
  expect(sweeps).toBe(1);
  release();
  await Promise.resolve();
  await Promise.resolve();
  fire();
  expect(sweeps).toBe(2);
});


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

function promptSettings(): SeatTickSettings {
  return {
    ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: MONITOR_PROMPT,
    updatedAt: "2026-08-28T11:00:00.000Z",
    setBy: { kind: "manager", conversationId: CONVERSATION, project: PROJECT, seatEpoch: 7 },
  };
}

test("the wake the scheduler fires carries the project's own monitor prompt, check after check (#1280)", async () => {
  const settings = promptSettings();
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const firstRecord = await runSeatTickCheck(PROJECT, first.deps);
  expect(firstRecord).toMatchObject({ verdict: "wake" });
  expect(first.sent[0]!.text).toContain(MONITOR_PROMPT);
  /* Beside what the tick derived, not instead of it, and the contract still
     has the last word. */
  expect(first.sent[0]!.text).toContain("Items:");
  expect(first.sent[0]!.text).toContain("Contract:");
  expect(first.sent[0]!.text).not.toContain("Act on the listed items only");

  /* The next check reads the same row rather than any memory of the last wake,
     so an hour later the instruction is still on the wake. A prompt the seat
     re-typed into a schedule it made for itself lasted exactly one turn; this
     is the difference. */
  const second = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("a rotation hands the monitor prompt on: the successor's first wake carries it (#1280)", async () => {
  const settings = promptSettings();
  const before = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, before.deps);
  expect(before.sent[0]!.conversationId).toBe(CONVERSATION);

  /* A different seat, a later epoch: the row is the PROJECT's, so what the
     retired seat asked its monitor to watch is what the successor is woken
     with, rather than dying with the session that wrote it. */
  const after = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: OVERDUE,
    settings,
  });
  await runSeatTickCheck(PROJECT, after.deps);
  expect(after.sent[0]!.conversationId).toBe(SUCCESSOR);
  expect(after.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("a project with no monitor prompt is woken with exactly the message it was woken with before (#1280)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).not.toContain(PROMPT_HEADING);
  /* And a row that exists but carries no prompt is the same silence: an empty
     field is not a section with nothing in it. */
  const configured = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    settings: { ...promptSettings(), monitorPrompt: null },
  });
  await runSeatTickCheck(PROJECT, configured.deps);
  expect(configured.sent[0]!.text).toBe(rig.sent[0]!.text);
});

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

test("a prompt replaced while a wake is outstanding waits for original-key settlement (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: REPLACEMENT_PROMPT });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  expect(record.delivery!.outcome).toBe("deferred-outstanding");
  expect(layer.accepted).toHaveLength(1);
});

test("a prompt cleared while a wake is outstanding retains the original attempt (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: null });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  /* Withdrawn means withdrawn: the key is the one this wake would have had if
     the project had never set a prompt, and the text carries no note. */
  expect(record.delivery!.clientMessageId).toBe(outstanding.slice(0, outstanding.lastIndexOf(":prompt-")));
  expect(layer.accepted).toHaveLength(1);
});

test("an outstanding wake whose prompt has not changed stays under its original key (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, promptSettings());
  /* Same words, same key, same text: the layer sees the message it is already
     holding, and the seat is spared a second copy of one it may yet receive. */
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).toBe(outstanding);
  expect(layer.accepted.at(-1)!.text).toBe(layer.accepted[0]!.text);
});

test("a promptless wake keeps the exact client message id it had before the prompt existed (#1280)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  /* Nothing after the fingerprint: a project that never set a prompt is not
     paying for the field with a changed identity. */
  expect(record!.delivery!.clientMessageId).toBe(
    `seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:${rig.written.at(-1)!.lastWakeFingerprint}`);
});

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
    turn?: "busy" | "idle" | "terminal" | "unknown";
    terminalAt?: string | null;
    host?: AgentHostStatus | null;
    cwd?: string;
    parent?: string | null;
    memberships?: DurableMembershipInput[];
    /** No conversation record at all: a reservation nothing has settled. */
    unobserved?: boolean;
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
      /* Under a scanner root and on disk, the way a real spawn's transcript is
         (#1783): the harvest skips a child the Viewer cannot resolve. */
      const placement = options.transcript ?? "rooted";
      const childPath = path.join(placement === "outside-roots" ? dir : SESSIONS, `${crypto.randomUUID()}.jsonl`);
      if (placement !== "missing") fs.writeFileSync(childPath, "");
      const observedChild = options.unobserved ? null : registry.ensureConversation("claude", childPath, null);
      const parent = options.parent === undefined ? seatConversation.id : options.parent;
      const begun = registry.beginSpawnRequest({
        engine: "claude",
        cwd: childCwd,
        transport: "structured",
        ...(observedChild ? { conversationId: observedChild.id } : {}),
        ...(parent ? { parentConversationId: parent as never, parentSource: "explicit" } : {}),
        launchProfile: { title: options.title },
        ...(options.memberships ? { memberships: options.memberships } : {}),
      });
      const child = observedChild ?? { id: begun.receipt.conversationId, generations: [] };
      if (!options.unobserved) {
        registry.reconcileConversations([{
          engine: "claude",
          path: childPath,
          accountId: null,
          launchProfile: emptyLaunchProfile({ cwd: childCwd, title: options.title }),
          turn: { state: options.turn ?? "busy", source: "assistant", terminalAt: options.terminalAt ?? null },
          observedAt: new Date(now - 5 * MINUTE).toISOString(),
        }]);
      }
      if (options.host) {
        registry.upsert({
          key: sessionKeyFromTranscript("claude", childPath)!,
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
      if (!options.unobserved && (options.turn === "terminal" || options.turn === "idle")) {
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

/* The RED assertion this lane was cut for: a running child and nothing else is
   open work with an agenda, and the interval wake carries it. On the code
   before #1465 this check ended `proactive` — a proposal brief dispatched over
   a worker still running. */
test("a running spawned child with no lane is open work, and the interval wake names it (#1465)", async () => {
  const fixture = childFixture("running-child");
  const child = fixture.spawn({ title: "build the exporter", turn: "busy", host: "live" });
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });

  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1, deferred: 0 });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(rig.sent[0]!.text).toContain("build the exporter");
  /* A live turn the liveness plane calls running is not a stall, however long
     it has been open. */
  expect(rig.cards).toEqual([]);
  expect(rig.liveness).toEqual([{ conversationId: child.id }]);
});

test("a finished child is harvested by exactly one wake, across ticks, a fresh controller and a rotation (#1465)", async () => {
  const fixture = childFixture("finished-child");
  const child = fixture.spawn({ title: "review the exporter", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();

  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(record!.detail).toContain("a spawned child finished and its outcome is unharvested");
  expect(first.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(first.sent[0]!.text).toContain("review the exporter");
  /* The landing wrote the cursor: this child is now the seat's business. */
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().lastWakeAt).toBe(new Date(fixture.now).toISOString());

  /* Same controller, the interval elapsed again: nothing owed. */
  const later = fixture.now + 61 * MINUTE;
  const second = childRig(fixture, { now: later });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "quiet", items: 0 });
  expect(second.sent).toEqual([]);

  /* A fresh controller reading the row off disk. */
  const third = childRig(fixture, { now: later });
  expect(await runSeatTickCheck(fixture.project, third.deps)).toMatchObject({ verdict: "quiet" });
  expect(third.sent).toEqual([]);

  /* A rotation: the successor inherits the harvest cursor with the clock. */
  const rotated = childRig(fixture, { now: later, seat: { ...fixture.seat, seatEpoch: 8 } });
  expect(await runSeatTickCheck(fixture.project, rotated.deps)).toMatchObject({ verdict: "quiet", seatEpoch: 8 });
  expect(rotated.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ seatEpoch: 8 });
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a child whose host was released after a settled turn is finished, and harvested once (#1465)", async () => {
  const fixture = childFixture("unhosted-child");
  const child = fixture.spawn({ title: "draft the changelog", turn: "idle", host: "dead" });
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  /* No liveness read for a turn the registry says has settled. */
  expect(rig.liveness).toEqual([]);
});

test("a launch that failed before it ran is a terminal child with a failed outcome, harvested once (#1465)", async () => {
  const fixture = childFixture("failed-child");
  const child = fixture.spawn({ title: "build the exporter", unobserved: true });
  fixture.registry.failSpawn(child.launchId, "the host could not be started");
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(record!.detail).toContain("a spawned child failed");
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id} — build the exporter — spawned child failed, outcome unharvested`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const again = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, again.deps)).toMatchObject({ verdict: "quiet" });
});

test("more terminal children than the wake carries leave the rest owed, oldest harvested first (#1465)", async () => {
  const fixture = childFixture("bounded-harvest");
  const oldest = fixture.spawn({ title: "first worker", turn: "terminal", terminalAt: ago(fixture, 30) });
  const middle = fixture.spawn({ title: "second worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const newest = fixture.spawn({ title: "third worker", turn: "terminal", terminalAt: ago(fixture, 10) });
  fixture.seed();
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 1 };

  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, { ...first.deps, policy });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 2 });
  expect(first.sent[0]!.text).toContain(`[child] ${oldest.id}`);
  expect(first.sent[0]!.text).not.toContain(middle.id);
  expect(fixture.acknowledged()).toEqual([oldest.id]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  const next = await runSeatTickCheck(fixture.project, { ...second.deps, policy });
  expect(next).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 1 });
  expect(second.sent[0]!.text).toContain(`[child] ${middle.id}`);
  expect(new Set(fixture.acknowledged())).toEqual(new Set([oldest.id, middle.id]));

  const third = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...third.deps, policy });
  expect(third.sent[0]!.text).toContain(`[child] ${newest.id}`);
  expect(new Set(fixture.acknowledged())).toEqual(new Set([oldest.id, middle.id, newest.id]));
});

test("every owed child beyond the cursor cap is named once across landings and restarts (#1465)", async () => {
  const fixture = childFixture("harvest-capacity");
  const owed = Array.from({ length: 205 }, (_, index) => fixture.spawn({
    title: `worker ${index}`,
    turn: "terminal",
    terminalAt: ago(fixture, 300 - index),
  }));
  fixture.seed();
  let projectedRows = 0;
  const pageChildren = fixture.registry.pageSeatChildren.bind(fixture.registry);
  fixture.registry.pageSeatChildren = (...args) => {
    const page = pageChildren(...args);
    projectedRows += page?.keys.length ?? 0;
    return page;
  };
  const named: string[] = [];
  for (let tick = 0; tick < 45; tick += 1) {
    projectedRows = 0;
    // Each check constructs a fresh controller over the same durable row.
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE });
    await runSeatTickCheck(fixture.project, {
      ...rig.deps,
      policy: { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 5 },
    });
    expect(projectedRows).toBeLessThanOrEqual(60);
    expect(rig.snapshots).toBe(0);
    expect(rig.liveness.length).toBeLessThanOrEqual(60);
    for (const message of rig.sent) {
      for (const match of message.text.matchAll(/\[child\] (\S+) /g)) named.push(match[1]!);
    }
  }
  const unique = new Set(named);
  expect({ named: named.length, unique: unique.size, missing: owed.filter((child) => !unique.has(child.id)).length })
    .toEqual({ named: 205, unique: 205, missing: 0 });
}, 180_000);

test("a harvested child the seat re-instructs is owed again when it next finishes (#1465)", async () => {
  const fixture = childFixture("reinstructed-child");
  const child = fixture.spawn({ title: "iterate on the exporter", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The seat sent it more work: the turn is open again under a live host. */
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "iterate on the exporter" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: ago(fixture, 1),
  }]);
  fixture.registry.upsert({
    key: sessionKeyFromTranscript("claude", child.path)!,
    artifactPath: child.path,
    cwd: fixture.cwd,
    accountId: null,
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const running = childRig(fixture, { now: fixture.now + 61 * MINUTE, childActivity: { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  expect(await runSeatTickCheck(fixture.project, running.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.acknowledged()).toEqual([child.id]);

  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "iterate on the exporter" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(fixture.now + 90 * MINUTE).toISOString() },
    observedAt: new Date(fixture.now + 90 * MINUTE).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "reinstructed", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "reinstructed", status: "completed", seq: 4 });
  const finished = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, finished.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
});

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

test("a wake the record still holds is retained: no stamp moves and the row keeps it (#1465)", async () => {
  const fixture = childFixture("receipt-assigned");
  setAgentRegistryForTests(fixture.registry);
  const wake = recordedWake(fixture, { state: "assigned" });
  fixture.seed({ outstandingWake: wake, eventsThrough: 3 });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal.map((line) => line.verdict)).toEqual([record!.verdict]);
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61), eventsThrough: 3, harvestedChildren: [] });
});

test("a wake the record says was delivered lands, on the plan the raising check wrote (#1465)", async () => {
  const fixture = childFixture("receipt-delivered");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "delivered", children: [child.id] });
  fixture.seed({ outstandingWake: wake, eventsThrough: 1 });
  const rig = childRig(fixture, { realWakeState: true });
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
  expect(fixture.row()).toMatchObject({
    outstandingWake: null,
    lastWakeAt: new Date(fixture.now).toISOString(),
    eventsThrough: 3,
    harvestedChildren: [],
  });
  expect(fixture.acknowledged()).toContain(child.id);
  /* The landing credited the harvest, so the same check has nothing to raise. */
  expect(rig.sent).toEqual([]);
});

test("a wake the record proves was never delivered is dropped, and raised again in the same check (#1465)", async () => {
  const fixture = childFixture("receipt-lost");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "lost", children: [child.id] });
  fixture.seed({ outstandingWake: wake });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "dropped" });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(rig.sent).toHaveLength(1);
  expect(fixture.row()).toMatchObject({ outstandingWake: null });
  expect(fixture.acknowledged()).toContain(child.id);
});

/* A terminal receipt the host ended without verifying — it took the message
   and died — is missing evidence, not proof of loss (#1465). The attempt keeps
   its key: nothing it carried is acknowledged, no wake replaces it under any
   key, and neither the deadline nor a re-designation of the same conversation
   changes that. What changes is that the board says so, once, the moment it is
   seen, because no evidence will settle this on its own — and that the fence
   it holds is bounded (#1746): spent, the attempt is retired unresolved and
   the obligations it named are re-derived into a wake that does go out. */
test("a wake the record ended without proof keeps its identity inside its bound, carded once and never replaced, and is retired unresolved past it (#1465, #1746)", async () => {
  const fixture = childFixture("receipt-unverified");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "unverified", children: [child.id] });
  fixture.seed({ outstandingWake: wake, eventsThrough: 1 });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "uncertain", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
  expect(rig.journal[0]!.detail).toContain("no wake replaces it");
  /* Nothing credited, nothing replaced, and the board carries it now. */
  expect(fixture.row()).toMatchObject({ outstandingWake: { ...wake, preparedAt: new Date(fixture.now).toISOString() }, lastWakeAt: ago(fixture, 61), eventsThrough: 1, harvestedChildren: [] });
  expect(fixture.acknowledged()).toEqual([]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { clientMessageId: expect.not.stringMatching(wake.clientMessageId), outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(rig.cards.map((entry) => entry.card)).toMatchObject([{ ref: seatTickWakeUnresolvedRef(wake.clientMessageId), kind: "wake-unresolved", instance: wake.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain('last answered "uncertain"');
  expect(rig.cards[0]!.card.detail).toContain("dispatches no replacement wake");

  /* Past the wake interval, and past a re-designation of the SAME conversation
     at a higher epoch — one seat, so no supersession (#1594) — with the first
     send's fate still unknown and its own bound not yet spent: the same key, no
     send under any key, nothing acknowledged. The bound is two wake intervals
     and never under an hour, so a check at 61 and at 119 minutes is inside it. */
  for (const [minutes, seat] of [[61, fixture.seat], [119, { ...fixture.seat, seatEpoch: 8 }]] as const) {
    const later = childRig(fixture, { realWakeState: true, now: fixture.now + minutes * MINUTE, seat });
    const deferred = await runSeatTickCheck(fixture.project, later.deps);
    expect(later.sent).toEqual([]);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: wake.clientMessageId, seatEpoch: 7 });
    expect(fixture.row().lastWakeAt).toBe(ago(fixture, 61));
    expect(fixture.acknowledged()).toEqual([]);
    /* And the deferral says why it is mute: which key holds the project's
       wakes, since when, and when that ends on its own (#1746). */
    expect(deferred!.detail).toContain(`fenced by the wake prepared ${new Date(fixture.now).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(deferred!.detail).toContain(`under key ${wake.clientMessageId}`);
    expect(deferred!.detail).toContain(`the fence lapses at ${new Date(fixture.now + 120 * MINUTE).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    /* One occurrence, one card: the board's create receipt collapses the rest. */
    expect(later.cards.map((entry) => entry.card.instance)).toEqual([wake.clientMessageId]);
  }

  /* The bound spent, with the record still unable to prove anything either way:
     the attempt is retired unresolved — same key, never re-sent, crediting
     nothing — and the same check derives its own wake from the obligations it
     named and delivers it (#1746). */
  const past = childRig(fixture, { realWakeState: true, now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  const woken = await runSeatTickCheck(fixture.project, past.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(past.sent).toHaveLength(1);
  expect(past.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(past.sent[0]!.text).toContain(`[child] ${child.id}`);
  const retirement = past.journal.find((line) => line.verdict === "retired")!;
  expect(retirement).toMatchObject({ delivery: { clientMessageId: wake.clientMessageId } });
  expect(retirement.detail).toContain("retired unresolved on its age bound");
  expect(retirement.detail).toContain("never re-sent");
  expect(retirement.detail).toContain("credits nothing");
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId }, supersededBy: null, reason: "unresolved-age" }]);
  /* The obligation reappeared in the wake that went out, and was credited
     exactly once — by that wake, not by the attempt that was retired. */
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* And when the holder finally answers for the retired attempt, the answer
     credits nothing: the check that retired it already re-derived what it
     named, and crediting both would acknowledge the same obligation twice. */
  const settled = childRig(fixture, { realWakeState: true, now: fixture.now + 260 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, { ...settled.deps, sources: { ...settled.deps.sources!, wakeState: async () => "landed" } });
  const landing = settled.journal.find((line) => line.verdict === "landed")!;
  expect(landing.detail).toContain("retired unresolved on its age bound was delivered after all");
  expect(landing.detail).toContain("nothing it carried is credited");
  expect(fixture.row().retiredWakes).toEqual([]);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

/* An attempt no holder can account for — absent record, no runtime operation,
   or a record nobody can read — is kept under its key while its own bound
   runs (#1465). One wake interval is not permission to redeliver: the wait goes
   on the board, and that is all that changes. Two of them is (#1746): a fence
   nothing can ever settle is retired unresolved, and the tick starts again. */
test("a wake nobody can account for is kept under its key past the deadline and carded once, until its bound is spent (#1465, #1746)", async () => {
  const fixture = childFixture("receipt-aged-unknown");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  /* A send that once held an operation: absent beside a handle is unknown. */
  const wake = recordedWake(fixture, { state: "none", operationId: "op-compacted-1" });
  fixture.seed({ outstandingWake: wake });
  const first = childRig(fixture, { realWakeState: true });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(fixture.row().outstandingWake).toEqual({ ...wake, preparedAt: new Date(fixture.now).toISOString() });
  expect(first.cards).toEqual([]);
  expect(first.sent).toEqual([]);
  const within = childRig(fixture, { realWakeState: true, now: fixture.now + 30 * MINUTE });
  await runSeatTickCheck(fixture.project, within.deps);
  expect(within.cards).toEqual([]);
  expect(within.sent).toEqual([]);

  const aged = childRig(fixture, { realWakeState: true, now: fixture.now + 61 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, aged.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(aged.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(aged.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: { clientMessageId: wake.clientMessageId, operationId: "op-compacted-1" }, lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(fixture.acknowledged()).toEqual([]);
  expect(aged.cards.map((entry) => entry.card)).toMatchObject([{ ref: seatTickWakeUnresolvedRef(wake.clientMessageId), instance: wake.clientMessageId }]);
  expect(aged.cards[0]!.card.detail).toContain('last answered "unknown"');
  /* A holder that cannot be read at all is the same wait, said the same way —
     and a read that proves nothing is exactly what the bound is for. Two wake
     intervals after the attempt was prepared it is retired unresolved on its
     age, the board says so, and this project's wakes flow again (#1746). */
  const unreadable = childRig(fixture, { realWakeState: true, now: fixture.now + 122 * MINUTE });
  const woken = await runSeatTickCheck(fixture.project, { ...unreadable.deps, sources: { ...unreadable.deps.sources!, wakeState: async () => { throw new Error("the delivery record could not be read"); } } });
  expect(unreadable.cards[0]!.card.detail).toContain("could not be read");
  expect(unreadable.cards[0]!.card.detail).toContain("retired unresolved on its age bound");
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId }, supersededBy: null, reason: "unresolved-age" }]);
  expect(woken).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(unreadable.sent).toHaveLength(1);
  expect(unreadable.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);

  /* And the next check does not put a second wake beside the first: the wake
     that went out landed, so there is nothing owed and nothing prepared. */
  const after = childRig(fixture, { realWakeState: true, now: fixture.now + 127 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...after.deps, sources: { ...after.deps.sources!, wakeState: async () => { throw new Error("the delivery record could not be read"); } } });
  expect(after.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toBeNull();
});

/* The `uncertain` line these endings write has to survive the journal it is
   written to: a verdict the reader does not know is a line nobody can read
   back, and the journal is the audit trail the operator is pointed at. */
test("an uncertain journal line reads back from the seat tick journal (#1465)", () => {
  const file = path.join(fs.mkdtempSync(path.join(SANDBOX, "journal-")), "runs.ndjson");
  const record: SeatTickRunRecord = {
    schemaVersion: 1, at: new Date(NOW).toISOString(), project: PROJECT, seatEpoch: 7, verdict: "uncertain", reasons: [], items: 0, deferred: 0,
    eventsThrough: 3, delivery: { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", outcome: "unresolved" }, detail: "ended unverified",
  };
  appendSeatTickRecord(record, file);
  expect(readSeatTickRecords(10, file)).toEqual([record]);
});

test("a wake the record has no trace of is unknown, and a different wake waits behind it (#1465)", async () => {
  const fixture = childFixture("receipt-absent");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "none", operationId: null });
  fixture.seed({ outstandingWake: wake });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61) });
});

test("a registry that cannot be read fails the check outright, and moves nothing (#1465)", async () => {
  const fixture = childFixture("receipt-unreadable");
  setAgentRegistryForTests(fixture.registry);
  const wake = recordedWake(fixture, { state: "assigned" });
  fixture.seed({ outstandingWake: wake });
  fixture.registry.seatTickConversation = () => { throw new Error("registry unavailable"); };
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  /* The seat's own turn is read off the same registry, so the whole check
     ends as an error line: no wake, no stamp, and the row keeps the wake. */
  expect(record).toMatchObject({ verdict: "error", delivery: null });
  expect(record!.detail).toContain("the check failed");
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61) });
  expect(rig.sent).toEqual([]);
});

test("a snapshot that cannot be taken leaves the children unread: a wake names the gap, and nothing else owed is an error (#1465)", async () => {
  const fixture = childFixture("children-unreadable");
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture);
  const registry = fixture.registry;
  const blind = {
    ...rig.deps.sources!,
    registry: () => ({
      seatTickConversation: registry.seatTickConversation.bind(registry),
            conversation: (id: string) => registry.conversation(id as never),
      conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
      readOnlySnapshot: () => { throw new Error("the registry snapshot is being rewritten"); },
    }) as never,
  };
  const record = await runSeatTickCheck(fixture.project, { ...rig.deps, sources: blind });
  expect(record).toMatchObject({ verdict: "error" });
  expect(record!.detail).toBe("the seat's spawned children could not be read (registry-unreadable): the registry read failed, so nothing owed is not established");
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(rig.sent).toEqual([]);

  /* A reason that stands on its own still wakes, and the wake names the gap. */
  const withCard = childRig(fixture, { tasks: [{ id: "task_c2", status: "assigned" }] });
  const cardSources = { ...withCard.deps.sources!, registry: blind.registry, tasks: () => [{ id: "task_c2", project: fixture.project, status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: ago(fixture, 30), updatedAt: ago(fixture, 30) }] as never };
  const woken = await runSeatTickCheck(fixture.project, { ...withCard.deps, sources: cardSources });
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["unstarted-task"] });
  expect(woken!.detail).toContain("the seat's spawned children could not be read (registry-unreadable)");
  expect(withCard.sent[0]!.text).toContain("registry-unreadable");
});

test("an absorbing refusal that names an operation is recorded outstanding under it (#1465)", async () => {
  const fixture = childFixture("absorbing-refusal");
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    delivery: { ok: false, outcome: "failed", error: "an earlier attempt began actuating", status: 409, actuation: "started", operationId: "op-absorbed-1", resend: "verify-first" },
    wakeState: "retained",
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(fixture.row().outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    operationId: "op-absorbed-1",
    commit: { reasons: ["child-terminal"], children: [outcomeIdentity(["claude", fixture.registry.conversation(child.id as never)!.generations[0]!.id, "turn-one"])] },
  });
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
});

test("a send that never returned is looked up under its own key, and kept outstanding when the record holds it (#1465)", async () => {
  const fixture = childFixture("send-threw-reserved");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    deliverWith: async (message) => {
      /* The layer reserved the key and queued the runtime operation, then the
         control channel died before the answer came back. */
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, { operationId: "op-unreturned-1", kind: "send", policy: "queue" });
      throw new Error("Viewer control did not reconnect after 2 attempts");
    },
    realWakeState: true,
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row().outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    operationId: null,
    commit: { children: [outcomeIdentity(["claude", fixture.registry.conversation(child.id as never)!.generations[0]!.id, "turn-one"])] },
  });
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  /* The next check asks the record: still assigned, so still retained, and
     the same wake is not dispatched a second time under a fresh key. */
  const next = childRig(fixture, { realWakeState: true, deliveryThrows: true });
  const again = await runSeatTickCheck(fixture.project, next.deps);
  expect(again!.delivery!.clientMessageId).toBe(record!.delivery!.clientMessageId);
  expect(next.sent).toHaveLength(0);
});

test("a send that never returned and left no record retains its original prepared attempt (#1465)", async () => {
  const fixture = childFixture("send-threw-absent");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { deliveryThrows: true, realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row()).toMatchObject({ outstandingWake: { clientMessageId: record!.delivery!.clientMessageId }, lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(rig.journal).toHaveLength(1);
});

test("a send that never returned with an unreadable record is kept outstanding without a handle (#1465)", async () => {
  const fixture = childFixture("send-threw-unreadable");
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { deliveryThrows: true });
  const record = await runSeatTickCheck(fixture.project, {
    ...rig.deps,
    sources: { ...rig.deps.sources!, originalSend: async () => ({ kind: "unreadable", reason: "the delivery record could not be read" }) },
  });
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId, operationId: null });
});

test("a child finishing while a wake is unresolved dispatches nothing, and is harvested by the wake after the landing (#1465)", async () => {
  const fixture = childFixture("child-finishes-mid-flight");
  const child = fixture.spawn({ title: "long worker", turn: "busy", host: "live" });
  fixture.seed();
  const activity: Record<string, Partial<AgentLivenessRecord>> = { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } };
  const first = childRig(fixture, {
    childActivity: activity,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-flight-1", receipt: {} as never, structured: true },
    wakeState: "retained",
  });
  const raised = await runSeatTickCheck(fixture.project, first.deps);
  expect(raised).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().outstandingWake).toMatchObject({ operationId: "op-flight-1", commit: { children: [] } });

  /* The child finishes while the runtime still holds the interval wake. */
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "long worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 1) },
    observedAt: ago(fixture, 1),
  }]);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-one", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
  const second = childRig(fixture, { wakeState: "retained" });
  const withheld = await runSeatTickCheck(fixture.project, second.deps);
  expect(withheld).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "deferred-outstanding" } });
  expect(second.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: { operationId: "op-flight-1" }, harvestedChildren: [] });

  /* The holder delivers the first wake: it lands, and it credited no harvest. */
  const third = childRig(fixture, { wakeState: "landed" });
  expect(await runSeatTickCheck(fixture.project, third.deps)).toMatchObject({ verdict: "quiet" });
  expect(third.journal[0]).toMatchObject({ verdict: "landed" });
  expect(fixture.row()).toMatchObject({ outstandingWake: null, harvestedChildren: [] });

  /* The next interval carries the child. */
  const fourth = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, fourth.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fourth.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

/* ------------------------------------------------------------------------- *
 * What is NOT this seat's to wake on (#1465).
 * ------------------------------------------------------------------------- */

test("cross-project, pipeline-owned, engine-native and unrelated conversations add nothing (#1465)", async () => {
  const fixture = childFixture("exclusions");
  const elsewhere = path.join(fixture.dir, "other-repo");
  fs.mkdirSync(elsewhere);
  fixture.spawn({ title: "another project's worker", turn: "terminal", terminalAt: ago(fixture, 20), cwd: elsewhere });
  fixture.spawn({
    title: "a pipeline stage",
    turn: "terminal",
    terminalAt: ago(fixture, 20),
    memberships: [{ kind: "pipeline", containerId: "pipeline_x1", role: "builder", slot: "build", stageId: "build", stageOrder: 1, round: 1, parentConversationId: fixture.seat.conversationId as never }],
  });
  /* An engine-native edge: the engine itself recorded the parent, no Viewer
     spawn was ever asked for. */
  const nativePath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  fixture.registry.ensureConversation("claude", nativePath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: nativePath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "a native fork", parentConversationId: fixture.seat.conversationId as never }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 20) },
    observedAt: ago(fixture, 20),
  }]);
  const edges = Object.values(fixture.registry.readOnlySnapshot().lineageEdges);
  expect(edges.some((edge) => edge.source === "engine-native")).toBe(true);
  /* A conversation started by hand, with no edge at all. */
  const manualPath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  fixture.registry.ensureConversation("claude", manualPath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: manualPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "started by hand" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 20) },
    observedAt: ago(fixture, 20),
  }]);
  /* A child of another seat entirely. */
  const otherSeat = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "another seat's worker", turn: "terminal", terminalAt: ago(fixture, 20), parent: otherSeat.id });
  fixture.seed();

  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "the board is done and the proposal slot is not due" });
  expect(rig.sent).toEqual([]);
  expect(rig.liveness).toEqual([]);
});

test("a child the registry cannot place is unknown: not open work, not harvested, and said so (#1465)", async () => {
  const fixture = childFixture("unknown-child");
  fixture.spawn({ title: "a reservation nothing settled", unobserved: true });
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "error" });
  expect(record!.detail).toContain("(child-unplaced): a child has no conversation record");
  expect(rig.sent).toEqual([]);
  expect(fixture.acknowledged()).toEqual([]);
  /* The condition is a run of its own, and outliving the wake interval puts it
     on the board once with its own clause (#1465). */
  expect(fixture.row().childrenGap).toMatchObject({ gap: "child-unplaced", attempts: 1, reported: false });
  const standing = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, standing.deps);
  expect(standing.cards.map((entry) => entry.card)).toMatchObject([{ ref: "seat-tick-source-children", kind: "source-unreadable", instance: fixture.row().childrenGap!.since }]);
  expect(standing.cards[0]!.card.detail).toContain("child-unplaced, 2 attempt(s)");
  expect(fixture.row().childrenGap).toMatchObject({ reported: true });
  const quiet = childRig(fixture, { now: fixture.now + 66 * MINUTE });
  await runSeatTickCheck(fixture.project, quiet.deps);
  expect(quiet.cards).toEqual([]);
});

test("a cold inbox with no children stays quiet, and no heartbeat card is needed (#1465)", async () => {
  const fixture = childFixture("cold-inbox");
  fixture.seed();
  const rig = childRig(fixture, { tasks: [{ id: "task_c1", status: "inbox" }] });
  /* The harness's cards belong to the default project; a seat with an inbox
     card and no child of its own has an empty agenda either way. */
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toEqual([]);
});

test("a busy child whose host is gone is a stall the registry can see, reported after a second check (#1465)", async () => {
  const fixture = childFixture("gone-child");
  const child = fixture.spawn({ title: "worker whose host died", turn: "busy", host: "dead" });
  fixture.seed();
  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  /* Open work, so the interval wakes; the stall waits for its second check. */
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(first.liveness).toEqual([]);
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  const stalled = await runSeatTickCheck(fixture.project, second.deps);
  expect(stalled).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(stalled!.detail).toContain("host_gone_turn_open");
  expect(second.sent[0]!.text).toContain(`[child] ${child.id}`);
});

test("the projection uses bounded keyed registry reads and targeted liveness without transcripts (#1465)", async () => {
  const fixture = childFixture("bounded-read");
  const busy = fixture.spawn({ title: "busy worker", turn: "busy", host: "live" });
  const idle = fixture.spawn({ title: "idle worker", turn: "idle", host: "live" });
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [busy.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 3 });
  /* The child source uses keyed projections without a registry snapshot. */
  expect(rig.snapshots).toBe(0);
  /* Liveness is asked by id, for the one child whose turn is open, and never
     project-wide: there is no lane to sweep for. */
  expect(rig.liveness).toEqual([{ conversationId: busy.id }]);
  expect(rig.liveness.some((read) => read.project)).toBe(false);
  /* The fixture's transcripts exist, so the harvest can resolve them (#1783),
     and they are empty: nothing here read a byte of transcript CONTENT. */
  expect(fs.statSync(busy.path).size).toBe(0);
  expect(fs.statSync(idle.path).size).toBe(0);
});

test("two later turns between ticks are separately owed across controller replacement and seat rotation (#1465)", async () => {
  const fixture = childFixture("multiple-turns");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture);
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });
  ledger.append(generation, { kind: "turn-started", turnId: "turn-three", seq: 5 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-three", status: "error", seq: 6 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  const result = await runSeatTickCheck(fixture.project, next.deps);
  /* Two later turns of ONE child are one line since #1783, described by the
     latest of them — and the line still stands for both, so both are
     acknowledged by its landing and neither is offered again. */
  expect(result).toMatchObject({ verdict: "wake", items: 1 });
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const outcomes = accounting.collection.snapshot().filter((row) => row.kind === "outcome");
  expect(outcomes).toHaveLength(3);
  expect(outcomes.every((row) => row.status === "acknowledged")).toBe(true);
  expect(new Set(outcomes.map((row) => row.identity)).size).toBe(3);
  const again = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  await runSeatTickCheck(fixture.project, again.deps);
  expect(again.sent).toHaveLength(0);
});

test("a new turn discovered during an unknown send remains owed under the original wake fence (#1465)", async () => {
  const fixture = childFixture("unknown-send-turn");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture, { deliveryThrows: true, wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  const outstanding = fixture.row().outstandingWake!;
  expect(outstanding.text).toBe(first.sent[0]!.text);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "next-turn", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "next-turn", status: "completed", seq: 4 });
  /* Past the wake interval, an unaccounted, unverified or retained attempt
     keeps its fence: no send under any key, no acknowledgment, the same key. */
  for (const wakeState of ["unknown", "uncertain", "retained"] as const) {
    const next = childRig(fixture, { now: fixture.now + 61 * MINUTE, wakeState });
    await runSeatTickCheck(fixture.project, next.deps);
    expect(next.sent).toHaveLength(0);
    expect(fixture.row().outstandingWake!.clientMessageId).toBe(outstanding.clientMessageId);
    expect(fixture.acknowledged()).toEqual([]);
  }
  await runSeatTickCheck(fixture.project, childRig(fixture, { now: fixture.now + 61 * MINUTE, wakeState: "landed" }).deps);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const final = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, final.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
});

test("an old child finishing behind a completed discovery sweep remains owed (#1465)", async () => {
  const fixture = childFixture("out-of-order");
  const old = fixture.spawn({ title: "slow worker", turn: "busy", host: "live" });
  fixture.spawn({ title: "fast worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  const generation = fixture.registry.conversation(old.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "late-turn", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "late-turn", status: "completed", seq: 2 });
  const later = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, later.deps);
  expect(later.sent[0]!.text).toContain(old.id);
  expect(fixture.acknowledged()).toContain(old.id);
});

test("concurrent controllers prepare one original wake and stale state cannot overwrite its landing (#1465)", async () => {
  const fixture = childFixture("concurrent-checks");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  let release!: () => void;
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = childRig(fixture, { deliverWith: async () => {
    admitted(); await held;
    return { ok: true, target: "structured", outcome: "delivered", structured: true };
  } });
  const pending = runSeatTickCheck(fixture.project, first.deps);
  await started;
  const prepared = fixture.row();
  expect(prepared.outstandingWake?.text).toBe(first.sent[0]!.text);
  const second = childRig(fixture, { wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, second.deps);
  expect(second.sent).toEqual([]);
  release(); await pending;
  expect(first.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(() => writeSeatTickState(fixture.project, prepared, fixture.stateFile)).toThrow("stale");
  expect(fixture.row().outstandingWake).toBeNull();
});

/* A predecessor's attempt whose fate is unknown or unverified stays the
   predecessor's attempt (#1465): a rotation is not evidence about a payload,
   so the successor is not woken over it and no wake replaces it. The wait is
   carded once it has outlived the wake interval, and only landed evidence
   settles it — acknowledging what it named exactly once. */
test("rotation and prompt changes retain an unknown predecessor wake across the deadline until proven landing (#1465)", async () => {
  const fixture = childFixture("unknown-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture, { deliveryThrows: true, wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, first.deps);
  const original = fixture.row().outstandingWake!;
  expect(original.preparedAt).toBe(new Date(fixture.now).toISOString());
  const rotated = childRig(fixture, { now: fixture.now + 61 * MINUTE,
    seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "uncertain", withdrawal: "unknown",
    settings: { ...defaultSeatTickSettings(fixture.project), monitorPrompt: "Inspect the implementation evidence." } });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(rotated.sent).toHaveLength(0);
  expect(rotated.journal[0]).toMatchObject({ verdict: "uncertain", seatEpoch: 7, delivery: { clientMessageId: original.clientMessageId, outcome: "uncertain" } });
  expect(fixture.row().outstandingWake).toEqual(original);
  expect(fixture.row().lastWakeAt).toBe(ago(fixture, 61));
  expect(rotated.cards.map((entry) => entry.card)).toMatchObject([{ ref: seatTickWakeUnresolvedRef(original.clientMessageId), instance: original.clientMessageId }]);
  expect(rotated.cards[0]!.card.detail).toContain("a seat that has since been replaced");
  const stillUnknown = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "unknown", withdrawal: "unknown" });
  await runSeatTickCheck(fixture.project, stillUnknown.deps);
  expect(stillUnknown.sent).toHaveLength(0);
  expect(stillUnknown.journal[0]).toMatchObject({ verdict: "revoked", delivery: { outcome: "unknown" } });
  expect(fixture.row().outstandingWake).toEqual(original);
  expect(fixture.acknowledged()).toEqual([]);
  const landed = childRig(fixture, { now: fixture.now + 183 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, landed.deps);
  expect(landed.sent).toHaveLength(0);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().outstandingWake).toBeNull();
});

test("first tick after rotation discovers predecessor children from committed revocations only (#1465)", async () => {
  const fixture = childFixture("predecessor-discovery");
  const old = fixture.spawn({ title: "predecessor worker", turn: "terminal" });
  const abandoned = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "abandoned pending seat worker", turn: "terminal", parent: abandoned.id });
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.seed();
  const file = statePath("orchestrator-seats.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 9, seats: {}, pending: {},
      revocations: [{ project: fixture.project, conversationId: fixture.seat.conversationId, seatEpoch: 7,
        revokedAt: new Date(fixture.now).toISOString(), successorConversationId: successor.id }],
      history: [{ seat: { project: fixture.project, conversationId: abandoned.id, seatEpoch: 6, state: "pending" }, reason: "terminal_error" }],
    }));
    const sent: ConversationMessage[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE, seat: { conversationId: successor.id, seatEpoch: 8, path: null } });
      await runSeatTickCheck(fixture.project, rig.deps);
      sent.push(...rig.sent);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(old.id);
    expect(fixture.acknowledged()).toEqual([old.id]);
  } finally { if (before) fs.writeFileSync(file, before); else fs.unlinkSync(file); }
});

test("a child in a deleted nested worktree keeps its parent project's harvest obligation (#1465)", async () => {
  const fixture = childFixture("deleted-worktree", true);
  const deletedCwd = path.join(fixture.cwd, ".worktrees", "finished-task");
  expect(fs.existsSync(deletedCwd)).toBe(false);
  const child = fixture.spawn({ title: "worktree worker", turn: "terminal", cwd: deletedCwd });
  fixture.seed();
  const rig = childRig(fixture);
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a settled child with an idle retained host is announced once and leaves no running agenda (#1465)", async () => {
  const fixture = childFixture("settled-idle-host");
  const child = fixture.spawn({ title: "settled worker", turn: "idle", host: "idle" });
  fixture.seed();
  const first = childRig(fixture);
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id]);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
});


test("a child inserted behind the discovery cursor is found on the next sweep after rotation (#1465)", async () => {
  const fixture = childFixture("insert-behind");
  for (let n = 0; n < 21; n++) fixture.spawn({ title: `initial ${n}`, turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  const added = fixture.spawn({ title: "inserted behind", turn: "terminal" });
  const db = new Database(path.join(fixture.dir, "agent-registry.sqlite"));
  db.query("UPDATE registry_rows SET row_key=? WHERE collection='lineageEdges' AND row_key=?").run("!behind", added.id);
  db.close();
  const sent: ConversationMessage[] = [];
  for (let tick = 1; tick < 18; tick++) {
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
    await runSeatTickCheck(fixture.project, rig.deps);
    sent.push(...rig.sent);
  }
  expect(fixture.acknowledged().filter((id) => id === added.id)).toHaveLength(1);
  expect(sent.filter((message) => message.text.includes(added.id))).toHaveLength(1);
}, 60000);

test("ambiguous legacy outcomes rotate behind later proven work and later turns remain owed (#1465)", async () => {
  const fixture = childFixture("legacy-fairness");
  const old = fixture.spawn({ title: "legacy worker", turn: "terminal" });
  const fresh = fixture.spawn({ title: "new worker", turn: "terminal" });
  fs.writeFileSync(fixture.stateFile, JSON.stringify({ version: 2, projects: { [fixture.project]: {
    ...emptySeatTickState(), seatEpoch: 7, harvestedChildren: [old.id],
    lastWakeAt: new Date(fixture.now - 61 * MINUTE).toISOString(), lastProposalAt: new Date(fixture.now).toISOString(),
  } } }));
  const first = childRig(fixture);
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  expect(first.sent[0]!.text).toContain(fresh.id);
  expect(first.sent[0]!.text).not.toContain(old.id);
  const generation = fixture.registry.conversation(old.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "after-migration", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "after-migration", status: "completed", seq: 4 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.text).toContain(old.id);
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const held = accounting.collection.snapshot().filter((row) => row.kind === "outcome" && row.gap === "legacy-delivery-ambiguous");
  expect(held).toHaveLength(1);
  expect(held[0]!.kind === "outcome" && held[0]!.status).toBe("owed");
});


test("rotation after durable prepare and before transport releases the proven unsent attempt (#1465)", async () => {
  const fixture = childFixture("prepare-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const rig = childRig(fixture);
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.seatFor = (project) => fixture.row().outstandingWake
    ? { ...seatFor(project), active: null } : seatFor(project);
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.acknowledged()).toEqual([]);
  const successor = childRig(fixture, { seat: { ...fixture.seat, seatEpoch: 8 } });
  await runSeatTickCheck(fixture.project, successor.deps);
  expect(successor.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});


test("successive completed turns change the retry-guard fingerprint without a sampled running state (#1465)", async () => {
  const fixture = childFixture("turn-retry-guard");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal" });
  fixture.seed();
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  for (let turn = 1; turn <= 5; turn++) {
    if (turn > 1) {
      ledger.append(generation, { kind: "turn-started", turnId: `iteration-${turn}`, seq: turn * 2 - 1 });
      ledger.append(generation, { kind: "turn-ended", turnId: `iteration-${turn}`, status: "completed", seq: turn * 2 });
    }
    const rig = childRig(fixture, { now: fixture.now + (turn - 1) * 61 * MINUTE });
    expect(await runSeatTickCheck(fixture.project, rig.deps)).toMatchObject({ verdict: "wake", items: 1 });
    expect(rig.sent).toHaveLength(1);
  }
  expect(fixture.acknowledged()).toHaveLength(5);
});


/* ------------------------------------------------------------------------- *
 * Production-shaped ledgers, fair observation, and the conditions a check
 * cannot account for (#1465, second review round).
 * ------------------------------------------------------------------------- */

/* Real child ledgers are megabytes of delta text around a handful of turn
   boundaries. The reader has to reach a child's terminal record within the
   check that follows it, not hours of thirty-kilobyte visits later. */
test("a child whose ledger is a production-sized ten megabytes of deltas is harvested by the next check (#1465)", async () => {
  const fixture = childFixture("large-ledger");
  const child = fixture.spawn({ title: "verbose worker", turn: "busy", host: "live" });
  fixture.seed();
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const lines: string[] = [JSON.stringify({ kind: "turn-started", turnId: "long-turn", seq: 1 })];
  let seq = 1;
  let bytes = 0;
  while (bytes < 10 * 1024 * 1024) {
    const line = JSON.stringify({ kind: "delta", turnId: "long-turn", text: "x".repeat(200 + (seq % 100)), seq: ++seq });
    lines.push(line);
    bytes += line.length + 1;
  }
  lines.push(JSON.stringify({ kind: "turn-ended", turnId: "long-turn", status: "completed", seq: ++seq }));
  const ledgerDir = statePath("structured-host-events");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, `${encodeURIComponent(generation)}.jsonl`), `${lines.join("\n")}\n`);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "verbose worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 1) },
    observedAt: ago(fixture, 1),
  }]);
  const started = performance.now();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  const elapsed = performance.now() - started;
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const source = accounting.collection.snapshot().find((row) => row.kind === "source");
  expect(source?.kind === "source" && source.cursor).toMatchObject({ atEnd: true, seq, settledThrough: seq, gap: null });
  expect(elapsed).toBeLessThan(5_000);
  console.log(`[ledger] ${bytes} bytes harvested in one check in ${elapsed.toFixed(0)} ms`);
});

/* Running children are observed through a rotating window, so a stall on a
   child beyond the eighth is seen on two consecutive checks and reported —
   the fixed identity-ordered eight this replaces never observed it. */
test("a stall on the twelfth of twelve running children is reported within two sweeps of it entering the window (#1465)", async () => {
  const fixture = childFixture("twelve-running");
  const children = Array.from({ length: 12 }, (_, index) => fixture.spawn({ title: `worker ${index + 1}`, turn: "busy", host: "live" }));
  // Discovery starts the running queue in insertion order.
  const ids = children.map((child) => child.id);
  const twelfth = children.find((child) => child.id === ids[11])!;
  fixture.seed();
  const activity: Record<string, Partial<AgentLivenessRecord>> = Object.fromEntries(children.map((child) => [child.id, { lifecycle: "running", reason: "host_alive_turn_active" }]));
  activity[twelfth.id] = { lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" };

  const first = childRig(fixture, { childActivity: activity });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(first.liveness.map((read) => read.conversationId)).toEqual(ids.slice(0, 8));
  expect(fixture.row().stalledSeen).toEqual([]);

  const second = childRig(fixture, { childActivity: activity, now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(second.liveness.map((read) => read.conversationId)).toEqual(ids.slice(4, 12));
  expect(fixture.row().stalledSeen).toEqual([`child:${twelfth.id}`]);

  const third = childRig(fixture, { childActivity: activity, now: fixture.now + 122 * MINUTE });
  const stalled = await runSeatTickCheck(fixture.project, third.deps);
  expect(third.liveness.map((read) => read.conversationId)).toEqual([...ids.slice(8, 12), ...ids.slice(0, 4)]);
  expect(stalled).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(stalled!.detail).toContain(`child ${twelfth.id} runs a turn the registry reports stalled (host_alive_transcript_silent)`);
  expect(third.sent[0]!.text).toContain(`[child] ${twelfth.id}`);
  /* Every check observed a bounded window and asked liveness for it alone. */
  for (const rig of [first, second, third]) expect(rig.liveness).toHaveLength(8);
});

/* A registry without an indexed lineage projection reads the seat and names
   the children as unindexed; the check does not fail (#1465). */
test("a JSON-mode registry leaves the seat readable and reports the children as unindexed (#1465)", async () => {
  const fixture = childFixture("json-registry", false, "off");
  fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const rig = childRig(fixture, { tasks: [{ id: "task_j1", status: "assigned" }] });
  const sources = { ...rig.deps.sources!, tasks: () => [{ id: "task_j1", project: fixture.project, status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: ago(fixture, 30), updatedAt: ago(fixture, 30) }] as never };
  const record = await runSeatTickCheck(fixture.project, { ...rig.deps, sources });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unstarted-task"] });
  expect(record!.detail).toContain("(children-unindexed): the registry backend has no indexed lineage projection");
  expect(rig.sent[0]!.text).toContain("children-unindexed");
  expect(fixture.row().childrenGap).toMatchObject({ gap: "children-unindexed" });
});

/* A legacy tick state that cannot be imported blocks every prepare. That must
   never be silent (#1465): the refusal is named in the journal, the condition
   is a run of its own, and it reaches the board once it has outlived the wake
   interval — with the clause that says which file to look at. */
test("a blocked legacy import names itself in the journal and reaches the board after one wake interval (#1465)", async () => {
  const fixture = childFixture("blocked-migration");
  fixture.spawn({ title: "worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fs.writeFileSync(fixture.stateFile, "{ this is not the tick state");
  fixture.seed();
  expect(fixture.row().accounting?.gap).toBe("legacy-json-malformed");
  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "accounting-blocked" } });
  expect(record!.detail).toContain("(migration-blocked): the legacy tick state at state/seat-tick.json cannot be imported");
  expect(first.sent).toEqual([]);
  expect(fixture.acknowledged()).toEqual([]);
  expect(fixture.row().childrenGap).toMatchObject({ gap: "migration-blocked", attempts: 1 });
  const standing = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, standing.deps);
  expect(standing.cards.map((entry) => entry.card)).toMatchObject([{ ref: "seat-tick-source-children", kind: "source-unreadable" }]);
  expect(standing.cards[0]!.card.detail).toContain("migration-blocked, 2 attempt(s)");
  expect(standing.cards[0]!.card.detail).toContain("state/seat-tick.json");
  /* Fixing the file unblocks the import, and the next check wakes. */
  fs.unlinkSync(fixture.stateFile);
  const fixed = childRig(fixture, { now: fixture.now + 66 * MINUTE });
  expect(fixture.row().accounting?.gap).toBeNull();
  const woken = await runSeatTickCheck(fixture.project, fixed.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(fixed.sent).toHaveLength(1);
});

/** Exercise the public delivery adapter's refusal before any reservation. */
function refuseBeforeReservation(status: 409 | 503): (message: ConversationMessage) => Promise<DeliveryOutcome> {
  return (message) => deliverConversationMessage(message, {
    recover: async () => ({ path: message.path, conversationId: message.conversationId as never, spawned: false, target: null }),
    enqueueStructured: async () => status === 503 ? null : {
      ok: false, structured: true, outcome: "failed", error: "conversation cannot be resumed", status,
    },
  });
}

test("a returned 409 or 503 refusal is fenced across rotation and the successor acknowledges once (#1465)", async () => {
  for (const status of [409, 503] as const) {
    const fixture = childFixture(`rotated-refusal-${status}`);
    setAgentRegistryForTests(fixture.registry);
    const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
    fixture.seed();
    const first = childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(status) });
    await runSeatTickCheck(fixture.project, first.deps);
    const original = fixture.row().outstandingWake!;
    expect(original.operationId).toBeNull();
    expect(await resolveOriginalSend({ conversationId: original.conversationId, clientMessageId: original.clientMessageId }, { registry: fixture.registry, client: null })).toEqual({ kind: "absent" });
    const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
    const seat = { conversationId: successor.id, seatEpoch: 8, path: successor.generations[0]!.path };
    const next = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 5 * MINUTE, deliverWith: async (message) => {
      expect(fixture.acknowledged()).toEqual([]);
      expect(fixture.row().lastWakeAt).toBe(ago(fixture, 61));
      const held = fixture.registry.holdDelivery(successor.id, message.text, message.clientMessageId);
      fixture.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    } });
    await runSeatTickCheck(fixture.project, next.deps);
    expect(next.journal[0]).toMatchObject({ verdict: "revoked", delivery: { clientMessageId: original.clientMessageId, outcome: "unsent" } });
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]!.clientMessageId).not.toBe(original.clientMessageId);
    expect(next.sent[0]!.conversationId).toBe(successor.id);
    expect(next.sent[0]!.text).toContain(child.id);
    expect(fixture.acknowledged()).toEqual([child.id]);
    const again = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 10 * MINUTE });
    await runSeatTickCheck(fixture.project, again.deps);
    expect(again.sent).toEqual([]);
    expect(fixture.acknowledged()).toEqual([child.id]);
  }
});

test("a paused old lookup cannot dispatch after a successor replaces the refused wake (#1465)", async () => {
  const fixture = childFixture("old-lookup-interleaving");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, deliverWith: refuseBeforeReservation(503) }).deps);
  const original = fixture.row().outstandingWake!;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const old = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE });
  const lookup = old.deps.sources!.wakeState!;
  let paused = false;
  const pending = runSeatTickCheck(fixture.project, { ...old.deps, sources: { ...old.deps.sources!, wakeState: async (wake) => {
    const evidence = await lookup(wake);
    if (!paused) { paused = true; entered(); await blocked; }
    return evidence;
  } } });
  await waiting;
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  const next = childRig(fixture, { realWakeState: true, seat: { conversationId: successor.id, seatEpoch: 8, path: null }, now: fixture.now + 6 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
  release();
  await pending;
  expect(old.sent).toEqual([]);
  expect(await resolveOriginalSend({ conversationId: original.conversationId, clientMessageId: original.clientMessageId }, { registry: fixture.registry, client: null })).toEqual({ kind: "absent" });
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a dispatch paused before reservation blocks rotation until its returned refusal is fenced (#1465)", async () => {
  const fixture = childFixture("active-dispatch-interleaving");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  fixture.seed();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = childRig(fixture, { realWakeState: true, deliverWith: async (message) => {
    entered(); await blocked;
    return refuseBeforeReservation(503)(message);
  } });
  const pending = runSeatTickCheck(fixture.project, first.deps);
  await waiting;
  const original = fixture.row().outstandingWake!;
  expect(original.dispatch?.state).toBe("active");
  const seat = { ...fixture.seat, seatEpoch: 8 };
  const rotated = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(rotated.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toEqual(original);
  expect(rotated.cards.map(({ card }) => card.ref)).toContain(seatTickWakeUnresolvedRef(original.clientMessageId));
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  expect(accounting.settleAbsent(original)).toBe(false);
  expect(accounting.cancelUndispatched(original)).toBe(false);
  release(); await pending;
  const returned = fixture.row().outstandingWake!;
  expect(returned.dispatch?.state).toBe("refused");
  const next = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 62 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(accounting.beginDispatch(returned)).toBeNull();
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("rotation retains absent legacy, unknown, unreadable, uncertain and too-late attempts with attention (#1465)", async () => {
  for (const mode of ["legacy", "unknown", "unreadable", "uncertain", "too-late", "started"] as const) {
    const fixture = childFixture(`rotated-mirror-${mode}`);
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "owed worker", turn: "terminal" });
    fixture.seed();
    await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true,
      ...(mode === "started" ? { delivery: { ok: false, outcome: "failed", error: "arrival unknown", status: 409, actuation: "started", resend: "verify-first" } as DeliveryOutcome }
        : { deliverWith: refuseBeforeReservation(409) }),
    }).deps);
    if (mode === "legacy" || mode === "unknown") {
      const state = fixture.row();
      writeSeatTickState(fixture.project, { ...state, outstandingWake: { ...state.outstandingWake!, dispatch: undefined,
        operationId: mode === "unknown" ? "unreadable-operation" : null } }, fixture.stateFile);
    }
    if (mode === "uncertain") {
      const wake = fixture.row().outstandingWake!;
      const held = fixture.registry.holdDelivery(wake.conversationId as never, wake.text!, wake.clientMessageId, "text", [], null, { operationId: "unverified-operation", kind: "send", policy: "queue" });
      fixture.registry.recordDeliveryOutcome(held.id, "failed", "arrival unverified", "unverified");
    }
    const original = fixture.row().outstandingWake!;
    const rig = childRig(fixture, { realWakeState: mode !== "too-late", wakeState: "retained", withdrawal: "too-late",
      seat: { ...fixture.seat, seatEpoch: 8 }, now: fixture.now + 61 * MINUTE });
    if (mode === "unreadable") rig.deps.sources!.wakeState = async () => { throw new Error("unreadable registry"); };
    await runSeatTickCheck(fixture.project, rig.deps);
    expect(rig.sent).toEqual([]);
    expect(fixture.row().outstandingWake).toEqual(original);
    expect(fixture.acknowledged()).toEqual([]);
    expect(rig.cards.map(({ card }) => card.ref)).toContain(seatTickWakeUnresolvedRef(original.clientMessageId));
  }
});

test("435 cold acknowledged children do not delay a new worker or its completion, and cold turns remain observable (#1465)", async () => {
  let payloadRows = 0;
  const fixture = childFixture("large-cold-fleet", false, "sqlite", (_collection, count) => { payloadRows += count; });
  const cold = Array.from({ length: 435 }, (_, index) => fixture.spawn({ title: `cold worker ${index}`, turn: "terminal" }));
  fixture.seed();
  const settings = { ...defaultSeatTickSettings(fixture.project), wakeIntervalMinutes: 5 };
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 20 };
  let clock = fixture.now;
  let projectedRows = 0;
  let projectionBytes = 0;
  let fetchedBytes = 0;
  let maxRows = 0;
  let maxPayloadRows = 0;
  let maxBytes = 0;
  const pageChildren = fixture.registry.pageSeatChildren.bind(fixture.registry);
  fixture.registry.pageSeatChildren = (...args) => {
    const page = pageChildren(...args);
    projectedRows += page?.keys.length ?? 0;
    projectionBytes += Buffer.byteLength(JSON.stringify(page?.file ?? {}));
    return page;
  };
  const check = async (over: Parameters<typeof harness>[0] = {}) => {
    projectedRows = 0; payloadRows = 0; projectionBytes = 0; fetchedBytes = 0;
    const read = fs.readSync;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const bytes = Reflect.apply(read, fs, args) as number;
      fetchedBytes += bytes;
      return bytes;
    }) as typeof fs.readSync;
    const rig = childRig(fixture, { now: clock, settings, ...over });
    let result;
    try { result = await runSeatTickCheck(fixture.project, { ...rig.deps, policy }); }
    finally { fs.readSync = read; }
    expect(projectedRows).toBeLessThanOrEqual(60);
    expect(payloadRows).toBeLessThanOrEqual(600);
    expect(projectionBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(fetchedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(rig.snapshots).toBe(0);
    expect(result?.detail).not.toContain("ledger-pending");
    maxRows = Math.max(maxRows, projectedRows);
    maxPayloadRows = Math.max(maxPayloadRows, payloadRows);
    maxBytes = Math.max(maxBytes, fetchedBytes);
    clock += 5 * MINUTE;
    return { result, rig };
  };
  // Establish real acknowledged history through the controller and event ledgers.
  const named: string[] = [];
  for (let tick = 0; tick < 100 && fixture.acknowledged().length < cold.length; tick++) {
    const { rig } = await check();
    for (const message of rig.sent) for (const match of message.text.matchAll(/\[child\] (\S+) /g)) named.push(match[1]!);
  }
  expect(named.length).toBe(435);
  expect(new Set(named)).toEqual(new Set(cold.map((child) => child.id)));
  // Move the old key-ordered implementation to the beginning of a cold sweep.
  // This uses observation only and makes the regression deterministic on that head.
  for (let tick = 0; tick < 22; tick++) await check();
  const fresh = fixture.spawn({ title: "new worker", turn: "busy", host: "live" });
  const generation = fixture.registry.conversation(fresh.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "fresh-turn", seq: 1 });
  const discovered = await check({ childActivity: { [fresh.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  expect(discovered.result).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(discovered.rig.sent[0]!.text).toContain(fresh.id);
  ledger.append(generation, { kind: "turn-ended", turnId: "fresh-turn", status: "completed", seq: 2 });
  fixture.registry.reconcileConversations([{
    engine: "claude", path: fresh.path, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "new worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(clock).toISOString() }, observedAt: new Date(clock).toISOString(),
  }]);
  const finished = await check();
  expect(finished.result).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(finished.rig.sent[0]!.text).toContain(fresh.id);
  expect(fixture.acknowledged().filter((id) => id === fresh.id)).toHaveLength(1);
  // A cold child's later turn is owed even without a sampled running state.
  const oldest = cold[0]!;
  const oldGeneration = fixture.registry.conversation(oldest.id as never)!.generations[0]!.id;
  ledger.append(oldGeneration, { kind: "turn-started", turnId: "cold-again", seq: 3 });
  ledger.append(oldGeneration, { kind: "turn-ended", turnId: "cold-again", status: "completed", seq: 4 });
  for (let tick = 0; tick < 55 && fixture.acknowledged().filter((id) => id === oldest.id).length < 2; tick++) await check();
  expect(fixture.acknowledged()).toHaveLength(437);
  expect(fixture.acknowledged().filter((id) => id === oldest.id)).toHaveLength(2);
  for (let tick = 0; tick < 3; tick++) expect((await check()).rig.sent).toEqual([]);
  console.log(`[435 cold] max projected rows ${maxRows}, payload rows ${maxPayloadRows}, positional bytes ${maxBytes}; new running check 1, completion check 1, 437 acknowledged outcomes`);
}, 300_000);

test("new-child discovery runs during historical bootstrap and keeps every older obligation (#1465)", async () => {
  const fixture = childFixture("bootstrap-tail");
  const historical = Array.from({ length: 63 }, (_, n) => fixture.spawn({ title: `historical ${n}`, turn: "terminal" }));
  fixture.seed();
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 20 };
  await runSeatTickCheck(fixture.project, { ...childRig(fixture).deps, policy });
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const owner = accounting.page("owner", 1)[0]!;
  expect(owner.kind === "owner" && owner.bootstrap).toBeTruthy();
  const fresh = fixture.spawn({ title: "new during bootstrap", turn: "busy", host: "live" });
  const generation = fixture.registry.conversation(fresh.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "new-during-bootstrap", seq: 1 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...next.deps, policy });
  expect(next.liveness.map((read) => read.conversationId)).toContain(fresh.id);
  for (let tick = 2; tick < 8; tick++) {
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE });
    await runSeatTickCheck(fixture.project, { ...rig.deps, policy });
  }
  expect(new Set(fixture.acknowledged())).toEqual(new Set(historical.map((child) => child.id)));
  expect(fixture.acknowledged()).toHaveLength(63);
  expect(accounting.page("child", 100)).toHaveLength(64);
  const completedOwner = accounting.page("owner", 1)[0]!;
  expect(completedOwner.kind === "owner" && completedOwner.bootstrap).toBeUndefined();
}, 30_000);

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

test("a wake stranded by a replaced seat is retired, and the successor's own wake goes out (#1594)", async () => {
  const fixture = childFixture("stranded-retired-seat");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  const stranded = await strandOneWake(fixture, 140);
  expect(stranded).toMatchObject({ seatEpoch: 140, operationId: null, dispatch: { state: "refused" } });
  expect(fixture.acknowledged()).toEqual([]);

  const successor = successorSeat(fixture, 155);
  const rig = childRig(fixture, { realWakeState: true, seat: successor, now: fixture.now + 34 * 60 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, rig.deps);

  /* The fence is gone, and it is the SUCCESSOR that is woken, under a key of
     its own — never the stranded one replayed. */
  expect(rig.sent.map((message) => message.conversationId)).toEqual([successor.conversationId]);
  expect(rig.sent[0]!.clientMessageId).not.toBe(stranded.clientMessageId);
  expect(record).toMatchObject({ verdict: "wake" });
  expect(record!.delivery!.outcome).not.toBe("deferred-outstanding");

  /* The obligation is not dropped: same key, same payload, same landing plan,
     same dispatch record, now held against the seat that has been replaced and
     carrying the proof that licensed the move. */
  const retired = fixture.row().retiredWakes;
  expect(retired).toHaveLength(1);
  expect(retired[0]!.wake).toEqual({ ...stranded, preparedAt: retired[0]!.wake.preparedAt });
  expect(retired[0]!.wake).toMatchObject({ clientMessageId: stranded.clientMessageId, seatEpoch: 140, operationId: null,
    text: stranded.text, commit: stranded.commit, dispatch: { state: "refused" } });
  expect(retired[0]!.supersededBy).toEqual({ conversationId: successor.conversationId, seatEpoch: 155 });
  /* And the reason it stopped fencing is on the row, not inferred from the
     presence of a superseding seat (#1746). */
  expect(retired[0]!.reason).toBe("seat-superseded");
  expect(retired[0]!.retiredAt).toBe(new Date(fixture.now + 34 * 60 * MINUTE).toISOString());

  /* One journal line carries both facts: what the holder last answered, and
     that the attempt stopped withholding this project's wakes. */
  const retirement = rig.journal.find((line) => line.verdict === "retired")!;
  expect(retirement).toMatchObject({ seatEpoch: 140, delivery: { clientMessageId: stranded.clientMessageId, outcome: "uncertain" } });
  expect(retirement.detail).toContain("never re-sent");
  expect(retirement.detail).toContain("credits nothing");

  /* And the wait stays on the board under the attempt's own key, saying what
     it now does and does not block. */
  expect(rig.cards.map((entry) => entry.card)).toMatchObject([{ ref: seatTickWakeUnresolvedRef(stranded.clientMessageId), kind: "wake-unresolved", instance: stranded.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain("no longer holds back this project's wakes");

  /* Nothing the stranded attempt named was credited on its behalf: the child it
     carried was still owed, so the wake the successor actually received is what
     harvested it. */
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* And the release is permanent, not one wake's reprieve. The holder still
     cannot account for the retired attempt, and the project's later checks are
     no longer withheld behind it. On main this project answered
     `deferred-outstanding` at +34 h, +48 h and +72 h with nothing sent. */
  for (const hours of [48, 72]) {
    const later = childRig(fixture, { realWakeState: true, seat: successor, now: fixture.now + hours * 60 * MINUTE });
    const record_ = await runSeatTickCheck(fixture.project, later.deps);
    expect(record_!.delivery?.outcome).not.toBe("deferred-outstanding");
    expect(fixture.row().retiredWakes).toHaveLength(1);
    expect(later.sent.map((message) => message.clientMessageId)).not.toContain(stranded.clientMessageId);
  }
});

/* The fence exists so two wakes are never in flight to ONE seat, and that is
   exactly as true after this change. Supersession takes positive proof, and
   each of these is the absence of it — so inside the attempt's own age bound
   every one of them is still fenced. */
test("the fence stands inside its bound wherever the payload could still reach the seat being woken (#1594)", async () => {
  const cases: [string, (fixture: ChildFixture) => { conversationId: string; seatEpoch: number; path: string | null } | null][] = [
    ["the seat has not moved at all", (fixture) => ({ ...fixture.seat, seatEpoch: 140 })],
    ["the same conversation is re-seated at a higher epoch", (fixture) => ({ ...fixture.seat, seatEpoch: 155 })],
    ["the seat file reads empty", () => null],
    ["the seat read has fallen behind the attempt's own epoch", (fixture) => ({ ...successorSeat(fixture, 139) })],
  ];
  for (const [name, seatFor] of cases) {
    const fixture = childFixture(`fence-holds-${name.replace(/[^a-z]+/g, "-")}`);
    setAgentRegistryForTests(fixture.registry);
    fixture.spawn({ title: "owed worker", turn: "terminal" });
    const stranded = await strandOneWake(fixture, 140);
    /* Resolved once: a case that mints a successor conversation must mint one,
       not one per read. */
    const seat = seatFor(fixture);
    /* Ninety minutes: past the wake interval, inside the two-interval bound. */
    const rig = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 90 * MINUTE });
    const record = await runSeatTickCheck(fixture.project, rig.deps);
    expect(rig.sent).toEqual([]);
    expect(fixture.row().retiredWakes).toEqual([]);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: stranded.clientMessageId, seatEpoch: 140 });
    expect(rig.journal.some((line) => line.verdict === "retired")).toBe(false);
    if (seat) expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
    expect(fixture.acknowledged()).toEqual([]);

    /* And past the bound every one of them is retired unresolved on its age
       instead, because none of these readings will ever settle the attempt and
       a seat is not left unwoken for a second day waiting for one (#1746). The
       retirement is recorded with its reason wherever the seat read stands —
       even where there is no seat to wake, which is the one case that sends
       nothing. */
    const past = childRig(fixture, { realWakeState: true, seat, now: fixture.now + 34 * 60 * MINUTE });
    const later = await runSeatTickCheck(fixture.project, past.deps);
    expect(fixture.row().outstandingWake).toBeNull();
    expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: stranded.clientMessageId, seatEpoch: 140 }, supersededBy: null, reason: "unresolved-age" }]);
    expect(past.journal.some((line) => line.verdict === "retired")).toBe(true);
    if (seat) {
      expect(past.sent).toHaveLength(1);
      expect(past.sent[0]!.clientMessageId).not.toBe(stranded.clientMessageId);
      expect(later!.delivery!.outcome).toBe("delivered");
    } else {
      expect(past.sent).toEqual([]);
    }
  }
});

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

/* Retirement moves the obligation; it does not end it. Every check still asks
   the holder what became of it, and still asks for it back while the holder
   still has it. */
test("a retired attempt is asked after on every check and taken back the moment that becomes possible (#1594)", async () => {
  const entry = retiredEntry();
  const seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
  const state = { ...RECENT, seatEpoch: 8, retiredWakes: [entry] };

  const stuck = harness({ seat, pipelines: OPEN_LANE, state, wakeState: "retained", withdrawal: "unknown" });
  await runSeatTickCheck(PROJECT, stuck.deps);
  expect(stuck.withdrawn.map((call) => call.wake.clientMessageId)).toEqual([entry.wake.clientMessageId]);
  expect(stuck.withdrawn[0]!.reason).toContain("has since been replaced");
  expect(stuck.written.at(-1)!.retiredWakes).toEqual([entry]);
  expect(stuck.sent).toEqual([]);

  const taken = harness({ seat, pipelines: OPEN_LANE, state, wakeState: "retained", withdrawal: "withdrawn" });
  await runSeatTickCheck(PROJECT, taken.deps);
  const revocation = taken.journal.find((line) => line.verdict === "revoked")!;
  expect(revocation).toMatchObject({ seatEpoch: 7, delivery: { clientMessageId: entry.wake.clientMessageId, outcome: "withdrawn" } });
  expect(taken.written.at(-1)!.retiredWakes).toEqual([]);

  /* A holder that cannot answer at all proves nothing either way, so the
     obligation stands and the next check asks again. */
  const unreadable = harness({ seat, pipelines: OPEN_LANE, state, holderThrows: true });
  await runSeatTickCheck(PROJECT, unreadable.deps);
  expect(unreadable.written.at(-1)!.retiredWakes).toEqual([entry]);
});

/* The other half of retirement, and the one that keeps a replaced seat from
   acting for its successor: whatever the holder says became of the payload, it
   became of it on a seat this project no longer has. Nothing is credited. */
test("a retired attempt that lands afterwards credits nothing, and is never re-dispatched (#1594)", async () => {
  const fixture = childFixture("retired-landing-credits-nothing");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "owed worker", turn: "terminal" });
  const successor = successorSeat(fixture, 155);
  fixture.seed({
    seatEpoch: 155,
    eventsThrough: 12,
    lastWakeAt: new Date(fixture.now - 5 * MINUTE).toISOString(),
    retiredWakes: [{
      wake: { clientMessageId: "seat-tick:record:140:first:child-terminal:fp-1", conversationId: fixture.seat.conversationId,
        seatEpoch: 140, operationId: null, text: "the predecessor's wake", preparedAt: new Date(fixture.now - 70 * MINUTE).toISOString(),
        commit: { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-1", eventsThrough: 99, children: [child.id] } },
      retiredAt: new Date(fixture.now - 65 * MINUTE).toISOString(),
      supersededBy: { conversationId: successor.conversationId, seatEpoch: 155 },
    }],
  });
  const rig = childRig(fixture, { seat: successor, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, rig.deps);
  const landing = rig.journal.find((line) => line.verdict === "landed")!;
  expect(landing).toMatchObject({ seatEpoch: 140, delivery: { outcome: "landed" } });
  expect(landing.detail).toContain("no longer holds this project");
  /* The stamp, the cursor and the child it named: all exactly where they were,
     so the successor is still owed every one of them. */
  const row = fixture.row();
  expect(row.retiredWakes).toEqual([]);
  expect(row.eventsThrough).toBe(12);
  expect(row.lastWakeAt).toBe(new Date(fixture.now - 5 * MINUTE).toISOString());
  expect(fixture.acknowledged()).toEqual([]);
  expect(rig.sent).toEqual([]);
});

/* `absent` is the one answer that licenses an OUTSTANDING attempt to go out
   again under its original key. A retired one has nowhere to go: the seat it
   was prepared for is gone, so it is released unsent and the wake that leaves
   this check is the successor's own, under its own key. */
test("a retired attempt the holder affirms it never kept is released unsent, never replayed (#1594)", async () => {
  const entry = retiredEntry();
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 8, retiredWakes: [entry] },
    wakeState: "absent",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  const released = rig.journal.find((line) => line.verdict === "revoked")!;
  expect(released).toMatchObject({ seatEpoch: 7, delivery: { clientMessageId: entry.wake.clientMessageId, outcome: "unsent" } });
  expect(released.detail).toContain("never re-dispatched");
  expect(rig.written.at(-1)!.retiredWakes).toEqual([]);
  /* One wake left this check, and it was not the retired payload. */
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.clientMessageId).not.toBe(entry.wake.clientMessageId);
  expect(rig.sent[0]!.text).not.toBe(entry.wake.text);
  expect(record).toMatchObject({ verdict: "wake" });
});

/* A retired attempt still unresolved past the interval keeps the operator's
   attention, once, under its own key — and the card says what it now costs,
   which is nothing. */
test("a retired attempt outliving the wake interval is carded once, under its own key (#1594)", async () => {
  const entry = retiredEntry();
  const seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
  const rig = harness({ seat, pipelines: OPEN_LANE, state: { ...RECENT, seatEpoch: 8, retiredWakes: [entry] }, wakeState: "uncertain" });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.cards.map((raised) => raised.card)).toMatchObject([{ ref: seatTickWakeUnresolvedRef(entry.wake.clientMessageId), kind: "wake-unresolved", instance: entry.wake.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain('last answered "uncertain"');
  expect(rig.cards[0]!.card.detail).toContain("never re-sent");
  expect(rig.cards[0]!.card.detail).toContain("no longer holds back this project's wakes");
  expect(rig.written.at(-1)!.retiredWakes).toEqual([entry]);
});

/* The bound. A row that has reached it refuses to retire another attempt and
   keeps the fence — which is the behaviour that stood before any of this, and
   the only direction that never discards an obligation to make room. */
test("a row at the retention bound keeps the fence rather than dropping an obligation (#1594)", async () => {
  const full = Array.from({ length: 20 }, (_, n) => retiredEntry({ clientMessageId: `retired-${n}` }));
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 8, outstandingWake: outstandingWake({ operationId: null }), retiredWakes: full },
    wakeState: "unknown",
    withdrawal: "unknown",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.retiredWakes).toHaveLength(20);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ clientMessageId: outstandingWake().clientMessageId });
  expect(rig.journal.some((line) => line.verdict === "retired")).toBe(false);
  expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
});

/* The journal is the audit trail an operator is pointed at, so the line this
   ending writes has to survive the journal it is written to. */
test("a retirement line reads back from the seat tick journal (#1594)", () => {
  const file = path.join(fs.mkdtempSync(path.join(SANDBOX, "journal-retired-")), "runs.ndjson");
  const record: SeatTickRunRecord = {
    schemaVersion: 1, at: new Date(NOW).toISOString(), project: PROJECT, seatEpoch: 140, verdict: "retired", reasons: [], items: 0, deferred: 0,
    eventsThrough: 3, delivery: { clientMessageId: "seat-tick:viewer:140:first:interval:fp-1", outcome: "uncertain" }, detail: "retired to a superseded seat",
  };
  appendSeatTickRecord(record, file);
  expect(readSeatTickRecords(10, file)).toEqual([record]);
});

/* The one way retirement could put two wakes in front of one seat: a seat
   re-designated BACK onto the conversation an earlier attempt was retired
   against. That conversation is the seat again, so the fence is owed to it
   again — and it is owed by the retired attempt, exactly as it would be by an
   outstanding one. */
test("a seat re-designated onto a conversation a retired attempt still names is fenced again (#1594)", async () => {
  const entry = retiredEntry();
  const rig = harness({
    /* The retired attempt's own conversation, seated again at a higher epoch. */
    seat: { conversationId: CONVERSATION, seatEpoch: 9, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 9, retiredWakes: [entry] },
    wakeState: "uncertain",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.written.at(-1)!.retiredWakes).toEqual([entry]);

  /* And a project whose seat is anywhere else is not fenced by it. */
  const elsewhere = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 9, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 9, retiredWakes: [entry] },
    wakeState: "uncertain",
  });
  await runSeatTickCheck(PROJECT, elsewhere.deps);
  expect(elsewhere.sent).toHaveLength(1);
  expect(elsewhere.sent[0]!.conversationId).toBe(SUCCESSOR);
});

/* A board card is re-found by its ref alone, so while one ref served the whole
   project the first unresolved attempt to be carded took the only slot and
   every later one wrote nothing. Retirement makes a project able to hold
   several at once — and the shadowed one is the outstanding attempt, whose card
   is the one that says the project's wakes are held back. The board would have
   carried a single card saying the opposite (#1594). This drives the real
   `ensureSeatTickCard` over a board file, because the shadowing lives there and
   the harness stub cannot see it. */
test("a retired and an outstanding attempt each carry their own board card (#1594)", async () => {
  const project = `wake-cards-${crypto.randomUUID().slice(0, 8)}`;
  const board = path.join(process.env.LLV_STATE_DIR!, "tasks.json");
  const cardsOn = (): { id: string; text: string; status: string }[] => {
    const file = JSON.parse(fs.readFileSync(board, "utf8")) as { tasks: { id: string; project: string; text: string; status: string }[] };
    return file.tasks.filter((task) => task.project === project && task.status !== "done");
  };
  const stranded = outstandingWake({ seatEpoch: 140, conversationId: CONVERSATION, operationId: null,
    text: "the predecessor's wake", preparedAt: new Date(NOW - 70 * MINUTE).toISOString() });
  const lane = [{ ...OPEN_LANE[0]!, project }];
  const seat = { conversationId: SUCCESSOR, seatEpoch: 155, path: null };
  const shared = {
    seat, pipelines: lane, settings: defaultSeatTickSettings(project), wakeState: "unknown" as const,
    /* A send the layer took and has not landed: the successor's own attempt
       becomes the outstanding one, and the retired one is still unresolved. */
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-successor-1", receipt: {} as never, structured: true } as DeliveryOutcome,
    state: { seatEpoch: 155, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), outstandingWake: stranded },
  };

  /* Check one retires the predecessor's attempt, cards it, and raises the
     successor's own wake — which the layer keeps. */
  const first = harness(shared);
  await runSeatTickCheck(project, { ...first.deps, ensureCard: undefined });
  expect(first.sent).toHaveLength(1);
  const successorKey = first.sent[0]!.clientMessageId!;
  expect(cardsOn()).toHaveLength(1);

  /* Check two, past the interval: the successor's attempt is now unresolved
     too, and it must reach the board rather than be shadowed. */
  const second = harness({ ...shared, now: NOW + 61 * MINUTE,
    state: { ...shared.state, outstandingWake: undefined as never } });
  second.deps.readState = first.deps.readState;
  second.deps.writeState = first.deps.writeState;
  const record = await runSeatTickCheck(project, { ...second.deps, ensureCard: undefined });
  expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });

  const standing = cardsOn();
  expect(standing).toHaveLength(2);
  const retiredCard = standing.find((task) => task.text.includes(stranded.clientMessageId))!;
  const outstandingCard = standing.find((task) => task.text.includes(successorKey))!;
  expect(retiredCard).toBeDefined();
  expect(outstandingCard).toBeDefined();
  expect(retiredCard.id).not.toBe(outstandingCard.id);
  /* Each names its own attempt, and each says what that attempt costs. The
     project's wakes being held back is stated, by the attempt holding them. */
  expect(outstandingCard.text).toContain("dispatches no replacement wake");
  expect(outstandingCard.text).toContain(seatTickWakeUnresolvedRef(successorKey));
  expect(retiredCard.text).toContain("no longer holds back this project's wakes");
  expect(retiredCard.text).toContain(seatTickWakeUnresolvedRef(stranded.clientMessageId));

  /* A later check re-raises both conditions and writes nothing: a card for
     something that HAPPENED does not churn once per check. */
  const third = harness({ ...shared, now: NOW + 122 * MINUTE, state: { ...shared.state, outstandingWake: undefined as never } });
  third.deps.readState = first.deps.readState;
  third.deps.writeState = first.deps.writeState;
  await runSeatTickCheck(project, { ...third.deps, ensureCard: undefined });
  expect(cardsOn().map((task) => `${task.id}:${task.text}`).sort())
    .toEqual(standing.map((task) => `${task.id}:${task.text}`).sort());

  /* And closing one attempt's card leaves the other's standing. */
  const file = JSON.parse(fs.readFileSync(board, "utf8")) as { tasks: { id: string; status: string }[] };
  fs.writeFileSync(board, JSON.stringify({ ...file,
    tasks: file.tasks.map((task) => task.id === retiredCard.id ? { ...task, status: "done" } : task) }));
  expect(cardsOn().map((task) => task.id)).toEqual([outstandingCard.id]);
});

/* The retired release on affirmed absence, pinned across every dispatch state
   it can meet — the one place the retired reconcile is deliberately less
   conservative than the outstanding one, which fences a token and releases only
   an explicit refusal. It can be: the admission fence claims
   `state.outstandingWake`, so no transport call can ever start under a retired
   attempt and there is no token left to fence. What still has to hold is the
   other half — an attempt whose transport call has NOT come back is kept,
   because that call is the one thing that could still be happening, and an
   attempt naming an operation is kept, because absence beside a handle is not
   an affirmation about that handle. */
test("the retired release on affirmed absence turns on the transport call, never on age (#1594)", async () => {
  const cases: [string, SeatTickOutstandingWake["dispatch"], string | null, boolean][] = [
    ["a refusal that reserved nothing", { token: "dispatch-token", state: "refused" }, null, true],
    ["a call that returned without refusing", { token: "dispatch-token", state: "returned" }, null, true],
    ["a legacy attempt with no dispatch record", undefined, null, true],
    ["a call that has not come back", { token: "dispatch-token", state: "active" }, null, false],
    ["an attempt that still names an operation", { token: "dispatch-token", state: "refused" }, "op-retired-1", false],
  ];
  for (const [name, dispatch, operationId, released] of cases) {
    const entry = retiredEntry({ clientMessageId: `retired-${name.replace(/[^a-z]+/g, "-")}`, dispatch, operationId });
    const rig = harness({
      seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
      pipelines: OPEN_LANE,
      state: { ...RECENT, seatEpoch: 8, retiredWakes: [entry] },
      wakeState: "absent",
    });
    await runSeatTickCheck(PROJECT, rig.deps);
    const unsent = rig.journal.find((line) => line.delivery?.clientMessageId === entry.wake.clientMessageId && line.delivery.outcome === "unsent");
    expect([name, rig.written.at(-1)!.retiredWakes.length]).toEqual([name, released ? 0 : 1]);
    expect([name, unsent !== undefined]).toEqual([name, released]);
    /* Released or kept, the payload never goes out again under any key. */
    expect(rig.sent).toEqual([]);
  }
});

/* The two answers the retired reconcile can meet that nothing else exercises.
   `dropped` is the one verdict that ends an obligation on the holder's word
   alone, and `too-late` is the answer the whole withdrawal mechanism exists to
   be able to give — the replaced seat may have received it. */
test("a retired attempt the holder proves it never delivered is ended, and one it was already past is kept (#1594)", async () => {
  const seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };

  /* Proven non-delivery ends the obligation, and credits nothing on the way
     out: the successor was never told, so everything it named is still owed. */
  const dropped = retiredEntry({ clientMessageId: "retired-dropped" });
  const ended = harness({
    seat, pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 8, eventsThrough: 12, retiredWakes: [dropped] },
    wakeState: "dropped",
  });
  await runSeatTickCheck(PROJECT, ended.deps);
  const line = ended.journal.find((entry) => entry.delivery?.clientMessageId === dropped.wake.clientMessageId)!;
  expect(line).toMatchObject({ verdict: "dropped", seatEpoch: 7, delivery: { outcome: "dropped" } });
  expect(line.detail).toContain("remain owed");
  expect(ended.written.at(-1)!.retiredWakes).toEqual([]);
  expect(ended.written.at(-1)!.eventsThrough).toBe(12);
  expect(ended.written.at(-1)!.lastWakeAt).toBe(RECENT.lastWakeAt);
  expect(ended.sent).toEqual([]);

  /* A holder already past the point of taking it back settles nothing: the
     replaced seat may have it, so the attempt is kept and asked again. The
     board is what carries that, once — a keep-verdict line per retained
     attempt per check would spend the journal's history on repetition. */
  const late = retiredEntry({ clientMessageId: "retired-too-late" });
  const kept = harness({
    seat, pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 8, retiredWakes: [late] },
    wakeState: "retained", withdrawal: "too-late",
  });
  await runSeatTickCheck(PROJECT, kept.deps);
  expect(kept.withdrawn.map((call) => call.wake.clientMessageId)).toEqual([late.wake.clientMessageId]);
  expect(kept.written.at(-1)!.retiredWakes).toEqual([late]);
  expect(kept.journal.some((entry) => entry.delivery?.clientMessageId === late.wake.clientMessageId)).toBe(false);
  expect(kept.cards.map((raised) => raised.card.instance)).toEqual([late.wake.clientMessageId]);
  expect(kept.cards[0]!.card.detail).toContain('last answered "retained"');
  expect(kept.sent).toEqual([]);
});

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

test("a wake the settlement ended unrecorded fences inside its bound, the board names the operation, the record's reason and the journal's silence, and the bound is what ends it (#1746)", async () => {
  const { fixture, journal, child, operationId, wake, fenced } = await strandedManagerWake("stranded-manager");
  expect(fenced.journal.map((line) => line.verdict)).toEqual(["uncertain", "wake"]);
  /* The same obligations raise the same key, and the key waits behind itself. */
  expect(fenced.journal[1]).toMatchObject({ delivery: { clientMessageId: wake.clientMessageId, outcome: "deferred-outstanding" } });
  expect(fenced.sent).toEqual([]);
  const cards = fenced.cards.map(({ card }) => card);
  expect(cards).toMatchObject([{ ref: seatTickWakeUnresolvedRef(wake.clientMessageId), kind: "wake-unresolved", instance: wake.clientMessageId }]);
  /* The diagnosis an operator can act on: which operation the record holds
     under the key, what the record says of it, and what the journal answered. */
  expect(cards[0]!.detail).toContain('last answered "uncertain"');
  expect(cards[0]!.detail).toContain(`operation ${operationId}`);
  expect(cards[0]!.detail).toContain("failed, unverified");
  expect(cards[0]!.detail).toContain("journal holds no record");
  expect(cards[0]!.detail).toContain("dispatches no replacement wake");
  expect(fenced.journal[0]!.detail).toContain(`operation ${operationId}`);
  expect(fenced.journal[0]!.detail).toContain("journal holds no record");

  /* Inside the bound, age settles nothing and a restart settles nothing: the
     row, the key and the payload are exactly what they were, and the card is
     raised once. */
  const before = JSON.stringify(frozen(fixture));
  for (const minutes of [16, 61, 119]) {
    const later = childRig(fixture, { realWakeState: true, journal, now: fixture.now + minutes * MINUTE });
    expect(await runSeatTickCheck(fixture.project, later.deps)).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
    expect(later.sent).toEqual([]);
    expect(later.journal.map((line) => line.verdict)).toEqual(["uncertain", "wake"]);
    expect(JSON.stringify(frozen(fixture))).toBe(before);
    expect(later.cards.map(({ card }) => card.instance)).toEqual([wake.clientMessageId]);
  }
  expect(fixture.acknowledged()).toEqual([]);

  /* Past it, nothing about the evidence has improved and nothing ever will:
     the record absorbed the key, the journal holds no record of the operation,
     and absence is not proof. This is the #1672 shape, and what ends it is the
     bound (#1746) — the attempt retired unresolved, the obligations it named
     re-derived, and the seat woken by the same check. */
  const spent = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 2 * 24 * 60 * MINUTE });
  const woken = await runSeatTickCheck(fixture.project, spent.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(spent.sent).toHaveLength(1);
  expect(spent.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(spent.journal.map((line) => line.verdict)).toEqual(["retired", "wake"]);
  expect(spent.journal[0]!.detail).toContain("retired unresolved on its age bound");
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.row().retiredWakes).toMatchObject([{ supersededBy: null, reason: "unresolved-age" }]);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a journal answer that proves nothing keeps the fence: a late admission the queue fenced, and an old host's unverified failure", async () => {
  for (const answer of [
    { status: "uncertain" as const, reason: DELIVERY_FENCED_BY_SETTLEMENT, expected: "journal: uncertain" },
    { status: "failed" as const, reason: SEND_UNVERIFIED_REASON, expected: "journal: failed" },
  ]) {
    const { fixture, journal, operationId, wake } = await strandedManagerWake(`stranded-${answer.status}`);
    journal.operations.set(operationId, { status: answer.status, reason: answer.reason });
    const before = JSON.stringify(frozen(fixture));
    const later = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE });
    expect(await runSeatTickCheck(fixture.project, later.deps)).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
    expect(later.sent).toEqual([]);
    expect(later.journal[0]).toMatchObject({ verdict: "uncertain", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
    expect(later.journal[0]!.detail).toContain(answer.expected);
    expect(JSON.stringify(frozen(fixture))).toBe(before);
    expect(fixture.acknowledged()).toEqual([]);
  }
});

test("the journal's own terminal verdict outranks a record settled without it: rejected releases the fence and the next wake goes out", async () => {
  for (const answer of [
    { status: "rejected" as const, reason: "conversation is not hosted by any structured host" },
    { status: "failed" as const, reason: SEND_DISCARDED_REASON },
  ]) {
    const { fixture, journal, child, operationId, wake } = await strandedManagerWake(`released-${answer.status}`);
    journal.operations.set(operationId, { status: answer.status, reason: answer.reason });
    /* The transport as it behaves on the re-raise: the same key reaches the
       delivery layer, which re-arms the reservation only because the record
       now says the first attempt was lost. */
    const rearmed: string[] = [];
    const released = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE, deliverWith: async (message) => {
      const held = fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, SEAT_TICK_COMMAND as never);
      rearmed.push(held.state);
      fixture.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    } });
    const record = await runSeatTickCheck(fixture.project, released.deps);
    /* Proven never executed: the record is settled lost on the journal's word,
       the attempt is released under its key, and the same check raises the
       wake again — the same obligations under a NEW key, because the old one
       is spent in the journal that refused it (#1672). */
    expect(released.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: wake.clientMessageId, outcome: "dropped" } });
    expect(released.journal[0]!.detail).toContain(`operation ${operationId}`);
    expect(released.journal[0]!.detail).toContain("settled lost on the journal's own verdict");
    expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "lost" });
    expect(rearmed).toEqual(["assigned"]);
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
    expect(record!.delivery!.clientMessageId).not.toBe(wake.clientMessageId);
    expect(record!.delivery!.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
    expect(fixture.row().releasedWake).toBeNull();
    expect(released.sent).toHaveLength(1);
    expect(released.sent[0]!.text).toContain(child.id);
    expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 16 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
  }
});

test("a journal verdict the record cannot take still releases: a reservation compacted to its owner row is not what the replacement needs", async () => {
  const { fixture, journal, child, operationId, wake } = await strandedManagerWake("released-compacted");
  journal.operations.set(operationId, { status: "rejected", reason: "conversation is not hosted by any structured host" });
  /* The reservation is gone; only the owner row remembers the send. */
  const registry = fixture.registry as unknown as { mutate<R>(fn: (file: { heldDeliveries: Record<string, unknown> }) => R): R };
  registry.mutate((file) => { for (const [id, row] of Object.entries(file.heldDeliveries)) if ((row as { command: { operationId: string } }).command.operationId === operationId) delete file.heldDeliveries[id]; });
  const later = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, later.deps);
  expect(later.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: wake.clientMessageId, outcome: "dropped" } });
  expect(later.journal[0]!.detail).toContain("could not take the journal's verdict");
  /* The owner row keeps its own answer; the replacement never asks it. */
  expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "unverified" });
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(record!.delivery!.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a replacement released in its turn is raised under a third key, distinct from both before it (#1672)", async () => {
  const { fixture, journal, operationId, wake } = await strandedManagerWake("released-twice");
  journal.operations.set(operationId, { status: "rejected", reason: "conversation is not hosted by any structured host" });
  /* The replacement is admitted and queued, never landing. */
  const admitted: string[] = [];
  const queuedTransport = async (message: ConversationMessage): Promise<DeliveryOutcome> => {
    const held = fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, SEAT_TICK_COMMAND as never);
    fixture.registry.beginDeliveryAttempt(held.id, held.generationId!);
    journal.operations.set(held.command.operationId, { status: "queued", reason: null });
    admitted.push(held.command.operationId);
    return { ok: true, target: "structured", outcome: "queued", structured: true, operationId: held.command.operationId };
  };
  /* The settlement reads the wall clock the record stamps with, so the
     replacement's fresh reservation is judged by its real age. */
  const live = () => Date.now();
  const first = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE, settlementNow: live, deliverWith: queuedTransport });
  await runSeatTickCheck(fixture.project, first.deps);
  const second = fixture.row().outstandingWake!;
  expect(second.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  expect(second.operationId).toBe(admitted[0]!);
  /* The host rejects the replacement too. */
  journal.operations.set(admitted[0]!, { status: "rejected", reason: "conversation is not hosted by any structured host" });
  const again = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 21 * MINUTE, settlementNow: live, deliverWith: queuedTransport });
  await runSeatTickCheck(fixture.project, again.deps);
  expect(again.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: second.clientMessageId, outcome: "dropped" } });
  const third = fixture.row().outstandingWake!;
  expect(third.clientMessageId).not.toBe(wake.clientMessageId);
  expect(third.clientMessageId).not.toBe(second.clientMessageId);
  expect(third.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  expect(fixture.row().releasedWake).toMatchObject({ clientMessageId: second.clientMessageId });
  expect(admitted).toHaveLength(2);
  expect(fixture.acknowledged()).toEqual([]);
});

test("a delivery whose terminal acknowledgement the record never received lands on the journal's word, on the plan the raising check wrote", async () => {
  const { fixture, journal, child, operationId, wake } = await strandedManagerWake("landed-by-journal");
  journal.operations.set(operationId, { status: "delivered", reason: null });
  const landed = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 16 * MINUTE });
  const record = await runSeatTickCheck(fixture.project, landed.deps);
  expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
  expect(landed.journal[0]!.detail).toContain("settled delivered on the journal's own verdict");
  expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalState: "delivered", terminalDisposition: "delivered" });
  expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 16 * MINUTE).toISOString() });
  expect(fixture.acknowledged()).toEqual([child.id]);
  /* Credited, so the same check has nothing left to raise. */
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(landed.sent).toEqual([]);
});

test("a send the host admitted and rejected outright is released in the same check, whatever disposition the record kept", async () => {
  const fixture = childFixture("admitted-rejected");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const journal = fakeJournal();
  const rig = childRig(fixture, { realWakeState: true, journal, deliverWith: admittedAndRejected(fixture, journal, "conversation is not hosted by any structured host") });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  /* The reconcile that follows the send reads the journal's `rejected` past
     the record's unverified failure: released, nothing credited. */
  expect(rig.journal.map((line) => line.verdict)).toEqual(["dropped", "wake"]);
  expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: ago(fixture, 61) });
  expect(fixture.acknowledged()).toEqual([]);
  /* The next check — a fresh controller — raises it again and it lands. */
  const next = childRig(fixture, { realWakeState: true, journal, now: fixture.now + 5 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, next.deps)).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(next.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("the permitted recovery for the stranded shape is supersession: the attempt retires whole and the successor is woken (#1594)", async () => {
  const { fixture, journal, child, wake } = await strandedManagerWake("stranded-superseded");
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  const seat = { conversationId: successor.id, seatEpoch: 8, path: successor.generations[0]!.path };
  const next = childRig(fixture, { realWakeState: true, journal, seat, now: fixture.now + 16 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.journal[0]).toMatchObject({ verdict: "retired", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
  /* Key, payload, plan and dispatch record travel untouched; only the fence ends. */
  expect(fixture.row().retiredWakes.map((entry) => entry.wake)).toEqual([wake]);
  expect(fixture.row().retiredWakes[0]!.supersededBy).toEqual({ conversationId: successor.id, seatEpoch: 8 });
  expect(fixture.row().outstandingWake).toBeNull();
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.conversationId).toBe(successor.id);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

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

test("a released wake is raised again as a new message the journal admits, through the real transport, and lands exactly once (#1672)", async () => {
  const fixture = childFixture("released-real-transport");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const { journal, client } = hostedSeat(fixture);
  try {
    /* The send that timed out after the reservation, and the deadline that
       ended it unrecorded — the same shape as the live row. */
    let operationId = "";
    await runSeatTickCheck(fixture.project, childRig(fixture, { realWakeState: true, journal: { client }, deliverWith: reservedThenTimedOut(fixture, (id) => { operationId = id; }) }).deps);
    const wake = fixture.row().outstandingWake!;
    const fenced = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 11 * MINUTE });
    await runSeatTickCheck(fixture.project, fenced.deps);
    expect(fenced.journal.map((line) => line.verdict)).toEqual(["uncertain", "wake"]);
    expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "unverified" });

    /* The host admits the command late, under the identity the record bound,
       and rejects it. The journal now owns (conversation, key). */
    const command = {
      kind: "send" as const, operationId, conversationId: wake.conversationId, idempotencyKey: wake.clientMessageId,
      text: wake.text!, contentDigest: structuredContentDigest({ text: wake.text!, images: [] }), policy: "interrupt-active" as const,
    };
    expect(journal.executeOperation(command).replayed).toBe(false);
    journal.transitionOperation(operationId, "rejected", { reason: "conversation is not hosted by any structured host" });
    /* Why the re-raise cannot be the same message: the journal answers the
       identical command by replaying the refusal, and a changed one under
       that key by refusing it outright. */
    expect(journal.executeOperation(command)).toMatchObject({ replayed: true, receipt: { status: "rejected" } });
    const changed = `${wake.text!} (edited)`;
    expect(() => journal.executeOperation({ ...command, text: changed, contentDigest: structuredContentDigest({ text: changed, images: [] }) }))
      .toThrow("idempotency key already belongs to another request");

    /* The release, and the re-raise through the real transport. */
    /* From here the settlement reads the wall clock the record stamps with,
       so the replacement's own reservation is judged by its real age. */
    const live = () => Date.now();
    const released = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 16 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    const record = await runSeatTickCheck(fixture.project, released.deps);
    expect(released.journal.map((line) => line.verdict)).toEqual(["dropped", "wake"]);
    expect(released.journal[0]).toMatchObject({ verdict: "dropped", delivery: { clientMessageId: wake.clientMessageId, outcome: "dropped" } });
    expect(fixture.registry.readOnlySnapshot().deliveryOperationOwners[operationId]).toMatchObject({ terminalDisposition: "lost" });
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "queued" } });
    const replacement = fixture.row().outstandingWake!;
    expect(replacement.clientMessageId).not.toBe(wake.clientMessageId);
    expect(replacement.clientMessageId.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
    expect(replacement.operationId).not.toBeNull();
    expect(replacement.operationId).not.toBe(operationId);
    expect(fixture.row().releasedWake).toMatchObject({ clientMessageId: wake.clientMessageId });
    /* Two operations in the journal — the refused one and the replacement —
       and exactly one pending effect, the replacement's. */
    expect(journal.operationResult(operationId)?.receipt.status).toBe("rejected");
    expect(journal.operationResult(replacement.operationId!)?.receipt).toMatchObject({ status: "queued", idempotencyKey: replacement.clientMessageId });
    expect(journal.effectBatch(100, ["runtime.send"]).map((effect) => effect.payload.operationId)).toEqual([replacement.operationId]);
    expect(fixture.acknowledged()).toEqual([]);

    /* A check while it is queued replays nothing and sends nothing. */
    const waiting = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 21 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, waiting.deps)).toMatchObject({ delivery: { clientMessageId: replacement.clientMessageId, outcome: "deferred-outstanding" } });
    expect(waiting.sent).toEqual([]);
    expect(journal.snapshot().recentOperations).toHaveLength(2);

    /* The drain delivers it; the next check credits the plan and clears the marker. */
    journal.transitionOperation(replacement.operationId!, "delivered");
    const landed = childRig(fixture, { realWakeState: true, journal: { client }, now: fixture.now + 26 * MINUTE, settlementNow: live, deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, landed.deps)).toMatchObject({ verdict: "quiet" });
    expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: replacement.clientMessageId, outcome: "landed" } });
    expect(fixture.row()).toMatchObject({ outstandingWake: null, releasedWake: null, lastWakeAt: new Date(fixture.now + 26 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
    expect(landed.sent).toEqual([]);
    expect(journal.snapshot().recentOperations).toHaveLength(2);
  } finally {
    journal.close();
  }
});

/* ------------------------------------------------------------------------- *
 * The bound on the fence (#1746).
 *
 * What #1672 recorded: a seat enabled, checked every five minutes, computing
 * `wake` every time, and mute for three and a half hours behind one attempt
 * whose delivery no evidence could ever prove either way. The protection was
 * heavier than the harm — a wake that arrives twice costs one redundant turn,
 * because the seat re-derives everything it acts on from bounded reads; a wake
 * that never arrives stops the conveyor.
 *
 * Every case below runs on this test's own copy of the state a check reads —
 * its own registry, its own row, its own delivery record, its own runtime
 * journal, in its own sandbox — and never the live ones.
 * ------------------------------------------------------------------------- */

/* The shape from the comment of 2026-09-18, rebuilt: seat epoch 169 on a
   twenty-minute cadence, a key derived from a wake eight days and eight epochs
   old, a record that reads failed and unverified for ever, and a runtime
   journal that has been compacted past the operation. The acceptance this
   whole issue is measured by: the first check after the bound delivers. */
test("the #1672 shape — a key anchored eight days back that no evidence can settle — is retired on its bound and the first check past it delivers a wake (#1746)", async () => {
  const anchor = new Date(Date.now() + 3 * MINUTE - 8 * 24 * 60 * MINUTE).toISOString();
  const { fixture, child, wake, rig } = await strandedManagerWake("fence-bound-1672-shape", {
    seatEpoch: 169, lastWakeAt: anchor, wakeIntervalMinutes: 20,
  });
  /* The key carries the stale anchor, which is how one unresolved original key
     outlived eight rotations: it is derived from the last PROVEN wake. */
  expect(wake.clientMessageId).toContain(`:${anchor}:`);
  expect(wake).toMatchObject({ seatEpoch: 169, operationId: null, dispatch: { state: "refused" } });

  /* Inside the bound — one hour, the floor under two twenty-minute intervals —
     every check still computes `wake` and still sends nothing, which is the
     no-blind-resend rule this issue keeps. What is new is that the line says
     why it is mute: which key, since when, and when the fence lapses. */
  for (const minutes of [21, 41, 59]) {
    const inside = rig(minutes);
    const deferred = await runSeatTickCheck(fixture.project, inside.deps);
    expect(deferred).toMatchObject({ verdict: "wake", delivery: { clientMessageId: wake.clientMessageId, outcome: "deferred-outstanding" } });
    expect(inside.sent).toEqual([]);
    expect(deferred!.detail).toContain("this tick is fenced by the wake prepared");
    expect(deferred!.detail).toContain(`under key ${wake.clientMessageId}`);
    expect(deferred!.detail).toContain(`the fence lapses at ${new Date(fixture.now + 60 * MINUTE).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: wake.clientMessageId });
    expect(fixture.acknowledged()).toEqual([]);
  }

  /* The bound spent: retired unresolved, recorded with its reason, and the
     seat woken by the same check — under a key of its own, never the fenced one
     replayed, because that key is still bound in the layers that refused it. */
  const past = rig(61);
  const woken = await runSeatTickCheck(fixture.project, past.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(past.sent).toHaveLength(1);
  expect(past.sent[0]!.clientMessageId).not.toBe(wake.clientMessageId);
  expect(past.sent[0]!.clientMessageId!.startsWith(`${wake.clientMessageId}:after-`)).toBe(true);
  /* And the obligations the retired attempt carried are in it, credited once,
     by the wake that actually went out. */
  expect(past.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row()).toMatchObject({ outstandingWake: null });
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId, seatEpoch: 169 }, supersededBy: null, reason: "unresolved-age" }]);
  const retirement = past.journal.find((line) => line.verdict === "retired")!;
  expect(retirement).toMatchObject({ delivery: { clientMessageId: wake.clientMessageId } });
  expect(retirement.detail).toContain("retired unresolved on its age bound");
  expect(retirement.detail).toContain("never re-sent");
  expect(retirement.detail).toContain("every obligation it named is still owed and the next check derives its own wake from them");
});

/* The rule the bound may not break: one wake in flight per seat. The wake that
   replaces a retired attempt can end the same way the first one did, and then
   it is the fence — under its own key, for its own bound. */
test("the wake that replaces an attempt retired on its age is the project's only one in flight (#1746)", async () => {
  const { fixture, journal, wake, rig } = await strandedManagerWake("fence-bound-one-in-flight", { wakeIntervalMinutes: 20 });
  let replacementOperation = "";
  const past = rig(61, { deliverWith: reservedThenTimedOut(fixture, (id) => { replacementOperation = id; }) });
  await runSeatTickCheck(fixture.project, past.deps);
  expect(past.sent).toHaveLength(1);
  const replacement = fixture.row().outstandingWake!;
  expect(replacement.clientMessageId).not.toBe(wake.clientMessageId);
  expect(fixture.row().retiredWakes).toMatchObject([{ reason: "unresolved-age" }]);

  /* The replacement's own send was reserved and lost the same way. Two checks
     later, nothing has gone out beside it: the row carries one prepared
     attempt, and it is the replacement's. */
  for (const minutes of [66, 75]) {
    const after = rig(minutes);
    const deferred = await runSeatTickCheck(fixture.project, after.deps);
    expect(after.sent).toEqual([]);
    expect(deferred!.delivery).toMatchObject({ clientMessageId: replacement.clientMessageId, outcome: "deferred-outstanding" });
    expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: replacement.clientMessageId });
    expect(fixture.row().retiredWakes).toHaveLength(1);
  }
  /* The retired attempt is never re-sent under any key, and the replacement is
     never sent twice. */
  expect(journal.transitions.filter((entry) => entry.operationId === replacementOperation)).toHaveLength(0);

  /* And the replacement's own bound is its own: measured from when IT was
     prepared, it retires an hour after that, not an hour after the first. */
  const replacementRetired = rig(122);
  await runSeatTickCheck(fixture.project, replacementRetired.deps);
  expect(fixture.row().retiredWakes).toMatchObject([{ reason: "unresolved-age" }, { reason: "unresolved-age" }]);
  expect(replacementRetired.sent).toHaveLength(1);
  expect(replacementRetired.sent[0]!.clientMessageId).not.toBe(replacement.clientMessageId);
});

/* The one answer the bound must not act on. A holder that affirms it still HAS
   the payload is going to deliver it, so retiring the attempt would turn a wake
   still on its way into a guaranteed duplicate. The attempt is kept past its
   bound, no second wake is prepared beside it — and the deferral says which key
   kept it, instead of quoting a lapse that has been and gone. */
test("an attempt its holder still accounts for is kept past its bound, and no second wake is prepared beside it (#1746)", async () => {
  const outstanding = outstandingWake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstanding);
  expect(rig.written.at(-1)!.retiredWakes).toEqual([]);
  expect(record!.detail).toContain(`under key ${outstanding.clientMessageId}`);
  expect(record!.detail).toContain("age bound was spent at");
  expect(record!.detail).toContain("the next check retires it unresolved and may wake this project");
  expect(record!.detail).toContain("unless the layer holding it reports by then that it still has the payload");
  expect(record!.detail).not.toContain("the fence lapses at");
});

/* The same restraint for a transport call that has not come back: retiring an
   attempt mid-flight is how two wakes reach one seat. */
test("an attempt whose transport call is still out is kept past its bound (#1746)", async () => {
  const outstanding = outstandingWake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(), dispatch: { token: "dispatch-token", state: "active" } });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "uncertain" });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.retiredWakes).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ clientMessageId: outstanding.clientMessageId, dispatch: { state: "active" } });
  expect(record).toMatchObject({ delivery: { outcome: "deferred-outstanding" } });
});

/* Retirement on age leaves the payload addressed to the seat that still holds
   the project, which is the one case where a duplicate can still be prevented
   outright: the holder is asked for it back, under a reason that says which
   retirement this was. */
test("a wake retired on its age is taken back out of the queue that still holds it, for a reason that names the bound (#1746)", async () => {
  const aged = {
    wake: outstandingWake({ seatEpoch: 7, operationId: null, text: "the wake nobody could account for",
      preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(), dispatch: { token: "dispatch-token", state: "refused" as const } }),
    retiredAt: new Date(NOW - 60 * MINUTE).toISOString(),
    supersededBy: null,
    reason: "unresolved-age" as const,
  };
  const taken = harness({ pipelines: OPEN_LANE, state: { ...RECENT, seatEpoch: 7, retiredWakes: [aged] }, wakeState: "retained", withdrawal: "withdrawn" });
  await runSeatTickCheck(PROJECT, taken.deps);
  expect(taken.withdrawn.map((call) => call.wake.clientMessageId)).toEqual([aged.wake.clientMessageId]);
  expect(taken.withdrawn[0]!.reason).toContain("retired unresolved after its age bound");
  expect(taken.withdrawn[0]!.reason).not.toContain("has since been replaced");
  const revocation = taken.journal.find((line) => line.verdict === "revoked")!;
  expect(revocation).toMatchObject({ delivery: { clientMessageId: aged.wake.clientMessageId, outcome: "withdrawn" } });
  expect(revocation.detail).toContain("retired unresolved on its age bound was taken out of the queue holding it");
  expect(taken.written.at(-1)!.retiredWakes).toEqual([]);
  /* And it is never sent again under its own key, whatever the holder answered. */
  expect(taken.sent.map((message) => message.clientMessageId)).not.toContain(aged.wake.clientMessageId);

  /* A holder that cannot give it back keeps it where it is, and the board — not
     a journal line per check — is what carries the wait. */
  const late = harness({ pipelines: OPEN_LANE, state: { ...RECENT, seatEpoch: 7, retiredWakes: [aged] }, wakeState: "retained", withdrawal: "too-late" });
  await runSeatTickCheck(PROJECT, late.deps);
  expect(late.written.at(-1)!.retiredWakes).toEqual([aged]);
  expect(late.cards.map((raised) => raised.card.instance)).toEqual([aged.wake.clientMessageId]);
  expect(late.cards[0]!.card.detail).toContain("retired unresolved on its age bound");
  expect(late.sent.map((message) => message.clientMessageId)).not.toContain(aged.wake.clientMessageId);
});

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

test("the wake replacing an attempt retired on its age stays inside the bound the runtime journal admits, and reaches the seat (#1771)", async () => {
  const { fixture, child, wake, rig } = await strandedManagerWake("mute-seat-key-bound", {
    seatEpoch: 173, wakeIntervalMinutes: 20, monitorPrompt: MUTE_PROMPT,
  });
  /* The original attempt is the readable composition, prompt digest and all,
     and it fits — which is why the seat got that first wake and no other. */
  expect(wake.clientMessageId).toContain(":prompt-");
  expect(wake.clientMessageId.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);

  /* The bound spent. The replacement folds the whole composition — the
     retired key's digest included — behind the project and the seat epoch,
     because the readable form of it no longer fits. */
  const past = rig(61);
  const woken = await runSeatTickCheck(fixture.project, past.deps);
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(past.sent).toHaveLength(1);
  const replacement = past.sent[0]!.clientMessageId!;
  expect(replacement).not.toBe(wake.clientMessageId);
  expect(replacement.startsWith(`seat-tick:${fixture.project}:173:digest-`)).toBe(true);
  expect(replacement.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);
  /* It landed, so the stamp the whole loop turned on finally moves, and the
     retired attempt is the only thing left fenced — crediting nothing. */
  expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 61 * MINUTE).toISOString() });
  expect(fixture.row().retiredWakes).toMatchObject([{ wake: { clientMessageId: wake.clientMessageId }, reason: "unresolved-age" }]);
  /* And the wake carried the obligations the retired attempt named. */
  expect(past.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(past.sent[0]!.text).toContain(MUTE_PROMPT);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The verdict that matters is the production validator's, not a number this
     test picked: the real journal admits the replacement key, and refuses one
     character past the bound. */
  const journal = new RuntimeJournal(path.join(fixture.dir, "key-admission.sqlite"), { structuredHosts: true });
  try {
    const admitted = journal.executeOperation(admissionCommand(wake.conversationId, replacement, past.sent[0]!.text));
    expect(admitted.receipt).toMatchObject({ idempotencyKey: replacement });
    expect(() => journal.executeOperation(admissionCommand(wake.conversationId, "k".repeat(RUNTIME_IDEMPOTENCY_KEY_LIMIT + 1), "over the bound")))
      .toThrow("idempotencyKey is invalid");
  } finally {
    journal.close();
  }
});

test("a wake whose identity crosses the bound is admitted by the real journal through the real transport, and lands (#1771)", async () => {
  const fixture = childFixture("mute-seat-real-transport");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  /* The marker an age-bound retirement leaves behind, which is what pushed the
     live project's next key past the bound. */
  fixture.seed({ releasedWake: { clientMessageId: `seat-tick:${fixture.project}:173:retired`, releasedAt: ago(fixture, 5) } });
  const { journal, client } = hostedSeat(fixture);
  try {
    const settings = { ...defaultSeatTickSettings(fixture.project), wakeIntervalMinutes: 20, reason: "this project batches its wakes", monitorPrompt: MUTE_PROMPT };
    const rig = childRig(fixture, { realWakeState: true, journal: { client }, settings, settlementNow: () => Date.now(), deliverWith: realTransport(fixture, client) });
    const record = await runSeatTickCheck(fixture.project, rig.deps);
    /* Queued by the real journal, under a key it admitted. Before the bound
       existed this check ended `failed`: the journal threw at admission, the
       claimed reservation was left delivery-uncertain, and the seat was fenced
       behind it for the hour. */
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "queued" } });
    const outstanding = fixture.row().outstandingWake!;
    expect(outstanding.clientMessageId.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);
    expect(journal.operationResult(outstanding.operationId!)?.receipt).toMatchObject({ status: "queued", idempotencyKey: outstanding.clientMessageId });
    expect(journal.effectBatch(100, ["runtime.send"]).map((effect) => effect.payload.operationId)).toEqual([outstanding.operationId]);

    /* The drain delivers it and the next check credits the plan: the stamp
       moves, the child is harvested, and the released marker is cleared. */
    journal.transitionOperation(outstanding.operationId!, "delivered");
    const landed = childRig(fixture, { realWakeState: true, journal: { client }, settings, now: fixture.now + 5 * MINUTE, settlementNow: () => Date.now(), deliverWith: realTransport(fixture, client) });
    expect(await runSeatTickCheck(fixture.project, landed.deps)).toMatchObject({ verdict: "quiet" });
    expect(landed.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: outstanding.clientMessageId, outcome: "landed" } });
    expect(fixture.row()).toMatchObject({ outstandingWake: null, releasedWake: null, lastWakeAt: new Date(fixture.now + 5 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
  } finally {
    journal.close();
  }
});

/* Outcome 2 of the issue: "prepared, with nothing delivered and nothing
   recorded" is the state to eliminate. A layer that refuses a send answers with
   a reason, and the check's own journal line — which the seat surface reads
   back as the last run's detail — is where it belongs. */
test("a wake the delivery layer would not take names the refusal on the check's journal line (#1771)", async () => {
  const fixture = childFixture("mute-seat-refusal-named");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const refused = childRig(fixture, {
    deliverWith: async () => ({ ok: false, outcome: "failed", error: "clientMessageId is longer than the 200 characters the runtime journal admits, so no send was reserved", status: 400 }),
  });
  const record = await runSeatTickCheck(fixture.project, refused.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(record!.detail).toContain("the delivery layer would not take the wake");
  expect(record!.detail).toContain("the runtime journal admits");

  /* A transport call that never came back says that instead, on its own
     project: the prepared attempt is kept either way, and the line is what
     tells an operator which of the two happened. */
  const other = childFixture("mute-seat-transport-threw");
  setAgentRegistryForTests(other.registry);
  other.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(other, 20) });
  other.seed();
  const threw = childRig(other, { deliveryThrows: true });
  const unreturned = await runSeatTickCheck(other.project, threw.deps);
  expect(unreturned).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(unreturned!.detail).toContain("the transport call for the wake did not return");
  expect(other.row().outstandingWake).not.toBeNull();
});

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

test("a completed lane the seat launched leads the wake, and stale children are counted rather than listed (#1749)", async () => {
  const fixture = childFixture("own-lane-over-stale-children");
  /* Forty children that finished a fortnight before this seat was designated,
     which is what filled every wake in the evidence. */
  const historical = Array.from({ length: 40 }, (_, n) => fixture.spawn({
    title: `historical worker ${n}`,
    turn: "terminal",
    terminalAt: ago(fixture, 20 * 24 * 60),
  }));
  fixture.seed();
  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 120) },
    pipelines: [ownLane(fixture)],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"] });
  expect(rig.sent).toHaveLength(1);
  const text = rig.sent[0]!.text;

  /* First: the line straight under the agenda's heading, which is where the
     five-item bound cuts from. */
  const agenda = text.split("\nItems:\n")[1]!.split("\n").filter((line) => line.startsWith("- "));
  expect(agenda[0]).toContain("pipeline_own_lane");
  expect(record).toMatchObject({ items: 1 });

  /* And not one of the forty is named: they are a number on one line. */
  for (const child of historical) expect(text).not.toContain(child.id);
  const summarised = text.match(/\((\d+) spawned child\(ren\) not listed/);
  expect(summarised).not.toBeNull();
  expect(Number(summarised![1])).toBeGreaterThan(0);
  expect(fixture.acknowledged()).toEqual([]);
}, 60_000);

test("an outcome harvested under an earlier seat epoch is not listed again after a rotation (#1749)", async () => {
  const fixture = childFixture("harvested-before-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal", terminalAt: ago(fixture, 240) });
  fixture.seed();
  /* Epoch 7 takes the outcome: a wake that lands is what acknowledges it. */
  const first = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The re-mint: a second turn read out of the same ledger is a NEW outcome
     identity for a conversation whose result was consumed under epoch 7, and
     its terminal instant is still the one the registry recorded then. Before
     this, the rotation's first wake carried it back to the successor. */
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });

  const rotated = childRig(fixture, {
    now: fixture.now + 61 * MINUTE,
    seat: { ...fixture.seat, seatEpoch: 8, designatedAt: ago(fixture, 120) },
  });
  const record = await runSeatTickCheck(fixture.project, rotated.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(rotated.sent).toEqual([]);
});

test("the wake a settled own lane raises composes a key the runtime journal admits (#1749)", async () => {
  const fixture = childFixture("own-lane-key-bound");
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 10) });
  /* Everything that has ever lengthened this key at once: the marker an
     age-bound retirement leaves, a monitor prompt's digest, and now a second
     reason kind beside the child's. */
  fixture.seed({ releasedWake: { clientMessageId: `seat-tick:${fixture.project}:7:retired`, releasedAt: ago(fixture, 5) } });
  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 600) },
    settings: { ...defaultSeatTickSettings(fixture.project), monitorPrompt: MUTE_PROMPT },
    pipelines: [ownLane(fixture, { state: "needs_decision", attemptState: "needs_decision" })],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled", "child-terminal"] });
  const key = rig.sent[0]!.clientMessageId!;
  expect(key.length).toBeLessThanOrEqual(RUNTIME_IDEMPOTENCY_KEY_LIMIT);

  /* The verdict that counts is the production validator's, and the same
     journal refuses one character past the bound. */
  const journal = new RuntimeJournal(path.join(fixture.dir, "own-lane-key-admission.sqlite"), { structuredHosts: true });
  try {
    expect(journal.executeOperation(admissionCommand(child.id, key, rig.sent[0]!.text)).receipt).toMatchObject({ idempotencyKey: key });
    expect(() => journal.executeOperation(admissionCommand(child.id, "k".repeat(RUNTIME_IDEMPOTENCY_KEY_LIMIT + 1), "over the bound")))
      .toThrow("idempotencyKey is invalid");
  } finally {
    journal.close();
  }
});

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

test("a child whose record is weeks old is skipped though a sweep refreshed its registry row (#1783)", async () => {
  const fixture = childFixture("swept-stale-child");
  const child = fixture.spawn({ title: "historical worker", turn: "terminal", terminalAt: null });
  ageTranscript(fixture, child.path, 20 * 24 * 60);
  sweepRegistryRow(fixture, child, "historical worker");
  fixture.seed();

  /* The condition under test, on the row itself: nothing says when this child
     ended except its transcript, and what the registry does say is younger
     than the seat. An age test reading the registry lists it. */
  const conversation = fixture.registry.conversation(child.id as never)!;
  expect(conversation.turn.terminalAt).toBeNull();
  expect(Date.parse(conversation.turn.observedAt!)).toBeGreaterThan(Date.parse(ago(fixture, 120)));

  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 120) },
    pipelines: [ownLane(fixture)],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 1 });
  const text = rig.sent[0]!.text;
  expect(text).not.toContain(child.id);
  expect(text).toContain("(1 spawned child(ren) not listed: their last activity predates this seat's designation");
  expect(fixture.acknowledged()).toEqual([]);
});

test("one child with a failed and a finished turn is one line carrying its latest state (#1783)", async () => {
  const fixture = childFixture("one-line-per-child");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  /* A second ended turn out of the same ledger: a second owed outcome for one
     child, which is how the same child reached one wake five times. */
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "error", seq: 4 });
  fixture.seed();

  const rig = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 0 });
  const text = rig.sent[0]!.text;
  /* One line, and the failure is the one it carries: the wake describes the
     child by its latest state, not once per owed row. */
  expect(text.split(child.id)).toHaveLength(2);
  expect(text).toContain(`${child.id} — iterative worker — spawned child failed, outcome unharvested`);

  /* The line stood for both rows, so the landing acknowledged both. */
  const outcomes = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project).collection.snapshot()
    .filter((row) => row.kind === "outcome");
  expect(outcomes).toHaveLength(2);
  expect(outcomes.every((row) => row.status === "acknowledged")).toBe(true);
});

test("a child whose transcript the Viewer cannot resolve is counted, never listed (#1783)", async () => {
  const fixture = childFixture("unresolvable-transcript");
  const unscanned = fixture.spawn({ title: "worker outside the roots", turn: "terminal", terminalAt: ago(fixture, 20), transcript: "outside-roots" });
  const gone = fixture.spawn({ title: "worker whose transcript is gone", turn: "terminal", terminalAt: ago(fixture, 20), transcript: "missing" });
  fixture.seed();

  const rig = childRig(fixture, {
    seat: { ...fixture.seat, designatedAt: ago(fixture, 600) },
    pipelines: [ownLane(fixture)],
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  /* No child reason at all: neither of these is work any seat can do. */
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 1 });
  const text = rig.sent[0]!.text;
  expect(text).not.toContain(unscanned.id);
  expect(text).not.toContain(gone.id);
  expect(text).toContain("(2 spawned child(ren) not listed: the Viewer cannot resolve their transcript, so no seat can read them.)");
  expect(fixture.acknowledged()).toEqual([]);
});

test("a child a delivered wake showed is not shown again until it ends another turn (#1783)", async () => {
  const fixture = childFixture("shown-once-per-state");
  const child = fixture.spawn({ title: "worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });
  fixture.seed();

  const shown = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, shown.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);

  /* An hour later, with the child in exactly the state the seat was shown. */
  const unchanged = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, unchanged.deps)).toMatchObject({ verdict: "quiet" });
  expect(unchanged.sent).toEqual([]);

  /* Its state changes: it ends another turn, and that IS owed. */
  ledger.append(generation, { kind: "turn-started", turnId: "turn-three", seq: 5 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-three", status: "error", seq: 6 });
  const moved = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, designatedAt: ago(fixture, 600) } });
  expect(await runSeatTickCheck(fixture.project, moved.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(moved.sent[0]!.text).toContain(`${child.id} — worker — spawned child failed, outcome unharvested`);
});

test("a failure this seat's own worker just had is listed beside the history that is not (#1783)", async () => {
  const fixture = childFixture("new-failure-still-listed");
  const historical = fixture.spawn({ title: "historical worker", turn: "terminal", terminalAt: null });
  ageTranscript(fixture, historical.path, 20 * 24 * 60);
  sweepRegistryRow(fixture, historical, "historical worker");
  const recent = fixture.spawn({ title: "current worker", turn: "terminal", terminalAt: ago(fixture, 15) });
  const generation = fixture.registry.conversation(recent.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "error", seq: 4 });
  fixture.seed();

  const rig = childRig(fixture, { seat: { ...fixture.seat, designatedAt: ago(fixture, 120) } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  const text = rig.sent[0]!.text;
  expect(text).toContain(`${recent.id} — current worker — spawned child failed, outcome unharvested`);
  expect(text).not.toContain(historical.id);
  expect(text).toContain("(1 spawned child(ren) not listed: their last activity predates this seat's designation");
});

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

test("a child whose last record predates the seat by weeks is skipped on the harvest and on the stall path (#1783)", async () => {
  const fixture = childFixture("aged-child-both-paths");
  /* One of each, both in the August shape: an open turn on the registry, a
     dead host, and a transcript nothing has appended to for twenty-five days.
     The first also owes an outcome, which is what puts it on the harvest. */
  const owed = fixture.spawn({ title: "august worker", turn: "busy", host: "dead" });
  endedTurnUnderADeadHost(fixture, owed, "completed", 1);
  const stalled = fixture.spawn({ title: "august stall", turn: "busy", host: "dead" });
  for (const child of [owed, stalled]) ageTranscript(fixture, child.path, 25 * 24 * 60);
  fixture.seed();

  /* The condition under test, on the rows themselves: neither child has a
     terminal instant to test, and the seat was designated two hours ago. */
  for (const child of [owed, stalled]) {
    const conversation = fixture.registry.conversation(child.id as never)!;
    expect(conversation.turn.state).toBe("busy");
    expect(conversation.turn.terminalAt).toBeNull();
  }

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat, pipelines: [ownLane(fixture)] });
  await runSeatTickCheck(fixture.project, first.deps);
  /* The stall memory saw both of them, which is what makes the second check
     the one where the stall path WOULD name them. */
  expect(fixture.row().stalledSeen).toEqual([`child:${owed.id}`, `child:${stalled.id}`]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat, pipelines: [ownLane(fixture)] });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  /* No child reason at all: not the harvest, not the stall. The wake carries
     the lane the seat launched and nothing else. */
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 1 });
  const text = second.sent[0]!.text;
  expect(text).not.toContain(owed.id);
  expect(text).not.toContain(stalled.id);
  expect(text).toContain("(2 spawned child(ren) not listed: their last activity predates this seat's designation");
  expect(fixture.acknowledged()).toEqual([]);
});

test("a child whose transcript the Viewer cannot resolve is skipped on the harvest and on the stall path (#1783)", async () => {
  const fixture = childFixture("unresolvable-child-both-paths");
  /* Spawned an hour ago — nothing about either of these is old — and neither
     transcript is one this Viewer can read: one is outside every scanner root,
     the other has gone from disk. No seat can harvest or read either, however
     recently it ran. */
  const owed = fixture.spawn({ title: "unscanned worker", turn: "busy", host: "dead", transcript: "outside-roots" });
  endedTurnUnderADeadHost(fixture, owed, "error", 1);
  const stalled = fixture.spawn({ title: "vanished worker", turn: "busy", host: "dead", transcript: "missing" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat, pipelines: [ownLane(fixture)] });
  await runSeatTickCheck(fixture.project, first.deps);
  expect(fixture.row().stalledSeen).toEqual([`child:${owed.id}`, `child:${stalled.id}`]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat, pipelines: [ownLane(fixture)] });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["own-lane-settled"], items: 1 });
  const text = second.sent[0]!.text;
  expect(text).not.toContain(owed.id);
  expect(text).not.toContain(stalled.id);
  expect(text).toContain("(2 spawned child(ren) not listed: the Viewer cannot resolve their transcript, so no seat can read them.)");
  expect(fixture.acknowledged()).toEqual([]);
});

test("a failure this seat's own worker had an hour ago is listed, once (#1783)", async () => {
  const fixture = childFixture("new-failure-listed-once");
  /* The same shape as the children above, and a different answer: this one is
     this seat's and it is an hour old, not a month. */
  const child = fixture.spawn({ title: "current worker", turn: "busy", host: "dead" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  /* The first check sees the stall; a stall is only reported once it has
     survived a second one, so this wake carries the open worker and no more. */
  const first = childRig(fixture, { seat });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);

  /* Then its host writes an ended turn to the ledger and dies over the open
     turn — the production shape exactly. The check that follows holds the same
     child on BOTH paths: an outcome nobody has harvested, and a stall that has
     now persisted across two checks. */
  endedTurnUnderADeadHost(fixture, child, "error", 1);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  expect(record).toMatchObject({ verdict: "wake", items: 1 });
  expect(record!.reasons).toContain("child-terminal");
  expect(record!.reasons).toContain("stalled");
  const text = second.sent[0]!.text;
  /* One line on the agenda, and it is the one that says what to do: the
     failure is the seat's to harvest, and the stall is the same conversation.
     Both reasons are true and the wake says both; the item list names the
     child once, which is the half a seat works from. */
  const agenda = agendaOf(text);
  expect(agenda.filter((line) => line.includes(child.id))).toEqual([
    `- [child] ${child.id} — current worker — spawned child failed, outcome unharvested`,
  ]);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* And it wakes nobody again while nothing about it moves. The outcome the
     line stood for is acknowledged, so the harvest no longer offers it; the
     stall it was shown in is the stall it is still in, so the stall path does
     not raise it a second time. The child is still open work, so the interval
     agenda still says so — once, and without the stall line under it. */
  const third = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat });
  const after = await runSeatTickCheck(fixture.project, third.deps);
  expect(after).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1 });
  const later = agendaOf(third.sent[0]!.text);
  expect(later).toEqual([`- [child] ${child.id} — current worker — spawned child running`]);
});

test("a stall one seat was shown is shown again to the seat that succeeds it (#1783)", async () => {
  const fixture = childFixture("stall-shown-across-rotation");
  /* A stall and nothing else: an open turn on the registry with no host behind
     it, spawned minutes ago, no ended turn in its ledger. It owes no outcome,
     so there is nothing a landing could acknowledge for it and nothing that
     will ever change its own record again — a dead host over an open turn
     writes no more of them. That is the case the showings record exists for,
     and therefore the case a rotation must not swallow. */
  const child = fixture.spawn({ title: "stalled worker", turn: "busy", host: "dead" });
  fixture.seed();
  const stallLine = `- [child] ${child.id} — stalled worker — child ${child.id} runs a turn the registry reports gone (host_gone_turn_open)`;

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat });
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);

  /* Epoch 7 is told, and the landing records the state it was shown in. */
  const shown = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat });
  expect((await runSeatTickCheck(fixture.project, shown.deps))!.reasons).toContain("stalled");
  expect(agendaOf(shown.sent[0]!.text)).toEqual([stallLine]);
  expect(fixture.row().childrenShown).toHaveLength(1);

  /* Same seat, nothing moved: not told again. This is what the record buys and
     what makes the question below a real one. */
  const again = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat });
  expect((await runSeatTickCheck(fixture.project, again.deps))!.reasons).not.toContain("stalled");
  expect(agendaOf(again.sent[0]!.text)).toEqual([`- [child] ${child.id} — stalled worker — spawned child running`]);

  /* The rotation. Epoch 8 was designated an hour ago, so the child's own clock
     is inside its day of grace and its transcript resolves: the first two
     clauses of the eligibility test pass for it. The third is the one at issue
     — a successor must not be answered with what its predecessor was shown,
     because for this child the token never changes again and the successor
     would then never be told at all. The showings are the seat's judgement and
     the row is projected per epoch, so the rotation drops them; the stall
     memory goes with them, which is why the successor's first check re-observes
     the stall and its second reports it, exactly as the first seat's did. */
  const successor = { ...fixture.seat, seatEpoch: 8, designatedAt: ago(fixture, 60) };
  const rotated = childRig(fixture, { now: fixture.now + 183 * MINUTE, seat: successor });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);

  const told = childRig(fixture, { now: fixture.now + 244 * MINUTE, seat: successor });
  const record = await runSeatTickCheck(fixture.project, told.deps);
  expect(record!.reasons).toContain("stalled");
  /* Once, and under the stall heading. */
  expect(agendaOf(told.sent[0]!.text).filter((line) => line.includes(child.id))).toEqual([stallLine]);
  /* And what the predecessor was shown is gone from the row rather than
     accumulated beside it: one token per child, whoever was shown it. */
  expect(fixture.row().childrenShown).toHaveLength(1);

  /* And the successor is told once, the same as its predecessor was: the
     record is per seat, not per wake. */
  const settled = childRig(fixture, { now: fixture.now + 305 * MINUTE, seat: successor });
  await runSeatTickCheck(fixture.project, settled.deps);
  expect(agendaOf(settled.sent[0]!.text).filter((line) => line.includes("reports gone"))).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * The third place the same list is read (#1783, round two review).
 *
 * The item list filters the running children; the two clauses that decide a
 * wake is WARRANTED at all did not. So a board whose only children are the
 * August workers and the unreadable one raised an interval wake every hour
 * that named nothing — the empty hourly agenda this whole mechanism exists to
 * stop sending, arriving under the reason that says work is open. One test
 * per side of that: a board of nothing but ineligible children ends quiet, and
 * a board with one eligible child beside them still wakes and names it.
 * ------------------------------------------------------------------------- */

test("a board whose only children are ineligible ends quiet rather than raising an interval wake (#1783)", async () => {
  const fixture = childFixture("ineligible-children-quiet");
  /* The production shape with the lane taken away: two workers whose hosts
     died over an open turn, one last written to twenty-five days before the
     designation and one whose transcript no scanner root holds. Nothing else
     on the board — no lane, no task, no signal. */
  const aged = fixture.spawn({ title: "august stall", turn: "busy", host: "dead" });
  ageTranscript(fixture, aged.path, 25 * 24 * 60);
  const unreadable = fixture.spawn({ title: "vanished stall", turn: "busy", host: "dead", transcript: "missing" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const first = childRig(fixture, { seat });
  /* The stall memory saw both, so the check below is the one on which the
     stall path would speak — and the one the interval clause spoke on. */
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "quiet" });
  expect(fixture.row().stalledSeen).toEqual([`child:${aged.id}`, `child:${unreadable.id}`]);
  expect(first.sent).toEqual([]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat });
  const record = await runSeatTickCheck(fixture.project, second.deps);
  /* No wake at all. Neither child is work this seat can act on, so neither is
     open work, and an hour elapsing over them is not an agenda. */
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
});

test("one eligible child beside the ineligible ones still raises the interval wake and is named (#1783)", async () => {
  const fixture = childFixture("eligible-child-still-wakes");
  /* The same two, and one worker this seat spawned minutes ago whose host is
     alive: the clause the fix narrows must still let this one through. */
  const aged = fixture.spawn({ title: "august stall", turn: "busy", host: "dead" });
  ageTranscript(fixture, aged.path, 25 * 24 * 60);
  const unreadable = fixture.spawn({ title: "vanished stall", turn: "busy", host: "dead", transcript: "missing" });
  const live = fixture.spawn({ title: "build the exporter", turn: "busy", host: "live" });
  fixture.seed();

  const seat = { ...fixture.seat, designatedAt: ago(fixture, 120) };
  const rig = childRig(fixture, {
    seat,
    childActivity: { [live.id]: { lifecycle: "running", reason: "host_alive_turn_active" } },
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1 });
  const agenda = agendaOf(rig.sent[0]!.text);
  expect(agenda).toEqual([`- [child] ${live.id} — build the exporter — spawned child running`]);
  expect(agenda.join("\n")).not.toContain(aged.id);
  expect(agenda.join("\n")).not.toContain(unreadable.id);
});
