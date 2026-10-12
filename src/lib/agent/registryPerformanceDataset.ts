import fs from "node:fs";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import { IDENTITY_WAVE_MIGRATION } from "./identityWaveMigration";
import { AgentRegistry, normalizeRegistry, type RegistryFile } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

/**
 * A synthetic registry shaped like a long-running installation (#2761).
 *
 * The counts and payload sizes follow the registry that timed out the files
 * projection after #2714: about 30,000 rows of which more than nine in ten are
 * cold history, large operation-owner and receipt payloads, delegated launches
 * whose MCP grants depend on other rows, and attestors that are missing or
 * disagree. Nothing in it comes from a real installation; every identity is
 * generated from an index.
 *
 * The candidate performance gate and its integration tests open it the way a
 * release opens the live registry, so they exercise the same grant decisions,
 * archive reads and projection passes production does.
 */
export interface RegistryPerformanceDatasetShape {
  conversations: number;
  entries: number;
  receipts: number;
  heldDeliveries: number;
  deliveryOperationOwners: number;
  lineageEdges: number;
  memberships: number;
  migrationIntents: number;
  /** Rows that stay hot: live entries, outstanding receipts and deliveries. */
  activeEntries: number;
  /** Terminal rows the bounded archive pass has not reached yet. */
  hotTerminalRows: number;
  /** One operator root in this many conversations holds the Telegram grant,
      and the four conversations after it are delegated children claiming it. */
  grantEvery: number;
  pendingDeliveries: number;
  uncertainDeliveries: number;
  outstandingReceipts: number;
  /** The newest live entries that are structured hosts: a release hands each
      one over to its successor, which re-hosts it. */
  workers: number;
  /** The newest entries whose conversations still have their transcripts. */
  transcripts: number;
  /** Working directories the history is spread over. The board shows the ten
      most recently active projects, so a history that fits in them keeps
      every row on the board whichever project a write makes the newest. */
  projects: number;
}

/** The production-like default: 30,356 rows. */
export const REGISTRY_PERFORMANCE_SHAPE: RegistryPerformanceDatasetShape = Object.freeze({
  conversations: 4_700,
  entries: 3_800,
  receipts: 3_870,
  heldDeliveries: 4_280,
  deliveryOperationOwners: 6_240,
  lineageEdges: 4_240,
  memberships: 3_170,
  migrationIntents: 40,
  activeEntries: 24,
  hotTerminalRows: 2_200,
  grantEvery: 50,
  pendingDeliveries: 16,
  uncertainDeliveries: 8,
  outstandingReceipts: 12,
  workers: 4,
  transcripts: 320,
  projects: 8,
});

/** A small shape with the same structure, for fast tests. */
export function scaledRegistryPerformanceShape(factor: number): RegistryPerformanceDatasetShape {
  const scaled = (value: number, minimum: number) => Math.max(minimum, Math.round(value * factor));
  const shape = REGISTRY_PERFORMANCE_SHAPE;
  return {
    conversations: scaled(shape.conversations, 40),
    entries: scaled(shape.entries, 32),
    receipts: scaled(shape.receipts, 32),
    heldDeliveries: scaled(shape.heldDeliveries, 32),
    deliveryOperationOwners: scaled(shape.deliveryOperationOwners, 40),
    lineageEdges: scaled(shape.lineageEdges, 32),
    memberships: scaled(shape.memberships, 24),
    migrationIntents: scaled(shape.migrationIntents, 4),
    activeEntries: shape.activeEntries,
    hotTerminalRows: scaled(shape.hotTerminalRows, 20),
    grantEvery: Math.max(5, Math.round(shape.grantEvery * Math.min(1, factor * 4))),
    pendingDeliveries: shape.pendingDeliveries,
    uncertainDeliveries: shape.uncertainDeliveries,
    outstandingReceipts: shape.outstandingReceipts,
    workers: shape.workers,
    transcripts: Math.min(shape.transcripts, scaled(shape.entries, 32)),
    projects: shape.projects,
  };
}

