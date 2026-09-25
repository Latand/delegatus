"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { ProjectSettingRow } from "./ProjectSettingRow";

/*
 * "Merge when the review passes" (#2187 §6): one switch row with one muted
 * line under it, the one place the project's merge setting shows. The desktop
 * board's ⋯ menu and the phone's ⋯ sheet draw the same row; the phone's is
 * 44 px tall.
 */

export type SettingRead = { enabled: boolean; github: string | null };

/** Also read by the draft editor, which names the setting beside its
    finishes-the-task checkbox (#2187 §6). */
export async function readSetting(project: string): Promise<SettingRead | null> {
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
  return (
    <ProjectSettingRow
      label={t("projectSettings.mergeOnReview")}
      hint={hint}
      enabled={enabled}
      disabled={!read || noGithub || saving}
      failed={failed}
      variant={variant}
      rowProps={{ "data-merge-on-review": enabled ? "on" : "off", "data-merge-on-review-github": noGithub ? "none" : undefined }}
      switchProps={{ "data-merge-on-review-switch": "", onClick: toggle }}
    />
  );
}
