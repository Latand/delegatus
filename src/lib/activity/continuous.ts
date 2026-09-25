import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";

import { conversationResolver } from "./conversationResolver";
import { readHostsConfig } from "./hostSources";
import { ingestTranscripts, type IngestResult, type IngestSource } from "./ingest";
import { pullHost, sshTransport, type PullResult } from "./pull";
import { ActivityStore } from "./store";

/*
 * The activity record keeping itself current, run by the process that already
 * indexes transcripts: after each pass of the transcript index over the
 * scanner's inventory, the ingest reads what the transcripts gained, and each
 * host listed with a pull whose interval has passed is pulled. The pull runs
 * beside the index queue and never holds it: a slow or unreachable host
 * delays nothing but its own next attempt.
 */

interface ContinuousState {
  pulling?: Promise<void>;
  lastIngest?: IngestResult & { durationMs: number; at: number };
  lastPulls: Record<string, PullResult & { at: number }>;
}

const host = globalThis as typeof globalThis & { __llvActivityRecord?: ContinuousState };

function state(): ContinuousState {
  return host.__llvActivityRecord ??= { lastPulls: {} };
}

function registrySnapshot(): RegistryFile | null {
  try {
    return agentRegistry().readOnlySnapshot();
  } catch {
    /* Unreadable: only the marker and the typed flag decide, and delivered
       sessions wait as unregistered. */
    return null;
  }
}

export async function recordActivityFromIndexFeed(
  sources: readonly IngestSource[],
  complete: boolean,
  listedAt: number,
): Promise<IngestResult> {
  const startedAt = Date.now();
  const store = ActivityStore.open();
  try {
    const result = await ingestTranscripts(sources, {
      complete,
      listedAt,
      store,
      resolver: () => conversationResolver(registrySnapshot()),
    });
    state().lastIngest = { ...result, durationMs: Date.now() - startedAt, at: startedAt };
    if (result.failures.length) {
      console.error(`[activity] ${result.failures.length} transcript(s) could not be read; a later pass retries them`);
    }
    return result;
  } finally {
    store.close();
    startDuePulls();
  }
}

/** Pull every listed host whose interval has passed, one at a time, in the
    background. */
export function startDuePulls(now: number = Date.now()): void {
  const current = state();
  if (current.pulling) return;
  let due: ReturnType<typeof readHostsConfig>["hosts"];
  try {
    due = readHostsConfig(statePath("activity")).hosts.filter((entry) => {
      if (!entry.pull) return false;
      const last = current.lastPulls[entry.id]?.at ?? 0;
      return now - last >= entry.pull.everyMin * 60_000;
    });
  } catch {
    return;
  }
  if (!due.length) return;
  const run = (async () => {
    for (const entry of due) {
      const store = ActivityStore.open();
      try {
        const result = await pullHost(store, entry.id, entry.pull!, sshTransport(entry.pull!));
        current.lastPulls[entry.id] = { ...result, at: Date.now() };
        if (result.error) console.error(`[activity] pull from ${entry.id}: ${result.error}`);
      } catch (error) {
        current.lastPulls[entry.id] = { ok: false, error: "unreachable", pages: 0, rows: 0, changed: 0, at: Date.now() };
        console.error(`[activity] pull from ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        store.close();
      }
    }
  })();
  current.pulling = run.finally(() => {
    delete current.pulling;
  });
}
