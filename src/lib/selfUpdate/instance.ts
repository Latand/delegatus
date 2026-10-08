/* The one self-update service of this web process, wired to the real
   install (#2007). Everything that resolves the state directory runs on the
   first request, never while a module loads (#1905). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { identityAlive, livenessProbe } from "@/lib/agent/accountLiveness";
import { headlessRoundProcess, productionLivenessSources, type AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { censusIndex, ownerProcessAlive, registryOwners, rowKeyId, type OwnerlessRecord, type RecordedOwner } from "@/lib/lifecycle/owners";
import type { EngineHost, HostState } from "@/lib/runtime/engineHost";
import { structuredDeliveryHeldHosts } from "@/lib/runtime/structuredDeliveryController";
import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { Engine } from "@/lib/types";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { viewerOwnProjectKeys } from "@/lib/monitor/seatTickSources";
import { flowPipelineController } from "@/lib/pipelines/controller";
import { seatTickIdle } from "@/lib/monitor/seatTickController";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { readRuntimeSession, runtimeHostClient } from "@/lib/runtime/client";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";
import type { RuntimeEvent, RuntimeReplay, RuntimeSession, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
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
import { registryAdmissionEvidence, sessionClaimsOpenTurn, type OwnerlessReading, type OwnerReading, type QuietPorts, type TailReading } from "./quiet";
import { readWorkOffThread } from "./workReads";
import { memAvailableMb, realPorts, UpdateRunner } from "./steps";
import type { Snapshot } from "./types";

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

/** The writer epoch a fence names: the number a `writerClaim` string ends
    with, or null when the field is null or missing (R5). */
export function fenceEpoch(writerClaim: string | null | undefined): number | null {
  if (typeof writerClaim !== "string") return null;
  const match = /:(\d+)$/.exec(writerClaim);
  return match ? Number(match[1]) : null;
}

/**
 * What the journal rows say about one owner (R5, source 3): every status mark
 * that names the owner's entry key and writer. The marks' own `host`, `turn`
 * and `activeTurnId` are read,
 * whatever later writes did to the rows. The owner's writer can stand on
 * several rows at once, so they are read as a set: an idle mark on one row
 * takes nothing from a running mark on another, whichever order the snapshot
 * lists them in. A row at the owner's fence that claims a turn and carries no
 * mark was written by a journal that kept none, so who set its turn is
 * unknown.
 */
export function journalStatement(
  rows: readonly RuntimeSession[],
  owner: { entryKey: string | null; writerEpoch: number | null },
): "claimed" | "idle" | "unattributed" | null {
  if (owner.writerEpoch === null || owner.entryKey === null) return null;
  let claimed = false;
  let unattributed = false;
  let idle = false;
  for (const row of rows) {
    const mark = row.writerStatus;
    if (mark) {
      if (rowKeyId(mark.sessionKey) === owner.entryKey && fenceEpoch(mark.writerClaim) === owner.writerEpoch) {
        if (sessionClaimsOpenTurn(mark)) claimed = true;
        else if (mark.turn === "idle" && mark.activeTurnId === null) idle = true;
      }
      continue;
    }
    if (rowKeyId(row.sessionKey) === owner.entryKey && fenceEpoch(row.writerClaim) === owner.writerEpoch
      && sessionClaimsOpenTurn(row)) unattributed = true;
  }
  return claimed ? "claimed" : idle ? "idle" : unattributed ? "unattributed" : null;
}

/** Resolve each own statement in journal order. Engine events name a session
    key, while publications supply its writer epoch. A turn already attributed
    to an earlier writer stays that writer's. An unfamiliar turn under the
    current key can be current work, so it holds until a later own idle/end.
    Missing history supplies no release proof for an answering process. */
