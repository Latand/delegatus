import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { writePrivate, type StoredSession } from "./storage";
import { validCallSummary, type CallSummary } from "./callMemoryTypes";
import type { CompanionUsage } from "./contract";
import { CALL_RETENTION_COUNT, CALL_RETENTION_MS, callEndedAt, safelyClosed } from "./retention";

export type TranscriptKind = "session_start" | "session_end" | "utterance" | "reply" | "delegation" | "tool" | "handoff" | "request" | "report" | "summary";
/** Page contract. Times are milliseconds from session start; speech also
 * carries the provider's timeline and each fragment's [start, end] pair.
 * Tool arguments and results are cleaned, bounded pretty JSON strings. */
export interface TranscriptEntry {
  id: string;
  kind: TranscriptKind;
  atMs: number;
  data: Record<string, unknown>;
  /** First occurrence, retained when fragments or delivery states update. */
  order?: number;
}
export interface SessionTranscriptRecord { entries: TranscriptEntry[]; truncated: boolean; usage?: CompanionUsage }
const MAX_BYTES = 4 * 1024 * 1024;
const CLOSE_RESERVE = 8192;
const TRUNCATION_MARKER = JSON.stringify({ type: "transcript_truncated", version: 1 }) + "\n";
const validId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/u.test(id);
interface Held { entries: Map<string, TranscriptEntry>; persisted: Set<string>; bytes: number; truncated: boolean }

/** Settled entries append once; late corrections compact the private journal.
 * Growing speech and in-flight tools stay in memory and are returned by read.
 * The replay ring and the backend's 64-segment context never bound this store. */
