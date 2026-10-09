"use client";

import { Check, ChevronRight, CircleAlert, LoaderCircle, SendHorizontal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EngineMark } from "@/components/EngineMark";
import { CopyButton } from "@/components/feed/CopyButton";
import { useLocale } from "@/lib/i18n";
import { laneLayout, type Rect, type Size } from "@/lib/voiceCompanion/placement";
import type { SessionTranscriptRecord, TranscriptEntry } from "@/lib/voiceCompanion/transcriptRecord";

/*
 * The whole conversation on demand (item 6 of docs/design/voice-delegatus-live-feedback.md). The character itself
 * opens it (a tap that does not move it, or Enter), so the companion gains no control. A 360 px glass panel beside
 * the character reads the session's transcript record: speech as bubbles with the speaker and the time over each
 * line and a copy control of its own, and every tool call and every request to the orchestrator as ONE line (the
 * tool and its outcome) that opens to its arguments, its result and its delivery steps. Text selects and copies.
 */

const LABELS = {
  en: { title: "Conversation", live: "in progress", ended: "ended", close: "Close", args: "Arguments", result: "Result", toVoice: "Passed to the voice", open: "Show the conversation", empty: "Nothing said yet.", truncated: "Part of the conversation is not kept: the record reached its size limit.", request: "Request to the orchestrator", instruction: "Instruction", steps: "Delivery steps", copyMessage: "Copy message", showDetails: "Show details", hideDetails: "Hide details", reports: { progress: "Progress", result: "Result", question: "Question", blocked: "Blocked" } },
  uk: { title: "Розмова", live: "триває", ended: "завершено", close: "Закрити", args: "Аргументи", result: "Результат", toVoice: "Передано голосу", open: "Показати розмову", empty: "Ще нічого не сказано.", truncated: "Частина розмови не збереглася: запис досяг межі розміру.", request: "Запит оркестратору", instruction: "Доручення", steps: "Кроки доставки", copyMessage: "Скопіювати повідомлення", showDetails: "Показати подробиці", hideDetails: "Сховати подробиці", reports: { progress: "Хід роботи", result: "Результат", question: "Питання", blocked: "Заблоковано" } },
} as const;
export const transcriptLabels = (locale: string) => LABELS[locale === "uk" ? "uk" : "en"];

/* The panel's box beside the character. */
const SIZE = { width: 360, height: 560 };

/** The panel's box in the viewport: placed as the lane is, facing the middle of the screen, flipping at an edge. */
export function transcriptRect(viewport: Size, block: Rect): Rect {
  return laneLayout(viewport, block, Math.min(SIZE.height, viewport.height - 16), Math.min(SIZE.width, viewport.width - 16)).rect;
}

type Status = "running" | "done" | "failed";
type Row =
  | { kind: "speech"; key: string; atMs: number; speaker: "operator" | "companion"; text: string }
  | { kind: "call"; key: string; atMs: number; name: string; status: Status; args: string; result: string | null; reason: string | null; handoffs: string[] }
  | { kind: "request"; key: string; atMs: number; instruction: string; stage: string; reason: string | null; engine: "claude" | "codex" | null;
      states: Array<{ atMs: number; status: string }>; args: string | null; result: string | null; answers: Array<{ key: string; atMs: number; text: string; status: string | null }> };

const str = (value: unknown) => (typeof value === "string" ? value : null);
const STAGE: Record<string, string> = { proposed: "proposed", sending: "sending", awaiting_confirmation: "awaiting-confirmation", queued: "queued", delivered: "delivered", unknown: "unknown", failed: "failed", refused: "refused", cancelled: "cancelled", sent: "delivered" };

/** The record as rows: speech, each call with what was passed to the voice after it, and each request with
    its own call, its delivery and every report it brought back, in order, together. A call no request row holds (the spoken answer to a
    confirmation, a repeated request) is a row of its own. Live's own hand-off markers carry nothing to read and are left out. */
