import { readBackgroundTaskLedger, pendingBackgroundTasks } from "@/lib/pipelines/backgroundTasks";
import fs from "node:fs";
import path from "node:path";
import { activityFactsFromRecords } from "@/lib/lifecycle/agentActivityEvidence";
import { activityProcessReader } from "@/lib/lifecycle/agentActivityProcesses";
import { tailRecordsResult } from "./activity";
import type { FileEntry, ProjectCatalogEntry } from "../types";
import { agentRegistry, RegistryReadError, resolveConversationAlias } from "../agent/registry";
import { registryRowProjection, type RegistryRowProjector } from "../agent/sqliteRegistryStore";
import type { ViewerConversationId } from "../accounts/migration/contracts";
import { forEachCooperatively, yieldToRuntime } from "../cooperative";
import { tickPipelines } from "../pipelines/engine";
import { notifyQuestion } from "../push";
import { overlayControllerSessionTitles, sessionProjectProjection } from "../session/titleProjection";
import { deputyConversationRefs } from "../orchestrator/deputies";
import { loadTasksForList } from "../tasks/store";
import { waitForStateLock } from "../state/lockWait";
import { admitScannedConversations, planAdmissions } from "../tasks/membership";
import { loadPipelinesForProjection } from "../pipelines/store";
import { panePidMap, resolveTarget } from "../tmux";
import { activityVerdict, transcriptTurnResult } from "./activity";
import type { ConversationCatalogEntry } from "./conversationCatalog";
import { ctxFor } from "./context";
import { lastAgentWorkAtFor, lastAssistantMessageAtFor, lastTurnFor } from "./turnDuration";
import { discoverFiles, discoverFilesWithProjectCatalog } from "./discover";
import { describeFile } from "./describe";
import { durableServiceTierIndexForPaths, entryEffort, entryEffortResult, entryServiceTier } from "./effort";
import { linkEntries } from "./links";
import { entryModelsResult } from "./model";
import { agentProcesses, outputHolders } from "./process";
import { goalFor, planFor } from "./plan";
import { pendingQuestionFor } from "./questions";
import { pendingWakeupFor } from "./wakeup";
import { assignTranscriptPids } from "./transcripts";
import { scanRootEntries } from "./roots";
import { createTranscriptPathCanonicalizer, type TranscriptPathCanonicalizer } from "./transcriptIdentity";
import { waitingInputProbe } from "./waitingInput";
import { observeCodexSubagentTranscripts } from "../runtime/codexSubagentDetection";
import { machineCpuPressurePollMs } from "../runtime/cpuPressure";

function applyProcessState(entry: FileEntry, holders: Map<string, number>) {
  if (entry.root === "claude-tasks" && entry.path.endsWith(".output")) {
    const holder = holders.get(entry.path) ?? null;
    entry.pid = holder;
    entry.proc = holder === null ? "done" : "running";
    if (holder !== null) {
      entry.activity = "live";
      entry.activityReason = "output_held";
    }
  }
}

/**
 * TODO(codex): full pipeline port of `list_files` from the prototype
 * (the original single-file Python prototype):
 *
 *  1. discover.ts  — walk ROOTS, filter EXTS, skip `tool-results/` and
 *     everything in claude-tasks that is not `<slug>/<sid>/tasks/*.output`,
 *     skip a-prefixed task outputs that mirror subagents/agent-<id>.jsonl,
 *     stat each file, dedupe copied Codex rollouts, then apply the configurable
 *     recent-project and per-project scheme window.
 *  2. describe.ts  — project/title/kind/engine/fmt per root (port `describe`,
 *     `_scan_jsonl_title`, `_project_from_slug`), size-keyed cache.
 *  3. activity.ts  — port `_tail_records`, `_jsonl_turn_state`, `_activity`
 *     (age gate: files quiet >30 min are idle without reading).
 *  4. model.ts     — port `_entry_model` + `_short_model`.
 *  5. links.ts     — port `_link_entries` (parent links + bg-task command
 *     recovery + project inheritance from root ancestor).
 *
 * Steps 3-5 run only on the capped shortlist.
 */
const NO_HOLDERS: Map<string, number> = new Map();
const ASYNC_BATCH_SIZE = 16;

async function forEachEntryYielding(entries: FileEntry[], visit: (entry: FileEntry) => void): Promise<void> {
  await forEachCooperatively(entries, visit);
}

