import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { withWaitCorrelation } from "@/lib/blockingWaits";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HeldDelivery, ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { DeliveryOperationOwner, RegistryFile } from "@/lib/agent/registry";
import { killedBackgroundWorkNotice } from "@/lib/pipelines/backgroundTasks";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransaction, withFileTransactionSync } from "@/lib/state/fileTransaction";

import { VIEWER_RELEASE_INTERRUPTION_OPENING, VIEWER_RESTART_INTERRUPTION_OPENING } from "./recoveryNotices";

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
export type InterruptionReason = "viewer-release" | "viewer-restart" | "account-guard";
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
  /** The transcript as the cut left it, for the message and the log.
      `backgroundTasks` names the harness background work a Claude turn was
      waiting on when a restart took it down with its process. */
  checkpoint: { lastEventKind: string | null; lastEventAt: number | null; backgroundTasks?: string[] };
  /** The orchestrator seat the conversation held when it was cut. */
  seat: { project: string; seatEpoch: number } | null;
  /** The pipeline stage attempt the conversation ran, when it ran one. Its
      controller retries the attempt, so such a record is never delivered. */
  stage?: InterruptionStage | null;
  state: InterruptionObligationState;
  operationId: string | null;
  attempts: number;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface InterruptionStage {
  pipelineId: string;
  stageId: string | null;
  attempt: number | null;
}

/** Why a cut of a pipeline stage's conversation is owed no continuation. */
export const STAGE_CUT_RESOLUTION = "a pipeline stage: its controller retries the attempt";

/** The pipeline stage a conversation runs, from its durable membership. */
export function interruptionStageOf(
  memberships: RegistryFile["memberships"],
  conversationId: string,
): InterruptionStage | null {
  const pipeline = (memberships[conversationId] ?? []).find((membership) => membership.kind === "pipeline");
  return pipeline ? { pipelineId: pipeline.containerId, stageId: pipeline.stageId, attempt: pipeline.round } : null;
}

export type InterruptionObligationInput = Omit<InterruptionObligation,
  "version" | "id" | "recordedAt" | "state" | "operationId" | "attempts" | "resolvedAt" | "resolution"> & {
  recordedAt?: string;
  /** A cut somebody else answers: recorded already discharged, with the reason,
      so the record names the cut and owes no continuation. */
  answeredBy?: string;
};

export interface InterruptionObligationStore {
  list(): InterruptionObligation[];
  record(input: InterruptionObligationInput): { obligation: InterruptionObligation; created: boolean };
  update(id: string, patch: Partial<Pick<InterruptionObligation,
    "state" | "operationId" | "attempts" | "resolvedAt" | "resolution">>): InterruptionObligation | null;
  /** Removes a restart record the evidence no longer supports, from the
      directory and from the pending journal, so nothing continues it, counts
      it or lists it. False when no record was there, or when a copy could not
      be removed: the caller reads the store again to tell which. */
  withdraw(id: string): boolean;
}

/** Why a review round's reviewer, cut by a restart, is owed no continuation. */
export const REVIEWER_CUT_RESOLUTION = "a review flow reviewer: its flow relaunches the round";

/**
 * Whether a restart record is still a proposal: written from evidence a
 * predecessor could still move, with nothing yet done about it. The row's
 * claim epoch is the one the record was written under, so no successor has
 * taken the row; and the record is still owed, or stands as the witness it was
 * recorded as. Every pass asks such a row again
 * (docs/design/restart-cut-recognition.md, "A cut is a proposal until the row
 * is taken").
 */
export function restartCutProposal(
  obligation: InterruptionObligation,
  row: { hostKey: string; claimEpoch: number },
): boolean {
  return obligation.reason === "viewer-restart" && obligation.seat === null && obligation.owner === null
    && obligation.hostKey === row.hostKey && obligation.claimEpoch === row.claimEpoch
    && (obligation.state === "owed" || (obligation.state === "discharged"
      && (obligation.resolution === STAGE_CUT_RESOLUTION || obligation.resolution === REVIEWER_CUT_RESOLUTION)));
}

const OBLIGATION_PREFIX = "interruption-continuation-";
/** Resolved records stay long enough to explain what happened, then go. */
const RESOLVED_RETENTION_MS = 7 * 24 * 3_600_000;
/** An import holds its claim for milliseconds; one untouched this long was
    left by an import that died. */
