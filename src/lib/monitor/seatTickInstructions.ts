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
