/* The one self-update service of this web process, wired to the real
   install (#2007). Everything that resolves the state directory runs on the
   first request, never while a module loads (#1905). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { livenessProbe } from "@/lib/agent/accountLiveness";
import { agentLivenessSnapshot, canonicalConversationId, conversationIdForPath, conversationRegistryHost, headlessReviewerProcess, headlessRoundProcess, productionLivenessSources, type AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { structuredDeliveryHostForConversation } from "@/lib/runtime/structuredDeliveryController";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { viewerOwnProjectKeys } from "@/lib/monitor/seatTickSources";
import { flowPipelineController } from "@/lib/pipelines/controller";
import { seatTickIdle } from "@/lib/monitor/seatTickController";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { readRuntimeSession, runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { loadFlows } from "@/lib/flows/store";
import { listPresence } from "@/lib/view/presenceStore";
import { requestViewerDeployment } from "@/lib/runtime/deploymentRuntime";
import { stateDir, statePath } from "@/lib/configDir";
import { readHotStateReleaseTarget } from "@/lib/state/hotStateAuthority";

import { buildEnv } from "./env";
import { CANONICAL_REMOTE, checkForUpdate, readRevision, runGit } from "./git";
import { requestRestart } from "./launcher";
import { detectMode, productionModePorts } from "./mode";
import { sameProcess } from "./pid";
import { procBackend } from "@/lib/proc";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { currentHostTurnIdle, type QuietPorts, type QuietTurn } from "./quiet";
import { memAvailableMb, realPorts, UpdateRunner } from "./steps";
import type { Snapshot } from "./types";
import { admittedRecords } from "../../../bin/self-update-supervisor.mjs";

const POLL_MINUTES = 60;
const SSE_MIN_GAP_MS = 250;
const TICK_ACTIVE_MS = 1_000;
const TICK_IDLE_MS = 5_000;
const KEEPALIVE_MS = 15_000;

const preparing = new Map<string, Promise<string>>();

/* The snapshot and the check both ask for the repository, often at the same
   moment on first use; two `git init`s racing over one directory fail on
   each other's template files. One preparation per directory is in flight at
   a time, and the repository is created without template hooks at all. */
/** The bare repository the managed install checks against. Its object store
    borrows the deploy adapter's canonical mirror (read-only, through git's
    alternates) when that mirror exists, so a check fetches only what is new;
    nothing is ever written into the mirror. */
export function prepareManagedCheckRepo(directory: string, mirrorObjects: string): Promise<string> {
  const running = preparing.get(directory);
  if (running) return running;
  const next = prepareOnce(directory, mirrorObjects).finally(() => preparing.delete(directory));
  preparing.set(directory, next);
  return next;
}

async function prepareOnce(directory: string, mirrorObjects: string): Promise<string> {
  if (!existsSync(join(directory, "HEAD"))) {
    mkdirSync(directory, { recursive: true });
    const result = await runGit(["init", "--bare", "--quiet", "--template=", directory], directory);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "git init failed");
  }
  const alternates = join(directory, "objects", "info", "alternates");
  if (existsSync(mirrorObjects)) {
    let current = "";
    try { current = readFileSync(alternates, "utf8").trim(); } catch { /* none yet */ }
    if (current !== mirrorObjects) {
      mkdirSync(join(directory, "objects", "info"), { recursive: true });
      writeFileSync(alternates, `${mirrorObjects}\n`);
    }
  }
  return directory;
}

/**
 * The evidence a restart judges one journal row on: the row `agent_activity`
 * answers for the conversation, read through the same snapshot it uses, then
 * the host its registry row names, the headless reviewer a flow round names,
 * then what a host in this Viewer says about its own turn (#2515).
 *
 * The drain used to ask a second liveness reading that answers only for a
 * registry row still carrying its structured host columns. A host that died
 * has those columns cleared, so every such row came back with no answer, and
 * no answer blocked the update for as long as the row existed.
 */