function orderedJournalStatement(rows: readonly RuntimeSession[], owner: RecordedOwner, events: readonly RuntimeEvent[], missingHistory: boolean, engineCursor: number | null): OwnerReading["journal"] {
  const statement = journalStatement(rows, owner);
  const turns = new Map<string, number>();
  const turnOwners = new Map<string, { key: string; epoch: number }>();
  const rowKeys = new Map<string, string>();
  const statements = new Map<string, Map<string | null, number | null>>();
  const checkpoints = new Set<string>();
  const turnKey = (key: string, turn: string) => `${key}\0${turn}`;
  const prefix = `engine-host:${owner.entryKey}:`;
  for (const event of events) {
    if (event.scope.type !== "session") continue;
    const payload = event.payload;
    const turn = typeof payload.turnId === "string" ? payload.turnId : null;
    if (event.kind === "session-status") {
      const key = payload.sessionKey as RuntimeSession["sessionKey"] | undefined;
      if (key?.engine && key.sessionId) rowKeys.set(event.scope.id, rowKeyId(key));
      const epoch = fenceEpoch(typeof payload.writerClaim === "string" ? payload.writerClaim : null);
      if (!key?.engine || !key.sessionId || epoch === null || !("host" in payload && "turn" in payload && "activeTurnId" in payload)) continue;
      const id = rowKeyId(key);
      const active = typeof payload.activeTurnId === "string" ? payload.activeTurnId : null;
      const busy = sessionClaimsOpenTurn(payload as unknown as RuntimeSession);
      if (busy && active) {
        turns.set(turnKey(id, active), epoch);
        turnOwners.set(turnKey(event.scope.id, active), { key: id, epoch });
      }
      if (id === owner.entryKey && epoch === owner.writerEpoch && (busy || payload.turn === "idle")) {
        const producer = event.producer.eventKey ?? "";
        const statusPrefix = `structured-host:${id}:${epoch}:`;
        const match = producer.startsWith(statusPrefix) ? /^(\d+):/.exec(producer.slice(statusPrefix.length)) : null;
        const cursor = match ? Number(match[1]) : null;
        const claims = statements.get(event.scope.id) ?? new Map<string | null, number | null>();
        if (busy) {
          checkpoints.delete(event.scope.id);
          const previous = claims.get(active);
          claims.set(active, previous === undefined || previous === null ? cursor : cursor === null ? null : Math.max(previous, cursor));
        } else {
          // Append order cannot make a queued, older health sample newer than
          // an engine event. A missing source cursor cannot settle a claim.
          for (const [turn, started] of claims) if (cursor !== null && started !== null && cursor > started) claims.delete(turn);
          // The engine's durable high-water mark survives retention. Only an
          // own publication beyond it can settle an engine start we lost.
          if (cursor !== null && engineCursor !== null && engineCursor > 0 && cursor > engineCursor) checkpoints.add(event.scope.id);
        }
        statements.set(event.scope.id, claims);
      }
      continue;
    }
    if (event.kind !== "turn-started" && event.kind !== "turn-ended") continue;
    const producer = event.producer.eventKey;
    if (event.kind === "turn-started" && producer?.startsWith("operation:") && producer.endsWith(":native-turn-started") && turn) {
      const recorded = turnOwners.get(turnKey(event.scope.id, turn));
      if (recorded && (recorded.key !== owner.entryKey || recorded.epoch !== owner.writerEpoch)) continue;
      // A native settlement carries no engine cursor. It may precede the
      // event pump and the running publication, so an earlier own idle cannot
      // authorize a restart. Own keyed evidence can subsequently resolve it.
      if (recorded || statements.has(event.scope.id) || rowKeys.get(event.scope.id) === owner.entryKey) {
        const claims = statements.get(event.scope.id) ?? new Map<string | null, number | null>();
        if (!claims.has(turn)) claims.set(turn, null);
        statements.set(event.scope.id, claims);
      }
      continue;
    }
    if (!producer?.startsWith(prefix) || !/^\d+$/.test(producer.slice(prefix.length)) || !turn) continue;
    const prior = turns.get(turnKey(owner.entryKey!, turn));
    // Known foreign work cannot grant or withdraw this owner's claim. When
    // the epoch is absent from retained history, ambiguity holds the owner.
    if (prior !== undefined && prior !== owner.writerEpoch) continue;
    if (event.kind === "turn-started") {
      turns.set(turnKey(owner.entryKey!, turn), owner.writerEpoch!);
      turnOwners.set(turnKey(event.scope.id, turn), { key: owner.entryKey!, epoch: owner.writerEpoch! });
      const active = statements.get(event.scope.id) ?? new Map<string | null, number | null>();
      const cursor = Number(producer.slice(prefix.length));
      const previous = active.get(turn);
      active.set(turn, previous === undefined || previous === null ? cursor : Math.max(previous, cursor));
      statements.set(event.scope.id, active);
    } else {
      const claims = statements.get(event.scope.id);
      const started = claims?.get(turn);
      if (started !== undefined && started !== null && Number(producer.slice(prefix.length)) > started) claims!.delete(turn);
    }
  }
  let unread = false;
  let idle = false;
  for (const ordered of statements.values()) {
    if (ordered.size) return "claimed";
    idle = true;
  }
  if (missingHistory && (!statements.size || [...statements.keys()].some((id) => !checkpoints.has(id)))) return "unattributed";
  for (const row of rows) {
    const own = row.writerStatus && rowKeyId(row.writerStatus.sessionKey) === owner.entryKey
      && fenceEpoch(row.writerStatus.writerClaim) === owner.writerEpoch;
    const ordered = statements.get(row.conversationId);
    if (ordered?.size) return "claimed";
    if (ordered) idle = true;
    else if (own && sessionClaimsOpenTurn(row.writerStatus!)) return "claimed";
    else if (own) unread = true;
  }
  return unread || statement === "unattributed" ? "unattributed" : idle ? "idle" : statement;
}

