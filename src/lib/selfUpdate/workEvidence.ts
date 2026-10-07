/* The work the Update surface shows beside the installation (#2594).

   Every snapshot used to await a whole `probeQuiet` before it could say which
   revision is installed, and on a long-lived installation that probe takes
   longer than any reader waits. This module is the thin layer between the
   surface and the probe:

   - `ObservedWork` runs at most ONE observational probe at a time and hands
     every reader that arrives meanwhile the same reading, so overlapping
     dialogs, tabs and polls never stack probes. The snapshot never waits for
     it: it says the work is `pending` until the first reading lands, and
     `unavailable` with the error when a reading failed.
   - `instrumentQuietPorts` times the probe's phases through its ports, so the
     dominant cost is named on a real installation without touching the
     probe's own rules. The same ports give the event loop back between the
     probe's steps, so a reading that takes seconds never holds up another
     caller's answer.

   What this module holds is for display only. A mutation (update admission,
   generation fencing, active-turn protection, the drain) calls `probeQuiet`
   on the service's own ports for fresh evidence, never this cache. */
import { pipelineRegistryHealth } from "@/lib/pipelines/store";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";

import { probeQuiet, type QuietBlockers, type QuietPorts } from "./quiet";
import type { ResumeWork, Snapshot, WorkEvidence, WorkPhases } from "./types";

/** A landed reading is shown again, without a new probe, for this long. */
export const WORK_EVIDENCE_REUSE_MS = 5_000;

/** How long a reading runs before it gives the event loop back. */
export const WORK_EVIDENCE_SLICE_MS = 10;

type Phase = "pipelines" | "flows" | "historicalReviewers" | "turns";

/* A synchronous port's answer read ahead of the probe, or what it threw. */
type Held<T> = { value: T } | { error: unknown };

interface Recorder {
  pipelines: readonly Pipeline[];
  flows: readonly Flow[];
  held: Partial<Record<"registryHealth" | "pipelines" | "flows", Held<unknown>>>;
  sessions: readonly { conversationId: string; turn?: string; host?: string }[];
  index: Map<string, Phase> | null;
  ms: Record<keyof Omit<WorkPhases, "totalMs" | "judgingMs" | "readings">, number>;
  readings: Record<Phase, number>;
}

function newRecorder(): Recorder {
  return { pipelines: [], flows: [], held: {}, sessions: [], index: null,
    ms: { journalMs: 0, pipelinesMs: 0, flowsMs: 0, historicalReviewersMs: 0, turnsMs: 0, otherMs: 0, yieldedMs: 0 },
    readings: { pipelines: 0, flows: 0, historicalReviewers: 0, turns: 0 } };
}

/* Which phase asked about an owner, by the identities `probeQuiet` gives
   them. A reading is memoized per probe, so it is counted once, under the
   most specific role it plays: a historical reviewer round, else a current
   flow owner, else a pipeline attempt, else a journal row. */
function ownerIndex(recorder: Recorder): Map<string, Phase> {
  const index = new Map<string, Phase>();
  const claim = (id: string | null | undefined, phase: Phase) => { if (id && !index.has(id)) index.set(id, phase); };
  for (const flow of recorder.flows) {
    const last = flow.rounds?.at(-1);
    for (const round of flow.rounds ?? []) if (round !== last) {
      claim(round.reviewerConversationId, "historicalReviewers");
      claim(`flow:${flow.id}:round:${round.n}:reviewer`, "historicalReviewers");
      claim(round.reviewerPath, "historicalReviewers");
    }
  }
  for (const flow of recorder.flows) {
    const last = flow.rounds?.at(-1);
    claim(last?.reviewerConversationId, "flows");
    if (last) claim(`flow:${flow.id}:round:${last.n}:reviewer`, "flows");
    claim(last?.reviewerPath, "flows");
    claim(flow.implementerConversationId ?? `flow:${flow.id}:implementer`, "flows");
    claim(flow.implementerPath, "flows");
  }
  for (const pipeline of recorder.pipelines) {
    for (const run of pipeline.runs ?? []) for (const attempt of run.attempts) {
      claim(attempt.conversationId, "pipelines");
      claim(`stage:${pipeline.id}:${run.stageId}:attempt:${attempt.n ?? 0}`, "pipelines");
      claim(attempt.agentPath, "pipelines");
    }
  }
  return index;
}

