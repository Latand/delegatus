"use client";

import { useCallback, useState } from "react";

import { MemorySourceRow, type MemorySourceState } from "@/components/memory/MemorySourceRow";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

/**
 * "Later, any time" → Memory: the Settings row that keeps one memory in
 * Delegatus, in its own frame. The row says why its switch is off until an
 * orchestrator exists (the import runs as an agent's work); while it does, the
 * step offers the way to the orchestrator step instead of a second control.
 */
export function MemoryStep({ onGoOrchestrator, onState }: { onGoOrchestrator: () => void; onState?: (state: MemorySourceState) => void }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [state, setState] = useState<MemorySourceState>("loading");
  const report = useCallback((next: MemorySourceState) => { setState(next); onState?.(next); }, [onState]);
  return (
    <div data-onboarding-memory="" className="flex flex-col items-start gap-4 max-sm:items-stretch">
      <div className="w-full rounded-[10px] border border-border bg-card">
        <MemorySourceRow phone={isMobile} inset onState={report} />
      </div>
      {state === "needs-orchestrator" ? (
        <button
          type="button"
          data-onboarding-memory-go="orchestrator"
          onClick={onGoOrchestrator}
          className="inline-flex h-9 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
        >
          {t("onboarding.memory.goOrchestrator")}
        </button>
      ) : null}
    </div>
  );
}
