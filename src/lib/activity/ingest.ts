import fs from "node:fs";

import path from "node:path";
import { waitForStateLock } from "@/lib/state/lockWait";
import { statePath } from "@/lib/configDir";
import { readActivitySettings } from "./settings";
import { maintainUsage } from "./tokenStore";
import { activityOperation } from "./operation";

import type { ExclusionReason } from "./humanInput";
import { codexSessionKind } from "./humanInput";
import { UNREGISTERED_ROLE } from "./method";
import { LOCAL_HOST_KEY, type ActivityStore, type TurnOwner } from "./store";
import {
  classifyRecords,
  transcriptContext,
  TranscriptLineReader,
  type ConversationResolution,
  type TranscriptFacts,
} from "./transcriptExport";

/*
 * This host's operator input, recorded as its transcripts are written
 * (docs/design/activity-dashboard.md, "Continuous ingest"). The transcript
 * index runs a pass over the scanner's inventory; this runs right after it
 * over the same inventory and reads only the bytes a transcript gained since
 * its cursor. The first pass has no cursors, so it reads every transcript on
 * the host whole: that is the one-time backfill of history.
 *
 * Each transcript's new lines go through the exporter's own reader and
 * classifier, so a record the export would count is the record stored here,
 * and the rows, the exclusion counts and the advanced cursor commit together.
 */

/** A transcript the scanner lists. */
export interface IngestSource {
  path: string;
  engine: string;
  size: number;
  mtimeMs: number;
}

export interface IngestOptions {
  /** Whether the inventory names every transcript on the host. Only a
      complete pass can say the host was read up to a time. */
  complete: boolean;
  /** When the listing began: a transcript created after it is not in the
      inventory, so nothing after it is claimed as read. */
  listedAt: number;
  store: ActivityStore;
  /** Built at most once per pass, and only when a transcript has new lines. */
  resolver(): (facts: TranscriptFacts) => ConversationResolution;
  now?(): number;
  /** How long an unregistered Delegatus transcript waits for the registry to
      name it before it is judged as it stands. */
  holdMs?: number;
  batchBytes?: number;
  /** Bytes one pass reads at most; the rest waits for the next pass. */
  budgetBytes?: number;
}

export interface IngestResult {
  filesRead: number;
  filesSkipped: number;
  filesHeld: number;
  /** Transcripts left for a later pass by the budget. */
  filesDeferred: number;
  bytesRead: number;
  inputsWritten: number;
  turnsRead: number;
  failures: Array<{ path: string; error: string }>;
  /** The time up to which this host now counts as read, when the pass moved it. */
  coveredUntil: number | null;
}

/** A spawn's transcript can appear before the registry names it; judged
    then, its operator input would be excluded for good. */
export const UNREGISTERED_HOLD_MS = 15 * 60_000;
const READ_CHUNK_BYTES = 1 << 20;
/** One transcript is read and committed in pieces of about this size, so a
    multi-gigabyte rollout never holds more than one piece in memory, and a
    backfill cut short resumes inside it. */
export const INGEST_BATCH_BYTES = 32 << 20;
/** What one pass reads at most. The first pass on a host with years of
    history would otherwise parse gigabytes in one go inside the Viewer; this
    spreads that backfill over successive index passes, newest first, and a
    pass that stops at its budget moves no read span. */
export const INGEST_PASS_BUDGET_BYTES = 1 << 30;
const NEWLINE = 0x0a;

interface ReadPiece {
  reader: TranscriptLineReader;
  /** The offset after the last complete line. */
  offset: number;
  bytes: number;
  /** Whether the read reached the end of the file. */
  eof: boolean;
}

/** Complete lines from `offset` to the end of the file. A last line with no
    newline is still being written and stays for the next pass. */
async function readFrom(file: string, offset: number, reader: TranscriptLineReader, maxBytes: number, chunk: Buffer, end = Infinity): Promise<ReadPiece> {
  const handle = await fs.promises.open(file, "r");
  let position = offset;
  let consumed = offset;
  let pending: Buffer[] = [];
  let bytes = 0;
  let eof = false;
  try {
    while (true) {
      /* Past the piece's size, stop at the last whole line read. */
      if (bytes >= maxBytes) break;
      const length = Math.min(chunk.length, end - position, bytes < maxBytes ? maxBytes - bytes : chunk.length);
      if (length <= 0) { eof = true; break; }
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) {
        eof = true;
        break;
      }
      bytes += bytesRead;
      position += bytesRead;
      const view = chunk.subarray(0, bytesRead);
      let start = 0;
      while (true) {
        const newline = view.indexOf(NEWLINE, start);
        if (newline < 0) break;
        const tail = view.subarray(start, newline);
        const line = pending.length ? Buffer.concat([...pending, tail]) : tail;
        pending = [];
        if (line.length) reader.acceptBytes(line);
        consumed += line.length + 1;
        start = newline + 1;
      }
      if (start < view.length) pending.push(Buffer.from(view.subarray(start)));
      await yieldToEventLoop();
      if (position >= end) { eof = true; break; }
    }
  } finally {
    await handle.close();
  }
  return { reader, offset: consumed, bytes, eof };
}

