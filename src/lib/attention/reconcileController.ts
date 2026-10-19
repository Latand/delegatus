import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { NeedsYouBody } from "./needsYouRead";
import type { SystemAttentionClear } from "./dismissals";
import { attentionSystemClears, retiredSeatConversations, type ReconcileFacts } from "./reconcile";

/*
 * The clock of automatic clearing (docs/design/attention-auto-resolve.md,
 * «Implementation plan for acceptance 2»). It runs in the release that owns
 * traffic, beside the seat tick and the asks sweep, over the board projection
 * the panel itself reads, so a wait that no longer asks anyone leaves the
 * operator's list on an ordinary minute, whether or not any agent takes a
 * turn. Every source is read before anything is written; one that cannot be
 * read clears nothing.
 */

export const ATTENTION_RECONCILE_INTERVAL_MS = 60_000;
const FIRST_RECONCILE_DELAY_MS = 30_000;

export interface AttentionReconcilePorts {
  now(): Date;
  board(): Promise<Pick<NeedsYouBody, "files" | "pipelines"> & Partial<Pick<NeedsYouBody, "tasks">>>;
  facts(body: Pick<NeedsYouBody, "pipelines"> & Partial<Pick<NeedsYouBody, "tasks">>): ReconcileFacts;
  write(clears: readonly SystemAttentionClear[], now: Date): SystemAttentionClear[];
  /** Rechecked inside admission, immediately before the first effect. */
  current?(): boolean;
  admit?(write: () => SystemAttentionClear[]): Promise<SystemAttentionClear[]>;
  /** Tell the board something changed; best effort. */
  announce(): Promise<void>;
}

async function productionPorts(assertActive: () => void): Promise<AttentionReconcilePorts> {
  const [{ operatorBoardRepresentation }, { systemClearAttention }, seats, { readReplySuggestionsFile }, registry, tasks, pipelines] = await Promise.all([
    import("@/app/api/files/operatorProjection"),
    import("./dismissals"),
    import("@/lib/orchestrator/seats"),
    import("@/lib/suggestions/store"),
    import("@/lib/agent/registry"),
    import("@/lib/tasks/store"),
    import("@/lib/pipelines/store"),
  ]);
  let observedRegistry: ReturnType<ReturnType<typeof registry.agentRegistry>["readOnlySnapshot"]> | undefined;
  let observedTasks: ReturnType<typeof tasks.loadTasksForList> | undefined;
  let observedLanes: ReturnType<typeof pipelines.loadPipelinesForList> = [];
  return {
    now: () => new Date(),
    board: operatorBoardRepresentation,
    facts: () => {
      observedRegistry = registry.agentRegistry().readOnlySnapshot();
      const lookup = registry.readOnlyConversationLookupFromSnapshot(observedRegistry);
      const canonical = (id: string) => (id.startsWith("conversation_") ? lookup.canonicalConversationId(id as `conversation_${string}`) : id);
      const operatorWroteAt = new Map<string, number>();
      for (const admission of readReplySuggestionsFile().admissions) {
        const at = Date.parse(admission.at);
        const id = canonical(admission.conversationId);
        if (Number.isFinite(at) && at > (operatorWroteAt.get(id) ?? Number.NEGATIVE_INFINITY)) operatorWroteAt.set(id, at);
      }
      observedTasks = tasks.loadTasksForList();
      observedLanes = pipelines.loadPipelinesForList();
      const lanes = new Map(observedLanes.map(lane => [lane.id, lane]));
      return {
        canonicalConversationId: canonical,
        retiredSeats: retiredSeatConversations(seats.readOrchestratorSeatFileOrNull(), canonical),
        operatorWroteAt,
        pipeline: (id) => lanes.get(id) ?? null,
        tasks: observedTasks,
        pipelines: observedLanes,
      };
    },
    admit: write => waitForStateLock("attention.reconcile.write", write, { subject: "attention" }),
    current: () => {
      assertActive();
      // Any source replacement while admission waited invalidates the observation.
      if (tasks.loadTasksForList() !== observedTasks || pipelines.loadPipelinesForList() !== observedLanes) return false;
      if (!observedRegistry || registry.agentRegistry().readOnlySnapshot() !== observedRegistry) return false;
      return true;
    },
    write: (clears, now) => {
      if (!observedRegistry) return [];
      const lookup = registry.readOnlyConversationLookupFromSnapshot(observedRegistry);
      return systemClearAttention(clears.filter(clear => {
        if (clear.rule !== "container-finished" || !clear.conversationId?.startsWith("conversation_")) return true;
        const conversation = lookup.conversation(clear.conversationId as `conversation_${string}`);
        const generation = conversation?.generations.at(-1);
        const entry = conversation && generation ? observedRegistry!.entries[`${conversation.engine}:${generation.id}`] : null;
        return !entry || entry.status === "dead";
      }), now);
    },
    announce: async () => {
      try {
        const [{ runtimeHostClient }, { publishFilesRevision }] = await Promise.all([import("@/lib/runtime/client"), import("@/lib/runtime/filesRevision")]);
        const client = runtimeHostClient();
        if (client) await publishFilesRevision(client);
      } catch {
        // the next poll carries it
      }
    },
  };
}

/** One pass: read the board and the facts, write the clears they prove.
    Answers what it wrote. */
export async function reconcileAttentionOnce(ports?: AttentionReconcilePorts, assertActive = () => {
  if (!viewerReleaseOwnsTraffic()) throw new Error("attention reconciliation lost release authority");
}): Promise<SystemAttentionClear[]> {
  const live = ports ?? await productionPorts(assertActive);
  const body = await live.board();
  const facts = live.facts(body);
  const now = live.now();
  const files = body.files.map(file => file.attentionDismissal?.by.kind === "system" && file.attentionDismissal.by.rule === "container-finished" && !file.attentionDismissal.restoredAt
    ? { ...file, attentionDismissal: undefined } : file);
  const clears = attentionSystemClears(files, now.getTime() / 1000, facts);
  if (!clears.length) return [];
  const write = () => live.current?.() === false ? [] : live.write(clears, now);
  const written = live.admit ? await live.admit(write) : write();
  if (written.length) await live.announce();
  return written;
}

async function releaseOwnsTraffic(): Promise<boolean> {
  try {
    const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerInstrumentation");
    return viewerReleaseOwnsTraffic();
  } catch {
    return false;
  }
}

/* Shared by every bundle that loads this module: the route bundle and the
   instrumentation bundle hold separate copies. */
const TIMER = Symbol.for("delegatus.attentionReconcileTimer");
const host = globalThis as typeof globalThis & { [TIMER]?: ReturnType<typeof setTimeout> };

export function startAttentionReconcile(ports: {
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  pass?: () => Promise<unknown>;
} = {}): void {
  if (host[TIMER]) return;
  const schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const pass = ports.pass ?? (async () => {
    if (await releaseOwnsTraffic()) await reconcileAttentionOnce();
  });
  const arm = (delayMs: number) => {
    const timer = schedule(() => {
      void withViewerOperation("attention.reconcile", pass)
        .catch((error) => console.error("[attention reconcile] pass failed", error instanceof Error ? error.name : "unknown"))
        .finally(() => {
          if (host[TIMER] === timer) arm(ATTENTION_RECONCILE_INTERVAL_MS);
        });
    }, delayMs);
    timer.unref?.();
    host[TIMER] = timer;
  };
  arm(FIRST_RECONCILE_DELAY_MS);
}

/** Test seam: the timer is process-global. */
export function stopAttentionReconcile(): void {
  if (host[TIMER]) clearTimeout(host[TIMER]);
  host[TIMER] = undefined;
}
