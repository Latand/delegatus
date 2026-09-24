import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  candidateFor,
  claudeSessionKind,
  classifyUserRecord,
  codexSessionKind,
  dedupeCandidates,
  parseClaudeUserRecord,
  parseCodexUserRecord,
  type ExclusionReason,
  type ExportManifest,
  type HumanInput,
  type InputCandidate,
  type LaunchKind,
  type TranscriptContext,
  type UserRecord,
} from "./humanInput";

/*
 * One host's transcripts into human-input events (the exporter's core; the
 * command is `scripts/export-human-input.ts`). It reads every transcript file
 * modified since the window began — a session that began days earlier still
 * holds messages inside it, so files are chosen by modification time and never
 * by the date directory a session was filed under — and every message is kept
 * or dropped by its own timestamp.
 *
 * The project comes from the conversation's context: the host registry's
 * ownership or task binding, otherwise the conversation's working directory.
 * A message's text never decides a project.
 */

/** What the transcript itself says about its conversation. */
export interface TranscriptFacts {
  path: string;
  engine: "claude" | "codex";
  /** The working directory the conversation ran in, from its own records. */
  cwd: string | null;
  /** Claude: the entrypoint of its first user record. */
  entrypoint: string | null;
  /** Codex: the `session_meta` payload. */
  sessionMeta: unknown;
}

/** What the host knows about the conversation beyond its transcript. */
export interface ConversationResolution {
  project: string | null;
  /** How the host's registry says it was launched; null when unregistered. */
  launch: LaunchKind | null;
  registered: boolean;
  /** A stable identity for the fan-out rule, when the registry has one. */
  conversation?: string;
  deliveryOrigin?: TranscriptContext["deliveryOrigin"];
  /** The registry's role and pipeline stage for the agent axis. */
  agent?: { role: string; pipelineId: string | null; stageId: string | null };
}

export interface ExportRequest {
  host: string;
  from: number;
  to: number;
  now: number;
  files: readonly string[];
  resolve(facts: TranscriptFacts): ConversationResolution;
}

export interface ExportResult {
  manifest: Omit<ExportManifest, "v" | "type">;
  inputs: HumanInput[];
}

/** Every `.jsonl` under the roots modified at or after `sinceMs`, each real
    file once and by its real path (a store linked into two roots is one
    store, and the real path is the one the registry records). */
export function listTranscriptFiles(roots: readonly string[], sinceMs: number): string[] {
  const found = new Map<string, string>();
  const visited = new Set<string>();
  const walk = (dir: string) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      const target = path.join(dir, item.name);
      if (item.isDirectory() || (item.isSymbolicLink() && isDirectory(target))) walk(target);
      else if (item.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(target);
          if (stat.isFile() && stat.mtimeMs >= sinceMs) {
            const realFile = fs.realpathSync(target);
            found.set(realFile, realFile);
          }
        } catch {
          /* Vanished while walking. */
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return [...found.values()].sort();
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface ParsedTranscript {
  facts: TranscriptFacts;
  records: UserRecord[];
}

/** What a transcript's lines have said about its conversation so far: kept
    between reads, so a transcript read in pieces reaches the same facts as
    one read whole. Plain JSON, so it can be stored with a read cursor. */
export interface TranscriptFactsState {
  engine: "claude" | "codex" | null;
  cwd: string | null;
  entrypoint: string | null;
  sessionMeta: unknown;
  /** The agent turn still open at the last line read, when turns are kept. */
  turn?: AgentTurn | null;
}

/** One agent turn: from what started it to the last record of work in it. */
export interface AgentTurn {
  start: number;
  end: number;
}

/** A record's place in an agent turn. */
function turnMark(engine: "claude" | "codex", line: Record<string, unknown>): { start: boolean; message?: boolean; end: boolean; work: boolean } {
  const payload = record(line.payload);
  if (engine === "codex") {
    /* A Codex turn is bounded by the engine itself. A turn started by another
       agent's delivery carries no user message, so the task events are the
       only boundary every turn has. */
    const event = line.type === "event_msg" ? payload?.type : null;
    const message = event === "user_message" || (line.type === "response_item" && payload?.type === "message" && payload.role === "user");
    const work = line.type === "response_item" || (line.type === "event_msg" && event !== "thread_settings_applied");
    return { start: event === "task_started", message, end: event === "task_complete" || event === "turn_aborted", work };
  }
  /* A Claude turn opens at a user record with text and ends at its last
     assistant, tool-result or system record; queue and bookkeeping records
     written while the agent waits are not work. */
  const content = record(line.message)?.content;
  const start = line.type === "user" && (typeof content === "string"
    ? content.trim().length > 0
    : Array.isArray(content) && content.some((part) => record(part)?.type === "text" && typeof record(part)?.text === "string" && (record(part)!.text as string).trim().length > 0));
  return { start, end: false, work: line.type === "assistant" || line.type === "user" || line.type === "system" };
}

/** The fields a Codex rollout writes first on every line. */
const CODEX_PREFIX = /^\{"timestamp":"([^"]{10,40})",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)"(?:,"role":"([a-z]+)")?)?/;
const CODEX_PREFIX_BYTES = 300;