async function forEachEntryBatchYielding(
  entries: FileEntry[],
  visit: (entry: FileEntry) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < entries.length; start += ASYNC_BATCH_SIZE) {
    await Promise.all(entries.slice(start, start + ASYNC_BATCH_SIZE).map(visit));
    if (start + ASYNC_BATCH_SIZE < entries.length) await yieldToRuntime();
  }
}

export interface FileScanOptions {
  persist?: boolean;
  /** Refresh process and tmux pane observations before hydrating FileEntry
      ownership and pane-derived state. */
  fresh?: boolean;
  /** Persist parsed per-file summaries while keeping controller mutations out
      of request-owned scans. */
  persistIndex?: boolean;
  /** Deep-link target that must survive the recency cap: a transcript path,
      or a `conversation_*` id resolved to its current generation path. */
  pin?: string;
  /** Batch of transcript paths that must survive the recency cap. Used by
      operations that need one activity snapshot for a complete target set. */
  pins?: readonly string[];
  /** Publishes the current filesystem scope for resource observation. Sidebar
      metadata and lineage enrichment continue within the same generation. */
  onResourceSnapshot?: (snapshot: FileCatalogScan) => void;
  /** Last validated completed generation used only to label current resource
      paths while the catalog projection for this generation continues. */
  resourceBaseline?: FileCatalogScan;
  /** Cancellation for direct/test scans. Production scans cross the worker
      boundary, where abort terminates the child process. */
  signal?: AbortSignal | null;
}

export interface FileCatalogScan {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  /** Worker-only transport; the parent publishes and removes it on receipt. */
  conversationCatalog?: ConversationCatalogEntry[];
  pinOverlayPaths?: string[];
  complete: boolean;
}

/* Identity projections for the pin family walk. Enumerating the rows read
   every cold payload, and resolving each alias through the registry opened a
   read transaction per edge and membership: 5.9 s for one pinned scope over
   thirty thousand rows (#2761). Aliases resolve against the same snapshot. */
const PIN_CONVERSATION_PATHS: RegistryRowProjector<"conversations", { id: ViewerConversationId; latest: string | null; paths: string[] }> = {
  id: "scanner.pin-conversation-paths.v1",
  collection: "conversations",
  project: (conversation) => ({
    id: conversation.id,
    latest: conversation.generations.at(-1)?.path ?? null,
    paths: [...conversation.generations.map((generation) => generation.path), ...conversation.continuityPaths],
  }),
};
const PIN_LINEAGE: RegistryRowProjector<"lineageEdges", { parent: ViewerConversationId; child: ViewerConversationId }> = {
  id: "scanner.pin-lineage.v1",
  collection: "lineageEdges",
  project: (edge) => ({ parent: edge.parentConversationId, child: edge.childConversationId }),
};
const PIN_MEMBERSHIPS: RegistryRowProjector<"memberships", Array<{ container: string; conversationId: ViewerConversationId }>> = {
  id: "scanner.pin-memberships.v1",
  collection: "memberships",
  project: (memberships) => memberships.map((membership) => ({
    container: `${membership.kind}:${membership.containerId}`,
    conversationId: membership.conversationId,
  })),
};

/** Transcript paths a pin value requires in the feed. A conversation id is
    canonicalized through the registry's durable aliases and maps to its
    latest generation. A plain path also brings the registry-current
    generation of its owning conversation, so an archived `#f=` target always
    ships together with the successor the client must redirect to. An
    unreadable registry keeps a path pin as itself and drops an id pin. */
