import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { writeJsonDurably } from "@/lib/state/durableJson";

/**
 * A conversation whose in-flight turn the Viewer cut, and the one continuation
 * the Viewer owes it for that cut (#1835).
 *
 * The obligation is written before the owner is released, so the promise to
 * resume the turn survives every process that could hold it in memory: the
 * incumbent that cut the turn exits, and the successor may itself be replaced
 * before it delivers. Its id is derived from what was cut — the canonical
 * conversation, the generation's host row, the owner process and its turn, and
 * the boundary that cut them — and doubles as the delivery's client message
 * id, so every producer and every retry lands on one durable reservation.
 *
 * States: `owed` until a continuation is admitted, `submitted` once the queue
 * accepted it without proof of arrival, `delivered` once a same-key replay
 * reports arrival, `discharged` when something other than the continuation
 * resumed or retired the turn, `failed` when the queue refused it for good.
 */
export type InterruptionReason = "viewer-release" | "viewer-restart";
export type InterruptionObligationState = "owed" | "submitted" | "delivered" | "discharged" | "failed";

export interface InterruptionOwner {
  pid: number;
  startIdentity: string | null;
}

export interface InterruptionObligation {
  version: 1;
  id: string;
  conversationId: ViewerConversationId;
  engine: "codex" | "claude";
  hostKey: string;
  path: string;
  owner: InterruptionOwner | null;
  claimEpoch: number | null;
  turnRef: string | null;
  boundary: string;
  reason: InterruptionReason;
  recordedAt: string;
  /** The transcript as the cut left it, for the message and the log. */
  checkpoint: { lastEventKind: string | null; lastEventAt: number | null };
  /** The orchestrator seat the conversation held when it was cut. */
  seat: { project: string; seatEpoch: number } | null;
  state: InterruptionObligationState;
  operationId: string | null;
  attempts: number;
  resolvedAt: string | null;
  resolution: string | null;
}

export type InterruptionObligationInput = Omit<InterruptionObligation,
  "version" | "id" | "recordedAt" | "state" | "operationId" | "attempts" | "resolvedAt" | "resolution"> & {
  recordedAt?: string;
};

export interface InterruptionObligationStore {
  list(): InterruptionObligation[];
  record(input: InterruptionObligationInput): { obligation: InterruptionObligation; created: boolean };
  update(id: string, patch: Partial<Pick<InterruptionObligation,
    "state" | "operationId" | "attempts" | "resolvedAt" | "resolution">>): InterruptionObligation | null;
}

const OBLIGATION_PREFIX = "interruption-continuation-";
/** Resolved records stay long enough to explain what happened, then go. */
const RESOLVED_RETENTION_MS = 7 * 24 * 3_600_000;

export function interruptionObligationId(input: Pick<InterruptionObligation,
  "conversationId" | "hostKey" | "owner" | "turnRef" | "boundary">): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    input.conversationId,
    input.hostKey,
    input.owner?.pid ?? null,
    input.owner?.startIdentity ?? null,
    input.turnRef,
    input.boundary,
  ])).digest("hex").slice(0, 32);
  return `${OBLIGATION_PREFIX}${digest}`;
}

export function interruptionObligationUnresolved(obligation: InterruptionObligation): boolean {
  return obligation.state === "owed" || obligation.state === "submitted";
}

function sameOwner(left: InterruptionOwner | null, right: InterruptionOwner | null): boolean {
  if (!left || !right) return false;
  return left.pid === right.pid && left.startIdentity === right.startIdentity;
}

/** Whether an existing obligation already covers the cut `input` describes.
    One cut can be seen twice — at release by the incumbent, and again at boot
    as a severed turn — and must still owe one continuation. */
function coversSameCut(existing: InterruptionObligation, input: InterruptionObligationInput): boolean {
  if (existing.conversationId !== input.conversationId || existing.hostKey !== input.hostKey) return false;
  if (sameOwner(existing.owner, input.owner) && existing.turnRef === input.turnRef) return true;
  if (input.reason !== "viewer-restart") return false;
  /* A boot-time severed turn is the same cut as any obligation recorded after
     that turn's last transcript event: the release happened after it. */
  const lastEventAt = input.checkpoint.lastEventAt;
  return lastEventAt === null
    ? interruptionObligationUnresolved(existing)
    : Date.parse(existing.recordedAt) >= lastEventAt;
}

function isObligation(value: unknown): value is InterruptionObligation {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InterruptionObligation>;
  return record.version === 1
    && typeof record.id === "string"
    && record.id.startsWith(OBLIGATION_PREFIX)
    && typeof record.conversationId === "string"
    && (record.engine === "codex" || record.engine === "claude")
    && typeof record.hostKey === "string"
    && typeof record.path === "string"
    && typeof record.recordedAt === "string"
    && typeof record.state === "string";
}

/** Appends one line and syncs it: the fallback a release writes when the
    obligation directory refuses the record. */
