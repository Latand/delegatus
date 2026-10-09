import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { AgentRegistry, setAgentRegistryForTests, type ProcessIdentity } from "@/lib/agent/registry";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { statePath } from "@/lib/configDir";
import { completeViewerReleaseDemotion } from "@/lib/viewerInstrumentation";
import { defaultPipelinePorts } from "@/lib/pipelines/engine";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { HostState, RuntimeEvent } from "./engineHost";
import { durableRuntimeEventTailSeq, FileRuntimeEventStore, readHostTurnRecord } from "./eventStore";
import { createFakeDeliveryLedger, FakeEngineHost, type FakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import type { StructuredHostAdoptionFilter } from "./registry";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import { INTERRUPTED_CODEX_CONTINUATION_TEXT } from "./recoveryNotices";
import { recoverDeadStructuredConversation, StructuredRecoveryHeldForUpdateError } from "./structuredRecovery";
import {
  adoptStructuredHostsAtStartup,
  releaseStructuredHostsForViewerDemotion,
  releaseUnpublishedStartupHostsForDemotion,
  structuredStartupDeferral,
} from "./startup";
import {
  bindStructuredDeliveryQueue,
  recordDemotionInterruption,
  releaseStructuredDeliveryHostsForDemotion,
} from "./structuredDeliveryController";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";

/*
 * A Viewer release cuts every turn its structured hosts are running (#1835).
 * These cases drive the real release seam and the real successor startup
 * against one isolated registry, one runtime journal and fake engine hosts:
 * the incumbent releases, its controller state is dropped the way its process
 * exit drops it, and a successor with its own registry handle adopts the rows.
 * The runtime journal is the same one throughout — the runtime host outlives
 * the Viewer, so its epoch never moves across these releases.
 */

/** Invented session ids, assembled so no id-shaped literal is published. */
function cutSessionId(index: number): string {
  return ["18350000", "0000", "4000", "8000", String(index).padStart(12, "0")].join("-");
}

const INCUMBENT_VIEWER: ProcessIdentity = { pid: 2_000_001_001, startIdentity: "incumbent-viewer" };
const CUT_TURN = "turn-cut-by-release";

const isolatedEnvironmentKeys = ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR"] as const;
let previousEnvironment: Record<string, string | undefined> = {};
let directory = "";
/** Every deferral re-probe a boot scheduled. No case lets one reach a real
    timer: a case that exercises the re-probe runs the callback itself. */
let scheduledProbes: Array<{ callback: () => void; delayMs: number }> = [];

beforeEach(() => {
  scheduledProbes = [];
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-interruption-"));
  previousEnvironment = Object.fromEntries(isolatedEnvironmentKeys.map((key) => [key, process.env[key]]));
  const isolated = {
    HOME: path.join(directory, "home"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    LLV_STATE_DIR: path.join(directory, "state"),
    TMPDIR: path.join(directory, "tmp"),
  };
  for (const value of Object.values(isolated)) fs.mkdirSync(value, { recursive: true });
  Object.assign(process.env, isolated);
});

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { registry: new AgentRegistry(path.join(directory, "agent-registry.json")), client: null });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.chmodSync(directory, 0o700);
  const obligations = path.join(directory, "interruption-obligations");
  if (fs.existsSync(obligations)) fs.chmodSync(obligations, 0o700);
  fs.rmSync(directory, { recursive: true, force: true });
});

function journalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    /* The host answers `session-read` from its journal; delivery reads the
       session through it before it enqueues a continuation. */
    readSession: async (identity) => journal.readSession(identity),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

/** A turn in the middle of a tool call, stamped a minute ago. */
function midToolTranscript(engine: "codex" | "claude", toolName = "Bash"): Record<string, unknown>[] {
  const at = (offset: number) => new Date(Date.now() - 60_000 + offset * 1_000).toISOString();
  return engine === "codex"
    ? [
      { timestamp: at(0), type: "event_msg", payload: { type: "user_message", message: "run the suite" } },
      { timestamp: at(1), type: "response_item", payload: { type: "function_call", call_id: "call-cut", name: "shell" } },
    ]
    : [
      { type: "user", timestamp: at(0), message: { content: "run the suite" } },
      { type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", id: "tool-cut", name: toolName }] } },
    ];
}

interface CutConversation {
  registryFile: string;
  engine: "codex" | "claude";
  sessionId: string;
  hostKey: string;
  conversationId: `conversation_${string}`;
  artifactPath: string;
}

/** A structured row the incumbent Viewer owns, its engine mid-turn. */
function incumbentConversation(
  engine: "codex" | "claude",
  sessionId: string,
  engineProcess: ProcessIdentity,
  records: Record<string, unknown>[] = midToolTranscript(engine),
  /** What the registry last observed of the turn; a spawn that has written
      no record yet was never observed. */
  observed: "busy" | "never" = "busy",
): CutConversation {
  const registryFile = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(registryFile);
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine,
    path: artifactPath,
    accountId: null,
    launchProfile,
    turn: observed === "busy"
      ? { state: "busy", source: "lifecycle", terminalAt: null }
      : { state: "unknown", source: "empty", terminalAt: null },
    observedAt: new Date(Date.now() - 30_000).toISOString(),
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile,
    status: "live",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:incumbent",
      process: null,
      eventCursor: 4,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const claimed = registry.claimStructuredHost(key, INCUMBENT_VIEWER, { allowUnhosted: true });
  if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("incumbent claim was unavailable");
  if (!registry.setStructuredHostClaimed(key, {
    ...claimed.structuredHost,
    endpoint: "fake:incumbent",
    process: engineProcess,
    activeTurnRef: CUT_TURN,
  }, "live", claimed.claimOwner, claimed.claimEpoch)) throw new Error("incumbent claim was lost");
  return {
    registryFile,
    engine,
    sessionId,
    hostKey: `${engine}:${sessionId}`,
    conversationId: registry.canonicalConversationId(conversation.id),
    artifactPath,
  };
}

function hostFor(ledger: FakeDeliveryLedger, state?: Partial<HostState>, release?: () => Promise<void>) {
  const host = new FakeEngineHost(ledger, {
    status: "idle",
    sessionKey: "fake",
    endpoint: "fake:host",
    pid: null,
    processStartIdentity: null,
    eventCursor: 0,
    protocolVersion: "test",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
    ...state,
  });
  if (release) host.release = release;
  return Object.assign(host, { onStateChange: () => () => {} });
}

/** The incumbent releases every host it owns, as its demotion does. */
async function releaseIncumbent(
  cut: readonly CutConversation[],
  journal: RuntimeJournal,
  engineProcess: (conversation: CutConversation) => ProcessIdentity,
  options: { failRelease?: boolean } = {},
): Promise<{ exitCode: number | null; incumbentLedger: FakeDeliveryLedger }> {
  const registry = new AgentRegistry(cut[0]!.registryFile);
  const incumbentLedger = createFakeDeliveryLedger();
  const hosts = cut.map((conversation) => {
    const owner = engineProcess(conversation);
    return {
      key: { engine: conversation.engine, sessionId: conversation.sessionId },
      host: hostFor(incumbentLedger, {
        status: "active",
        pid: owner.pid,
        processStartIdentity: owner.startIdentity,
        activeTurnRef: CUT_TURN,
      }, options.failRelease ? async () => { throw new Error("engine did not stop"); } : undefined),
    };
  });
  await bindStructuredDeliveryQueue(hosts as never, { registry, client: journalClient(journal) });
  let exitCode: number | null = null;
  await completeViewerReleaseDemotion(
    async () => {},
    (code) => { exitCode = code; },
    () => {},
    () => releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" }),
  );
  /* The incumbent's process exits: nothing it held in memory survives. */
  await bindStructuredDeliveryQueue([], { registry, client: null });
  return { exitCode, incumbentLedger };
}

/** One successor boot: its own registry handle, adopting every row the
    startup filter selects onto a fresh fake host owned by this process. */
async function successorBoot(
  registryFile: string,
  journal: RuntimeJournal | null,
  ledger: FakeDeliveryLedger,
  options: {
    seats?: () => OrchestratorSeat[];
    adoptionFails?: boolean;
    /** Claude adoption fails after Codex adopted, so the pass ends holding
        Codex hosts it never published. */
    claudeAdoptionFails?: boolean;
    /** The engine each adopted host reports: a process that outlived the
        previous Viewer, still running a turn. */
    survivingEngine?: { process: ProcessIdentity; activeTurnRef: string };
    /** The Viewer claiming the rows; this test process unless a case needs a
        Viewer that has since exited. */
    viewer?: ProcessIdentity;
    /** Runs inside adoption, after the rows are claimed. */
    duringAdoption?: (registry: AgentRegistry) => Promise<void>;
    /** Read on every health probe of an adopted host: true makes it reject. */
    healthFails?: () => boolean;
    /** The registry handle of a Viewer that runs more than one pass. */
    registry?: AgentRegistry;
    /** Runs when adoption starts, after the pass decided its rows and before
        any of them is claimed. */
    beforeAdoption?: () => void;
    /** The host ledger reader, for a case whose ledger moves under the read. */
    readHostTurnRecord?: typeof readHostTurnRecord;
  } = {},
): Promise<{ adopted: string[]; error: unknown }> {
  const registry = options.registry ?? new AgentRegistry(registryFile);
  let adoptionStarted = false;
  const adopted: string[] = [];
  const successor = options.viewer ?? { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const adopt = async (
    engine: "codex" | "claude",
    received: AgentRegistry,
    shouldAdopt: StructuredHostAdoptionFilter,
  ) => {
    if (!adoptionStarted) {
      adoptionStarted = true;
      options.beforeAdoption?.();
    }
    if (options.adoptionFails || (engine === "claude" && options.claudeAdoptionFails)) {
      throw new Error("successor exited before adopting its hosts");
    }
    const surviving = options.survivingEngine;
    return Object.values(received.readOnlySnapshot().entries).flatMap((entry) => {
      if (entry.key.engine !== engine || !entry.structuredHost || !shouldAdopt(entry)) return [];
      const claimed = received.claimStructuredHost(entry.key, successor, { allowUnhosted: true });
      if (!claimed?.structuredHost || !claimed.claimOwner) return [];
      if (!received.setStructuredHostClaimed(entry.key, {
        ...claimed.structuredHost,
        endpoint: `fake:successor-${entry.key.sessionId}`,
        process: surviving?.process ?? successor,
        activeTurnRef: surviving?.activeTurnRef ?? null,
      }, surviving ? "live" : "idle", claimed.claimOwner, claimed.claimEpoch)) return [];
      adopted.push(`${engine}:${entry.key.sessionId}`);
      const host = hostFor(ledger, surviving
        ? {
          status: "active",
          pid: surviving.process.pid,
          processStartIdentity: surviving.process.startIdentity,
          activeTurnRef: surviving.activeTurnRef,
        }
        : undefined);
      const healthFails = options.healthFails;
      if (healthFails) {
        const health = host.health.bind(host);
        host.health = async () => {
          if (healthFails()) throw new Error("engine host stopped answering health probes");
          return await health();
        };
      }
      return [{ key: entry.key, host: host as never }];
    });
  };
  const adoptThenRun = async (
    engine: "codex" | "claude",
    received: AgentRegistry,
    shouldAdopt: StructuredHostAdoptionFilter,
  ) => {
    const hosts = await adopt(engine, received, shouldAdopt);
    if (hosts.length > 0) await options.duringAdoption?.(received);
    return hosts;
  };
  let error: unknown = null;
  try {
    await adoptStructuredHostsAtStartup({
      registry,
      client: journal ? journalClient(journal) : null,
      orchestratorSeats: options.seats ?? (() => []),
      schedule: (callback, delayMs) => {
        scheduledProbes.push({ callback, delayMs });
        return { unref() {} };
      },
      ...(options.readHostTurnRecord ? { readHostTurnRecord: options.readHostTurnRecord } : {}),
      adopt: async (received, _optionsFor, _env, shouldAdopt = () => true) =>
        adoptThenRun("codex", received, shouldAdopt) as never,
      adoptClaude: async (received, _optionsFor, _env, shouldAdopt = () => true) =>
        adoptThenRun("claude", received, shouldAdopt) as never,
    });
  } catch (caught) {
    error = caught;
  }
  return { adopted, error };
}

/** Lets the delivery queue drain, bounded, without deciding the outcome: the
    assertion that follows is the verdict. */
async function settle(predicate: () => boolean, milliseconds = 400): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline && !predicate()) await Bun.sleep(5);
  await Bun.sleep(30);
}

function deadEngine(pid: number): ProcessIdentity {
  return captureProcessIdentity(pid, undefined, `engine-${pid}`);
}

function continuationsIn(ledger: FakeDeliveryLedger): string[] {
  return ledger.writes.map((entry) => entry.text ?? "");
}

function expectDeploymentContinuation(text: string | undefined): void {
  expect(text).toContain("deployment interrupted your turn");
  expect(text).toContain("Inspect your transcript");
  expect(text).toContain("preserved work");
  expect(text).toContain("Re-run any interrupted operation");
  expect(text).toContain("Run long commands in the foreground");
  expect(text).toContain("stage_report");
}

test.each(["claude", "codex"] as const)(
  "a %s turn cut mid-tool by a Viewer release resumes once on the successor while the runtime-host epoch stays unchanged",
  async (engine) => {
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    try {
      const cut = incumbentConversation(engine, engine === "codex"
        ? cutSessionId(1)
        : cutSessionId(2), deadEngine(2_000_001_101));
      const { exitCode, incumbentLedger } = await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_101));
      expect(exitCode).toBe(0);

      const ledger = createFakeDeliveryLedger();
      const boot = await successorBoot(cut.registryFile, journal, ledger);
      expect(boot.error).toBeNull();
      expect(boot.adopted).toEqual([cut.hostKey]);
      await settle(() => ledger.writes.length > 0);

      const writes = continuationsIn(ledger);
      expect(writes).toHaveLength(1);
      expectDeploymentContinuation(writes[0]);
      expect(incumbentLedger.writes).toEqual([]);
    } finally {
      journal.close();
    }
  },
);

test("a cut turn stays owed while runtime-host succession lags past three minutes, then resumes once", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(3), deadEngine(2_000_001_103));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_103));

    /* No runtime host answers yet: the successor launches nothing. */
    const ledger = createFakeDeliveryLedger();
    const early = await successorBoot(cut.registryFile, null, ledger);
    expect(early.error).not.toBeNull();
    expect(early.adopted).toEqual([]);

    const realNow = Date.now;
    const lateBy = 4 * 60_000;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + lateBy);
    try {
      const late = await successorBoot(cut.registryFile, journal, ledger);
      expect(late.error).toBeNull();
      await settle(() => ledger.writes.length > 0);
    } finally {
      clock.mockRestore();
    }
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);
  } finally {
    journal.close();
  }
});