/** What a handle's health says about its host's turn; null when it reports
    no host. */
function handleTurn(health: Pick<HostState, "status" | "activeTurnRef"> | null | undefined): "busy" | "idle" | null {
  if (!health || health.status === "dead" || health.status === "unhosted") return null;
  return health.status === "idle" && health.activeTurnRef === null ? "idle" : "busy";
}

export interface OwnerCensusReaderOptions {
  /** One keyed journal read, for a live owner with a writer whose
      conversation the snapshot omits. */
  readSession?: (query: { conversationId?: string; artifactPath?: string }) => Promise<RuntimeSession | null>;
  /** Existing journal replay, for ordered start/completion evidence. */
  readEvents?: (after: number) => Promise<RuntimeReplay>;
  /** Durable engine high-water mark, including events pruned from replay. */
  readProducerCursor?: (kind: string, prefix: string) => Promise<number>;
  /** The hosts this Viewer holds, by session key. */
  heldHosts?: () => ReadonlyMap<string, EngineHost>;
  /** This Viewer's own process, the claimant of the claims it makes (R6b). */
  viewerIdentity?: () => ProcessIdentity | null;
}

let viewerIdentity: ProcessIdentity | null | undefined;

/**
 * The drain's reader (docs/design/update-drain-liveness.md): one census of
 * every recorded process, and for each one the evidence its own records give.
 * Process state comes first; a gone owner reads nothing more. A live host
 * reads its handle by its own session key, its own row reference, the status
 * mark its own writer published and its own transcript. No source is reached
 * through a conversation id, a path another row shares, another row's key or
 * another writer's epoch.
 */
