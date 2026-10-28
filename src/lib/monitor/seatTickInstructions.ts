import type { SeatTickSettingsActor } from "./seatTickSettings";

/** Attribution is supplied by the writer's server context. Legacy dates and
 * authors are unknown: a row's last editor cannot identify its older lines. */
export interface SeatTickInstructionLine {
  text: string;
  author: SeatTickSettingsActor | null;
  at: string | null;
}

type Instructions = { reason: string | null; instructionLines?: SeatTickInstructionLine[] };

export function seatTickInstructionLines(settings: Instructions): SeatTickInstructionLine[] {
  const { reason, instructionLines } = settings;
  if (!reason) return [];
  // An older writer may have changed reason while retaining the metadata.
  // Never transfer attribution to words the recorded author did not write.
  if (Array.isArray(instructionLines) && instructionLines.length > 0 && instructionLines.length <= reason.length + 1
    && instructionLines.every(line => typeof line?.text === "string" && line.text.length <= reason.length && !line.text.includes("\n")
      && (line.at === null || (typeof line.at === "string" && line.at.length <= 40 && Number.isFinite(Date.parse(line.at))))
      && (line.author === null || (line.author && ["gateway", "manager", "agent", "unidentified"].includes(line.author.kind))))
    && instructionLines.map(line => line.text).join("\n") === reason) return instructionLines;
  return reason.split("\n").map(text => ({ text, author: null, at: null }));
}

function sameWriter(author: SeatTickSettingsActor | null, actor: SeatTickSettingsActor): boolean {
  if (!author || author.kind !== actor.kind) return false;
  if (actor.kind === "gateway") return true;
  return actor.kind !== "unidentified" && author.conversationId === actor.conversationId
    && author.project === actor.project && author.seatEpoch === actor.seatEpoch;
}

/** Each writer replaces its own block. Other authors' text, order and stamps
 * survive. Matching lines keep their first write date, including duplicates. */
export function replaceSeatTickInstructions(settings: Instructions, text: string | null, actor: SeatTickSettingsActor, at: string): SeatTickInstructionLine[] {
  const lines = seatTickInstructionLines(settings);
  const own = lines.filter(line => sameWriter(line.author, actor));
  const remaining = [...own];
  const replacement = text ? text.split("\n").map(text => {
    const index = remaining.findIndex(line => line.text === text);
    return index >= 0 ? remaining.splice(index, 1)[0]! : { text, author: actor, at };
  }) : [];
  const first = lines.findIndex(line => sameWriter(line.author, actor));
  const kept = lines.filter(line => !sameWriter(line.author, actor));
  const insertion = first < 0 ? kept.length : lines.slice(0, first).filter(line => !sameWriter(line.author, actor)).length;
  kept.splice(insertion, 0, ...replacement);
  return kept;
}

/** A line a seat or an agent session wrote for itself. Every other line is
 * the operator's: their own, and the older lines no author was recorded for
 * (#3091), which only the operator could have written. */
export function isSeatNote(line: SeatTickInstructionLine): boolean {
  return line.author?.kind === "manager" || line.author?.kind === "agent";
}

export function hasUnknownAuthor(line: SeatTickInstructionLine): boolean {
  return !line.author || line.author.kind === "unidentified";
}

/** The operator's editable field: every line that is not a seat note, in
 * stored order. */
export function operatorFieldText(settings: Instructions): string {
  return seatTickInstructionLines(settings).filter(line => !isSeatNote(line)).map(line => line.text).join("\n");
}

/** A seat note named by its place in the stored lines and what it records. */
export interface SeatNoteRemoval { index: number; text: string; at: string | null }

export const SEAT_NOTE_REMOVAL_STALE = "a seat note to remove is no longer stored as the panel read it. Nothing was stored — check the notes and save again";

/** An operator's edit of the instructions. `text` absent keeps the field's
 * lines as stored; `claimUnknown` makes the lines with no known author part of
 * the block `text` replaces. */
export interface SeatTickInstructionEdit {
  text?: string | null;
  claimUnknown?: boolean;
  removeSeatNotes?: unknown;
}

/** The lines an edit would store. The panel's counter and the server's limit
 * both count this, so the number on screen is the number the server checks.
 * Removals are matched against the stored lines before anything else; one that
 * no longer matches refuses the whole edit. */
export function previewSeatTickInstructions(settings: Instructions, edit: SeatTickInstructionEdit, actor: SeatTickSettingsActor, at: string):
  { ok: true; lines: SeatTickInstructionLine[] } | { ok: false; error: string } {
  let lines = seatTickInstructionLines(settings);
  if (edit.removeSeatNotes !== undefined) {
    const removals = edit.removeSeatNotes;
    if (!Array.isArray(removals) || removals.some(entry => !entry || typeof entry !== "object" || !Number.isInteger(entry.index) || entry.index < 0
      || typeof entry.text !== "string" || (entry.at !== null && typeof entry.at !== "string"))) {
      return { ok: false, error: "removeSeatNotes must be a list of { index, text, at } naming stored seat notes" };
    }
    const indexes = new Set<number>();
    for (const { index, text, at: written } of removals as SeatNoteRemoval[]) {
      const line = lines[index];
      if (indexes.has(index) || !line || !isSeatNote(line) || line.text !== text || line.at !== written) return { ok: false, error: SEAT_NOTE_REMOVAL_STALE };
      indexes.add(index);
    }
    lines = lines.filter((_, index) => !indexes.has(index));
  }
  if (edit.text === undefined) return { ok: true, lines };
  const remaining = { reason: lines.map(line => line.text).join("\n") || null, instructionLines: lines };
  if (!edit.claimUnknown) return { ok: true, lines: replaceSeatTickInstructions(remaining, edit.text, actor, at) };
  /* Lines with no known author join the actor's block for this write and keep
     their entries when kept. */
  const originals = new Map<SeatTickInstructionLine, SeatTickInstructionLine>();
  const claimed = lines.map(line => {
    if (!hasUnknownAuthor(line)) return line;
    const own = { ...line, author: actor };
    originals.set(own, line);
    return own;
  });
  return { ok: true, lines: replaceSeatTickInstructions({ reason: remaining.reason, instructionLines: claimed }, edit.text, actor, at).map(line => originals.get(line) ?? line) };
}

/** Wakes reserve this section in full. Dates stay on the stored lines and in
 * the panel; the wake groups their text under the authority it actually has. */
export function seatTickInstructionSections(settings: Instructions): string[] {
  const lines = seatTickInstructionLines(settings);
  const operator = lines.filter(line => line.author?.kind === "gateway");
  const notes = lines.filter(line => line.author && line.author.kind !== "gateway" && line.author.kind !== "unidentified");
  const unknown = lines.filter(line => !line.author || line.author.kind === "unidentified");
  const rendered: string[] = [];
  if (operator.length) rendered.push("", "Operator instructions for every wake:", ...operator.map(line => line.text));
  if (notes.length) {
    rendered.push("", "Seat notes for every wake:");
    let previous = "";
    for (const line of notes) {
      const author = line.author!;
      const label = author.kind === "manager" && author.seatEpoch !== null ? `Seat epoch ${author.seatEpoch}:` : "Agent session:";
      if (label !== previous) rendered.push(label);
      rendered.push(`> ${line.text}`);
      previous = label;
    }
  }
  if (unknown.length) rendered.push("", "Instructions — author unknown:", ...unknown.map(line => `> ${line.text}`));
  return rendered;
}
