import { redactMonitorText } from "./redact";
import type { SeatTickCheckInput, SeatTickFormPage } from "./types";

const text = (value: string, limit: number) => redactMonitorText(value).replace(/\s+/g, " ").slice(0, limit);
export function seatTickFormPage(input: SeatTickCheckInput): SeatTickFormPage | undefined {
  if (input.workerAsksObserved === false) return { lines: ["Open decision forms: not read this check (budget or source failure); the next check reads them."], rows: [] };
  const forms = input.decisionForms;
  if (!forms?.rows.length) return undefined;
  const ordered = [...forms.rows].sort((a, b) => Number(b.stale) - Number(a.stale) || (Date.parse(a.since ?? "") || 0) - (Date.parse(b.since ?? "") || 0) || a.id.localeCompare(b.id));
  const after = ordered.findIndex(row => row.id === input.state.formPageAfter);
  const start = after < 0 || after === ordered.length - 1 ? 0 : after + 1;
  const rows: SeatTickFormPage["rows"] = [];
  let length = 0;
  for (const row of ordered.slice(start)) {
    const facts = row.evidence.filter(fact => typeof fact !== "string");
    const hints = facts.filter(f => f.code === "earlier-seat" || f.code === "elsewhere").map(f => f.code);
    const status = facts.some(f => f.code === "undelivered") ? "answered; delivery pending" : "current";
    const currency = row.stale ? `STALE: ${facts.filter(f => f.stale).map(f => `${f.code} — ${f.detail}`).join("; ")}` : [status, ...hints].join("; ");
    const age = row.since ? `${Math.max(0, Math.floor((input.now - Date.parse(row.since)) / 3_600_000))}h` : "unknown";
    const id = row.subject.reviewId ?? row.subject.pipelineId ?? row.id;
    const line = `- ${row.kind} ${id} | ${row.taskId ? `task ${row.taskId}` : row.kind === "prototype" ? "seat form" : "lane"} | asked ${age} ago | ${text(currency, 140)} | ${text(row.title, 80)}`;
    if (rows.length === 8 || length + line.length + 1 > 750) break;
    rows.push({ id: row.id, line }); length += line.length + 1;
  }
  return { lines: [
    `Open decision forms: ${forms.count} waiting on the operator; ${forms.routedToSeat ?? 0} lane decisions wait on you (Waiting on seat). Rows ${start + 1}–${start + rows.length} of ${ordered.length}; the next wake continues.`,
    'Withdraw stale forms with dismiss_attention target {kind:"prototype", taskId, reviewId} (taskId null for a seat form); refresh by publishing a new round, then withdraw the old one.',
    ...rows.map(row => row.line),
  ], rows };
}

export function validFormPage(value: unknown): value is import("./types").SeatTickFormPage {
  if (!value || typeof value !== "object") return false;
  const page = value as import("./types").SeatTickFormPage;
  return Array.isArray(page.lines) && page.lines.every(line => typeof line === "string") && page.lines.join("\n").length <= 1200
    && Array.isArray(page.rows) && page.rows.length <= 8 && page.rows.every(row => typeof row?.id === "string" && row.id.length > 0 && row.id.length <= 500 && typeof row.line === "string" && !row.line.includes("\n") && page.lines.includes(row.line));
}
