import fs from "node:fs/promises";
import crypto from "node:crypto";
import { isClaudePrompt } from "@/lib/claudeProtocolUser";
import { turnStateFromRecords } from "./nativeTurnState";
import { fact, unknown, type Evidence, type Fact, type NativeTurn, type TranscriptVersion, type NativePromptAnchor } from "./model";

type Engine = "codex" | "claude" | "copilot" | "claude-ledger";
type RecordLike = Record<string, unknown>;
const object = (v: unknown): RecordLike => v && typeof v === "object" && !Array.isArray(v) ? v as RecordLike : {};
const string = (v: unknown): string | null => typeof v === "string" && v.length <= 256 ? v : null;
const identity = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > 128) throw new Error("native identity exceeds its bound");
  return v;
};
const time = (v: unknown): number | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const PAGE = 128 * 1024;
const PASS_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 2048;
export interface BoundaryEvent {
  kind: "start" | "terminal" | "tool" | "output" | "continue";
  type: string;
  id: string | null;
  at: number | null;
  tools?: boolean;
  outcome?: "completed" | "interrupted" | "error";
  parentId?: string | null;
  toolDelta?: number;
  toolFloor?: number;
  opensWork?: boolean;
  synthetic?: boolean;
  release?: boolean;
}

/** Remove message bodies before retaining any recovery page. */
export function nativeBoundaryEvent(record: RecordLike, engine: Engine, localRef: string | null = null): BoundaryEvent | null {
  if (engine === "claude-ledger") {
    if (record.kind === "turn-started" && record.turnId === localRef) {
      return { kind: "continue", type: "host-turn-start", id: null, at: time(record.accountingAt) };
    }
    const item = object(record.item);
    const uuid = identity(item.uuid);
    return record.kind === "item" && record.turnId === localRef && isClaudePrompt(item) && uuid
      ? { kind: "start", type: "host-user-frame", id: uuid, at: time(record.accountingAt) } : null;
  }
  const data = engine === "codex" ? object(record.payload) : engine === "copilot" ? object(record.data) : record;
  const type = string(data.type ?? record.type) ?? "";
  const id = identity(data.turn_id ?? data.turnId ?? record.uuid ?? record.id);
  const at = time(record.timestamp);
  if (engine === "codex") {
    if (["task_started", "turn_started"].includes(type)) return { kind: "start", type, id, at };
    // The ordinary user echo has no native id and follows task_started. It
    // must not erase that id and let an older cached terminal close this turn.
    if (type === "user_message") return { kind: "start", type, id, at };
    if (["task_complete", "turn_complete", "turn_completed", "turn_aborted"].includes(type)) return { kind: "terminal", type, id, at, outcome: type === "turn_aborted" ? "interrupted" : "completed" };
    if (/tool|function|command/.test(type)) return { kind: /output|_result$/.test(type) ? "output" : "tool", type, id, at };
    return null;
  }
  if (engine === "claude") {
    const message = object(record.message);
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = typeof message.content === "string" ? message.content : parts.map(part => string(object(part).text) ?? "").join("\n");
    if (record.isCompactSummary === true) return null;
    if (record.type === "user") {
      if (record.interruptedByShutdown === true || "interruptedMessageId" in record
        || /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(text)) {
        return { kind: "continue", type, id, at, release: true, synthetic: true };
      }
      const content = object(record.message).content;
      if (Array.isArray(content) && content.some(part => object(part).type === "tool_result")) return { kind: "output", type, id, at, parentId: identity(record.parentUuid) };
      if (!isClaudePrompt(record)) {
        // The CLI inserts metadata user rows for image captions. They keep
        // parent ancestry for the assistant's result without opening a turn.
        const parentId = identity(record.parentUuid);
        return record.isMeta === true && (message.role === undefined || message.role === "user") && id && parentId
          ? { kind: "output", type, id, at, parentId } : null;
      }
      return { kind: "start", type, id, at, parentId: identity(record.parentUuid) };
    }
    if (record.type !== "assistant" && record.type !== "result") return null;
    const verdict = turnStateFromRecords([record], "claude", true);
    return { kind: verdict.state === "terminal" ? "terminal" : "continue", type, id, at, parentId: identity(record.parentUuid),
      ...(verdict.state === "terminal" ? { outcome: record.isApiErrorMessage === true || record.is_error === true ? "error" as const : "completed" as const } : {}),
      ...(message.model === "<synthetic>" ? { synthetic: true, release: /^no response requested\.?$/i.test(text.trim()) } : {}) };
  }
  if (type === "user.message") return { kind: "start", type, id, at };
  if (type === "assistant.message") {
    return { kind: "continue", type, id: null, at, tools: Array.isArray(data.toolRequests) && data.toolRequests.length > 0 };
  }
  if (["assistant.turn_end", "abort", "session.shutdown"].includes(type)) return { kind: "terminal", type, id: null, at, outcome: type === "abort" ? "interrupted" : type === "session.shutdown" ? "error" : "completed" };
  if (["assistant.turn_start", "tool.execution_start", "tool.execution_complete"].includes(type)) return { kind: "continue", type, id: null, at };
  return null;
}

