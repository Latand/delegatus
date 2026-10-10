import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite drives the process-scoped delivery controller
   and a startup adoption pass, neither of which may touch the operator's live
   registry, runtime journal, or config directory. */
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-rebind-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
/* Restored in afterAll: a bun run that carries several test files shares one
   process, so an isolated TMPDIR this file then deletes would strand every
   later file's mkdtemp. */
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { createFakeDeliveryLedger, FakeEngineHost } = await import("./fixtures/fakeEngineHost");
const { RuntimeHostUnavailableError } = await import("./client");
const {
  bindStructuredDeliveryQueue,
  completeStructuredDeliveryQueueStartup,
  hasStructuredDeliveryHost,
  publishStructuredDeliveryHost,
  releaseStructuredDeliveryHost,
  structuredDeliveryPublicationState,
} = await import("./structuredDeliveryController");
const { kickStructuredDeliveryQueue } = await import("./structuredDeliverySignal");
const { adoptStructuredHostsAtStartup } = await import("./startup");
type AgentRegistry = InstanceType<typeof AgentRegistry>;
type RuntimeHostClient = import("./client").RuntimeHostClient;
type SessionKey = import("@/lib/agent/sessionKey").SessionKey;

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

function runtimeClient(journal: InstanceType<typeof RuntimeJournal>): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    waitEvents: async (after: number) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    producerCursor: async (producerKind: string, eventKeyPrefix: string) =>
      journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

function structuredHost() {
  return Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), { onStateChange: () => () => {} });
}

/** Seeds the conversation and structured-host entry a delivery needs to resolve
    a published host, and answers the conversation id with the session key the
    delivery queue will look the host up under. */
function seedConversation(
  registry: AgentRegistry,
  directory: string,
  name: string,
): { conversationId: string; key: SessionKey } {
  const artifactPath = path.join(directory, `${name}.jsonl`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "rebind-fixture-account",
    launchProfile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-08-26T10:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("seeded conversation is missing");
  const key: SessionKey = { engine: "codex", sessionId: generation.id };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "rebind-fixture-account",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:rebind-fixture-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  return { conversationId: conversation.id, key };
}

/** Holds the first `producerCursor` call of a bind open. That parks the
    registration of a carried-over host between its seat and its commit, which
    is the window every lifecycle assertion below is about (#1191). */
function producerCursorGate(client: RuntimeHostClient, journal: InstanceType<typeof RuntimeJournal>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let gated = true;
  return {
    started,
    open: () => open(),
    client: {
      ...client,
      producerCursor: async (producerKind: string, eventKeyPrefix: string) => {
        if (gated) {
          gated = false;
          entered();
          await gate;
        }
        return journal.producerCursor(producerKind, eventKeyPrefix);
      },
    } as RuntimeHostClient,
  };
}

/** A structured host that counts the releases it receives, so "exactly once"
    is an assertion instead of an inference. */
function releaseCountingHost() {
  const releases = { count: 0 };
  return {
    releases,
    host: Object.assign(structuredHost(), { release: async () => { releases.count += 1; } }),
  };
}

async function settles(assertion: () => boolean, what = "rebind condition"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
}

function fixture(name: string) {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  return {
    directory,
    registry,
    journal,
    client: runtimeClient(journal),
    close: async () => {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      journal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a process that never bound the delivery queue reports an unbound publication (#1191)", () => {
  /* Read from a fresh process: the publication lives on `process`, so any bind
     this suite (or a sibling file sharing the run) already performed would
     answer for it here. */
  const probe = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      "const controller = await import(\"./src/lib/runtime/structuredDeliveryController.ts\");"
        + " console.log(controller.structuredDeliveryPublicationState());",
    ],
    cwd: repoRoot,
    env: { ...process.env, ...isolatedEnvironment },
  });

  expect(probe.stdout.toString().trim()).toBe("unbound");
});