function appendDurably(filename: string, line: string): void {
  const descriptor = fs.openSync(filename, "a", 0o600);
  try {
    fs.writeSync(descriptor, line);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** One file per obligation, so the incumbent recording at release and the
    successor reading at boot never rewrite each other's records.

    A release that cannot write the record, even on a second try, appends it
    to a pending journal beside the directory instead. Every read merges that
    journal and imports its records into the directory once it accepts them,
    so the successor sees the obligation either way. */
export function interruptionObligationStore(directory: string): InterruptionObligationStore {
  const fileFor = (id: string) => path.join(directory, `${id}.json`);
  const pendingFile = `${directory}.pending.jsonl`;
  const readPending = (): InterruptionObligation[] => {
    let text: string;
    try {
      text = fs.readFileSync(pendingFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.error("[interruption recovery] unreadable pending obligations", { filename: pendingFile, error });
      return [];
    }
    return text.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line) as unknown;
        return isObligation(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  };
  /* Moves pending records into the directory; the journal goes only once
     every record in it has a file. Returns the records still waiting. */
  const importPending = (): InterruptionObligation[] => {
    const pending = readPending();
    if (pending.length === 0) return [];
    const stranded: InterruptionObligation[] = [];
    for (const obligation of pending) {
      if (fs.existsSync(fileFor(obligation.id))) continue;
      try {
        writeJsonDurably(fileFor(obligation.id), obligation);
      } catch (error) {
        console.error("[interruption recovery] pending obligation is not importable yet", { obligation: obligation.id, error });
        stranded.push(obligation);
      }
    }
    if (stranded.length === 0) fs.rmSync(pendingFile, { force: true });
    return stranded;
  };
  const read = (filename: string): InterruptionObligation | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
      return isObligation(parsed) ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.error("[interruption recovery] unreadable obligation record", { filename, error });
      return null;
    }
  };
  const list = (): InterruptionObligation[] => {
    const stranded = importPending();
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    const now = Date.now();
    const obligations: InterruptionObligation[] = [];
    for (const name of names.sort()) {
      if (!name.startsWith(OBLIGATION_PREFIX) || !name.endsWith(".json")) continue;
      const obligation = read(path.join(directory, name));
      if (!obligation) continue;
      const resolvedAt = obligation.resolvedAt ? Date.parse(obligation.resolvedAt) : NaN;
      if (!interruptionObligationUnresolved(obligation) && now - resolvedAt > RESOLVED_RETENTION_MS) {
        fs.rmSync(path.join(directory, name), { force: true });
        continue;
      }
      obligations.push(obligation);
    }
    for (const obligation of stranded) {
      if (!obligations.some((existing) => existing.id === obligation.id)) obligations.push(obligation);
    }
    return obligations.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  };
  return {
    list,
    record(input) {
      const covering = list().find((existing) => coversSameCut(existing, input));
      if (covering) return { obligation: covering, created: false };
      const id = interruptionObligationId(input);
      const obligation: InterruptionObligation = {
        version: 1,
        id,
        conversationId: input.conversationId,
        engine: input.engine,
        hostKey: input.hostKey,
        path: input.path,
        owner: input.owner,
        claimEpoch: input.claimEpoch,
        turnRef: input.turnRef,
        boundary: input.boundary,
        reason: input.reason,
        recordedAt: input.recordedAt ?? new Date().toISOString(),
        checkpoint: input.checkpoint,
        seat: input.seat,
        state: "owed",
        operationId: null,
        attempts: 0,
        resolvedAt: null,
        resolution: null,
      };
      try {
        writeJsonDurably(fileFor(id), obligation);
      } catch (first) {
        try {
          writeJsonDurably(fileFor(id), obligation);
        } catch (second) {
          console.error("[interruption recovery] obligation directory refused the record; appending it to the pending journal", {
            obligation: id, first, second,
          });
          appendDurably(pendingFile, `${JSON.stringify(obligation)}\n`);
        }
      }
      return { obligation, created: true };
    },
    update(id, patch) {
      const current = read(fileFor(id)) ?? readPending().find((pending) => pending.id === id) ?? null;
      if (!current) return null;
      const next = { ...current, ...patch };
      writeJsonDurably(fileFor(id), next);
      return next;
    },
  };
}

/** Obligations live beside the registry that names their conversations, so an
    isolated registry carries its own and production keeps them in state/. */
export function interruptionObligationDirectory(registryFilename: string): string {
  return path.join(path.dirname(registryFilename), "interruption-obligations");
}

/**
 * The one continuation a cut conversation receives.
 *
 * It tells the agent what happened and what it has to go on, without claiming
 * more than the Viewer knows: background or external work may have survived
 * the handover, so it asks for inspection before anything is re-run.
 */
export function interruptionContinuationText(obligation: InterruptionObligation): string {
  const at = obligation.checkpoint.lastEventAt === null
    ? "an unrecorded time"
    : new Date(obligation.checkpoint.lastEventAt).toISOString();
  const turn = `The interrupted turn's last transcript event is ${obligation.checkpoint.lastEventKind ?? "a record"} at ${at}.`;
  const opening = obligation.reason === "viewer-release"
    ? [
      "A Viewer deployment interrupted your turn while it was in flight: the Viewer that hosted you was replaced and this conversation was re-hosted by its successor.",
      turn,
      "Resume that turn.",
    ]
    : [
      "Viewer restarted and severed your structured host mid-turn.",
      turn,
      "You were re-hosted automatically; resume that turn.",
    ];
  return [
    ...opening,
    "Inspect your transcript and your preserved work (files, worktree status, commits) to find where the turn stopped.",
    "Re-run any interrupted operation whose result you do not have; background or external work may or may not have survived, so check it before relying on it.",
    "Run long commands in the foreground.",
    "If you own a pipeline stage, finish it through stage_report.",
  ].join(" ");
}
