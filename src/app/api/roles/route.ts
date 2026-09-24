import { NextRequest, NextResponse } from "next/server";

import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { BUILDER_VARIANT_DEFAULTS, loadRoleRegistrySnapshot, loadRoleRegistrySnapshotOrDefaults, parseRoleMappingPatch, RoleStoreError, ROLE_OVERRIDES_SCHEMA_VERSION, saveRoleMapping } from "@/lib/roles/store";
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
    /* promptPreview duplicates promptScaffold under the name the draft pane
       reads; `shipped` is the runtime before this install's mapping, so the
       mapping editor can tell "default" from "changed". */
    roles: roles.map((role) => ({
      ...role,
      promptPreview: role.promptScaffold,
      shipped: {
        config: ROLE_DEFAULTS.find((candidate) => candidate.id === role.id)!.config,
        ...(role.id === "builder" ? { variants: BUILDER_VARIANT_DEFAULTS } : {}),
      },
    })),
  };
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(catalog(loadRoleRegistrySnapshotOrDefaults()));
}

/**
 * The agent mapping's writer (#1876): `{ overrides: { [roleId]: { config,
 * variants } } }`, where a full config sets a row and `null` resets it to the
 * shipped value. It merges into the stored file, so a prompt-scaffold override
 * survives, and answers the merged catalog so the editor re-renders from the
 * server's truth.
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
