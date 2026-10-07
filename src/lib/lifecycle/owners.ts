/* The census of recorded processes (docs/design/update-drain-liveness.md).

   The update drain used to ask about an identifier (a conversation id, a
   transcript path, a session key) and resolve it to evidence through separate
   lookups, each picking one row from several. Evidence about one process was
   then judged together with evidence about another. This module lists every
   process a durable record names, with the transcript that record names, so
   each can be judged from the records that name that same process. A
   conversation, a generation, a journal row, a stage and a flow name no
   process, so they add no owner here.

   Pure over its inputs: the registry snapshot, the flows, a liveness probe and,
   for R6b, this Viewer's own identity and the session keys it holds a host for. */
import { identityAlive, type LivenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry, RegistryFile, SpawnReceipt } from "@/lib/agent/registry";
import { resolveConversationAlias, structuredClaimIdentity } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import type { Flow, Round } from "@/lib/flows/types";
import type { ProcessIdentity } from "@/lib/processIdentity";

export type CensusRegistry = Pick<RegistryFile, "entries" | "conversations">
  & Partial<Pick<RegistryFile, "conversationAliases" | "receipts">>;

/** The session key a journal row or a registry entry names its row by. */
export type RegistryRowKey = { engine: string; sessionId: string };

export type OwnerRole = "host" | "setup" | "reviewer";

/**
 * One recorded process together with the transcript its record names (R1).
 * `identities` answer for the process: a tmux owner is its agent and its pane
 * process, alive while either answers. A reviewer is read through the round's
 * own pid and identity string instead.
 */
export interface RecordedOwner {
  /** Unique per census: the record, the process and the artifact. */
  id: string;
  role: OwnerRole;
  kind: "tmux" | "structured" | "headless";
  pid: number;
  identities: ProcessIdentity[];
  round?: Pick<Round, "reviewerPid" | "reviewerIdentity">;
  artifactPath: string | null;
  /** The registry entry that records the process, for its row reference and
      its writer; null for a receipt or a round. */
  entry: AgentRegistryEntry | null;
  entryKey: string | null;
  sessionKey: RegistryRowKey | null;
  /** The writer epoch of the entry's host columns, or null when the entry has
      no writer: a tmux host, or no structured columns (R5). */
  writerEpoch: number | null;
  /** True for the structured host the entry records, the one process a handle
      held under the entry's key speaks for. */
  structuredHost: boolean;
  launchId: string | null;
  /** The canonical conversation the owner is shown under and found by. It is
      used for display and custody lookups, never to choose evidence. */
  binding: string | null;
  /** The conversations of the launch receipts that record this same process
      (R1). A stage or a flow that names one reaches the owner through it
      (R10), before the conversation's own row binds the entry. */
  custody?: string[];
  engine: string | null;
  cwd: string | null;
}

/** A row that claims a host and records no process (R2, R8). */
export interface OwnerlessRecord {
  id: string;
  kind: "hosted-row" | "open-receipt";
  artifactPath: string | null;
  entryKey: string | null;
  sessionKey: RegistryRowKey | null;
  launchId: string | null;
  binding: string | null;
  engine: string | null;
  cwd: string | null;
  /** When the registry row was last written, for a hosted row (R8 clock 1). */
  updatedAt: number | null;
}

export interface OwnerCensus {
  owners: RecordedOwner[];
  ownerless: OwnerlessRecord[];
}

/** What R6b needs to know about the Viewer that runs the census. */
export interface CensusViewer {
  identity: ProcessIdentity | null;
  heldKeys: { has(key: string): boolean };
}

const HOSTED = new Set<AgentRegistryEntry["status"]>(["starting", "live", "idle", "handoff"]);
const OPEN_RECEIPT = new Set<SpawnReceipt["state"]>(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);

function usable(identity: ProcessIdentity | null | undefined): identity is ProcessIdentity {
  return !!identity && Number.isInteger(identity.pid) && identity.pid > 0;
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startIdentity === right.startIdentity;
}

/** Alive while any recorded identity answers under its start identity (R4). */
export function ownerProcessAlive(owner: Pick<RecordedOwner, "identities" | "round">, probe: LivenessProbe): boolean {
  if (owner.round) return headlessRoundVerdict(owner.round, probe) !== "gone";
  return owner.identities.some((identity) => identityAlive(identity, probe));
}

/** The verdict a headless round's own pid and identity give (#2515): `alive`
    under the exact identity, `gone` on a pid that does not answer or answers
    as another process, `unproven` otherwise. */
