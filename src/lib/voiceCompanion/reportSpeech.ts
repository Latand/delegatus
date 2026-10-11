import type { BridgeReportV1 } from "@/lib/bridge/types";

/** The report the voice relays, one line per item: the uncut copy when the
 * display body left items out, else the body without its header line, which
 * names the project, kind and time the voice states itself. */
export function voiceReportText(report: Pick<BridgeReportV1, "body" | "complete" | "origin">): string {
  const complete = report.complete;
  if (complete) return [complete.summary, ...complete.sections.flatMap(section => [`${section.heading}:`, ...section.items.map(item => `- ${item}`)]),
    ...(complete.omitted ? [`(${complete.omitted} more item(s) only in the report log.)`] : [])].filter(Boolean).join("\n");
  const lines = report.body.split("\n").map(line => line.trim()).filter(Boolean);
  return (report.origin?.kind === "manager" && lines.length > 1 && lines[0]!.includes(" · ") ? lines.slice(1) : lines).join("\n");
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** One line cut into pieces of at most `limit` bytes: at sentence ends, then
 * between words, then between characters. Nothing is dropped. */
function pieces(line: string, limit: number): string[] {
  if (bytes(line) <= limit) return [line];
  const units = line.split(/(?<=[.!?…;])\s+/u).flatMap(sentence => bytes(sentence) <= limit ? [sentence]
    : sentence.split(/\s+/u).flatMap(word => {
      if (bytes(word) <= limit) return [word];
      const runs: string[] = [];
      let run = "";
      for (const char of word) {
        if (bytes(run + char) > limit) { runs.push(run); run = ""; }
        run += char;
      }
      return run ? [...runs, run] : runs;
    }));
  const out: string[] = [];
  let current = "";
  for (const unit of units) {
    const joined = current ? `${current} ${unit}` : unit;
    if (bytes(joined) <= limit) current = joined;
    else { if (current) out.push(current); current = unit; }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Report text split into ordered appends of at most `limit` bytes each. The
 * first carries `intro`, every later one `continued`; whole lines stay
 * together where they fit, and a longer line continues in the next append.
 */
export function speechParts(intro: string, text: string, continued: string, limit: number): string[] {
  const room = limit - bytes(continued) - 1;
  if (bytes(intro) > limit || room < 16) throw new Error("SPEECH_FRAME_TOO_LONG");
  const parts: string[] = [];
  let current = intro;
  for (const line of text.split("\n").map(row => row.trim()).filter(Boolean)) for (const piece of pieces(line, room)) {
    const joined = `${current}\n${piece}`;
    if (bytes(joined) <= limit) { current = joined; continue; }
    parts.push(current);
    current = `${continued}\n${piece}`;
  }
  parts.push(current);
  return parts;
}