export function transcriptRows(entries: readonly TranscriptEntry[]): Row[] {
  const sorted = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rows: Row[] = [];
  const requests = new Map<string, Extract<Row, { kind: "request" }>>();
  const calls = new Map<string, Extract<Row, { kind: "call" }>>();
  const tools = new Map<string, TranscriptEntry>();
  for (const entry of sorted) if (entry.kind === "tool" && str(entry.data.callId)) tools.set(entry.data.callId as string, entry);
  /* The calls a request row shows inside itself. */
  const folded = new Set<string>();
  for (const entry of sorted) if (entry.kind === "request" && tools.has(str(entry.data.callId) ?? entry.id)) folded.add(str(entry.data.callId) ?? entry.id);
  for (const entry of sorted) {
    const data = entry.data;
    if (entry.kind === "utterance" || entry.kind === "reply") {
      const text = str(data.text)?.trim();
      if (text) rows.push({ kind: "speech", key: entry.id, atMs: entry.atMs, speaker: entry.kind === "utterance" ? "operator" : "companion", text });
    } else if (entry.kind === "tool" && !folded.has(str(data.callId) ?? "")) {
      const row: Row = { kind: "call", key: entry.id, atMs: entry.atMs, name: str(data.name) ?? "", status: (str(data.status) as Status) ?? "running", args: str(data.arguments) ?? "", result: str(data.result), reason: str(data.reason), handoffs: [] };
      rows.push(row);
      if (str(data.delegationId)) calls.set(data.delegationId as string, row);
    } else if (entry.kind === "request") {
      const callId = str(data.callId) ?? entry.id;
      const tool = tools.get(callId);
      const recipient = data.recipient as { engine?: "claude" | "codex" } | undefined;
      const row: Extract<Row, { kind: "request" }> = {
        kind: "request", key: entry.id, atMs: entry.atMs, instruction: str(data.instruction) ?? "", stage: STAGE[str(data.status) ?? ""] ?? "proposed", reason: str(data.reason),
        engine: recipient?.engine ?? null, states: Array.isArray(data.states) ? (data.states as Array<{ atMs: number; status: string }>) : [],
        args: tool ? str(tool.data.arguments) : null, result: tool ? str(tool.data.result) : null, answers: [],
      };
      rows.push(row);
      requests.set(callId, row);
    } else if (entry.kind === "report") {
      const request = requests.get(str((data.delivery as { callId?: string } | undefined)?.callId) ?? "");
      if (request) request.answers.push({ key: entry.id, atMs: entry.atMs, text: str(data.text) ?? "", status: str(data.status) });
    } else if (entry.kind === "handoff") {
      calls.get(str(data.delegationId) ?? "")?.handoffs.push(str(data.text) ?? "");
    }
  }
  return rows;
}

/** A sent request nothing has answered for yet. The server records its report whenever it arrives, the voice
    session open or not, so a record that holds one is read again until the answer lands. */
export const awaitsReport = (record: SessionTranscriptRecord): boolean =>
  transcriptRows(record.entries).some((row) => row.kind === "request" && (row.stage === "queued" || row.stage === "delivered") && !row.answers.some((answer) => answer.status !== "progress"));

export const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The `speech` field of a call's result, the text the voice is handed as the result itself. */
const spokenResult = (result: string | null): string | null => {
  if (!result) return null;
  try { return str((JSON.parse(result) as { speech?: unknown } | null)?.speech)?.trim() ?? null; } catch { return null; }
};

