"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { replaceRoleCatalog, type RoleCatalogItem } from "@/components/DraftAgentPane";
import { equivalentConfig } from "@/lib/roles/equivalents";
import type { RoleConfig, RoleEngine } from "@/lib/roles/types";

/**
 * The board maintainer's engine, model and effort, read from and written to the
 * role registry's `maintainer` row — the row Settings → agent mapping and the
 * `role_presets` tool edit. There is no second, per-project copy: this is a
 * window onto the same record, so a change here shows there and the reverse.
 *
 * Every choice offered comes from `launchChoices` in the `/api/roles` answer,
 * the launch catalogue the server validates against, so an invalid engine,
 * model or effort cannot be composed in the panel.
 */

export interface LaunchChoice {
  engine: RoleEngine;
  models: Array<{ id: string; label: string; shortLabel: string; use: string; efforts: readonly string[] }>;
}

export type MaintainerRuntime = Pick<RoleConfig, "engine" | "model" | "effort">;

export interface MaintainerRoleRead {
  /** The stored runtime, or null until the first answer. */
  config: RoleConfig | null;
  choices: readonly LaunchChoice[];
  /** The catalogue could not be read: the picker is not offered. */
  failed: boolean;
  /** Writes the runtime into the `maintainer` row. `ok` once the record holds
      the change; otherwise the server's refusal text, and `stale` when the
      mapping moved under the panel, so the choice made against the old value
      is dropped and the current one shown. */
  save: (runtime: MaintainerRuntime) => Promise<{ ok: true } | { ok: false; error: string; stale: boolean }>;
}

interface Catalogue {
  revision: string | null;
  config: RoleConfig;
  roles: RoleCatalogItem[];
  choices: LaunchChoice[];
}

const ROLES_URL = "/api/roles";

function parseCatalogue(body: unknown): Catalogue | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { revision?: unknown; roles?: unknown; launchChoices?: unknown };
  if (!Array.isArray(value.roles) || !Array.isArray(value.launchChoices)) return null;
  const roles = value.roles as RoleCatalogItem[];
  const row = roles.find((role) => role.id === "maintainer");
  if (!row) return null;
  return {
    revision: typeof value.revision === "string" ? value.revision : null,
    config: row.config,
    roles,
    choices: value.launchChoices as LaunchChoice[],
  };
}

let cache: Catalogue | null = null;

export function resetMaintainerRoleCacheForTests(): void {
  cache = null;
}

export function useMaintainerRole(enabled: boolean): MaintainerRoleRead {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(cache);
  const [failed, setFailed] = useState(false);
  const revision = useRef<string | null>(cache?.revision ?? null);

  const adopt = useCallback((next: Catalogue) => {
    cache = next;
    revision.current = next.revision;
    setCatalogue(next);
    setFailed(false);
  }, []);

  const read = useCallback(async (signal?: AbortSignal): Promise<Catalogue | null> => {
    const response = await fetch(ROLES_URL, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) return null;
    return parseCatalogue(await response.json().catch(() => null));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void read(controller.signal)
      .then((next) => {
        if (next) adopt(next);
        else setFailed(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [enabled, read, adopt]);

  const save = useCallback(async (runtime: MaintainerRuntime): Promise<{ ok: true } | { ok: false; error: string; stale: boolean }> => {
    const stored = cache?.config;
    if (!stored) return { ok: false, error: "the maintainer's runtime has not been read yet", stale: false };
    /* Everything the row already carries that the picker does not touch — the
       service tier — survives a change of model and is dropped with a change
       of engine, where it would name a tier the other engine does not have. */
    const config: RoleConfig = stored.engine === runtime.engine ? { ...stored, ...runtime } : { ...runtime };
    try {
      const response = await fetch(ROLES_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(revision.current ? { expectedRevision: revision.current } : {}),
          overrides: { maintainer: { config } },
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const next = response.ok ? parseCatalogue(body) : null;
      if (next) {
        adopt(next);
        replaceRoleCatalog(next.roles);
        return { ok: true };
      }
      if (response.status === 409) {
        /* The mapping moved under the panel: the answer carries the current
           catalogue, so the picker shows it and the operator chooses again. */
        const current = parseCatalogue(body);
        if (current) adopt(current);
        return { ok: false, error: "the agent mapping changed meanwhile; the current value is shown", stale: true };
      }
      return { ok: false, error: typeof body?.error === "string" && body.error ? body.error : `the save was refused (${response.status})`, stale: false };
    } catch {
      return { ok: false, error: "the save got no answer; nothing more was sent", stale: false };
    }
  }, [adopt]);

  return { config: catalogue?.config ?? null, choices: catalogue?.choices ?? [], failed, save };
}

/** The model a switch to `engine` lands on: the catalogue's equivalent of the
    current one when it offers it, else the engine's first model. The effort is
    kept when the new model has that tier and otherwise lands on the nearest
    one the model's own ladder offers. */
export function runtimeForEngine(choices: readonly LaunchChoice[], from: MaintainerRuntime, engine: RoleEngine): MaintainerRuntime {
  const models = choices.find((choice) => choice.engine === engine)?.models ?? [];
  if (from.engine === engine || models.length === 0) return { ...from, engine };
  const wanted = equivalentConfig({ ...from }, engine).model;
  const model = models.find((candidate) => candidate.id === wanted) ?? models[0]!;
  return { engine, model: model.id, effort: effortFor(model.efforts, from.effort) };
}

export function runtimeForModel(choices: readonly LaunchChoice[], from: MaintainerRuntime, modelId: string): MaintainerRuntime {
  const model = choices.find((choice) => choice.engine === from.engine)?.models.find((candidate) => candidate.id === modelId);
  return model ? { engine: from.engine, model: model.id, effort: effortFor(model.efforts, from.effort) } : from;
}

const TIERS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** `effort` when the ladder has it, else the highest tier of the ladder that
    does not exceed it, else the ladder's lowest. */
function effortFor(ladder: readonly string[], effort: string): string {
  if (ladder.includes(effort)) return effort;
  const rank = TIERS.indexOf(effort);
  const below = ladder.filter((tier) => TIERS.indexOf(tier) <= rank);
  return below.length > 0 ? below[below.length - 1]! : ladder[0] ?? effort;
}
