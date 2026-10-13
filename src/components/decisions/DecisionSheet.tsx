"use client";

import { MessageCircleQuestionMark } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { X } from "@/components/icons";
import { Z } from "@/components/layers";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import { useModalLayer } from "@/components/modalLayer";
import { ReportLog } from "@/components/orchestrator/reportLog/ReportLog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

import { DecisionList, DecisionTabs, useOpenDecisionCount, type DecisionTab } from "./DecisionColumn";
import { closeDecisionSheet, useDecisionSheet, type DecisionRequest } from "./decisionSurface";

/*
 * Where a project's decisions open when no seat column of the project stands
 * on screen (docs/design/operator-decision-forms.md, variant 3): on the phone
 * a sheet with the column's two tabs, «Рішення» and «Звіти»; on the desktop a
 * dialog with the decisions alone. Mounted once, by the prototype review host.
 */
export function DecisionSheet() {
  const request = useDecisionSheet();
  if (!request) return null;
  return <OpenDecisionSheet key={`${request.project}\n${request.reviewId ?? ""}`} request={request} />;
}

function OpenDecisionSheet({ request }: { request: DecisionRequest }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const [tab, setTab] = useState<DecisionTab>("decisions");
  const count = useOpenDecisionCount(request.project);
  const focus = request.reviewId ? { reviewId: request.reviewId, nonce: 1 } : null;
  if (phone) {
    return (
      <MobileSheet name="decisions" title={t("decisions.listAria")} titleHidden onClose={closeDecisionSheet}>
        <div data-decision-sheet={request.project} className="flex min-h-0 flex-col">
          <DecisionTabs tab={tab} onTab={setTab} count={count} touch />
          {tab === "decisions"
            ? <DecisionList project={request.project} focus={focus} touch />
            : <ReportLog key={request.project} project={request.project} variant="screen" />}
        </div>
      </MobileSheet>
    );
  }
  return <DecisionDialog request={request} focus={focus} />;
}

function DecisionDialog({ request, focus }: { request: DecisionRequest; focus: { reviewId?: string; nonce: number } | null }) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDivElement>(null);
  useModalLayer({ containerRef: dialog, onClose: closeDecisionSheet });
  return createPortal(
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-6`}
      data-decision-sheet={request.project}
      onClick={(event) => { if (event.target === event.currentTarget) closeDecisionSheet(); }}
    >
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("decisions.listAria")} tabIndex={-1} className="flex h-[min(80vh,860px)] w-[min(560px,calc(100vw-48px))] min-h-0 flex-col overflow-hidden rounded-surface border border-border bg-card shadow-2 outline-none">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <h2 className="m-0 min-w-0 flex-1 truncate text-body font-bold text-primary">{t("decisions.listAria")}</h2>
          <button
            type="button"
            aria-label={t("common.close")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={closeDecisionSheet}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <DecisionList project={request.project} focus={focus} />
      </div>
    </div>,
    document.body,
  );
}
