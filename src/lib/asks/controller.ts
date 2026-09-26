import { agentRegistry, readOnlyConversationLookupFromSnapshot, type RegistryFile } from "@/lib/agent/registry";
import { canonicalProject } from "@/lib/projects/aliases";
import { finalAssistantMessage } from "@/lib/scanner/lastAssistantMessage";
import { cachedFileScan, lastScannedFiles } from "@/lib/scanner/scanCache";
import type { FileEntry } from "@/lib/types";

import { classifyWithJev } from "./jev";
import { readAsksYouSettings, readOpenRouterApiKey } from "./settings";
import { mutateOperatorAsks, readOperatorAsks } from "./store";
import { ASK_MAX_AGE_MS, runAskSweep, type AskCandidate } from "./sweep";

/*
 * The "Asks you" clock (docs/research/attention-classifier.md §7). It runs in
 * the release that owns traffic, beside the seat tick and the sweeps, and
 * reads the scan the board reads: no transcript is scanned for it alone. A
 * sweep with the switch off reads one small file and stops.
 */

export const ASKS_SWEEP_INTERVAL_MS = 15_000;
/** How often a sweep asks the scan cache for a refresh, which is the cadence
    of the scan's own ordinary refresh: with no browser polling, the scan still
    moves. Other sweeps read the last scan as it stands, without a copy. */
const SCAN_NUDGE_MS = 300_000;
let lastNudge = 0;
const FIRST_SWEEP_DELAY_MS = 60_000;

/**
 * The conversations Delegatus knows, at their current generation. Left out:
 * engine-native subagents (their parent reads them), and pipeline stages and
 * review flows, whose turn ends in a verdict their lane or flow already
 * surfaces (a lane that needs the operator is its own needs-you reason).
 */
export function askCandidates(files: readonly FileEntry[], snapshot: RegistryFile): AskCandidate[] {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const candidates: AskCandidate[] = [];
  for (const file of files) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    if (file.root !== "claude-projects" && file.root !== "codex-sessions") continue;
    if (file.path.startsWith("spawn:")) continue;
    const conversation = lookup.conversationForPath(file.path);
    if (!conversation || conversation.engine !== file.engine || conversation.supersededBy) continue;
    if (conversation.generations.at(-1)?.path !== file.path) continue;
    const edge = snapshot.lineageEdges[conversation.id];
    if (edge?.source === "engine-native") continue;
    const memberships = snapshot.memberships[conversation.id] ?? [];
    if (memberships.some((membership) => membership.kind === "pipeline" || membership.kind === "flow")) continue;
    candidates.push({
      subject: conversation.id,
      conversationId: conversation.id,
      path: file.path,
      /* An operator who moved the card moved it; the log follows. */
      project: canonicalProject(conversation.projectOwnership?.project.trim() || file.project),
      role: conversation.agentRole ?? edge?.role ?? null,
      title: file.title?.trim() || null,
      working: file.activity === "live" || file.lastTurn?.endedAt === null,
      structuredAsk: Boolean(file.pendingQuestion || file.waitingInput),
      lastTurnStartedAt: file.lastTurn?.startedAt ?? null,
    });
  }
  return candidates;
}

async function releaseOwnsTraffic(): Promise<boolean> {
  try {
    const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerInstrumentation");
    return viewerReleaseOwnsTraffic();
  } catch {
    return true;
  }
}

/** The board learns of a new ask on its live transport, as it does of a new
    transcript. Best effort: the next poll carries it anyway. */
async function announceAsk(): Promise<void> {
  try {
    const [{ runtimeHostClient }, { publishFilesRevision }] = await Promise.all([
      import("@/lib/runtime/client"),
      import("@/lib/runtime/filesRevision"),
    ]);
    const client = runtimeHostClient();
    if (client) await publishFilesRevision(client);
  } catch {
    // the next poll carries it
  }
}

const inflight = new Set<string>();

export async function runAsksSweepOnce(): Promise<void> {
  const settings = readAsksYouSettings();
  if (!settings.enabled) return;
  const key = readOpenRouterApiKey();
  if (!key) return;
  if (!(await releaseOwnsTraffic())) return;
  if (Date.now() - lastNudge >= SCAN_NUDGE_MS) {
    lastNudge = Date.now();
    await cachedFileScan();
  }
  const enabledSince = settings.changedAt ? Date.parse(settings.changedAt) : null;
  const floor = Math.max(Date.now() - ASK_MAX_AGE_MS, enabledSince ?? 0);
  /* Only a conversation whose agent wrote lately can hold a message to send:
     a quiet sweep reads no registry and no transcript. */
  const recent = (lastScannedFiles() ?? []).filter((file) => typeof file.lastAssistantMessageAt === "number" && file.lastAssistantMessageAt >= floor);
  if (!recent.length) return;
  const byPath = new Map(recent.map((file) => [file.path, file] as const));
  const candidates = askCandidates(recent, agentRegistry().readOnlySnapshot());
  let announced = false;
  await runAskSweep({
    now: () => new Date(),
    settings: () => readAsksYouSettings(),
    enabledSince,
    apiKey: key,
    candidates,
    finalMessage: (candidate) => {
      const file = byPath.get(candidate.path);
      return file ? finalAssistantMessage(file) : null;
    },
    classify: (text, credential) => classifyWithJev(text, { apiKey: credential }),
    read: () => readOperatorAsks(),
    write: (mutation) => { mutateOperatorAsks(mutation); },
    onAsk: () => {
      if (announced) return;
      announced = true;
      void announceAsk();
    },
  }, inflight);
}

const host = globalThis as typeof globalThis & { __llvAsksSweepTimer?: ReturnType<typeof setTimeout> };

export function startAsksClassifier(ports: {
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  sweep?: () => Promise<unknown>;
} = {}): void {
  if (host.__llvAsksSweepTimer) return;
  const schedule = ports.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const sweep = ports.sweep ?? runAsksSweepOnce;
  const arm = (delayMs: number) => {
    const timer = schedule(() => {
      void sweep()
        /* The class of what failed, never a message: a provider error may
           quote the request. */
        .catch((error) => console.error("[asks you] sweep failed", error instanceof Error ? error.name : "unknown"))
        .finally(() => {
          if (host.__llvAsksSweepTimer === timer) arm(ASKS_SWEEP_INTERVAL_MS);
        });
    }, delayMs);
    timer.unref?.();
    host.__llvAsksSweepTimer = timer;
  };
  arm(FIRST_SWEEP_DELAY_MS);
}

/** Test seam: the timer is process-global. */
export function stopAsksClassifier(): void {
  if (host.__llvAsksSweepTimer) clearTimeout(host.__llvAsksSweepTimer);
  host.__llvAsksSweepTimer = undefined;
}
