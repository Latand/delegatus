import type { Payload } from "./contract";

type Speaker = "operator" | "companion";
type Snapshot = Extract<Payload, { type: "transcript.snapshot" }>;
interface Segment { speaker: Speaker; itemId: string; text: string; startMs: number; endMs: number; final: boolean; boundaryMs?: number }
export const DISPLAY_PAUSE_MS = 1_500;

/** Fresh Live reducer. Timeline gaps segment the record, never authorize a
 * tool or delivery. Fragment text stays in delivery order within its segment. */
export class LiveTranscript {
  private readonly segments: Segment[] = [];
  private sequence = 0;
  private snapshot(segment: Segment): Snapshot {
    return { type: "transcript.snapshot", speaker: segment.speaker, itemId: segment.itemId,
      text: segment.text, final: segment.final, startMs: segment.startMs, endMs: segment.endMs };
  }
  fragment(speaker: Speaker, delta: string, startMs: number, endMs: number): Snapshot[] {
    if (!delta || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) return [];
    const events: Snapshot[] = [];
    let current = this.segments.findLast(row => row.speaker === speaker);
    const late = this.segments.findLast(row => row.speaker === speaker && startMs >= row.startMs
      && (row.final ? endMs <= (row.boundaryMs ?? row.endMs) : startMs <= row.endMs));
    if (late && (!current || startMs < current.startMs || late.final)) current = late;
    const starts = !current || (current.final && !late) || startMs - current.endMs >= DISPLAY_PAUSE_MS || current.text.length + delta.length > 4_000;
    if (starts) {
      if (current && !current.final) { current.final = true; current.boundaryMs = startMs; events.push(this.snapshot(current)); }
      if (speaker === "companion") events.push(...this.boundary(startMs));
      current = { speaker, itemId: `live-${speaker}-${++this.sequence}`, text: "", startMs, endMs, final: false };
      this.segments.push(current);
      if (this.segments.length > 64) this.segments.shift();
    }
    current!.text = (current!.text + delta).slice(0, 4_000);
    current!.endMs = Math.max(current!.endMs, endMs);
    events.push(this.snapshot(current!));
    return events;
  }
  /** A model answer or delegation seals only speech preceding its timeline
   * position. An overlapping operator segment remains open in duplex audio. */
  boundary(offsetMs: number): Snapshot[] {
    const current = this.segments.findLast(row => row.speaker === "operator" && !row.final);
    if (!current || current.endMs > offsetMs) return [];
    current.final = true; current.boundaryMs = offsetMs;
    return [this.snapshot(current)];
  }
  finish(): Snapshot[] {
    return this.segments.filter(row => !row.final).map(row => { row.final = true; return this.snapshot(row); });
  }
}