export function foldNativeBoundaries(events: readonly BoundaryEvent[], engine: Engine, localRef: string | null,
  previous?: NativeTurn): NativeTurn | null {
  let turn: NativeTurn | null = previous ? { ...previous, localRef } : null;
  let requestedTools = (previous?.tools ?? 0) > 0;
  let promptOrdinal = previous?.promptOrdinal ?? 0;
  let recoveryClosed: NativeTurn | null = previous?.state === "closed" ? { ...previous } : null;
  for (const event of events) {
    if (event.kind === "start") {
      // Several deliveries can join one held turn. The first native opening
      // remains its anchor even when a later prompt steers that turn.
      if (engine === "claude-ledger" && turn) continue;
      if (engine === "codex" && event.type === "user_message" && !event.id && turn?.state === "open" && turn.nativeId) {
        turn.tools = 0; continue;
      }
      if (engine === "claude" && turn?.state === "closed") recoveryClosed = { ...turn };
      if (engine === "copilot") promptOrdinal++;
      turn = { state: "open", nativeId: event.id, localRef, opening: event.type, closing: null, at: event.at, tools: 0, ...(engine === "copilot" ? { promptOrdinal, modelReady: false } : {}), ...(engine === "claude" ? { ancestry: event.id ? [event.id] : [] } : {}) };
      requestedTools = false;
    } else if (event.kind === "terminal") {
      // Native ids on Codex terminals must agree with the latest start, or
      // with the persisted exact native turn when the start is above the page.
      if (engine === "codex" && event.id && (turn?.opening === "user_message" && !turn.nativeId
        || event.id !== (turn?.nativeId ?? localRef))) continue;
      if (engine === "copilot" && event.type === "assistant.turn_end" && (requestedTools || !turn?.modelReady)) continue;
      if (engine === "claude" && event.parentId && turn && !turn.ancestry?.includes(event.parentId)) continue;
      if (!turn && engine !== "codex") continue;
      turn = { state: "closed", nativeId: turn?.nativeId ?? event.id, localRef,
        opening: turn?.opening ?? null, closing: event.type, at: event.at, tools: 0,
        ...(engine === "claude" ? { ancestry: [...new Set([...(turn?.ancestry ?? []), ...(event.id ? [event.id] : [])])].slice(-16) } : {}), ...(engine === "copilot" ? { promptOrdinal } : {}), ...(event.outcome ? { outcome: event.outcome } : {}) };
    } else if (turn) {
      if (event.type === "tool-summary") {
        turn.tools = Math.max(event.toolFloor ?? 0, turn.tools + (event.toolDelta ?? 0));
        if (event.opensWork) { turn.state = "open"; turn.closing = null; }
        continue;
      }
      if (engine === "claude" && event.synthetic) {
        if (event.release && recoveryClosed) turn = { ...turn, state: "closed", closing: "recovery-release", at: event.at, tools: 0 };
        continue;
      }
      if (engine === "claude" && event.id) {
        if (event.parentId && !turn.ancestry?.includes(event.parentId)) continue;
        turn.ancestry = [...new Set([...(turn.ancestry ?? []), event.id])].slice(-16);
      }
      if (engine === "claude" && event.kind === "continue") {
        recoveryClosed = null; turn.state = "open"; turn.closing = null;
      }
      if (event.kind === "tool") { turn.tools++; turn.state = "open"; turn.closing = null; }
      else if (event.kind === "output") { turn.tools = Math.max(0, turn.tools - 1); }
      else if (engine === "copilot") {
        if (event.type === "assistant.turn_start" || event.type === "assistant.message") turn.modelReady = true;
        if (event.tools !== undefined) { requestedTools = event.tools; turn.tools = event.tools ? 1 : 0; }
        turn.state = "open"; turn.closing = null;
      }
    }
  }
  return turn;
}