/** A line that opens: one row with a chevron, the detail under it only while open. Closed by default. */
function Disclosure({ summary, children, name, label }: { summary: ReactNode; children: ReactNode; name: string; label: { show: string; hide: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="vc-tr-call" data-transcript-call={name} data-open={open ? "" : undefined}>
      <button type="button" className="vc-tr-toggle" data-transcript-toggle aria-expanded={open} title={open ? label.hide : label.show} onClick={() => setOpen((value) => !value)}>
        {summary}
        <ChevronRight size={14} className="vc-tr-chev" aria-hidden />
      </button>
      {open ? <div className="vc-tr-detail" data-transcript-detail>{children}</div> : null}
    </div>
  );
}

export function CompanionTranscript({ record, left, top, width, height, onClose }: {
  record: SessionTranscriptRecord;
  /* The box, from the companion's own corner. */
  left: number; top: number; width: number; height: number;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const L = transcriptLabels(locale);
  const rows = useMemo(() => transcriptRows(record.entries), [record.entries]);
  const ended = record.entries.some((entry) => entry.kind === "session_end");
  const last = record.entries.reduce((max, entry) => Math.max(max, entry.atMs, typeof entry.data.endMs === "number" ? entry.data.endMs : 0), 0);
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /* Opened at its newest line, as the lane shows it, and following new lines until the reader scrolls back. */
  const following = useRef(true);
  useLayoutEffect(() => { if (following.current && body.current) body.current.scrollTop = body.current.scrollHeight; }, [rows]);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);

  const who = (speaker: "operator" | "companion") => (speaker === "operator" ? t("voiceCompanion.you") : "Delegatus");
  const stageLine = (stage: string) => t(`voiceCompanion.stage.${stage}` as "voiceCompanion.stage.delivered");
  const label = { show: L.showDetails, hide: L.hideDetails };

  const icon = (status: Status) => (status === "running" ? <LoaderCircle size={14} className="vc-spin" /> : status === "done" ? <Check size={14} /> : <X size={14} />);
  /* A call: one line, the tool and its outcome; opened, what it was asked and what it answered. */
  const call = (row: Extract<Row, { kind: "call" }>) => (
    <Disclosure
      name={row.name}
      label={label}
      summary={(
        <span className="vc-call" data-status={row.status} data-tool={row.name}>
          <span className="vc-call-icon" aria-hidden>{icon(row.status)}</span>
          <span className="vc-call-body"><span className="vc-call-name">{row.name}</span></span>
          <span className="vc-call-state">{t(`voiceCompanion.call.${row.status}`)}</span>
        </span>
      )}
    >
      {/* The header says failed and the result carries the reason; the reason stands alone only when there is no result. */}
      {row.reason && !row.result ? <p className="vc-tr-reason" data-status={row.status}>{row.reason}</p> : null}
      <span className="vc-tr-label">{L.args}</span>
      <pre className="vc-tr-pre">{row.args}</pre>
      {row.result ? <><span className="vc-tr-label">{L.result}</span><pre className="vc-tr-pre" data-status={row.status}>{row.result}</pre></> : null}
      {row.handoffs.filter((text) => text.trim() !== spokenResult(row.result)).map((text, index) => <p key={index} className="vc-tr-handoff"><span className="vc-tr-label">{L.toVoice}</span> {text}</p>)}
    </Disclosure>
  );
  /* A request to the orchestrator: one line with its delivery outcome; opened, the instruction, each delivery step and the raw call. */
  const request = (row: Extract<Row, { kind: "request" }>) => {
    const failed = row.stage === "failed" || row.stage === "refused" || row.stage === "unknown";
    return (
      <>
        <Disclosure
          name="request_orchestrator_delegation"
          label={label}
          summary={(
            <span className="vc-call" data-status={failed ? "failed" : row.stage === "delivered" || row.stage === "queued" ? "done" : "running"} data-stage={row.stage} data-transcript-request>
              <span className="vc-call-icon" aria-hidden>{failed ? <CircleAlert size={14} /> : row.stage === "delivered" || row.stage === "queued" ? <Check size={14} /> : <SendHorizontal size={14} />}</span>
              <span className="vc-call-body"><span className="vc-call-name" data-human-label>{L.request}</span></span>
              {row.engine ? <span className="vc-deleg-engine"><EngineMark engine={row.engine} size={14} /></span> : null}
              <span className="vc-call-state">{stageLine(row.stage)}</span>
            </span>
          )}
        >
          <span className="vc-tr-label">{L.instruction}</span>
          <p className="vc-instruction">{row.instruction}</p>
          {row.reason ? <p className="vc-deleg-note">{row.reason}</p> : null}
          <span className="vc-tr-label">{L.steps}</span>
          <ol className="vc-tr-states">{row.states.map((state, index) => <li key={index}><span className="vc-tr-time">{clock(state.atMs)}</span>{stageLine(STAGE[state.status] ?? state.status)}</li>)}</ol>
          {row.args ? <><span className="vc-tr-label">{L.args}</span><pre className="vc-tr-pre">{row.args}</pre></> : null}
          {row.args && row.result ? <><span className="vc-tr-label">{L.result}</span><pre className="vc-tr-pre">{row.result}</pre></> : null}
        </Disclosure>
        {row.answers.map((answer) => (
          <div key={answer.key} className="vc-call vc-deleg vc-reply" data-stage="answered" data-report-status={answer.status ?? undefined} data-transcript-answer>
            <div className="vc-deleg-head">
              <span className="vc-call-icon" aria-hidden><Check size={14} /></span>
              <span className="vc-deleg-title">{t("voiceCompanion.stage.answered")}{answer.status && answer.status in L.reports ? ` · ${L.reports[answer.status as keyof typeof L.reports]}` : ""}</span>
              <span className="vc-tr-time vc-tr-push">{clock(answer.atMs)}</span>
              <CopyButton text={answer.text} label={L.copyMessage} className="vc-tr-copy" />
            </div>
            <p className="vc-answer">{answer.text}</p>
          </div>
        ))}
      </>
    );
  };

  const item = (row: Row) => {
    if (row.kind === "speech") {
      return (
        <li key={row.key} className="vc-tr-row" data-kind="speech" data-speaker={row.speaker}>
          <span className="vc-tr-meta"><span className="vc-tr-who">{who(row.speaker)}</span><span className="vc-tr-time">{clock(row.atMs)}</span><CopyButton text={row.text} label={L.copyMessage} className="vc-tr-copy" /></span>
          <p className="vc-bubble" data-speaker={row.speaker}><span className="vc-text" data-transcript-text>{row.text}</span></p>
        </li>
      );
    }
    return <li key={row.key} className="vc-tr-row" data-kind={row.kind}>{row.kind === "call" ? call(row) : request(row)}</li>;
  };

  return (
    <div
      ref={panel}
      className="vc-tr"
      data-companion-transcript-view
      role="dialog"
      aria-label={L.title}
      tabIndex={-1}
      style={{ left, top, width, height }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <div className="vc-tr-head">
        <span className="vc-tr-title">{L.title}</span>
        <span className="vc-tr-sub">{ended ? L.ended : L.live} · {clock(last)}</span>
        <button type="button" className="vc-btn vc-tr-close" aria-label={L.close} title={L.close} data-transcript-close onClick={onClose}><X size={14} aria-hidden /></button>
      </div>
      <div ref={body} className="vc-tr-body" data-transcript-body onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 40; }}>
        {record.truncated ? <p className="vc-deleg-note vc-deleg-wait">{L.truncated}</p> : null}
        {rows.length ? <ol className="vc-tr-list">{rows.map(item)}</ol> : <p className="vc-deleg-note vc-deleg-wait">{L.empty}</p>}
      </div>
    </div>
  );
}