export function headlessRoundVerdict(
  round: { reviewerPid?: number | null; reviewerIdentity?: string | null },
  probe: LivenessProbe,
): "alive" | "gone" | "unproven" {
  const pid = round.reviewerPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unproven";
  if (!probe.pidAlive(pid)) return "gone";
  const currentIdentity = probe.processIdentity(pid);
  if (!round.reviewerIdentity || !currentIdentity) return "unproven";
  return currentIdentity === round.reviewerIdentity ? "alive" : "gone";
}

function canonical(registry: Pick<CensusRegistry, "conversationAliases">, id: string): string {
  return registry.conversationAliases && id.startsWith("conversation_")
    ? resolveConversationAlias({ conversationAliases: registry.conversationAliases }, id as `conversation_${string}`)
    : id;
}

/** Where each session key and each transcript path is bound, by canonical id. */
interface Bindings {
  byKey: Map<string, string>;
  byPath: Map<string, string>;
}

function bindings(registry: CensusRegistry): Bindings {
  const byKey = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const conversation of Object.values(registry.conversations)) {
    const id = canonical(registry, conversation.id);
    for (const generation of conversation.generations) {
      byKey.set(sessionKeyId({ engine: conversation.engine, sessionId: generation.id }), id);
      if (!byPath.has(generation.path)) byPath.set(generation.path, id);
    }
    for (const path of conversation.continuityPaths ?? []) if (!byPath.has(path)) byPath.set(path, id);
  }
  return { byKey, byPath };
}

function entryBinding(map: Bindings, entry: AgentRegistryEntry): string | null {
  return map.byKey.get(sessionKeyId(entry.key)) ?? map.byPath.get(entry.artifactPath) ?? null;
}

/** The claimant of the entry's current writer claim, or null. */
function currentClaimant(entry: AgentRegistryEntry): ProcessIdentity | null {
  return entry.claimOwner && entry.claimEpoch > 0 && entry.structuredHost?.writerClaimEpoch === entry.claimEpoch
    ? structuredClaimIdentity(entry.claimOwner) : null;
}

/**
 * The owners one registry entry records (R2) and, when it records none, the
 * ownerless record it is (R8). R6 decides whether the writer claim is an owner.
 */
export function entryOwners(
  entry: AgentRegistryEntry,
  probe: LivenessProbe,
  context: { binding?: string | null; viewer?: CensusViewer | null } = {},
): { owners: RecordedOwner[]; ownerless: OwnerlessRecord | null } {
  const key = sessionKeyId(entry.key);
  const binding = context.binding ?? null;
  const tmux = entry.host?.kind === "tmux" ? entry.host : null;
  const writerEpoch = !tmux && entry.structuredHost ? entry.structuredHost.writerClaimEpoch : null;
  const base = {
    artifactPath: entry.artifactPath, entry, entryKey: key, sessionKey: entry.key,
    launchId: null, binding, engine: entry.key.engine, cwd: entry.cwd,
  };
  const owners: RecordedOwner[] = [];
  const recorded: ProcessIdentity[] = [];
  if (tmux) {
    const identities = [tmux.agent, tmux.panePid].filter(usable);
    if (identities.length) {
      recorded.push(...identities);
      owners.push({ ...base, id: `tmux:${key}:${tmux.agent.pid}:${tmux.agent.startIdentity}`, role: "host", kind: "tmux",
        pid: tmux.agent.pid, identities, writerEpoch: null, structuredHost: false });
    }
  }
  const structured = entry.structuredHost?.process;
  if (usable(structured)) {
    recorded.push(structured);
    owners.push({ ...base, id: `structured:${key}:${structured.pid}:${structured.startIdentity}`, role: "host", kind: "structured",
      pid: structured.pid, identities: [structured], writerEpoch, structuredHost: true });
  }
  for (const survivor of entry.structuredTerminationSurvivors ?? []) {
    if (!usable(survivor)) continue;
    recorded.push(survivor);
    owners.push({ ...base, id: `survivor:${key}:${survivor.pid}:${survivor.startIdentity}`, role: "host", kind: "structured",
      pid: survivor.pid, identities: [survivor], writerEpoch, structuredHost: false });
  }
  /* R6: in production the claimant is the Viewer that controls the host, so a
     live claim at the current epoch is the normal state of a hosted row. It
     is a setup owner only when it is doing setup. */
  const claimant = currentClaimant(entry);
  if (claimant) {
    const ownHost = recorded.some((identity) => sameProcess(identity, claimant));
    const viewer = context.viewer;
    const heldByThisViewer = !!viewer?.identity && sameProcess(viewer.identity, claimant) && viewer.heldKeys.has(key);
    const hostedLive = HOSTED.has(entry.status) && recorded.some((identity) => identityAlive(identity, probe));
    if (!ownHost && !heldByThisViewer && !hostedLive) {
      owners.push({ ...base, id: `setup:${key}:${claimant.pid}:${claimant.startIdentity}`, role: "setup", kind: "structured",
        pid: claimant.pid, identities: [claimant], writerEpoch, structuredHost: false });
    }
    recorded.push(claimant);
  }
  const ownerless = !recorded.length && HOSTED.has(entry.status) ? {
    id: `hosted-row:${key}`, kind: "hosted-row" as const, artifactPath: entry.artifactPath, entryKey: key, sessionKey: entry.key,
    launchId: null, binding, engine: entry.key.engine, cwd: entry.cwd,
    updatedAt: Number.isFinite(Date.parse(entry.updatedAt)) ? Date.parse(entry.updatedAt) : null,
  } : null;
  return { owners, ownerless };
}

