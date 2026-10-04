import { NextRequest, NextResponse } from "next/server";

import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { ENGINE_MODELS, validateLaunchModel } from "@/lib/agent/models";
import { effortScale } from "@/lib/agent/efforts";
import { ROLE_VARIANT_DEFAULTS } from "@/lib/roles/paramConfig";
import { loadRoleRegistrySnapshot, loadRoleRegistrySnapshotOrDefaults, parseRoleMappingPatch, RoleStoreError, ROLE_OVERRIDES_SCHEMA_VERSION, saveRoleMapping } from "@/lib/roles/store";
import type { RoleRegistrySnapshot } from "@/lib/roles/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function catalog(snapshot: RoleRegistrySnapshot) {
  const { roles } = snapshot;
  return {
    /* Newest schema of the overrides file this build reads and writes. */
    schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION,
    revision: snapshot.revision,
    health: snapshot.health,
    /* The launch catalogue and per-model reasoning ladders also drive the
       maintainer picker. Role runtimes stay in the same registry row. */
    launchChoices: (["claude", "codex"] as const).map(engine => ({
      engine,
      models: ENGINE_MODELS[engine].map(model => ({ ...model, efforts: effortScale(engine, model.id)! })),
    })),
    /* promptPreview duplicates promptScaffold under the name the draft pane
       reads; `shipped` is the runtime and prompt text before this install's
       mapping, so the mapping editor can tell "default" from "changed". */
    roles: roles.map((role) => ({
      ...role,
      promptPreview: role.promptScaffold,
      shipped: {
        config: ROLE_DEFAULTS.find((candidate) => candidate.id === role.id)!.config,
        promptScaffold: ROLE_DEFAULTS.find((candidate) => candidate.id === role.id)!.promptScaffold,
        ...(role.id in ROLE_VARIANT_DEFAULTS ? { variants: ROLE_VARIANT_DEFAULTS[role.id as keyof typeof ROLE_VARIANT_DEFAULTS] } : {}),
      },
    })),
    /* Rows a retirement set back to the default that the operator has not
       touched since (docs/design/model-sizing-tiers.md §5). */
    resets: snapshot.resets ?? [],
  };
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(catalog(loadRoleRegistrySnapshotOrDefaults()));
}

/**
 * The agent mapping's writer (#1876): `{ overrides: { [roleId]: { config,
 * variants, promptScaffold } } }`, where a full config sets a row and `null`
 * resets it to the shipped value; `promptScaffold` accepts only `null`, which
 * restores the shipped prompt text. It merges into the stored file, so a
 * prompt-scaffold override survives a runtime edit, and answers the merged
 * catalog so the editor re-renders from the server's truth.
 */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
  const expectedRevision = (body as { expectedRevision?: unknown }).expectedRevision;
  if (expectedRevision !== undefined && (typeof expectedRevision !== "string" || !expectedRevision || expectedRevision.length > 128)) {
    return NextResponse.json({ error: "expectedRevision must be a non-empty revision string" }, { status: 400 });
  }
  const patch = parseRoleMappingPatch((body as { overrides?: unknown }).overrides);
  if (typeof patch === "string") return NextResponse.json({ error: patch }, { status: 400 });
  for (const override of Object.values(patch)) {
    for (const config of [override.config, ...Object.values(override.variants ?? {})]) {
      if (!config) continue;
      if (config.engine !== "claude" && config.engine !== "codex") return NextResponse.json({ error: "role engine must be claude or codex" }, { status: 400 });
      const model = validateLaunchModel(config.engine, config.model);
      if ("error" in model) return NextResponse.json({ error: model.error }, { status: 400 });
    }
  }
  try {
    const current = loadRoleRegistrySnapshot();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      return NextResponse.json(catalog(current), { status: 409 });
    }
    saveRoleMapping(patch);
    return NextResponse.json(catalog(loadRoleRegistrySnapshot()));
  } catch (error) {
    if (error instanceof RoleStoreError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