export function turnEvidenceReader(
  sources: () => AgentLivenessSources = productionLivenessSources,
): NonNullable<QuietPorts["turnLiveness"]> {
  let base: AgentLivenessSources | null = null;
  const perProbe = new WeakMap<object, AgentLivenessSources>();
  return async ({ conversationId, artifactPath }, probe) => {
    base ??= sources();
    const liveness = perProbe.get(probe) ?? probeSources(base);
    perProbe.set(probe, liveness);
    const read = async (request: { conversationId: string } | { transcriptPath: string }) =>
      (await agentLivenessSnapshot({ ...request, limit: 1 }, liveness)).conversations[0] ?? null;
    /* By id first. The transcript the journal row itself names is the second
       reading, for an id the registry no longer resolves. */
    const record = await read({ conversationId }) ?? (artifactPath ? await read({ transcriptPath: artifactPath }) : null);
    const registry = liveness.registrySnapshot();
    const requestedId = canonicalConversationId(registry, conversationId);
    // A legacy flow may name only a path. The registry keeps that ownership
    // even after the transcript disappears, including past generations and
    // continuity paths. Ask the canonical owner's current host in every case.
    const ownerId = registry.conversations[requestedId] ? requestedId
      : canonicalConversationId(registry, (artifactPath ? conversationIdForPath(registry, artifactPath) : null)
        ?? record?.conversationId ?? requestedId);
    const host = structuredDeliveryHostForConversation(ownerId);
    return {
      record,
      registryHost: conversationRegistryHost(registry, ownerId, liveness.probe),
      headlessReviewerProcess: headlessReviewerProcess(liveness.flows?.() ?? [], ownerId, artifactPath ?? null, liveness.probe, registry),
      currentTurnIdle: currentHostTurnIdle(await host?.health()),
    };
  };
}

/**
 * The liveness sources as one probe consumes them. A probe asks about every
 * journal row in turn, and each answer would otherwise reload the registry, the
 * flows and every pipeline. The pipelines only name a row's stage lineage,
 * which no verdict reads, so they are left out; the other two are read once
 * for all the rows of one probe, and afresh by the next.
 */
function probeSources(base: AgentLivenessSources): AgentLivenessSources {
  const once = <T>(read: () => T): (() => T) => {
    let held: { value: T } | null = null;
    return () => (held ??= { value: read() }).value;
  };
  return {
    ...base,
    registrySnapshot: once(base.registrySnapshot),
    pipelines: () => [],
    ...(base.flows ? { flows: once(base.flows) } : {}),
  };
}

/** The snapshot's inactive history is bounded for display. Registry identities
    remain admission input even when a lagging fallback put their journal row
    outside that bound. Keyed reads preserve any journal turn/setup hints; a
    registered owner without a journal row still asks the common verdict. */
