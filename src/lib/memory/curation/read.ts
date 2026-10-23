import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { readImportBatch } from "../importCuration";
import { pipelineSelectionSource } from "@/lib/pipelines/store";
import { readHistoryProjection, historyAttemptCounts } from "@/lib/state/historyProjection";
import { listRoles, roleScaffoldBody, roleFenceBlock } from "@/lib/roles/registry";
import { defaultRoleParameterValue } from "@/lib/roles/parameters";
import { canonicalProject } from "@/lib/projects/aliases";
import { canonicalScope, projectViewAsync, RoleMemoryRefusal } from "../roleStore";
import { isCrossProjectRoleScope, scopeRole, scopeProject } from "../roleScopes";
import { scopeChars } from "../roleConsolidate";
import { ROLE_MEMORY_BOUND } from "../roleTypes";
import { otherProjectRoleRules, roleScopeReadMetadata, ruleUsageCounts } from "../roleViewSource";
import { swarmRulesForRole } from "../swarmPack";
import { swarmRulesEnabled } from "../settings";
import type { CuratorPass } from "./store";

const PAGE_BYTES = 24_000;
/** Local evidence stays local; cursors are bound to the scope's revision. */
export function readCuration(pass: CuratorPass, scope?: undefined, cursor?: string, now?: number): Promise<Extract<Awaited<ReturnType<typeof readRuleCuration>>, { scopes: unknown }>>;
export function readCuration(pass: CuratorPass, scope: "imports", cursor?: string, now?: number): Promise<{ pass: string; candidates: Awaited<ReturnType<typeof readImportBatch>> }>;
export function readCuration(pass: CuratorPass, scope?: string, cursor?: string, now?: number): ReturnType<typeof readRuleCuration>;
export async function readCuration(pass: CuratorPass, scope?: string, cursor?: string, now = Date.now()) {
  if (scope === "imports") return { pass: pass.id, candidates: await withViewerOperation("memory.import.curation", () => readImportBatch(pass)) };
  return readRuleCuration(pass, scope, cursor, now);
}
async function readRuleCuration(pass: CuratorPass, scope?: string, cursor?: string, now = Date.now()) {
  if (scope && !pass.scopes.some(key => canonicalScope(key) === canonicalScope(scope))) throw new RoleMemoryRefusal("CURATE_SCOPE", "scope does not belong to this pass");
  const project = canonicalProject(scope && scopeProject(canonicalScope(scope)) || pass.project);
  if (scope) pipelineSelectionSource();
  const attempts = scope ? await readHistoryProjection(db => historyAttemptCounts(db, project, now), { collections: ["pipelines","pipelines_archive"] }) : {};
  const scopes = [...new Set(pass.scopes.map(canonicalScope))];
  const view = await projectViewAsync(project, now);
  if (!scope) return { pass: pass.id, ...(pass.importBatch ? { import: { candidates: pass.importBatch.candidates.length, scope: "imports" } } : {}), scopes: scopes.map(key => {
    const held = view.scopes.find(s => s.scope === key);
    return { scope: key, revision: held?.revision ?? 0, chars: held?.chars ?? 0, bound: ROLE_MEMORY_BOUND, active: held?.active.length ?? 0, left: held?.left.length ?? 0 };
  }) };
  const resolvedScope = canonicalScope(scope);
  if (!scopes.includes(resolvedScope)) throw new RoleMemoryRefusal("CURATE_SCOPE", "scope does not belong to this pass");
  const held = roleScopeReadMetadata(resolvedScope, pass.id);
  const revision = held.revision;
  let offset = 0;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (parsed.scope !== resolvedScope || parsed.revision !== revision || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw Error();
      offset = parsed.offset;
    } catch { throw new RoleMemoryRefusal("CURATE_STALE", "scope or cursor changed; read it again"); }
  }
  const role = scopeRole(resolvedScope);
  const definition = role ? listRoles().find(r => r.id === role) : null;
  const scaffold = definition ? roleScaffoldBody(definition, Object.fromEntries(definition.parameters.map(parameter => [parameter.key, defaultRoleParameterValue(parameter)]))) + roleFenceBlock(definition) : null;
  const rules = view.scopes.find(s => s.scope === resolvedScope);
  const since = held.curatedAt ?? "";
  const departuresSince = held.hasPass ? held.departuresSince : since;
  const entries: Record<string, unknown>[] = [
    ...(rules?.active.slice().reverse().map(({ versions, ...rule }) => ({ kind: "active", ...rule, newSincePass: !!rule.awaitingCuration || rule.changedAt > since, versionCount: versions?.length ?? 0, earlierText: versions?.at(-1) })) ?? []),
    ...(rules?.left.filter(rule => rule.reason === "budget" || rule.changedAt > departuresSince).map(({ versions, ...rule }) => ({ kind: "left", ...rule, versionCount: versions?.length ?? 0 })) ?? []),
  ];
  if (role && !isCrossProjectRoleScope(resolvedScope)) entries.push(...otherProjectRoleRules(resolvedScope).map(row => ({ kind: "other-project", id: row.id, scope: canonicalScope(row.scope), rule: row.rule, why: row.why, readOnly: true })));
  const usage = ruleUsageCounts(entries.map(entry => String(entry.id)));
  for (const entry of entries) Object.assign(entry, usage[String(entry.id)] ?? { applied: 0, misled: 0 });
  const meta = { pass: pass.id, scope: resolvedScope, revision, chars: rules?.chars ?? scopeChars([]), bound: ROLE_MEMORY_BOUND, attempts, scaffold,
    swarmReceiving: swarmRulesEnabled(), swarm: role ? swarmRulesForRole(role).map(({ id, rule }) => ({ id, rule, readOnly: true })) : [] };
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
  return { ...meta, rules: page, cursor: next < entries.length ? Buffer.from(JSON.stringify({ scope: resolvedScope, revision, offset: next })).toString("base64url") : null };
}