test("failed demotion cleanup keeps the obligation, and a surviving owner keeps it owed until adoption takes the row", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  /* A real process this test started stands in for the engine the release
     could not stop. */
  const survivorProcess = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const survivor = captureProcessIdentity(survivorProcess.pid);
  try {
    const cut = incumbentConversation("claude", cutSessionId(4), survivor);
    const { exitCode } = await releaseIncumbent([cut], journal, () => survivor, { failRelease: true });
    expect(exitCode).toBe(1);

    const ledger = createFakeDeliveryLedger();
    const contested = await successorBoot(cut.registryFile, journal, ledger);
    expect(contested.adopted).toEqual([]);
    await settle(() => ledger.writes.length > 0, 100);
    expect(ledger.writes).toEqual([]);

    survivorProcess.kill();
    await survivorProcess.exited;
    const adopted = await successorBoot(cut.registryFile, journal, ledger);
    expect(adopted.error).toBeNull();
    expect(adopted.adopted).toEqual([cut.hostKey]);
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);
  } finally {
    if (survivorProcess.exitCode === null) survivorProcess.kill();
    journal.close();
  }
});

test("a turn cut on a host startup adopted but never published resumes once with the deployment continuation", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(13), deadEngine(2_000_001_113));
    const ledger = createFakeDeliveryLedger();
    /* This Viewer's startup adopts the row onto an engine still mid-turn, then
       fails before publishing it: its retry loop holds the host unpublished. */
    const retrying = await successorBoot(cut.registryFile, journal, ledger, {
      claudeAdoptionFails: true,
      viewer: { pid: 2_000_001_002, startIdentity: "retrying-viewer" },
      survivingEngine: { process: deadEngine(2_000_001_213), activeTurnRef: "turn-on-unpublished-host" },
    });
    expect(retrying.error).not.toBeNull();
    expect(retrying.adopted).toEqual([cut.hostKey]);

    /* The next deploy demotes that Viewer through its real release seam. */
    const registry = new AgentRegistry(cut.registryFile);
    setAgentRegistryForTests(registry);
    const exitCodes: number[] = [];
    try {
      await completeViewerReleaseDemotion(
        async () => {},
        (code) => { exitCodes.push(code); },
        () => {},
        async () => {
          await releaseUnpublishedStartupHostsForDemotion({ boundary: "viewer-release:test-deploy" });
          await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
        },
      );
    } finally {
      setAgentRegistryForTests(null);
    }
    expect(exitCodes).toEqual([0]);
    await bindStructuredDeliveryQueue([], { registry, client: null });

    const successor = await successorBoot(cut.registryFile, journal, ledger);
    expect(successor.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);
  } finally {
    journal.close();
  }
});

test("an obligation the release cannot write to its directory still reaches the successor, which resumes the turn once", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(12), deadEngine(2_000_001_112));
    const obligations = path.join(path.dirname(cut.registryFile), "interruption-obligations");
    fs.mkdirSync(obligations, { recursive: true });
    fs.chmodSync(obligations, 0o500);
    const { exitCode } = await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_112));
    fs.chmodSync(obligations, 0o700);

    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);

    /* The imported record is the one the next boot reads: nothing more. */
    await bindStructuredDeliveryQueue([], { registry: new AgentRegistry(cut.registryFile), client: null });
    const again = createFakeDeliveryLedger();
    await successorBoot(cut.registryFile, journal, again);
    await settle(() => again.writes.length > 0, 150);
    expect(again.writes).toEqual([]);
    /* Recorded durably, so the release itself did not fail. */
    expect(exitCode).toBe(0);
  } finally {
    journal.close();
  }
});

test("a host whose obligation cannot be recorded anywhere is left running and the demotion reports it", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(13), deadEngine(2_000_001_113));
    const registry = new AgentRegistry(cut.registryFile);
    const released: string[] = [];
    await bindStructuredDeliveryQueue([{
      key: { engine: "claude", sessionId: cut.sessionId },
      host: hostFor(createFakeDeliveryLedger(), {
        status: "active", pid: 2_000_001_113, processStartIdentity: "engine-2000001113", activeTurnRef: CUT_TURN,
      }, async () => { released.push(cut.hostKey); }) as never,
    }], { registry, client: journalClient(journal) });
    const unwritable = {
      list: () => [],
      record: () => { throw new Error("obligation storage is unavailable"); },
      update: () => null,
      withdraw: () => false,
    };
    let exitCode = null as number | null;
    const reported: unknown[] = [];
    const logged = spyOn(console, "error").mockImplementation((...args: unknown[]) => { reported.push(args); });
    try {
      await completeViewerReleaseDemotion(async () => {}, (code) => { exitCode = code; }, () => {}, () =>
        releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:unwritable", store: unwritable }));
    } finally {
      logged.mockRestore();
    }
    expect(released).toEqual([]);
    expect(exitCode).toBe(1);
    expect(JSON.stringify(reported, (_key, value) => value instanceof Error ? value.message : value))
      .toContain("obligation storage is unavailable");
  } finally {
    journal.close();
  }
});

test("restarts between recording, admitting and recording the admission deliver one continuation, never two", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(5), deadEngine(2_000_001_105));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_105));

    /* The first successor dies before it adopts anything. */
    const firstLedger = createFakeDeliveryLedger();
    const first = await successorBoot(cut.registryFile, journal, firstLedger, { adoptionFails: true });
    expect(first.error).not.toBeNull();

    /* The second admits the continuation, then cannot write down that it did. */
    const obligations = path.join(path.dirname(cut.registryFile), "interruption-obligations");
    if (fs.existsSync(obligations)) fs.chmodSync(obligations, 0o500);
    const secondLedger = createFakeDeliveryLedger();
    await successorBoot(cut.registryFile, journal, secondLedger);
    await settle(() => secondLedger.writes.length > 0);
    if (fs.existsSync(obligations)) fs.chmodSync(obligations, 0o700);
    await bindStructuredDeliveryQueue([], { registry: new AgentRegistry(cut.registryFile), client: null });

    /* The third finds the obligation still owed and replays its own key. */
    const thirdLedger = createFakeDeliveryLedger();
    const third = await successorBoot(cut.registryFile, journal, thirdLedger);
    expect(third.error).toBeNull();
    await settle(() => thirdLedger.writes.length > 0, 150);

    const writes = [...firstLedger.writes, ...secondLedger.writes, ...thirdLedger.writes]
      .map((entry) => entry.text ?? "");
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);
  } finally {
    journal.close();
  }
});

test("provider recovery bookkeeping written after the cut does not discharge the continuation", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(6), deadEngine(2_000_001_106));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_106));
    /* What a resumed Claude CLI writes on its own: the replayed continuation
       prompt, a synthetic no-op answer and a result closing the "turn". */
    const now = new Date().toISOString();
    fs.appendFileSync(cut.artifactPath, [
      { type: "user", timestamp: now, message: { content: "Continue from where you left off." } },
      { type: "assistant", timestamp: now, message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
      { type: "result", timestamp: now, subtype: "success" },
    ].map((record) => `${JSON.stringify(record)}\n`).join(""));

    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);
  } finally {
    journal.close();
  }
});

test("a message that reaches the cut conversation first discharges the obligation and nothing else is sent", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(7), deadEngine(2_000_001_107));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_107));
    await Bun.sleep(5);

    /* The operator writes while the successor is still coming up. */
    const human = await enqueueStructuredMessage({
      path: cut.artifactPath,
      conversationId: cut.conversationId,
      clientMessageId: "operator-message-after-deploy",
      text: "the deploy is done; where are we?",
      images: [],
    }, {
      enabled: () => true,
      client: () => null,
      registry: () => new AgentRegistry(cut.registryFile),
      requestMigrationTick: () => {},
    });
    expect(human).toMatchObject({ ok: true, outcome: "held" });

    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    /* The migration controller drains held work once the host is published. */
    const registry = new AgentRegistry(cut.registryFile);
    await drainHeldDeliveries(cut.conversationId, {
      deliver: async ({ delivery, path: deliveryPath, clientMessageId }) =>
        await deliverHeldStructuredMessage({
          conversationId: cut.conversationId,
          path: deliveryPath,
          deliveryId: delivery.id,
          clientMessageId,
          text: delivery.text,
          command: delivery.command,
        }, {
          enabled: () => true,
          client: () => journalClient(journal),
          registry: () => registry,
        }) ?? "delivery-uncertain",
    }, registry);
    await settle(() => ledger.writes.length > 1, 300);
    expect(continuationsIn(ledger)).toEqual(["the deploy is done; where are we?"]);
  } finally {
    journal.close();
  }
});

/** The runtime host's own row for the cut conversation: it outlives the
    Viewer, so a send can be admitted before any successor host is up. */
function runtimeSession(journal: RuntimeJournal, cut: CutConversation): void {
  journal.append({
    scope: { type: "session", id: cut.conversationId },
    kind: "session-status",
    payload: {
      conversationId: cut.conversationId,
      sessionKey: { engine: cut.engine, sessionId: cut.sessionId },
      hostKind: cut.engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: cut.artifactPath,
      capabilities: { steer: cut.engine === "codex", structuredAttention: true },
    },
  });
}

/** An operator send the runtime host admits itself, with no Viewer
    reservation: only its receipt says the conversation was taken up. */
function operatorSend(journal: RuntimeJournal, cut: CutConversation, idempotencyKey: string, text: string) {
  return journal.executeOperation({
    kind: "send",
    operationId: `${idempotencyKey}-operation`,
    idempotencyKey,
    conversationId: cut.conversationId,
    text,
    policy: "queue",
  }).receipt;
}

test("a send the runtime admitted before the successor boots discharges the obligation and nothing else is sent", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(10), deadEngine(2_000_001_110));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_110));
    runtimeSession(journal, cut);
    await Bun.sleep(5);

    const admitted = operatorSend(journal, cut, "operator-send-before-boot", "status after the deploy?");
    expect(admitted.status).not.toBe("rejected");

    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 1, 300);
    expect(continuationsIn(ledger)).toEqual(["status after the deploy?"]);
  } finally {
    journal.close();
  }
});

test("a send the runtime admits while the successor is adopting discharges the obligation and nothing else is sent", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(11), deadEngine(2_000_001_111));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_111));
    runtimeSession(journal, cut);

    const ledger = createFakeDeliveryLedger();
    let receipt: { status: string } | null = null;
    const boot = await successorBoot(cut.registryFile, journal, ledger, {
      duringAdoption: async () => {
        await Bun.sleep(5);
        receipt = operatorSend(journal, cut, "operator-send-during-adoption", "are you back?");
      },
    });
    expect(boot.error).toBeNull();
    expect(receipt).not.toBeNull();
    expect(receipt!.status).not.toBe("rejected");
    await settle(() => ledger.writes.length > 0, 300);
    expect(continuationsIn(ledger)).toEqual(["are you back?"]);
  } finally {
    journal.close();
  }
});

function seatFor(project: string, seatEpoch: number, cut: CutConversation): OrchestratorSeat {
  return {
    project,
    seatEpoch,
    conversationId: cut.conversationId,
    path: cut.artifactPath,
    mandate: "run the checkpoint loop",
    promptVersion: null,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: `seat-${project}-${seatEpoch}`, mode: "existing", launchId: null, error: null },
    designatedAt: "2026-09-19T00:00:00.000Z",
    activatedAt: "2026-09-19T00:00:01.000Z",
  };
}

test("a seat cut by the deploy it requested resumes once with the deployment continuation", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation(
      "claude",
      cutSessionId(8),
      deadEngine(2_000_001_108),
      midToolTranscript("claude", "mcp__viewer__deploy_exact_sha"),
    );
    const seat = seatFor("seat-deployer", 7, cut);
    const registry = new AgentRegistry(cut.registryFile);
    const incumbentLedger = createFakeDeliveryLedger();
    await bindStructuredDeliveryQueue([{
      key: { engine: "claude", sessionId: cut.sessionId },
      host: hostFor(incumbentLedger, {
        status: "active", pid: 2_000_001_108, processStartIdentity: "engine-2000001108", activeTurnRef: CUT_TURN,
      }) as never,
    }], { registry, client: journalClient(journal) });
    let exitCode = null as number | null;
    await completeViewerReleaseDemotion(async () => {}, (code) => { exitCode = code; }, () => {}, () =>
      releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:seat-deploy", seats: () => [seat] }));
    expect(exitCode).toBe(0);
    await bindStructuredDeliveryQueue([], { registry, client: null });

    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger, { seats: () => [seat] });
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 1, 300);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expectDeploymentContinuation(writes[0]);

    /* A second boot of the same successor state sends nothing more. */
    await bindStructuredDeliveryQueue([], { registry: new AgentRegistry(cut.registryFile), client: null });
    const again = createFakeDeliveryLedger();
    await successorBoot(cut.registryFile, journal, again, { seats: () => [seat] });
    await settle(() => again.writes.length > 0, 150);
    expect(again.writes).toEqual([]);
  } finally {
    journal.close();
  }
});

test("a seat rotated before the successor adopts it is owed nothing", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(9), deadEngine(2_000_001_109));
    const seat = seatFor("seat-rotating", 3, cut);
    const registry = new AgentRegistry(cut.registryFile);
    await bindStructuredDeliveryQueue([{
      key: { engine: "claude", sessionId: cut.sessionId },
      host: hostFor(createFakeDeliveryLedger(), {
        status: "active", pid: 2_000_001_109, processStartIdentity: "engine-2000001109", activeTurnRef: CUT_TURN,
      }) as never,
    }], { registry, client: journalClient(journal) });
    await completeViewerReleaseDemotion(async () => {}, () => {}, () => {}, () =>
      releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:rotation", seats: () => [seat] }));
    await bindStructuredDeliveryQueue([], { registry, client: null });

    const rotated: OrchestratorSeat = { ...seat, seatEpoch: 4, conversationId: "conversation_00000000-0000-4000-8000-00000000rota" };
    const ledger = createFakeDeliveryLedger();
    await successorBoot(cut.registryFile, journal, ledger, { seats: () => [rotated] });
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger).filter((text) => text.includes("deployment interrupted"))).toEqual([]);
  } finally {
    journal.close();
  }
});

function obligationsFor(registryFile: string) {
  return interruptionObligationStore(interruptionObligationDirectory(registryFile)).list();
}

