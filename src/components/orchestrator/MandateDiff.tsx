"use client";

import { useDeferredValue, useMemo } from "react";

import { useLocale } from "@/lib/i18n";

import { diffFromTexts } from "../feed/diff";
import { DiffRows, flattenHunks } from "../feed/cards/DiffCard";

/**
 * The rotate dialog's mandate diff: the incumbent's stored mandate against the
 * text the rotation will post, in the feed's own diff rows (tones, intraline
 * highlights) in their prose variant. Mounted only while the mandate section is
 * open, so the full model is never built for a collapsed line. The text is
 * deferred, so typing in the editor under a long diff stays responsive.
 */
export function MandateDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const { t } = useLocale();
  const deferred = useDeferredValue(newText);
  const file = useMemo(() => diffFromTexts(oldText, deferred), [oldText, deferred]);
  const rows = useMemo(() => flattenHunks(file.hunks), [file]);
  return (
    <div
      className="rounded-surface border border-border bg-sunken py-1 text-ui leading-[1.45]"
      data-orchestrator-mandate-diff
    >
      <DiffRows rows={rows} prose />
      {file.truncated ? <div className="border-t border-border px-2 pt-1 text-caption text-muted">{t("tools.diffTruncated")}</div> : null}
    </div>
  );
}