test("startup drains registered hosts while retaining original sends for unregistered hosts", async () => {
  const { registry, journal, directory, client, close } = fixture("startup-partial-registration");
  const first = seedConversation(registry, directory, "first-startup-host");
  const second = seedConversation(registry, directory, "second-startup-host");
  const firstHost = structuredHost();
  const secondHost = structuredHost();
  try {
    await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
    await publishStructuredDeliveryHost({ key: first.key, host: firstHost });
    for (const [index, target] of [first, second].entries()) {
      if (index === 1) journal.append({
        scope: { type: "session", id: target.conversationId }, kind: "session-status",
        payload: { conversationId: target.conversationId, sessionKey: target.key,
          hostKind: "codex-app-server", host: "hosted", turn: "idle" },
      });
      journal.executeOperation({
        kind: "send", operationId: `startup-original-${index}`,
        idempotencyKey: `startup-original-key-${index}`, conversationId: target.conversationId,
        text: `original payload ${index}`, policy: "queue",
      });
    }
    const pending = journal.operationResult("startup-original-1");
    expect(pending?.receipt.status).toBe("queued");
    await kickStructuredDeliveryQueue();
    await settles(() => journal.operationResult("startup-original-0")?.receipt.status === "delivered");
    expect(journal.operationResult("startup-original-1")).toEqual(pending);
    expect(secondHost.ledger.writes).toEqual([]);
    await publishStructuredDeliveryHost({ key: second.key, host: secondHost });
    await kickStructuredDeliveryQueue();
    await settles(() => journal.operationResult("startup-original-1")?.receipt.status === "delivered");
    await completeStructuredDeliveryQueueStartup([]);
    expect(firstHost.ledger.writes).toMatchObject([{ id: "startup-original-0", text: "original payload 0" }]);
    expect(secondHost.ledger.writes).toMatchObject([{ id: "startup-original-1", text: "original payload 1" }]);
    expect(firstHost.ledger.writes).toHaveLength(1);
    expect(secondHost.ledger.writes).toHaveLength(1);
  } finally {
    await close();
  }
});

test("separate Next bundle realms share one delivery controller lifecycle (#572)", async () => {
  const { registry, directory, client, close } = fixture("bundle-realms");
  const moduleCopy = (name: string) => `./structuredDeliveryController?${name}`;
  const instrumentationRealm = await import(moduleCopy("issue-572-instrumentation"));
  const routeRealm = await import(moduleCopy("issue-572-route"));
  const { key } = seedConversation(registry, directory, "bundle-realm-session");
  const host = structuredHost();

  try {
    expect(instrumentationRealm).not.toBe(routeRealm);
    await instrumentationRealm.bindStructuredDeliveryQueue([], { registry, client });
    expect(routeRealm.hasStructuredDeliveryController(registry)).toBe(true);

    await routeRealm.publishStructuredDeliveryHost({ key, host });
    expect(instrumentationRealm.hasStructuredDeliveryHost(key)).toBe(true);

    /* Re-entering startup through the other compiled module replaces the
       generation while preserving its one process-owned host lifecycle. */
    await routeRealm.bindStructuredDeliveryQueue([], { registry, client });
    expect(instrumentationRealm.hasStructuredDeliveryController(registry)).toBe(true);
    expect(instrumentationRealm.hasStructuredDeliveryHost(key)).toBe(true);
  } finally {
    await close();
  }
});

test("a spawn issued while the queue rebinds is published once the bind completes (#1191)", async () => {
  const { registry, journal, client, close } = fixture("rebind-window");
  await bindStructuredDeliveryQueue([], { registry, client });
  expect(structuredDeliveryPublicationState()).toBe("ready");

  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let snapshotEntered!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => { snapshotEntered = resolve; });
  const slowClient = {
    ...client,
    snapshot: async () => {
      snapshotEntered();
      await snapshotGate;
      return journal.snapshot();
    },
  } as RuntimeHostClient;

  const rebind = bindStructuredDeliveryQueue([], { registry, client: slowClient });
  await snapshotStarted;

  /* The spawn lands in the middle of the rebinding pass: the replacement is
     published, the predecessor is retired, and no caller ever sees a gap. */
  const key = { engine: "codex" as const, sessionId: "rebind-window-session" };
  const unregister = await publishStructuredDeliveryHost({ key, host: structuredHost() });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  releaseSnapshot();
  await rebind;

  await unregister();
  await close();
});