export class CompanionTranscriptRecords {
  private readonly active = new Map<string, Held>();
  private directory() { return statePath("voice-companion", "transcripts"); }
  private file(id: string) {
    if (!validId(id)) throw new Error("INVALID_REQUEST");
    return path.join(this.directory(), `${id}.jsonl`);
  }
  private load(id: string): Held {
    const held: Held = { entries: new Map(), persisted: new Set(), bytes: 0, truncated: false };
    try {
      if (fs.statSync(this.file(id)).size > MAX_BYTES) throw new Error("TRANSCRIPT_UNAVAILABLE");
      const lines = fs.readFileSync(this.file(id), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const value = JSON.parse(line) as TranscriptEntry | { type: string; version: number };
        if (value && typeof value === "object" && "type" in value && value.type === "transcript_truncated" && value.version === 1) {
          held.truncated = true;
          continue;
        }
        const entry = value as TranscriptEntry;
        if (!entry || typeof entry.id !== "string" || !Number.isFinite(entry.atMs) || !entry.data || typeof entry.data !== "object") throw new Error("TRANSCRIPT_UNAVAILABLE");
        held.entries.set(entry.id, entry); held.persisted.add(entry.id);
        if (entry.kind === "session_end" && entry.data.truncated) held.truncated = true;
      }
      held.bytes = [...held.entries.values()].reduce((sum, entry) => sum + this.size(entry), 0) + (held.truncated ? Buffer.byteLength(TRUNCATION_MARKER) : 0);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("TRANSCRIPT_UNAVAILABLE"); }
    return held;
  }
  private size(entry: TranscriptEntry) { return Buffer.byteLength(JSON.stringify(entry) + "\n"); }
  private journal(entries: Iterable<TranscriptEntry>, truncated: boolean): string {
    return [...entries].map(entry => JSON.stringify(entry) + "\n").join("") + (truncated ? TRUNCATION_MARKER : "");
  }
  private persistTruncation(id: string, held: Held): void {
    if (held.truncated) return;
    held.truncated = true;
    fs.mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.file(id), "a", 0o600);
    try { fs.writeSync(fd, TRUNCATION_MARKER); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    held.bytes += Buffer.byteLength(TRUNCATION_MARKER);
  }
  begin(session: StoredSession, voice: string, sessions: Record<string, StoredSession>, now: number): void {
    this.prune(sessions, now);
    this.put(session.id, { id: "start", kind: "session_start", atMs: 0, data: { createdAt: session.createdAt, locale: session.locale, voice,
      project: session.project, startedBy: session.startedBy ?? { operator: true } } }, true);
  }
  put(id: string, entry: TranscriptEntry, settled: boolean): void {
    const held = this.active.get(id) ?? this.load(id);
    this.active.set(id, held);
    const old = held.entries.get(entry.id);
    entry = { ...entry, order: old?.order ?? held.entries.size };
    if (entry.kind === "session_end") entry = { ...entry, data: { ...entry.data, truncated: held.truncated } };
    const bytes = held.bytes - (old ? this.size(old) : 0) + this.size(entry);
    if (bytes > MAX_BYTES - (entry.kind === "session_end" ? 0 : entry.kind === "summary" ? 2048 : CLOSE_RESERVE)) {
      this.persistTruncation(id, held);
      return;
    }
    held.entries.set(entry.id, entry); held.bytes = bytes;
    if (!settled) return;
    fs.mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
    if (held.persisted.has(entry.id)) {
      // A final may arrive out of order or be re-masked when a later fragment
      // completes a credential. Replace its settled entry without duplicates.
      writePrivate(this.file(id), this.journal([...held.entries.values()].filter(row => held.persisted.has(row.id)),held.truncated));
    } else {
      const fd = fs.openSync(this.file(id), "a", 0o600);
      try { fs.writeSync(fd, JSON.stringify(entry) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      held.persisted.add(entry.id);
    }
  }
  read(id: string): SessionTranscriptRecord {
    const held = this.active.get(id) ?? this.load(id);
    // Insertion order preserves the first occurrence of an updated segment.
    return { entries: structuredClone([...held.entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))), truncated: held.truncated };
  }
  summary(id: string): CallSummary | null {
    const value = this.read(id).entries.find(entry => entry.kind === "summary")?.data;
    if (!value) return null;
    if (!validCallSummary(value)) throw new Error("TRANSCRIPT_UNAVAILABLE");
    return value;
  }
  writeSummary(id: string, summary: CallSummary, now = Date.now()): void {
    if (!validCallSummary(summary)) throw new Error("TRANSCRIPT_UNAVAILABLE");
    // A pruned journal must stay pruned, even when its request returns late.
    if (!fs.existsSync(this.file(id))) return;
    this.put(id, { id: "summary", kind: "summary", atMs: Math.max(0, now - summary.startedAt), data: { ...summary } }, true);
    if (this.read(id).entries.some(entry => entry.kind === "session_end")) this.finish(id);
  }
  finish(id: string): void {
    const held = this.active.get(id);
    if (!held) return;
    writePrivate(this.file(id), this.journal(held.entries.values(),held.truncated));
    this.active.delete(id);
  }
  /** Ownership travels with the journal so removing a heavy state row cannot
   * orphan its summary. Legacy journals without ownership remain unreadable as
   * memory unless their retained state row supplies that authority. */
  sessions(requireOwner = true): StoredSession[] {
    let files: string[];
    try { files = fs.readdirSync(this.directory()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.flatMap(file => {
      if (!file.endsWith(".jsonl") || !validId(file.slice(0,-6))) return [];
      const id = file.slice(0,-6);
      const entries = this.read(id).entries;
      const start = entries.find(row => row.kind === "session_start")?.data;
      const end = entries.find(row => row.kind === "session_end")?.data;
      if (!start || !end || !Number.isFinite(start.createdAt) || !Number.isFinite(end.endedAt)) return [];
      const owner = start.startedBy;
      const owned = owner && typeof owner === "object" && !Array.isArray(owner) && Object.keys(owner).length === 1
        && ("operator" in owner && owner.operator === true || "memberId" in owner && typeof owner.memberId === "string" && owner.memberId.length > 0);
      if (requireOwner && (!owned || typeof start.project !== "string" || !start.project || !["en","uk"].includes(String(start.locale)))) return [];
      return [{ id, project: typeof start.project === "string" ? start.project : "unknown", locale: start.locale === "uk" ? "uk" : "en", startedBy: owned ? owner as StoredSession["startedBy"] : undefined,
        createdAt: start.createdAt as number, endedAt: end.endedAt as number, closed: true, generation: 1, seq: 0, inputs: [], events: [], proposals: {} }];
    });
  }
  prune(sessions: Record<string, StoredSession>, now: number): void {
    const known = new Map(this.sessions(false).map(session => [session.id,session]));
    for (const session of Object.values(sessions)) known.set(session.id,session);
    const closed = [...known.values()].filter(session => safelyClosed(session)).map(session => {
      const end = this.read(session.id).entries.find(entry => entry.kind === "session_end");
      return { ...session, endedAt: typeof end?.data.endedAt === "number" ? end.data.endedAt : callEndedAt(session) };
    }).sort((a, b) => b.endedAt - a.endedAt);
    for (const [index, session] of closed.entries()) if (index >= CALL_RETENTION_COUNT || now - session.endedAt > CALL_RETENTION_MS) {
      fs.rmSync(this.file(session.id), { force: true }); this.active.delete(session.id);
    }
  }
}
