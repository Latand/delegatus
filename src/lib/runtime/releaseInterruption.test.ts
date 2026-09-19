import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { completeViewerReleaseDemotion } from "@/lib/viewerInstrumentation";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { HostState } from "./engineHost";
import { createFakeDeliveryLedger, FakeEngineHost, type FakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import type { StructuredHostAdoptionFilter } from "./registry";
import { adoptStructuredHostsAtStartup } from "./startup";
import { bindStructuredDeliveryQueue, releaseStructuredDeliveryHostsForDemotion } from "./structuredDeliveryController";
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

beforeEach(() => {
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
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
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
    /** Runs inside adoption, after the rows are claimed. */
    duringAdoption?: (registry: AgentRegistry) => Promise<void>;
  } = {},
): Promise<{ adopted: string[]; error: unknown }> {
  const registry = new AgentRegistry(registryFile);
  const adopted: string[] = [];
  const successor = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const adopt = async (
    engine: "codex" | "claude",
    received: AgentRegistry,
    shouldAdopt: StructuredHostAdoptionFilter,
  ) => {
    if (options.adoptionFails) throw new Error("successor exited before adopting its hosts");
    return Object.values(received.readOnlySnapshot().entries).flatMap((entry) => {
      if (entry.key.engine !== engine || !entry.structuredHost || !shouldAdopt(entry)) return [];
      const claimed = received.claimStructuredHost(entry.key, successor, { allowUnhosted: true });
      if (!claimed?.structuredHost || !claimed.claimOwner) return [];
      if (!received.setStructuredHostClaimed(entry.key, {
        ...claimed.structuredHost,
        endpoint: `fake:successor-${entry.key.sessionId}`,
        process: successor,
        activeTurnRef: null,
      }, "idle", claimed.claimOwner, claimed.claimEpoch)) return [];
      adopted.push(`${engine}:${entry.key.sessionId}`);
      return [{ key: entry.key, host: hostFor(ledger) as never }];
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
      releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:seat-deploy", seatFor: async () => ({ project: seat.project, seatEpoch: seat.seatEpoch }) }));
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
      releaseStructuredDeliveryHostsForDemotion({ boundary: "viewer-release:rotation", seatFor: async () => ({ project: seat.project, seatEpoch: seat.seatEpoch }) }));
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