test("a startup pass with no runtime client leaves the live publication in place (#1191)", async () => {
  const { registry, client, close } = fixture("clientless-startup");
  await bindStructuredDeliveryQueue([], { registry, client });
  const key = { engine: "claude" as const, sessionId: "clientless-startup-session" };
  const unregister = await publishStructuredDeliveryHost({ key, host: structuredHost() });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  await adoptStructuredHostsAtStartup({
    registry,
    client: null,
    refreshTranscriptState: async () => {},
    adopt: async () => [],
    adoptClaude: async () => [],
  });

  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(structuredDeliveryPublicationState()).toBe("ready");
  const second = { engine: "claude" as const, sessionId: "clientless-startup-successor" };
  const unregisterSecond = await publishStructuredDeliveryHost({ key: second, host: structuredHost() });

  await unregisterSecond();
  await unregister();
  await close();
});

test("retiring the publication leaves the controller rebinding, not unbound (#1191)", async () => {
  const { registry, client, close } = fixture("publication-state");
  await bindStructuredDeliveryQueue([], { registry, client });
  expect(structuredDeliveryPublicationState()).toBe("ready");

  await bindStructuredDeliveryQueue([], { registry, client: null });
  expect(structuredDeliveryPublicationState()).toBe("rebinding");

  await close();
});

test("a publication paused inside the predecessor lands on the controller that replaced it (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("in-flight-swap");
  await bindStructuredDeliveryQueue([], { registry, client });

  const { conversationId, key } = seedConversation(registry, directory, "in-flight-swap-session");
  let releaseOwnership!: () => void;
  const ownershipGate = new Promise<void>((resolve) => { releaseOwnership = resolve; });
  let ownershipEntered!: () => void;
  const ownershipStarted = new Promise<void>((resolve) => { ownershipEntered = resolve; });
  let gated = true;
  const ownsOperation = async () => {
    if (!gated) return true;
    gated = false;
    ownershipEntered();
    await ownershipGate;
    return true;
  };

  const host = structuredHost();
  const publication = publishStructuredDeliveryHost({ key, host }, ownsOperation);
  await ownershipStarted;

  /* The whole rebind lands while that publication is parked inside the
     predecessor's registration: the successor is installed and the predecessor
     retired, so a continuation that committed into its captured maps would
     report a host the live controller does not have. */
  await bindStructuredDeliveryQueue([], { registry, client });
  releaseOwnership();
  const unregister = await publication;

  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-in-flight-swap",
    idempotencyKey: "in-flight-swap",
    conversationId,
    text: "the first delivery after the swap",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => journal.operationResult("operation-in-flight-swap")?.receipt.status === "delivered");
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-in-flight-swap"]);

  await unregister();
  expect(hasStructuredDeliveryHost(key)).toBe(false);
  await close();
});

test("a startup completion chained behind a retired generation registers through its successor (#1282)", async () => {
  const { registry, directory, journal, client, close } = fixture("startup-completion-handover");
  const gate = producerCursorGate(client, journal);
  await bindStructuredDeliveryQueue([], { registry, client: gate.client, deferStartupWork: true });
  const first = seedConversation(registry, directory, "completion-handover-first");
  const second = seedConversation(registry, directory, "completion-handover-second");
  const parked = structuredHost();
  const behind = structuredHost();

  /* Two startup completions, the second chained behind the first, with the
     first parked mid-registration. The rebind lands in between, so the chained
     one resumes inside a generation that no longer owns the publication. */
  const firstCompletion = completeStructuredDeliveryQueueStartup([{ key: first.key, host: parked }]);
  await gate.started;
  const secondCompletion = completeStructuredDeliveryQueueStartup([{ key: second.key, host: behind }]);
  await bindStructuredDeliveryQueue([], { registry, client });
  gate.open();
  await firstCompletion;
  await secondCompletion;

  /* Answering "done" while registering nothing is what leaves a launched host
     with no owner able to write a turn into it. */
  expect(hasStructuredDeliveryHost(first.key)).toBe(true);
  expect(hasStructuredDeliveryHost(second.key)).toBe(true);

  await close();
});

test("a rebind keeps serving the hosts the predecessor already had (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-carry");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-carry-session");
  const host = structuredHost();
  await publishStructuredDeliveryHost({ key, host });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  /* Startup binds with an empty adoption set and completes it later, so a
     successor that starts hostless serves nothing until that completion lands.
     The predecessor's hosts are handed over instead. */
  await bindStructuredDeliveryQueue([], { registry, client });

  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-handover-carry",
    idempotencyKey: "handover-carry",
    conversationId,
    text: "the first delivery after the hand-over",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => journal.operationResult("operation-handover-carry")?.receipt.status === "delivered");
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-handover-carry"]);

  await close();
});