test("an unpublished host the release cannot hand over still lets the published hosts record their cuts and resume once", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const unpublished = incumbentConversation("codex", cutSessionId(14), deadEngine(2_000_001_114));
    const published = incumbentConversation("claude", cutSessionId(15), deadEngine(2_000_001_115));
    /* Startup adopts the Codex row onto an engine still mid-turn and fails
       before publishing it; that host then stops answering health probes. */
    let unhealthy = false;
    const retrying = await successorBoot(unpublished.registryFile, journal, createFakeDeliveryLedger(), {
      claudeAdoptionFails: true,
      viewer: { pid: 2_000_001_002, startIdentity: "retrying-viewer" },
      survivingEngine: { process: deadEngine(2_000_001_214), activeTurnRef: "turn-on-unpublished-host" },
      healthFails: () => unhealthy,
    });
    expect(retrying.adopted).toEqual([unpublished.hostKey]);
    const restartCuts = obligationsFor(unpublished.registryFile);
    expect(restartCuts.map((cut) => [cut.reason, cut.hostKey]).sort()).toEqual([
      ["viewer-restart", unpublished.hostKey],
      ["viewer-restart", published.hostKey],
    ].sort());
    unhealthy = true;

    const registry = new AgentRegistry(published.registryFile);
    const released: string[] = [];
    await bindStructuredDeliveryQueue([{
      key: { engine: "claude", sessionId: published.sessionId },
      host: hostFor(createFakeDeliveryLedger(), {
        status: "active", pid: 2_000_001_115, processStartIdentity: "engine-2000001115", activeTurnRef: CUT_TURN,
      }, async () => { released.push(published.hostKey); }) as never,
    }], { registry, client: journalClient(journal) });
    setAgentRegistryForTests(registry);
    const exitCodes: number[] = [];
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await completeViewerReleaseDemotion(async () => {}, (code) => { exitCodes.push(code); }, () => {}, () =>
        releaseStructuredHostsForViewerDemotion({ boundary: "viewer-release:partial-cleanup" }));
    } finally {
      logged.mockRestore();
      setAgentRegistryForTests(null);
    }
    expect(exitCodes).toEqual([1]);
    expect(released).toEqual([published.hostKey]);
    /* The retrying boot was itself a restart and recorded the cuts it found;
       the release records its own for the host it handed over. */
    const cuts = obligationsFor(published.registryFile);
    expect(cuts.map((cut) => [cut.reason, cut.hostKey]).sort()).toEqual([
      ["viewer-restart", unpublished.hostKey],
      ["viewer-restart", published.hostKey],
      ["viewer-release", published.hostKey],
    ].sort());
    const releaseCut = cuts.find((cut) => cut.reason === "viewer-release")!;
    expect(releaseCut.conversationId).toBe(published.conversationId);
    await bindStructuredDeliveryQueue([], { registry, client: null });
    /* The successor boots in this same test process, where the unpublished
       handle is still retained; the probe answers again so it only sees it as
       a host that outlived its Viewer. */
    unhealthy = false;

    const ledger = createFakeDeliveryLedger();
    const successor = await successorBoot(published.registryFile, journal, ledger);
    expect(successor.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    const continuations = continuationsIn(ledger).filter((text) => text.includes("deployment interrupted"));
    expect(continuations).toHaveLength(1);
    expectDeploymentContinuation(continuations[0]);
    const settled = obligationsFor(published.registryFile);
    expect(settled.find((cut) => cut.id === releaseCut.id)?.operationId).toBe(
      ledger.writes.find((write) => write.text === continuations[0])!.id,
    );
    expect(settled.find((cut) => cut.id === restartCuts.find((cut) => cut.hostKey === published.hostKey)!.id))
      .toMatchObject({ state: "discharged", resolution: "a newer cut of this conversation owes its one continuation" });
    await successorBoot(published.registryFile, journal, ledger);
    await settle(() => false, 50);
    expect(continuationsIn(ledger).filter((text) => text.includes("deployment interrupted"))).toEqual(continuations);
  } finally {
    journal.close();
  }
});

test("one published host failing its health probe does not cut short the other hosts' records", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const failing = incumbentConversation("codex", cutSessionId(16), deadEngine(2_000_001_116));
    const recorded = incumbentConversation("claude", cutSessionId(17), deadEngine(2_000_001_117));
    const registry = new AgentRegistry(recorded.registryFile);
    const released: string[] = [];
    const brokenHost = hostFor(createFakeDeliveryLedger(), {}, async () => { released.push(failing.hostKey); });
    let unhealthy = false;
    const brokenHealth = brokenHost.health.bind(brokenHost);
    brokenHost.health = async () => {
      if (unhealthy) throw new Error("engine host stopped answering health probes");
      return await brokenHealth();
    };
    const slowHost = hostFor(createFakeDeliveryLedger(), {
      status: "active", pid: 2_000_001_117, processStartIdentity: "engine-2000001117", activeTurnRef: CUT_TURN,
    }, async () => { released.push(recorded.hostKey); });
    const slowHealth = slowHost.health.bind(slowHost);
    slowHost.health = async () => {
      await Bun.sleep(40);
      return await slowHealth();
    };
    await bindStructuredDeliveryQueue([
      { key: { engine: "codex", sessionId: failing.sessionId }, host: brokenHost as never },
      { key: { engine: "claude", sessionId: recorded.sessionId }, host: slowHost as never },
    ], { registry, client: journalClient(journal) });
    unhealthy = true;

    let failure: unknown = null;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:one-unhealthy" });
    } catch (error) {
      failure = error;
    } finally {
      logged.mockRestore();
    }
    /* Read the moment the release reports: the process exits right after. */
    const onDisk = obligationsFor(recorded.registryFile).map((obligation) => obligation.conversationId);
    expect(failure).not.toBeNull();
    expect(onDisk).toEqual([recorded.conversationId]);
    expect(released).toEqual([recorded.hostKey]);
    await bindStructuredDeliveryQueue([], { registry, client: null });

    const ledger = createFakeDeliveryLedger();
    const successor = await successorBoot(recorded.registryFile, journal, ledger);
    expect(successor.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    const continuations = continuationsIn(ledger).filter((text) => text.includes("deployment interrupted"));
    expect(continuations).toHaveLength(1);
    expectDeploymentContinuation(continuations[0]);
  } finally {
    journal.close();
  }
});

test("a submitted continuation whose reservation was compacted away is resolved, and no later boot sends it again", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(18), deadEngine(2_000_001_118));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_118));
    const ledger = createFakeDeliveryLedger();
    const first = await successorBoot(cut.registryFile, journal, ledger);
    expect(first.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toHaveLength(1);
    const [submitted] = obligationsFor(cut.registryFile);
    expect(submitted?.state).toBe("submitted");
    await bindStructuredDeliveryQueue([], { registry: new AgentRegistry(cut.registryFile), client: null });

    /* Later sends push the settled reservation out of the per-conversation
       window, and compaction drops it. */
    const registry = new AgentRegistry(cut.registryFile) as unknown as {
      mutate<T>(fn: (file: { heldDeliveries: Record<string, { clientMessageId: string | null }> }) => T): T;
    };
    registry.mutate((file) => {
      for (const [id, delivery] of Object.entries(file.heldDeliveries)) {
        if (delivery.clientMessageId === submitted!.id) delete file.heldDeliveries[id];
      }
    });

    const again = createFakeDeliveryLedger();
    const next = await successorBoot(cut.registryFile, journal, again);
    expect(next.error).toBeNull();
    await settle(() => again.writes.length > 0, 150);
    expect(again.writes).toEqual([]);
    expect(obligationsFor(cut.registryFile)[0]).toMatchObject({ id: submitted!.id, state: "delivered" });
  } finally {
    journal.close();
  }
});

test("a seat that names an alias of the cut conversation is recorded on the obligation", async () => {
  const cut = incumbentConversation("claude", cutSessionId(19), deadEngine(2_000_001_119));
  const alias = ["conversation_18350000", "0000", "4000", "8000", "0000000alias"].join("-") as `conversation_${string}`;
  const registry = new AgentRegistry(cut.registryFile);
  (registry as unknown as {
    mutate<T>(fn: (file: { conversationAliases: Record<string, string> }) => T): T;
  }).mutate((file) => { file.conversationAliases[alias] = cut.conversationId; });
  expect(registry.canonicalConversationId(alias)).toBe(cut.conversationId);

  await recordDemotionInterruption(registry, { engine: "claude", sessionId: cut.sessionId }, {
    status: "active",
    sessionKey: "fake",
    endpoint: "fake:host",
    pid: 2_000_001_119,
    processStartIdentity: "engine-2000001119",
    eventCursor: 0,
    protocolVersion: "test",
    activeTurnRef: CUT_TURN,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  }, {
    boundary: "viewer-release:aliased-seat",
    seats: () => [{ project: "seat-aliased", seatEpoch: 5, conversationId: alias }],
  });
  expect(obligationsFor(cut.registryFile).map((obligation) => obligation.seat))
    .toEqual([{ project: "seat-aliased", seatEpoch: 5 }]);
});

test("the pipeline engine reads a continuation the successor submitted as arrived once its reservation delivered (#1835 review)", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(21), deadEngine(2_000_001_121));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_121));
    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toHaveLength(1);

    /* The store still reads `submitted`: the queue answered on admission, and
       only a later startup pass records the arrival. */
    const [obligation] = obligationsFor(cut.registryFile);
    expect(obligation?.state).toBe("submitted");
    const registry = new AgentRegistry(cut.registryFile);
    const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
      .find((delivery) => delivery.clientMessageId === obligation!.id);
    expect(reservation).toMatchObject({ state: "delivered" });
    expect(reservation!.deliveredAt).not.toBeNull();

    /* What the stage tick reads: arrived, at the reservation's delivery. */
    setAgentRegistryForTests(registry);
    try {
      expect(defaultPipelinePorts().conversationInterruption!(cut.conversationId)).toEqual({
        state: "delivered",
        recordedAt: obligation!.recordedAt,
        resolvedAt: reservation!.deliveredAt,
      });
    } finally {
      setAgentRegistryForTests(null);
    }
  } finally {
    journal.close();
  }
});

test("persistent update drain holds a fresh agent turn through queue recovery, while submitted work and operator sends settle", async () => {
  const { NextRequest } = await import("next/server");
  const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
  const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
  const { handleRuntimeCommand } = await import("./http");
  const { kickStructuredDeliveryQueue } = await import("./structuredDeliverySignal");
  const { writeDrain, drainFile, releaseDrain } = await import("@/lib/selfUpdate/drain");
  const registry = new AgentRegistry(path.join(directory, "drain-registry.json"));
  const artifactPath = path.join(directory, "drain-session.jsonl");
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: "fixture", launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString() }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "codex" as const, sessionId: conversation.generations.at(-1)!.id };
  registry.upsert({ key, artifactPath, cwd: directory, accountId: "fixture", launchProfile: profile, status: "idle", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fake:update-drain", process: null, eventCursor: 0,
      protocolVersion: "fake-v1", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 0, claimOwner: null, pendingAction: null });
  const journal = new RuntimeJournal(path.join(directory, "drain-runtime.sqlite"), { structuredHosts: true });
  const client = journalClient(journal);
  const host = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  const hosts = [{ key, host }];
  setCallerConversationResolverForTests(() => "conversation_fixture_sender");
  try {
    await bindStructuredDeliveryQueue(hosts as never, { registry, client });
    const submitted = journal.executeOperation({ kind: "send", conversationId: conversation.id, text: "Already admitted", idempotencyKey: "before-drain", origin: { kind: "agent" } });
    const since = new Date(Date.parse(submitted.receipt.admittedAt!) + 1).toISOString();
    writeDrain(drainFile(), { id: "turn-drain", target: "a".repeat(40), since, until: 0, persistent: true });
    await kickStructuredDeliveryQueue();
    expect(host.ledger.writes.map(write => write.text)).toEqual(["Already admitted"]);
    // Give the fresh admission an immutable stamp after the hold boundary.
    while (Date.now() <= Date.parse(since)) await new Promise(resolve => setTimeout(resolve, 1));
    const request = new NextRequest("http://127.0.0.1/api/runtime/send", { method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json", [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) },
      body: JSON.stringify({ conversationId: conversation.id, text: "Fresh autonomous work", idempotencyKey: "during-drain" }) });
    const response = await handleRuntimeCommand(request, "send", { enabled: () => true, structuredEnabled: () => true,
      registry: () => registry, client: () => client, recordOperatorRequest: () => null,
      retireReplySuggestions: () => ({ cleared: false, pending: false }), kick: () => {} });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    await kickStructuredDeliveryQueue();
    expect(host.ledger.writes).toHaveLength(1);
    await bindStructuredDeliveryQueue([], { registry, client: null });
    await bindStructuredDeliveryQueue(hosts as never, { registry, client });
    await kickStructuredDeliveryQueue();
    expect(host.ledger.writes).toHaveLength(1);
    const manual = journal.executeOperation({ kind: "send", conversationId: conversation.id, text: "Operator work", idempotencyKey: "manual-drain", origin: { kind: "operator" } });
    await kickStructuredDeliveryQueue();
    expect(host.ledger.writes.map(write => write.text)).toEqual(["Already admitted", "Operator work"]);
    expect(journal.operationResult(manual.operationId)!.receipt.status).toBe("delivered");
    releaseDrain(drainFile(), "turn-drain");
    await kickStructuredDeliveryQueue(); await kickStructuredDeliveryQueue();
    expect(host.ledger.writes.map(write => write.text)).toEqual(["Already admitted", "Operator work", "Fresh autonomous work"]);
    expect(host.ledger.writes[2].id).toBe(accepted.operationId);
  } finally {
    setCallerConversationResolverForTests(null); releaseDrain(drainFile(), "turn-drain");
    await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close();
  }
});

test("a pending spawn's first prompt retains its original cohort admission time", async () => {
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const registry = new AgentRegistry(path.join(directory, "admitted-spawn-registry.json"));
  const launch = beginLegacySpawnFixture(registry, { engine: "codex", cwd: directory });
  if (launch.kind !== "created") throw new Error("fixture spawn was not reserved");
  await new Promise(resolve => setTimeout(resolve, 2));
  const op = `spawn_message_${launch.receipt.launchId}`;
  const message = registry.holdDelivery(launch.receipt.conversationId, "Initial accepted prompt", `spawn_${launch.receipt.launchId}`, "text", [], null, { operationId: op });
  expect(registry.deliveryAdmissionAtForOperation(op)).toBe(launch.receipt.createdAt);
  expect(Date.parse(message.createdAt)).toBeGreaterThan(Date.parse(launch.receipt.createdAt));
  const normal = registry.holdDelivery(launch.receipt.conversationId, "New work", "ordinary-message", "text", [], null, { operationId: "ordinary-operation" });
  expect(registry.deliveryAdmissionAtForOperation("ordinary-operation")).toBe(normal.createdAt);
});

/*
 * A service restart (a deploy, a self-update, a crash) with no release before
 * it: the old Viewer recorded nothing, its engines die with it or are replaced
 * by the claim, and the booting successor is the only one left to notice what
 * it cut. It records every turn it finds in flight, once.
 */

/** A Claude turn that ended on background work it was still waiting for. */
function waitingOnBackgroundTranscript(): Record<string, unknown>[] {
  const at = (offset: number) => new Date(Date.now() - 60_000 + offset * 1_000).toISOString();
  return [
    { type: "user", timestamp: at(0), message: { content: "run the merge gate" } },
    { type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", id: "tool-gate", name: "Bash", input: { run_in_background: true } }] } },
    { type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "tool-gate", content: "Command running in background with ID: gatetask1." }] },
      toolUseResult: { backgroundTaskId: "gatetask1" } },
    { type: "assistant", timestamp: at(3), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Waiting for the gate to finish." }] } },
  ];
}

test("a spawned agent whose turn a service restart cut is resumed once, and a second restart sends nothing more", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(31), deadEngine(2_000_001_131));
    const ledger = createFakeDeliveryLedger();
    const first = await successorBoot(cut.registryFile, journal, ledger, { viewer: { pid: 2_000_001_003, startIdentity: "first-successor" } });
    expect(first.error).toBeNull();
    expect(first.adopted).toEqual([cut.hostKey]);
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith("Viewer restarted and severed your structured host mid-turn.");
    expect(writes[0]).toContain("The interrupted turn's last transcript event is tool-call");
    expect(writes[0]).toContain("Re-run any interrupted operation");

    const second = await successorBoot(cut.registryFile, journal, ledger);
    expect(second.error).toBeNull();
    await settle(() => ledger.writes.length > 1);
    expect(continuationsIn(ledger)).toHaveLength(1);
    expect(obligationsFor(cut.registryFile).map(({ conversationId, reason }) => ({ conversationId, reason })))
      .toEqual([{ conversationId: cut.conversationId, reason: "viewer-restart" }]);
  } finally {
    journal.close();
  }
});

