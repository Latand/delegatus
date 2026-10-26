"use client";

import { ArrowRight, History } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import type { OrchestratorSeatStatus } from "./seatState";
import { useOrchestratorSeat, useSeatConversations } from "./useOrchestratorSeat";

export interface RetiredOrchestrator {
  successorConversationId: string | null;
  /** The detail read has not answered yet, so a missing successor is not known. */
  pending: boolean;
}

/** Called only for a conversation the shared poll lists as a former seat and
 * not as a current one; the detail page of history cannot undo that. */
export function retiredOrchestratorFor(
  file: Pick<FileEntry, "conversationId" | "path" | "project">,
  status: OrchestratorSeatStatus | null,
  failed = false,
): RetiredOrchestrator {
  if (!status) return { successorConversationId: null, pending: !failed };
  const current = status.seat;
  const sameConversation = Boolean((file.conversationId && current?.conversationId === file.conversationId)
    || current?.path === file.path);
  return {
    successorConversationId: !sameConversation && !failed && status.exists && current?.project === file.project
      ? current.conversationId ?? null : null,
    pending: false,
  };
}

/** The shared seat poll already supplies the board's historical identities.
 * Only a matching former seat needs the project's detailed status read. */
export function useRetiredOrchestrator(file: FileEntry, enabled = true): RetiredOrchestrator | null {
  const seats = useSeatConversations(enabled);
  const matches = (ids: readonly string[] | undefined, paths: readonly string[] | undefined) =>
    Boolean((file.conversationId && ids?.includes(file.conversationId)) || paths?.includes(file.path));
  const current = matches(seats?.conversationIds, seats?.paths);
  const previous = !current && matches(seats?.previous?.conversationIds, seats?.previous?.paths);
  const read = useOrchestratorSeat(enabled && previous ? file.project : null);
  if (!previous) return null;
  // The shared response names every former seat; the detail history is only
  // a recent page. Neither a missing record nor that page can undo retirement.
  return retiredOrchestratorFor(file, read.status, read.failed);
}

export function RetiredOrchestratorBanner({ retirement }: { retirement: RetiredOrchestrator }) {
  const { t } = useLocale();
  return (
    <div role="status" aria-live="polite" data-retired-orchestrator
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-sunken px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-label font-bold text-secondary">
        <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("retiredOrchestrator.title")}</span>
      </div>
      <p className="text-caption font-semibold text-muted">{t("retiredOrchestrator.body")}</p>
      {retirement.successorConversationId ? (
        <a href={`#c=${encodeURIComponent(retirement.successorConversationId)}`}
          className="inline-flex min-h-11 items-center justify-center gap-1 self-start rounded-control border border-brand bg-brand px-2.5 text-label font-bold text-on-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-8">
          {t("retiredOrchestrator.open")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </a>
      ) : retirement.pending ? null : <p className="text-caption text-muted">{t("retiredOrchestrator.unavailable")}</p>}
    </div>
  );
}