test("a delivery admitted while the successor is still registering lands exactly once (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-window");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-window-session");
  const host = structuredHost();
  await publishStructuredDeliveryHost({ key, host });

  let releaseCursor!: () => void;
  const cursorGate = new Promise<void>((resolve) => { releaseCursor = resolve; });
  let cursorEntered!: () => void;
  const cursorStarted = new Promise<void>((resolve) => { cursorEntered = resolve; });
  let gated = true;
  const gatedClient = {
    ...client,
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => {
      if (gated) {
        gated = false;
        cursorEntered();
        await cursorGate;
      }
      return journal.producerCursor(producerKind, eventKeyPrefix);
    },
  } as RuntimeHostClient;

  const rebind = bindStructuredDeliveryQueue([], { registry, client: gatedClient });
  /* Racing the rebind keeps this deterministic either way: a build that never
     re-registers the carried-over host finishes the bind instead of entering
     the gate, and fails the assertion below rather than hanging. */
  await Promise.race([cursorStarted, rebind]);

  /* The successor owns the publication and its registration of this host is
     still in flight. The host must already resolve, or the delivery admitted
     here settles `failed` with "structured host recovery did not start". */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-handover-window",
    idempotencyKey: "handover-window",
    conversationId,
    text: "admitted mid-registration",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => journal.operationResult("operation-handover-window")?.receipt.status === "delivered");

  releaseCursor();
  await rebind;

  /* Completing the registration neither loses the host nor re-delivers. */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-handover-window"]);

  await close();
});

test("a carried-over host released mid-registration is released once and stays gone (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-release");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { key } = seedConversation(registry, directory, "handover-release-session");
  const { host, releases } = releaseCountingHost();
  await publishStructuredDeliveryHost({ key, host });

  const gate = producerCursorGate(client, journal);
  const rebind = bindStructuredDeliveryQueue([], { registry, client: gate.client });
  /* Racing the rebind keeps this deterministic either way: a build that never
     re-registers the carried-over host finishes the bind instead of entering
     the gate, and fails the assertions below rather than hanging. */
  await Promise.race([gate.started, rebind]);

  /* The successor owns the publication and this host's registration is parked
     inside it. One lifecycle means the release lands on the host itself here,
     not on a seat the registration behind it can undo. */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(await releaseStructuredDeliveryHost(key)).toBe(true);
  expect(hasStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);

  gate.open();
  await rebind;

  /* The registration that resumed cannot bring the host back, and nothing
     releases it a second time. */
  expect(hasStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);
  expect(await releaseStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);

  await close();
});

test("releasing one conversation's host reads and republishes no other conversation's host", async () => {
  /* 2026-10-07 on production: every release republished all 13 to 17
     registered hosts one after another, which added 10.7 to 19.1 s to each
     account switch and made a kill take 16 to 32 s. */
  const { registry, journal, directory, client, close } = fixture("release-scope");
  await bindStructuredDeliveryQueue([], { registry, client });
  const released = seedConversation(registry, directory, "release-scope-released");
  const releasedHost = structuredHost();
  await publishStructuredDeliveryHost({ key: released.key, host: releasedHost });
  const reads = { count: 0 };
  for (const name of ["release-scope-other-one", "release-scope-other-two"]) {
    const { key } = seedConversation(registry, directory, name);
    const host = structuredHost();
    const health = host.health.bind(host);
    await publishStructuredDeliveryHost({ key, host: Object.assign(host, {
      health: async () => { reads.count += 1; return health(); },
    }) });
  }
  const before = reads.count;
  const sessionRevision = () => journal.snapshot().sessions
    .find((session) => session.conversationId === released.conversationId)?.revision ?? 0;
  const revisionBefore = sessionRevision();

  expect(await releaseStructuredDeliveryHost(released.key)).toBe(true);

  expect(reads.count).toBe(before);
  /* The released conversation's own projection is still rewritten. */
  expect(sessionRevision()).toBeGreaterThan(revisionBefore);

  await close();
});