test("a spawned agent waiting on background work the restart killed is told so once", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(32), deadEngine(2_000_001_132), waitingOnBackgroundTranscript());
    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([cut.hostKey]);
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("background work you started was still running (background task gatetask1)");
    expect(writes[0]).toContain("its completion notice will not arrive");
    expect(obligationsFor(cut.registryFile)[0]!.checkpoint.backgroundTasks).toEqual(["background task gatetask1"]);
  } finally {
    journal.close();
  }
});

test("a pipeline stage a restart cut gets no continuation: its cut is recorded for the controller that retries it", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(33), deadEngine(2_000_001_133));
    new AgentRegistry(cut.registryFile).rememberMembership(cut.conversationId, {
      kind: "pipeline", containerId: "lane-fixture", role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: 1, parentConversationId: null,
    });
    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    const [record] = obligationsFor(cut.registryFile);
    expect(record).toMatchObject({
      conversationId: cut.conversationId, reason: "viewer-restart", state: "discharged",
      resolution: "a pipeline stage: its controller retries the attempt",
      stage: { pipelineId: "lane-fixture", stageId: "build", attempt: 1 },
    });
    const registry = new AgentRegistry(cut.registryFile);
    setAgentRegistryForTests(registry);
    try {
      expect(defaultPipelinePorts().conversationRestartCut!(cut.conversationId)).toEqual({ recordedAt: record!.recordedAt });
      expect(defaultPipelinePorts().conversationInterruption!(cut.conversationId)?.state).toBe("discharged");
    } finally {
      setAgentRegistryForTests(null);
    }
  } finally {
    journal.close();
  }
});

test("a restart that finds an agent's turn already settled records nothing and sends nothing", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const settled = waitingOnBackgroundTranscript();
    const at = new Date(Date.now() - 10_000).toISOString();
    settled.push({ type: "user", timestamp: at, message: { content: "<task-notification>\n<task-id>gatetask1</task-id>\n<status>completed</status>\n</task-notification>" } });
    settled.push({ type: "assistant", timestamp: at, message: { stop_reason: "end_turn", content: [{ type: "text", text: "The gate passed." }] } });
    const cut = incumbentConversation("claude", cutSessionId(34), deadEngine(2_000_001_134), settled);
    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  } finally {
    journal.close();
  }
});

/** The row as a previous Viewer left it: hosted, its turn `live` or, once a
    Claude turn ended, `idle`. */
function markHosted(cut: CutConversation, status: "live" | "idle", activeTurnRef: string | null = null): void {
  const registry = new AgentRegistry(cut.registryFile);
  const entry = registry.readOnlySnapshot().entries[cut.hostKey]!;
  if (!registry.setStructuredHostClaimed({ engine: cut.engine, sessionId: cut.sessionId },
    { ...entry.structuredHost!, activeTurnRef }, status, entry.claimOwner!, entry.claimEpoch)) {
    throw new Error("the hosted row could not be restated");
  }
}

function appendTranscript(cut: CutConversation, records: Record<string, unknown>[]): void {
  fs.appendFileSync(cut.artifactPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const OTHER_VIEWER = (index: number): ProcessIdentity => ({ pid: 2_000_002_000 + index, startIdentity: `viewer-${index}` });

test("an idle Claude agent whose ended turn still waited on background work is told once that the restart killed it", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(35), deadEngine(2_000_001_135), waitingOnBackgroundTranscript());
    /* A completed turn reports idle and clears its turn, while the CLI and the
       command it started in the background keep running. */
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("background work you started was still running (background task gatetask1)");
    expect(obligationsFor(cut.registryFile).map(({ conversationId, reason, checkpoint }) => ({ conversationId, reason, tasks: checkpoint.backgroundTasks })))
      .toEqual([{ conversationId: cut.conversationId, reason: "viewer-restart", tasks: ["background task gatetask1"] }]);
  } finally {
    journal.close();
  }
});

test("an agent resumed after one restart and cut mid-turn by the next gets its own one continuation", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(36), deadEngine(2_000_001_136));
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(1) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toHaveLength(1);
    const delivered = Object.values(new AgentRegistry(cut.registryFile).readOnlySnapshot().heldDeliveries)
      .filter((delivery) => delivery.state === "delivered");
    expect(delivered).toHaveLength(1);

    /* The agent took the continuation up and was mid-tool when the next
       restart came. */
    await Bun.sleep(5);
    const at = new Date().toISOString();
    appendTranscript(cut, [
      { type: "user", timestamp: at, message: { content: "continue" } },
      { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "tool-second", name: "Bash" }] } },
    ]);
    markHosted(cut, "live", "turn-after-resume");
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(2) })).error).toBeNull();
    await settle(() => ledger.writes.length > 1);
    expect(continuationsIn(ledger)).toHaveLength(2);
    expect(obligationsFor(cut.registryFile).filter((obligation) => obligation.reason === "viewer-restart")).toHaveLength(2);

    /* A third boot that finds the same silent turn owes nothing more. */
    markHosted(cut, "live", "turn-after-resume");
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(3) })).error).toBeNull();
    await settle(() => ledger.writes.length > 2, 150);
    expect(continuationsIn(ledger)).toHaveLength(2);
  } finally {
    journal.close();
  }
});

test("a spawned Claude agent cut before its first transcript record is resumed once across repeated boots", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    /* The first prompt reached the engine, which names its turn, and the
       restart came before the CLI wrote a line. */
    const cut = incumbentConversation("claude", cutSessionId(47), deadEngine(2_000_001_147), [], "never");
    const ledger = createFakeDeliveryLedger();
    /* The next boot finds the row as the cut left it. That boot declines to
       re-host a turn claim no transcript record dates, so a third has no row. */
    for (const index of [1, 2]) {
      if (index > 1) markHosted(cut, "live", CUT_TURN);
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(70 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 ? 400 : 150);
    }
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith("Viewer restarted and severed your structured host mid-turn.");
    expect(obligationsFor(cut.registryFile)).toMatchObject([{
      reason: "viewer-restart", turnRef: CUT_TURN, boundary: "viewer-restart:launch", checkpoint: { lastEventAt: null },
    }]);
  } finally {
    journal.close();
  }
});

test.each([
  { row: "idle", status: "idle", turn: null, observed: "never" },
  { row: "live with no turn named", status: "live", turn: null, observed: "never" },
  { row: "naming a turn whose transcript was observed before", status: "live", turn: CUT_TURN, observed: "busy" },
] as const)("an agent's row $row, its transcript holding no record, records nothing and sends nothing", async ({ status, turn, observed }) => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(48), deadEngine(2_000_001_148), [], observed);
    markHosted(cut, status, turn);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  } finally {
    journal.close();
  }
});

test("a turn an operator resumed after a cut, cut again before its transcript shows it, gets its own one continuation", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(50), deadEngine(2_000_001_150));
    await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_150));
    runtimeSession(journal, cut);
    await Bun.sleep(5);
    expect(operatorSend(journal, cut, "operator-send-after-release", "carry on").status).not.toBe("rejected");

    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(80) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toEqual(["carry on"]);
    expect(obligationsFor(cut.registryFile).map(({ state }) => state)).toEqual(["discharged"]);

    /* The operator's message started a turn the next restart cut before the
       transcript echoed its prompt. */
    const receipt = ledger.receipts.get(ledger.writes[0]!.id);
    if (receipt?.outcome !== "turn-started") throw new Error("the operator's message started no turn");
    const operatorTurn = receipt.turnId;
    await Bun.sleep(5);
    for (const index of [1, 2, 3]) {
      markHosted(cut, "live", operatorTurn);
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(80 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 1, index === 1 ? 400 : 150);
    }
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toStartWith("Viewer restarted and severed your structured host mid-turn.");
    expect(obligationsFor(cut.registryFile).map(({ reason, turnRef }) => ({ reason, turnRef }))).toEqual([
      { reason: "viewer-release", turnRef: CUT_TURN },
      { reason: "viewer-restart", turnRef: operatorTurn },
    ]);
  } finally {
    journal.close();
  }
});

test("a Codex agent's restart cut is continued once across repeated boots and Viewer generations", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(37), deadEngine(2_000_001_137));
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2, 3]) {
      /* Each later boot finds the row as the cut left it: no turn since. */
      if (index > 1) markHosted(cut, "live", CUT_TURN);
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(10 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 ? 400 : 150);
    }
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith("Viewer restarted and severed your structured host mid-turn.");
    expect(obligationsFor(cut.registryFile).map(({ reason, state }) => ({ reason, state }))[0]?.reason).toBe("viewer-restart");
    expect(obligationsFor(cut.registryFile)).toHaveLength(1);
  } finally {
    journal.close();
  }
});

test.each(["codex", "claude"] as const)("a %s pipeline stage the restart cut gets no continuation from any path", async (engine) => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation(engine, cutSessionId(engine === "codex" ? 38 : 39), deadEngine(2_000_001_138));
    new AgentRegistry(cut.registryFile).rememberMembership(cut.conversationId, {
      kind: "pipeline", containerId: "lane-fixture", role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: 1, parentConversationId: null,
    });
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2]) {
      /* The later boot finds the row as the cut left it: the same turn. */
      if (index > 1) markHosted(cut, "live", CUT_TURN);
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(20 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, 150);
    }
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toMatchObject([{
      reason: "viewer-restart", state: "discharged", stage: { pipelineId: "lane-fixture", stageId: "build", attempt: 1 },
    }]);
  } finally {
    journal.close();
  }
});

test("an orderly release of a pipeline stage leaves its cut to the stage controller", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(40), deadEngine(2_000_001_140));
    new AgentRegistry(cut.registryFile).rememberMembership(cut.conversationId, {
      kind: "pipeline", containerId: "lane-fixture", role: "builder", slot: "build:1",
      stageId: "build", stageOrder: 0, round: 1, parentConversationId: null,
    });
    const { exitCode } = await releaseIncumbent([cut], journal, () => deadEngine(2_000_001_140));
    expect(exitCode).toBe(0);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);

    expect(continuationsIn(ledger)).toEqual([]);
    const [record] = obligationsFor(cut.registryFile);
    expect(record).toMatchObject({
      reason: "viewer-release", state: "discharged", resolution: "a pipeline stage: its controller retries the attempt",
      stage: { pipelineId: "lane-fixture", stageId: "build", attempt: 1 },
    });
    const registry = new AgentRegistry(cut.registryFile);
    setAgentRegistryForTests(registry);
    try {
      expect(defaultPipelinePorts().conversationRestartCut!(cut.conversationId)).toEqual({ recordedAt: record!.recordedAt });
    } finally {
      setAgentRegistryForTests(null);
    }
  } finally {
    journal.close();
  }
});

test("Codex exit bookkeeping after a cut owes no second continuation, and a resumed turn cut again owes its own", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("codex", cutSessionId(41), deadEngine(2_000_001_141));
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(31) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toHaveLength(1);

    /* The CLI's usage envelope lands after the record, under the same open
       turn: no prompt, no tool call, no reply. */
    for (const index of [2, 3]) {
      await Bun.sleep(5);
      appendTranscript(cut, [{ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: null } }]);
      markHosted(cut, "live", CUT_TURN);
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(30 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 1, 150);
    }
    expect(continuationsIn(ledger)).toHaveLength(1);
    expect(obligationsFor(cut.registryFile)).toHaveLength(1);

    /* The agent took the continuation up and the next restart cut that turn. */
    await Bun.sleep(5);
    const at = new Date().toISOString();
    appendTranscript(cut, [
      { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "continue" } },
      { timestamp: at, type: "response_item", payload: { type: "function_call", call_id: "call-second", name: "shell" } },
      { timestamp: at, type: "event_msg", payload: { type: "token_count", info: null } },
    ]);
    markHosted(cut, "live", "turn-after-resume");
    for (const index of [4, 5]) {
      if (index > 4) markHosted(cut, "live", "turn-after-resume");
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(30 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 1, index === 4 ? 400 : 150);
    }
    expect(continuationsIn(ledger)).toHaveLength(2);
    expect(obligationsFor(cut.registryFile)).toHaveLength(2);
  } finally {
    journal.close();
  }
});

/* The continuation of a first cut started its turn, and the next restart cut
   that turn before the transcript showed a word of it. The registry named the
   turn; that is the evidence. */
test.each(["claude", "codex"] as const)("a %s turn a delivered continuation started, cut before its transcript echoed it, gets its own one continuation", async (engine) => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation(engine, cutSessionId(engine === "codex" ? 47 : 48), deadEngine(2_000_001_147));
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(61) })).error).toBeNull();
    await settle(() => ledger.receipts.size > 0);
    const receipt = [...ledger.receipts.values()].at(-1);
    if (receipt?.outcome !== "turn-started") throw new Error("the first continuation started no turn");
    markHosted(cut, "live", receipt.turnId);

    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(62) })).error).toBeNull();
    await settle(() => ledger.writes.length > 1);
    expect(continuationsIn(ledger)).toHaveLength(2);
    const restartCuts = obligationsFor(cut.registryFile).filter((obligation) => obligation.reason === "viewer-restart");
    expect(restartCuts).toHaveLength(2);
    expect(restartCuts.map((obligation) => obligation.turnRef)).toEqual([CUT_TURN, receipt.turnId]);

    /* Later boots that find the same row and the same silent transcript, or
       only exit bookkeeping on it, owe nothing more. */
    for (const index of [63, 64]) {
      if (engine === "codex") {
        appendTranscript(cut, [{ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: null } }]);
      }
      markHosted(cut, "live", receipt.turnId);
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 2, 150);
    }
    expect(continuationsIn(ledger)).toHaveLength(2);
    expect(obligationsFor(cut.registryFile)).toHaveLength(2);
  } finally {
    journal.close();
  }
});

/* A Claude stage whose provider failed before the restart: the CLI gave up on
   the turn, and the provider recovery owns it. The shared projection keeps
   that turn busy, which is no cut. */
test("a stage whose turn a provider failure ended before the restart records no restart cut", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const at = new Date(Date.now() - 30_000).toISOString();
    const cut = incumbentConversation("claude", cutSessionId(49), deadEngine(2_000_001_149), [
      ...midToolTranscript("claude"),
      { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "tool-cut", content: "ok" }] } },
      { type: "assistant", timestamp: at, isApiErrorMessage: true, error: "server_error",
        message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "Failed to refresh OAuth token: retry in a minute" }] } },
    ]);
    asPipelineStage(cut);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  } finally {
    journal.close();
  }
});

/** A Claude host as the broker reports it: its state changes reach the
    registry through the real persistence binding, and a release ends it
    `unhosted` with no process. */
