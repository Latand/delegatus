"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Flow } from "@/lib/reviewHistory/types";
import type { ArchiveArtifact } from "@/lib/reviewHistory/archiveArtifacts";
import type { FileEntry } from "@/lib/types";
import { reviewerBindingTargetsForRound } from "./flowModel";
import { useLocale } from "@/lib/i18n";
import { Z } from "@/components/layers";
import { useModalLayer } from "@/components/modalLayer";

const OPEN_HISTORY = "llv:review-history";
type Target = { id?: string; project?: string; round?: number };
export function openReviewHistory(id: string, round?: number): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_HISTORY, { detail: { id, round } }));
}
export function openProjectReviewHistory(project: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_HISTORY, { detail: { project } }));
}

type Detail = {
  row: Flow;
  currentHead: string;
  conversations?: { reviewers: { round: number; conversationId: string | null }[] };
  artifacts: { round: number; artifacts: { findings: ArchiveArtifact } }[];
};
type Page = {
  rows: { id: string; title: string; state: Flow["state"]; roundCount: number; createdAt: string }[];
  nextCursor: string | null;
  cursorReset?: boolean;
};

/** One history reader serves every board, stage, task and phone entry point.
 * Requests are owned by the mounted target, so a late answer cannot replace a
 * newly selected archive. No read changes placement or adopts historical work. */
export function ReviewHistoryHost({ files = [] }: { files?: readonly FileEntry[] }) {
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => {
    const open = (event: Event) => setTarget((event as CustomEvent<Target>).detail);
    window.addEventListener(OPEN_HISTORY, open);
    return () => window.removeEventListener(OPEN_HISTORY, open);
  }, []);
  return target ? <ReviewHistoryDialog key={JSON.stringify(target)} target={target} files={files} onClose={() => setTarget(null)} /> : null;
}