export interface RegistryPerformanceDataset {
  filename: string;
  shape: RegistryPerformanceDatasetShape;
  rows: number;
  coldRows: number;
  payloadBytes: number;
  /** Live entry rows the writers restamp. They must stay hot. */
  activeEntryKeys: string[];
  /** Structured-host entries a running worker serves, with their transcripts. */
  workers: Array<{ key: string; sessionId: string; transcript: string }>;
  /** Delivery ids whose evidence a release must never archive or rewrite. */
  pendingDeliveryIds: string[];
  uncertainDeliveryIds: string[];
  /** Grant-bearing rows a writer touches, with their expected effective lists. */
  grantSubjects: Array<{ collection: "entries" | "receipts"; key: string; servers: string[] }>;
  /** Operation ids of cold and hot deliveries, for keyed lookups. */
  coldOperationIds: string[];
  hotOperationIds: string[];
  /** Conversations whose transcripts exist under `sessionsRoot`, newest last. */
  conversationPaths: string[];
  /** Each of those conversations' identity and the project the board files it under. */
  conversations: Array<{ path: string; conversationId: string; cwd: string }>;
  seedMs: number;
}

export interface RegistryPerformanceDatasetOptions {
  /** Where the transcripts go: a Codex sessions directory in a sandboxed home.
      Without one every path is invented and nothing is written. */
  sessionsRoot?: string;
}

const ROOT_GRANT = ["viewer", "telegram"];
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const conversationId = (index: number) => `conversation_${uuid(index)}` as RegistryFile["conversations"][string]["id"];

/**
 * Build the dataset into `directory` and leave the archive in its steady state.
 * The import and archive passes run through the store a release uses.
 */