async function persistedIdleClaudeHost(cut: CutConversation, ledger: FakeDeliveryLedger, engineProcess: ProcessIdentity) {
  const { bindClaudeHostPersistence } = await import("./registry");
  const registry = new AgentRegistry(cut.registryFile);
  const key = { engine: cut.engine, sessionId: cut.sessionId };
  const entry = registry.readOnlySnapshot().entries[cut.hostKey]!;
  const listeners = new Set<(state: HostState) => void>();
  const host = hostFor(ledger, { status: "idle", pid: engineProcess.pid, processStartIdentity: engineProcess.startIdentity });
  Object.assign(host, {
    setWriterFence: () => {},
    onStateChange: (listener: (state: HostState) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    release: async () => {
      const state = { ...await host.health(), status: "unhosted" as const, pid: null, processStartIdentity: null };
      for (const listener of [...listeners]) listener(state);
    },
  });
  await bindClaudeHostPersistence(registry, key, host as never, entry.claimOwner!, entry.claimEpoch);
  return { registry, key, host };
}

test("an orderly release resumes an idle Claude agent waiting on background work, once, naming the work", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const engine = deadEngine(2_000_001_142);
    const cut = incumbentConversation("claude", cutSessionId(42), engine, waitingOnBackgroundTranscript());
    const incumbentLedger = createFakeDeliveryLedger();
    const { registry, key, host } = await persistedIdleClaudeHost(cut, incumbentLedger, engine);
    expect(registry.readOnlySnapshot().entries[cut.hostKey]!.status).toBe("idle");
    await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
    await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(new AgentRegistry(cut.registryFile).readOnlySnapshot().entries[cut.hostKey]!.status).toBe("unhosted");
    expect(obligationsFor(cut.registryFile)).toMatchObject([{
      conversationId: cut.conversationId, reason: "viewer-release", state: "owed", turnRef: null,
      checkpoint: { lastEventKind: "assistant-message", backgroundTasks: ["background task gatetask1"] },
    }]);

    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2]) {
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(40 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 ? 400 : 150);
    }
    const writes = continuationsIn(ledger);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("deployment interrupted your turn");
    expect(writes[0]).toContain("background work you started was still running (background task gatetask1)");
    expect(incumbentLedger.writes).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toHaveLength(1);
  } finally {
    journal.close();
  }
});

test("an orderly release of an idle Claude agent with nothing in the background records nothing", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const engine = deadEngine(2_000_001_143);
    const settled = waitingOnBackgroundTranscript();
    const at = new Date(Date.now() - 10_000).toISOString();
    settled.push({ type: "user", timestamp: at, message: { content: "<task-notification>\n<task-id>gatetask1</task-id>\n<status>completed</status>\n</task-notification>" } });
    settled.push({ type: "assistant", timestamp: at, message: { stop_reason: "end_turn", content: [{ type: "text", text: "The gate passed." }] } });
    const cut = incumbentConversation("claude", cutSessionId(43), engine, settled);
    const { registry, key, host } = await persistedIdleClaudeHost(cut, createFakeDeliveryLedger(), engine);
    await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
    await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
  } finally {
    journal.close();
  }
});

function asPipelineStage(cut: CutConversation): void {
  new AgentRegistry(cut.registryFile).rememberMembership(cut.conversationId, {
    kind: "pipeline", containerId: "lane-fixture", role: "builder", slot: "build:1",
    stageId: "build", stageOrder: 0, round: 1, parentConversationId: null,
  });
}

test.each([
  { artifact: "truncated mid-record", content: "{partial record" },
  { artifact: "corrupt after a readable record", content: `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: "build" } })}\n{"type":"assist` },
] as const)("a stage transcript $artifact proves no restart cut", async ({ content }) => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(44), deadEngine(2_000_001_144));
    asPipelineStage(cut);
    fs.writeFileSync(cut.artifactPath, content);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    const registry = new AgentRegistry(cut.registryFile);
    setAgentRegistryForTests(registry);
    try {
      expect(defaultPipelinePorts().conversationRestartCut!(cut.conversationId)).toBeNull();
    } finally {
      setAgentRegistryForTests(null);
    }
  } finally {
    journal.close();
  }
});

test.each([
  { artifact: "empty", write: (file: string) => fs.writeFileSync(file, "") },
  { artifact: "not written yet", write: (file: string) => fs.rmSync(file) },
  { artifact: "holding only launch metadata", write: (file: string) => fs.writeFileSync(file, `${JSON.stringify({ type: "queue-operation", operation: "enqueue" })}\n`) },
] as const)("a stage cut at launch, its transcript $artifact, is recorded once for its controller", async ({ write }) => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(45), deadEngine(2_000_001_145));
    asPipelineStage(cut);
    write(cut.artifactPath);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(51) })).error).toBeNull();
    const [first] = obligationsFor(cut.registryFile);
    expect(first).toMatchObject({
      reason: "viewer-restart", state: "discharged", boundary: "viewer-restart:launch",
      checkpoint: { lastEventKind: null, lastEventAt: null }, stage: { pipelineId: "lane-fixture", stageId: "build", attempt: 1 },
    });
    /* A later boot finds the same launch cut and leaves its record as written. */
    await Bun.sleep(5);
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(52) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([first!]);
  } finally {
    journal.close();
  }
});

test("a predecessor Viewer whose pid this process was given still has its cut recorded and resumed once", async () => {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    const cut = incumbentConversation("claude", cutSessionId(46), deadEngine(2_000_001_146));
    const registry = new AgentRegistry(cut.registryFile);
    const key = { engine: cut.engine, sessionId: cut.sessionId };
    const predecessor = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: "previous-viewer-start" }, { allowUnhosted: true });
    if (!predecessor?.structuredHost || !predecessor.claimOwner) throw new Error("the predecessor claim was unavailable");
    if (!registry.setStructuredHostClaimed(key, { ...predecessor.structuredHost, process: deadEngine(2_000_001_146), activeTurnRef: CUT_TURN },
      "live", predecessor.claimOwner, predecessor.claimEpoch)) throw new Error("the predecessor claim was lost");

    const ledger = createFakeDeliveryLedger();
    const boot = await successorBoot(cut.registryFile, journal, ledger);
    expect(boot.error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toHaveLength(1);
    expect(obligationsFor(cut.registryFile).map(({ reason }) => reason)).toEqual(["viewer-restart"]);

    /* The row is now this process's own claim: a turn it is running is its
       own work, whatever the transcript gained. */
    await Bun.sleep(5);
    const at = new Date().toISOString();
    appendTranscript(cut, [
      { type: "user", timestamp: at, message: { content: "continue" } },
      { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "tool-own", name: "Bash" }] } },
    ]);
    markHosted(cut, "live", "turn-of-this-viewer");
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 1, 150);
    expect(continuationsIn(ledger)).toHaveLength(1);
    expect(obligationsFor(cut.registryFile)).toHaveLength(1);
  } finally {
    journal.close();
  }
});

/*
 * Restart cut recognition (docs/design/restart-cut-recognition.md). These
 * cases write the host ledger through the store a real host writes, in the
 * case's own state directory: Claude records carry `uuid`s and Codex
 * lifecycle records `turn_id`s, as real ones do.
 */

function appendHostLedger(cut: CutConversation, events: Array<Record<string, unknown>>): void {
  const store = new FileRuntimeEventStore();
  const tail = durableRuntimeEventTailSeq(cut.sessionId);
  let seq = tail.determined ? tail.value : 0;
  for (const event of events) store.append(cut.sessionId, { ...event, seq: seq += 1 } as RuntimeEvent);
}

const turnStarted = (turnId: string) => ({ kind: "turn-started", turnId });
const turnEnded = (turnId: string, status: "completed" | "interrupted" | "error" = "completed") => ({ kind: "turn-ended", turnId, status });
/** The frame the Claude host records for a transcript record. */
const frameOf = (record: Record<string, unknown>, turnId: string | null) => ({ kind: "item", turnId, phase: "completed", item: record });

/** A Claude turn that ran one tool and ended, `ageMs` ago, its records named. */
function closedClaudeTurn(name: string, ageMs = 60_000): Record<string, unknown>[] {
  const at = (offset: number) => new Date(Date.now() - ageMs + offset * 1_000).toISOString();
  return [
    { type: "user", uuid: `${name}-prompt`, timestamp: at(0), message: { role: "user", content: "run the suite" } },
    { type: "assistant", uuid: `${name}-call`, timestamp: at(1), message: { model: "claude", content: [{ type: "tool_use", id: `${name}-tool`, name: "Bash" }] } },
    { type: "user", uuid: `${name}-result`, timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${name}-tool`, content: "ok" }] } },
    { type: "assistant", uuid: `${name}-end`, timestamp: at(3), message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
  ];
}

/** The ledger a host leaves for a turn it started and saw end. */
function closedTurnLedger(turnId: string, records: Record<string, unknown>[]): Array<Record<string, unknown>> {
  return [turnStarted(turnId), ...records.map((record) => frameOf(record, turnId)), turnEnded(turnId)];
}

/** Restates the row as its cut left it for the next boot. False once a boot
    retired the row: nothing is left for a later one to find. */
function restateHosted(cut: CutConversation, status: "live" | "idle", activeTurnRef: string | null = null): boolean {
  const entry = new AgentRegistry(cut.registryFile).readOnlySnapshot().entries[cut.hostKey];
  if (!entry?.claimOwner || !entry.structuredHost || entry.status === "dead" || entry.status === "unhosted") return false;
  markHosted(cut, status, activeTurnRef);
  return true;
}

/** A Claude turn its host saw interrupted mid-tool: the transcript still reads
    open, the ledger holds the end. */
function interruptedClaudeTurn(): { records: Record<string, unknown>[]; ledger: Array<Record<string, unknown>> } {
  const records: Record<string, unknown>[] = [
    ...midToolTranscript("claude").map((record, index) => ({ ...record, uuid: `cut-${index}` })),
    { type: "user", uuid: "interrupt-marker", timestamp: new Date(Date.now() - 30_000).toISOString(), message: { role: "user", content: "[Request interrupted by user for tool use]" } },
  ];
  return { records, ledger: [turnStarted("T1"), ...records.map((record) => frameOf(record, "T1")), turnEnded("T1", "interrupted")] };
}

function restartContinuations(ledger: FakeDeliveryLedger): string[] {
  return continuationsIn(ledger).filter((text) => text.startsWith("Viewer restarted and severed your structured host mid-turn."));
}

function restartCuts(registryFile: string) {
  return obligationsFor(registryFile).filter((obligation) => obligation.reason === "viewer-restart");
}

async function withJournal(run: (journal: RuntimeJournal) => Promise<void>): Promise<void> {
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    await run(journal);
  } finally {
    journal.close();
  }
}

/** Runs the newest scheduled deferral re-probe and waits for what it starts. */
async function runScheduledProbe(done: () => boolean = () => false, milliseconds = 400): Promise<void> {
  const probe = scheduledProbes.pop();
  if (!probe) throw new Error("no deferral re-probe is scheduled");
  const before = scheduledProbes.length;
  probe.callback();
  await settle(() => done() || scheduledProbes.length > before, milliseconds);
}

test("a later turn its host started is continued once across boots when the restart precedes its prompt echo, however old the turn before it (R5 F1, C1)", async () => {
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1", 7 * 3_600_000);
    const cut = incumbentConversation("claude", cutSessionId(60), deadEngine(2_000_001_160), first);
    appendHostLedger(cut, [...closedTurnLedger("T1", first), turnStarted("T2")]);
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2, 3]) {
      if (!restateHosted(cut, "live", "T2")) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(100 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 ? 400 : 150);
    }
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(obligationsFor(cut.registryFile)).toMatchObject([{ reason: "viewer-restart", turnRef: "T2", boundary: "viewer-restart:turn" }]);
  });
});

test("a turn its host recorded as ended, the row still naming it, records nothing (C2)", async () => {
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1");
    const cut = incumbentConversation("claude", cutSessionId(61), deadEngine(2_000_001_161), first);
    appendHostLedger(cut, closedTurnLedger("T1", first));
    markHosted(cut, "live", "T1");
    runtimeSession(journal, cut);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(restartContinuations(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test("a queued turn started as the one before it closed is continued once, with nine later sends admitted behind it (C2, C3)", async () => {
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1");
    const cut = incumbentConversation("claude", cutSessionId(62), deadEngine(2_000_001_162), first);
    appendHostLedger(cut, [...closedTurnLedger("T1", first), turnStarted("T2")]);
    markHosted(cut, "live", "T2");
    runtimeSession(journal, cut);
    for (let index = 0; index < 9; index += 1) {
      expect(operatorSend(journal, cut, `queued-send-${index}`, `queued ${index}`).status).not.toBe("rejected");
    }
    await Bun.sleep(5);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => restartContinuations(ledger).length > 0);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T2", boundary: "viewer-restart:turn" }]);
    expect(restartContinuations(ledger).length).toBeLessThanOrEqual(1);
  });
});

/** A Codex rollout mid-tool under turn `turnId`, then whatever the CLI wrote
    on its way down. */
function codexTurnRollout(turnId: string, tail: Array<Record<string, unknown>> = []): Record<string, unknown>[] {
  const at = (offset: number) => new Date(Date.now() - 60_000 + offset * 1_000).toISOString();
  return [
    { timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: at(0), type: "event_msg", payload: { type: "user_message", message: "run the suite" } },
    { timestamp: at(1), type: "response_item", payload: { type: "function_call", call_id: "call-cut", name: "shell" } },
    ...tail,
  ];
}
const codexAborted = (turnId: string) =>
  ({ timestamp: new Date(Date.now() - 50_000).toISOString(), type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted" } });

test.each([
  { member: "agent", ledger: true },
  { member: "stage", ledger: true },
  { member: "agent", ledger: false },
  { member: "stage", ledger: false },
] as const)("a Codex $member whose shutdown wrote turn_aborted is still recognized as cut (R5 F2, host ledger: $ledger)", async ({ member, ledger: withLedger }) => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("codex", cutSessionId(63), deadEngine(2_000_001_163), codexTurnRollout(CUT_TURN, [codexAborted(CUT_TURN)]));
    if (member === "stage") asPipelineStage(cut);
    if (withLedger) appendHostLedger(cut, [turnStarted(CUT_TURN)]);
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2]) {
      if (index > 1 && !restateHosted(cut, "live", CUT_TURN)) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(110 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 && member === "agent" ? 400 : 150);
    }
    expect(continuationsIn(ledger)).toHaveLength(member === "agent" ? 1 : 0);
    expect(restartCuts(cut.registryFile)).toMatchObject([member === "agent"
      ? { turnRef: CUT_TURN }
      : { turnRef: CUT_TURN, state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" }]);
    if (member === "stage") {
      setAgentRegistryForTests(new AgentRegistry(cut.registryFile));
      try {
        expect(defaultPipelinePorts().conversationRestartCut!(cut.conversationId)).not.toBeNull();
      } finally {
        setAgentRegistryForTests(null);
      }
    }
  });
});

test("a Codex turn whose interrupt its host served records nothing (R5 F2)", async () => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("codex", cutSessionId(64), deadEngine(2_000_001_164), codexTurnRollout(CUT_TURN, [codexAborted(CUT_TURN)]));
    appendHostLedger(cut, [turnStarted(CUT_TURN), turnEnded(CUT_TURN, "interrupted")]);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test("a transcript that ends on a partial record holds its row, and the re-probe decides and continues it in the same Viewer (R5 F3, C4)", async () => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("claude", cutSessionId(65), deadEngine(2_000_001_165));
    const whole = fs.readFileSync(cut.artifactPath, "utf8");
    fs.writeFileSync(cut.artifactPath, `${whole}{"type":"assist`);
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);
    expect(registry.readOnlySnapshot().entries[cut.hostKey]).toMatchObject({ status: "live", structuredHost: { activeTurnRef: CUT_TURN } });

    /* The record is finished: the same process decides the row before it
       adopts it, records the cut and continues it. */
    fs.writeFileSync(cut.artifactPath, whole);
    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toHaveLength(1);
    expect(structuredStartupDeferral()).toBeNull();
    expect(scheduledProbes).toEqual([]);
  });
});

