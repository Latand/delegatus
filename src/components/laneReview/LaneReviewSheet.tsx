"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DiffRows, OP_TONE } from "@/components/feed/cards/DiffCard";
import type { FileDiff } from "@/components/feed/diff";
import { outboxStateForReceiptStatus, receiptHasUnknownFate } from "@/components/conversation/outbox";
import type { ReceiptStatus, RuntimeReceipt } from "@/components/runtime/runtimeModel";
import { useLocale, type TFunction } from "@/lib/i18n";
import {
  LANE_REVIEW_LIMITS, laneReviewDraftKey, numberRows, orderComments, parseLaneReviewDraft, reanchor, rowAnchor, rowQuote,
  type LaneReviewComment, type LaneReviewDraft, type LaneReviewSide, type NumberedRow,
} from "@/lib/laneReview/model";
import type { LaneChangeFile, LaneChangeSummary, LaneReviewTarget } from "@/lib/pipelines/laneChanges";
import {
  readLaneFile, readLaneSummary, readOperation, readPairFiles, retryOperation, sendLaneReview, shortSha,
  type FetchPort, type PairFiles,
} from "./client";

/* The lane review sheet (docs/design/lane-diff-comments.md §6–§7): the files a
   lane changed over a pinned base/head, each file's diff with its line
   numbers, the operator's comments under their lines, and one Send to the
   lane's writer. The draft lives in this browser's storage, one per lane. */

export type LaneReviewSheetPorts = {
  fetch: FetchPort;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now: () => Date;
  newId: () => string;
};

const defaultPorts = (): LaneReviewSheetPorts => ({
  fetch: (input, init) => fetch(input, init),
  storage: typeof window === "undefined" ? null : window.localStorage,
  now: () => new Date(),
  newId: () => crypto.randomUUID(),
});

type Load = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ready"; summary: LaneChangeSummary; target: LaneReviewTarget | null };
type DiffEntry = { kind: "error"; reason: string } | { kind: "ready"; file: FileDiff };
type Editor = { id: string | null; path: string; side: LaneReviewSide; line: number | null; quote: string; text: string };
type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; reason: string }
  | { kind: "target-changed"; stage: string };

const hasContent = (draft: LaneReviewDraft | null) => Boolean(draft && (draft.comments.length || draft.note.trim()));
const engineName = (engine: string) => (engine ? engine[0]!.toUpperCase() + engine.slice(1) : "");
const diffKey = (base: string, head: string, path: string) => `${base}..${head}:${path}`;

/** A refusal in the operator's language: the server's codes are named, the
    rest say whether the server answered at all. */
export function reasonText(t: TFunction, answer: { status: number; code: string | null }): string {
  switch (answer.code) {
    case "head_unavailable": return t("laneReview.reason.noHead");
    case "base_unavailable": return t("laneReview.reason.noBase");
    case "git_failed": return t("laneReview.reason.git");
    case "path_not_changed": return t("laneReview.reason.pathGone");
    case "quote_mismatch": return t("laneReview.reason.quote");
    case "operator_only": case "member_required": return t("laneReview.reason.operatorOnly");
    case "no_target": return t("laneReview.noTarget");
    default: return answer.status === 0 || answer.status >= 500 ? t("laneReview.reason.unavailable") : t("laneReview.reason.refused", { status: answer.status });
  }
}

/* What the sheet says about the send's receipt, read through the composer's own
   grouping (outbox.ts): rejected and failed are not delivered, uncertain or a
   verify-first resend is unconfirmed, steered and turn-started are delivered. */
type ReceiptView = "delivered" | "queued" | "failed" | "unconfirmed";

function receiptView(receipt: { status?: string; resend?: string } | null): ReceiptView | null {
  if (!receipt?.status) return null;
  const status = receipt.status as ReceiptStatus;
  if (receiptHasUnknownFate({ status, resend: receipt.resend as RuntimeReceipt["resend"] })) return "unconfirmed";
  switch (outboxStateForReceiptStatus(status)) {
    case "delivered": return "delivered";
    case "failed": return "failed";
    default: return "queued";
  }
}

