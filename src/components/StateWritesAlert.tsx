"use client";

import { useLocale } from "@/lib/i18n";
import type { FilesResponse } from "@/lib/types";

/** Computed health arrives with files; showing this alert requires no write. */
export function StateWritesAlert({ storage }: { storage?: FilesResponse["systemHealth"]["storage"] }) {
  const { t, locale } = useLocale();
  const writes = storage?.writes;
  if (writes?.state !== "disk-full") return null;
  const free = writes.freeBytes === null ? t("stateWrites.unknown")
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(writes.freeBytes / 1024 / 1024)} MiB`;
  return (
    <div role="alert" data-state-writes-alert className="shrink-0 border-t border-danger/40 bg-raised px-3 py-2 text-xs leading-relaxed text-danger" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
      <strong className="block">{t("stateWrites.title")}</strong>
      <span>{t("stateWrites.free", { free })} {writes.since ? t("stateWrites.since", { time: new Date(writes.since).toLocaleTimeString(locale) }) : ""} {t("stateWrites.recovery")}</span>
    </div>
  );
}
