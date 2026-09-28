"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { ProjectSettingRow } from "@/components/ProjectSettingRow";

type Shared = { v: 1; all: boolean; projects: string[] };
type View = { shared: Shared; known: { key: string; name: string }[] };

export function ShareProjectRow({ project, variant }: { project: string; variant: "menu" | "sheet" }) {
  const { t } = useLocale();
  const [view, setView] = useState<View | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch("/api/links/shared", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<View> : null)
      .then((answer) => { if (live) setView(answer); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [project]);
  const eligible = view?.known.some((row) => row.key === project) ?? false;
  const enabled = eligible && Boolean(view?.shared.all || view?.shared.projects.includes(project));
  const toggle = async () => {
    if (!view || !eligible || saving || view.shared.all) return;
    setSaving(true); setFailed(false);
    const projects = enabled ? view.shared.projects.filter((key) => key !== project) : [...view.shared.projects, project];
    try {
      const response = await fetch("/api/links/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...view.shared, projects }) });
      if (!response.ok) throw new Error("failed");
      setView(await response.json() as View);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  };
  return <ProjectSettingRow label={t("links.shareProject")} hint={failed ? t("links.shareFailed") : eligible ? t(enabled ? "links.shareOn" : "links.shareOff") : t("links.cannotShare")}
    enabled={enabled} disabled={!view || !eligible || saving || view.shared.all} failed={failed} variant={variant}
    rowProps={{ "data-share-project": enabled ? "on" : "off" }} switchProps={{ "data-share-project-switch": "", onClick: () => void toggle() }} />;
}