/**
 * Every process the durable records name (R2), with no status filter, no age
 * filter and no size cap. Nothing is merged before a verdict except a receipt
 * or a round that describes a process an entry already records (R1).
 */
export function registryOwners(
  registry: CensusRegistry,
  flows: readonly Flow[],
  probe: LivenessProbe,
  viewer: CensusViewer | null = null,
): OwnerCensus {
  const map = bindings(registry);
  const owners: RecordedOwner[] = [];
  const ownerless: OwnerlessRecord[] = [];
  for (const entry of Object.values(registry.entries)) {
    const read = entryOwners(entry, probe, { binding: entryBinding(map, entry), viewer });
    owners.push(...read.owners);
    if (read.ownerless) ownerless.push(read.ownerless);
  }
  for (const receipt of Object.values(registry.receipts ?? {})) {
    const open = OPEN_RECEIPT.has(receipt.state);
    const base = {
      artifactPath: receipt.artifactPath, entry: null, entryKey: receipt.key ? sessionKeyId(receipt.key) : null,
      sessionKey: receipt.key, writerEpoch: null, structuredHost: false, launchId: receipt.launchId,
      binding: canonical(registry, receipt.conversationId), engine: receipt.engine, cwd: receipt.cwd,
    };
    const kind = receipt.transport === "tmux" ? "tmux" as const : "structured" as const;
    if (open && usable(receipt.admissionOwner)) {
      const admission = receipt.admissionOwner;
      owners.push({ ...base, id: `admission:${receipt.launchId}:${admission.pid}:${admission.startIdentity}`, role: "setup", kind,
        pid: admission.pid, identities: [admission] });
    } else if (open && !receipt.queuedPinnedSpawn) {
      /* A launch queued for account capacity has released its admission and
         started nothing, so it holds nothing (R2). */
      ownerless.push({ ...base, id: `open-receipt:${receipt.launchId}`, kind: "open-receipt", updatedAt: null });
    }
    const launched = [receipt.verifiedHost?.agent, receipt.pane?.panePid].filter(usable);
    if (!launched.length) continue;
    /* An entry that records the launched process is that owner already (R1):
       the receipt adds the conversation it was launched for, and the
       artifact stays the entry's. */
    const recorded = owners.filter((owner) => owner.entry && owner.identities.some((identity) => launched.some((other) => sameProcess(other, identity))));
    for (const owner of recorded) if (owner.binding !== base.binding && !owner.custody?.includes(base.binding)) (owner.custody ??= []).push(base.binding);
    if (!recorded.length) {
      owners.push({ ...base, id: `launched:${receipt.launchId}:${launched[0]!.pid}:${launched[0]!.startIdentity}`, role: "host", kind,
        pid: launched[0]!.pid, identities: launched });
    }
  }
  /* A headless launch records its process on the flow round only, so the
     hosted row it leaves with no process, at the round's own transcript or
     under the round's own session key, is that round's process (R1). The key
     is the round's session id under the engine its frozen role names, else
     the flow's reviewer role for a round from before the freeze. A row of
     another generation of the same conversation, or under another engine's
     key, is a launch of its own. */
  const described = new Set<string>();
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      const pid = round.reviewerPid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
      const engine = round.reviewerRole?.engine ?? flow.roles?.reviewer?.engine ?? null;
      const roundKey = round.sessionId && engine ? rowKeyId({ engine, sessionId: round.sessionId }) : null;
      for (const record of ownerless) {
        if (record.kind === "hosted-row" && ((!!round.reviewerPath && record.artifactPath === round.reviewerPath)
          || (roundKey !== null && record.entryKey === roundKey))) described.add(record.id);
      }
      const binding = round.reviewerConversationId ? canonical(registry, round.reviewerConversationId)
        : round.reviewerPath ? map.byPath.get(round.reviewerPath) ?? null : null;
      // An entry that records this process for the same transcript or
      // conversation already is this owner (R1).
      if (owners.some((owner) => owner.entry && owner.identities.some((identity) => identity.pid === pid
        && (!round.reviewerIdentity || identity.startIdentity === round.reviewerIdentity))
        && ((!!round.reviewerPath && owner.artifactPath === round.reviewerPath) || (binding !== null && owner.binding === binding)))) continue;
      owners.push({ id: `reviewer:${flow.id}:${round.n}:${pid}:${round.reviewerIdentity ?? ""}`, role: "reviewer", kind: "headless",
        pid, identities: [], round: { reviewerPid: pid, reviewerIdentity: round.reviewerIdentity ?? null },
        artifactPath: round.reviewerPath ?? null, entry: null, entryKey: null, sessionKey: null, writerEpoch: null,
        structuredHost: false, launchId: null, binding, engine: null, cwd: null });
    }
  }
  return { owners, ownerless: ownerless.filter((record) => !described.has(record.id)) };
}

