"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { writeProjectPresentation } from "@/components/projectActions/presentationClient";
import type { ProjectActionResult } from "@/components/projectActions/rights";
import { projectKey } from "@/components/projectModel";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { remapProjectSet } from "@/lib/projects/clientAliases";
import type { FileEntry } from "@/lib/types";

const STORAGE_KEY = "llvArchivedProjects";

function readStored(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStored(projects: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...projects]));
  } catch {
    // Private mode or full quota: the browser's older shelf just doesn't persist.
  }
}

export interface UseArchivedProjects {
  archivedProjects: ReadonlySet<string>;
  /** Drawn at once; the answer says whether the server kept it, and a refusal draws it back. */
  archiveProject: (project: string) => Promise<ProjectActionResult>;
  unarchiveProject: (project: string) => Promise<ProjectActionResult>;
}

const EMPTY: readonly string[] = [];

/**
 * Projects shelved without deleting their transcripts from disk.
 *
 * The shelf is the server's (`archivedProjects` in /api/files, written through
 * PUT /api/projects/settings), so every browser and the board's ⋯ menu and the
 * rail's row menu share it. A browser that shelved projects before that keeps
 * its own list in localStorage, read beside the server's; restoring a project
 * clears it from both.
 *
 * Real activity always wins: a project where any entry goes live or still has a
 * running process is off the shelf at once, and the server is told so, so a new
 * agent run brings the project back to the rail everywhere.
 */
export function useArchivedProjects(
  files: FileEntry[],
  projectAliases: Readonly<Record<string, string>> = {},
  serverArchived: readonly string[] = EMPTY,
): UseArchivedProjects {
  const [stored, setStored] = useState<Set<string>>(() => new Set());
  /* Mirrors `stored` synchronously so the effects below can read the latest
     value without listing the state as its own dependency (see useArchivedPaths
     for the cascading-render rationale). */
  const storedRef = useRef(stored);
  /* The presses the server has not confirmed yet, by project. */
  const [pending, setPending] = useState<ReadonlyMap<string, { archived: boolean; accepted: boolean }>>(new Map());
  const writes = useRef(new Map<string, Promise<ProjectActionResult>>());
  const confirmed = useRef(new Map<string, boolean>());
  /* Server-shelved projects this page has already told the server are active again. */
  const restored = useRef(new Set<string>());
  const [retry, setRetry] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(new Map<string, number>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, []);

  useEffect(() => {
    const loaded = readStored();
    storedRef.current = loaded;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setStored(loaded);
  }, []);

  useEffect(() => {
    const prev = storedRef.current;
    if (!prev.size) return;
    const next = remapProjectSet(prev, projectAliases);
    if (next.size === prev.size && [...next].every((project) => prev.has(project))) return;
    storedRef.current = next;
    setStored(next);
    writeStored(next);
  }, [projectAliases]);

  /* A running process counts as activity even when its last turn already
     finished (activity "recent", not "live"): an idle-but-alive agent in an
     archived project must still pull the project back to the rail. */
  const active = useMemo(() => {
    const projects = new Set<string>();
    for (const file of files) if (file.activity === "live" || file.proc === "running") projects.add(projectKey(file));
    return projects;
  }, [files]);

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- reconciling
       against the fresh server payload; the same-reference return makes an
       already-settled state a render no-op. */
    setPending((previous) => {
      if (!previous.size) return previous;
      const next = new Map(previous);
      for (const [project, press] of previous) if (press.accepted && serverArchived.includes(project) === press.archived) next.delete(project);
      return next.size === previous.size ? previous : next;
    });
    for (const project of confirmed.current.keys()) if (!pending.has(project) && !writes.current.has(project)) confirmed.current.delete(project);
    for (const project of restored.current) if (!serverArchived.includes(project)) restored.current.delete(project);
  }, [serverArchived, pending]);

  const archivedProjects = useMemo(() => {
    const next = new Set([...serverArchived, ...stored]);
    for (const [project, press] of pending) {
      if (press.archived) next.add(project);
      else next.delete(project);
    }
    for (const project of active) next.delete(project);
    return next;
  }, [serverArchived, stored, pending, active]);

  const press = useCallback(async (project: string, archived: boolean, activity = false): Promise<ProjectActionResult> => {
    const request = { archived, accepted: false };
    setPending((previous) => new Map(previous).set(project, request));
    /* Preserve press order on the server while the newest press draws immediately. */
    const write = (writes.current.get(project) ?? Promise.resolve()).then(() => writeProjectPresentation(project, activity ? { restoreOnActivity: true } : { archived }));
    writes.current.set(project, write);
    const result = await write;
    if (writes.current.get(project) === write) writes.current.delete(project);
    if (result.ok) confirmed.current.set(project, archived);
    if (result.ok && !archived && storedRef.current.has(project)) {
      const next = new Set(storedRef.current);
      next.delete(project);
      storedRef.current = next;
      setStored(next);
      writeStored(next);
    }
    if (result.ok) {
      setPending((previous) => previous.get(project) === request
        ? new Map(previous).set(project, { ...request, accepted: true })
        : previous);
      requestFilesRefresh();
      return result;
    }
    /* Only this press is dropped: a later press on the same project keeps its own. */
    setPending((previous) => {
      if (previous.get(project) !== request) return previous;
      const next = new Map(previous);
      if (confirmed.current.has(project)) next.set(project, { archived: confirmed.current.get(project)!, accepted: true });
      else next.delete(project);
      return next;
    });
    return result;
  }, []);

  useEffect(() => {
    const prev = storedRef.current;
    if (prev.size) {
      const next = new Set([...prev].filter((project) => !active.has(project)));
      if (next.size !== prev.size) {
        storedRef.current = next;
        setStored(next);
        writeStored(next);
      }
    }
    for (const project of serverArchived) {
      if (!active.has(project) || restored.current.has(project)) continue;
      if (failures.current.has(project) && retryTimer.current !== null) continue;
      restored.current.add(project);
      void press(project, false, true).then((result) => {
        if (result.ok) { failures.current.delete(project); return; }
        restored.current.delete(project);
        if (!mounted.current) return;
        const attempt = Math.min(6, (failures.current.get(project) ?? 0) + 1);
        failures.current.set(project, attempt);
        /* useFiles preserves unchanged array references. A paced retry must
           wake this effect itself; one timer coalesces failed projects and
           backs off to at most one retry per 30 seconds. */
        if (retryTimer.current === null) retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          setRetry((value) => value + 1);
        }, Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
      });
    }
    for (const project of failures.current.keys()) if (!active.has(project) || !serverArchived.includes(project)) failures.current.delete(project);
  }, [active, serverArchived, press, retry]);

  const archiveProject = useCallback((project: string) => press(project, true), [press]);
  const unarchiveProject = useCallback((project: string) => press(project, false), [press]);

  return { archivedProjects, archiveProject, unarchiveProject };
}