test("a settled operator message moves the files revision, so the board drops its stale delivery state", async () => {
  /* 2026-10-07 on production: the card kept "message not delivered" for 7 to
     15 s after the agent had answered, until the next poll. */
  const { registry, journal, directory, client, close } = fixture("settled-delivery-revision");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "settled-delivery-revision-session");
  await publishStructuredDeliveryHost({ key, host: structuredHost() });
  const reservation = registry.holdDelivery(conversationId as `conversation_${string}`, "Reply with the single word OK",
    "settled-delivery", "text", [], null, { operationId: "operation-settled-delivery" });
  expect(registry.beginDeliveryAttempt(reservation.id, key.sessionId)).toMatchObject({ state: "delivery-uncertain" });
  const revisionBefore = journal.snapshot().filesRevision;

  journal.executeOperation({
    kind: "send",
    operationId: "operation-settled-delivery",
    idempotencyKey: "settled-delivery",
    conversationId,
    text: "Reply with the single word OK",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => registry.readOnlySnapshot().heldDeliveries[reservation.id]?.state !== "delivery-uncertain", "delivery record");
  await settles(() => journal.snapshot().filesRevision > revisionBefore, "files revision");

  await close();
});

test("an inactive carried-over host retired mid-registration is detached and stays gone (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-terminate");
  let gate: ReturnType<typeof producerCursorGate> | undefined;
  let rebind: Promise<void> | undefined;
  try {
    await bindStructuredDeliveryQueue([], { registry, client });
    const { conversationId, key } = seedConversation(registry, directory, "handover-terminate-session");
    const { host, releases } = releaseCountingHost();
    await publishStructuredDeliveryHost({ key, host });

    gate = producerCursorGate(client, journal);
    rebind = bindStructuredDeliveryQueue([], { registry, client: gate.client });
    await Promise.race([gate.started, rebind]);
    expect(hasStructuredDeliveryHost(key)).toBe(true);

    /* A kill effect drains through the controller's termination path while the
       registration is still parked. */
    // This fake host has no process. Publish that fact so the registry's
    // inactive-row termination fence can authorize its teardown.
    registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!, status: "unhosted" });
    journal.executeOperation({
      kind: "kill",
      operationId: "operation-handover-terminate",
      idempotencyKey: "handover-terminate",
      conversationId,
      sessionKey: key,
    });
    await kickStructuredDeliveryQueue();
    await settles(() => {
      const status = journal.operationResult("operation-handover-terminate")?.receipt.status;
      return status === "delivered" || status === "failed" || status === "rejected";
    }, "the kill receipt");
    expect(journal.operationResult("operation-handover-terminate")?.receipt.status).toBe("delivered");
    // Inactive-row retirement detaches the transport. Without process identity
    // it cannot authorize the transport's release callback to signal anything.
    expect(releases.count).toBe(0);
    expect(hasStructuredDeliveryHost(key)).toBe(false);

    gate.open();
    await rebind;

    expect(hasStructuredDeliveryHost(key)).toBe(false);
    expect(releases.count).toBe(0);
  } finally {
    gate?.open();
    try { await rebind; }
    finally { await close(); }
  }
});

test("a carried-over host whose registration fails is retried and delivers exactly once (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-retry");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-retry-session");
  let subscriptions = 0;
  const host = Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), {
    onStateChange: () => { subscriptions += 1; return () => {}; },
  });
  await publishStructuredDeliveryHost({ key, host });
  expect(subscriptions).toBe(1);

  let cursorFailures = 0;
  const failingClient = {
    ...client,
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => {
      if (cursorFailures === 0) {
        cursorFailures += 1;
        throw new RuntimeHostUnavailableError("runtime host request timed out");
      }
      return journal.producerCursor(producerKind, eventKeyPrefix);
    },
  } as RuntimeHostClient;

  await bindStructuredDeliveryQueue([], { registry, client: failingClient });
  expect(cursorFailures).toBe(1);

  /* The failed registration left a host that resolves but that nothing is
     watching: without its own state subscription, a delivery admitted here has
     nothing to wake the queue when the host turns idle again. */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-handover-retry",
    idempotencyKey: "handover-retry",
    conversationId,
    text: "admitted while the registration was failing",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(
    () => journal.operationResult("operation-handover-retry")?.receipt.status === "delivered",
    "the delivery admitted while the registration was failing",
  );

  /* The retry behind the seat makes the registration good. */
  await settles(() => subscriptions === 2, "the retried registration");
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-handover-retry"]);

  await close();
});

