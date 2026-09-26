import crypto from "node:crypto";
import fs from "node:fs";

import {
  endDeputy,
  readDeputies,
  recordDeputyNote,
  type DeputyOutcome,
  type OrchestratorDeputy,
} from "./deputies";
import { deputyResultLine, deputySeatNote, deputyWorkFromLines, DEPUTY_FINAL_TEXT_LIMIT } from "./deputyNote";
import type { OrchestratorSeat } from "./seats";

/* How a seat's deputy ends (docs/design/ghost-seat.md §5 "End", §4 rules 1, 6).
 *
 * One sweep, run every few seconds in the Viewer while any deputy is live and
 * once at boot. Each live record gets a verdict from durable and runtime facts:
 *
 *  - the seat moved (a rotation, a revocation): `seat-rotated`, host interrupted;
 *  - the record is past its expiry: `timeout`, host interrupted;
 *  - the deputy's turn is idle after it answered: `done`;
 *  - its host is gone before it answered: `host-died`.
 *
 * Ending releases the host, writes the touched ids and the collapsed line onto
 * the record (which is what collapses the block in the seat's feed), and
 * queues one note to the seat behind its running turn. Every step is
 * idempotent: the record ends once, and the note is keyed by the record.
 */

export const DEPUTY_SWEEP_INTERVAL_MS = 4_000;
/** A host that has not appeared this long after activation has died. */
export const DEPUTY_HOST_GRACE_MS = 90_000;

export interface DeputyRuntimeFacts {
  host: "registering" | "hosted" | "recovering" | "unhosted" | "conflict" | "dead" | null;
  turn: "unknown" | "idle" | "running" | "interrupt_requested" | null;
}

export type DeputyVerdict =
  | { kind: "wait" }
  | { kind: "end"; outcome: DeputyOutcome; interrupt: boolean };

/** Pure: what one live record's facts say should happen to it now. */
export function deputyVerdict(
  deputy: OrchestratorDeputy,
  facts: {
    nowMs: number;
    seat: Pick<OrchestratorSeat, "conversationId" | "seatEpoch"> | null;
    runtime: DeputyRuntimeFacts | null;
    /** The deputy wrote at least one assistant record of its own. */
    answered: boolean;
  },
): DeputyVerdict {
  if (deputy.state === "ended") return { kind: "wait" };
  if (!facts.seat || facts.seat.conversationId !== deputy.seatConversationId || facts.seat.seatEpoch !== deputy.seatEpoch) {
    return { kind: "end", outcome: "seat-rotated", interrupt: true };
  }
  const expires = Date.parse(deputy.expiresAt);
  if (!Number.isFinite(expires) || facts.nowMs >= expires) return { kind: "end", outcome: "timeout", interrupt: true };
  if (deputy.state !== "active") return { kind: "wait" };
  const runtime = facts.runtime;
  if (runtime?.turn === "idle" && facts.answered && (runtime.host === "hosted" || runtime.host === "unhosted" || runtime.host === "dead")) {
    return { kind: "end", outcome: "done", interrupt: false };
  }
  const gone = runtime?.host === "dead" || runtime?.host === "unhosted";
  const activated = deputy.activatedAt ? Date.parse(deputy.activatedAt) : Number.NaN;
  const pastGrace = Number.isFinite(activated) && facts.nowMs - activated >= DEPUTY_HOST_GRACE_MS;
  if (gone && facts.answered) return { kind: "end", outcome: "done", interrupt: false };
  if ((gone || !runtime) && pastGrace) return { kind: "end", outcome: "host-died", interrupt: false };
  return { kind: "wait" };
}