function receiptWord(t: TFunction, receipt: { status?: string; resend?: string } | null): string | null {
  switch (receiptView(receipt)) {
    case "delivered": return t("laneReview.delivered");
    case "queued": return t("composer.receiptQueued");
    default: return null;
  }
}

export function LaneReviewSheet(props: {
  pipelineId: string;
  title: string;
  onClose: () => void;
  onOpenConversation?: (conversationId: string) => void;
  ports?: Partial<LaneReviewSheetPorts>;
}) {
  const { t, locale } = useLocale();
  const ports = useMemo(() => ({ ...defaultPorts(), ...props.ports }), [props.ports]);
  const sheet = useRef<HTMLElement>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [draft, setDraftState] = useState<LaneReviewDraft | null>(null);
  const [saved, setSaved] = useState(true);
  const [pairFiles, setPairFiles] = useState<{ key: string; value: PairFiles } | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [reanchoring, setReanchoring] = useState(false);
  const [reanchored, setReanchored] = useState<{ moved: number; detached: number } | null>(null);
  const [receipt, setReceipt] = useState<{ status?: string; resend?: string } | null>(null);
  const storageKey = laneReviewDraftKey(props.pipelineId);

  const setDraft = useCallback((next: LaneReviewDraft) => {
    const stamped = { ...next, updatedAt: ports.now().toISOString() };
    setDraftState(stamped);
    try {
      if (!ports.storage) throw new Error("no storage");
      ports.storage.setItem(storageKey, JSON.stringify(stamped));
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }, [ports, storageKey]);

  /* The current head, read on open and again whenever the window regains focus. */
  const applySummary = useCallback((answer: Awaited<ReturnType<typeof readLaneSummary>>) => {
    if (!answer.ok) {
      setLoad((current) => (current.kind === "ready" ? current : { kind: "error", reason: reasonText(t, answer) }));
      return;
    }
    const { summary, target } = answer.value;
    setLoad({ kind: "ready", summary, target });
    setDraftState((current) => {
      let stored = current;
      if (!stored) {
        try {
          stored = parseLaneReviewDraft(ports.storage?.getItem(storageKey) ?? null, props.pipelineId);
        } catch {
          stored = null;
        }
      }
      if (stored && ((stored.head === summary.head && stored.base === summary.base) || hasContent(stored))) return stored;
      /* A draft with nothing in it simply follows the branch. */
      return {
        v: 1, pipelineId: props.pipelineId, draftId: stored?.draftId ?? ports.newId(), base: summary.base, head: summary.head,
        targetConversationId: target?.conversationId ?? null, note: stored?.note ?? "", comments: [], ...(stored?.sent ? { sent: stored.sent } : {}),
        updatedAt: ports.now().toISOString(),
      };
    });
  }, [ports, props.pipelineId, storageKey, t]);
  const refresh = useCallback(() => readLaneSummary(ports.fetch, props.pipelineId).then(applySummary), [ports.fetch, props.pipelineId, applySummary]);

  useEffect(() => {
    let live = true;
    const read = () => void readLaneSummary(ports.fetch, props.pipelineId).then((answer) => { if (live) applySummary(answer); });
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [ports.fetch, props.pipelineId, applySummary]);

  useLayoutEffect(() => {
    sheet.current?.querySelector<HTMLElement>("[data-sheet-close]")?.focus({ preventScroll: true });
  }, []);

  const summary = load.kind === "ready" ? load.summary : null;
  const target = load.kind === "ready" ? load.target : null;
  /* The server refuses a moved base as it refuses a moved head, so both make a draft stale. */
  const stale = Boolean(summary && draft && (draft.head !== summary.head || draft.base !== summary.base));
  const pairKey = draft ? `${draft.base}..${draft.head}` : "";

  /* The draft's own pair lists its own files; a moved branch keeps them. */
  useEffect(() => {
    if (!draft || !summary || !stale || pairFiles?.key === pairKey) return;
    let live = true;
    void readPairFiles(ports.fetch, props.pipelineId, draft.base, draft.head).then((answer) => {
      if (live && answer.ok) setPairFiles({ key: pairKey, value: answer.value });
    });
    return () => { live = false; };
  }, [draft, summary, stale, pairKey, pairFiles?.key, ports.fetch, props.pipelineId]);

  const listing: PairFiles | null = !summary || !draft ? null
    : !stale ? { files: summary.files, total: summary.total, truncated: summary.truncated }
      : pairFiles?.key === pairKey ? pairFiles.value : { files: summary.files, total: summary.total, truncated: summary.truncated };
  const files = listing?.files ?? [];
  /* A resumed draft opens on its first commented file. */
  const current = selected && files.some((file) => file.path === selected) ? selected
    : files.find((file) => draft?.comments.some((comment) => comment.path === file.path))?.path ?? files[0]?.path ?? null;

  /* The selected file's diff over the draft's pair; a file with no entry yet
     reads as loading, and each pair and path is requested once. */
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!draft || !current) return;
    const key = diffKey(draft.base, draft.head, current);
    if (requested.current.has(key)) return;
    requested.current.add(key);
    void readLaneFile(ports.fetch, props.pipelineId, draft.base, draft.head, current).then((answer) => {
      setDiffs((all) => ({ ...all, [key]: answer.ok ? { kind: "ready", file: answer.value.file } : { kind: "error", reason: reasonText(t, answer) } }));
    });
  }, [draft, current, ports.fetch, props.pipelineId, t]);

  /* The receipt of the last send, read again on focus. */
  const sentOperation = draft?.sent?.operationId ?? null;
  useEffect(() => {
    if (!sentOperation) return;
    let live = true;
    const check = () => void readOperation(ports.fetch, sentOperation).then((answer) => {
      if (live && answer.ok && answer.value.receipt) setReceipt(answer.value.receipt);
    });
    check();
    window.addEventListener("focus", check);
    return () => { live = false; window.removeEventListener("focus", check); };
  }, [sentOperation, ports.fetch]);

  const editDraft = (change: (draft: LaneReviewDraft) => LaneReviewDraft) => {
    if (!draft) return;
    /* The first edit after a send starts a new draft: a new key, no receipt. */
    const base = draft.sent ? { ...draft, draftId: ports.newId(), sent: undefined } : draft;
    if (draft.sent) setReceipt(null);
    setDraft(change(base));
    if (send.kind === "failed") setSend({ kind: "idle" });
  };

  const saveEditor = () => {
    if (!editor || !editor.text.trim()) return;
    const body = editor.text.trim().slice(0, LANE_REVIEW_LIMITS.body);
    editDraft((value) => ({
      ...value,
      comments: editor.id
        ? value.comments.map((comment) => (comment.id === editor.id ? { ...comment, body } : comment))
        : [...value.comments, { id: ports.newId(), path: editor.path, side: editor.side, line: editor.line, quote: editor.quote, body, state: "anchored" as const }].slice(0, LANE_REVIEW_LIMITS.comments),
    }));
    setEditor(null);
  };

  const removeComment = (id: string) => editDraft((value) => ({ ...value, comments: value.comments.filter((comment) => comment.id !== id) }));

  const doReanchor = async () => {
    if (!draft || !summary) return;
    setReanchoring(true);
    try {
      const paths = [...new Set(draft.comments.filter((comment) => comment.line !== null).map((comment) => comment.path))];
      const listed = summary.files.map((file) => file.path);
      const loaded = new Map<string, FileDiff>();
      for (const path of paths.filter((entry) => listed.includes(entry))) {
        const answer = await readLaneFile(ports.fetch, props.pipelineId, summary.base, summary.head, path);
        if (!answer.ok) {
          setSend({ kind: "failed", reason: reasonText(t, answer) });
          return;
        }
        loaded.set(path, answer.value.file);
        requested.current.add(diffKey(summary.base, summary.head, path));
        setDiffs((all) => ({ ...all, [diffKey(summary.base, summary.head, path)]: { kind: "ready", file: answer.value.file } }));
      }
      const result = reanchor(draft.comments, listed, loaded);
      setDraft({ ...draft, base: summary.base, head: summary.head, comments: result.comments, targetConversationId: target?.conversationId ?? draft.targetConversationId });
      setReanchored({ moved: result.moved, detached: result.detached });
      setSend({ kind: "idle" });
    } finally {
      setReanchoring(false);
    }
  };

  const doSend = async () => {
    if (!draft || !target || stale || send.kind === "sending") return;
    setSend({ kind: "sending" });
    const answer = await sendLaneReview(ports.fetch, draft, target.conversationId, locale);
    if (answer.ok) {
      setReceipt(answer.value.receipt ?? null);
      setReanchored(null);
      setDraft({
        ...draft, draftId: ports.newId(), comments: [], note: "",
        sent: { operationId: answer.value.operationId ?? null, clientMessageId: answer.value.clientMessageId, head: draft.head, at: ports.now().toISOString(), stageName: target.stageName, conversationId: target.conversationId },
      });
      setSend({ kind: "idle" });
      return;
    }
    if (answer.code === "head_moved") {
      setSend({ kind: "idle" });
      await refresh();
      return;
    }
    if (answer.code === "target_changed" && answer.body.target && typeof answer.body.target === "object") {
      const next = answer.body.target as LaneReviewTarget;
      setLoad((value) => (value.kind === "ready" ? { ...value, target: next } : value));
      setSend({ kind: "target-changed", stage: next.stageName });
      return;
    }
    setSend({ kind: "failed", reason: reasonText(t, answer) });
  };

  const doRetryDelivery = async (uncertain: boolean) => {
    if (!sentOperation) return;
    const answer = await retryOperation(ports.fetch, sentOperation, uncertain);
    if (answer.ok && answer.value.receipt) setReceipt(answer.value.receipt);
    else if (!answer.ok) setSend({ kind: "failed", reason: reasonText(t, answer) });
  };

  const counts = useMemo(() => {
    const byPath = new Map<string, number>();
    for (const comment of draft?.comments ?? []) byPath.set(comment.path, (byPath.get(comment.path) ?? 0) + 1);
    return byPath;
  }, [draft?.comments]);

  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const commentCount = draft?.comments.length ?? 0;
  const empty = Boolean(summary && listing && listing.total === 0);
  const sendBlocked = !draft || !target || stale || empty || !hasContent(draft) || send.kind === "sending" || reanchoring;

  const fileEntry = draft && current ? diffs[diffKey(draft.base, draft.head, current)] : undefined;
  const fileInfo = files.find((file) => file.path === current) ?? null;

  return (
    <div
      className="gsheet-scrim"
      data-lane-review-scrim=""
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={sheet}
        className="gsheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("laneReview.sheetAria", { title: props.title })}
        data-lane-review={props.pipelineId}
        data-lane-review-state={load.kind === "ready" ? (empty ? "empty" : stale ? "stale" : "ready") : load.kind}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          const target = event.target as HTMLElement;
          if (target.closest("input, textarea, [contenteditable='true']")) return;
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }}
      >
        <header>
          <span className="kind">{t("laneReview.kind")}</span>
          <h2>{props.title}</h2>
          {draft ? <span className="shrink-0 whitespace-nowrap font-mono text-ui text-muted" data-lane-review-pair="">{shortSha(draft.base)} → {shortSha(draft.head)}</span> : null}
          {listing && listing.total ? <span className="progress" data-lane-review-totals="">{t("laneReview.totals", { count: listing.total, added: totals.added, removed: totals.removed })}</span> : null}
          <span className="grow" />
          <button type="button" className="icon-btn ml-auto" data-sheet-close="" aria-label={t("common.close")} onClick={props.onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>

        {stale && summary && draft ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-sunken px-4 py-2 text-ui" role="status" data-lane-review-stale="">
            <span className="min-w-0 flex-1">{t("laneReview.stale", draft.head === summary.head ? { old: `${shortSha(draft.base)}..${shortSha(draft.head)}`, new: `${shortSha(summary.base)}..${shortSha(summary.head)}`, count: commentCount } : { old: shortSha(draft.head), new: shortSha(summary.head), count: commentCount })}</span>
            <button type="button" className="btn" data-lane-review-reanchor="" disabled={reanchoring} onClick={() => void doReanchor()}>
              {reanchoring ? t("laneReview.reanchoring") : t("laneReview.reanchor", { new: shortSha(summary.head) })}
            </button>
          </div>
        ) : null}
        {reanchored && !stale ? (
          <div className="border-b border-border bg-sunken px-4 py-2 text-ui" role="status" data-lane-review-reanchored="">
            {t("laneReview.reanchored", { moved: reanchored.moved, detached: reanchored.detached })}
          </div>
        ) : null}
        {summary && summary.uncommitted > 0 ? (
          <div className="border-b border-border px-4 py-1.5 text-caption text-muted" data-lane-review-uncommitted="">
            {t("laneReview.uncommitted", { count: summary.uncommitted })}
          </div>
        ) : null}

        <div className={`grid min-h-0 flex-1 ${empty ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]"}`}>
          {empty ? null : <nav className="min-h-0 overflow-y-auto border-r border-border py-1" aria-label={t("laneReview.filesAria")} data-lane-review-files="">
            {load.kind === "loading" ? <p className="px-3 py-2 text-ui text-muted">{t("laneReview.loading")}</p> : null}
            {load.kind === "error" ? (
              <div className="flex flex-col items-start gap-2 px-3 py-2 text-ui" role="alert" data-lane-review-error="">
                <p className="m-0">{t("laneReview.error", { reason: load.reason })}</p>
                <button type="button" className="btn" onClick={() => { setLoad({ kind: "loading" }); void refresh(); }}>{t("laneReview.tryAgain")}</button>
              </div>
            ) : null}
            {files.map((file) => (
              <FileRow key={file.path} file={file} t={t} selected={file.path === current} comments={counts.get(file.path) ?? 0} onSelect={() => { setSelected(file.path); setEditor(null); }} />
            ))}
            {listing?.truncated ? <p className="px-3 py-1.5 text-caption text-muted">{t("laneReview.moreFiles", { count: listing.total - files.length })}</p> : null}
          </nav>}

          <div className="min-h-0 min-w-0 overflow-y-auto" data-lane-review-diff="">
            {load.kind === "loading" ? <p className="px-4 py-3 text-ui text-muted">{t("laneReview.loadingFile")}</p> : null}
            {empty && draft ? <p className="px-4 py-3 text-ui" data-lane-review-empty="">{t("laneReview.empty")}</p> : null}
            {draft && fileInfo ? (
              <FileView
                t={t}
                file={fileInfo}
                entry={fileEntry}
                comments={draft.comments.filter((comment) => comment.path === fileInfo.path)}
                editor={editor?.path === fileInfo.path ? editor : null}
                readOnly={stale}
                onOpenEditor={setEditor}
                onEditorText={(text) => setEditor((value) => (value ? { ...value, text } : value))}
                onSave={saveEditor}
                onCancel={() => setEditor(null)}
                onDelete={removeComment}
              />
            ) : null}
          </div>
        </div>

        <footer className="flex flex-col gap-2 border-t border-border bg-raised px-4 py-2.5" data-lane-review-footer="">
          {draft && !empty ? (
            <details className="text-ui" open={Boolean(draft.note)}>
              <summary className="cursor-pointer text-secondary">{t("laneReview.note")}</summary>
              <textarea
                className="mt-1.5 block min-h-[56px] w-full resize-y rounded-[8px] border border-border bg-sunken px-2 py-1.5 text-ui"
                value={draft.note}
                maxLength={LANE_REVIEW_LIMITS.note}
                disabled={stale}
                onChange={(event) => editDraft((value) => ({ ...value, note: event.target.value }))}
                data-lane-review-note=""
              />
            </details>
          ) : null}
          {!saved ? <p className="m-0 text-caption text-muted" data-lane-review-not-saved="">{t("laneReview.notSaved")}</p> : null}
          <div className="flex flex-wrap items-center gap-2 text-ui">
            <span className="min-w-0 flex-1 text-secondary" data-lane-review-status="">
              {load.kind === "ready" ? <FooterStatus t={t} locale={locale} draft={draft} target={target} send={send} stale={stale} receipt={receipt} /> : null}
            </span>
            {draft?.sent && receiptView(receipt) === "failed" && receipt?.resend === "safe" ? (
              <button type="button" className="btn" data-lane-review-retry="" onClick={() => void doRetryDelivery(false)}>{t("laneReview.retryDelivery")}</button>
            ) : null}
            {draft?.sent && receiptView(receipt) === "unconfirmed" ? (
              <button type="button" className="btn" data-lane-review-recheck="" onClick={() => void doRetryDelivery(true)}>{t("composer.payloadRecheck")}</button>
            ) : null}
            {draft?.sent && props.onOpenConversation ? (
              <button type="button" className="btn quiet" data-lane-review-open="" onClick={() => props.onOpenConversation!(draft.sent!.conversationId)}>{t("laneReview.openConversation")}</button>
            ) : null}
            <button
              type="button"
              className="btn primary"
              data-lane-review-send=""
              disabled={sendBlocked}
              title={stale ? t("laneReview.staleWhy") : !target ? t("laneReview.noTarget") : undefined}
              onClick={() => void doSend()}
            >
              {send.kind === "sending" ? t("laneReview.sending") : send.kind === "failed" ? t("laneReview.sendAgain") : t("laneReview.send")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function FooterStatus({ t, locale, draft, target, send, stale, receipt }: {
  t: TFunction; locale: string; draft: LaneReviewDraft | null; target: LaneReviewTarget | null; send: SendState; stale: boolean; receipt: { status?: string; resend?: string } | null;
}) {
  if (send.kind === "failed") return <span role="alert" data-lane-review-failed="">{t("laneReview.failed", { reason: send.reason })}</span>;
  if (send.kind === "target-changed") return <span role="status">{t("laneReview.targetChanged", { stage: send.stage })}</span>;
  if (stale) return <span>{t("laneReview.staleWhy")}</span>;
  if (!target) return <span data-lane-review-no-target="">{t("laneReview.noTarget")}</span>;
  if (draft?.sent && !draft.comments.length && !draft.note.trim()) {
    const time = new Date(draft.sent.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const view = receiptView(receipt);
    const params = { stage: draft.sent.stageName, time };
    /* A send that needs the operator's attention leads with the outcome in the
       warning or danger tone; a delivered or queued one stays muted. */
    if (view === "failed") return <span role="status" className="font-medium text-danger" data-lane-review-sent="" data-receipt="failed">{t("laneReview.sentFailed", params)}</span>;
    if (view === "unconfirmed") return <span role="status" className="font-medium text-warning" data-lane-review-sent="" data-receipt="unconfirmed">{t("laneReview.sentUnconfirmed", params)}</span>;
    const word = receiptWord(t, receipt);
    return <span role="status" data-lane-review-sent="" data-receipt={view ?? undefined}>{t("laneReview.sent", params)}{word ? ` · ${word}` : ""}</span>;
  }
  const count = draft?.comments.length ?? 0;
  const engine = engineName(target.engine);
  return <span>{count ? t("laneReview.footer", { count, stage: target.stageName, engine }) : t("laneReview.footerTarget", { stage: target.stageName, engine })}</span>;
}

function FileRow({ file, t, selected, comments, onSelect }: { file: LaneChangeFile; t: TFunction; selected: boolean; comments: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      className="group block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      aria-current={selected ? "true" : undefined}
      title={file.path}
      data-lane-review-file={file.path}
      onClick={onSelect}
    >
      {/* The board's stylesheet resets a button's padding and background, so
          the row's box is this span. */}
      <span className={`flex min-h-8 w-full items-center gap-2 px-3 py-1 text-ui group-hover:bg-sunken ${selected ? "bg-sunken font-semibold" : ""}`}>
        <span className={`w-3 shrink-0 font-mono text-caption font-semibold ${OP_TONE[file.op]}`}>{t(`laneReview.op.${file.op}`)}</span>
        {/* Truncated from the left: the file name is the part worth keeping. */}
        <span className="min-w-0 flex-1 truncate text-left [direction:rtl]"><bdi>{file.path}</bdi></span>
        {file.binary ? null : (
          <span className="shrink-0 font-mono text-caption">
            <span className="text-diff-add">+{file.added}</span> <span className="text-diff-del">−{file.removed}</span>
          </span>
        )}
        {comments ? <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-caption font-semibold text-accent" aria-label={t("laneReview.commentCount", { count: comments })}>{comments}</span> : null}
      </span>
    </button>
  );
}

function FileView(props: {
  t: TFunction;
  file: LaneChangeFile;
  entry: DiffEntry | undefined;
  comments: LaneReviewComment[];
  editor: Editor | null;
  readOnly: boolean;
  onOpenEditor: (editor: Editor) => void;
  onEditorText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) {
  const { t, file, entry, comments, editor } = props;
  const rows = useMemo(() => (entry?.kind === "ready" ? numberRows(entry.file.hunks) : []), [entry]);
  const fileComments = orderComments(comments.filter((comment) => comment.line === null), [file.path]);
  const detached = fileComments.filter((comment) => comment.state === "detached");
  const plain = fileComments.filter((comment) => comment.state !== "detached");
  const lineComments = comments.filter((comment) => comment.line !== null);
  const commentsAt = (row: NumberedRow) => lineComments.filter((comment) => row[comment.side] === comment.line);
  const editorAt = (row: NumberedRow) => editor && editor.line !== null && row[editor.side] === editor.line && !editor.id;

  const open = (side: LaneReviewSide, line: number | null, quote: string) =>
    props.onOpenEditor({ id: null, path: file.path, side, line, quote, text: "" });

  const editorView = (value: Editor): ReactNode => (
    <CommentEditor t={t} value={value} onText={props.onEditorText} onSave={props.onSave} onCancel={props.onCancel} />
  );
  const commentView = (comment: LaneReviewComment): ReactNode =>
    editor?.id === comment.id ? <div key={comment.id}>{editorView(editor)}</div> : (
      <CommentCard key={comment.id} t={t} comment={comment} readOnly={props.readOnly}
        onEdit={() => props.onOpenEditor({ id: comment.id, path: comment.path, side: comment.side, line: comment.line, quote: comment.quote, text: comment.body })}
        onDelete={() => props.onDelete(comment.id)} />
    );

  return (
    <div className="flex flex-col" data-lane-review-file-view={file.path}>
      <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-raised px-4 py-1.5 text-ui">
        <span className={`shrink-0 font-semibold uppercase ${OP_TONE[file.op]}`}>{file.op}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
        {props.readOnly ? null : (
          <button type="button" className="btn quiet" data-lane-review-file-comment="" onClick={() => open("new", null, "")}>{t("laneReview.fileComment")}</button>
        )}
      </div>
      {detached.length ? (
        <section className="flex flex-col gap-1.5 border-b border-border px-4 py-2" data-lane-review-needs-line="">
          <h3 className="m-0 text-caption font-semibold text-diff-del">{t("laneReview.needsLine")}</h3>
          {detached.map(commentView)}
        </section>
      ) : null}
      {plain.length || (editor && editor.line === null && !editor.id) ? (
        <section className="flex flex-col gap-1.5 border-b border-border px-4 py-2" data-lane-review-file-comments="">
          {plain.map(commentView)}
          {editor && editor.line === null && !editor.id ? editorView(editor) : null}
        </section>
      ) : null}
      {!entry ? <p className="px-4 py-3 text-ui text-muted">{t("laneReview.loadingFile")}</p> : null}
      {entry?.kind === "error" ? <p className="px-4 py-3 text-ui" role="alert">{t("laneReview.error", { reason: entry.reason })}</p> : null}
      {entry?.kind === "ready" && entry.file.binary ? <p className="px-4 py-3 text-ui text-muted">{t("laneReview.binary")}</p> : null}
      {entry?.kind === "ready" && !entry.file.binary ? (
        <div className="max-w-full overflow-x-auto py-1 font-mono text-[12px] leading-6" data-lane-review-rows="">
          <DiffRows
            rows={rows}
            numbers={(row) => <Gutter t={t} row={row} disabled={props.readOnly} onComment={(side, line) => open(side, line, rowQuote(row.line.text))} />}
            after={(index) => {
              const row = rows[index]!;
              const here = commentsAt(row);
              if (!here.length && !editorAt(row)) return null;
              return (
                <div className="flex flex-col gap-1.5 border-y border-border bg-sunken py-2 pl-[88px] pr-4 font-sans text-ui leading-normal">
                  {here.map(commentView)}
                  {editorAt(row) ? editorView(editor!) : null}
                </div>
              );
            }}
          />
        </div>
      ) : null}
      {entry?.kind === "ready" && entry.file.truncated ? (
        <p className="border-t border-border px-4 py-1.5 text-caption text-muted" data-lane-review-cut="">{t("laneReview.cut", { count: rows.length })}</p>
      ) : null}
    </div>
  );
}

/** The old and new line numbers of a row. The number a comment anchors to is
    a button; a context row anchors to its new line. */
function Gutter({ t, row, disabled, onComment }: { t: TFunction; row: NumberedRow; disabled: boolean; onComment: (side: LaneReviewSide, line: number) => void }) {
  const anchor = rowAnchor(row);
  const cell = (side: LaneReviewSide) => {
    const line = row[side];
    if (line === undefined) return <span className="w-10 shrink-0" aria-hidden="true" />;
    if (disabled || anchor?.side !== side) return <span className="w-10 shrink-0 select-none pr-1.5 text-right text-muted">{line}</span>;
    return (
      <button
        type="button"
        className="group h-6 w-10 shrink-0 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        aria-label={t(side === "new" ? "laneReview.lineNew" : "laneReview.lineOld", { line })}
        data-lane-review-line={`${side}:${line}`}
        onClick={() => onComment(side, line)}
      >
        <span className="block h-full pr-1.5 text-right text-muted group-hover:bg-accent/15 group-hover:text-accent">{line}</span>
      </button>
    );
  };
  return (
    <span className="flex shrink-0 border-r border-border">
      {cell("old")}
      {cell("new")}
    </span>
  );
}

function CommentEditor({ t, value, onText, onSave, onCancel }: { t: TFunction; value: Editor; onText: (text: string) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 font-sans" data-lane-review-editor="">
      <textarea
        autoFocus
        className="block min-h-[72px] w-full resize-y rounded-[8px] border border-border bg-raised px-2 py-1.5 text-ui leading-normal"
        placeholder={t("laneReview.placeholder")}
        value={value.text}
        maxLength={LANE_REVIEW_LIMITS.body}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
          }
        }}
      />
      <div className="flex gap-2">
        <button type="button" className="btn primary" disabled={!value.text.trim()} data-lane-review-save="" onClick={onSave}>{t("laneReview.save")}</button>
        <button type="button" className="btn quiet" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

function CommentCard({ t, comment, readOnly, onEdit, onDelete }: { t: TFunction; comment: LaneReviewComment; readOnly: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <article className="rounded-[8px] border border-border bg-raised px-2.5 py-1.5 font-sans text-ui" data-lane-review-comment={comment.id} data-state={comment.state}>
      {comment.line === null && comment.quote ? <p className="m-0 truncate font-mono text-caption text-muted">&gt; {comment.quote}</p> : null}
      <p className="m-0 whitespace-pre-wrap break-words">{comment.body}</p>
      {readOnly ? null : (
        /* The board's stylesheet resets a button's padding, so each target's box
           is its span: 24 px tall, with a gap between Edit and the destructive Delete. */
        <div className="mt-0.5 flex gap-3 text-caption" data-lane-review-comment-actions="">
          <button type="button" className="group flex" onClick={onEdit}><span className="inline-flex min-h-6 min-w-6 items-center justify-center px-2 font-semibold text-accent group-hover:underline">{t("laneReview.edit")}</span></button>
          <button type="button" className="group flex" onClick={onDelete}><span className="inline-flex min-h-6 min-w-6 items-center justify-center px-2 font-semibold text-diff-del group-hover:underline">{t("laneReview.delete")}</span></button>
        </div>
      )}
    </article>
  );
}