test("a transcript that stays corrupt is never recorded or adopted, until a waiting send takes it at the re-probe cap (R5 F3, C4)", async () => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("claude", cutSessionId(66), deadEngine(2_000_001_166));
    fs.appendFileSync(cut.artifactPath, '{"type":"assist');
    runtimeSession(journal, cut);
    expect(operatorSend(journal, cut, "send-to-a-torn-row", "are you there?").status).not.toBe("rejected");
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    const delays: number[] = [];
    for (let probe = 0; probe < 8 && ledger.writes.length === 0; probe += 1) {
      delays.push(scheduledProbes.at(-1)!.delayMs);
      await runScheduledProbe(() => ledger.writes.length > 0, 150);
    }
    expect(delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    await settle(() => ledger.writes.length > 0);
    expect(continuationsIn(ledger)).toEqual(["are you there?"]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test.each([
  { engine: "claude", ledger: false }, { engine: "claude", ledger: true },
  { engine: "codex", ledger: false }, { engine: "codex", ledger: true },
] as const)("an undated $engine completion of the turn the row names invents no cut (C5, D5, host ledger: $ledger)", async ({ engine, ledger: withLedger }) => {
  await withJournal(async (journal) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const records: Record<string, unknown>[] = engine === "claude"
      ? [
        { type: "user", uuid: "t-prompt", timestamp: at, message: { role: "user", content: "say done" } },
        { type: "assistant", uuid: "t-end", message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
      ]
      : [
        { timestamp: at, type: "event_msg", payload: { type: "task_started", turn_id: CUT_TURN } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: CUT_TURN } },
      ];
    const cut = incumbentConversation(engine, cutSessionId(67), deadEngine(2_000_001_167), records);
    /* The host recorded the turn's start and died before its end reached it. */
    if (withLedger) {
      appendHostLedger(cut, engine === "claude"
        ? [turnStarted(CUT_TURN), frameOf(records[0]!, CUT_TURN)]
        : [turnStarted(CUT_TURN)]);
    }
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test.each([{ dated: true }, { dated: false }])("a completion of the turn before does not close the open one (D5, dated: $dated)", async ({ dated }) => {
  await withJournal(async (journal) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const cut = incumbentConversation("codex", cutSessionId(68), deadEngine(2_000_001_168), [
      { timestamp: at, type: "event_msg", payload: { type: "task_started", turn_id: "T1" } },
      { ...(dated ? { timestamp: at } : {}), type: "event_msg", payload: { type: "task_complete", turn_id: "T1" } },
    ]);
    appendHostLedger(cut, [turnStarted("T1"), turnEnded("T1"), turnStarted("T2")]);
    markHosted(cut, "live", "T2");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T2", boundary: "viewer-restart:turn" }]);
  });
});

test.each([
  { member: "agent", ledger: true, cut: true },
  { member: "stage", ledger: true, cut: true },
  { member: "agent", ledger: false, cut: false },
  { member: "stage", ledger: false, cut: true },
] as const)("a Codex $member whose tail holds only a reasoning item (C6, host ledger: $ledger)", async ({ member, ledger: withLedger, cut: expectCut }) => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("codex", cutSessionId(69), deadEngine(2_000_001_169), [
      { timestamp: new Date(Date.now() - 60_000).toISOString(), type: "response_item", payload: { type: "reasoning" } },
    ]);
    if (member === "stage") asPipelineStage(cut);
    if (withLedger) appendHostLedger(cut, [turnStarted(CUT_TURN)]);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, expectCut && member === "agent" ? 400 : 150);
    expect(restartCuts(cut.registryFile)).toHaveLength(expectCut ? 1 : 0);
    expect(restartContinuations(ledger)).toHaveLength(expectCut && member === "agent" ? 1 : 0);
  });
});

test.each([
  { moved: "appended to", member: "agent" },
  { moved: "appended to", member: "stage" },
  { moved: "replaced", member: "agent" },
] as const)("a host ledger $moved under the read holds its $member row, and the re-probe decides it from the still file (D1)", async ({ moved, member }) => {
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1");
    const cut = incumbentConversation("claude", cutSessionId(70), deadEngine(2_000_001_170), first);
    if (member === "stage") asPipelineStage(cut);
    appendHostLedger(cut, closedTurnLedger("T1", first));
    markHosted(cut, "live", "T2");
    const ledgerFile = path.join(process.env.LLV_STATE_DIR!, "structured-host-events", `${cut.sessionId}.jsonl`);
    let reads = 0;
    const movingReader: typeof readHostTurnRecord = (sessionId, options) => readHostTurnRecord(sessionId, {
      ...options,
      afterRead: () => {
        if ((reads += 1) > 1) return;
        /* The predecessor accepts T2 and syncs its start while this read runs. */
        appendHostLedger(cut, [turnStarted("T2")]);
        if (moved === "replaced") {
          const contents = fs.readFileSync(ledgerFile);
          fs.rmSync(ledgerFile);
          fs.writeFileSync(ledgerFile, contents);
        }
      },
    });
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry, readHostTurnRecord: movingReader });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);
    expect(registry.readOnlySnapshot().entries[cut.hostKey]!.status).toBe("live");

    await runScheduledProbe(() => restartCuts(cut.registryFile).length > 0);
    await settle(() => ledger.writes.length > 0, member === "agent" ? 400 : 150);
    expect(restartCuts(cut.registryFile)).toMatchObject([member === "agent"
      ? { turnRef: "T2" }
      : { turnRef: "T2", state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" }]);
    expect(restartContinuations(ledger)).toHaveLength(member === "agent" ? 1 : 0);
  });
});

test("a turn started under the same row after a pass decided it is decided again by the next pass (D2)", async () => {
  await withJournal(async (journal) => {
    const first = interruptedClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(71), deadEngine(2_000_001_171), first.records);
    appendHostLedger(cut, first.ledger);
    markHosted(cut, "live", "T1");
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    /* The first pass decides no cut over the ended T1, then fails while it adopts. */
    const failed = await successorBoot(cut.registryFile, journal, ledger, { registry, adoptionFails: true });
    expect(failed.error).not.toBeNull();
    expect(obligationsFor(cut.registryFile)).toEqual([]);

    /* The predecessor accepts T2 under the same host row, before any echo. */
    appendHostLedger(cut, [turnStarted("T2")]);
    markHosted(cut, "live", "T2");
    expect((await successorBoot(cut.registryFile, journal, ledger, { registry })).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T2" }]);

    /* A third pass over unchanged evidence adds nothing. */
    restateHosted(cut, "live", "T2");
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(120) })).error).toBeNull();
    await settle(() => ledger.writes.length > 1, 150);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toHaveLength(1);
  });
});

test("a turn started after the pass decided its row and before the claim leaves the row unclaimed, and the re-probe continues it (D2)", async () => {
  await withJournal(async (journal) => {
    const first = interruptedClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(72), deadEngine(2_000_001_172), first.records);
    appendHostLedger(cut, first.ledger);
    markHosted(cut, "live", "T1");
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const before = registry.readOnlySnapshot().entries[cut.hostKey]!;
    const boot = await successorBoot(cut.registryFile, journal, ledger, {
      registry,
      beforeAdoption: () => {
        appendHostLedger(cut, [turnStarted("T2")]);
        markHosted(cut, "live", "T2");
      },
    });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    const held = registry.readOnlySnapshot().entries[cut.hostKey]!;
    expect(held).toMatchObject({ status: "live", claimEpoch: before.claimEpoch, structuredHost: { activeTurnRef: "T2" } });
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);

    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T2" }]);
  });
});

/** `waitingOnBackgroundTranscript` with named records, and the ledger of the
    host that ran it: the turn ended waiting on `gatetask1`. */
function endedWaitingOnBackground(): { records: Record<string, unknown>[]; ledger: Array<Record<string, unknown>> } {
  const records = waitingOnBackgroundTranscript().map((record, index) => ({ ...record, uuid: `wait-${index}` }));
  return { records, ledger: closedTurnLedger("T1", records) };
}
const gateNotification = () => ({
  type: "user", uuid: "gate-notice", timestamp: new Date(Date.now() - 10_000).toISOString(),
  message: { role: "user", content: "<task-notification>\n<task-id>gatetask1</task-id>\n<status>completed</status>\n</task-notification>" },
});
const followUpCall = () => ({
  type: "assistant", uuid: "follow-call", timestamp: new Date(Date.now() - 9_000).toISOString(),
  message: { model: "claude", content: [{ type: "tool_use", id: "tool-follow", name: "Read" }] },
});
const followUpEnd = () => [
  { type: "user", uuid: "follow-result", timestamp: new Date(Date.now() - 8_000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-follow", content: "ok" }] } },
  { type: "assistant", uuid: "follow-end", timestamp: new Date(Date.now() - 7_000).toISOString(), message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "The gate passed." }] } },
];

test.each([
  { work: "a tool call after the completion notice", member: "agent", cut: true },
  { work: "a tool call after the completion notice", member: "stage", cut: true },
  { work: "the completion notice alone", member: "agent", cut: true },
  { work: "a follow-up that finished", member: "agent", cut: false },
  { work: "a tool call the host recorded and the transcript never got", member: "agent", cut: true },
] as const)("work a Claude $member began by itself after its host closed the turn, $work (D3)", async ({ work, member, cut: expectCut }) => {
  await withJournal(async (journal) => {
    const ended = endedWaitingOnBackground();
    const cut = incumbentConversation("claude", cutSessionId(73), deadEngine(2_000_001_173), ended.records);
    if (member === "stage") asPipelineStage(cut);
    const notice = gateNotification();
    const call = followUpCall();
    const transcript = work === "the completion notice alone" ? [notice]
      : work === "a follow-up that finished" ? [notice, call, ...followUpEnd()]
        : work === "a tool call the host recorded and the transcript never got" ? [notice]
          : [notice, call];
    appendTranscript(cut, transcript);
    /* The host records the frames under no turn: it had none open. */
    appendHostLedger(cut, [
      ...ended.ledger,
      ...(work === "the completion notice alone" ? [] : [frameOf(call, null)]),
      ...(work === "a follow-up that finished" ? followUpEnd().map((record) => frameOf(record, null)) : []),
    ]);
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2, 3]) {
      if (index > 1 && !restateHosted(cut, "idle")) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(130 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 && expectCut && member === "agent" ? 400 : 150);
    }
    expect(restartContinuations(ledger)).toHaveLength(expectCut && member === "agent" ? 1 : 0);
    expect(restartCuts(cut.registryFile)).toMatchObject(!expectCut ? [] : [member === "agent"
      ? { turnRef: "T1", boundary: "viewer-restart:turn" }
      : { turnRef: "T1", state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" }]);
  });
});

test("a turn the operator interrupted, its marker recorded before the end, records nothing (D3)", async () => {
  await withJournal(async (journal) => {
    const interrupted = interruptedClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(74), deadEngine(2_000_001_174), interrupted.records);
    appendHostLedger(cut, interrupted.ledger);
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test.each([{ followUp: "open", records: 1 }, { followUp: "finished", records: 0 }] as const)(
  "an orderly release of an idle Claude host whose self-started work is $followUp (D3)",
  async ({ followUp, records: expected }) => {
    await withJournal(async (journal) => {
      const engine = deadEngine(2_000_001_175);
      const ended = endedWaitingOnBackground();
      const cut = incumbentConversation("claude", cutSessionId(75), engine, ended.records);
      const call = followUpCall();
      appendTranscript(cut, [gateNotification(), call, ...(followUp === "finished" ? followUpEnd() : [])]);
      appendHostLedger(cut, [...ended.ledger, frameOf(call, null),
        ...(followUp === "finished" ? followUpEnd().map((record) => frameOf(record, null)) : [])]);
      const { registry, key, host } = await persistedIdleClaudeHost(cut, createFakeDeliveryLedger(), engine);
      await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
      await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
      await bindStructuredDeliveryQueue([], { registry, client: null });
      expect(obligationsFor(cut.registryFile)).toMatchObject(expected === 0 ? [] : [{ reason: "viewer-release", state: "owed" }]);

      const ledger = createFakeDeliveryLedger();
      for (const index of [1, 2]) {
        expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(140 + index) })).error).toBeNull();
        await settle(() => ledger.writes.length > 0, index === 1 && expected > 0 ? 400 : 150);
        /* A continuation is a host turn: the host that delivered it records it. */
        if (index === 1 && expected > 0) appendHostLedger(cut, [turnStarted("T-continuation"), turnEnded("T-continuation")]);
      }
      expect(continuationsIn(ledger)).toHaveLength(expected);
      expect(obligationsFor(cut.registryFile)).toHaveLength(expected);
    });
  },
);

test("a late echo of the turn a witness names leaves one record that follows the new work, and the next host turn gets its own (D4)", async () => {
  /* A real process this test started stands in for the CLI that outlives the
     Viewers booting over it. */
  const engineProcess = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1");
    const cut = incumbentConversation("claude", cutSessionId(76), captureProcessIdentity(engineProcess.pid), first);
    asPipelineStage(cut);
    appendHostLedger(cut, [...closedTurnLedger("T1", first), turnStarted("T2")]);
    markHosted(cut, "live", "T2");
    const ledger = createFakeDeliveryLedger();
    /* The first boot records the witness before T2's echo and exits before it adopts. */
    await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(151), adoptionFails: true });
    const [witness] = restartCuts(cut.registryFile);
    expect(witness).toMatchObject({ turnRef: "T2", state: "discharged" });

    /* The CLI, which outlived that Viewer, publishes the turn it had begun. */
    await Bun.sleep(10);
    const echoAt = Date.now();
    appendTranscript(cut, [
      { type: "user", uuid: "t2-prompt", timestamp: new Date(echoAt).toISOString(), message: { role: "user", content: "next" } },
      { type: "assistant", uuid: "t2-call", timestamp: new Date(echoAt).toISOString(), message: { model: "claude", content: [{ type: "tool_use", id: "t2-tool", name: "Bash" }] } },
    ]);
    for (const index of [2, 3]) {
      await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(150 + index), adoptionFails: true });
    }
    const [moved, ...others] = restartCuts(cut.registryFile);
    expect(others).toEqual([]);
    expect(moved).toMatchObject({ id: witness!.id, state: "discharged", resolution: witness!.resolution, checkpoint: { lastEventAt: echoAt } });
    expect(Date.parse(moved!.recordedAt)).toBeGreaterThanOrEqual(echoAt);
    setAgentRegistryForTests(new AgentRegistry(cut.registryFile));
    try {
      expect(Date.parse(defaultPipelinePorts().conversationRestartCut!(cut.conversationId)!.recordedAt)).toBeGreaterThanOrEqual(echoAt);
    } finally {
      setAgentRegistryForTests(null);
    }

    /* The host closes T2 and starts T3 over the unchanged transcript. */
    appendHostLedger(cut, [turnEnded("T2"), turnStarted("T3")]);
    markHosted(cut, "live", "T3");
    await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(154), adoptionFails: true });
    expect(restartCuts(cut.registryFile).map(({ turnRef }) => turnRef).sort()).toEqual(["T2", "T3"]);
    expect(continuationsIn(ledger)).toEqual([]);
  }).finally(async () => {
    if (engineProcess.exitCode === null) engineProcess.kill();
    await engineProcess.exited;
  });
});

