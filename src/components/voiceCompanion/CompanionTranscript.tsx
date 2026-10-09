"use client";

import { Check, ChevronRight, CircleAlert, Copy, LoaderCircle, SendHorizontal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { EngineMark } from "@/components/EngineMark";
import { useLocale } from "@/lib/i18n";
import { laneLayout, type Rect, type Size } from "@/lib/voiceCompanion/placement";
import type { SessionTranscriptRecord, TranscriptEntry } from "@/lib/voiceCompanion/transcriptRecord";

/*
 * The whole conversation on demand (item 6 of docs/design/voice-delegatus-live-feedback.md), PROTOTYPE: three
 * numbered variants for the operator to pick from. The character itself opens it (a tap that does not move it,
 * or Enter), so the companion gains no control. It reads the session's transcript record and shows every
 * utterance, reply, tool call with its arguments and result, and the request to the orchestrator with its
 * delivery and answer, as text that selects and copies with its speaker. The interface stage keeps the variant
 * the operator picks and deletes the others.
 *
 * 1 · The lane, scrolled back: the floating lane's own bubbles and cards, every one of them, in the lane's column.
 * 2 · A glass sheet: a wider panel beside the character, speech as bubbles, a call opens to its arguments and result.
 * 3 · A reader: a wide panel set as a document, times in a gutter, every call's arguments and result shown, Copy all.
 */

export type TranscriptVariant = 1 | 2 | 3;

const LABELS = {
  en: { title: "Conversation", live: "in progress", ended: "ended", close: "Close", args: "Arguments", result: "Result", toVoice: "Passed to the voice", copyAll: "Copy all", copied: "Copied", open: "Show the conversation", empty: "Nothing said yet.", truncated: "The earliest part is not kept: the record reached its size limit.", sent: "Sent to the orchestrator", answer: "Orchestrator's answer" },
  uk: { title: "Розмова", live: "триває", ended: "завершено", close: "Закрити", args: "Аргументи", result: "Результат", toVoice: "Передано голосу", copyAll: "Скопіювати все", copied: "Скопійовано", open: "Показати розмову", empty: "Ще нічого не сказано.", truncated: "Найраніша частина не збереглася: запис досяг межі розміру.", sent: "Надіслано оркестратору", answer: "Відповідь оркестратора" },
} as const;
export const transcriptLabels = (locale: string) => LABELS[locale === "uk" ? "uk" : "en"];

/* Each variant's box beside the character: its width and the tallest it grows to. */
const SIZE: Record<TranscriptVariant, { width: number; height: number }> = { 1: { width: 280, height: 520 }, 2: { width: 360, height: 560 }, 3: { width: 460, height: 640 } };

/** The view's box in the viewport: placed as the lane is, facing the middle of the screen, flipping at an edge. */
export function transcriptRect(variant: TranscriptVariant, viewport: Size, block: Rect): Rect {
  const { width, height } = SIZE[variant];
  return laneLayout(viewport, block, Math.min(height, viewport.height - 16), Math.min(width, viewport.width - 16)).rect;
}

type Status = "running" | "done" | "failed";
type Row =
  | { kind: "speech"; key: string; atMs: number; speaker: "operator" | "companion"; text: string }
  | { kind: "call"; key: string; atMs: number; name: string; status: Status; args: string; result: string | null; reason: string | null; handoffs: string[] }
  | { kind: "request"; key: string; atMs: number; instruction: string; stage: string; reason: string | null; engine: "claude" | "codex" | null;
      states: Array<{ atMs: number; status: string }>; args: string | null; result: string | null; answer: { atMs: number; text: string } | null };

const str = (value: unknown) => (typeof value === "string" ? value : null);
const STAGE: Record<string, string> = { proposed: "proposed", sending: "sending", awaiting_confirmation: "awaiting-confirmation", queued: "queued", delivered: "delivered", unknown: "unknown", failed: "failed", refused: "refused", cancelled: "cancelled", sent: "delivered" };
const DELEGATION_TOOLS = new Set(["request_orchestrator_delegation", "resolve_orchestrator_confirmation"]);

/** The record as rows: speech, each read call with what was passed to the voice after it, and each request with
    its call, its delivery and its answer together. Live's own hand-off markers carry nothing to read and are left out. */
export function transcriptRows(entries: readonly TranscriptEntry[]): Row[] {
  const sorted = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rows: Row[] = [];
  const requests = new Map<string, Extract<Row, { kind: "request" }>>();
  const calls = new Map<string, Extract<Row, { kind: "call" }>>();
  const tools = new Map<string, TranscriptEntry>();
  for (const entry of sorted) if (entry.kind === "tool" && str(entry.data.callId)) tools.set(entry.data.callId as string, entry);
  for (const entry of sorted) {
    const data = entry.data;
    if (entry.kind === "utterance" || entry.kind === "reply") {
      const text = str(data.text)?.trim();
      if (text) rows.push({ kind: "speech", key: entry.id, atMs: entry.atMs, speaker: entry.kind === "utterance" ? "operator" : "companion", text });
    } else if (entry.kind === "tool" && !DELEGATION_TOOLS.has(str(data.name) ?? "")) {
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
        args: tool ? str(tool.data.arguments) : null, result: tool ? str(tool.data.result) : null, answer: null,
      };
      rows.push(row);
      requests.set(callId, row);
    } else if (entry.kind === "report") {
      const request = requests.get(str((data.delivery as { callId?: string } | undefined)?.callId) ?? "");
      if (request) request.answer = { atMs: entry.atMs, text: str(data.text) ?? "" };
    } else if (entry.kind === "handoff") {
      calls.get(str(data.delegationId) ?? "")?.handoffs.push(str(data.text) ?? "");
    }
  }
  return rows;
}

