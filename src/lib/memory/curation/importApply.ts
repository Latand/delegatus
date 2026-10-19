import { adoptionReaches, assertImportCandidate, candidateState } from "../importCuration";
import { projectScope, newRuleId, RoleMemoryRefusal, rulePrivacyHints } from "../roleStore";
import { sameRule } from "../roleConsolidate";
import { canonicalProject } from "@/lib/projects/aliases";
import { scopeRole } from "../roleScopes";
import { problemInput } from "../roleProblems";
import type { ImportCandidate } from "../importTypes";
import type { RoleMemoryRule, RulePrivacyHint } from "../roleTypes";
import type { CuratorPass } from "./store";
import type { CurationApply } from "./apply";

export function prepareImportEdits(pass: CuratorPass, input: CurationApply, now: string, context: {
  work: Map<string, RoleMemoryRule>; created: Map<string, RoleMemoryRule>; placeholders: Record<string, string>;
  get: Parameters<typeof newRuleId>[0]["get"];
  target: (scope: string) => void;
  text: (rule: string, why: string) => { rule: string; why: string; hints: RulePrivacyHint[] };
  note: (value: unknown) => string;
  evidence: (where: string | undefined) => void;
}): ImportCandidate[] {
  const refuse = (message: string): never => { throw new RoleMemoryRefusal("CURATE_IMPORT", message); };
  if ((input.adopt?.length ?? 0) > 40 || (input.drop?.length ?? 0) > 40 || (input.defer?.length ?? 0) > 40) refuse("import operations exceed the batch bound");
  const rows = new Map<string, ImportCandidate>(), covered = new Map<string, Set<string>>();
  const candidate = (id: string, occurrences: string[], deferred = false, adopting = false) => {
    const row = rows.get(id) ?? assertImportCandidate(pass, id);
    if (!occurrences.length || new Set(occurrences).size !== occurrences.length) refuse("name distinct occurrences");
    const state = candidateState(row);
    if (!deferred && (adopting && state.ruleIds.length || occurrences.some(id => !state.pending.includes(id)))) refuse("candidate still has a surviving rule or a disposition; rewrite its rule by id");
    const seen = covered.get(id) ?? new Set<string>();
    for (const occurrence of occurrences) {
      if (!row.occurrences.some(item => item.id === occurrence) || seen.has(occurrence)) refuse("every occurrence needs exactly one disposition or defer");
      seen.add(occurrence);
    }
    covered.set(id, seen); rows.set(id, row); return row;
  };
  const source = (row: ImportCandidate, occurrences: string[], to: string) => ({
    origin: "import" as const, project: row.occurrences[0].project ?? pass.project, roleId: scopeRole(to), fixRound: false as const,
    candidate: row.id, occurrences: row.occurrences.filter(item => occurrences.includes(item.id)), engine: row.engine,
    sha256: row.contentSha256, importId: row.importId,
  });
  const create = (row: RoleMemoryRule) => { context.work.set(row.id, row); context.created.set(row.id, row); };
  const newId = () => newRuleId({ get: key => context.work.get(key.slice(2)) ?? context.get(key) });
  for (const item of input.adopt ?? []) {
    const row = candidate(item.candidate, item.occurrences, false, true); context.note(item.note);
    if (!item.parts.length || item.parts.length > 16) refuse("adopt needs 1–16 parts");
    const ids: string[] = [];
    for (const [index, part] of item.parts.entries()) {
      context.target(part.to);
      if (!adoptionReaches(row, part.to)) refuse("adoption is outside the candidate's project and shared scopes");
      const fields = context.text(part.rule, part.why), id = newId();
      const duplicate = [...context.work.values()].find(rule => rule.state === "active" && rule.scope === part.to && sameRule(rule.rule, fields.rule));
      create({ kind: "rule", id, scope: part.to, ...fields, source: source(row, item.occurrences, part.to), state: duplicate ? "merged" : "active", ...(duplicate ? { mergedInto: duplicate.id, mergedAt: now, reason: "duplicate" as const } : {}), createdAt: now, changedAt: now, curatedAt: now, note: item.note, versions: [] });
      ids.push(id); context.placeholders[`adopt:${row.id}:${index}`] = duplicate?.id ?? id;
    }
    row.dispositions.push({ at: now, pass: pass.id, kind: "adopt", ruleIds: ids, occurrences: item.occurrences, note: item.note });
  }
  for (const item of input.drop ?? []) {
    const row = candidate(item.candidate, item.occurrences); context.note(item.note);
    if (!["task-specific", "stale", "in-code", "in-instructions", "no-reader", "contradicted", "duplicate"].includes(item.reason)) refuse("drop needs an existing curator reason; defects use problem");
    if (item.forRoom && (item.reason !== "no-reader" || !row.occurrences.some(o => item.occurrences.includes(o.id) && o.writer.kind === "seat"))) refuse("the room trigger requires a seat candidate dropped only for room");
    if (item.reason === "in-code" || item.reason === "in-instructions" || item.where) {
      if (!row.occurrences.every(o => o.project && canonicalProject(o.project) === canonicalProject(pass.project))) refuse("repository evidence is unavailable for this candidate's project; judge it from its text");
      context.evidence(item.where);
    }
    row.dispositions.push({ at: now, pass: pass.id, kind: "drop", ruleIds: [], occurrences: item.occurrences, reason: item.reason, note: item.note, ...(item.forRoom ? { forRoom: true } : {}) });
  }
  for (const item of input.defer ?? []) {
    const row = candidate(item.candidate, item.occurrences, true);
    const prior = row.deferred?.find(receipt => receipt.pass === pass.id);
    const occurrences = new Set([...(prior?.occurrences ?? []), ...item.occurrences]);
    row.deferred = [...row.deferred?.filter(receipt => receipt.pass !== pass.id) ?? [], { pass: pass.id, occurrences: [...occurrences].sort() }];
  }
  for (const item of input.problem ?? []) if (pass.importBatch?.candidates.includes(item.id)) {
    const original = assertImportCandidate(pass, item.id);
    const row = candidate(item.id, candidateState(original).pending); context.note(item.note);
    const problem = problemInput(item), id = newId(), scope = projectScope(row.occurrences[0].project ?? pass.project);
    context.target(scope);
    create({ kind: "rule", id, scope, rule: problem.statement, why: "Imported concrete evidence for the project seat agenda.", hints: rulePrivacyHints(`${problem.statement}\n${problem.evidence}`), source: source(row, row.occurrences.map(o => o.id), scope), state: "archived", reason: "problem", problem, problemEpisode: `${pass.id}:${now}`, note: item.note, createdAt: now, changedAt: now, curatedAt: now });
    row.dispositions.push({ at: now, pass: pass.id, kind: "drop", reason: "problem", ruleIds: [id], occurrences: row.occurrences.map(o => o.id), note: item.note });
  }
  if (pass.importBatch) for (const id of pass.importBatch.candidates) {
    const row = rows.get(id) ?? assertImportCandidate(pass, id);
    const before = { ...row, dispositions: row.dispositions.filter(item => item.pass !== pass.id || item.at !== now) };
    if (candidateState(before).pending.some(occurrence => !covered.get(id)?.has(occurrence))) refuse("every candidate, part and occurrence in the batch needs a disposition or defer");
  }
  return [...rows.values()];
}
