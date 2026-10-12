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
  board(): Promise<Pick<NeedsYouBody, "files" | "pipelines">>;
  facts(body: Pick<NeedsYouBody, "pipelines">): ReconcileFacts;
  write(clears: readonly SystemAttentionClear[], now: Date): SystemAttentionClear[];
  /** Tell the board something changed; best effort. */
  announce(): Promise<void>;
}

async function productionPorts(): Promise<AttentionReconcilePorts> {
  const [{ operatorBoardRepresentation }, { systemClearAttention }, seats, { readReplySuggestionsFile }, registry] = await Promise.all([
    import("@/app/api/files/operatorProjection"),
    import("./dismissals"),
    import("@/lib/orchestrator/seats"),
    import("@/lib/suggestions/store"),
    import("@/lib/agent/registry"),
  ]);
  return {
    now: () => new Date(),
    board: operatorBoardRepresentation,
    facts: (body) => {
      const lookup = registry.readOnlyConversationLookupFromSnapshot(registry.agentRegistry().readOnlySnapshot());
      const canonical = (id: string) => (id.startsWith("conversation_") ? lookup.canonicalConversationId(id as `conversation_${string}`) : id);
      const operatorWroteAt = new Map<string, number>();
      for (const admission of readReplySuggestionsFile().admissions) {
        const at = Date.parse(admission.at);
        const id = canonical(admission.conversationId);
        if (Number.isFinite(at) && at > (operatorWroteAt.get(id) ?? Number.NEGATIVE_INFINITY)) operatorWroteAt.set(id, at);
      }
      const lanes = new Map(body.pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
      return {
        canonicalConversationId: canonical,
        retiredSeats: retiredSeatConversations(seats.readOrchestratorSeatFileOrNull(), canonical),
        operatorWroteAt,
        pipeline: (id) => lanes.get(id) ?? null,
      };
    },
    write: systemClearAttention,
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
export async function reconcileAttentionOnce(ports?: AttentionReconcilePorts): Promise<SystemAttentionClear[]> {
  const live = ports ?? await productionPorts();
  const body = await live.board();
  const facts = live.facts(body);
  const now = live.now();
  const clears = attentionSystemClears(body.files, now.getTime() / 1000, facts);
  if (!clears.length) return [];
  const written = live.write(clears, now);
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
      void pass()
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