const ABANDONED_CLAIM_MS = 60_000;

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

/** Whether a client message id is an obligation's own key, which is what its
    continuation is delivered under. */
export function isInterruptionObligationId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(OBLIGATION_PREFIX) && value.length > OBLIGATION_PREFIX.length;
}

export function interruptionObligationUnresolved(obligation: InterruptionObligation): boolean {
  return obligation.state === "owed" || obligation.state === "submitted";
}

/** How a submitted continuation's delivery ended, as the registry records it. */
export interface SubmittedContinuationOutcome {
  state: "delivered" | "failed";
  /** When it arrived or failed; null when no record of that moment is left. */
  at: string | null;
  resolution: string;
  /** Neither the reservation nor its owner row is left: settled long enough ago
      that retention dropped both. */
  compacted: boolean;
}

/**
 * Reads a `submitted` obligation's outcome from its delivery reservation, the
 * one its id keys (#1835). Null while that delivery is still in flight. The
 * queue answers `submitted` on admission and says nothing more, so this is how
 * both startup and the pipeline engine learn the continuation arrived.
 */
export function submittedContinuationOutcome(
  obligation: Pick<InterruptionObligation, "id" | "conversationId" | "operationId">,
  snapshot: {
    heldDeliveries: Record<string, Pick<HeldDelivery, "clientMessageId" | "conversationId" | "state" | "deliveredAt" | "error">>;
    deliveryOperationOwners: Record<string, Pick<DeliveryOperationOwner, "terminalState" | "terminalReason" | "settledAt">>;
  },
  canonical: (conversationId: ViewerConversationId) => string,
): SubmittedContinuationOutcome | null {
  const reservation = Object.values(snapshot.heldDeliveries).find((delivery) =>
    delivery.clientMessageId === obligation.id
      && canonical(delivery.conversationId) === canonical(obligation.conversationId));
  const owner = obligation.operationId ? snapshot.deliveryOperationOwners[obligation.operationId] : undefined;
  const settled = reservation
    ? reservation.state === "delivered" || reservation.state === "failed" ? reservation.state : null
    : owner?.terminalState ?? "delivered";
  if (settled === null) return null;
  const at = reservation?.state === "delivered" ? reservation.deliveredAt ?? owner?.settledAt ?? null : owner?.settledAt ?? null;
  const resolution = settled === "failed"
    ? reservation?.error || owner?.terminalReason || "the continuation delivery failed"
    : reservation || owner ? "delivered" : "delivered; its settled reservation was compacted";
  return { state: settled, at, resolution, compacted: !reservation && !owner };
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
  /* Between two restart records of a conversation that is no seat, the id is
     the whole identity: each names its cut by the turn that was cut. */
  if (restartRecordOfNoSeat(existing) && restartRecordOfNoSeat(input)) return false;
  if (sameOwner(existing.owner, input.owner) && existing.turnRef === input.turnRef) return true;
  if (input.reason !== "viewer-restart") return false;
  /* A resolved cut was taken up by its continuation or by another message,
     and either started a turn of its own. A turn the row names other than the
     one this record cut is that turn, cut again before its transcript showed it. */
  if (!interruptionObligationUnresolved(existing) && input.turnRef !== null && existing.turnRef !== input.turnRef) return false;
  /* A boot-time severed turn is the same cut as any obligation recorded after
     that turn's last transcript event: the release happened after it. */
  const lastEventAt = input.checkpoint.lastEventAt;
  return lastEventAt === null
    ? interruptionObligationUnresolved(existing)
    : Date.parse(existing.recordedAt) >= lastEventAt;
}

