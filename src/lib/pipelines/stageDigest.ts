import crypto from "node:crypto";

import type { PipelineStage } from "./types";

/**
 * A stage's configuration digest (#1695 C7): what `override-stage` would
 * change, fingerprinted so a caller can say which configuration its edit was
 * made against. `GET /api/pipelines/:id` answers it per stage, and
 * `override-stage` with `expectedStageDigest` refuses with 409 `STAGE_CHANGED`
 * when the stage no longer has it.
 *
 * It covers the stored stage fields an override writes, which are what the
 * stage's first attempt snapshots and starts with (`newAttempt` clones
 * `effectiveRole`; the spawn renders from that snapshot):
 *   - the reassembled prompt as stored (wiring tokens included);
 *   - the account pin, with an absent, `null` or blank pin all meaning "none",
 *     as `override-stage` itself treats them;
 *   - the role reference, with its parameters in key order, and no parameters
 *     the same as empty ones;
 *   - the stored `effectiveRole`: role id, engine, model, effort, access and
 *     prompt scaffold, with an absent model, effort or scaffold the same as
 *     `null`.
 * Values that mean the same stored stage digest the same; any stored change
 * digests differently, including an override that re-resolves the same role
 * against an edited role registry and only its scaffold moves. A registry
 * edit that no override has applied changes nothing stored, so it neither
 * moves the digest nor changes what the stage would start with.
 *
 * `v` versions this canonical form: v2 added the effective role id and
 * scaffold.
 */
export function stageDigestInput(stage: Pick<PipelineStage, "prompt" | "account" | "role" | "effectiveRole">): string {
  const account = typeof stage.account === "string" && stage.account.trim() ? stage.account.trim() : null;
  const params = stage.role?.params && Object.keys(stage.role.params).length
    ? Object.fromEntries(Object.entries(stage.role.params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    : null;
  const runtime = stage.effectiveRole;
  return JSON.stringify({
    v: 2,
    "prompt": stage.prompt,
    account,
    role: stage.role ? { roleId: stage.role.roleId, params } : null,
    runtime: {
      roleId: runtime.roleId ?? null,
      engine: runtime.engine,
      model: runtime.model ?? null,
      effort: runtime.effort ?? null,
      access: runtime.access ?? null,
      promptScaffold: runtime.promptScaffold ?? null,
    },
  });
}

/** SHA-256 (hex) of `stageDigestInput`. */
export function stageDigest(stage: Pick<PipelineStage, "prompt" | "account" | "role" | "effectiveRole">): string {
  return crypto.createHash("sha256").update(stageDigestInput(stage)).digest("hex");
}

/** Every stage's digest, by stage id. */
export function stageDigests(stages: readonly PipelineStage[]): Record<string, string> {
  return Object.fromEntries(stages.map((stage) => [stage.id, stageDigest(stage)] as const));
}

/** A well-formed digest: 64 lowercase hex characters. */
export function isStageDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