interface Cached {
  version: TranscriptVersion;
  turn: NativeTurn | null;
  events: BoundaryEvent[];
  before: number;
  complete: boolean;
  edgeHash?: string;
  cost?: number;
  promptStarts?: number;
  refusal?: string;
}
export interface TranscriptAcquisition {
  turn: Fact<NativeTurn>;
  readonly transcript: Fact<TranscriptVersion>;
}
export class AgentTranscriptCache {
  private readonly rows = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<TranscriptAcquisition>>();
  private retainedBytes = 0;
  readonly counters = { payloadBytes: 0, opens: 0, hits: 0, joined: 0, evictions: 0, recoveryPages: 0 };
  constructor(private readonly capacity = 4096) {}
  clear(): void { this.rows.clear(); this.retainedBytes = 0; }
  get size(): number { return this.rows.size; }
  seed(input: { engine: Engine; path: string; revision: string; anchor?: NativePromptAnchor | null; localRef?: string | null }, acquisition: TranscriptAcquisition): void {
    const key = JSON.stringify([input.engine, input.path, input.revision, input.anchor ?? null, input.engine === "claude-ledger" ? input.localRef : null]);
    if (this.rows.has(key) || !acquisition.turn.determined || !acquisition.transcript.determined
      || acquisition.turn.evidence.source !== "native-transcript") return;
    // acquire validates the persisted signature against the current pathname
    // before using this boundary. No request has to scan retained history.
    const row: Cached = { version: { ...acquisition.transcript.value }, turn: { ...acquisition.turn.value }, events: [],
      before: acquisition.transcript.value.coveredFrom, complete: true };
    row.cost = JSON.stringify(row).length * 2;
    if (this.rows.size >= this.capacity || this.retainedBytes + row.cost > 16 * 1024 * 1024) return;
    this.rows.set(key, row); this.retainedBytes += row.cost;
  }
  async acquire(input: { engine: Engine; path: string; revision: string; localRef: string | null; observedAt: number; anchor?: NativePromptAnchor | null }): Promise<TranscriptAcquisition> {
    const key = JSON.stringify([input.engine, input.path, input.revision, input.anchor ?? null, input.engine === "claude-ledger" ? input.localRef : null]);
    const inflight = this.pending.get(key);
    if (inflight) { this.counters.joined++; return inflight; }
    const result = this.read(input, key);
    this.pending.set(key, result);
    try { return await result; } finally { if (this.pending.get(key) === result) this.pending.delete(key); }
  }
  private async read(input: { engine: Engine; path: string; revision: string; localRef: string | null; observedAt: number; anchor?: NativePromptAnchor | null }, key: string): Promise<TranscriptAcquisition> {
    const evidence: Evidence = { source: "native-transcript", observedAt: input.observedAt, subjectRevision: input.revision, ref: "boundary-unresolved" };
    const uncertain = (why: string): TranscriptAcquisition => ({ turn: unknown(why, evidence), transcript: unknown(why, evidence) });
    let handle: fs.FileHandle | null = null;
    try {
      const stat = await fs.stat(input.path, { bigint: true });
      const signature = fileSignature(stat);
      const size = Number(stat.size);
      if (!stat.isFile() || !Number.isSafeInteger(size)) return uncertain("artifact is not a bounded regular file");
      const anchor = input.engine === "copilot" ? input.anchor : null;
      const base = anchor?.offset ?? 0;
      if (base > size || anchor && anchor.device !== null && (String(stat.dev) !== anchor.device || String(stat.ino) !== anchor.inode)) return uncertain("native prompt anchor identity changed");
      const artifact = crypto.createHash("sha256").update(input.path).digest("hex").slice(0, 24);
      evidence.ref = `${artifact}:${signature}`;
      const old = this.rows.get(key);
      let cached = old?.version.signature === signature ? old : undefined;
      if (cached?.complete) {
        this.rows.delete(key); this.rows.set(key, cached); this.counters.hits++;
        return this.answer(cached, evidence, input.localRef);
      }
      // Incomplete scans retain only compact native boundaries and the earlier
      // cursor. Every earlier page is read once for a stable artifact version.
      cached ??= { version: { artifact, signature, size, mtimeMs: Number(stat.mtimeNs) / 1e6, coveredFrom: size, bytesRead: 0 },
        turn: null, events: [], before: size, complete: false };
      this.counters.opens++;
      handle = await fs.open(input.path, "r");
      if (fileSignature(await handle.stat({ bigint: true })) !== signature) return uncertain("artifact replaced before read");
      let spent = 0;
      if (anchor && base > 0) {
        const edge = Buffer.alloc(Math.min(64, base));
        const read = await handle.read(edge, 0, edge.length, base - edge.length);
        this.counters.payloadBytes += read.bytesRead;
        if (read.bytesRead !== edge.length || edge.at(-1) !== 10 || crypto.createHash("sha256").update(edge).digest("hex") !== anchor.edgeHash) return uncertain("native prompt anchor prefix changed");
      }

      const sameInode = old?.version.signature.split(":").slice(0, 2).join(":") === signature.split(":").slice(0, 2).join(":");
      if (old?.complete && old.turn && old.edgeHash && sameInode && size > old.version.size && size - old.version.size <= PASS_BYTES) {
        const overlap = Buffer.alloc(Math.min(64, old.version.size));
        const overlapRead = await handle.read(overlap, 0, overlap.length, old.version.size - overlap.length);
        spent += overlapRead.bytesRead;
        this.counters.payloadBytes += overlapRead.bytesRead;
        if (overlapRead.bytesRead === overlap.length && crypto.createHash("sha256").update(overlap).digest("hex") === old.edgeHash) {
          const suffix = Buffer.alloc(size - old.version.size);
          const suffixRead = await handle.read(suffix, 0, suffix.length, old.version.size);
          if (suffixRead.bytesRead !== suffix.length || suffix.at(-1) !== 10) return uncertain("incomplete appended native record");
          spent += suffixRead.bytesRead; this.counters.payloadBytes += suffixRead.bytesRead;
          const events = parseBoundaryPage(suffix, input.engine, input.localRef);
          cached = { ...cached, turn: foldNativeBoundaries(events, input.engine, input.localRef, old.turn), complete: true,
            before: old.before, events: [], version: { ...cached.version, coveredFrom: old.before } };
        }
      }
      while (!cached.complete && spent < PASS_BYTES) {
        const end = cached.before;
        const recordStartedAt = spent;
        let start = Math.max(base, end - Math.min(PAGE, PASS_BYTES - spent));
        let buffer = Buffer.alloc(end - start);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, start + offset);
          if (!read.bytesRead) return uncertain("short transcript read");
          offset += read.bytesRead;
        }
        spent += offset; this.counters.payloadBytes += offset; this.counters.recoveryPages++;
        if (buffer.length && buffer.at(-1) !== 10) return uncertain("incomplete native record");
        // A large single JSONL record may occupy an entire page. Expand only
        // this exceptional record within the acquisition budget, then discard
        // its body after parsing; skipping its only newline makes no progress.
        const chunks = [buffer];
        while (start > base && spent < PASS_BYTES && (chunks[0]!.indexOf(10) < 0
          || chunks.length === 1 && buffer.indexOf(10) === buffer.length - 1)) {
          const earlier = Math.max(base, start - Math.min(PAGE, PASS_BYTES - spent));
          const chunk = Buffer.alloc(start - earlier);
          let read = 0;
          while (read < chunk.length) {
            const part = await handle.read(chunk, read, chunk.length - read, earlier + read);
            if (!part.bytesRead) return uncertain("short transcript read");
            read += part.bytesRead;
          }
          spent += read; this.counters.payloadBytes += read; this.counters.recoveryPages++;
          chunks.unshift(chunk); start = earlier;
        }
        if (chunks.length > 1) buffer = Buffer.concat(chunks);
        if (start > base && buffer.indexOf(10) === buffer.length - 1) {
          if (recordStartedAt === 0) {
            cached.events = []; cached.turn = null; cached.complete = true; cached.refusal = "native record exceeds acquisition budget";
          }
          // An acquisition that already reduced later records retries this
          // exceptional record with the full next budget and the same cursor.
          break;
        }
        const skip = start > base ? buffer.indexOf(10) + 1 : 0;
        if (start > base && skip <= 0) return uncertain("native record exceeds page budget");
        const events = parseBoundaryPage(buffer.subarray(skip), input.engine, input.localRef);
        if (input.engine === "copilot") cached.promptStarts = (cached.promptStarts ?? 0) + events.filter(event => event.kind === "start").length;
        cached.events = [...events, ...cached.events];
        if (input.engine === "codex") {
          const start = cached.events.findLastIndex(event => event.kind === "start" && event.id !== null);
          if (start > 0) cached.events = cached.events.slice(start);
          cached.events = compactCodexWork(cached.events);
        }

        if (input.engine === "copilot") {
          const latestStart = cached.events.findLastIndex(event => event.kind === "start");
          if (latestStart > 0) cached.events = cached.events.slice(latestStart);
        }
        cached.before = start + skip;
        cached.version.coveredFrom = cached.before;
        const turn = foldNativeBoundaries(cached.events, input.engine, input.localRef);
        // Recover the latest opening before deciding the agent is settled.
        // A late terminal for an older native id cannot close a later start.
        const recoveryPending = input.engine === "claude" && cached.events.at(-1)?.release && turn?.state !== "closed";
        cached.complete = cached.before === base || (input.engine === "claude-ledger"
          ? cached.events.some(event => event.type === "host-turn-start")
          : input.engine !== "copilot" && !recoveryPending && Boolean(turn?.opening)
            && (input.engine !== "codex" || turn?.nativeId !== null));
        if (turn && input.engine === "copilot") turn.promptOrdinal = cached.before === base ? cached.promptStarts ?? 0 : null;
        cached.turn = turn;
        if (!cached.complete && (cached.events.length > MAX_EVENTS || JSON.stringify(cached.events).length > 256 * 1024)) {
          cached.events = []; cached.turn = null; cached.complete = true; cached.refusal = "native summary capacity exceeded";
        }
        if (!cached.complete && cached.before === end) return uncertain("boundary recovery made no progress");
      }
      if (fileSignature(await handle.stat({ bigint: true })) !== signature
        || fileSignature(await fs.stat(input.path, { bigint: true })) !== signature) return uncertain("transcript changed during read");
      cached.version.bytesRead += spent;
      if (cached.complete) cached.events = [];
      const edge = Buffer.alloc(Math.min(64, size));
      if (edge.length) {
        const read = await handle.read(edge, 0, edge.length, size - edge.length);
        this.counters.payloadBytes += read.bytesRead;
        if (read.bytesRead !== edge.length) return uncertain("incomplete native overlap");
      }
      cached.edgeHash = crypto.createHash("sha256").update(edge).digest("hex");
      if (fileSignature(await handle.stat({ bigint: true })) !== signature
        || fileSignature(await fs.stat(input.path, { bigint: true })) !== signature) return uncertain("transcript changed during checkpoint");
      this.retainedBytes -= this.rows.get(key)?.cost ?? 0;
      this.rows.delete(key);
      cached.cost = JSON.stringify(cached).length * 2;
      this.retainedBytes += cached.cost;
      this.rows.set(key, cached);
      while (this.rows.size > this.capacity || this.retainedBytes > 16 * 1024 * 1024) {
        const first = this.rows.keys().next().value!;
        this.retainedBytes -= this.rows.get(first)?.cost ?? 0;
        this.rows.delete(first); this.counters.evictions++;
      }
      return this.answer(cached, evidence, input.localRef);
    } catch { return uncertain("native transcript unreadable or invalid"); }
    finally { await handle?.close(); }
  }
  private answer(cached: Cached, evidence: Evidence, localRef: string | null): TranscriptAcquisition {
    return { transcript: fact(cached.version, evidence), turn: cached.complete && cached.turn
      ? fact({ ...cached.turn, localRef }, { ...evidence, ...(cached.turn.at === null ? {} : { eventAt: cached.turn.at }) })
      : cached.complete && cached.version.size === 0 && localRef === null
        ? fact({ state: "absent", nativeId: null, localRef: null, opening: null, closing: null, at: null, tools: 0 }, evidence)
        : unknown(cached.refusal ?? (cached.complete ? "boundary-unresolved" : "boundary recovery pending"), evidence) };
  }
}
export function fileSignature(stat: import("node:fs").BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
export async function transcriptVersionMatches(path: string, signature: string): Promise<boolean> {
  try { return fileSignature(await fs.stat(path, { bigint: true })) === signature; } catch { return false; }
}

function parseBoundaryPage(buffer: Buffer, engine: Engine, localRef: string | null): BoundaryEvent[] {
  const data = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const events: BoundaryEvent[] = [];
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid native record");
    const event = nativeBoundaryEvent(value as RecordLike, engine, localRef);
    if (event) events.push(event);
  }
  return events;
}