export function buildRegistryPerformanceDataset(
  directory: string,
  shape: RegistryPerformanceDatasetShape = REGISTRY_PERFORMANCE_SHAPE,
  options: RegistryPerformanceDatasetOptions = {},
): RegistryPerformanceDataset {
  const started = performance.now();
  const sessionsRoot = options.sessionsRoot;
  /* A Codex rollout name ends in its session id, which is how the scanner and
     the registry agree on which conversation a transcript is. */
  const transcriptOf = (index: number) => sessionsRoot
    ? path.join(sessionsRoot, "2026", "10", "01", `rollout-2026-10-01T00-00-00-${uuid(index)}.jsonl`)
    : `/sessions/${uuid(index)}.jsonl`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const seedPath = path.join(directory, "performance-seed.json");
  const seed = new AgentRegistry(seedPath, undefined, undefined, { sqliteMode: "off" });
  const conversation = seed.ensureConversation("codex", `/sessions/${uuid(0)}.jsonl`, null);
  const receipt = seed.beginSpawn("codex", "/repo", { title: "Performance gate fixture" });
  const delivery = seed.holdDelivery(conversation.id, "performance gate fixture", "performance-fixture");
  const source = seed.snapshot();
  seed.close();
  fs.rmSync(seedPath, { force: true });

  const file = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
  const seededAt = Date.now();
  /* An installation that kept this much history has long run the one-time
     identity wave; its marker is part of the shape. Without it the first boot
     of a production server would run the wave, which no live registry does. */
  file.identityMigrations[IDENTITY_WAVE_MIGRATION] = {
    completedAt: new Date(seededAt - 30 * 86_400_000).toISOString(), retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0,
  };
  /* The newest hundred launches spread over the last day, as a busy
     installation's do, so they still project board cards; the rest are older
     than a day. No launch sits near the 15-minute or 24-hour projection
     boundaries, so a gate run cannot watch a card change tier mid-measurement. */
  const launchAge = (newest: number) => newest < 100
    ? 20 * 60_000 + newest * 12 * 60_000
    : 30 * 3_600_000 + (newest - 100) * 600_000;
  const count = shape.conversations;
  const every = shape.grantEvery;
  const rootOf = (index: number) => index - (index % every);
  const isRoot = (index: number) => index % every === 0;
  /* A grant root and the delegated children that claim its grant. Everything
     else is a delegated child holding the baseline. */
  const claims = (index: number) => index % every <= 4;
  for (let index = 0; index < count; index++) {
    const key = conversationId(index);
    const root = isRoot(index);
    const generation = structuredClone(conversation.generations[0]!);
    generation.id = uuid(index);
    generation.path = transcriptOf(index);
    generation.launchProfile = {
      ...emptyLaunchProfile({ cwd: `/repo/project-${index % shape.projects}` }),
      title: `Synthetic conversation ${index}`,
      mcpServers: claims(index) ? [...ROOT_GRANT] : ["viewer"],
      parentConversationId: root ? null : conversationId(rootOf(index)),
    };
    file.conversations[key] = {
      ...structuredClone(conversation),
      id: key,
      agentRole: root ? "orchestrator" : "builder",
      delegationDepth: root ? 0 : 1,
      generations: [generation],
      continuityPaths: index % 7 === 0 ? [`/sessions/continuity-${uuid(index)}.jsonl`] : [],
    };
  }
  /* Live hosts and outstanding launches sit on grant-bearing rows, so a write
     that touches them exercises the authority decision. */
  const newestClaiming = (total: number, wanted: number) => {
    const picked = new Set<number>();
    for (let index = total - 1; index >= 0 && picked.size < wanted; index--) if (claims(index % count)) picked.add(index);
    return picked;
  };
  const activeIndexes = newestClaiming(shape.entries, shape.activeEntries + shape.workers);
  const workerIndexes = new Set([...activeIndexes].sort((left, right) => right - left).slice(0, shape.workers));
  const outstandingIndexes = newestClaiming(shape.receipts, shape.outstandingReceipts);
  const activeEntryKeys: string[] = [];
  const workers: RegistryPerformanceDataset["workers"] = [];
  for (let index = 0; index < shape.entries; index++) {
    const sessionKey = { engine: "codex" as const, sessionId: uuid(index) };
    const key = `codex:${sessionKey.sessionId}`;
    const worker = workerIndexes.has(index);
    const active = activeIndexes.has(index) && !worker;
    const parent = index % count;
    file.entries[key] = {
      key: sessionKey,
      artifactPath: transcriptOf(index),
      cwd: `/repo/project-${index % shape.projects}`,
      accountId: null,
      launchProfile: {
        ...emptyLaunchProfile({ cwd: `/repo/project-${index % shape.projects}` }),
        mcpServers: claims(parent) ? [...ROOT_GRANT] : ["viewer"],
      },
      /* A worker's row is as the previous release left it: live, its turn
         open, its engine gone with that release, for the Viewer that boots to
         re-host. A live entry without a host is one between turns. */
      status: worker ? "live" : active ? "idle" : "dead",
      host: null,
      ...(worker ? {
        structuredHost: {
          kind: "codex-app-server" as const,
          endpoint: "stdio:retained",
          process: null,
          eventCursor: 0,
          protocolVersion: "performance-fixture",
          writerClaimEpoch: 0,
          activeTurnRef: `performance-turn-${index}`,
          pendingAttention: [],
          activeFlags: [],
        },
      } : {}),
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
      updatedAt: conversation.updatedAt,
    };
    if (active) activeEntryKeys.push(key);
    if (worker) {
      workers.push({ key, sessionId: sessionKey.sessionId, transcript: transcriptOf(index) });
      file.conversations[conversationId(index)]!.turn = { state: "busy", source: "lifecycle", terminalAt: null, observedAt: new Date(seededAt).toISOString() };
    }
  }
  const grantSubjects: RegistryPerformanceDataset["grantSubjects"] = [];
  for (let index = 0; index < shape.receipts; index++) {
    const launchId = `performance-launch-${index}`;
    const target = index % count;
    const outstanding = outstandingIndexes.has(index);
    /* Absent attestors: every eleventh receipt names a conversation the
       registry never held. Contradictory ones: every thirteenth names a
       parent its lineage edge does not. */
    const absent = index % 11 === 0;
    const contradicted = index % 13 === 0;
    file.receipts[launchId] = {
      ...structuredClone(receipt),
      launchId,
      conversationId: absent ? conversationId(count + index) : conversationId(target),
      clientAttemptId: `performance-attempt-${index}`,
      requestDigest: "d".repeat(64),
      spawnCapabilityDigest: null,
      key: { engine: "codex", sessionId: uuid(target) },
      artifactPath: transcriptOf(target),
      state: outstanding ? "path-pending" : index % 17 === 0 ? "failed" : "completed",
      agentRole: isRoot(target) ? "orchestrator" : "builder",
      delegationDepth: isRoot(target) ? 0 : 1,
      parentConversationId: isRoot(target) ? null : conversationId(contradicted ? rootOf(target) + every : rootOf(target)),
      telegramSeatGrant: claims(target),
      launchProfile: {
        ...emptyLaunchProfile({ cwd: `/repo/project-${target % shape.projects}` }),
        title: `Synthetic launch ${index}`,
        mcpServers: claims(target) ? [...ROOT_GRANT] : ["viewer"],
        parentConversationId: isRoot(target) ? null : conversationId(rootOf(target)),
      },
      launchDisplay: { prompt: "synthetic launch prompt ".repeat(200), echo: "synthetic launch", images: 0 },
      transport: "structured",
      createdAt: new Date(seededAt - launchAge(shape.receipts - 1 - index)).toISOString(),
      artifactLifecycle: outstanding ? "pending" : "materialized",
    };
  }
  const heldTemplate = source.heldDeliveries[delivery.id]!;
  const ownerTemplate = source.deliveryOperationOwners[heldTemplate.command.operationId]!;
  const pendingDeliveryIds: string[] = [];
  const uncertainDeliveryIds: string[] = [];
  const coldOperationIds: string[] = [];
  const hotOperationIds: string[] = [];
  for (let index = 0; index < shape.heldDeliveries; index++) {
    const key = `performance-delivery-${index}`;
    const operationId = `performance-operation-${index}`;
    const fromEnd = shape.heldDeliveries - index;
    const state = fromEnd <= shape.uncertainDeliveries ? "delivery-uncertain"
      : fromEnd <= shape.uncertainDeliveries + shape.pendingDeliveries ? "held" : "delivered";
    if (state === "delivery-uncertain") uncertainDeliveryIds.push(key);
    else if (state === "held") pendingDeliveryIds.push(key);
    (state === "delivered" ? coldOperationIds : hotOperationIds).push(operationId);
    file.heldDeliveries[key] = {
      ...structuredClone(heldTemplate),
      id: key,
      conversationId: conversationId(index % count),
      command: { ...structuredClone(heldTemplate.command), operationId },
      text: "synthetic delivery text ".repeat(40),
      state,
    };
  }
  for (let index = 0; index < shape.deliveryOperationOwners; index++) {
    const key = `performance-operation-${index}`;
    const delivered = index < shape.heldDeliveries - shape.pendingDeliveries - shape.uncertainDeliveries
      || index >= shape.heldDeliveries;
    file.deliveryOperationOwners[key] = {
      ...structuredClone(ownerTemplate),
      command: { ...structuredClone(ownerTemplate.command), operationId: key },
      conversationId: conversationId(index % count),
      deliveryId: `performance-delivery-${index}`,
      /* A settled owner carries the instant it settled, as settlement writes
         it: retained history ended long before the run. */
      ...(delivered
        ? {
          terminalState: "delivered", terminalDisposition: "delivered", terminalReason: "synthetic retained evidence ".repeat(270),
          settledAt: new Date(seededAt - 30 * 86_400_000 - (shape.deliveryOperationOwners - index) * 60_000).toISOString(),
        }
        : {}),
    };
  }
  for (let index = 0; index < shape.lineageEdges; index++) {
    const child = index % count;
    if (isRoot(child)) continue;
    const key = conversationId(child);
    /* Every nineteenth child has no edge at all: its receipt is the only attestor. */
    if (index % 19 === 0) continue;
    file.lineageEdges[key] = {
      childConversationId: key,
      parentConversationId: conversationId(rootOf(child)),
      childSessionKey: null,
      parentSessionKey: null,
      childArtifactPath: transcriptOf(child),
      parentArtifactPath: null,
      kind: "spawn",
      role: null,
      reviewsConversationId: null,
      source: "viewer-spawn",
      evidence: { launchId: `performance-launch-${child}`, clientAttemptId: `performance-attempt-${child}`, telegramSeatGrant: claims(child) },
      createdAt: conversation.createdAt,
    };
  }
  for (let index = 0; index < shape.memberships; index++) {
    const key = conversationId(index % count);
    file.memberships[key] = [{
      conversationId: key, kind: "pipeline", containerId: `performance-pipeline-${Math.floor(index / 5)}`, role: "builder", slot: "build",
      stageId: null, stageOrder: null, round: null, parentConversationId: null, createdAt: conversation.createdAt,
    }];
  }
  for (let index = 0; index < shape.migrationIntents; index++) {
    const key = `performance-migration-${index}`;
    file.migrationIntents[key] = {
      id: key, engine: "codex", targetId: "fixture-account", origin: "manual", revision: 1,
      state: "complete", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
      requestIds: [], evidence: null, stoppedAt: null,
    };
  }
  for (const key of [...activeEntryKeys, ...workers.map((worker) => worker.key)]) {
    const entry = file.entries[key]!;
    grantSubjects.push({ collection: "entries", key, servers: [...(entry.launchProfile?.mcpServers ?? ["viewer"])] });
  }
  for (const index of outstandingIndexes) {
    const launchId = `performance-launch-${index}`;
    grantSubjects.push({ collection: "receipts", key: launchId, servers: [...file.receipts[launchId]!.launchProfile.mcpServers] });
  }

  /* The newest entries' conversations keep their transcripts, so a board
     scope pinning one of them has a real conversation to show. */
  const transcribed: RegistryPerformanceDataset["conversations"] = [];
  if (sessionsRoot) {
    const first = Math.max(0, Math.min(shape.entries, count) - shape.transcripts);
    for (let index = first; index < Math.min(shape.entries, count); index++) {
      const transcript = transcriptOf(index);
      const cwd = `/repo/project-${index % shape.projects}`;
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      const stamp = new Date(seededAt - (Math.min(shape.entries, count) - index) * 60_000).toISOString();
      /* A worker's turn is still open: it keeps writing once re-hosted. */
      const open = workerIndexes.has(index);
      fs.writeFileSync(transcript, [
        { timestamp: stamp, type: "session_meta", payload: { id: uuid(index), timestamp: stamp, cwd, originator: "codex_cli_rs", cli_version: "0.0.0" } },
        { timestamp: stamp, type: "event_msg", payload: { type: "user_message", message: `Synthetic conversation ${index}` } },
        { timestamp: stamp, type: "event_msg", payload: { type: "agent_message", message: `Synthetic answer ${index}` } },
        ...(open ? [] : [{ timestamp: stamp, type: "event_msg", payload: { type: "task_complete" } }]),
      ].map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
      transcribed.push({ path: transcript, conversationId: conversationId(index), cwd });
    }
  }

  const filename = path.join(directory, "agent-registry.sqlite");
  const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: file, normalize: normalizeRegistry });
  try {
    /* The hygiene owner archives in bounded passes, so the newest terminal
       rows are still hot when a release starts. */
    const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
    const counter = new Database(filename, { readonly: true });
    const rows = counter.query<{ rows: number }, []>("SELECT COUNT(*) AS rows FROM registry_rows").get()!.rows;
    counter.close();
    let remaining = Math.max(0, rows - shape.hotTerminalRows);
    while (remaining > 0) {
      const moved = store.archiveInactive(Math.min(10_000, remaining));
      if (!moved) break;
      remaining -= moved;
    }
    const decided = store.read((registry) => grantSubjects.map((subject) =>
      [...(registry[subject.collection][subject.key]?.launchProfile?.mcpServers ?? [])]));
    decided.forEach((servers, index) => { grantSubjects[index]!.servers = servers; });
  } finally {
    store.close();
  }
  const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(filename, { readonly: true });
  try {
    const total = db.query<{ rows: number; bytes: number }, []>(
      "SELECT COUNT(*) AS rows, SUM(LENGTH(value_json)) AS bytes FROM registry_records").get()!;
    const cold = db.query<{ rows: number }, []>("SELECT COUNT(*) AS rows FROM registry_cold").get()!;
    return {
      filename,
      shape,
      rows: total.rows,
      coldRows: cold.rows,
      payloadBytes: total.bytes,
      activeEntryKeys,
      workers,
      pendingDeliveryIds,
      uncertainDeliveryIds,
      grantSubjects,
      coldOperationIds,
      hotOperationIds,
      conversationPaths: sessionsRoot ? transcribed.map((item) => item.path) : Array.from({ length: count }, (_, index) => transcriptOf(index)),
      conversations: transcribed,
      seedMs: performance.now() - started,
    };
  } finally {
    db.close();
  }
}
