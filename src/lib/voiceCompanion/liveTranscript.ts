import type { Payload } from "./contract";
import { credentialMask, maskedSlice } from "./credentialMask";

type Speaker = "operator" | "companion";
type Snapshot = Extract<Payload, { type: "transcript.snapshot" }>;
interface Segment { speaker: Speaker; itemId: string; text: string; startMs: number; endMs: number; final: boolean; boundaryMs?: number; turn: number; published?: string; fragments: Array<[number, number]> }
export const DISPLAY_PAUSE_MS = 1_500;

/** Fresh Live reducer. Timeline gaps segment the record, never authorize a
 * tool or delivery. Fragment text stays in delivery order within its segment.
 *
 * A credential in use is masked over each speaker's whole stream before any
 * snapshot leaves, so one cut into short fragments across many segments is
 * still found whole; a segment whose masked text changes is published again.
 *
 * Operator segments carry a turn: the speech between two of the companion's
 * answers or delegations. The turn binds a request and its confirmation. */
export class LiveTranscript {
  private readonly segments: Segment[] = [];
  private sequence = 0;
  private droppedTiming: { itemId: string; fragments: Array<[number, number]> } | null = null;
  private turn = 0;
  private answered = true;
  /** Text of segments the bounded history dropped, kept only to find a
   * credential that began in them. */
  private readonly dropped: Record<Speaker, string> = { operator: "", companion: "" };
  constructor(private readonly secrets: readonly string[] = []) {}
  private cleaned(speaker: Speaker): Map<Segment, string> {
    const rows = this.segments.filter(row => row.speaker === speaker);
    const before = this.dropped[speaker];
    const stream = before + rows.map(row => row.text).join("");
    const mask = credentialMask(stream, this.secrets);
    const texts = new Map<Segment, string>();
    let offset = before.length;
    for (const row of rows) { texts.set(row, maskedSlice(stream, mask, offset, offset + row.text.length)); offset += row.text.length; }
    return texts;
  }
  private snapshot(segment: Segment): Snapshot {
    const text = this.cleaned(segment.speaker).get(segment)!;
    segment.published = text;
    return { type: "transcript.snapshot", speaker: segment.speaker, itemId: segment.itemId,
      text, final: segment.final, startMs: segment.startMs, endMs: segment.endMs };
  }
  /** Earlier segments whose masked text a later fragment changed. */
  private republished(speaker: Speaker, except: Segment): Snapshot[] {
    const texts = this.cleaned(speaker);
    return [...texts].filter(([row, text]) => row !== except && row.published !== undefined && row.published !== text).map(([row]) => this.snapshot(row));
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
      else if (this.answered) { this.turn += 1; this.answered = false; }
      current = { speaker, itemId: `live-${speaker}-${++this.sequence}`, text: "", startMs, endMs, final: false, turn: speaker === "operator" ? this.turn : 0, fragments: [] };
      this.segments.push(current);
      if (this.segments.length > 64) {
        const gone = this.segments.shift()!;
        this.droppedTiming = { itemId: gone.itemId, fragments: gone.fragments };
        this.dropped[gone.speaker] = (this.dropped[gone.speaker] + gone.text).slice(-2_048);
      }
    }
    current!.fragments.push([startMs, endMs]);
    current!.text = (current!.text + delta).slice(0, 4_000);
    current!.endMs = Math.max(current!.endMs, endMs);
    events.push(this.snapshot(current!), ...this.republished(speaker, current!));
    return events;
  }
  /** A model answer or delegation seals only speech preceding its timeline
   * position. An overlapping operator segment remains open in duplex audio. */
  boundary(offsetMs: number): Snapshot[] {
    this.answered = true;
    const current = this.segments.findLast(row => row.speaker === "operator" && !row.final);
    if (!current || current.endMs > offsetMs) return [];
    current.final = true; current.boundaryMs = offsetMs;
    return [this.snapshot(current)];
  }
  timingsOf(itemId: string): Array<[number, number]> {
    return this.segments.find(row => row.itemId === itemId)?.fragments ?? (this.droppedTiming?.itemId === itemId ? this.droppedTiming.fragments : []);
  }
  /** The turn an operator segment belongs to. */
  turnOf(itemId: string): number | undefined { return this.segments.find(row => row.itemId === itemId && row.speaker === "operator")?.turn; }
  /** The operator's latest turn, if the operator has spoken. */
  latestTurn(): number | undefined { return this.turn || undefined; }
  /** The masked record, oldest first, for the backend's context. */
  record(): Array<{ speaker: Speaker; text: string }> {
    const texts = new Map([...this.cleaned("operator"), ...this.cleaned("companion")]);
    return this.segments.map(row => ({ speaker: row.speaker, text: texts.get(row)! }));
  }
  finish(): Snapshot[] {
    return this.segments.filter(row => !row.final).map(row => { row.final = true; return this.snapshot(row); });
  }
}