/** One turn of the event loop: timers, sockets and requests waiting run first. */
const nextTurn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * The service's ports with every call timed into the reading in progress.
 *
 * The wrapper is ONE object for the life of the reader: `probeQuiet` keeps the
 * age of each unresolved owner beside the ports object it is given, so a new
 * wrapper per probe would restart that bound on every observation. Readings
 * never overlap (`ObservedWork` runs one at a time), so one current recorder
 * is enough.
 *
 * The probe runs on the Viewer's own event loop, and most of its steps answer
 * from promises that are already settled, so nothing else would run until it
 * ends. Before each awaited port the wrapper gives the loop back once the
 * reading has run `sliceMs` since it last did, and `begin` reads the
 * synchronous ports the probe calls back to back (the registry health, the
 * pipelines, the flows) one per turn, ahead of it. A single synchronous port
 * still holds the loop for as long as it takes; nothing on one thread can
 * split it.
 */
export function instrumentQuietPorts(ports: QuietPorts, clock: () => number = () => performance.now(), sliceMs = WORK_EVIDENCE_SLICE_MS): {
  ports: QuietPorts;
  begin(): Promise<void>;
  finish(totalMs: number): WorkPhases;
} {
  let recorder = newRecorder();
  let sliceFrom = clock();
  const pace = async () => {
    if (clock() - sliceFrom < sliceMs) return;
    const started = clock();
    await nextTurn();
    sliceFrom = clock();
    recorder.ms.yieldedMs += sliceFrom - started;
  };
  const hold = <T>(read: () => T): Held<T> => { try { return { value: read() }; } catch (error) { return { error }; } };
  /* The answer read ahead, once; a second call reads afresh. */
  const replay = <T>(key: keyof Recorder["held"], read: () => T): T => {
    const held = recorder.held[key];
    if (!held) return read();
    delete recorder.held[key];
    if ("error" in held) throw held.error;
    return held.value as T;
  };
  const timed = <T>(bucket: keyof Recorder["ms"], read: () => T): T => {
    const started = clock();
    try { return read(); } finally { recorder.ms[bucket] += clock() - started; }
  };
  const timedAsync = async <T>(bucket: keyof Recorder["ms"], read: () => Promise<T>): Promise<T> => {
    const started = clock();
    try { return await read(); } finally { recorder.ms[bucket] += clock() - started; }
  };
  const readPipelines = () => timed("pipelinesMs", () => (recorder.pipelines = ports.pipelines()));
  const readFlows = () => timed("flowsMs", () => (recorder.flows = ports.flows?.() ?? []));
  const readRegistryHealth = () => timed("pipelinesMs", () => (ports.registryHealth ?? pipelineRegistryHealth)());
  const wrapped: QuietPorts = {
    ...ports,
    runtimeSnapshot: async () => {
      await pace();
      return timedAsync("journalMs", async () => {
        const runtime = await ports.runtimeSnapshot();
        recorder.sessions = runtime.sessions;
        return runtime;
      });
    },
    pipelines: () => replay("pipelines", readPipelines),
    flows: () => replay("flows", readFlows),
    registryHealth: () => replay("registryHealth", readRegistryHealth),
    presence: (now) => timed("otherMs", () => ports.presence(now)),
    ...(ports.reviewerProcess ? { reviewerProcess: (round) => timed("flowsMs", () => ports.reviewerProcess!(round)) } : {}),
    ...(ports.controllerBusyReason ? { controllerBusyReason: async () => { await pace(); return timedAsync("otherMs", () => ports.controllerBusyReason!()); } } : {}),
    ...(ports.controllerIdle ? { controllerIdle: async () => { await pace(); return timedAsync("otherMs", () => ports.controllerIdle!()); } } : {}),
    ...(ports.seats ? { seats: () => timed("otherMs", () => ports.seats!()) } : {}),
    ...(ports.memoryAvailableMb ? { memoryAvailableMb: () => timed("otherMs", () => ports.memoryAvailableMb!()) } : {}),
    ...(ports.turnLiveness ? {
      turnLiveness: async (session, probe) => {
        await pace();
        recorder.index ??= ownerIndex(recorder);
        const phase = recorder.index.get(session.conversationId)
          ?? (session.artifactPath ? recorder.index.get(session.artifactPath) : undefined) ?? "turns";
        recorder.readings[phase]++;
        const bucket = `${phase}Ms` as const;
        return timedAsync(bucket, () => ports.turnLiveness!(session, probe));
      },
    } : {}),
  };
  return {
    ports: wrapped,
    begin: async () => {
      recorder = newRecorder();
      for (const [key, read] of [["registryHealth", readRegistryHealth], ["pipelines", readPipelines], ["flows", readFlows]] as const) {
        const started = clock();
        await nextTurn();
        recorder.ms.yieldedMs += clock() - started;
        const held = hold<unknown>(read);
        recorder.held[key] = held;
        // The probe stops at the first of them that fails; so does this.
        if ("error" in held) break;
      }
      sliceFrom = clock();
    },
    finish: (totalMs) => {
      const measured = Object.values(recorder.ms).reduce((sum, value) => sum + value, 0);
      const round = (value: number) => Math.round(value * 10) / 10;
      return {
        totalMs: round(totalMs),
        ...Object.fromEntries(Object.entries(recorder.ms).map(([key, value]) => [key, round(value)])) as Recorder["ms"],
        judgingMs: round(Math.max(0, totalMs - measured)),
        readings: { ...recorder.readings },
      };
    },
  };
}