export function ownerCensusReader(
  sources: () => AgentLivenessSources = productionLivenessSources,
  options: OwnerCensusReaderOptions = {},
): NonNullable<QuietPorts["owners"]> {
  let base: AgentLivenessSources | null = null;
  const readSession = options.readSession ?? (async (query) => {
    const client = runtimeHostClient();
    if (!client) throw new Error("runtime host is unavailable for registered turn evidence");
    return readRuntimeSession(client, query);
  });
  const readEvents = options.readEvents ?? (async (after) => {
    const client = runtimeHostClient();
    if (!client) throw new Error("runtime host is unavailable for ordered turn evidence");
    return client.events(after);
  });
  const heldHosts = options.heldHosts ?? structuredDeliveryHeldHosts;
  const readProducerCursor = options.readProducerCursor ?? (async (kind, prefix) => {
    const client = runtimeHostClient();
    if (!client) throw new Error("runtime host is unavailable for retained turn checkpoint");
    return client.producerCursor(kind, prefix);
  });
  const viewer = options.viewerIdentity ?? (() => viewerIdentity === undefined ? (viewerIdentity = captureProcessIdentity(process.pid)) : viewerIdentity);
  return async (sessions, _probe, read = (_reference, reading) => reading()) => {
    base ??= sources();
    const liveness = probeSources(base);
    const registry = liveness.registrySnapshot();
    const flows = liveness.flows?.() ?? [];
    const probe = liveness.probe;
    const held = heldHosts();
    // One replay per probe, only when an own journal statement needs ordering.
    // Keep only deciding events; payloads from live output are never retained.
    let history: Promise<{ events: RuntimeEvent[]; incomplete: boolean }> | null = null;
    const events = () => (history ??= (async () => {
      const result: RuntimeEvent[] = [];
      let cursor = 0;
      let page = await readEvents(cursor);
      const incomplete = page.reset;
      if (page.reset) { cursor = page.floorSeq; page = await readEvents(cursor); }
      while (true) {
        if (page.reset) throw new Error("runtime turn history changed during drain probe");
        for (const event of page.events) if (["session-status", "turn-started", "turn-ended"].includes(event.kind)) result.push(event);
        if (!page.events.length) return { events: result, incomplete };
        const next = page.events.at(-1)!.seq;
        if (next <= cursor) throw new Error("runtime turn history did not advance");
        cursor = next;
        page = await readEvents(cursor);
      }
    })());
    const census = registryOwners(registry, flows, probe, { identity: viewer(), heldKeys: held });
    const index = censusIndex(registry);
    const tails = new Map<string, Promise<TailReading | null>>();
    const engines = new Map<string, Engine>();
    for (const conversation of Object.values(registry.conversations)) {
      for (const generation of conversation.generations) engines.set(generation.path, conversation.engine);
    }
    /* A missing file or a torn tail reads as null: R8 holds an answering
       owner and bounds an ownerless launch that never proved work. A read
       that fails on anything else (a denied open, an I/O error) is no
       verdict: the strict read throws it, it reaches the probe as
       `unreadable`, and the next probe reads again (R7). The description
       that names a path's engine is read the same way. A reading is kept for
       the probe under the engine it was read with, so a row of another
       engine at the same path reads its own (R3, R12). */
    const tail = (path: string | null, engine?: string | null): Promise<TailReading | null> => {
      if (!path) return Promise.resolve(null);
      const known = engine ?? engines.get(path) ?? null;
      const memo = `${known ?? ""}\0${path}`;
      if (!tails.has(memo)) tails.set(memo, (async () => {
        const kind = known ?? (await liveness.describeTranscript(path, { strict: true }))?.engine ?? null;
        if (!kind) return null;
        const evidence = await liveness.transcriptEvidence(kind as "claude" | "codex", path, { strict: true });
        return evidence ? { turn: evidence.turn === "busy" ? "busy" : evidence.turn === "idle" ? "idle" : "unknown", lastRecordAt: evidence.lastRecordTs } : null;
      })());
      return tails.get(memo)!;
    };
    /* The journal rows that can speak for an entry key: the rows whose status
       mark names it, and the rows filed under it, which carry an
       unattributed claim when they have no mark (R5). A row is found by the
       key, never by the conversation it is filed under, so a display binding
       or a copy of the registry cannot hide an owner's own statement. When
       the snapshot omits the owner's conversation or its artifact, a keyed
       read fetches the row the snapshot omits, and it is read together with
       the listed rows: the owner's writer can stand on both. */
    const byKey = new Map<string, RuntimeSession[]>();
    const file = (key: string, row: RuntimeSession) => {
      const rows = byKey.get(key) ?? [];
      if (!rows.includes(row)) byKey.set(key, [...rows, row]);
    };
    const listedIds = new Set<string>();
    const listedPaths = new Set<string>();
    for (const row of sessions) {
      if (row.writerStatus?.sessionKey) file(rowKeyId(row.writerStatus.sessionKey), row);
      if (row.sessionKey) file(rowKeyId(row.sessionKey), row);
      listedIds.add(row.conversationId);
      listedIds.add(index.conversation({ conversationId: row.conversationId }) ?? row.conversationId);
      if (row.artifactPath) listedPaths.add(row.artifactPath);
    }
    const keyed = new Map<string, Promise<RuntimeSession[]>>();
    const speaksFor = (key: string) => (row: RuntimeSession) =>
      (!!row.writerStatus?.sessionKey && rowKeyId(row.writerStatus.sessionKey) === key) || (!!row.sessionKey && rowKeyId(row.sessionKey) === key);
    const rowsFor = (owner: RecordedOwner): Promise<RuntimeSession[]> => {
      const key = owner.entryKey!;
      if (!keyed.has(key)) keyed.set(key, (async () => {
        const fetched: RuntimeSession[] = [];
        if (owner.binding && !listedIds.has(owner.binding)) {
          const row = await readSession({ conversationId: owner.binding });
          if (row) fetched.push(row);
        }
        if (owner.artifactPath && !listedPaths.has(owner.artifactPath) && !fetched.some(speaksFor(key))) {
          const row = await readSession({ artifactPath: owner.artifactPath });
          if (row && !fetched.some((other) => other.conversationId === row.conversationId)) fetched.push(row);
        }
        const listed = byKey.get(key) ?? [];
        return [...listed, ...fetched.filter((row) => speaksFor(key)(row) && !listed.some((other) => other.conversationId === row.conversationId))];
      })());
      return keyed.get(key)!;
    };
    const owners: OwnerReading[] = [];
    const place = (owner: RecordedOwner | OwnerlessRecord) => ({ id: owner.id, binding: owner.binding, artifactPath: owner.artifactPath,
      ...("custody" in owner && owner.custody ? { custody: owner.custody } : {}),
      entryKey: owner.entryKey, launchId: owner.launchId, engine: owner.engine, cwd: owner.cwd });
    /* A handle speaks for the structured host its entry records. When its
       health names another pid, or the entry records no process, the handle
       is an owner of its own. */
    const handles = new Map<string, Promise<HostState | null>>();
    const health = (key: string) => {
      if (!handles.has(key)) handles.set(key, held.get(key)?.health() ?? Promise.resolve(null));
      return handles.get(key)!;
    };
    const spoken = new Set<string>();
    const gone: { key: string; identity: ProcessIdentity }[] = [];
    for (const owner of census.owners) {
      await read({ conversationId: owner.binding, artifactPath: owner.artifactPath }, async () => {
        const alive = ownerProcessAlive(owner, probe);
        const reading: OwnerReading = { ...place(owner), role: owner.role, process: alive ? "alive" : "gone" };
        if (!alive && owner.entryKey) for (const identity of owner.identities) gone.push({ key: owner.entryKey, identity });
        if (alive && owner.role === "host") {
          let handle: "busy" | "idle" | null = null;
          if (owner.structuredHost && owner.entryKey && held.has(owner.entryKey)) {
            const state = await health(owner.entryKey);
            if (state && (state.pid === null || state.pid === owner.pid)) {
              handle = handleTurn(state);
              spoken.add(owner.entryKey);
            }
          }
          reading.handle = handle;
          reading.rowReference = !!owner.entry && !owner.entry.host && !!owner.entry.structuredHost?.activeTurnRef && owner.structuredHost;
          if (owner.writerEpoch !== null) {
            const rows = await rowsFor(owner);
            const history = await events();
            // Only these engine producers retain their cursor across pruning.
            const kind = owner.engine === "codex" ? "codex-app-server" : owner.engine === "claude" ? "claude-broker" : null;
            const cursor = history.incomplete && kind ? await readProducerCursor(kind, `engine-host:${owner.entryKey}:`) : null;
            reading.journal = orderedJournalStatement(rows, owner, history.events, history.incomplete, cursor);
          } else if (owner.entry && ["starting", "live", "handoff"].includes(owner.entry.status)) {
            // A standalone input can be accepted before its transcript start.
            // The completion must follow this owner's live admission record.
            const at = Date.parse(owner.entry.updatedAt);
            reading.settlementAfter = Number.isFinite(at) ? at : Infinity;
          }
          reading.tail = await tail(owner.artifactPath, owner.engine);
          if (reading.settlementAfter !== undefined && reading.tail?.turn === "idle" && owner.artifactPath
            && (owner.engine === "codex" || owner.engine === "claude")) {
            // Record freshness includes output after a completion. Date the
            // actual terminal marker, so such output cannot settle new work.
            const records = await readStableTailRecords(owner.artifactPath, undefined, { strict: true });
            const turn = records.integrity === "complete" ? turnStateFromRecords(records.records, owner.engine) : null;
            const at = turn?.state === "terminal" && turn.terminalAt ? Date.parse(turn.terminalAt) : NaN;
            reading.tail = { ...reading.tail, settledAt: Number.isFinite(at) ? at : null };
          }
        }
        owners.push(reading);
      });
    }
    for (const [key] of held) {
      if (spoken.has(key)) continue;
      const entry = registry.entries[key] ?? null;
      const binding = entry ? index.conversation({ sessionKey: entry.key, artifactPath: entry.artifactPath }) : null;
      await read({ conversationId: binding, artifactPath: entry?.artifactPath ?? null }, async () => {
        const state = await health(key);
        const turn = handleTurn(state);
        if (!state || !turn) return;
        /* R4 for the handle: health that names a process a record under the
           same key holds, and that the census found gone, is stale and speaks
           for nobody. Health that names another process is that process's
           owner, alive only while its own pid and start identity answer. */
        if (state.pid !== null) {
          const pid = state.pid, start = state.processStartIdentity;
          if (gone.some((record) => record.key === key && record.identity.pid === pid
            && start !== null && record.identity.startIdentity !== null && record.identity.startIdentity === start)) return;
          if (!identityAlive({ pid, startIdentity: start }, probe)) return;
        }
        owners.push({ id: `handle:${key}:${state.pid ?? ""}`, binding, artifactPath: entry?.artifactPath ?? null, entryKey: key,
          launchId: null, engine: entry?.key.engine ?? null, cwd: entry?.cwd ?? null,
          role: "host", process: "alive", handle: turn, rowReference: false, journal: null,
          tail: await tail(entry?.artifactPath ?? null, entry?.key.engine) });
      });
    }
    const ownerless: OwnerlessReading[] = [];
    for (const record of census.ownerless) {
      await read({ conversationId: record.binding, artifactPath: record.artifactPath }, async () => {
        ownerless.push({ ...place(record), kind: record.kind, updatedAt: record.updatedAt, tail: await tail(record.artifactPath, record.engine) });
      });
    }
    const everything = [...owners, ...ownerless];
    return {
      owners,
      ownerless,
      bound: (reference) => index.boundTo(everything, reference),
      names: (reference) => index.names(reference),
      tail: async (reference) => {
        if (reference.artifactPath) return tail(reference.artifactPath);
        const id = index.conversation(reference);
        const generation = id ? registry.conversations[id]?.generations.at(-1) : undefined;
        return generation ? tail(generation.path, registry.conversations[id!]!.engine) : null;
      },
    };
  };
}

