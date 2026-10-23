"use client";

import { useEffect, useMemo, useState } from "react";

import { DiffCard, OP_TONE } from "@/components/feed/cards/DiffCard";
import type { FileDiff } from "@/components/feed/diff";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import { useLocale } from "@/lib/i18n";
import type { LaneChangeSummary } from "@/lib/pipelines/laneChanges";
import { readLaneFile, readLaneSummary, shortSha, type FetchPort } from "./client";
import { reasonText } from "./LaneReviewSheet";

/* The phone's lane review (docs/design/lane-diff-comments.md §7): the changed
   files and each file's diff in the feed's DiffCard, read-only. Comments are
   written on a computer; this sheet neither reads nor writes a draft. */

type FileEntry = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ready"; file: FileDiff };

export function LaneReviewPhoneSheet({ pipelineId, onClose, fetchPort }: { pipelineId: string; onClose: () => void; fetchPort?: FetchPort }) {
  const { t } = useLocale();
  const port = useMemo<FetchPort>(() => fetchPort ?? ((input, init) => fetch(input, init)), [fetchPort]);
  const [summary, setSummary] = useState<LaneChangeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileEntry>>({});

  useEffect(() => {
    let live = true;
    void readLaneSummary(port, pipelineId).then((answer) => {
      if (!live) return;
      if (answer.ok) setSummary(answer.value.summary);
      else setError(reasonText(t, answer));
    });
    return () => { live = false; };
  }, [port, pipelineId, t]);

  const toggle = (path: string) => {
    setOpen((current) => (current === path ? null : path));
    if (!summary || files[path]) return;
    setFiles((all) => ({ ...all, [path]: { kind: "loading" } }));
    void readLaneFile(port, pipelineId, summary.base, summary.head, path).then((answer) => {
      setFiles((all) => ({ ...all, [path]: answer.ok ? { kind: "ready", file: answer.value.file } : { kind: "error", reason: reasonText(t, answer) } }));
    });
  };

  const totals = summary?.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });

  return (
    <MobileSheet name="changes" title={t("laneReview.phoneRow")} expandable onClose={onClose}>
      <div className="flex flex-col gap-2 px-3 pb-4" data-mobile2-lane-review={pipelineId}>
        <p className="m-0 text-ui text-secondary" data-lane-review-phone-note="">{t("laneReview.phoneNote")}</p>
        {!summary && !error ? <p className="m-0 text-ui text-muted">{t("laneReview.loading")}</p> : null}
        {error ? <p className="m-0 text-ui" role="alert">{t("laneReview.error", { reason: error })}</p> : null}
        {summary ? (
          <>
            <p className="m-0 flex flex-wrap gap-x-3 text-ui text-muted">
              <span className="font-mono" data-lane-review-pair="">{shortSha(summary.base)} → {shortSha(summary.head)}</span>
              {summary.total ? <span>{t("laneReview.totals", { count: summary.total, added: totals!.added, removed: totals!.removed })}</span> : null}
            </p>
            {summary.uncommitted > 0 ? <p className="m-0 text-caption text-muted">{t("laneReview.uncommitted", { count: summary.uncommitted })}</p> : null}
            {summary.total === 0 ? <p className="m-0 text-ui">{t("laneReview.empty", { base: shortSha(summary.base), head: shortSha(summary.head) })}</p> : null}
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {summary.files.map((file) => {
                const entry = files[file.path];
                return (
                  <li key={file.path} className="flex min-w-0 flex-col">
                    <button
                      type="button"
                      aria-expanded={open === file.path}
                      className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[10px] bg-quiet px-3 text-left text-ui ring-1 ring-inset ring-border active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      data-lane-review-phone-file={file.path}
                      onClick={() => toggle(file.path)}
                    >
                      <span className={`w-3 shrink-0 font-mono text-caption font-semibold ${OP_TONE[file.op]}`}>{t(`laneReview.op.${file.op}`)}</span>
                      <span className="min-w-0 flex-1 truncate [direction:rtl] text-left"><bdi>{file.path}</bdi></span>
                      {file.binary ? null : (
                        <span className="shrink-0 font-mono text-caption">
                          <span className="text-diff-add">+{file.added}</span> <span className="text-diff-del">−{file.removed}</span>
                        </span>
                      )}
                    </button>
                    {open === file.path ? (
                      entry?.kind === "ready" ? (
                        entry.file.binary ? <p className="m-0 px-1 pt-1.5 text-caption text-muted">{t("laneReview.binary")}</p>
                          : <DiffCard body={{ type: "diff", files: [entry.file], filesTruncated: false }} />
                      ) : entry?.kind === "error" ? <p className="m-0 px-1 pt-1.5 text-caption" role="alert">{t("laneReview.error", { reason: entry.reason })}</p>
                        : <p className="m-0 px-1 pt-1.5 text-caption text-muted">{t("laneReview.loadingFile")}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {summary.truncated ? <p className="m-0 text-caption text-muted">{t("laneReview.moreFiles", { count: summary.total - summary.files.length })}</p> : null}
          </>
        ) : null}
      </div>
    </MobileSheet>
  );
}