function resumeWork(blockers: QuietBlockers): ResumeWork {
  return { turns: blockers.turns, stages: blockers.stages, turnList: blockers.turnList, stageList: blockers.stageList, unreadable: blockers.unreadable };
}

/* Why a reading cannot say how much work runs, or null when it can.
   `probeQuiet` answers an unreadable journal or registry inside its
   blockers rather than by rejecting, and its counts then stop wherever the
   read failed; a registry record it could not parse is a pipeline it did not
   count. Either way the counts are a lower bound, and shown as counts they
   would read as the work there is. */
function incomplete(blockers: QuietBlockers): string | null {
  if (blockers.unreadable) return blockers.unreadable;
  const issues = blockers.registryIssues ?? [];
  if (!issues.length) return null;
  const named = issues.slice(0, 3).map((issue) => `${issue.collection}/${issue.id} (${issue.reason})`).join(", ");
  return `pipeline registry incomplete: ${named}${issues.length > 3 ? ` and ${issues.length - 3} more` : ""}`;
}

type Landed = { at: number; work: ResumeWork; phases: WorkPhases } | { at: number; error: string; phases: WorkPhases | null };

/**
 * One observational reading of the work in progress at a time, shared by
 * every reader. `observe` returns at once with what is known and starts a
 * reading only when none is in flight and the last one is older than the
 * reuse window. `landed` is called when a reading finishes either way, so a
 * live stream can publish it.
 */
export class ObservedWork {
  private readonly instrumented: ReturnType<typeof instrumentQuietPorts>;
  private running: Promise<void> | null = null;
  private latest: Landed | null = null;
  private pendingSince: number | null = null;
  /** How many probes this reader has started; a test counts stacking with it. */
  started = 0;

  constructor(
    ports: QuietPorts,
    private readonly now: () => number,
    private readonly landed: () => void,
    private readonly reuseMs = WORK_EVIDENCE_REUSE_MS,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.instrumented = instrumentQuietPorts(ports, clock);
  }

  observe(snapshot: Snapshot): { evidence: WorkEvidence; resumeWork?: ResumeWork } {
    const now = this.now();
    if (!this.running && (!this.latest || now - this.latest.at >= this.reuseMs)) this.start(snapshot, now);
    const latest = this.latest;
    if (!latest) {
      return { evidence: { state: "pending", since: new Date(this.pendingSince ?? now).toISOString(), at: null, error: null, phases: null } };
    }
    if ("error" in latest) {
      return { evidence: { state: "unavailable", since: null, at: new Date(latest.at).toISOString(), error: latest.error, phases: latest.phases } };
    }
    return { evidence: { state: "ready", since: null, at: new Date(latest.at).toISOString(), error: null, phases: latest.phases },
      resumeWork: latest.work };
  }

  /** The reading in flight, or nothing. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /* The reading is reserved here, so every reader that arrives meanwhile
     shares it, and begins on a later turn of the event loop: `probeQuiet`
     runs synchronous phases (the registry, the pipelines, the flows) before
     its first await, and inside this call they would run before the caller
     could answer with the installation. */
  private start(snapshot: Snapshot, now: number): void {
    this.started++;
    this.pendingSince ??= now;
    this.running = new Promise<void>((resolve) => { setTimeout(resolve, 0); }).then(() => this.read(snapshot, now));
  }

  private async read(snapshot: Snapshot, now: number): Promise<void> {
    const instrumented = this.instrumented;
    const startedAt = this.clock();
    try {
      await instrumented.begin();
      const { blockers } = await probeQuiet(snapshot, instrumented.ports, now);
      const phases = instrumented.finish(this.clock() - startedAt);
      const error = incomplete(blockers);
      this.latest = error === null ? { at: this.now(), work: resumeWork(blockers), phases } : { at: this.now(), error, phases };
    } catch (error) {
      this.latest = { at: this.now(), error: error instanceof Error ? error.message : String(error), phases: instrumented.finish(this.clock() - startedAt) };
    } finally {
      this.running = null;
      this.pendingSince = null;
      this.landed();
    }
  }
}