test.each(["completed", "interrupted"] as const)("a Codex turn its host closed %s gets neither a restart record nor the generic nudge before the transcript echoes the close", async (status) => {
  await withJournal(async (journal) => {
    /* The rollout still ends mid-tool: the CLI had not written the close yet. */
    const cut = incumbentConversation("codex", cutSessionId(77), deadEngine(2_000_001_177), codexTurnRollout(CUT_TURN));
    appendHostLedger(cut, [turnStarted(CUT_TURN), turnEnded(CUT_TURN, status)]);
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2]) {
      if (index > 1 && !restateHosted(cut, "live", CUT_TURN)) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(160 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0);
    }
    expect(continuationsIn(ledger)).not.toContain(INTERRUPTED_CODEX_CONTINUATION_TEXT);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test.each([
  { bookkeeping: "a shutdown marker", member: "agent", withLedger: true },
  { bookkeeping: "a shutdown marker", member: "stage", withLedger: true },
  { bookkeeping: "a shutdown marker", member: "agent", withLedger: false },
  { bookkeeping: "a meta prompt and a synthetic no-op", member: "agent", withLedger: true },
  { bookkeeping: "nothing", member: "agent", withLedger: true },
] as const)("background work a Claude $member's ended turn waits on is recorded and named after $bookkeeping (host ledger: $withLedger)", async ({ bookkeeping, member, withLedger }) => {
  await withJournal(async (journal) => {
    const ended = endedWaitingOnBackground();
    const cut = incumbentConversation("claude", cutSessionId(78), deadEngine(2_000_001_178), ended.records);
    if (member === "stage") asPipelineStage(cut);
    const at = new Date(Date.now() - 20_000).toISOString();
    appendTranscript(cut, bookkeeping === "a shutdown marker"
      ? [{ type: "user", uuid: "shutdown", timestamp: at, interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } }]
      : bookkeeping === "nothing" ? []
        : [
          { type: "user", uuid: "meta", timestamp: at, isMeta: true, message: { role: "user", content: "Continue from where you left off." } },
          { type: "assistant", uuid: "no-op", timestamp: at, message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
        ]);
    if (withLedger) appendHostLedger(cut, ended.ledger);
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    for (const index of [1, 2, 3]) {
      if (index > 1 && !restateHosted(cut, "idle")) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(170 + index) })).error).toBeNull();
      await settle(() => ledger.writes.length > 0, index === 1 && member === "agent" ? 400 : 150);
    }
    expect(structuredStartupDeferral()).toBeNull();
    const writes = restartContinuations(ledger);
    expect(writes).toHaveLength(member === "agent" ? 1 : 0);
    if (member === "agent") expect(writes[0]).toContain("background task gatetask1");
    expect(restartCuts(cut.registryFile)).toMatchObject([{
      checkpoint: { backgroundTasks: ["background task gatetask1"] },
      ...(member === "stage" ? { state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" } : {}),
    }]);
  });
});

test("direct recovery leaves a row held for its restart cut evidence untouched until the re-probe decides it", async () => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("claude", cutSessionId(79), deadEngine(2_000_001_179));
    const whole = fs.readFileSync(cut.artifactPath, "utf8");
    fs.writeFileSync(cut.artifactPath, `${whole}{"type":"assist`);
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    expect((await successorBoot(cut.registryFile, journal, ledger, { registry })).error).toBeNull();
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);
    const before = registry.readOnlySnapshot().entries[cut.hostKey]!;

    /* A send's recovery, a retry or a control asks before the first re-probe. */
    let spawns = 0;
    const recovery = recoverDeadStructuredConversation({ path: cut.artifactPath, conversationId: cut.conversationId }, {
      registry,
      client: journalClient(journal),
      transport: () => "structured",
      resolveAccount: () => ({ engine: "claude", accountId: "default", kind: "managed", home: path.join(directory, "account"), transcriptRoot: directory, env: { NODE_ENV: "test" } }),
      spawn: async () => {
        spawns += 1;
        return { ok: false, error: "no native spawn in this case" } as never;
      },
    });
    expect(recovery).rejects.toBeInstanceOf(StructuredRecoveryHeldForUpdateError);
    await recovery.catch(() => {});
    expect(spawns).toBe(0);
    const after = new AgentRegistry(cut.registryFile).readOnlySnapshot().entries[cut.hostKey]!;
    expect({ status: after.status, claimEpoch: after.claimEpoch, turn: after.structuredHost?.activeTurnRef, process: after.structuredHost?.process })
      .toEqual({ status: before.status, claimEpoch: before.claimEpoch, turn: CUT_TURN, process: before.structuredHost?.process });
    expect(obligationsFor(cut.registryFile)).toEqual([]);

    /* Repaired evidence still yields its one continuation. */
    fs.writeFileSync(cut.artifactPath, whole);
    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toHaveLength(1);
  });
});

test.each(["agent", "stage"] as const)("a host ledger with a sequence gap invents no cut for a Codex %s until it is repaired", async (member) => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("codex", cutSessionId(80), deadEngine(2_000_001_180), []);
    if (member === "stage") asPipelineStage(cut);
    const ledgerFile = path.join(statePath("structured-host-events"), `${encodeURIComponent(cut.sessionId)}.jsonl`);
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    /* The record at seq 2 is missing: it could be the turn's end. */
    fs.writeFileSync(ledgerFile, [
      { kind: "turn-started", turnId: "T1", seq: 1 },
      { kind: "session-status", status: "idle", seq: 3 },
    ].map((event) => `${JSON.stringify(event)}\n`).join(""));
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    for (let probe = 0; probe < 3; probe += 1) await runScheduledProbe(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);

    /* Repaired: T1 started and nothing ended it. */
    fs.writeFileSync(ledgerFile, [
      { kind: "turn-started", turnId: "T1", seq: 1 },
      { kind: "session-status", status: "active", seq: 2 },
    ].map((event) => `${JSON.stringify(event)}\n`).join(""));
    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0, member === "agent" ? 400 : 150);
    expect(restartContinuations(ledger)).toHaveLength(member === "agent" ? 1 : 0);
    expect(restartCuts(cut.registryFile)).toMatchObject([member === "agent"
      ? { turnRef: "T1", boundary: "viewer-restart:turn", state: expect.any(String) }
      : { turnRef: "T1", state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" }]);
  });
});

function hostLedgerFile(cut: CutConversation): string {
  return path.join(statePath("structured-host-events"), `${encodeURIComponent(cut.sessionId)}.jsonl`);
}

test("a fresh host ledger that reads corrupt over an old transcript stays held, and its repair continues the later turn once (C1, rows 1)", async () => {
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1", 7 * 3_600_000);
    const cut = incumbentConversation("claude", cutSessionId(81), deadEngine(2_000_001_181), first);
    appendHostLedger(cut, [...closedTurnLedger("T1", first), turnStarted("T2")]);
    const ledgerFile = hostLedgerFile(cut);
    const whole = fs.readFileSync(ledgerFile, "utf8");
    fs.appendFileSync(ledgerFile, '{"kind":"item",BROKEN}\n');
    markHosted(cut, "live", "T2");
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    for (let probe = 0; probe < 2; probe += 1) await runScheduledProbe(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);
    expect(registry.readOnlySnapshot().entries[cut.hostKey]).toMatchObject({ status: "live", structuredHost: { activeTurnRef: "T2" } });

    /* Repaired: T2 started and nothing ended it. */
    fs.writeFileSync(ledgerFile, whole);
    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    for (const index of [1, 2]) {
      if (!restateHosted(cut, "live", "T2")) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(150 + index) })).error).toBeNull();
      await settle(() => restartContinuations(ledger).length > 1, 150);
    }
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T2", boundary: "viewer-restart:turn" }]);
  });
});

