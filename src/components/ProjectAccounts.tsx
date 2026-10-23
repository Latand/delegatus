"use client";

import { useEffect, useRef, useState } from "react";

import { useAccountIdentityVersion, useAccountLimitsVersion } from "@/hooks/useEngineAccounts";

import { EngineAccountSwitch, type EngineAccountSwitchAppearance } from "./EngineAccountSwitch";

/** One engine's block of the project view served by /api/account-project-bindings. */
export interface ProjectAccountsEngineView {
  engine: "claude" | "codex";
  nextChosenAccountId?: string | null;
  restricted: boolean;
  allowed: { accountId: string; label: string }[];
  carrying: { accountId: string; label: string }[];
  /** Accounts somebody deliberately chose from outside the pool, newest first. */
  outsidePool: { accountId: string; label: string; at: string; actor: "operator" | "agent" }[];
}

export interface ProjectAccountsView {
  project: string;
  engines: ProjectAccountsEngineView[];
}

/** Crash-safe read of the route's project view; anything malformed renders nothing. */
export function parseProjectAccountsView(body: unknown): ProjectAccountsView | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.project !== "string" || !record.project) return null;
  const engines = record.engines;
  if (!engines || typeof engines !== "object") return null;
  const parsed = (["claude", "codex"] as const).flatMap((engine) => {
    const block = (engines as Record<string, unknown>)[engine];
    if (!block || typeof block !== "object") return [];
    const view = block as Record<string, unknown>;
    const accounts = (value: unknown) => Array.isArray(value)
      ? value.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          return typeof entry.accountId === "string" && entry.accountId
            ? [{ accountId: entry.accountId, label: typeof entry.label === "string" && entry.label ? entry.label : entry.accountId }]
            : [];
        })
      : [];
    const outsidePool = Array.isArray(view.outsidePool)
      ? view.outsidePool.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.accountId !== "string" || !entry.accountId) return [];
          return [{
            accountId: entry.accountId,
            label: typeof entry.label === "string" && entry.label ? entry.label : entry.accountId,
            at: typeof entry.at === "string" ? entry.at : "",
            actor: entry.actor === "agent" ? "agent" as const : "operator" as const,
          }];
        })
      : [];
    return [{
      engine,
      ...(typeof view.nextChosenAccountId === "string" ? { nextChosenAccountId: view.nextChosenAccountId } : {}),
      restricted: view.restricted === true,
      allowed: accounts(view.allowed),
      carrying: accounts(view.carrying),
      outsidePool,
    }];
  });
  return { project: record.project, engines: parsed };
}

/**
 * The project side of #1279's relation: which accounts this project may use,
 * which of them are carrying its work right now, and which were deliberately
 * chosen from outside that set.
 *
 * It stays silent for a project that is neither fenced nor busy. Relevant
 * engines each get one compact active-account switch; project pool, carrier,
 * and out-of-pool detail moves into that switch's panel (#1331).
 */
export function ProjectAccounts({ project, appearance }: { project: string; appearance?: EngineAccountSwitchAppearance }) {
  const [result, setResult] = useState<{ revision: string; view: ProjectAccountsView } | null>(null);
  /* A removal drops the account's bindings, so the strip reads again when an
     engine's accounts change; it clears only for another project, so an
     accounts panel open under it stays open through the re-read. */
  const claudeAccounts = useAccountIdentityVersion("claude");
  const codexAccounts = useAccountIdentityVersion("codex");
  const claudeLimits = useAccountLimitsVersion("claude");
  const codexLimits = useAccountLimitsVersion("codex");
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const shownProject = useRef<string | null>(null);
  const revision = JSON.stringify([project, claudeAccounts, codexAccounts, claudeLimits, codexLimits, refreshEpoch]);

  useEffect(() => {
    const timer = setInterval(() => setRefreshEpoch((current) => current + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    if (shownProject.current !== project) {
      shownProject.current = project;
      setResult(null);
    }
    void (async () => {
      try {
        const response = await fetch(`/api/account-project-bindings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
        if (!response.ok) return;
        const parsed = parseProjectAccountsView(await response.json());
        if (live && parsed && parsed.project === project) setResult({ revision, view: parsed });
      } catch {
        // A failed read leaves the strip absent rather than guessing at a fence.
      }
    })();
    return () => { live = false; };
  }, [project, claudeAccounts, codexAccounts, claudeLimits, codexLimits, refreshEpoch, revision]);

  return <ProjectAccountsStrip view={result?.view.project === project ? result.view : null} appearance={appearance} />;
}

/** The rendering half, separated so it can be exercised without a fetch. */
export function ProjectAccountsStrip({ view, appearance }: { view: ProjectAccountsView | null; appearance?: EngineAccountSwitchAppearance }) {
  const shown = (view?.engines ?? []).filter((engine) =>
    engine.restricted || engine.carrying.length > 0 || engine.outsidePool.length > 0);
  if (!view || !shown.length) return null;
  return (
    /* In the header bar the switches are one group, 8 px apart; in its ⋯ menu, one row per engine. */
    <div
      data-project-accounts={view.project}
      className={appearance === "menu" ? "flex flex-col gap-0.5" : `flex min-w-0 shrink-0 items-center ${appearance === "bar" ? "gap-2" : "gap-1"}`}
    >
      {shown.map((engine) => (
        <EngineAccountSwitch
          key={engine.engine}
          engine={engine.engine}
          appearance={appearance}
          projectContext={{
            project: view.project,
            nextChosenAccountId: engine.nextChosenAccountId,
            restricted: engine.restricted,
            allowed: engine.allowed,
            carrying: engine.carrying,
            outsidePool: engine.outsidePool,
          }}
        />
      ))}
    </div>
  );
}