/** Setup-only snapshot. Hot prompt dispatch reads this immutable anchor in memory. */
export async function readNativePromptAnchor(path: string, fresh = false): Promise<NativePromptAnchor | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path, "r");
    const before = await handle.stat({ bigint: true });
    const offset = Number(before.size);
    if (!before.isFile() || !Number.isSafeInteger(offset)) return null;
    const edge = Buffer.alloc(Math.min(64, offset));
    const read = await handle.read(edge, 0, edge.length, offset - edge.length);
    if (read.bytesRead !== edge.length || edge.length && edge.at(-1) !== 10) return null;
    if (fileSignature(await handle.stat({ bigint: true })) !== fileSignature(before)
      || fileSignature(await fs.stat(path, { bigint: true })) !== fileSignature(before)) return null;
    return { device: String(before.dev), inode: String(before.ino), offset, edgeHash: crypto.createHash("sha256").update(edge).digest("hex") };
  } catch (error) {
    return fresh && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { device: null, inode: null, offset: 0, edgeHash: crypto.createHash("sha256").digest("hex") } : null;
  } finally { await handle?.close(); }
}

/** Compose tool-count transforms without retaining a long historical call ledger. */
function compactCodexWork(events: BoundaryEvent[]): BoundaryEvent[] {
  const compact: BoundaryEvent[] = [];
  let run: BoundaryEvent | null = null;
  const flush = () => { if (run) compact.push(run); run = null; };
  for (const event of events) {
    if (event.kind === "start" || event.kind === "terminal") { flush(); compact.push(event); continue; }
    if (event.kind !== "tool" && event.kind !== "output" && event.type !== "tool-summary") continue;
    run ??= { kind: "continue", type: "tool-summary", id: null, at: null, toolDelta: 0, toolFloor: 0, opensWork: false };
    const delta = event.toolDelta ?? (event.kind === "tool" ? 1 : -1);
    run.toolFloor = Math.max(event.toolFloor ?? 0, (run.toolFloor ?? 0) + delta);
    run.toolDelta = (run.toolDelta ?? 0) + delta;
    run.opensWork ||= event.opensWork || event.kind === "tool";
  }
  flush();
  return compact;
}
