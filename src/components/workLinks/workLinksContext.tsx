"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { applyPipelineSnapshot } from "@/hooks/useFiles";
import { fireTasksChanged } from "@/components/tasks/taskApi";
import { EMPTY_FILES_WORK_LINKS, type FilesWorkLinks, type ResolvedWorkLinks } from "@/lib/forge/workLinks";
import { getLocale, translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * The resolved PR and issue links the board draws (#2059). `/api/files`
 * carries them for every pipeline and task it carries; an attach or detach
 * answers with the record's new links, and a pipeline's answer with those of
 * every task card that aggregates it, which stand in until the next poll
 * brings its own. A detach is drawn at once: the chip leaves before the
 * request, survives a poll that lands meanwhile, and comes back on a refusal.
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

type EditAnswer = { links: ReadonlyMap<string, ResolvedWorkLinks>; error: string | null };

async function send(target: WorkLinkTarget, action: "attach" | "detach", link: string): Promise<EditAnswer> {
  const url = target.kind === "pipeline" ? `/api/pipelines/${encodeURIComponent(target.id)}` : `/api/tasks/${encodeURIComponent(target.id)}`;
  const body = target.kind === "pipeline"
    ? { action: action === "attach" ? "attach-link" : "detach-link", link }
    : action === "attach" ? { attachLinks: link } : { detachLinks: link };
  try {
    const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => null)) as {
      pipeline?: Pipeline;
      workLinks?: ResolvedWorkLinks;
      taskWorkLinks?: Record<string, ResolvedWorkLinks>;
      error?: string;
    } | null;
    if (!response.ok) return { links: new Map(), error: json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status }) };
    if (json?.pipeline) applyPipelineSnapshot(json.pipeline, true);
    if (target.kind === "task") fireTasksChanged();
    const links = new Map<string, ResolvedWorkLinks>();
    if (json?.workLinks) links.set(keyOf(target), json.workLinks);
    for (const [taskId, resolved] of Object.entries(json?.taskWorkLinks ?? {})) links.set(keyOf({ kind: "task", id: taskId }), resolved);
    return { links, error: null };
  } catch {
    return { links: new Map(), error: translate(getLocale(), "common.serverUnavailable") };
  }
}

export function WorkLinksProvider({ value, children }: { value: FilesWorkLinks | undefined; children: ReactNode }) {
  const served = value ?? EMPTY_FILES_WORK_LINKS;
  const [local, setLocal] = useState<ReadonlyMap<string, ResolvedWorkLinks>>(new Map());
  /* Detaches still on their way, by record: drawn over every poll until they answer. */
  const detaching = useRef(new Map<string, number>());
  const shown = useRef({ served, local });
  useLayoutEffect(() => {
    shown.current = { served, local };
  });
  /* A newer poll is the authority again, except over a detach still on its way. */
  useEffect(() => {
    setLocal((current) => (current.size ? new Map([...current].filter(([key]) => detaching.current.has(key))) : current));
  }, [served]);
  const edit = useCallback(async (target: WorkLinkTarget, action: "attach" | "detach", link: string) => {
    const key = keyOf(target);
    const before = shown.current.local.get(key);
    const current = before ?? (target.kind === "pipeline" ? shown.current.served.pipelines[target.id] : shown.current.served.tasks[target.id]) ?? null;
    if (action === "detach" && current) {
      detaching.current.set(key, (detaching.current.get(key) ?? 0) + 1);
      setLocal((drawn) => new Map(drawn).set(key, { ...current, links: current.links.filter((entry) => `${entry.repository}#${entry.number}` !== link) }));
    }
    const answer = await send(target, action, link);
    if (action === "detach" && current) {
      const left = (detaching.current.get(key) ?? 1) - 1;
      if (left > 0) detaching.current.set(key, left);
      else detaching.current.delete(key);
      if (answer.error) setLocal((drawn) => {
        const next = new Map(drawn);
        if (before) next.set(key, before);
        else next.delete(key);
        return next;
      });
    }
    if (answer.links.size) setLocal((drawn) => new Map([...drawn, ...answer.links]));
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