export function pinnedPathsFor(value: string | readonly string[] | undefined): ReadonlySet<string> {
  const values = typeof value === "string" ? [value] : value?.filter(Boolean) ?? [];
  if (!values.length) return new Set();
  try {
    const registry = agentRegistry();
    const snapshot = registry.readOnlySnapshot();
    const canonical = (id: ViewerConversationId) => resolveConversationAlias(snapshot, id);
    const paths = new Set<string>();
    const latestByKnownPath = new Map<string, string>();
    const conversationIdByKnownPath = new Map<string, `conversation_${string}`>();
    for (const [, conversation] of registryRowProjection(snapshot, PIN_CONVERSATION_PATHS)) {
      const latest = conversation.latest;
      if (!latest) continue;
      for (const pathname of conversation.paths) {
        latestByKnownPath.set(pathname, latest);
        conversationIdByKnownPath.set(pathname, conversation.id);
      }
    }
    const children = new Map<string, `conversation_${string}`[]>();
    for (const [, edge] of registryRowProjection(snapshot, PIN_LINEAGE)) {
      const parent = canonical(edge.parent);
      const child = canonical(edge.child);
      const rows = children.get(parent) ?? [];
      if (!rows.includes(child)) rows.push(child);
      children.set(parent, rows);
    }
    const membersByContainer = new Map<string, `conversation_${string}`[]>();
    for (const [, memberships] of registryRowProjection(snapshot, PIN_MEMBERSHIPS)) {
      for (const membership of memberships) {
        const rows = membersByContainer.get(membership.container) ?? [];
        const member = canonical(membership.conversationId);
        if (!rows.includes(member)) rows.push(member);
        membersByContainer.set(membership.container, rows);
      }
    }
    const addFamily = (seed: `conversation_${string}`) => {
      const queue = [canonical(seed)];
      const seen = new Set<string>();
      while (queue.length) {
        const conversationId = queue.shift()!;
        if (seen.has(conversationId)) continue;
        seen.add(conversationId);
        const conversation = snapshot.conversations[conversationId];
        const latest = conversation?.generations.at(-1)?.path;
        if (latest) paths.add(latest);
        const parent = snapshot.lineageEdges[conversationId]?.parentConversationId;
        if (parent) queue.push(canonical(parent));
        for (const child of children.get(conversationId) ?? []) queue.push(child);
        for (const membership of snapshot.memberships[conversationId] ?? []) {
          for (const member of membersByContainer.get(`${membership.kind}:${membership.containerId}`) ?? []) queue.push(member);
        }
      }
    };
    for (const pin of values) {
      if (pin.startsWith("conversation_")) {
        const id = canonical(pin as `conversation_${string}`) ?? pin;
        if (snapshot.conversations[id]) addFamily(id);
        continue;
      }
      paths.add(pin);
      const latest = latestByKnownPath.get(pin);
      if (latest) paths.add(latest);
      const owner = conversationIdByKnownPath.get(pin);
      if (owner) addFamily(owner);
    }
    return paths;
  } catch (error) {
    if (error instanceof RegistryReadError) return new Set(values.filter((pin) => !pin.startsWith("conversation_")));
    throw error;
  }
}

export async function listFiles(options: FileScanOptions = {}): Promise<FileEntry[]> {
  return (await listFilesInternal(false, undefined, options)).files;
}

export async function listFilesWithProjectCatalog(selectedProject?: string, options: FileScanOptions = {}): Promise<FileCatalogScan> {
  return listFilesInternal(true, selectedProject, options);
}

/** Discovery can precede hydration by seconds. Reobserve a moving file only
    after its current header confirms the same catalog identity. A replacement
    with different metadata belongs to the next discovery generation. */
function refreshEntryIdentity(entry: FileEntry): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entry.path);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size === entry.size && stat.mtimeMs / 1000 === entry.mtime) return true;
  const root = path.resolve(entry.path.slice(0, -entry.name.length));
  const current = describeFile(entry.root, root, entry.path, stat);
  const keys = ["cwd", "nativeParentThreadId", "nativeForkSourceThreadId", "engine", "fmt", "kind"] as const;
  if (!current.complete || keys.some((key) => (entry[key] ?? null) !== (current.description[key] ?? null))) return false;
  entry.title = current.description.title;
  entry.sessionStartedAt = current.description.sessionStartedAt;
  entry.size = stat.size;
  entry.mtime = stat.mtimeMs / 1000;
  return true;
}

/* Transcript paths superseded by an account migration: every generation and
   continuity path of a conversation except its current one. Mirrors the
   `migratedTo` annotation in the files response — these entries are folded
   into their successor's card, so they rank below live transcripts when the
   recency cap is applied and leave the cap slots to live conversations.
   A path is only a predecessor when it names a DIFFERENT file from some
   conversation's current generation: an account home that symlinks into the
   shared transcript store gives one physical transcript two absolute forms,
   and comparing those as strings filed live conversations as their own
   archived predecessors — demoted below the whole corpus, off the board and
   out of the folded list (issue #942). */
export function archivedTranscriptPaths(): ReadonlySet<string> {
  return withDeputyTranscripts(archivedPredecessorPaths());
}

/* A seat's deputies (docs/design/ghost-seat.md §5) rank with the archived
   predecessors: a week of one-ask forks must not eat the recency cap and churn
   live conversations out of the feed. A live deputy's host keeps its card
   through the hosted set whatever the cap says. */
function withDeputyTranscripts(demoted: ReadonlySet<string>): ReadonlySet<string> {
  let deputies: string[];
  try {
    deputies = deputyConversationRefs()?.paths ?? [];
  } catch {
    deputies = [];
  }
  if (!deputies.length) return demoted;
  return new Set([...demoted, ...deputies]);
}