export const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function CompanionTranscript({ variant, record, left, top, width, height, onClose }: {
  variant: TranscriptVariant;
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
  const [copied, setCopied] = useState(false);
  /* Opened at its newest line, as the lane shows it; scrolled back from there. */
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, []);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);

  const who = (speaker: "operator" | "companion") => (speaker === "operator" ? t("voiceCompanion.you") : "Delegatus");
  const stageLine = (stage: string) => t(`voiceCompanion.stage.${stage}` as "voiceCompanion.stage.delivered");
  const plain = () => rows.map((row) => {
    if (row.kind === "speech") return `[${clock(row.atMs)}] ${who(row.speaker)}: ${row.text}`;
    if (row.kind === "call") return `[${clock(row.atMs)}] ${row.name} (${t(`voiceCompanion.call.${row.status}`)})\n${L.args}: ${row.args}${row.result ? `\n${L.result}: ${row.result}` : ""}`;
    return `[${clock(row.atMs)}] ${L.sent}: ${row.instruction} (${stageLine(row.stage)})${row.answer ? `\n[${clock(row.answer.atMs)}] ${t("voiceCompanion.orchestrator")}: ${row.answer.text}` : ""}`;
  }).join("\n\n");

  const icon = (status: Status) => (status === "running" ? <LoaderCircle size={14} className="vc-spin" /> : status === "done" ? <Check size={14} /> : <X size={14} />);
  /* A call: its card, and under it what it was asked and what it answered. 1 and 2 open it on a tap; 3 shows it. */
  const call = (row: Extract<Row, { kind: "call" }>) => {
    const card = (
      <span className="vc-call" data-status={row.status} data-tool={row.name}>
        <span className="vc-call-icon" aria-hidden>{icon(row.status)}</span>
        <span className="vc-call-body">
          <span className="vc-call-name">{row.name}</span>
          {row.status === "failed" && row.reason ? <span className="vc-call-line">{row.reason}</span> : null}
        </span>
        <span className="vc-call-state">{t(`voiceCompanion.call.${row.status}`)}</span>
        {variant !== 3 ? <ChevronRight size={14} className="vc-tr-chev" aria-hidden /> : null}
      </span>
    );
    const detail = (
      <div className="vc-tr-detail">
        <span className="vc-tr-label">{L.args}</span>
        <pre className="vc-tr-pre">{row.args}</pre>
        {row.result ? <><span className="vc-tr-label">{L.result}</span><pre className="vc-tr-pre" data-status={row.status}>{row.result}</pre></> : null}
        {variant === 3 ? row.handoffs.map((text, index) => <p key={index} className="vc-tr-handoff"><span className="vc-tr-label">{L.toVoice}</span> {text}</p>) : null}
      </div>
    );
    if (variant === 3) return <div className="vc-tr-callrow">{card}{detail}</div>;
    return <details className="vc-tr-call" data-transcript-call={row.name}><summary>{card}</summary>{detail}</details>;
  };
  const request = (row: Extract<Row, { kind: "request" }>) => {
    const failed = row.stage === "failed" || row.stage === "refused" || row.stage === "unknown";
    const head = (
      <div className="vc-deleg-head">
        <span className="vc-call-icon" aria-hidden>{failed ? <CircleAlert size={14} /> : row.stage === "delivered" || row.stage === "queued" ? <Check size={14} /> : <SendHorizontal size={14} />}</span>
        <span className="vc-deleg-title">{stageLine(row.stage)}</span>
        {row.engine ? <span className="vc-deleg-engine"><EngineMark engine={row.engine} size={14} />{row.engine === "codex" ? "Codex" : "Claude"}</span> : null}
      </div>
    );
    const states = <ol className="vc-tr-states">{row.states.map((state, index) => <li key={index}><span className="vc-tr-time">{clock(state.atMs)}</span>{stageLine(STAGE[state.status] ?? state.status)}</li>)}</ol>;
    const raw = row.args ? (
      <div className="vc-tr-detail">
        <span className="vc-tr-label">{L.args}</span><pre className="vc-tr-pre">{row.args}</pre>
        {row.result ? <><span className="vc-tr-label">{L.result}</span><pre className="vc-tr-pre">{row.result}</pre></> : null}
      </div>
    ) : null;
    return (
      <>
        <div className="vc-call vc-deleg" data-stage={row.stage} data-transcript-request>
          {head}
          <span className="vc-call-name">request_orchestrator_delegation</span>
          <p className="vc-instruction">{row.instruction}</p>
          {row.reason ? <p className="vc-deleg-note">{row.reason}</p> : null}
          {variant === 1 ? null : states}
          {variant === 3 ? raw : raw ? <details className="vc-tr-call vc-tr-raw"><summary><span className="vc-tr-label">{L.args} · {L.result}</span><ChevronRight size={13} className="vc-tr-chev" aria-hidden /></summary>{raw}</details> : null}
        </div>
        {row.answer ? (
          <div className="vc-call vc-deleg vc-reply" data-stage="answered" data-transcript-answer>
            <div className="vc-deleg-head">
              <span className="vc-call-icon" aria-hidden><Check size={14} /></span>
              <span className="vc-deleg-title">{t("voiceCompanion.stage.answered")}</span>
              {variant !== 1 ? <span className="vc-tr-time vc-tr-push">{clock(row.answer.atMs)}</span> : null}
            </div>
            <p className="vc-answer">{row.answer.text}</p>
          </div>
        ) : null}
      </>
    );
  };

  const item = (row: Row) => {
    if (variant === 3) {
      const label = row.kind === "speech" ? who(row.speaker) : row.kind === "call" ? row.name : L.sent;
      return (
        <li key={row.key} className="vc-tr-doc" data-kind={row.kind} data-speaker={row.kind === "speech" ? row.speaker : undefined}>
          <span className="vc-tr-time">{clock(row.atMs)}</span>
          <div className="vc-tr-entry">
            {row.kind === "speech" ? <p className="vc-tr-said"><span className="vc-tr-who">{label}</span>{row.text}</p> : row.kind === "call" ? call(row) : request(row)}
          </div>
        </li>
      );
    }
    if (row.kind === "speech") {
      return (
        <li key={row.key} className="vc-tr-row" data-kind="speech" data-speaker={row.speaker}>
          {variant === 2 ? <span className="vc-tr-meta"><span className="vc-tr-who">{who(row.speaker)}</span><span className="vc-tr-time">{clock(row.atMs)}</span></span> : null}
          <p className="vc-bubble" data-speaker={row.speaker}>
            {variant === 1 ? <span className={row.speaker === "operator" ? "vc-who" : "vc-sr"}>{who(row.speaker)}{row.speaker === "operator" ? "" : ": "}</span> : null}
            <span className="vc-text">{row.text}</span>
          </p>
        </li>
      );
    }
    return <li key={row.key} className="vc-tr-row" data-kind={row.kind}>{row.kind === "call" ? call(row) : request(row)}</li>;
  };

  const copyAll = async () => {
    try { await navigator.clipboard.writeText(plain()); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* selection still copies */ }
  };

  return (
    <div
      ref={panel}
      className="vc-tr"
      data-variant={variant}
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
        {variant === 3 ? <button type="button" className="vc-act vc-tr-copy" data-transcript-copy onClick={copyAll}><Copy size={13} aria-hidden />{copied ? L.copied : L.copyAll}</button> : null}
        <button type="button" className="vc-btn vc-tr-close" aria-label={L.close} title={L.close} data-transcript-close onClick={onClose}><X size={14} aria-hidden /></button>
      </div>
      <div ref={body} className="vc-tr-body" data-transcript-body>
        {record.truncated ? <p className="vc-deleg-note vc-deleg-wait">{L.truncated}</p> : null}
        {rows.length ? <ol className="vc-tr-list">{rows.map(item)}</ol> : <p className="vc-deleg-note vc-deleg-wait">{L.empty}</p>}
      </div>
    </div>
  );
}

