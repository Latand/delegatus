import { loadPipelines, loadArchivedPipelines } from "@/lib/pipelines/store";
import { listRoles, roleScaffoldBody, roleFenceBlock } from "@/lib/roles/registry";
import { defaultRoleParameterValue } from "@/lib/roles/parameters";
import { canonicalProject } from "@/lib/projects/aliases";
import { canonicalScope, projectView, roleMemoryCollection, RoleMemoryRefusal } from "../roleStore";
import { isCrossProjectRoleScope, scopeRole } from "../roleScopes";
import { scopeChars } from "../roleConsolidate";
import { ROLE_MEMORY_BOUND } from "../roleTypes";
import type { CuratorPass } from "./store";

const PAGE_BYTES = 24_000;
/** Local evidence stays local; cursors are bound to the scope's revision. */
export function readCuration(pass: CuratorPass, scope?: string, cursor?: string, now = Date.now()) {
  const view = projectView(pass.project, now);
  const all = roleMemoryCollection()?.snapshot() ?? [];
  if (!scope) return { pass: pass.id, scopes: pass.scopes.map(key => {
    const held = view.scopes.find(s => s.scope === key);
    return { scope: key, revision: held?.revision ?? 0, chars: held?.chars ?? 0, bound: ROLE_MEMORY_BOUND, active: held?.active.length ?? 0, left: held?.left.length ?? 0 };
  }) };
  if (!pass.scopes.includes(scope)) throw new RoleMemoryRefusal("CURATE_SCOPE", "scope does not belong to this pass");
  const held = all.find(r => r.kind === "scope" && r.scope === scope);
  const revision = held?.kind === "scope" ? held.revision : 0;
  let offset = 0;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (parsed.scope !== scope || parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw Error();
      offset = parsed.offset;
    } catch { throw new RoleMemoryRefusal("CURATE_STALE", "scope or cursor changed; read it again"); }
  }
  const role = scopeRole(scope);
  const definition = role ? listRoles().find(r => r.id === role) : null;
  const scaffold = definition ? roleScaffoldBody(definition, Object.fromEntries(definition.parameters.map(parameter => [parameter.key, defaultRoleParameterValue(parameter)]))) + roleFenceBlock(definition) : null;
  const rules = view.scopes.find(s => s.scope === scope);
  const since = held?.kind === "scope" ? held.curatedAt ?? "" : "";
  const history = held?.kind === "scope" ? held.history : [];
  const departuresSince = history.some(h => h.pass === pass.id)
    ? history.filter(h => h.by === "curator" && h.pass !== pass.id).map(h => h.at).sort().at(-1) ?? ""
    : since;
  const entries: Record<string, unknown>[] = [
    ...(rules?.active.slice().reverse().map(({ versions, ...rule }) => ({ kind: "active", ...rule, newSincePass: rule.changedAt > since, versionCount: versions?.length ?? 0, earlierText: versions?.at(-1) })) ?? []),
    ...(rules?.left.filter(rule => rule.reason === "budget" || rule.changedAt > departuresSince).map(({ versions, ...rule }) => ({ kind: "left", ...rule, versionCount: versions?.length ?? 0 })) ?? []),
  ];
  if (role && !isCrossProjectRoleScope(scope)) entries.push(...all.flatMap(row => row.kind === "rule" && row.state === "active" && !row.versionOf && canonicalScope(row.scope) !== scope && scopeRole(row.scope) === role && !isCrossProjectRoleScope(row.scope) ? [{ kind: "other-project", id: row.id, scope: canonicalScope(row.scope), rule: row.rule, why: row.why, readOnly: true }] : []));
  const attempts: Record<string, number> = {};
  for (const pipeline of [...loadPipelines(), ...loadArchivedPipelines()]) if (canonicalProject(pipeline.project) === pass.project) {
    for (const run of pipeline.runs) {
      const roleId = pipeline.stages.find(s => s.id === run.stageId)?.role?.roleId ?? "unassigned";
      attempts[roleId] ??= 0;
      for (const attempt of run.attempts) if (attempt.startedAt && Date.parse(attempt.startedAt) <= now && now - Date.parse(attempt.startedAt) <= 30 * 24 * 60 * 60_000) {
        const actualRole = attempt.effectiveRole?.roleId ?? roleId;
        attempts[actualRole] = (attempts[actualRole] ?? 0) + 1;
      }
    }
  }
  const meta = { pass: pass.id, scope, revision, chars: rules?.chars ?? scopeChars([]), bound: ROLE_MEMORY_BOUND, attempts, scaffold };
  const page: Record<string, unknown>[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(meta)) + 512;
  while (offset + page.length < entries.length) {
    const entry = entries[offset + page.length];
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + size > PAGE_BYTES) {
      if (!page.length) throw new RoleMemoryRefusal("CURATE_PAGE", "a rule exceeds the read budget; read its versions in the operator window");
      break;
    }
    page.push(entry); bytes += size;
  }
  const next = offset + page.length;
  return { ...meta, rules: page, cursor: next < entries.length ? Buffer.from(JSON.stringify({ scope, revision, offset: next })).toString("base64url") : null };
}
