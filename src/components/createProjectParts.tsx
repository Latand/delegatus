"use client";

import { useEffect, useState } from "react";

import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { useLocale } from "@/lib/i18n";
import { folderName } from "@/lib/projects/folderName";

import { isDirectoryPath } from "./DirectoryPicker";
import { useTeamView } from "./team/teamClient";
import { ALL_WORKSPACES, effectiveWorkspace } from "./team/workspaceFilter";
import { useStoredWorkspace, useWorkspaces } from "./team/workspacesClient";

/*
 * The pieces the rail's create form and the phone sheet's create rows share
 * (docs/design/create-project-by-name.md §5): who is creating, which workspace
 * the new project joins, the words for a refusal, and the lines under the name.
 * Both forms ask the same stores the rest of the shell reads, so neither needs
 * a prop for it and the setup guide, which reuses the rail form, gets it too.
 */

type Translate = ReturnType<typeof useLocale>["t"];
type Failure = Extract<CreateProjectOutcome, { ok: false }>;

export interface CreateTarget {
  /** A signed-in team member who is not the owner: the default flow only. */
  member: boolean;
  /** The workspace to send, or null for an owner who is looking at All. */
  workspaceId: string | null;
  /** A member looking at All with two or more workspaces picks one. */
  choices: readonly { id: string; name: string }[];
  pick: (id: string) => void;
}

export function useCreateTarget(): CreateTarget {
  const team = useTeamView({ load: false });
  const teamOn = team?.mode === "team";
  const member = teamOn && team.me?.role === "member";
  const workspaces = useWorkspaces({ enabled: teamOn });
  const [stored] = useStoredWorkspace();
  const view = workspaces?.mode === "team" ? workspaces : null;
  const chosen = effectiveWorkspace(view, stored);
  const all = view?.workspaces ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const pickedId = all.some((workspace) => workspace.id === picked) ? picked : null;
  let workspaceId: string | null = null;
  if (chosen !== ALL_WORKSPACES) workspaceId = chosen;
  else if (member) workspaceId = pickedId ?? all[0]?.id ?? null;
  const choices = member && chosen === ALL_WORKSPACES && all.length >= 2 ? all.map(({ id, name }) => ({ id, name })) : [];
  return { member, workspaceId, choices, pick: setPicked };
}

/**
 * The line a refusal gets. On the default flow no line asks for a path; the
 * codes that belong to the existing-folder section keep their words there.
 * `name` is what was typed: the folder-name preview is computed from it, so
 * the line names the folder the person saw.
 */
export function createErrorText(t: Translate, outcome: Failure, name: string, member = false): string {
  switch (outcome.code) {
    case "INVALID_NAME": return t("rail.invalidName");
    case "INVALID_ROOT": return t("rail.invalidRoot");
    case "OUTSIDE_ROOTS": return t("rail.outsideRoots");
    case "DUPLICATE_PROJECT": return t("rail.duplicateProject");
    case "DUPLICATE_NAME": return t("rail.duplicateName", { name: outcome.displayName ?? name.trim() });
    case "NO_FREE_FOLDER": return t("rail.noFreeFolder", { slug: folderName(name) });
    case "PARENT_IN_REPOSITORY":
      return member || !outcome.parent ? t("rail.parentInRepositoryMember") : t("rail.parentInRepository");
    case "workspace_forbidden": return t("rail.workspaceForbidden");
    case "MKDIR_FAILED": return outcome.message ? `${t("rail.mkdirFailed")} — ${outcome.message}` : t("rail.mkdirFailed");
    default: return t("rail.createFailed");
  }
}

/**
 * `New folder: pr-gram`, the slug in monospace. The slug is the point of the
 * line, so it wraps in the rail's narrow form as it does on the phone instead
 * of being cut. `optional` is the line under the picker of an open «existing
 * folder» section with nothing chosen: it names what is empty and says the new
 * folder is created anyway.
 */
export function FolderPreview({ name, optional = false }: { name: string; optional?: boolean }) {
  const { t } = useLocale();
  if (!name.trim()) return null;
  const slug = folderName(name);
  const mark = "\u0001";
  const [before, after = ""] = t(optional ? "rail.newFolderOptional" : "rail.newFolderPreview", { slug: mark }).split(mark);
  return (
    <div
      data-create-folder-preview=""
      className="break-words px-0.5 text-[11px] text-muted"
    >
      {before}<span className="inline-block max-w-full break-all align-bottom font-mono text-secondary">{slug}</span>{after}
    </div>
  );
}

/** The member's native workspace choice (design D6), under a visible label so a
    bare workspace name is never mistaken for part of the project; nothing when
    there is none to make. */
export function WorkspaceChoice({ target, className, labelClass }: { target: CreateTarget; className: string; labelClass: string }) {
  const { t } = useLocale();
  if (!target.choices.length) return null;
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{t("rail.workspaceLabel")}</span>
      <select
        data-create-workspace=""
        className={`${className} min-w-0 truncate font-normal text-primary`}
        value={target.workspaceId ?? ""}
        onChange={(event) => target.pick(event.target.value)}
      >
        {target.choices.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
    </label>
  );
}

/**
 * Where a browse starts: the directory a path points at, or nothing at all.
 *
 * This is what the picker is asked for when it opens rather than when someone
 * types — opening is a request to see what is around the current root, not a
 * prefix to match, and answering it with the chosen path itself would list the
 * one directory already in hand. Everything the operator actually types goes to
 * the server verbatim, because the server is the only side that can look past
 * the rows already fetched. `isDirectoryPath` is the picker's own definition:
 * the two sides of this form agree on what a path is (issue #1223).
 */
function suggestionScope(query: string): string {
  const trimmed = query.trim();
  if (!isDirectoryPath(trimmed)) return "";
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/**
 * The suggestion source the picker cannot have (issue #1223): a project that
 * does not exist yet is absent from every known-directories list, so the rows
 * come from the filesystem, bounded server-side to the directories where this
 * machine's projects already live. Shared by the rail form and the phone sheet,
 * so both offer the same folder choice under the same plain label.
 *
 * The whole query goes over, not just the directory it points at. The picker
 * filters what it has been handed, and what it has been handed is one bounded
 * answer: a word matching a directory under a quiet anchor, or a name past the
 * first screenful of a crowded one, is simply not in it. Only the server can
 * look, so it is asked each time the query moves. Closed, nothing is requested.
 */
export function useDirectorySuggestions(enabled: boolean) {
  const [dirs, setDirs] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/projects/directories?q=" + encodeURIComponent(query))
      .then(async (response) => (response.ok ? await response.json() as { dirs?: unknown } : null))
      .then((payload) => {
        if (cancelled || !Array.isArray(payload?.dirs)) return;
        setDirs(payload.dirs.filter((dir): dir is string => typeof dir === "string"));
      })
      .catch(() => {
        /* No suggestions is the pre-#1223 state: the path can still be typed. */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, query]);
  const onQueryChange = (next: string, typed: boolean) => setQuery(typed ? next.trim() : suggestionScope(next));
  return { dirs, setQuery, onQueryChange };
}
