"use client";

import { MessageCircleQuestionMark } from "lucide-react";
import { useEffect, useState } from "react";

import { ArrowRight } from "@/components/icons";
import { usePrototypeNoticesFor } from "@/components/prototypeReview/prototypeReviewStore";
import type { ToolEvent } from "@/components/feed/parse";
import { useLocale } from "@/lib/i18n";
import type { OperatorDecisionView, OperatorDecisionsRead } from "@/lib/prototypeReview/types";

import { DecisionRecord } from "./DecisionCard";
import { openOperatorDecisions } from "./decisionSurface";
import { decisionsUrl } from "./useOperatorDecisions";

/*
 * Where the seat asked (docs/design/operator-decision-forms.md, variant 3):
 * the publish_prototype_review call in the feed is drawn as a short pointer to
 * the «Рішення» column while the decision waits, and as the answer's record
 * once it is answered. A publication without the project in its result
 * (written before this) keeps its ordinary MCP row.
 */

export interface DecisionPointerTarget { reviewId: string; project: string; title: string }

export function decisionPointerOf(event: ToolEvent): DecisionPointerTarget | null {
  const mcp = event.mcp;
  if (!mcp || mcp.toolName !== "publish_prototype_review" || event.status === "err" || !mcp.result) return null;
  const { reviewId, project, title } = mcp.result;
  if (typeof reviewId !== "string" || !/^pr_[a-f0-9]{32}$/.test(reviewId) || typeof project !== "string" || !project) return null;
  return { reviewId, project, title: typeof title === "string" ? title : typeof mcp.args.title === "string" ? mcp.args.title : "" };
}

/* A recorded answer is read again while its message is on its way: pending,
   or uncertain until the receipt settles it. A read the server could not
   answer (busy, down, offline) is tried again on the same pace. The first
   reads follow closely; past them the record keeps checking, slower. */
const recordPoll = { ms: 4000, slowMs: 30_000, fast: 30 };
const UNSETTLED = new Set(["pending", "uncertain"]);
const transientRead = (status: number) => status === 409 || status === 429 || status >= 500;

export function setDecisionRecordPollForTests(ms: number | null): void {
  recordPoll.ms = ms ?? 4000;
  recordPoll.slowMs = ms ?? 30_000;
}

export function DecisionPointer({ target }: { target: DecisionPointerTarget }) {
  const { t } = useLocale();
  const waiting = usePrototypeNoticesFor(target.project).some((notice) => notice.reviewId === target.reviewId);
  const [record, setRecord] = useState<OperatorDecisionView | null>(null);
  /* Each retry reads the record again and polls it while the message travels. */
  const [reads, setReads] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await fetch("/api/projects/decisions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: target.project, reviewId: target.reviewId, retry: true }),
      });
      if (!response.ok) setRetryError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? String(response.status));
    } catch (failure) {
      setRetryError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRetrying(false);
      setReads((held) => held + 1);
    }
  };
  useEffect(() => {
    if (waiting) return;
    let alive = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (!alive) return;
      polls += 1;
      timer = setTimeout(() => void read(), polls < recordPoll.fast ? recordPoll.ms : recordPoll.slowMs);
    };
    const read = async () => {
      try {
        const response = await fetch(decisionsUrl(target.project, target.reviewId), { cache: "no-store" });
        if (!alive) return;
        if (!response.ok) { if (transientRead(response.status)) again(); return; }
        const body = await response.json() as OperatorDecisionsRead;
        if (!alive) return;
        setRecord(body.round ?? null);
        if (UNSETTLED.has(body.round?.decision?.delivery.state ?? "")) again();
      } catch { again(); }
    };
    void read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [waiting, target.project, target.reviewId, reads]);
  if (!waiting && record?.decision) {
    return (
      <div data-decision-pointer={target.reviewId} className="my-1 ml-9 max-w-[640px] max-[480px]:ml-0">
        <DecisionRecord decision={record} onRetry={() => void retry()} retrying={retrying} retryError={retryError} />
      </div>
    );
  }
  return (
    <div data-decision-pointer={target.reviewId} className="my-1 ml-9 flex max-[480px]:ml-0">
      <button
        type="button"
        data-decision-pointer-open=""
        onClick={() => openOperatorDecisions({ project: target.project, reviewId: target.reviewId })}
        className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-control border border-accent/30 bg-accent-soft px-2 text-label font-semibold text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11"
      >
        <MessageCircleQuestionMark className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-medium text-primary">{target.title || record?.title}</span>
        <span className="shrink-0">· {t("decisions.inColumn")}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
    </div>
  );
}