function archivedPredecessorPaths(): ReadonlySet<string> {
  const archived = sessionProjectProjection(true).archivedPaths;
  if (!archived.size) return archived;
  const canonicalize = createTranscriptPathCanonicalizer(scanRootEntries().map(([, root]) => root));
  const current = currentTranscriptPaths(canonicalize);
  if (!current.size) return archived;
  const predecessors = new Set<string>();
  for (const pathname of archived) {
    if (!current.has(canonicalize(pathname))) predecessors.add(pathname);
  }
  return predecessors;
}

/** Canonical path of every conversation's current generation. */
function currentTranscriptPaths(canonicalize: TranscriptPathCanonicalizer): ReadonlySet<string> {
  const paths = new Set<string>();
  try {
    for (const conversation of Object.values(agentRegistry().readOnlySnapshot().conversations)) {
      const latest = conversation.generations.at(-1)?.path;
      if (latest) paths.add(canonicalize(latest));
    }
  } catch (error) {
    /* An unreadable registry leaves demotion exactly as the projection saw it. */
    if (!(error instanceof RegistryReadError)) throw error;
  }
  return paths;
}

/** Transcripts a registered host is running right now (issue #942). The scheme
    window keeps their cards whatever the caps say. */
export function hostedTranscriptPaths(): ReadonlySet<string> {
  const paths = new Set<string>();
  try {
    for (const entry of Object.values(agentRegistry().readOnlySnapshot().entries)) {
      if (entry.status === "dead" || entry.status === "unhosted") continue;
      if (entry.artifactPath) paths.add(entry.artifactPath);
    }
  } catch (error) {
    if (!(error instanceof RegistryReadError)) throw error;
  }
  return paths;
}

