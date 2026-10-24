"use client";
import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";

type Settings = { project: "cloud" | "local"; override: "cloud" | "local" | null };
export function PipelineCheckSettings({ id }: { id: string }) {
  const { locale } = useLocale();
  const uk = locale === "uk";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const url = `/api/pipelines/${encodeURIComponent(id)}/checks`;
  useEffect(() => {
    let active = true;
    void fetch(url).then(async response => {
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (active) setSettings(value);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [url]);
  async function save(scope: "lane" | "project", execution: string) {
    setSaving(true); setError(false);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, execution: execution || null }) });
      if (!response.ok) throw new Error();
      setSettings(await response.json());
    } catch { setError(true); } finally { setSaving(false); }
  }
  return <div className="flex flex-col gap-2 border-b border-border p-2 text-ui" role="group" aria-label={uk ? "Перевірки" : "Checks"}>
    {settings ? <>
      <label>{uk ? "Перевірки смуги" : "Lane checks"}<select aria-label={uk ? "Перевірки смуги" : "Lane checks"} data-cloud-check-lane className="ml-2 bg-card" disabled={saving} value={settings.override ?? ""} onChange={event => void save("lane", event.target.value)}>
        <option value="">{uk ? "Як у проєкті" : "Project default"}</option><option value="cloud">Cloud</option><option value="local">{uk ? "Локально" : "Local"}</option>
      </select></label>
      <label>{uk ? "Типово для проєкту" : "Project default"}<select aria-label={uk ? "Типово для проєкту" : "Project default"} data-cloud-check-project className="ml-2 bg-card" disabled={saving} value={settings.project} onChange={event => void save("project", event.target.value)}>
        <option value="cloud">Cloud</option><option value="local">{uk ? "Локально" : "Local"}</option>
      </select></label>
    </> : null}
    {error ? <span role="alert">{uk ? "Не вдалося оновити перевірки" : "Could not update checks"}</span> : null}
  </div>;
}