export interface DeputySweepPorts {
  now(): Date;
  deputies(): OrchestratorDeputy[];
  activeSeat(project: string): OrchestratorSeat | null;
  runtime(deputy: OrchestratorDeputy): Promise<DeputyRuntimeFacts | null>;
  /** The deputy's own transcript lines, after the fork prefix. Null when the
      transcript is gone. */
  ownLines(deputy: OrchestratorDeputy): string[] | null;
  interrupt(deputy: OrchestratorDeputy): Promise<void>;
  release(deputy: OrchestratorDeputy): Promise<void>;
  noteSeat(input: { deputy: OrchestratorDeputy; clientMessageId: string; text: string }): Promise<string>;
  end?: typeof endDeputy;
  recordNote?: typeof recordDeputyNote;
}

/** The note's delivery request. `queue` is the whole point: the note lands as
    the seat's NEXT turn, after the running one, which it never interrupts
    (docs/design/ghost-seat.md §4). */
export function deputySeatNoteRequest(deputy: Pick<OrchestratorDeputy, "seatPath" | "seatConversationId">, clientMessageId: string, text: string) {
  return {
    path: deputy.seatPath ?? "",
    conversationId: deputy.seatConversationId,
    clientMessageId,
    text,
    policy: "queue" as const,
    origin: { kind: "agent" as const, role: "orchestrator" },
  };
}

export function deputyNoteKey(askId: string): string {
  return `deputy_note_${crypto.createHash("sha256").update(askId).digest("hex").slice(0, 40)}`;
}

function hasAssistantRecord(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes('"type":"assistant"') || line.includes('"type": "assistant"'));
}

/** End one record and tell the seat. Safe to call again: nothing repeats. */
export async function finishDeputy(deputy: OrchestratorDeputy, outcome: DeputyOutcome, interrupt: boolean, ports: DeputySweepPorts): Promise<OrchestratorDeputy | null> {
  const end = ports.end ?? endDeputy;
  const recordNote = ports.recordNote ?? recordDeputyNote;
  if (interrupt) {
    try { await ports.interrupt(deputy); } catch { /* the release below still runs */ }
  }
  try { await ports.release(deputy); } catch { /* a host that is already gone needs no release */ }
  const lines = ports.ownLines(deputy) ?? [];
  const work = deputyWorkFromLines(lines);
  const finalText = work.finalText.length > DEPUTY_FINAL_TEXT_LIMIT * 4 ? work.finalText.slice(0, DEPUTY_FINAL_TEXT_LIMIT * 4) : work.finalText;
  const ended = end(deputy.askId, {
    outcome,
    now: ports.now(),
    touched: work.touched,
    result: { line: deputyResultLine(finalText), finalText },
  }) ?? deputy;
  /* A deputy that never started has nothing to report; its refusal already
     reached whoever asked. */
  if (ended.note || !ended.deputyConversationId) return ended;
  const clientMessageId = deputyNoteKey(deputy.askId);
  let answer: string;
  try {
    answer = await ports.noteSeat({ deputy: ended, clientMessageId, text: deputySeatNote(ended, finalText) });
  } catch (error) {
    /* The child ledger carries the final message to the seat's next wake
       (#1881); a note that did not land is retried on the next sweep. */
    console.error("[deputy] seat note failed", error instanceof Error ? error.name : "unknown");
    return ended;
  }
  return recordNote(deputy.askId, { clientMessageId, sentAt: ports.now().toISOString(), outcome: answer }) ?? ended;
}

/** One pass over every record. Returns whether any deputy is still live. */
export async function sweepDeputies(ports: DeputySweepPorts): Promise<boolean> {
  let live = false;
  for (const deputy of ports.deputies()) {
    if (deputy.state === "ended") {
      /* An ended record whose note never landed is retried here. */
      if (!deputy.note && deputy.outcome && deputy.outcome !== "failed" && deputy.deputyConversationId) {
        await finishDeputy(deputy, deputy.outcome, false, ports);
      }
      continue;
    }
    const nowMs = ports.now().getTime();
    const lines = deputy.state === "active" ? ports.ownLines(deputy) : null;
    let runtime: DeputyRuntimeFacts | null = null;
    if (deputy.state === "active") {
      try { runtime = await ports.runtime(deputy); } catch { runtime = null; }
    }
    const verdict = deputyVerdict(deputy, {
      nowMs,
      seat: ports.activeSeat(deputy.project),
      runtime,
      answered: lines ? hasAssistantRecord(lines) : false,
    });
    if (verdict.kind === "wait") {
      live = true;
      continue;
    }
    await finishDeputy(deputy, verdict.outcome, verdict.interrupt, ports);
  }
  return live;
}