export function ReviewHistoryDialog({ target, onClose, files = [] }: { target: Target; onClose: () => void; files?: readonly FileEntry[] }) {
  const { t } = useLocale();
  const panel = useRef<HTMLDivElement>(null);
  useModalLayer({ containerRef: panel, onClose });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState(target.id ?? null);
  const [round, setRound] = useState(target.round ?? null);
  const [error, setError] = useState(false);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  /* eslint-disable react-hooks/set-state-in-effect -- each keyed request owns its loading/error state. */
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    let alive = true;
    setDetail(null);
    setError(false);
    setMissing(false);
    void (async () => {
      try {
        const response = await fetch("/api/review-history/" + encodeURIComponent(selected), { signal: abort.signal });
        if (response.status === 404) { if (alive) setMissing(true); return; }
        if (!response.ok) throw new Error("archive read failed");
        const data = await response.json() as Detail | null;
        if (alive) {
          if (data?.row && Array.isArray(data.row.rounds) && Array.isArray(data.artifacts)) setDetail(data);
          else setMissing(true);
        }
      } catch { if (alive) setError(true); }
    })();
    return () => { alive = false; abort.abort(); };
  }, [selected, retry]);
  useEffect(() => {
    if (selected || !target.project) return;
    const abort = new AbortController();
    let alive = true;
    setLoadingPage(true);
    setError(false);
    void (async () => {
      try {
        const params = new URLSearchParams({ project: target.project!, limit: "25" });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch("/api/review-history?" + params, { signal: abort.signal });
        if (!response.ok) throw new Error("archive list failed");
        const data = await response.json() as Page;
        if (!Array.isArray(data.rows)) throw new Error("archive list invalid");
        if (alive) setPage(previous => ({
          ...data,
          rows: cursor && !data.cursorReset ? [...new Map([...(previous?.rows ?? []), ...data.rows].map(row => [row.id, row])).values()] : data.rows,
        }));
      } catch { if (alive) setError(true); }
      finally { if (alive) setLoadingPage(false); }
    })();
    return () => { alive = false; abort.abort(); };
  }, [selected, target.project, cursor, retry]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const recorded = detail?.row;
  const current = recorded?.rounds.find(item => item.n === round) ?? recorded?.rounds.at(-1);
  const artifact = detail?.artifacts.find(item => item.round === current?.n)?.artifacts.findings;
  const unresolved = recorded?.state === "paused" || recorded?.rounds.some(item => item.relayPendingSettlement || item.relayRetryRequiresIdempotency);
  return createPortal(
    <div data-review-history className={`fixed inset-0 ${Z.overlay} flex items-center justify-center bg-black/50 p-2 sm:p-6`}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("reviewHistory.title")}
        className="flex max-h-[calc(100dvh-16px)] w-full max-w-3xl min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-primary shadow-2">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
          <h2 className="min-w-0 flex-1 text-sm font-bold">{t("reviewHistory.title")}</h2>
          {selected && target.project ? <button type="button" className="min-h-11 px-2 text-sm" onClick={() => { setSelected(null); setRound(null); }}>{t("reviewHistory.back")}</button> : null}
          {selected ? <a download className="min-h-11 px-2 py-3 text-sm text-accent" href={"/api/review-history/" + encodeURIComponent(selected) + "/export"}>{t("reviewHistory.export")}</a> : null}
          <button type="button" className="min-h-11 min-w-11 rounded-lg border border-border px-2 text-sm" onClick={onClose}>{t("common.close")}</button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
          <p className="mb-3 text-sm text-muted">{t("reviewHistory.readOnly")}</p>
          {error ? <div role="alert" className="text-sm text-danger">{t("reviewHistory.failed")} <button className="min-h-11 underline" onClick={() => setRetry(value => value + 1)}>{t("kanban.retry")}</button></div> : null}
          {selected && missing ? <p role="status">{t("reviewHistory.missing")}</p> : null}
          {!error && !missing && selected && !detail ? <p role="status">{t("common.loading")}</p> : null}
          {!selected ? <>
            {page?.rows.map(row => <button key={row.id} className="mb-2 flex min-h-11 w-full flex-col rounded-lg border border-border p-3 text-left text-sm" onClick={() => { setSelected(row.id); setRound(null); }}>
              <span className="break-words font-semibold">{row.title || row.id}</span>
              <span className="text-muted">{row.createdAt} · {row.roundCount} · {t(`flowState.${row.state}`)}</span>
            </button>)}
            {page && !page.rows.length ? <p>{t("reviewHistory.empty")}</p> : null}
            {loadingPage ? <p role="status">{t("common.loading")}</p> : page?.nextCursor ? <button className="min-h-11 rounded-lg border border-border px-3" onClick={() => setCursor(page.nextCursor)}>{t("reviewHistory.more")}</button> : null}
          </> : null}
          {recorded ? <>
            <p className="mb-2 font-semibold">{t(unresolved ? "reviewHistory.unresolved" : "reviewHistory.retired")}</p>
            {recorded.stateDetail ? <p className="mb-2 whitespace-pre-wrap break-words text-sm">{recorded.stateDetail}</p> : null}
            <nav aria-label={t("reviewHistory.rounds")} className="mb-3 flex flex-wrap gap-1">
              {recorded.rounds.map(item => <button key={item.n} type="button" aria-pressed={current?.n === item.n} className="min-h-11 min-w-11 rounded-lg border border-border px-2 text-sm aria-pressed:border-accent" onClick={() => setRound(item.n)}>R{item.n}</button>)}
            </nav>
            {current ? <section className="flex min-w-0 flex-col gap-2 text-sm">
              <p className="font-semibold">R{current.n} · {current.verdict ?? t("reviewHistory.noVerdict")}</p>
              <p className="break-all">{t("reviewHistory.reviewedHead")}: {current.reviewHeadSha ?? t("reviewHistory.unknown")}</p>
              <p>{t("reviewHistory.currentHead")}: {t("reviewHistory.unknown")}</p>
              <p>{current.reviewedAt ?? current.startedAt}</p>
              {current.error ? <p className="whitespace-pre-wrap break-words text-danger">{current.error}</p> : null}
              {reviewerBindingTargetsForRound(recorded, { ...current, reviewerConversationId: detail?.conversations?.reviewers.find(item => item.round === current.n)?.conversationId ?? current.reviewerConversationId }, files).map((binding, index) => <a key={binding.path} className="min-h-11 py-3 text-accent underline" href={"#f=" + encodeURIComponent(binding.path)} onClick={onClose}>{t("reviewHistory.transcript")} {index + 1}</a>)}
              {artifact?.status === "available" ? <pre className="whitespace-pre-wrap break-words font-sans">{artifact.text}</pre> : <p>{t("reviewHistory.artifactMissing")}</p>}
            </section> : <p>{t("reviewHistory.empty")}</p>}
          </> : null}
        </div>
      </div>
    </div>, document.body,
  );
}
