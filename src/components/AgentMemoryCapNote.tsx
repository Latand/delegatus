"use client";

import { useLocale } from "@/lib/i18n";
import type { AgentMemoryCap } from "@/lib/runtime/agentMemoryConfig";

/** Shared launch receipt and stage-card resource disclosure. */
export function AgentMemoryCapNote({ cap }: { cap?: AgentMemoryCap | null }) {
  const { t } = useLocale();
  if (!cap) return null;
  const size = (bytes: number | null) => Number(((bytes ?? 0) / 2 ** 30).toFixed(2));
  return <div data-agent-memory-cap className="shrink-0 whitespace-normal break-words border-b border-border bg-card px-3 py-1.5 text-label leading-5 text-secondary">
    {cap.enforced && cap.limitBytes !== null
      ? t("agentMemory.cap", { size: size(cap.limitBytes) }) : t("agentMemory.unenforced")}
    {cap.clamped ? <> <span className="text-warning">{t("agentMemory.clamped", { size: size(cap.requestedBytes) })}</span></> : null}
  </div>;
}