/* Every colour a product token, as in the companion's own sheet; 1 keeps the lane's open glass, 2 a glass sheet, 3 a solid page. */
export const TRANSCRIPT_CSS = `
/* While the conversation is open, it stands where the lane was; the lane comes back as it closes. */
.vc-lane[data-reading] { visibility: hidden; }
.vc-figure[aria-expanded="true"]::before { box-shadow: 0 0 0 2px var(--vc-ring), 0 0 0 5px color-mix(in srgb, var(--vc-ring) 22%, transparent); }
.vc-tr {
  position: absolute; display: flex; flex-direction: column; pointer-events: auto; outline: none; color: var(--color-primary);
  animation: vc-in 160ms var(--vc-ease);
}
.vc-tr-head { display: flex; align-items: center; gap: 8px; flex: none; }
.vc-tr-title { font-size: 13px; font-weight: 700; }
.vc-tr-sub { font-size: 11.5px; color: var(--color-secondary); white-space: nowrap; }
.vc-tr-close { margin-left: auto; width: 26px; height: 26px; box-shadow: none; }
.vc-tr-copy + .vc-tr-close { margin-left: 0; }
.vc-tr-copy { margin-left: auto; height: 26px; padding: 0 10px; font-size: 12px; }
.vc-tr-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; user-select: text; }
.vc-tr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.vc-tr-row { display: flex; flex-direction: column; min-width: 0; }
.vc-tr .vc-bubble { max-width: 100%; cursor: text; }
.vc-tr .vc-call { cursor: default; }
.vc-tr .vc-deleg, .vc-tr .vc-call.vc-deleg { width: auto; max-height: none; }
.vc-tr .vc-instruction, .vc-tr .vc-answer, .vc-tr .vc-deleg-note { max-height: none; overflow: visible; }
.vc-tr-time { font-family: var(--font-mono); font-size: 10.5px; color: var(--color-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.vc-tr-push { margin-left: auto; font-weight: 500; }
.vc-tr-who { font-weight: 700; font-size: 11.5px; }
.vc-tr-label { font-size: 10.5px; font-weight: 700; color: var(--color-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.vc-tr-call > summary { list-style: none; cursor: pointer; display: block; border-radius: 12px; }
.vc-tr-call > summary::-webkit-details-marker { display: none; }
.vc-tr-call > summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.vc-tr-call > summary .vc-call { cursor: pointer; }
.vc-tr-chev { flex: none; color: var(--color-muted); transition: transform 150ms ease-out; }
.vc-tr-call[open] > summary .vc-tr-chev { transform: rotate(90deg); }
.vc-tr-detail { display: flex; flex-direction: column; gap: 3px; padding: 6px 2px 2px; min-width: 0; }
.vc-tr-pre {
  margin: 0 0 4px; padding: 6px 8px; font: 11px/15px var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
  background: var(--color-sunken); border: 1px solid var(--color-border); border-radius: 8px; color: var(--color-primary);
}
.vc-tr-pre[data-status="failed"] { border-color: color-mix(in srgb, var(--color-danger) 40%, transparent); background: color-mix(in srgb, var(--color-danger-soft) 60%, var(--color-sunken)); }
.vc-tr-handoff { margin: 0; font-size: 12px; line-height: 16px; color: var(--color-secondary); }
.vc-tr-states { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11.5px; color: var(--color-secondary); }
.vc-tr-states li { display: inline-flex; align-items: baseline; gap: 4px; }
.vc-tr-raw > summary { display: flex; align-items: center; gap: 4px; padding: 2px 0; }

/* 1 · the lane, scrolled back: no surface of its own, the lane's bubbles on the page as they floated */
.vc-tr[data-variant="1"] { gap: 6px; }
.vc-tr[data-variant="1"] .vc-tr-head {
  align-self: stretch; padding: 4px 4px 4px 12px; border-radius: 14px; box-shadow: var(--shadow-2);
  background: color-mix(in srgb, var(--color-raised) 92%, transparent); border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.vc-tr[data-variant="1"] .vc-tr-body { padding: 2px 2px 6px; mask-image: linear-gradient(to bottom, transparent 0, black 6px); }
.vc-tr[data-variant="1"] .vc-tr-row[data-speaker="operator"] { align-items: flex-end; }
.vc-tr[data-variant="1"] .vc-tr-row[data-speaker="companion"] { align-items: flex-start; }
.vc-tr[data-variant="1"] .vc-tr-detail { margin-top: 4px; padding: 6px 8px; border-radius: 12px; background: var(--color-raised); border: 1px solid var(--color-border); box-shadow: var(--shadow-1); }

/* 2 · a glass sheet: the bubbles' glass as one panel, speaker and time over each line */
.vc-tr[data-variant="2"], .vc-tr[data-variant="3"] { border-radius: 16px; box-shadow: var(--shadow-2); overflow: hidden; }
.vc-tr[data-variant="2"] {
  background: color-mix(in srgb, var(--color-raised) 94%, transparent); border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
}
.vc-tr[data-variant="2"] .vc-tr-head, .vc-tr[data-variant="3"] .vc-tr-head { padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--color-border); }
.vc-tr[data-variant="2"] .vc-tr-body { padding: 10px 12px 12px; }
.vc-tr[data-variant="2"] .vc-tr-list { gap: 10px; }
.vc-tr-meta { display: flex; align-items: baseline; gap: 6px; margin: 0 4px 3px; }
.vc-tr[data-variant="2"] .vc-tr-row[data-speaker="operator"] { align-items: flex-end; }
.vc-tr[data-variant="2"] .vc-tr-row[data-speaker="operator"] .vc-tr-meta { flex-direction: row-reverse; }
.vc-tr[data-variant="2"] .vc-tr-row[data-speaker] .vc-bubble { max-width: 88%; }
.vc-tr[data-variant="2"] .vc-bubble[data-speaker="companion"] { box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }

/* 3 · a reader: a solid page, the time in a gutter, every call open */
.vc-tr[data-variant="3"] { background: var(--color-raised); border: 1px solid var(--color-border); }
.vc-tr[data-variant="3"] .vc-tr-body { padding: 10px 14px 14px 10px; }
.vc-tr[data-variant="3"] .vc-tr-list { gap: 12px; }
.vc-tr-doc { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 8px; align-items: start; }
.vc-tr-doc > .vc-tr-time { padding-top: 3px; text-align: right; }
.vc-tr-entry { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.vc-tr-said { margin: 0; font-size: 13.5px; line-height: 20px; overflow-wrap: anywhere; }
.vc-tr-said .vc-tr-who { display: block; font-size: 11.5px; line-height: 16px; }
.vc-tr-doc[data-speaker="operator"] .vc-tr-said { color: var(--color-secondary); }
.vc-tr-doc[data-speaker="operator"] .vc-tr-who { color: var(--color-primary); }
.vc-tr-doc[data-speaker="companion"] .vc-tr-said { font-weight: 500; }
.vc-tr-doc[data-speaker="companion"] .vc-tr-who { color: color-mix(in srgb, var(--color-warning) 70%, var(--color-primary)); }
.vc-tr-callrow { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.vc-tr-callrow > .vc-call { align-self: flex-start; box-shadow: none; }
`;