/**
 * The liveness sources as one probe consumes them: the registry and the flows
 * are read once for all the owners of one probe, and afresh by the next.
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
      dispatchVersion: () => createHash("sha256")
        .update(JSON.stringify([...registryAdmissionEvidence(agentRegistry().readOnlySnapshot()), flowPipelineController().idle(), seatTickIdle()]))
        .digest("hex"),
      runtimeSnapshot: async () => {
        const client = runtimeHostClient();
        if (!client) throw new Error("runtime host is unavailable");
        return client.snapshot();
      },
      owners: ownerCensusReader(),
      pipelines: loadPipelinesForList,
      flows: () => loadFlows(),
      reviewerProcess: (round) => headlessRoundProcess(round, livenessProbe()),
      seats: () => activeOrchestratorSeats().filter((seat): seat is typeof seat & { conversationId: string } => !!seat.conversationId),
      controllerBusyReason: async () => {
        if (!(await import("@/lib/pipelines/controller")).flowPipelineController().idle()) return "pipeline-controller";
        return (await import("@/lib/monitor/seatTickController")).seatTickIdle() ? null : "seat-tick";
      },
      presence: listPresence,
      memoryAvailableMb: memAvailableMb,
    },
    observedReads: () => readWorkOffThread(),
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

/** Why the install could not be read, for the surface to say so (#2594). */
export function snapshotFailure(error: unknown): { code: "snapshot-failed"; error: string } {
  return { code: "snapshot-failed", error: error instanceof Error ? error.message : String(error) };
}