async function listFilesInternal(
  includeProjectCatalog: boolean,
  selectedProject?: string,
  options: FileScanOptions = {},
): Promise<FileCatalogScan> {
  if (options.signal?.aborted) throw new DOMException("file scan cancelled", "AbortError");
  const persist = options.persist === true;
  const stagedResourceScope = options.onResourceSnapshot !== undefined;
  const demote = stagedResourceScope
    ? undefined
    : archivedTranscriptPaths();
  const requestedPins = options.pins ? [...options.pins, ...(options.pin ? [options.pin] : [])] : options.pin;
  const pin = pinnedPathsFor(requestedPins);
  const hosted = hostedTranscriptPaths();
  const scan = includeProjectCatalog
    ? await discoverFilesWithProjectCatalog(undefined, selectedProject, {
        persist,
        persistIndex: options.persistIndex,
        demote,
        loadDemote: stagedResourceScope ? archivedTranscriptPaths : undefined,
        pin,
        hosted,
        resourceBaseline: options.resourceBaseline,
        onResourceSnapshot: options.onResourceSnapshot,
        transportConversationCatalog: process.env.LLV_FILE_SCANNER_WORKER === "1",
      })
    : { files: await discoverFiles(undefined, demote ?? archivedTranscriptPaths(), pin, hosted), projectCatalog: [], complete: true };
  if (options.signal?.aborted) throw new DOMException("file scan cancelled", "AbortError");
  const entries = scan.files;
  if (options.fresh) {
    const panes = panePidMap(true);
    agentProcesses(true);
    await panes;
  }
  // The /proc fd scan is only needed to attribute background-task outputs to a
  // live pid. When the shortlist has no such entries, skip the scan entirely;
  // activity() only consults holders on the same claude-tasks/.output path.
  const needsHolders = entries.some((entry) => entry.root === "claude-tasks" && entry.path.endsWith(".output"));
  const holders = needsHolders ? outputHolders() : NO_HOLDERS;
  const durableTiers = await durableServiceTierIndexForPaths(entries.map(entry => entry.path));
  const invalidTails = new Set<string>();
  const hydrateEntry = (entry: FileEntry) => {
    const verdict = activityVerdict(entry.root, entry.path, entry.mtime, entry.size);
    entry.activity = verdict.state;
    entry.activityReason = verdict.reason;
    entry.derivationComplete = verdict.complete;
    if (entry.path.endsWith(".jsonl") && (entry.engine === "claude" || entry.engine === "codex" || entry.engine === "openclaw" || entry.engine === "copilot")) {
      const authoritative = transcriptTurnResult(entry.path, entry.size, entry.mtime * 1000, entry.engine);
      entry.derivationComplete &&= authoritative.complete;
      if (authoritative.complete) {
        entry.authoritativeTurn = authoritative.turn;
        entry.recoveryReleased = authoritative.recoveryReleased;
      }
    }
    const models = entryModelsResult(entry);
    entry.model = models.value.display;
    entry.launchModel = models.value.launch;
    entry.derivationComplete &&= models.complete;
    const effort = entryEffortResult(entry);
    entry.effort = effort.value;
    // Derive this while the shared transcript tail is resident; a second full
    // pass would reread every tail once the bounded cache holds fewer entries.
    entryServiceTier(entry, durableTiers);
    entry.derivationComplete &&= effort.complete;
    entry.plan = planFor(entry);
    entry.goal = goalFor(entry);
    entry.ctx = ctxFor(entry);
    entry.lastTurn = lastTurnFor(entry);
    if (entry.engine === "claude" || entry.engine === "codex") {
      const tail = tailRecordsResult(entry.path, entry.size, entry.mtime * 1000);
      if (tail.complete) {
        const facts = activityFactsFromRecords(tail.records);
        facts.turnBoundaryVerified = !tail.prefixTruncated || facts.turnBoundaryFound === true;
        entry.agentActivity = facts;
      } else entry.agentActivity = { lastRecordAt: null, turnBoundaryVerified: false };
    }
    entry.lastAssistantMessageAt = lastAssistantMessageAtFor(entry);
    entry.lastAgentWorkAt = lastAgentWorkAtFor(entry);
    entry.pendingWakeup = pendingWakeupFor(entry);
    pendingQuestionFor(entry);
  };
  await forEachEntryYielding(entries, (entry) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!refreshEntryIdentity(entry)) {
        entry.derivationComplete = false;
        return;
      }
      hydrateEntry(entry);
      if (entry.derivationComplete !== false || !entry.path.endsWith(".jsonl")) return;
      const tail = tailRecordsResult(entry.path, entry.size, entry.mtime * 1000);
      if (tail.failure === "changed" && attempt === 0) continue;
      if (tail.failure === "content") invalidTails.add(entry.path);
      return;
    }
  });
  await forEachEntryYielding(entries, (entry) => {
    applyProcessState(entry, holders);
  });
  assignTranscriptPids(entries);
  const activityProcesses = activityProcessReader();
  // After pid assignment: the claude effort source is the live process argv.
  await forEachEntryBatchYielding(entries, async (entry) => {
    if (entry.agentActivity && entry.proc === "running" && entry.pid !== null) {
      entry.agentActivity.workProcesses = activityProcesses(entry.pid);
      entry.agentActivity.turnStartedAt = entry.lastTurn?.endedAt === null ? entry.lastTurn.startedAt : entry.agentActivity.turnStartedAt;
    }
    entry.effort = entryEffort(entry);
    entry.serviceTier = entryServiceTier(entry, durableTiers);
    entry.fast = entry.serviceTier === null ? null : entry.serviceTier !== "default";
    if (entry.engine === "claude" && entry.agentActivity && entry.proc === "running") {
      const ledger = await readBackgroundTaskLedger(entry.path);
      entry.agentActivity.backgroundVerified = ledger !== null;
      if (ledger) entry.agentActivity.background = pendingBackgroundTasks(ledger, Date.now()).filter(task => task.kind !== "wakeup").map(task => ({ id: task.id, description: entry.agentActivity?.background?.find(item => item.id === task.id)?.description ?? null }));
    }
    const pending = pendingQuestionFor(entry);
    entry.pendingQuestion = pending && entry.pid !== null
      ? { ...pending, paneTarget: await resolveTarget(entry.pid) }
      : pending;
    const probe = await waitingInputProbe(entry);
    entry.waitingInput = probe.waiting;
    entry.rateLimit = probe.rateLimit;
    /* A stalled transcript whose pane sits at a plain composer was interrupted
       mid-turn (Esc leaves the turn open in the jsonl): the agent is idle, not
       blocked, so it must not wear the «interrupted or waiting for permission» state. */
    if (probe.atComposer && entry.activity === "stalled") {
      entry.activity = Date.now() / 1000 - entry.mtime < 900 ? "recent" : "idle";
      entry.activityReason = "pane_at_composer";
    }
  });
  await linkEntries(entries, { persist });
  if (options.signal?.aborted) throw new DOMException("file scan cancelled", "AbortError");
  if (invalidTails.size) {
    console.warn(`[scanner] ${invalidTails.size} transcript tail(s) unavailable; retained with unknown turn evidence: ${[...invalidTails].slice(0, 5).join(", ")}`);
  }
  const pinOverlayPaths = "pinOverlayPaths" in scan ? scan.pinOverlayPaths : undefined;
  return {
    files: entries,
    projectCatalog: scan.projectCatalog,
    ...("conversationCatalog" in scan && scan.conversationCatalog
      ? { conversationCatalog: scan.conversationCatalog }
      : {}),
    ...(pinOverlayPaths?.length ? { pinOverlayPaths } : {}),
    // A stable damaged transcript remains present with unknown turn evidence.
    // It cannot prevent unrelated conversations from reaching the inventory.
    // Changing identities and I/O failures still withhold this generation.
    complete: scan.complete && entries.every((entry) => entry.derivationComplete !== false || invalidTails.has(entry.path)),
  };
}

