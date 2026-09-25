"use client";

import { useEffect, useId, useState } from "react";

import { useLocale } from "@/lib/i18n";

/*
 * "Merge when the review passes" (#2187 §6): one switch row with one muted
 * line under it, the one place the project's merge setting shows. The desktop
 * board's ⋯ menu and the phone's ⋯ sheet draw the same row; the phone's is
 * 44 px tall.
 */

type SettingRead = { enabled: boolean; github: string | null };

async function readSetting(project: string): Promise<SettingRead | null> {
  try {
    const response = await fetch(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { mergeOnReview?: { enabled?: unknown }; github?: unknown };
    return { enabled: body.mergeOnReview?.enabled === true, github: typeof body.github === "string" ? body.github : null };
  } catch {
    return null;
  }
}

async function writeSetting(project: string, enabled: boolean): Promise<boolean> {
  try {
    const response = await fetch("/api/projects/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, mergeOnReview: enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function MergeOnReviewRow({ project, variant, initial }: {
  project: string;
  variant: "menu" | "sheet";
  /** A known answer, drawn without a read (the evidence drivers pass one). */
  initial?: SettingRead;
}) {
  const { t } = useLocale();
  const hintId = useId();
  const [read, setRead] = useState<SettingRead | null>(initial ?? null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initial) return;
    let live = true;
    void readSetting(project).then((answer) => { if (live) setRead(answer); });
    return () => { live = false; };
  }, [project, initial]);

  const enabled = read?.enabled === true;
  const noGithub = read !== null && !read.github;
  const toggle = () => {
    if (!read || saving || noGithub) return;
    const next = !enabled;
    setRead({ ...read, enabled: next });
    setSaving(true);
    setFailed(false);
    void writeSetting(project, next).then((ok) => {
      setSaving(false);
      if (ok) return;
      setRead((current) => (current ? { ...current, enabled: !next } : current));
      setFailed(true);
    });
  };
  const hint = failed
    ? t("projectSettings.mergeOnReview.failed")
    : noGithub ? t("projectSettings.mergeOnReview.noGithub")
      : t(enabled ? "projectSettings.mergeOnReview.on" : "projectSettings.mergeOnReview.off");
  const sheet = variant === "sheet";
  return (
    <div data-merge-on-review={enabled ? "on" : "off"} data-merge-on-review-github={noGithub ? "none" : undefined} className={sheet ? "flex flex-col gap-0.5 px-4 py-1" : "flex flex-col gap-0.5 px-2 py-1"}>
      <div className={`flex items-center gap-2 ${sheet ? "min-h-11" : "min-h-8"}`}>
        <span className={`min-w-0 flex-1 font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{t("projectSettings.mergeOnReview")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("projectSettings.mergeOnReview")}
          aria-describedby={hintId}
          disabled={!read || noGithub || saving}
          data-merge-on-review-switch=""
          onClick={toggle}
          className={`relative flex shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${sheet ? "h-11 w-12" : "h-6 w-9"} rounded-full`}
        >
          <span aria-hidden className={`block h-5 w-9 rounded-full border transition-colors ${enabled ? "border-accent bg-accent" : "border-border bg-well"}`}>
            <span className={`mt-[1px] block h-4 w-4 rounded-full bg-card shadow transition-transform ${enabled ? "translate-x-[17px]" : "translate-x-[1px]"}`} />
          </span>
        </button>
      </div>
      <span id={hintId} role="status" className={`text-[11px] leading-snug ${failed ? "text-danger" : "text-muted"}`}>{hint}</span>
    </div>
  );
}