/** A Delegatus-hosted transcript the registry does not name yet. */
function awaitsRegistry(facts: TranscriptFacts, resolution: ConversationResolution): boolean {
  if (resolution.registered) return false;
  return facts.engine === "claude"
    ? facts.entrypoint !== null && facts.entrypoint !== "cli"
    : codexSessionKind(facts.sessionMeta) === "delegatus";
}

/**
 * Whose turns a transcript's turns are. Copies of one session in two stores
 * share its file name, so an unregistered one is still one conversation. A
 * Codex subagent thread is its own agent working beside its parent: the
 * registry can name the parent's conversation for its rollout, and its turns
 * joined into the parent's would count parallel work once. It keeps the
 * parent's project, role and stage (the resolution's) and takes its own key.
 */
export function turnOwnerConversation(file: string, facts: TranscriptFacts, resolution: ConversationResolution): string {
  const session = `session:${path.basename(file, ".jsonl")}`;
  if (!resolution.conversation) return session;
  return facts.engine === "codex" && codexSessionKind(facts.sessionMeta) === "subagent"
    ? `${resolution.conversation}\0${session}`
    : resolution.conversation;
}

function earliestOf(records: ReadonlyArray<{ at: number }>): number | null {
  let earliest: number | null = null;
  for (const rec of records) if (earliest === null || rec.at < earliest) earliest = rec.at;
  return earliest;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function ingestTranscripts(sources: readonly IngestSource[], options: IngestOptions): Promise<IngestResult> {
  const now = options.now ?? Date.now;
  const passStart = now();
  const holdMs = options.holdMs ?? UNREGISTERED_HOLD_MS;
  const store = options.store;
  const result: IngestResult = { filesRead: 0, filesSkipped: 0, filesHeld: 0, filesDeferred: 0, bytesRead: 0, inputsWritten: 0, turnsRead: 0, failures: [], coveredUntil: null };
  let resolve: ((facts: TranscriptFacts) => ConversationResolution) | null = null;
  /** The earliest record a held transcript has not had stored. */
  let heldFrom = Infinity;
  const listed = new Set<string>();
  const budget = options.budgetBytes ?? INGEST_PASS_BUDGET_BYTES;
  /* One read buffer for the pass: a buffer per piece is memory outside the
     heap that only a later collection returns. */
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  /* Newest first: a backfill spread over passes fills the recent days first. */
  const ordered = [...sources].sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const source of ordered) {
    if (source.engine !== "claude" && source.engine !== "codex") continue;
    listed.add(source.path);
    if (result.bytesRead >= budget) {
      const waiting = store.fileCursor(source.path);
      if (!waiting || waiting.size !== source.size || waiting.mtimeMs !== source.mtimeMs || waiting.usageOffset !== waiting.offset) result.filesDeferred += 1;
      continue;
    }
    const cursor = store.fileCursor(source.path);
    if (cursor && cursor.size === source.size && cursor.mtimeMs === source.mtimeMs && cursor.usageOffset === cursor.offset) {
      result.filesSkipped += 1;
      continue;
    }
    try {
      /* A mixed-version writer can advance the old cursor past a newer token
         cursor, or leave the token cursor beyond a rewritten file. Replay both
         readers from zero; durable response dedupe makes the token replay safe. */
      const storedUsageOffset = cursor?.usageOffset ?? 0;
      const tokenCursorAhead = cursor !== null && (storedUsageOffset > cursor.offset || storedUsageOffset > source.size);
      const resume = cursor && source.size >= cursor.offset && !tokenCursorAhead ? cursor : null;
      let offset = resume?.offset ?? 0;
      let facts = resume?.facts;
      let usageOffset = resume?.usageOffset ?? 0;
      let usageFacts = resume?.usageFacts;
      if (facts && usageOffset === offset && usageFacts?.usage) facts = { ...facts, usage: usageFacts.usage };
      let prompted = resume?.prompted ?? false;
      let resolution: ConversationResolution | null = null;
      result.filesRead += 1;
      while (true) {
        const backfill = usageOffset < offset;
        const reader = new TranscriptLineReader(backfill ? usageFacts : facts, !backfill, backfill);
        const pieceBytes=Math.min(Math.max(options.batchBytes??INGEST_BATCH_BYTES,reader.state.readBytesHint??0),Math.max(1,budget-result.bytesRead));
        const read = () => readFrom(source.path, backfill ? usageOffset : offset, reader, pieceBytes,
          backfill ? chunk.subarray(0, 64 << 10) : chunk, backfill ? offset : source.size);
        const piece = await (backfill ? activityOperation("activity.usage-backfill", read) : read());
        if(piece.offset===(backfill?usageOffset:offset)&&!piece.eof) reader.state.readBytesHint=Math.min(budget,Math.max(pieceBytes*2,chunk.length));
        else delete reader.state.readBytesHint;
        result.bytesRead += piece.bytes;
        const transcript = piece.reader.facts(source.path);
        const records = piece.reader.records;
        let candidates: ReturnType<typeof classifyRecords>["candidates"] = [];
        let excluded: Partial<Record<ExclusionReason, number>> = {};
        /* Every turn this piece touched: those that ended, and the one still
           open, stored as far as it has run. */
        const open = piece.reader.state.turn;
        const turns = [...piece.reader.turns, ...(open && open.end > open.start ? [{ ...open }] : [])];
        let owner: TurnOwner | null = null;
        if (transcript && (records.length || turns.length || piece.reader.usage?.records.length || piece.reader.usage?.malformed)) {
          resolve ??= options.resolver();
          resolution = resolve(transcript);
          if ((records.length || piece.reader.usage?.records.length) && awaitsRegistry(transcript, resolution) && passStart - source.mtimeMs < holdMs) {
            result.filesHeld += 1;
            heldFrom = Math.min(heldFrom, earliestOf([...records, ...(piece.reader.usage?.records ?? [])])!);
            break;
          }
          if (records.length) {
            const classified = classifyRecords(records, transcriptContext("local", transcript, resolution), prompted);
            candidates = classified.candidates;
            excluded = classified.excluded;
            prompted = classified.prompted;
          }
          owner = {
            conversation: turnOwnerConversation(source.path, transcript, resolution),
            project: resolution.project,
            engine: transcript.engine,
            role: resolution.agent?.role ?? UNREGISTERED_ROLE,
            pipelineId: resolution.agent?.pipelineId ?? null,
            stageId: resolution.agent?.stageId ?? null,
          };
          result.turnsRead += turns.length;
        }
        usageOffset = piece.offset;
        usageFacts = piece.reader.state;
        result.inputsWritten += await waitForStateLock("activity.commit", () => store.commitFile(
          source.path,
          /* A piece short of the end keeps no size, so the next pass reads on. */
          { offset: backfill ? offset : piece.offset, size: backfill ? resume!.size : piece.eof ? source.size : -1,
            mtimeMs: source.mtimeMs, facts: backfill ? facts! : piece.reader.state, prompted, usageOffset, usageFacts },
          candidates,
          excluded,
          earliestOf(records),
          owner && turns.length ? { owner, turns } : null,
          resolution?.mode === "team",
          owner && piece.reader.usage ? { owner, records: piece.reader.usage.records,
            attribution: resolution?.usageAttribution ?? (() => ({ account: "unknown", member: resolution?.mode === "team" ? "unattributed" : "operator", model: null, tier: null })),
            malformed: piece.reader.usage.malformed, now: passStart } : null,
        ));
        if (!backfill) { facts = piece.reader.state; offset = piece.offset; }
        else if (usageOffset === offset) facts = { ...facts!, usage: usageFacts.usage };
        if (!backfill && piece.eof) break;
        if (backfill && piece.eof && usageOffset < offset) throw new Error("token backfill cursor is not at a line boundary");
        if (result.bytesRead >= budget) {
          result.filesDeferred += 1;
          break;
        }
        await yieldToEventLoop();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      /* A transcript deleted since the listing has nothing left to read. */
      if (code === "ENOENT") continue;
      result.failures.push({ path: source.path, error: error instanceof Error ? error.message : String(error) });
    }
    await yieldToEventLoop();
  }

  const state = store.hostState(LOCAL_HOST_KEY);
  const patch: Parameters<ActivityStore["setHostState"]>[1] = { attemptAt: now() };
  if (options.complete) {
    for (const file of store.cursorPaths()) if (!listed.has(file)) await waitForStateLock("activity.forget", () => store.transaction(() => store.forgetFile(file)));
  }
  if (options.complete && !result.failures.length && !result.filesDeferred) {
    const until = Math.min(passStart, options.listedAt, heldFrom - 1);
    result.coveredUntil = until;
    patch.coveredUntil = until;
    patch.readAt = now();
    patch.error = null;
    /* A host with no user record at all is read from its first pass on. */
    if (state?.coveredFrom == null) patch.coveredFrom = until;
  } else if (result.failures.length) {
    patch.error = "unreadable";
  }
  await waitForStateLock("activity.host", () => store.transaction(() => store.setHostState(LOCAL_HOST_KEY, patch)));
  await waitForStateLock("activity.usage-maintenance", () => store.transaction(() => {
    maintainUsage(store.db, passStart, readActivitySettings(statePath("activity")).tz);
    let pending = 0;
    for (const source of ordered) {
      if (source.engine !== "claude" && source.engine !== "codex") continue;
      pending += Math.max(0, source.size - (store.fileCursor(source.path)?.usageOffset ?? 0));
    }
    store.db.query("UPDATE usage_meta SET pending_bytes=?, complete=?, version=version+1 WHERE singleton=1 AND (pending_bytes != ? OR complete != ?)")
      .run(pending, options.complete && !result.failures.length && !pending ? 1 : 0, pending, options.complete && !result.failures.length && !pending ? 1 : 0);
  }));
  return result;
}