/** Whether someone other than the operator answers an entry's question
    first, read once per controller pass. Unreadable routing pushes as before. */
async function questionRouteReader(entries: readonly FileEntry[]): Promise<(entry: FileEntry) => boolean> {
  if (!entries.some((entry) => entry.pendingQuestion || entry.waitingInput)) return () => false;
  try {
    const [{ questionRouteReader: routeReader, productionRoutingSources }, { seatIdentityResolver }] = await Promise.all([
      import("@/lib/attention/routeOverlay"), import("@/lib/bridge/seatIdentity"),
    ]);
    const registry = agentRegistry();
    return routeReader(productionRoutingSources(seatIdentityResolver((id) => registry.canonicalConversationId(id))), Date.now() / 1000);
  } catch {
    return () => false;
  }
}

/** Durable controllers run outside request handlers. Flow ordering remains
    stable: workflows observe the flow state from the same controller tick. */
export async function reconcileFileControllers(
  entries: FileEntry[],
  options: { inventoryChanged?: boolean } = {},
): Promise<void> {
  // The sidecar already compared the complete scan and a bounded registry
  // cursor. Link/observation recovery needs another pass only for new inputs.
  if (options.inventoryChanged !== false) await linkEntries(entries, { persist: true });
  // The observer keeps its own successful-work cursor and retries failed or
  // budget-deferred paths. Run it every pass without rebuilding registry links.
  observeCodexSubagentTranscripts(agentRegistry(), entries);
  await yieldToRuntime();
  // Custom session titles (issue #33) must reach push bodies too, so overlay
  // them before notifying — a rename shows the human name in notifications.
  overlayControllerSessionTitles(entries, options.inventoryChanged === false);
  /* A worker's question waits on its project's seat first
     (docs/design/attention-auto-resolve.md): it reaches the operator's phone
     only when no seat can be woken for it. */
  const routedToOthers = await questionRouteReader(entries);
  await forEachCooperatively(entries, (entry) => {
    if ((entry.pendingQuestion || entry.waitingInput) && !routedToOthers(entry)) void notifyQuestion(entry);
  });
  // A pass that finishes may still own a FIFO head a held pass needs.
  // Keep pipeline admission polling until the shared scanner pass settles.
  const controllers = [tickPipelines] as const;
  const polling: (Promise<void> | null)[] = controllers.map(() => null);
  const watch = setInterval(() => {
    for (const [index, tick] of controllers.entries()) {
      if (polling[index]) continue;
      polling[index] = tick(entries).then(() => {})
        .catch(error => { console.error("[scanner] work controller polling failed", error); })
        .finally(() => { polling[index] = null; });
    }
  }, machineCpuPressurePollMs());
  watch.unref();
  try {
    const results = await Promise.allSettled(controllers.map(tick => tick(entries)));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  } finally {
    // A timer may have started another pass; retain admission until it too
    // settles, then leave no controller work behind this scanner pass.
    while (polling.some(Boolean)) await Promise.all(polling);
    clearInterval(watch);
  }
  await yieldToRuntime();
  /* Canonical task membership (#1586): every root conversation the board draws
     belongs to a task. Placeholders are minted here, on the durable controller
     pass, in bounded batches — never from a read-only files GET. */
  try {
    await waitForStateLock("controller.task-admission", () => {
      const pipelines = loadPipelinesForProjection();
      if (planAdmissions(entries, loadTasksForList(), pipelines).length > 0) {
        // Admission derives the plan again under its writer lease.
        admitScannedConversations(entries, pipelines);
      }
    }, { subject: "tasks" });
  } catch (error) {
    console.error("[tasks] skipping conversation admission", error);
  }
}
