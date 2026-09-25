"use client";

import { ChevronRight, Folder, FolderPlus } from "lucide-react";
import { useState } from "react";

import { CreateProjectForm } from "@/components/ProjectRail";
import type { CreateProjectOutcome, CreateProjectRequestOptions } from "@/hooks/useProjectCuration";
import { useLocale } from "@/lib/i18n";

/**
 * Step 2, Project (#2166 §3.2): the project the orchestrator will work on.
 * The projects the rail lists that have a folder on disk are radio rows, the
 * one the guide opened over preselected, else the most recent; a project with
 * no folder (the "Unresolved project") is left out, since an orchestrator
 * cannot work there. "Open another folder" is the rail's own create form,
 * inline, and a project created there is chosen at once, so step 3 never
 * waits on the files feed to learn its folder.
 */

/** A project the guide can offer, with the folder its orchestrator works in. */
export type GuideProject = { project: string; name: string; cwd: string | null; conversations: number };

export function ProjectStep({ projects, chosen, onChoose, onCreate }: {
  /** Listed projects, most recent first; only those with a folder are offered. */
  projects: readonly GuideProject[];
  chosen: GuideProject | null;
  onChoose: (project: GuideProject) => void;
  onCreate?: (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;
}) {
  const { t } = useLocale();
  const onDisk = projects.filter((entry) => entry.cwd);
  /* A project created here a moment ago may not be in the list yet. */
  const rows = chosen && !onDisk.some((entry) => entry.project === chosen.project) ? [chosen, ...onDisk] : onDisk;
  const [formOpen, setFormOpen] = useState(false);
  const form = onCreate ? (
    <div data-onboarding-project-form="" className="flex flex-col gap-3 rounded-[10px] border border-accent/50 bg-card p-3">
      <div className="flex items-center gap-2 text-body font-semibold text-primary">
        <FolderPlus className="h-4 w-4 text-accent" aria-hidden />
        {t("onboarding.project.other")}
      </div>
      <CreateProjectForm
        className=""
        cancellable={rows.length > 0}
        onCreate={onCreate}
        onCancel={() => setFormOpen(false)}
        onCreated={(project, created) => {
          setFormOpen(false);
          onChoose({ project, name: created.name, cwd: created.root, conversations: 0 });
        }}
      />
    </div>
  ) : null;

  if (rows.length === 0) return form;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-label font-semibold uppercase tracking-[0.06em] text-muted">{t("onboarding.project.onDisk")}</div>
      <div role="radiogroup" aria-label={t("onboarding.project.heading")} className="flex flex-col gap-2">
        {rows.map((entry) => {
          const on = entry.project === chosen?.project;
          return (
            <button
              key={entry.project}
              type="button"
              role="radio"
              aria-checked={on}
              data-onboarding-project={entry.project}
              onClick={() => onChoose(entry)}
              className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:py-3 ${on ? "border-accent/50 bg-accent-soft/50" : "border-border bg-card hover:bg-sunken"}`}
            >
              <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${on ? "border-accent" : "border-strong"}`}>
                {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
              </span>
              <Folder className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-primary">{entry.name}</span>
                {entry.cwd ? <span className="truncate font-mono text-[11px] text-muted" title={entry.cwd}>{entry.cwd}</span> : null}
              </span>
              <span className="shrink-0 text-label text-muted">{t("onboarding.project.conversations", { count: entry.conversations })}</span>
            </button>
          );
        })}
      </div>
      {formOpen ? <div className="mt-2">{form}</div> : onCreate ? (
        <button
          type="button"
          data-onboarding-project-other=""
          onClick={() => setFormOpen(true)}
          className="mt-2 flex w-full items-center gap-3 rounded-[10px] border border-dashed border-strong px-3 py-2.5 text-left text-body text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:py-3"
        >
          <FolderPlus className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold text-primary">{t("onboarding.project.other")}</span>
            <span className="text-ui text-muted">{t("onboarding.project.otherHint")}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