function restartRecordOfNoSeat(record: Pick<InterruptionObligation, "reason" | "seat">): boolean {
  return record.reason === "viewer-restart" && !record.seat;
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
    so the successor sees the obligation either way.

    The incumbent may append while the successor imports, so an import first
    takes the journal by renaming it to a claim of its own and deletes only
    that claim: an append after the rename starts a fresh journal. Records the
    directory still refuses go back to the live journal. A claim left by an
    import that died midway is taken over once it has sat untouched long
    enough that no import can still be working on it. */
function createInterruptionObligationStore(
  directory: string,
  hooks: {
    /** Runs between reading a claimed journal and deleting it. */
    afterPendingRead?: () => void;
  } = {},
  admitted = false,
  guardOnly = false,
) {
  const fileFor = (id: string) => path.join(directory, `${id}.json`);
  const pendingFile = `${directory}.pending.jsonl`;
  const claimPrefix = `${path.basename(pendingFile)}.claim-`;
  let held = admitted;
  const transaction = <T>(operation: () => T): T => {
    if (held) return operation();
    return withFileTransactionSync(pendingFile, "interruption obligation import is busy", () => {
      held = true;
      try { return operation(); } finally { held = false; }
    });
  };
  const indexDirectory = accountGuardIndexDirectory(directory);
  const indexFile = (id: string) => path.join(indexDirectory, `${id}.json`);
  const conversationDirectory = (conversationId: string) => path.join(`${indexDirectory}.conversations`,
    crypto.createHash("sha256").update(conversationId).digest("hex"));
  const conversationIndexFile = (obligation: InterruptionObligation) =>
    path.join(conversationDirectory(obligation.conversationId), `${obligation.id}.json`);
  const cutIndexFile = (cut: InterruptionObligationInput) => cut.owner ? path.join(`${indexDirectory}.cuts`,
    `${crypto.createHash("sha256").update(JSON.stringify([cut.conversationId, cut.hostKey,
      cut.owner.pid, cut.owner.startIdentity, cut.turnRef])).digest("hex")}.json`) : null;
  const cutPointerId = (filename: string): string | null => {
    try {
      const id = JSON.parse(fs.readFileSync(filename, "utf8")).id;
      return typeof id === "string" && /^interruption-continuation-[0-9a-f]{32}$/.test(id) ? id : null;
    } catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const removeCutPointer = (cut: InterruptionObligation) => {
    const filename = cutIndexFile(cut);
    if (filename && cutPointerId(filename) === cut.id) fs.rmSync(filename, { force: true });
  };
  const indexedCut = (cut: InterruptionObligationInput): InterruptionObligation | null => {
    const filename = cutIndexFile(cut);
    if (!filename) return null;
    const id = cutPointerId(filename);
    if (!id) return null;
    const existing = read(fileFor(id)) ?? [...readPending(), ...activeClaims().flatMap(readJournal)].find(item => item.id === id);
    return existing?.reason === "account-guard" && interruptionObligationUnresolved(existing)
      && coversSameCut(existing, cut) ? existing : null;
  };
  // Publish a durable pointer before its owed record. A crash can leave an
  // extra pointer, but cannot hide work whose cut was acknowledged to a host.
  const prepareIndex = (obligation: InterruptionObligation): void => {
    if (obligation.reason !== "account-guard" || !interruptionObligationUnresolved(obligation)) return;
    for (const filename of [indexFile(obligation.id), conversationIndexFile(obligation)]) {
      if (!fs.existsSync(filename)) writeJsonDurably(filename, { id: obligation.id });
    }
    const cutFile = cutIndexFile(obligation);
    if (cutFile && cutPointerId(cutFile) !== obligation.id) {
      const existing = indexedCut(obligation);
      if (!existing || existing.recordedAt > obligation.recordedAt) writeJsonDurably(cutFile, { id: obligation.id });
    }
  };
  const write = (obligation: InterruptionObligation): void => {
    prepareIndex(obligation);
    writeJsonDurably(fileFor(obligation.id), obligation);
    if (obligation.reason === "account-guard") changedGuardObligations(directory);
    if (!interruptionObligationUnresolved(obligation)) {
      fs.rmSync(indexFile(obligation.id), { force: true });
      fs.rmSync(conversationIndexFile(obligation), { force: true });
      removeCutPointer(obligation);
    }
  };
  const readJournal = (filename: string): InterruptionObligation[] => {
    let text: string;
    try {
      text = fs.readFileSync(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.error("[interruption recovery] unreadable pending obligations", { filename, error });
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
  const readPending = () => readJournal(pendingFile);
  /* Renames `source` to a claim only this call holds; null when it is gone. */
  const claim = (source: string): string | null => {
    const claimed = path.join(path.dirname(pendingFile), `${claimPrefix}${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.renameSync(source, claimed);
      return claimed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[interruption recovery] pending obligations could not be claimed", { filename: source, error });
      }
      return null;
    }
  };
  const activeClaims = (): string[] => {
    let names: string[];
    try {
      names = fs.readdirSync(path.dirname(pendingFile));
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith(claimPrefix) && !name.endsWith(".lock")).map((name) =>
      path.join(path.dirname(pendingFile), name));
  };
  const abandonedClaims = (): string[] => {
    const now = Date.now();
    return activeClaims().filter((filename) => {
      try {
        /* A rename stamps ctime, so this is the age of the claim itself. */
        return now - fs.statSync(filename).ctimeMs > ABANDONED_CLAIM_MS;
      } catch {
        return false;
      }
    });
  };
  /* Moves pending records into the directory. Records still waiting remain
     in a claim or go back to the live journal. */
  const importPending = (): void => {
    const claims = transaction(() => [pendingFile, ...abandonedClaims()].flatMap((source) => claim(source) ?? []));
    if (claims.length === 0) return;
    claims.forEach(readJournal);
    hooks.afterPendingRead?.();
    /* Claim takeover, publication and withdrawal use one fence whose name
       survives every rename. No hook or awaited read holds it. */
    transaction(() => {
      for (const claimed of claims) {
        try {
          /* A withdrawal may have consumed this claim while the import was
             reading. Only the records still on disk can be published. */
          const waiting: InterruptionObligation[] = [];
          for (const obligation of readJournal(claimed)) {
            if (fs.existsSync(fileFor(obligation.id))) continue;
            if (waiting.some((record) => record.id === obligation.id)) continue;
            try {
              write(obligation);
            } catch (error) {
              console.error("[interruption recovery] pending obligation is not importable yet", { obligation: obligation.id, error });
              waiting.push(obligation);
            }
          }
          if (waiting.length > 0) {
            appendDurably(pendingFile, waiting.map((obligation) => `${JSON.stringify(obligation)}\n`).join(""));
          }
          fs.rmSync(claimed, { force: true });
        } catch (error) {
          /* The claim stays on disk; a later read takes it over. */
          console.error("[interruption recovery] pending obligations could not finish importing", { claimed, error });
        }
      }
    });
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
  const list = (page?: { after: string; limit: number; nextCursor: string | null; names?: string[] }): InterruptionObligation[] => {
    importPending();
    return transaction(() => {
      let names: string[];
      try {
        names = page?.names ?? fs.readdirSync(guardOnly ? indexDirectory : directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        names = [];
      }
      const now = Date.now();
      const obligations: InterruptionObligation[] = [];
      const canonicalIds = new Set<string>();
      const pending = [...readPending(), ...activeClaims().flatMap(readJournal)];
      // Include claimed or unimportable journal cuts in the same cursor order.
      const indexedNames = page?.names ?? (guardOnly ? [...new Set([...names, ...pending.filter(item => item.reason === "account-guard"
        && interruptionObligationUnresolved(item)).map(item => `${item.id}.json`)])] : names);
      const candidates = indexedNames.filter(name => name.startsWith(OBLIGATION_PREFIX) && name.endsWith(".json")
        && (!page || name > `${page.after}.json`)).sort();
      const selected = page ? candidates.slice(0, page.limit) : candidates;
      // Advance over inspected keys even when a record is temporarily unreadable.
      if (page) page.nextCursor = candidates.length > selected.length ? selected.at(-1)!.slice(0, -5) : null;
      for (const name of selected) {
        const obligation = read(path.join(directory, name));
        if (!obligation) {
          if (guardOnly && !pending.some(item => `${item.id}.json` === name)) {
            // A failed read can be temporary. Only a proven absent canonical
            // file makes this a pointer left before publication.
            try { fs.lstatSync(path.join(directory, name)); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              fs.rmSync(path.join(indexDirectory, name), { force: true });
            }
          }
          continue;
        }
        canonicalIds.add(obligation.id);
        const resolvedAt = obligation.resolvedAt ? Date.parse(obligation.resolvedAt) : NaN;
        if (guardOnly && (obligation.reason !== "account-guard" || !interruptionObligationUnresolved(obligation))) {
          fs.rmSync(path.join(indexDirectory, name), { force: true });
          fs.rmSync(conversationIndexFile(obligation), { force: true });
          removeCutPointer(obligation);
          continue;
        }
        if (!guardOnly && !interruptionObligationUnresolved(obligation) && now - resolvedAt > RESOLVED_RETENTION_MS) {
          fs.rmSync(path.join(directory, name), { force: true });
          continue;
        }
        if (guardOnly) prepareIndex(obligation);
        obligations.push(obligation);
      }
      /* A fresh claim is still part of the inventory. Reading it does not
         steal its import, and lets startup withdraw a disproved proposal.
         A canonical record wins even when it has already settled. */
      for (const obligation of pending) {
        if ((!guardOnly || obligation.reason === "account-guard" && interruptionObligationUnresolved(obligation))
          && (!page || selected.includes(`${obligation.id}.json`))
          && !canonicalIds.has(obligation.id)
          && !obligations.some((existing) => existing.id === obligation.id)) obligations.push(obligation);
      }
      if (page) return obligations.filter(item => item.id > page.after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, page.limit);
      return obligations.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
    });
  };
  return {
    list,
    importPending,
    prepareIndex,
    conversationPage(conversationId: string, names: string[]) {
      const records = list({ names, after: "", limit: 64, nextCursor: null });
      const kept = new Set(records.map(record => `${record.id}.json`));
      for (const name of names) if (!kept.has(name)) {
        try { fs.lstatSync(path.join(directory, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fs.rmSync(path.join(conversationDirectory(conversationId), name), { force: true }); }
      }
      return records.filter(record => record.conversationId === conversationId);
    },
    conversationDirectory,
    record(input: InterruptionObligationInput) {
      return transaction(() => {
        const id = interruptionObligationId(input);
        /* The id is the cut: a record already under it is this cut's, in
           whatever state it has reached, and is never written over. */
        const covering = guardOnly
          ? read(fileFor(id)) ?? indexedCut(input)
            ?? [...readPending(), ...activeClaims().flatMap(readJournal)].find(existing => existing.id === id)
          : list().find(existing => existing.id === id || coversSameCut(existing, input));
        if (covering) {
          /* A restart record found standing again after its engine wrote more
             says when it was last seen: the stage controller counts a cut only
             when the attempt's newest work precedes the record, and the deploy
             inventory lists by `recordedAt`. Its state and resolution stay. */
          const seenAt = input.checkpoint.lastEventAt;
          if (covering.id === id && restartRecordOfNoSeat(covering) && restartRecordOfNoSeat(input)
            && seenAt !== null && seenAt > (covering.checkpoint.lastEventAt ?? -Infinity)) {
            const moved: InterruptionObligation = {
              ...covering, checkpoint: input.checkpoint, recordedAt: input.recordedAt ?? new Date().toISOString(),
            };
            write(moved);
            return { obligation: moved, created: false };
          }
          return { obligation: covering, created: false };
        }
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
          ...(input.stage ? { stage: input.stage } : {}),
          state: input.answeredBy ? "discharged" : "owed",
          operationId: null,
          attempts: 0,
          resolvedAt: null,
          resolution: input.answeredBy ?? null,
        };
        if (input.answeredBy) obligation.resolvedAt = obligation.recordedAt;
        prepareIndex(obligation);
        try {
          write(obligation);
        } catch (first) {
          try {
            write(obligation);
          } catch (second) {
            console.error("[interruption recovery] obligation directory refused the record; appending it to the pending journal", {
              obligation: id, first, second,
            });
            appendDurably(pendingFile, `${JSON.stringify(obligation)}\n`);
            if (obligation.reason === "account-guard") changedGuardObligations(directory);
          }
        }
        return { obligation, created: true };
      });
    },
    withdraw(id: string) {
      try {
        return transaction(() => {
          /* Withdrawal consumes fresh claims too, so an importer paused
             before publication cannot restore this record. Other records
             go back to the live journal before any claim is removed. */
          const pendingClaim = claim(pendingFile);
          const claims = [...new Set([...(pendingClaim ? [pendingClaim] : []), ...activeClaims()])];
          const pending = claims.flatMap(readJournal);
          const kept = pending.filter((obligation) => obligation.id !== id);
          if (kept.length > 0) appendDurably(pendingFile, kept.map((obligation) => `${JSON.stringify(obligation)}\n`).join(""));
          for (const claimed of claims) fs.rmSync(claimed, { force: true });
          let removed = kept.length < pending.length;
          for (const current of pending) if (current.id === id) { fs.rmSync(conversationIndexFile(current), { force: true }); removeCutPointer(current); }
          if (fs.existsSync(fileFor(id))) {
            const current = read(fileFor(id));
            if (current) { fs.rmSync(conversationIndexFile(current), { force: true }); removeCutPointer(current); }
            fs.rmSync(fileFor(id), { force: true });
            removed = true;
          }
          fs.rmSync(indexFile(id), { force: true });
          if (removed) changedGuardObligations(directory);
          return removed;
        });
      } catch (error) {
        console.error("[interruption recovery] a withdrawn obligation could not be removed", { obligation: id, error });
        return false;
      }
    },
    update(id: string, patch: Parameters<InterruptionObligationStore["update"]>[1]) {
      return transaction(() => {
        const current = read(fileFor(id))
          ?? [...readPending(), ...activeClaims().flatMap(readJournal)].find((pending) => pending.id === id) ?? null;
        if (!current) return null;
        const next = { ...current, ...patch };
        if (JSON.stringify(current) === JSON.stringify(next)) return current;
        write(next);
        return next;
      });
    },
  };
}

export function interruptionObligationStore(
  directory: string,
  hooks: { afterPendingRead?: () => void } = {},
): InterruptionObligationStore {
  return createInterruptionObligationStore(directory, hooks);
}

const revisionOwner = process as typeof process & { __llvGuardObligationRevisions?: Map<string, number>; __llvGuardObligationSequence?: number };
const guardRevisions = revisionOwner.__llvGuardObligationRevisions ??= new Map<string, number>();
const GUARD_REVISION_LIMIT = 128;
export function accountGuardObligationRevision(directory: string): number { return guardRevisions.get(directory) ?? 0; }
function changedGuardObligations(directory: string): void {
  const revision = revisionOwner.__llvGuardObligationSequence = (revisionOwner.__llvGuardObligationSequence ?? 0) + 1;
  guardRevisions.delete(directory);
  guardRevisions.set(directory, revision);
  if (guardRevisions.size > GUARD_REVISION_LIMIT) guardRevisions.delete(guardRevisions.keys().next().value!);
}

function accountGuardIndexDirectory(directory: string): string {
  return `${directory}.account-guard-pending`;
}

/** Guard-only asynchronous admission shares the journal fence with release and
 * startup writers. The persisted pending index survives restarts; settled
 * history and its retention sweep never enter steady-state guard polls.
 * Existing installations backfill once through asynchronous directory reads.
 */
export function accountGuardObligationStore(directory: string) {
  const pendingFile = `${directory}.pending.jsonl`;
  const indexDirectory = accountGuardIndexDirectory(directory);
  const ready = path.join(indexDirectory, "ready");
  const store = createInterruptionObligationStore(directory, {}, true, true);
  const transaction = <T>(operation: () => T) => withViewerOperation("account-credit-guard.store", () =>
    withWaitCorrelation({ label: "account-credit-guard.obligations" }, () =>
      withFileTransaction(pendingFile, "account guard obligations are busy", operation)));
  const initialize = async () => {
    let indexed = false;
    try {
      const version = JSON.parse(fs.readFileSync(ready, "utf8")).version;
      if (version === 2) return;
      indexed = version === 1;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Import journal fallbacks under the same asynchronously acquired fence.
    await transaction(() => store.importPending());
    let entries: fs.Dir;
    // The existing pending index already excludes settled history. Upgrading
    // its conversation index never revisits every historical cut.
    try { entries = await fs.promises.opendir(indexed ? indexDirectory : directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await transaction(() => writeJsonDurably(ready, { version: 2 }));
      return;
    }
    for await (const entry of entries) {
      if (!entry.name.startsWith(OBLIGATION_PREFIX) || !entry.name.endsWith(".json")) continue;
      // Yield between legacy records, and re-read under admission so a peer's
      // settlement or withdrawal cannot be overwritten by the backfill.
      await new Promise<void>(resolve => setImmediate(resolve));
      await transaction(() => {
        const filename = path.join(directory, entry.name);
        let obligation: InterruptionObligation;
        try { obligation = JSON.parse(fs.readFileSync(filename, "utf8")); }
        catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (isObligation(obligation) && obligation.reason === "account-guard") store.prepareIndex(obligation);
        if (isObligation(obligation) && obligation.reason === "account-guard" && interruptionObligationUnresolved(obligation)) {
          writeJsonDurably(path.join(indexDirectory, `${obligation.id}.json`), { id: obligation.id });
        }
      });
    }
    await transaction(() => writeJsonDurably(ready, { version: 2 }));
  };
  // The watchdog keeps one bounded directory cursor across ticks. Reading all
  // index names on every page would still scale with retained pending work.
  let scan: fs.Dir | null = null;
  let expires: ReturnType<typeof setTimeout> | undefined;
  const closeScan = async () => {
    const current = scan;
    scan = null;
    if (expires) clearTimeout(expires);
    expires = undefined;
    await current?.close();
  };
  return {
    async scanPage() {
      await initialize();
      return withViewerOperation("account-credit-guard.store", async () => {
        if (expires) clearTimeout(expires);
        try {
          scan ??= await fs.promises.opendir(indexDirectory, { bufferSize: 64 });
          const names: string[] = [];
          let complete = false;
          for (let visited = 0; visited < 64; visited++) {
            const entry = await scan.read();
            if (!entry) { complete = true; break; }
            if (entry.name.startsWith(OBLIGATION_PREFIX) && entry.name.endsWith(".json")) names.push(entry.name);
          }
          const obligations = await transaction(() => store.list({ names, after: "", limit: 64, nextCursor: null }));
          if (complete) await closeScan();
          else {
            // A retired controller leaves no open directory behind. Expiry
            // restarts a later sweep; durable pending records remain indexed.
            expires = setTimeout(() => { void closeScan().catch(error => {
              console.error("[account-credit-guard] pending cursor close failed", error);
            }); }, 30_000);
            expires.unref?.();
          }
          return { obligations, nextCursor: complete ? null : "pending" };
        } catch (error) { await closeScan(); throw error; }
      });
    },
    async *conversationPages(conversationId: string) {
      let entries: fs.Dir;
      try { entries = await withViewerOperation("account-credit-guard.store", () =>
        fs.promises.opendir(store.conversationDirectory(conversationId), { bufferSize: 64 })); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      try {
        for (;;) {
          const { names, complete } = await withViewerOperation("account-credit-guard.store", async () => {
            const names: string[] = [];
            for (let visited = 0; visited < 64; visited++) {
              const entry = await entries.read();
              if (!entry) return { names, complete: true };
              if (entry.name.startsWith(OBLIGATION_PREFIX) && entry.name.endsWith(".json")) names.push(entry.name);
            }
            return { names, complete: false };
          });
          if (names.length) yield await transaction(() => store.conversationPage(conversationId, names));
          if (complete) break;
        }
      } finally { await entries.close(); }
    },
    async list() { await initialize(); return transaction(() => store.list()); },
    async page(after: string) {
      await initialize();
      return transaction(() => {
        const page = { after, limit: 64, nextCursor: null as string | null };
        const obligations = store.list(page);
        return { obligations, nextCursor: page.nextCursor };
      });
    },
    async record(input: InterruptionObligationInput) {
      if (input.reason !== "account-guard") throw new Error("account guard store requires a guard cut");
      await initialize();
      return transaction(() => store.record(input));
    },
    async update(id: string, patch: Parameters<InterruptionObligationStore["update"]>[1]) {
      return transaction(() => store.update(id, patch));
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
      VIEWER_RELEASE_INTERRUPTION_OPENING,
      turn,
      "Resume that turn.",
    ]
    : [
      VIEWER_RESTART_INTERRUPTION_OPENING,
      turn,
      "You were re-hosted automatically; resume that turn.",
    ];
  const background = obligation.checkpoint.backgroundTasks ?? [];
  const waiting = background.length === 0 ? [] : [killedBackgroundWorkNotice(background)];
  return [
    ...opening,
    ...waiting,
    "Inspect your transcript and your preserved work (files, worktree status, commits) to find where the turn stopped.",
    "Re-run any interrupted operation whose result you do not have; background or external work may or may not have survived, so check it before relying on it.",
    "Run long commands in the foreground.",
    "If you own a pipeline stage, finish it through stage_report.",
  ].join(" ");
}