const USER_BYTES = Buffer.from("\"user\"");
const SESSION_META_BYTES = Buffer.from("session_meta");
const CWD_BYTES = Buffer.from("\"cwd\"");

/**
 * One transcript's lines, in order, into its facts and user records. Lines
 * that cannot hold either are skipped before they are parsed; `wants` asks
 * that of a raw line, so a caller holding bytes decodes only the lines kept.
 */
export class TranscriptLineReader {
  readonly state: TranscriptFactsState;
  readonly records: UserRecord[] = [];
  /** Turns that ended in the lines read; the open one stays in `state.turn`. */
  readonly turns: AgentTurn[] = [];

  /** `keepTurns` reads every line, since any record can extend a turn. */
  constructor(state?: TranscriptFactsState, private readonly keepTurns = false) {
    this.state = state ? { ...state } : { engine: null, cwd: null, entrypoint: null, sessionMeta: null };
    if (keepTurns) this.state.turn ??= null;
  }

  wants(line: string | Buffer): boolean {
    if (this.keepTurns) return true;
    if (typeof line === "string") {
      return this.state.engine === null || line.includes("\"user\"") || line.includes("session_meta") || (this.state.cwd === null && line.includes("\"cwd\""));
    }
    return this.state.engine === null || line.includes(USER_BYTES) || line.includes(SESSION_META_BYTES) || (this.state.cwd === null && line.includes(CWD_BYTES));
  }

  /**
   * One raw line. A Codex line's place in a turn is in its first few hundred
   * bytes, so a line that cannot hold a user record or the session's facts —
   * tool output, reasoning, a compaction's copy of the history — is never
   * decoded or parsed whole. Anything else goes through `accept`.
   */
  acceptBytes(line: Buffer): void {
    if (this.keepTurns && this.state.engine === "codex") {
      const prefix = CODEX_PREFIX.exec(line.subarray(0, CODEX_PREFIX_BYTES).toString("utf8"));
      if (prefix) {
        const [, timestamp, type, payloadType, role] = prefix;
        const needed = type === "session_meta" || (type === "turn_context" && this.state.cwd === null)
          /* A message whose role is not first after its type is read whole. */
          || (type === "response_item" && payloadType === "message" && role !== "assistant" && role !== "developer");
        if (!needed) {
          this.observeTurn("codex", { timestamp, type, payload: { type: payloadType, role } });
          return;
        }
      }
    }
    if (this.wants(line)) this.accept(line.toString("utf8"));
  }

  accept(line: string): void {
    if (!line.trim()) return;
    let parsed: Record<string, unknown> | null;
    try {
      parsed = record(JSON.parse(line));
    } catch {
      return;
    }
    if (!parsed) return;
    const state = this.state;
    if (state.engine === null) state.engine = parsed.type === "session_meta" || parsed.type === "response_item" || parsed.type === "turn_context" ? "codex" : "claude";
    if (this.keepTurns) this.observeTurn(state.engine, parsed);
    if (state.engine === "codex") {
      const payload = record(parsed.payload);
      if (parsed.type === "session_meta") {
        /* Only what tells how the session was started: the state is kept
           with a read cursor, and the rest of the record is not needed. */
        state.sessionMeta ??= payload ? { originator: payload.originator, source: payload.source } : null;
        if (state.cwd === null && typeof payload?.cwd === "string") state.cwd = payload.cwd;
      }
      if (parsed.type === "turn_context" && state.cwd === null && typeof payload?.cwd === "string") state.cwd = payload.cwd;
      const user = parseCodexUserRecord(parsed);
      if (user) this.records.push(user);
    } else {
      if (state.cwd === null && typeof parsed.cwd === "string") state.cwd = parsed.cwd;
      const user = parseClaudeUserRecord(parsed);
      if (user) {
        if (state.entrypoint === null && typeof parsed.entrypoint === "string") state.entrypoint = parsed.entrypoint;
        this.records.push(user);
      }
    }
  }

