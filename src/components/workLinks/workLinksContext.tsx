"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { applyPipelineSnapshot } from "@/hooks/useFiles";
import { fireTasksChanged } from "@/components/tasks/taskApi";
import { EMPTY_FILES_WORK_LINKS, type FilesWorkLinks, type ResolvedWorkLinks } from "@/lib/forge/workLinks";
import { getLocale, translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * The resolved PR and issue links the board draws (#2059). `/api/files`
 * carries them for every pipeline and task it carries; an attach or detach
 * answers with the record's new links, which stand in until the next poll
 * brings its own.
 */

export type WorkLinkTarget = { kind: "pipeline"; id: string } | { kind: "task"; id: string };

type WorkLinksValue = {
  of: (target: WorkLinkTarget) => ResolvedWorkLinks | null;
  /** Attach or detach one reference; resolves to the refusal's sentence, or null. */
  edit: (target: WorkLinkTarget, action: "attach" | "detach", link: string) => Promise<string | null>;
};

const NO_LINKS: WorkLinksValue = { of: () => null, edit: async () => null };
const WorkLinksContext = createContext<WorkLinksValue>(NO_LINKS);

const keyOf = (target: WorkLinkTarget) => `${target.kind}:${target.id}`;

async function send(target: WorkLinkTarget, action: "attach" | "detach", link: string): Promise<{ links: ResolvedWorkLinks | null; error: string | null }> {
  const url = target.kind === "pipeline" ? `/api/pipelines/${encodeURIComponent(target.id)}` : `/api/tasks/${encodeURIComponent(target.id)}`;
  const body = target.kind === "pipeline"
    ? { action: action === "attach" ? "attach-link" : "detach-link", link }
    : action === "attach" ? { attachLinks: link } : { detachLinks: link };
  try {
    const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline; workLinks?: ResolvedWorkLinks; error?: string } | null;
    if (!response.ok) return { links: null, error: json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status }) };
    if (json?.pipeline) applyPipelineSnapshot(json.pipeline, true);
    if (target.kind === "task") fireTasksChanged();
    return { links: json?.workLinks ?? null, error: null };
  } catch {
    return { links: null, error: translate(getLocale(), "common.serverUnavailable") };
  }
}

export function WorkLinksProvider({ value, children }: { value: FilesWorkLinks | undefined; children: ReactNode }) {
  const served = value ?? EMPTY_FILES_WORK_LINKS;
  const [local, setLocal] = useState<ReadonlyMap<string, ResolvedWorkLinks>>(new Map());
  /* A newer poll is the authority again. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh payload retires the answers drawn ahead of it */
    setLocal((current) => (current.size ? new Map() : current));
  }, [served]);
  const edit = useCallback(async (target: WorkLinkTarget, action: "attach" | "detach", link: string) => {
    const answer = await send(target, action, link);
    if (answer.links) setLocal((current) => new Map(current).set(keyOf(target), answer.links!));
    return answer.error;
  }, []);
  const context = useMemo<WorkLinksValue>(() => ({
    of: (target) => local.get(keyOf(target)) ?? (target.kind === "pipeline" ? served.pipelines[target.id] : served.tasks[target.id]) ?? null,
    edit,
  }), [served, local, edit]);
  return <WorkLinksContext.Provider value={context}>{children}</WorkLinksContext.Provider>;
}

export function useWorkLinks(): WorkLinksValue {
  return useContext(WorkLinksContext);
}
