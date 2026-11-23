"use client";

import { useEffect, useMemo, useState } from "react";

import { CATALOG_REFRESH_EVENT, type LaunchAccountCatalog, type LaunchEngine } from "@/components/draft/AgentLaunchControls";
import type { AccountOption } from "@/components/RuntimePill";
import { useTeamView } from "@/components/team/teamClient";
import { parseAccountLimits } from "@/hooks/useEngineAccounts";
import type { EnginePool, ProjectAccountsView } from "@/lib/team/contract";

/*
 * What a member sees of their project's account pool in the composer
 * (docs/design/team-memory-and-workspaces.md §5.2, W1). The owner keeps reading
 * the full account list; only a member reads this route. Every shape below is
 * derived from the one response, so the chip, the sheet and the launch body
 * cannot disagree about which accounts exist.
 */

type PoolEngine = "claude" | "codex";
export const POOL_ENGINES: readonly PoolEngine[] = ["claude", "codex"];

/** A signed-in person who is not the owner on a team install. Until the team
 *  view is known the owner's path runs, as it does for the stop button. */
export function useIsMember(): boolean {
  const view = useTeamView({ load: false });
  return view?.mode === "team" && view.me?.role !== "owner";
}

/** The pool of the project, read once and again whenever launch accounts are
 *  asked to refresh. `null` until the route answered, and for a project the
 *  member cannot read. */
export function useProjectAccounts(project: string, enabled: boolean): ProjectAccountsView | null {
  const [answer, setAnswer] = useState<{ project: string; view: ProjectAccountsView } | null>(null);
  useEffect(() => {
    if (!enabled || !project) return;
    let cancelled = false;
    const read = () => {
      void fetch(`/api/team/project-accounts?project=${encodeURIComponent(project)}`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok || cancelled) return;
          const body = await response.json() as ProjectAccountsView;
          if (!cancelled) setAnswer({ project, view: body });
        })
        .catch(() => {});
    };
    read();
    window.addEventListener(CATALOG_REFRESH_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(CATALOG_REFRESH_EVENT, read);
    };
  }, [project, enabled]);
  return enabled && answer?.project === project ? answer.view : null;
}

/** An engine is offered where its pool holds an account, or where there is no
 *  pool and an account is signed in (Delegatus then picks one). */
export function engineOffered(pool: EnginePool | undefined): boolean {
  if (!pool) return false;
  return pool.pool === "set" ? pool.accounts.length > 0 : pool.available;
}

export function offeredEngines(view: ProjectAccountsView | null): PoolEngine[] {
  return view ? POOL_ENGINES.filter((engine) => engineOffered(view.engines[engine])) : [];
}

/** The launch catalog of a member: only accounts that can take a launch, and
 *  no stored choice, so a launch that picks nothing is chosen by the server
 *  from the pool. Copilot has no pools and offers nothing here. */
export function memberLaunchCatalog(view: ProjectAccountsView | null): LaunchAccountCatalog | null {
  if (!view) return null;
  const rows = (engine: PoolEngine) => {
    const pool = view.engines[engine];
    return pool.pool === "set"
      ? pool.accounts.filter((account) => account.signedIn).map((account) => ({ id: account.id, label: account.label, authPresent: true, signedOut: false }))
      : [];
  };
  return {
    claude: { active: "", accounts: rows("claude") },
    codex: { active: "", accounts: rows("codex") },
    copilot: { active: "", accounts: [] },
  } satisfies Record<LaunchEngine, { active: string; accounts: unknown[] }>;
}

/** The pool's rows of one engine for the account panels, with the weekly
 *  reading and whether each account can take a launch. */
export function memberPoolRows(view: ProjectAccountsView | null, engine: PoolEngine): AccountOption[] {
  const pool = view?.engines[engine];
  if (!pool || pool.pool !== "set") return [];
  return pool.accounts.map((account) => ({ id: account.id, label: account.label, signedIn: account.signedIn, limits: parseAccountLimits(account.limits) }));
}

/** Memoised {@link memberLaunchCatalog} for a component. */
export function useMemberLaunchCatalog(view: ProjectAccountsView | null, member: boolean): LaunchAccountCatalog | null | undefined {
  return useMemo(() => (member ? memberLaunchCatalog(view) : undefined), [member, view]);
}