  private observeTurn(engine: "claude" | "codex", line: Record<string, unknown>): void {
    const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (!Number.isFinite(at)) return;
    const mark = turnMark(engine, line);
    const open = this.state.turn ?? null;
    /* A Codex user message opens a turn only when none is running; inside
       one it is a steer, and the turn goes on. */
    if (mark.start || (mark.message && !open)) {
      if (open && open.end > open.start) this.turns.push(open);
      this.state.turn = { start: at, end: at };
      return;
    }
    if (!mark.work || !open || at < open.end) return;
    open.end = at;
    if (mark.end) {
      if (open.end > open.start) this.turns.push(open);
      this.state.turn = null;
    }
  }

  facts(file: string): TranscriptFacts | null {
    const { engine, cwd, entrypoint, sessionMeta } = this.state;
    return engine === null ? null : { path: file, engine, cwd, entrypoint, sessionMeta };
  }
}

/** One transcript's facts and user records. */
export async function readTranscript(file: string): Promise<ParsedTranscript | null> {
  const reader = new TranscriptLineReader();
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() && reader.wants(line)) reader.accept(line);
  }
  const facts = reader.facts(file);
  return facts ? { facts, records: reader.records } : null;
}

/** The classification context of one transcript on `host`. */
export function transcriptContext(host: string, facts: TranscriptFacts, resolution: ConversationResolution): TranscriptContext {
  return {
    host,
    project: resolution.project,
    conversation: resolution.conversation ?? facts.path,
    session: facts.engine === "codex"
      ? codexSessionKind(facts.sessionMeta)
      : claudeSessionKind(facts.entrypoint, resolution.registered),
    launch: resolution.launch,
    ...(resolution.deliveryOrigin ? { deliveryOrigin: resolution.deliveryOrigin } : {}),
  };
}

export interface ClassifiedRecords {
  candidates: InputCandidate[];
  excluded: Partial<Record<ExclusionReason, number>>;
  /** Records inside the window, counted or not. */
  seen: number;
  /** Whether the conversation's first message has been judged, to carry
      into the next piece of the same transcript. */
  prompted: boolean;
}

/** Records that say nothing about who started the conversation: seeing one
    does not make the next record the conversation's first message. */
const PRELUDE: ReadonlySet<ExclusionReason> = new Set(["injected", "attachment", "notification", "recovery", "interrupt"]);

/**
 * Human inputs of one host inside [from, to], deduplicated, and a manifest
 * with the counts of every record excluded, by reason.
 */
/**
 * One transcript's user records, in time order, against its context. Records
 * outside `window` are judged (they decide which message is the first) and
 * left out of the answer.
 */
export function classifyRecords(
  records: readonly UserRecord[],
  context: TranscriptContext,
  prompted: boolean,
  window: { from: number; until: number } = { from: -Infinity, until: Infinity },
): ClassifiedRecords {
  const candidates: InputCandidate[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  let seen = 0;
  for (const rec of [...records].sort((a, b) => a.at - b.at)) {
    const verdict = classifyUserRecord(rec, context, !prompted);
    if (verdict.human || !PRELUDE.has(verdict.reason)) prompted = true;
    if (rec.at < window.from || rec.at > window.until) continue;
    seen += 1;
    if (verdict.human) candidates.push(candidateFor(rec, context, verdict));
    else excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
  }
  return { candidates, excluded, seen, prompted };
}

/**
 * Human inputs of one host inside [from, to], deduplicated, and a manifest
 * with the counts of every record excluded, by reason.
 */
export async function exportHumanInputs(request: ExportRequest): Promise<ExportResult> {
  const until = Math.min(request.to, request.now);
  const candidates: InputCandidate[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  let seen = 0;
  for (const file of request.files) {
    const transcript = await readTranscript(file);
    if (!transcript) continue;
    const context = transcriptContext(request.host, transcript.facts, request.resolve(transcript.facts));
    const classified = classifyRecords(transcript.records, context, false, { from: request.from, until });
    candidates.push(...classified.candidates);
    seen += classified.seen;
    for (const [reason, count] of Object.entries(classified.excluded) as Array<[ExclusionReason, number]>) excluded[reason] = (excluded[reason] ?? 0) + count;
  }
  const inputs = dedupeCandidates(candidates);
  if (candidates.length > inputs.length) excluded.duplicate = candidates.length - inputs.length;
  return {
    manifest: { host: request.host, coveredFrom: request.from, coveredUntil: until, exportedAt: request.now, records: seen, excluded },
    inputs,
  };
}