export function registeredTurnOwnerReader(
  client: () => RuntimeHostClient | null = runtimeHostClient,
): NonNullable<QuietPorts["turnOwners"]> {
  return async (sessions) => {
    const registry = agentRegistry().readOnlySnapshot();
    const owners = new Map<string, QuietTurn>();
    const paths = new Map<string, string>();
    for (const conversation of Object.values(registry.conversations)) {
      const id = canonicalConversationId(registry, conversation.id);
      for (const generation of conversation.generations) paths.set(generation.path, id);
      for (const path of conversation.continuityPaths) paths.set(path, id);
      const generation = registry.conversations[id]?.generations.at(-1) ?? conversation.generations.at(-1);
      owners.set(id, { conversationId: id, artifactPath: generation?.path ?? null,
        cwd: generation?.launchProfile.cwd ?? null,
        sessionKey: { engine: conversation.engine, sessionId: generation?.id ?? id },
        host: "unhosted", turn: "unknown", activeTurnId: null });
    }
    // Entries may precede their conversation binding. Keep their path readable
    // rather than treating that missing binding as proof that no owner exists.
    for (const entry of Object.values(registry.entries)) {
      const id = paths.get(entry.artifactPath) ?? `${entry.key.engine}:${entry.key.sessionId}`;
      owners.set(id, { conversationId: id, artifactPath: entry.artifactPath, cwd: entry.cwd,
        sessionKey: entry.key, host: "unhosted", turn: "unknown", activeTurnId: null });
    }
    // A launch receipt owns setup before its conversation/entry materializes.
    // Ended receipts are also read; their status is the shared verdict's concern.
    for (const receipt of Object.values(registry.receipts)) {
      const id = canonicalConversationId(registry, receipt.conversationId);
      if (owners.has(id)) continue;
      owners.set(id, { conversationId: id, artifactPath: receipt.artifactPath, cwd: receipt.cwd,
        sessionKey: receipt.key ?? { engine: receipt.engine, sessionId: id },
        host: "unhosted", turn: "unknown", activeTurnId: null });
    }
    const turns: QuietTurn[] = [...sessions];
    const included = new Set(sessions.map(session => canonicalConversationId(registry, session.conversationId)));
    let connection: RuntimeHostClient | null = null;
    for (const [id, owner] of owners) {
      if (included.has(id)) continue;
      connection ??= client();
      if (!connection) throw new Error("runtime host is unavailable for registered turn evidence");
      turns.push(await readRuntimeSession(connection, { conversationId: id, artifactPath: owner.artifactPath ?? undefined }) ?? owner);
    }
    return turns;
  };
}