test.each(["health-failure", "deadline", "durable-read-loss", "claim-read-failure", "release-write-failure"])("retirement keeps its barrier across controller generations: %s", async (scenario) => {
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { procBackend } = await import("@/lib/proc");
  const { RuntimeHost } = await import("@/runtime-host/host");
  const { serveRuntimeHost } = await import("@/runtime-host/socket");
  const { runtimeHostClient } = await import("./client");
  type HostState = import("./engineHost").HostState;
  type Queue = import("./structuredDeliveryQueue").StructuredDeliveryQueue;
  const root = fs.mkdtempSync(path.join(isolated, "retirement-overlap-"));
  const ready = path.join(root, "ready");
  const child = Bun.spawn([process.execPath, "-e",
    `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`],
    { env: { NODE_ENV: "test", LLV_STATE_DIR: root }, stdout: "ignore", stderr: "ignore" });
  const recordedPid = child.pid;
  const originalKill = process.kill;
  const oldSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const oldStructured = process.env.LLV_STRUCTURED_HOSTS;
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"), { structuredHosts: true });
  const runtime = new RuntimeHost(journal, undefined, undefined, true);
  const socket = path.join(root, "runtime.sock");
  const server = serveRuntimeHost(socket, { handle: (request, options) => runtime.handle(request, options) });
  let replacement: Promise<void> | null = null;
  let oldDrain: Promise<void> | null = null;
  const signals: { signal: NodeJS.Signals | number; status: string | undefined }[] = [];
  let rebindComplete = false;
  let readLost = false;
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    await settles(() => fs.existsSync(ready), "TERM-resistant fixture startup");
    const key: SessionKey = { engine: "codex", sessionId: crypto.randomUUID() };
    const transcript = path.join(root, key.sessionId + ".jsonl");
    fs.writeFileSync(transcript, "");
    const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured", accountId: "account-a" });
    if (begun.kind !== "created") throw new Error("fixture launch refused");
    const conversationId = begun.receipt.conversationId;
    const identity = captureProcessIdentity(recordedPid);
    expect(registry.settleSpawn(begun.receipt.launchId, {
      key, artifactPath: transcript, cwd: root, accountId: "account-a", status: "idle", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio", process: identity,
        eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null,
    }).kind).toBe("settled");
    setAgentRegistryForTests(registry);
    process.env.LLV_RUNTIME_HOST_SOCKET = socket;
    process.env.LLV_STRUCTURED_HOSTS = "1";
    const client = runtimeHostClient()!;
    const firstClient = Object.create(client) as RuntimeHostClient;
    firstClient.operationStatus = async (operationId: string) => {
      if (scenario === "claim-read-failure" && journal.operationResult(operationId)?.receipt.status === "delivering") readLost = true;
      return readLost ? null : client.operationStatus(operationId);
    };
    firstClient.transitionOperation = async (operationId, status, details, options) => {
      if (scenario === "release-write-failure" && operationId === "overlap-retire" && status !== "delivering") {
        throw new RuntimeHostUnavailableError("fixture lost retirement release write");
      }
      return client.transitionOperation(operationId, status, details, options);
    };
    await bindStructuredDeliveryQueue([], { registry, client: firstClient, recover: async () => null });
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null,
      attentionIds: [], provenance: "structured", artifactPath: transcript, writerClaim: "structured-host:fixture:1",
      capabilities: { steer: true, structuredAttention: true },
    } });
    const session = journal.readSession({ conversationId })!;
    await client.command({ kind: "kill", operationId: "overlap-retire", idempotencyKey: "overlap-retire",
      conversationId, sessionKey: key, onlyIfIdle: { revision: session.revision, writerClaim: session.writerClaim! } });
    const oldQueue = (process as typeof process & { __llvStructuredDeliveryController: { activeQueue: Queue } }).__llvStructuredDeliveryController.activeQueue;
    const health: HostState = { sessionKey: key.sessionId, status: "idle", endpoint: "stdio", pid: recordedPid,
      processStartIdentity: identity.startIdentity, protocolVersion: "v2", eventCursor: 1,
      activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null };
    let healthReads = 0;
    const successorHost = Object.assign(structuredHost(), {
      health: async () => {
        if (++healthReads > 1) throw new Error("successor health unavailable");
        return health;
      },
    });
    const successorClient = Object.create(client) as RuntimeHostClient;
    successorClient.operationStatus = async (operationId: string) => {
      const result = await client.operationStatus(operationId);
      return result && scenario === "deadline" ? { ...result, receipt: {
        ...result.receipt, admittedAt: new Date(Date.now() - 180_000).toISOString(),
      } } : result;
    };
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) {
        if (pid !== recordedPid) throw new Error("fixture refused an unrecorded signal");
        signals.push({ signal, status: journal.operationResult("overlap-retire")?.receipt.status });
        expect(rebindComplete).toBe(false);
        if (signal === "SIGTERM" && signals.length === 1) {
          readLost = scenario === "durable-read-loss";
          replacement = (async () => {
            await bindStructuredDeliveryQueue([{ key, host: successorHost }], { registry, client: successorClient, recover: async () => null });
            rebindComplete = true;
            // Force another successor pass while the predecessor is in grace.
            await kickStructuredDeliveryQueue();
            expect(journal.operationResult("overlap-retire")?.receipt.status).toBe("delivering");
            await expect(client.transitionOperation("overlap-retire", "failed", { reason: "competing health failure" })).rejects.toThrow("another executor");
            await expect(client.transitionOperation("overlap-retire", "uncertain", { reason: "competing deadline" })).rejects.toThrow("another executor");
            const racing = await client.command({ kind: "send", operationId: "overlap-racing-work", idempotencyKey: "overlap-racing-work",
              conversationId, policy: "queue", text: "work during teardown" });
            expect(racing.receipt).toMatchObject({ status: "rejected", reason: "idle-retirement-in-progress" });
          })();
        }
      }
      return originalKill.call(process, pid, signal);
    }) as typeof process.kill;
    oldDrain = oldQueue.drain();
    if (scenario === "claim-read-failure") {
      await oldDrain;
      expect(signals).toEqual([]);
      expect(journal.operationResult("overlap-retire")?.receipt.status).toBe("delivering");
      const racing = await client.command({ kind: "send", operationId: "overlap-claim-racing-work", idempotencyKey: "overlap-claim-racing-work",
        conversationId, policy: "queue", text: "work before claim recovery" });
      expect(racing.receipt.reason).toBe("idle-retirement-in-progress");
      await bindStructuredDeliveryQueue([{ key, host: successorHost }], { registry, client: successorClient, recover: async () => null });
      rebindComplete = true;
      await kickStructuredDeliveryQueue();
    } else {
      await settles(() => replacement !== null, "first retirement TERM");
      await replacement;
      await expect(oldDrain).rejects.toThrow(scenario === "release-write-failure"
        ? "fixture lost retirement release write" : "idle-retirement-authority-lost");
      if (scenario === "release-write-failure") {
        expect(journal.operationResult("overlap-retire")?.receipt.status).toBe("delivering");
        // The predecessor has returned without releasing its claim. A live
        // Viewer PID can now be recovered using local executor completion.
        await kickStructuredDeliveryQueue();
        await kickStructuredDeliveryQueue();
      }
    }
    expect(journal.operationResult("overlap-retire")?.receipt.status).not.toBe("delivering");
    const next = await client.command({ kind: "send", operationId: "overlap-new-work", idempotencyKey: "overlap-new-work",
      conversationId, policy: "queue", text: "work after the signal ladder stopped" });
    expect(next.receipt.status).toBe("queued");
    await Bun.sleep(650);
    expect(signals).toEqual(scenario === "claim-read-failure" ? [] : [{ signal: "SIGTERM", status: "delivering" }]);
    expect(procBackend.pidAlive(recordedPid)).toBe(true);
  } finally {
    await oldDrain?.catch(() => {});
    await (replacement as Promise<void> | null)?.catch(() => {});
    process.kill = originalKill;
    await bindStructuredDeliveryQueue([], { registry, client: null });
    setAgentRegistryForTests(null);
    if (oldSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = oldSocket;
    if (oldStructured === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = oldStructured;
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close();
    if (child.exitCode === null) child.kill(9);
    await child.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("the watchdog runs while startup is still seating hosts: a registered conversation's unreadable send stalls and recovers once, and an unregistered host's send waits for startup", async () => {
  /* docs/design/delivery-progress-and-drain.md, A7. */
  const { registry, journal, directory, client, close } = fixture("startup-watchdog");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  const first = seedConversation(registry, directory, "watchdog-registered");
  const second = seedConversation(registry, directory, "watchdog-unregistered");
  const firstHost = structuredHost();
  const secondHost = structuredHost();
  let unreadable = true;
  const reading = {
    ...client,
    operationStatus: async (operationId: string) => {
      if (unreadable && operationId === "watchdog-original-0") throw new RuntimeHostUnavailableError("runtime host is unavailable");
      return journal.operationResult(operationId);
    },
  } as RuntimeHostClient;
  try {
    await bindStructuredDeliveryQueue([], { registry, client: reading, deferStartupWork: true, progress,
      watchdogIntervalMs: 5, settlementSweepMs: 0, queueTiming: { stallMs: 20, safetyPassMs: 40 } });
    await publishStructuredDeliveryHost({ key: first.key, host: firstHost });
    for (const [index, target] of [first, second].entries()) {
      journal.append({ scope: { type: "session", id: target.conversationId }, kind: "session-status",
        payload: { conversationId: target.conversationId, sessionKey: target.key, hostKind: "codex-app-server", host: "hosted", turn: "idle" } });
      journal.executeOperation({ kind: "send", operationId: `watchdog-original-${index}`, idempotencyKey: `watchdog-key-${index}`,
        conversationId: target.conversationId, text: `watchdog payload ${index}`, policy: "queue" });
    }
    /* No manual kick: only the watchdog moves anything. */
    await settles(() => progress.get("watchdog-original-0")?.stalledSince != null, "stall during startup");
    expect(progress.get("watchdog-original-1")?.waitReason).toBe("startup");
    unreadable = false;
    await settles(() => firstHost.ledger.writes.length === 1, "registered host delivery during startup");
    expect(secondHost.ledger.writes).toEqual([]);
    await publishStructuredDeliveryHost({ key: second.key, host: secondHost });
    await completeStructuredDeliveryQueueStartup([]);
    await kickStructuredDeliveryQueue();
    await settles(() => secondHost.ledger.writes.length === 1, "unregistered host delivery after startup");
    expect(firstHost.ledger.writes).toHaveLength(1);
  } finally {
    await close();
  }
});

test("startup projection waits for the lock off the loop and leaves refused outcomes owed to the journal", async () => {
  /* docs/design/delivery-progress-and-drain.md, C3. */
  const { sqliteRegistryFixture, registryLockHolder, longestLoopGap } = await import("@/lib/agent/registryLockHolderFixture");
  const made = sqliteRegistryFixture("llv-startup-projection", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  const journal = new RuntimeJournal(path.join(made.root, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  try {
    const target = seedConversation(registry, made.root, "projection-owed");
    const held = registry.holdDelivery(target.conversationId as `conversation_${string}`, "projected at startup", "projection-key", "text", [], null,
      { operationId: "projection-operation", kind: "send", policy: "queue" });
    registry.beginDeliveryAttempt(held.id, held.generationId!);
    journal.append({ scope: { type: "session", id: target.conversationId }, kind: "session-status",
      payload: { conversationId: target.conversationId, sessionKey: target.key, hostKind: "codex-app-server", host: "hosted", turn: "idle" } });
    journal.executeOperation({ kind: "send", operationId: "projection-operation", idempotencyKey: "projection-key",
      conversationId: target.conversationId, text: "projected at startup", policy: "queue" });
    journal.transitionOperation("projection-operation", "delivering");
    journal.transitionOperation("projection-operation", "delivered");

    await holder.hold(600);
    const { gapMs } = await longestLoopGap(() => bindStructuredDeliveryQueue([], { registry, client, watchdogIntervalMs: 0, settlementSweepMs: 0 }));
    expect(gapMs).toBeLessThan(50);
    expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivery-uncertain" });
    await Bun.sleep(650);
    await bindStructuredDeliveryQueue([], { registry, client, watchdogIntervalMs: 0, settlementSweepMs: 0 });
    expect(registry.snapshot().deliveryOperationOwners["projection-operation"]).toMatchObject({ terminalState: "delivered" });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    await holder.close();
    registry.close();
    made.cleanup();
  }
});