test("a corrupt host ledger last written before the window, over an old transcript, is left outside it (C1)", async () => {
  await withJournal(async (journal) => {
    const first = closedClaudeTurn("t1", 7 * 3_600_000);
    const cut = incumbentConversation("claude", cutSessionId(82), deadEngine(2_000_001_182), first);
    appendHostLedger(cut, [...closedTurnLedger("T1", first), turnStarted("T2")]);
    const ledgerFile = hostLedgerFile(cut);
    fs.appendFileSync(ledgerFile, '{"kind":"item",BROKEN}\n');
    const old = new Date(Date.now() - 7 * 3_600_000);
    fs.utimesSync(ledgerFile, old, old);
    markHosted(cut, "live", "T2");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger)).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(structuredStartupDeferral()).toBeNull();
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

test.each([
  { shape: "a delta that names no turn", line: '{"kind":"delta","text":"lost turn id","seq":2}' },
  { shape: "a delta whose text is no string", line: '{"kind":"delta","turnId":"T1","text":27,"seq":2}' },
  { shape: "a delta that is not JSON", line: '{"kind":"delta","turnId":"T1","text":BROKEN,"seq":2}' },
] as const)("$shape in a host ledger never authorizes a cut until it is repaired", async ({ line }) => {
  await withJournal(async (journal) => {
    const cut = incumbentConversation("codex", cutSessionId(83), deadEngine(2_000_001_183), []);
    const ledgerFile = hostLedgerFile(cut);
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const lines = (middle: string) => [
      JSON.stringify({ kind: "turn-started", turnId: "T1", seq: 1 }),
      middle,
      JSON.stringify({ kind: "session-status", status: "active", seq: 3 }),
    ].map((text) => `${text}\n`).join("");
    fs.writeFileSync(ledgerFile, lines(line));
    expect(() => new FileRuntimeEventStore(path.dirname(ledgerFile)).load(cut.sessionId)).toThrow();
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    for (let probe = 0; probe < 2; probe += 1) await runScheduledProbe(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);

    /* A second Viewer finds the same evidence and records nothing either. */
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(160) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(obligationsFor(cut.registryFile)).toEqual([]);

    /* Repaired: T1 started and nothing ended it. */
    fs.writeFileSync(ledgerFile, lines(JSON.stringify({ kind: "delta", turnId: "T1", text: "thinking", seq: 2 })));
    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T1", boundary: "viewer-restart:turn" }]);
  });
});

test.each([
  { evidence: "a valid ledger", records: 1 },
  { evidence: "a ledger with a corrupt record", records: 0 },
  { evidence: "a ledger whose frames the transcript never holds", records: 0 },
] as const)("an orderly release of an idle Claude host waiting on background work, its host leaving $evidence", async ({ evidence, records: expected }) => {
  await withJournal(async (journal) => {
    const engine = deadEngine(2_000_001_184);
    const ended = endedWaitingOnBackground();
    const cut = incumbentConversation("claude", cutSessionId(84), engine, ended.records);
    appendHostLedger(cut, evidence === "a ledger whose frames the transcript never holds"
      ? closedTurnLedger("T1", ended.records.map((record) => ({ ...record, uuid: `elsewhere-${String(record.uuid)}` })))
      : ended.ledger);
    if (evidence === "a ledger with a corrupt record") fs.appendFileSync(hostLedgerFile(cut), '{"kind":"item",BROKEN}\n');
    const { registry, key, host } = await persistedIdleClaudeHost(cut, createFakeDeliveryLedger(), engine);
    await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
    await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(obligationsFor(cut.registryFile)).toMatchObject(expected === 0 ? [] : [{
      reason: "viewer-release", state: "owed", checkpoint: { backgroundTasks: ["background task gatetask1"] },
    }]);

    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(171) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, expected > 0 ? 400 : 150);
    expect(continuationsIn(ledger)).toHaveLength(expected);
    expect(obligationsFor(cut.registryFile)).toHaveLength(expected);
  });
});

/** The turn a host records for a continuation it delivered: the prompt the
    agent was sent, and what the agent did with it. */
function continuationTurn(name: string, prompt: string, ending: "finished" | "mid-tool" | "launched gatetask2"): Record<string, unknown>[] {
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  const promptRecord = { type: "user", uuid: `${name}-prompt`, timestamp: at(0), message: { role: "user", content: prompt } };
  if (ending === "mid-tool") {
    return [promptRecord, { type: "assistant", uuid: `${name}-call`, timestamp: at(1), message: { model: "claude", content: [{ type: "tool_use", id: `${name}-tool`, name: "Bash" }] } }];
  }
  if (ending === "finished") {
    return [promptRecord, { type: "assistant", uuid: `${name}-end`, timestamp: at(1), message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "I read the gate output and finished." }] } }];
  }
  return [
    promptRecord,
    { type: "assistant", uuid: `${name}-call`, timestamp: at(1), message: { model: "claude", content: [{ type: "tool_use", id: `${name}-tool`, name: "Bash", input: { run_in_background: true } }] } },
    { type: "user", uuid: `${name}-result`, timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${name}-tool`, content: "Command running in background with ID: gatetask2." }] },
      toolUseResult: { backgroundTaskId: "gatetask2" } },
    { type: "assistant", uuid: `${name}-end`, timestamp: at(3), message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "Waiting for the gate again." }] } },
  ];
}

test.each([
  { after: "finishes", ending: "finished", continuations: 1, tasks: [["background task gatetask1"]] },
  { after: "is cut mid-tool", ending: "mid-tool", continuations: 2, tasks: [["background task gatetask1"], undefined] },
  { after: "launches a new background job", ending: "launched gatetask2", continuations: 2, tasks: [["background task gatetask1"], ["background task gatetask2"]] },
] as const)("background work a continuation reported as killed is never cut again, and the turn that $after gets what it is owed", async ({ ending, continuations, tasks }) => {
  await withJournal(async (journal) => {
    const ended = endedWaitingOnBackground();
    const cut = incumbentConversation("claude", cutSessionId(85), deadEngine(2_000_001_185), ended.records);
    appendHostLedger(cut, ended.ledger);
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(180) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);

    /* The host records the continuation as a turn of its own. The job died
       with the previous process, so its completion notice never arrives. */
    const resumed = continuationTurn("resume", restartContinuations(ledger)[0]!, ending);
    appendTranscript(cut, resumed);
    appendHostLedger(cut, ending === "mid-tool"
      ? [turnStarted("T-continuation"), ...resumed.map((record) => frameOf(record, "T-continuation"))]
      : closedTurnLedger("T-continuation", resumed));
    for (const index of [1, 2, 3]) {
      if (!restateHosted(cut, ending === "mid-tool" ? "live" : "idle", ending === "mid-tool" ? "T-continuation" : null)) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(180 + index) })).error).toBeNull();
      await settle(() => restartContinuations(ledger).length > 1, index === 1 && continuations > 1 ? 400 : 150);
    }
    expect(restartContinuations(ledger)).toHaveLength(continuations);
    expect(restartCuts(cut.registryFile).map(({ checkpoint }) => checkpoint.backgroundTasks)).toEqual(tasks.slice(0, continuations) as never);
    if (ending === "launched gatetask2") expect(restartContinuations(ledger)[1]).not.toContain("gatetask1");
  });
});

test("an orderly release of an idle Claude host records nothing for background work a continuation already reported as killed", async () => {
  await withJournal(async (journal) => {
    const engine = deadEngine(2_000_001_186);
    const ended = endedWaitingOnBackground();
    const cut = incumbentConversation("claude", cutSessionId(86), engine, ended.records);
    appendHostLedger(cut, ended.ledger);
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(190) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0);
    expect(restartContinuations(ledger)).toHaveLength(1);
    const resumed = continuationTurn("resume", restartContinuations(ledger)[0]!, "finished");
    appendTranscript(cut, resumed);
    appendHostLedger(cut, closedTurnLedger("T-continuation", resumed));

    const { registry, key, host } = await persistedIdleClaudeHost(cut, createFakeDeliveryLedger(), engine);
    await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
    await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(obligationsFor(cut.registryFile).map(({ reason }) => reason)).toEqual(["viewer-restart"]);
  });
});

/** A turn that ended waiting on `gatetask1`, its completion notice, more than
    a tail of other records, and a later turn that ended: the notice lies above
    the tail the turn reader takes. */
function backgroundEndedAboveTheTail(): { records: Record<string, unknown>[]; ledger: Array<Record<string, unknown>>; notice: Record<string, unknown> } {
  const ended = endedWaitingOnBackground();
  const notice = gateNotification();
  const padding = Array.from({ length: 90 }, (_, index) => ({ type: "progress", index, data: "x".repeat(2048) }));
  const later = closedClaudeTurn("later");
  return {
    records: [...ended.records, notice, ...padding, ...later],
    ledger: [...ended.ledger, ...closedTurnLedger("T2", later)],
    notice,
  };
}

/** Breaks one record of the transcript where it stands; returns the repair. */
function corruptTranscriptRecord(cut: CutConversation, record: Record<string, unknown>): () => void {
  const whole = fs.readFileSync(cut.artifactPath, "utf8");
  const line = JSON.stringify(record);
  expect(whole).toContain(line);
  fs.writeFileSync(cut.artifactPath, whole.replace(line, `${line.slice(0, -1)},BROKEN}`));
  return () => fs.writeFileSync(cut.artifactPath, whole);
}

test("a background job whose completion notice lies above the transcript tail is no cut", async () => {
  await withJournal(async (journal) => {
    const settled = backgroundEndedAboveTheTail();
    const cut = incumbentConversation("claude", cutSessionId(87), deadEngine(2_000_001_187), settled.records);
    appendHostLedger(cut, settled.ledger);
    markHosted(cut, "idle");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(200) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(structuredStartupDeferral()).toBeNull();
    expect(restartCuts(cut.registryFile)).toEqual([]);
    expect(continuationsIn(ledger)).toEqual([]);
  });
});

test.each([
  { job: "ended", continuations: 0 },
  { job: "still pending", continuations: 1 },
] as const)("a corrupt background record above the transcript tail invents no cut across probes and boots, and its repair decides the row (job $job)", async ({ job, continuations }) => {
  await withJournal(async (journal) => {
    const settled = backgroundEndedAboveTheTail();
    /* The pending case reports another task and leaves `gatetask1` running. */
    const notice = job === "ended" ? settled.notice : {
      ...settled.notice,
      message: { role: "user", content: "<task-notification>\n<task-id>othertask</task-id>\n<status>completed</status>\n</task-notification>" },
    };
    const records = settled.records.map((record) => record === settled.notice ? notice : record);
    const cut = incumbentConversation("claude", cutSessionId(88), deadEngine(2_000_001_188), records);
    appendHostLedger(cut, settled.ledger);
    markHosted(cut, "idle");
    const repair = corruptTranscriptRecord(cut, notice);
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    for (let probe = 0; probe < 2; probe += 1) await runScheduledProbe(() => ledger.writes.length > 0, 150);
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(210) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);

    repair();
    await runScheduledProbe(() => ledger.writes.length > 0, continuations > 0 ? 400 : 150);
    await settle(() => ledger.writes.length > 0, continuations > 0 ? 400 : 150);
    expect(restartContinuations(ledger)).toHaveLength(continuations);
    expect(restartCuts(cut.registryFile).map(({ checkpoint }) => checkpoint.backgroundTasks))
      .toEqual(continuations > 0 ? [["background task gatetask1"]] : []);
    expect(structuredStartupDeferral()).toBeNull();
  });
});

test("an orderly release of an idle Claude host whose background records read corrupt above the tail records nothing", async () => {
  await withJournal(async (journal) => {
    const engine = deadEngine(2_000_001_189);
    const settled = backgroundEndedAboveTheTail();
    const cut = incumbentConversation("claude", cutSessionId(89), engine, settled.records);
    appendHostLedger(cut, settled.ledger);
    corruptTranscriptRecord(cut, settled.notice);
    const { registry, key, host } = await persistedIdleClaudeHost(cut, createFakeDeliveryLedger(), engine);
    await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
    await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(obligationsFor(cut.registryFile)).toEqual([]);
  });
});

/** A Claude turn its host started and that is mid-tool, and the records that
    end it by itself. */
function openClaudeTurn(): { records: Record<string, unknown>[]; ledger: Array<Record<string, unknown>>; ending: Record<string, unknown>[] } {
  const [prompt, call, result, end] = closedClaudeTurn("t1");
  return {
    records: [prompt!, call!],
    ledger: [turnStarted("T1"), frameOf(prompt!, "T1"), frameOf(call!, "T1")],
    ending: [result!, end!],
  };
}

test.each([
  { member: "agent", window: "before the row is claimed" },
  { member: "stage", window: "before the row is claimed" },
  { member: "agent", window: "after a pass that recorded it and never adopted" },
  { member: "stage", window: "after a pass that recorded it and never adopted" },
] as const)("$member: a turn that ends by itself $window owes no continuation and leaves no restart record", async ({ member, window }) => {
  await withJournal(async (journal) => {
    const open = openClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(90), deadEngine(2_000_001_190), open.records);
    if (member === "stage") asPipelineStage(cut);
    appendHostLedger(cut, open.ledger);
    markHosted(cut, "live", "T1");
    const complete = () => {
      appendTranscript(cut, open.ending);
      appendHostLedger(cut, [...open.ending.map((record) => frameOf(record, "T1")), turnEnded("T1")]);
    };
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    if (window === "before the row is claimed") {
      const boot = await successorBoot(cut.registryFile, journal, ledger, { registry, beforeAdoption: complete });
      expect(boot.error).toBeNull();
      expect(boot.adopted).toEqual([]);
      expect(restartCuts(cut.registryFile)).toEqual([]);
      await runScheduledProbe(() => ledger.writes.length > 0, 150);
    } else {
      expect((await successorBoot(cut.registryFile, journal, ledger, { registry, adoptionFails: true })).error).not.toBeNull();
      expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T1" }]);
      complete();
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(220) })).error).toBeNull();
    }
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(obligationsFor(cut.registryFile)).toEqual([]);
    expect(structuredStartupDeferral()).toBeNull();
    setAgentRegistryForTests(new AgentRegistry(cut.registryFile));
    try {
      expect(defaultPipelinePorts().conversationRestartCut!(cut.conversationId)).toBeNull();
    } finally {
      setAgentRegistryForTests(null);
    }
  });
});

test.each(["agent", "stage"] as const)("%s: a turn whose shutdown wrote its marker before the row is claimed is still cut, once", async (member) => {
  await withJournal(async (journal) => {
    const open = openClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(91), deadEngine(2_000_001_191), open.records);
    if (member === "stage") asPipelineStage(cut);
    appendHostLedger(cut, open.ledger);
    markHosted(cut, "live", "T1");
    const ledger = createFakeDeliveryLedger();
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, {
      registry,
      beforeAdoption: () => appendTranscript(cut, [{
        type: "user", uuid: "shutdown", timestamp: new Date().toISOString(), interruptedByShutdown: true,
        message: { role: "user", content: "[Request interrupted by user for tool use]" },
      }]),
    });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    await runScheduledProbe(() => ledger.writes.length > 0);
    await settle(() => ledger.writes.length > 0, member === "agent" ? 400 : 150);
    for (const index of [1, 2]) {
      if (!restateHosted(cut, "live", "T1")) break;
      expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(230 + index) })).error).toBeNull();
      await settle(() => restartContinuations(ledger).length > 1, 150);
    }
    expect(restartContinuations(ledger)).toHaveLength(member === "agent" ? 1 : 0);
    expect(restartCuts(cut.registryFile)).toMatchObject([member === "agent"
      ? { turnRef: "T1", boundary: "viewer-restart:turn" }
      : { turnRef: "T1", state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" }]);
  });
});

/** Leaves one source of a row's evidence unreadable; returns the repair. */
function breakEvidence(cut: CutConversation, source: "transcript" | "host ledger"): () => void {
  const file = source === "transcript" ? cut.artifactPath : hostLedgerFile(cut);
  const whole = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, source === "transcript" ? '{"type":"assistant","uuid":"cut-short"' : '{"kind":"item",BROKEN}\n');
  return () => fs.writeFileSync(file, whole);
}

test.each([
  { source: "transcript", turn: "completed" },
  { source: "host ledger", turn: "completed" },
  { source: "transcript", turn: "still open" },
  { source: "host ledger", turn: "still open" },
] as const)("an owed proposal whose $source reads unreadable is held with no adoption or continuation across probes and boots, and its repair decides it (turn $turn)", async ({ source, turn }) => {
  await withJournal(async (journal) => {
    const open = openClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(92), deadEngine(2_000_001_192), open.records);
    appendHostLedger(cut, open.ledger);
    markHosted(cut, "live", "T1");
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { registry: new AgentRegistry(cut.registryFile), adoptionFails: true })).error).not.toBeNull();
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T1", state: "owed" }]);
    if (turn === "completed") {
      appendTranscript(cut, open.ending);
      appendHostLedger(cut, [...open.ending.map((record) => frameOf(record, "T1")), turnEnded("T1")]);
    }
    const repair = breakEvidence(cut, source);
    const registry = new AgentRegistry(cut.registryFile);
    const boot = await successorBoot(cut.registryFile, journal, ledger, { registry, viewer: OTHER_VIEWER(240) });
    expect(boot.error).toBeNull();
    expect(boot.adopted).toEqual([]);
    for (let probe = 0; probe < 2; probe += 1) await runScheduledProbe(() => ledger.writes.length > 0, 150);
    const again = await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(241) });
    expect(again).toEqual({ adopted: [], error: null });
    await settle(() => ledger.writes.length > 0, 150);
    expect(continuationsIn(ledger)).toEqual([]);
    expect(structuredStartupDeferral()?.hostKeys).toEqual([cut.hostKey]);
    expect(restartCuts(cut.registryFile)).toMatchObject([{ turnRef: "T1", state: "owed" }]);

    repair();
    await runScheduledProbe(() => ledger.writes.length > 0, turn === "still open" ? 400 : 150);
    await settle(() => ledger.writes.length > 0, turn === "still open" ? 400 : 150);
    expect(restartContinuations(ledger)).toHaveLength(turn === "still open" ? 1 : 0);
    expect(restartCuts(cut.registryFile)).toMatchObject(turn === "still open" ? [{ turnRef: "T1" }] : []);
    expect(structuredStartupDeferral()).toBeNull();
  });
});

test.each([
  { followUp: "finishes during the background read", records: 0 },
  { followUp: "stays open through the background read", records: 1 },
] as const)("an orderly release of an idle Claude host decides on the evidence as it stands after its reads: self-started work that $followUp", async ({ followUp, records: expected }) => {
  await withJournal(async (journal) => {
    const engine = deadEngine(2_000_001_193);
    const ended = endedWaitingOnBackground();
    const cut = incumbentConversation("claude", cutSessionId(93), engine, ended.records);
    const call = followUpCall();
    appendTranscript(cut, [gateNotification(), call]);
    appendHostLedger(cut, [...ended.ledger, frameOf(call, null)]);
    const { registry, key, host } = await persistedIdleClaudeHost(cut, createFakeDeliveryLedger(), engine);
    await bindStructuredDeliveryQueue([{ key, host }] as never, { registry, client: journalClient(journal) });
    const open = fs.promises.open.bind(fs.promises);
    let transcriptOpens = 0;
    const opens = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      /* The second open of the transcript is the verified background read. */
      if (String(file) === cut.artifactPath && (transcriptOpens += 1) === 2 && followUp === "finishes during the background read") {
        appendTranscript(cut, followUpEnd());
        appendHostLedger(cut, followUpEnd().map((record) => frameOf(record, null)));
      }
      return await (open as (...args: unknown[]) => Promise<fs.promises.FileHandle>)(file, ...rest);
    }) as typeof fs.promises.open);
    try {
      await releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:test-deploy" });
    } finally {
      opens.mockRestore();
    }
    await bindStructuredDeliveryQueue([], { registry, client: null });
    expect(transcriptOpens).toBeGreaterThanOrEqual(2);
    expect(obligationsFor(cut.registryFile)).toMatchObject(expected === 0 ? [] : [{ reason: "viewer-release", state: "owed" }]);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(243) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, expected > 0 ? 400 : 150);
    expect(continuationsIn(ledger)).toHaveLength(expected);
  });
});

test.each(["agent", "stage"] as const)("%s: a proposal the pending journal holds is withdrawn when its turn ends by itself, and stays gone once the directory accepts records", async (member) => {
  await withJournal(async (journal) => {
    const open = openClaudeTurn();
    const cut = incumbentConversation("claude", cutSessionId(94), deadEngine(2_000_001_194), open.records);
    if (member === "stage") asPipelineStage(cut);
    appendHostLedger(cut, open.ledger);
    markHosted(cut, "live", "T1");
    const obligations = interruptionObligationDirectory(cut.registryFile);
    fs.mkdirSync(obligations, { recursive: true });
    fs.chmodSync(obligations, 0o500);
    const ledger = createFakeDeliveryLedger();
    expect((await successorBoot(cut.registryFile, journal, ledger, { registry: new AgentRegistry(cut.registryFile), adoptionFails: true })).error).not.toBeNull();
    const [proposal] = restartCuts(cut.registryFile);
    expect(proposal).toMatchObject({ turnRef: "T1" });
    expect(fs.readdirSync(obligations)).toEqual([]);
    expect(fs.readFileSync(`${obligations}.pending.jsonl`, "utf8")).toContain(proposal!.id);

    appendTranscript(cut, open.ending);
    appendHostLedger(cut, [...open.ending.map((record) => frameOf(record, "T1")), turnEnded("T1")]);
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(244) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(restartCuts(cut.registryFile)).toEqual([]);
    const restartCutOf = () => {
      setAgentRegistryForTests(new AgentRegistry(cut.registryFile));
      try {
        return defaultPipelinePorts().conversationRestartCut!(cut.conversationId);
      } finally {
        setAgentRegistryForTests(null);
      }
    };
    expect(restartCutOf()).toBeNull();

    fs.chmodSync(obligations, 0o700);
    expect(restartCuts(cut.registryFile)).toEqual([]);
    restateHosted(cut, "live", "T1");
    expect((await successorBoot(cut.registryFile, journal, ledger, { viewer: OTHER_VIEWER(245) })).error).toBeNull();
    await settle(() => ledger.writes.length > 0, 150);
    expect(restartCuts(cut.registryFile)).toEqual([]);
    expect(restartCutOf()).toBeNull();
    expect(continuationsIn(ledger)).toEqual([]);
  });
});