/* Every colour a product token, as in the companion's own sheet: the bubbles' glass as one panel. */
export const TRANSCRIPT_CSS = `
/* While the conversation is open, it stands where the lane was; the lane comes back as it closes. */
.vc-lane[data-reading] { visibility: hidden; }
.vc-figure[aria-expanded="true"]::before { box-shadow: 0 0 0 2px var(--vc-ring), 0 0 0 5px color-mix(in srgb, var(--vc-ring) 22%, transparent); }
.vc-tr {
  position: absolute; display: flex; flex-direction: column; pointer-events: auto; outline: none; color: var(--color-primary);
  animation: vc-in 160ms var(--vc-ease);
  border-radius: 16px; box-shadow: var(--shadow-2); overflow: hidden;
  background: color-mix(in srgb, var(--color-raised) 94%, transparent); border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
}
.vc-tr-head { display: flex; align-items: center; gap: 8px; flex: none; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--color-border); }
.vc-tr-title { font-size: 13px; font-weight: 700; }
.vc-tr-sub { font-size: 11.5px; color: var(--color-secondary); white-space: nowrap; }
.vc-tr-close { margin-left: auto; width: 26px; height: 26px; box-shadow: none; }
.vc-tr-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; user-select: text; padding: 10px 12px 12px; }
.vc-tr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.vc-tr-row { display: flex; flex-direction: column; min-width: 0; }
.vc-tr-row[data-speaker="operator"] { align-items: flex-end; }
.vc-tr-row[data-speaker="companion"] { align-items: flex-start; }
.vc-tr .vc-bubble { max-width: 88%; cursor: text; }
.vc-tr .vc-bubble[data-speaker="companion"] { box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
.vc-tr .vc-call { cursor: default; }
.vc-tr .vc-deleg, .vc-tr .vc-call.vc-deleg { width: auto; max-height: none; }
.vc-tr .vc-instruction, .vc-tr .vc-answer, .vc-tr .vc-deleg-note { max-height: none; overflow: visible; }
.vc-tr-meta { display: flex; align-items: center; gap: 6px; margin: 0 4px 3px; }
.vc-tr-row[data-speaker="operator"] .vc-tr-meta { flex-direction: row-reverse; }
.vc-tr-copy { opacity: 0.7; }
.vc-tr-copy:hover, .vc-tr-copy:focus-visible { opacity: 1; }
.vc-tr-time { font-family: var(--font-mono); font-size: 10.5px; color: var(--color-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.vc-tr-push { margin-left: auto; font-weight: 500; }
.vc-tr-who { font-weight: 700; font-size: 11.5px; }
.vc-tr-label { font-size: 10.5px; font-weight: 700; color: var(--color-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.vc-tr-toggle { position: relative; display: block; width: 100%; margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; border-radius: 12px; }
.vc-tr-toggle:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.vc-tr-toggle .vc-call { cursor: pointer; }
.vc-tr .vc-call-name[data-human-label] { font-family: inherit; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-tr-chev { position: absolute; right: 10px; top: calc(50% - 7px); color: var(--color-muted); transition: transform 150ms ease-out; pointer-events: none; }
.vc-tr-toggle[aria-expanded="true"] .vc-tr-chev { transform: rotate(90deg); }
.vc-tr-toggle .vc-call { display: flex; padding-right: 30px; }
.vc-tr-detail { display: flex; flex-direction: column; gap: 3px; padding: 6px 2px 2px; min-width: 0; }
.vc-tr-reason { margin: 0; font-size: 12px; line-height: 16px; color: var(--color-secondary); }
.vc-tr-pre {
  margin: 0 0 4px; padding: 6px 8px; font: 11px/15px var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
  background: var(--color-sunken); border: 1px solid var(--color-border); border-radius: 8px; color: var(--color-primary);
}
.vc-tr-pre[data-status="failed"] { border-color: color-mix(in srgb, var(--color-danger) 40%, transparent); background: color-mix(in srgb, var(--color-danger-soft) 60%, var(--color-sunken)); }
.vc-tr-handoff { margin: 0; font-size: 12px; line-height: 16px; color: var(--color-secondary); }
.vc-tr-states { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11.5px; color: var(--color-secondary); }
.vc-tr-states li { display: inline-flex; align-items: baseline; gap: 4px; }
`;