export function productionDeps(env: Readonly<Record<string, string | undefined>> = process.env): ServiceDeps {
  const dir = statePath("self-update");
  const remote = env.LLV_SELF_UPDATE_REMOTE?.trim() || env.LLV_VIEWER_CANONICAL_REMOTE?.trim() || CANONICAL_REMOTE;
  const branch = env.LLV_SELF_UPDATE_BRANCH?.trim() || "main";
  const port = Number(env.PORT);
  return {
    now: () => Date.now(),
    env,
    dir,
    remote,
    branch,
    pollMinutes: POLL_MINUTES,
    bun: process.execPath,
    mode: () => detectMode(productionModePorts(runtimeHostClient(), env)),
    check: checkForUpdate,
    describe: readRevision,
    createRunner: (config, publish, onChange) => new UpdateRunner(config, realPorts(publish), onChange),
    requestRestart,
    processAlive: (pid, startIdentity) => sameProcess({ pid, startIdentity }),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    hostHealth: async () => {
      const client = runtimeHostClient();
      if (!client?.runtimeHostHealth) return null;
      return client.runtimeHostHealth();
    },
    requestDeployment: requestViewerDeployment,
    readDeployment: async (deploymentId) => {
      const client = runtimeHostClient();
      return client ? client.readViewerDeployment(deploymentId) : null;
    },
    findDeploymentByIdempotencyKey: async (idempotencyKey): Promise<ViewerDeploymentStatus | null> => {
      const client = runtimeHostClient();
      if (!client?.findViewerDeploymentByIdempotencyKey) throw new Error("runtime host cannot confirm deployment admission");
      return client.findViewerDeploymentByIdempotencyKey(idempotencyKey);
    },
    releaseTarget: () => readHotStateReleaseTarget(stateDir()),
    prepareCheckRepo: () => prepareManagedCheckRepo(join(dir, "check.git"), statePath("deployments", "canonical.git", "objects")),
    buildEnv: (scratch) => buildEnv(scratch),
    web: {
      pid: process.pid,
      port: Number.isInteger(port) && port > 0 ? port : null,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    requestPipelineTick,
    kickDeliveryQueue: kickStructuredDeliveryQueue,
    updateProject: () => viewerOwnProjectKeys()[0] ?? "Delegatus",
    quiet: {
      // Admitted work by identity. The journal is left out on purpose: every
      // event of a turn already running moves it, so it cannot fence new work.
      dispatchVersion: () => {
        const registry = agentRegistry().snapshot();
        const records = admittedRecords(registry);
        if (!records) throw new Error("Runtime admission evidence is unavailable");
        const receiptOwners = Object.values(registry.receipts).map((receipt) => [
          receipt.launchId, receipt.conversationId, receipt.state, receipt.artifactPath,
          receipt.admissionOwner, receipt.verifiedHost?.agent, receipt.pane?.panePid,
        ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
        return createHash("sha256").update(JSON.stringify([records, receiptOwners, flowPipelineController().idle(), seatTickIdle()])).digest("hex");
      },
      runtimeSnapshot: async () => {
        const client = runtimeHostClient();
        if (!client) throw new Error("runtime host is unavailable");
        return client.snapshot(undefined, { timeoutMs: 10_000 });
      },
      turnOwners: registeredTurnOwnerReader(),
      pipelines: loadPipelinesForList,
      flows: () => loadFlows(),
      turnLiveness: turnEvidenceReader(),
      reviewerProcess: (round) => headlessRoundProcess(round, livenessProbe()),
      seats: () => activeOrchestratorSeats().filter((seat): seat is typeof seat & { conversationId: string } => !!seat.conversationId),
      controllerBusyReason: async () => {
        if (!(await import("@/lib/pipelines/controller")).flowPipelineController().idle()) return "pipeline-controller";
        return (await import("@/lib/monitor/seatTickController")).seatTickIdle() ? null : "seat-tick";
      },
      presence: listPresence,
      memoryAvailableMb: memAvailableMb,
    },
  };
}

const KEY = Symbol.for("llv.selfUpdate.service");
type Holder = { [KEY]?: SelfUpdateService | null };

/* One instance per process, shared across the route bundles (each route is
   its own module graph in a production build). */
export function selfUpdateService(): SelfUpdateService {
  const holder = globalThis as Holder;
  if (!holder[KEY]) holder[KEY] = new SelfUpdateService(productionDeps());
  return holder[KEY]!;
}

/** Tests only; `null` drops the instance so the next call builds a fresh one. */
export function setSelfUpdateServiceForTests(service: SelfUpdateService | null): void {
  const holder = globalThis as Holder;
  holder[KEY]?.stop();
  holder[KEY] = service;
}

/** The Snapshot as a server-sent event stream: one `state` event on every
    change (at most one per 250 ms), and a re-read of the install every
    second while something runs and every five seconds otherwise, since the
    launcher, the runtime host and a deployment move without telling us. */
export function snapshotStream(service: SelfUpdateService, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let last = "";
  let pending: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setTimeout> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let off: () => void = () => {};
  let lastSent = 0;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    off();
    if (pending) clearTimeout(pending);
    if (tick) clearTimeout(tick);
    if (keepalive) clearInterval(keepalive);
    try { controllerRef?.close(); } catch { /* already closed */ }
  };
  const send = (text: string) => {
    if (closed) return;
    try { controllerRef?.enqueue(encoder.encode(text)); } catch { close(); }
  };
  const broadcast = async (force = false) => {
    pending = null;
    if (closed) return;
    let snapshot: Snapshot;
    try { snapshot = await service.snapshot(); } catch { return; }
    const body = JSON.stringify(snapshot);
    /* serverTime moves every read; compare without it. */
    const comparable = body.replace(/"serverTime":"[^"]*"/, "");
    if (!force && comparable === last) return;
    last = comparable;
    lastSent = Date.now();
    send(`event: state\ndata: ${body}\n\n`);
  };
  const schedule = () => {
    if (pending || closed) return;
    pending = setTimeout(() => { void broadcast(); }, Math.max(0, lastSent + SSE_MIN_GAP_MS - Date.now()));
  };
  const loop = () => {
    tick = setTimeout(() => {
      void broadcast().finally(() => { if (!closed) loop(); });
    }, service.active() ? TICK_ACTIVE_MS : TICK_IDLE_MS);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      send("retry: 2000\n\n");
      off = service.changes.on(schedule);
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      signal.addEventListener("abort", close, { once: true });
      void broadcast(true);
      loop();
    },
    cancel() { close(); },
  });
}
