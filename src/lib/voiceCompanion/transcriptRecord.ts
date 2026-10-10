import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { writePrivate, type StoredSession } from "./storage";

export type TranscriptKind = "session_start" | "session_end" | "utterance" | "reply" | "delegation" | "tool" | "handoff" | "request" | "report";
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
export interface SessionTranscriptRecord { entries: TranscriptEntry[]; truncated: boolean }
const MAX_BYTES = 4 * 1024 * 1024;
const CLOSE_RESERVE = 2048;
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
        const entry = JSON.parse(line) as TranscriptEntry;
        if (!entry || typeof entry.id !== "string" || !Number.isFinite(entry.atMs) || !entry.data || typeof entry.data !== "object") throw new Error("TRANSCRIPT_UNAVAILABLE");
        held.entries.set(entry.id, entry); held.persisted.add(entry.id);
        if (entry.kind === "session_end" && entry.data.truncated) held.truncated = true;
      }
      held.bytes = [...held.entries.values()].reduce((sum, entry) => sum + this.size(entry), 0);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("TRANSCRIPT_UNAVAILABLE"); }
    return held;
  }
  private size(entry: TranscriptEntry) { return Buffer.byteLength(JSON.stringify(entry) + "\n"); }
  begin(session: StoredSession, voice: string, sessions: Record<string, StoredSession>, now: number): void {
    this.prune(sessions, now);
    this.put(session.id, { id: "start", kind: "session_start", atMs: 0, data: { createdAt: session.createdAt, locale: session.locale, voice } }, true);
  }
  put(id: string, entry: TranscriptEntry, settled: boolean): void {
    const held = this.active.get(id) ?? this.load(id);
    this.active.set(id, held);
    const old = held.entries.get(entry.id);
    entry = { ...entry, order: old?.order ?? held.entries.size };
    if (entry.kind === "session_end") entry = { ...entry, data: { ...entry.data, truncated: held.truncated } };
    const bytes = held.bytes - (old ? this.size(old) : 0) + this.size(entry);
    if (bytes > MAX_BYTES - (entry.kind === "session_end" ? 0 : CLOSE_RESERVE)) { held.truncated = true; return; }
    held.entries.set(entry.id, entry); held.bytes = bytes;
    if (!settled) return;
    fs.mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
    if (held.persisted.has(entry.id)) {
      // A final may arrive out of order or be re-masked when a later fragment
      // completes a credential. Replace its settled entry without duplicates.
      writePrivate(this.file(id), [...held.entries.values()].filter(row => held.persisted.has(row.id)).map(row => JSON.stringify(row) + "\n").join(""));
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
  finish(id: string): void {
    const held = this.active.get(id);
    if (!held) return;
    writePrivate(this.file(id), [...held.entries.values()].map(entry => JSON.stringify(entry) + "\n").join(""));
    this.active.delete(id);
  }
  prune(sessions: Record<string, StoredSession>, now: number): void {
    const closed = Object.values(sessions).filter(session => session.closed).map(session => {
      const end = this.read(session.id).entries.find(entry => entry.kind === "session_end");
      return { ...session, endedAt: typeof end?.data.endedAt === "number" ? end.data.endedAt : session.createdAt };
    }).sort((a, b) => b.endedAt - a.endedAt);
    for (const [index, session] of closed.entries()) if (index >= 50 || now - session.endedAt > 30 * 86400_000) {
      fs.rmSync(this.file(session.id), { force: true }); this.active.delete(session.id);
    }
  }
}