/** The Snapshot as a server-sent event stream: one `state` event on every
    change (at most one per 250 ms), and a re-read of the install every
    second while something runs and every five seconds otherwise, since the
    launcher, the runtime host and a deployment move without telling us.
    The work in progress follows in a later `state` once its reading lands;
    a read that fails is a `snapshot-error` event, never silence. */
export function snapshotStream(service: SelfUpdateService, signal: AbortSignal, options: { work?: boolean } = {}): ReadableStream<Uint8Array> {
  const read = options.work === false ? () => service.snapshot() : () => service.observe();
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
  /* Readings overlap (a change, the tick, the first read) and can finish in
     any order. Each is numbered as it starts; one that finishes after a later
     one already answered is about an older install and is dropped, error or
     state, so the surface never steps back. */
  let started = 0;
  let answered = 0;
  const broadcast = async (force = false) => {
    pending = null;
    if (closed) return;
    const reading = ++started;
    let snapshot: Snapshot;
    try { snapshot = await read(); } catch (error) {
      if (reading < answered) return;
      answered = reading;
      const failure = JSON.stringify(snapshotFailure(error));
      if (!force && failure === last) return;
      last = failure;
      send(`event: snapshot-error\ndata: ${failure}\n\n`);
      return;
    }
    if (reading < answered) return;
    answered = reading;
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