/** What a stage, a flow or a journal row names. */
export interface OwnerReference {
  conversationId?: string | null;
  artifactPath?: string | null;
  sessionKey?: RegistryRowKey | null;
}

export interface CensusIndex {
  /** The conversation a reference resolves to: by id, then by key, then by
      path. An id the registry does not know is returned as it is. */
  conversation(reference: OwnerReference): string | null;
  /**
   * The items bound to a reference (R10): every entry of every generation and
   * alias of its conversation, every entry and receipt at its path, every
   * entry that records the process a receipt of its conversation launched,
   * every round that names either. A reference to a deleted earlier path still
   * reaches the conversation's current process, because the lookup returns the
   * whole set.
   */
  boundTo<T extends { binding: string | null; custody?: readonly string[]; artifactPath: string | null; entryKey: string | null }>(items: readonly T[], reference: OwnerReference): T[];
  /** Whether the registry holds anything a reference names (R9): an entry
      under its key, a conversation or receipt under its id, an entry or a
      generation at its path. */
  names(reference: OwnerReference): boolean;
}

export function censusIndex(registry: CensusRegistry): CensusIndex {
  const map = bindings(registry);
  const receiptIds = new Set(Object.values(registry.receipts ?? {}).map((receipt) => canonical(registry, receipt.conversationId)));
  const entryPaths = new Set(Object.values(registry.entries).map((entry) => entry.artifactPath));
  /* The conversations the entries and receipts at a path are bound to. An
     entry whose artifact moved past its generation's path is found at its own
     path only, and its binding carries the rest of its conversation (R10). */
  const pathBindings = new Map<string, Set<string>>();
  const bindPath = (path: string | null | undefined, id: string | null) => {
    if (!path || !id) return;
    const ids = pathBindings.get(path) ?? new Set<string>();
    ids.add(id);
    pathBindings.set(path, ids);
  };
  for (const entry of Object.values(registry.entries)) bindPath(entry.artifactPath, entryBinding(map, entry));
  for (const receipt of Object.values(registry.receipts ?? {})) bindPath(receipt.artifactPath, canonical(registry, receipt.conversationId));
  const conversation = (reference: OwnerReference): string | null => {
    const byId = reference.conversationId ? canonical(registry, reference.conversationId) : null;
    if (byId && registry.conversations[byId]) return byId;
    const byKey = reference.sessionKey ? map.byKey.get(rowKeyId(reference.sessionKey)) : undefined;
    if (byKey) return byKey;
    return (reference.artifactPath ? map.byPath.get(reference.artifactPath) : undefined) ?? byId;
  };
  return {
    conversation,
    boundTo(items, reference) {
      const ids = new Set(reference.artifactPath ? pathBindings.get(reference.artifactPath) ?? [] : []);
      const id = conversation(reference);
      if (id !== null) ids.add(id);
      const key = reference.sessionKey ? rowKeyId(reference.sessionKey) : null;
      return items.filter((item) => (item.binding !== null && ids.has(item.binding))
        || !!item.custody?.some((id) => ids.has(id))
        || (!!reference.artifactPath && item.artifactPath === reference.artifactPath)
        || (key !== null && item.entryKey === key));
    },
    names(reference) {
      if (reference.sessionKey && registry.entries[rowKeyId(reference.sessionKey)]) return true;
      if (reference.conversationId) {
        const id = canonical(registry, reference.conversationId);
        if (registry.conversations[id] || receiptIds.has(id)) return true;
      }
      return !!reference.artifactPath && (map.byPath.has(reference.artifactPath) || entryPaths.has(reference.artifactPath));
    },
  };
}

export function rowKeyId(key: RegistryRowKey): string {
  return `${key.engine}:${key.sessionId}`;
}