/** The deputy's own lines: everything after the records the fork copied. */
export function readDeputyOwnLines(deputy: Pick<OrchestratorDeputy, "artifactPath" | "forkRecordCount">): string[] | null {
  if (!deputy.artifactPath || deputy.forkRecordCount === null) return null;
  let text: string;
  try {
    text = fs.readFileSync(deputy.artifactPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(deputy.forkRecordCount);
}

type SweepState = { timer: ReturnType<typeof setInterval> | null; running: boolean };
const sweepState: SweepState = ((globalThis as unknown as { __llvDeputySweep?: SweepState }).__llvDeputySweep ??= { timer: null, running: false });

/**
 * Keep the sweep running while any deputy is live; idempotent per process.
 * Started by the ask route and at Viewer boot. It stops itself when nothing is
 * live, so an install that never asks in parallel pays for one read at boot.
 */
export function startDeputySweep(loadPorts: () => Promise<DeputySweepPorts> = productionDeputySweepPorts): void {
  if (sweepState.timer) return;
  const tick = async () => {
    if (sweepState.running) return;
    sweepState.running = true;
    try {
      const live = await sweepDeputies(await loadPorts());
      if (!live && sweepState.timer) {
        clearInterval(sweepState.timer);
        sweepState.timer = null;
      }
    } catch (error) {
      console.error("[deputy] sweep failed", error instanceof Error ? error.name : "unknown");
    } finally {
      sweepState.running = false;
    }
  };
  sweepState.timer = setInterval(() => { void tick(); }, DEPUTY_SWEEP_INTERVAL_MS);
  sweepState.timer.unref?.();
  void tick();
}

async function productionDeputySweepPorts(): Promise<DeputySweepPorts> {
  const [{ orchestratorSeatFor }, { runtimeHostClient, readRuntimeSession }, { applyConversationAction }, { enqueueStructuredMessage }] = await Promise.all([
    import("./seats"),
    import("@/lib/runtime/client"),
    import("@/lib/conversation/actions"),
    import("@/lib/runtime/structuredMessageDelivery"),
  ]);
  const action = async (deputy: OrchestratorDeputy, name: "interrupt" | "kill") => {
    if (!deputy.deputyConversationId) return;
    await applyConversationAction({ conversationId: deputy.deputyConversationId, transcriptPath: deputy.artifactPath ?? "", action: name, operationId: `deputy_${name}_${deputy.askId}` });
  };
  return {
    now: () => new Date(),
    deputies: readDeputies,
    activeSeat: (project) => orchestratorSeatFor(project).active,
    runtime: async (deputy) => {
      const client = runtimeHostClient();
      if (!client || !deputy.deputyConversationId) return null;
      const session = await readRuntimeSession(client, { conversationId: deputy.deputyConversationId });
      return session ? { host: session.host, turn: session.turn } : null;
    },
    ownLines: readDeputyOwnLines,
    interrupt: (deputy) => action(deputy, "interrupt"),
    release: (deputy) => action(deputy, "kill"),
    noteSeat: async ({ deputy, clientMessageId, text }) => {
      const result = await enqueueStructuredMessage(deputySeatNoteRequest(deputy, clientMessageId, text));
      if (!result) throw new Error("structured delivery is unavailable");
      if (!result.ok) throw new Error(result.error);
      return result.outcome;
    },
  };
}
