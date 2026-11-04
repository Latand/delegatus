/** Assemble the #3406 cohort from read-only snapshots and exact delivery hashes.
 * Output is a private source snapshot; the checked-in replay bundle is scrubbed. */
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Pipeline } from "../src/lib/pipelines/types";
import type { RoleMemoryRow } from "../src/lib/memory/roleTypes";
import type { MemoryDelivery } from "../src/lib/memory/deliveryLedger";
import type { EvalCase } from "./role-selection-eval";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
type Attempt = { pipelineId: string; stageId: string; attempt: number };
const key = (attempt?: Attempt) => JSON.stringify([attempt?.pipelineId, attempt?.stageId, attempt?.attempt]);

export function assembleInputs(stateFile: string, ledgerFile: string, root: string) {
  const source = new Database(stateFile, { readonly: true });
  const read = <T>(collection: string): T[] => source.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection=? ORDER BY row_key").all(collection).map(row => JSON.parse(row.value_json));
  let memory: RoleMemoryRow[], pipelines: Pipeline[];
  try {
    memory = read<RoleMemoryRow>("role_memory");
    pipelines = [...new Map([...read<Pipeline>("pipelines_archive"), ...read<Pipeline>("pipelines")].map(pipeline => [pipeline.id, pipeline])).values()];
  } finally { source.close(); }
  const ledger = new Database(ledgerFile, { readonly: true });
  let deliveries: MemoryDelivery[];
  try { deliveries = ledger.query<{ body: string }, []>("SELECT body FROM deliveries ORDER BY sequence").all().map(row => JSON.parse(row.body)); }
  finally { ledger.close(); }
  const rules = memory.filter(row => row.kind === "rule"), requests = memory.filter(row => row.kind === "request");
  const textByIdentity = new Map<string, typeof rules[number]>();
  for (const rule of rules) {
    textByIdentity.set(JSON.stringify([rule.id, hash(rule.rule)]), rule);
    if (rule.versionOf) textByIdentity.set(JSON.stringify([rule.versionOf, hash(rule.rule)]), rule);
  }
  const cases: EvalCase[] = [];
  let dropped = 0;
  function assemble(delivery: MemoryDelivery, cohort: EvalCase["cohort"]) {
    const pipeline = pipelines.find(pipeline => pipeline.id === delivery.attempt?.pipelineId);
    const stage = pipeline?.stages.find(stage => stage.id === delivery.attempt?.stageId);
    const request = requests.find(request => key(request) === key(delivery.attempt));
    if (!pipeline || !stage || !request) return;
    const texts = delivery.rules.map(rule => textByIdentity.get(JSON.stringify([rule.id, rule.hash])));
    if (texts.some(rule => !rule)) { dropped++; return; }
    const mapped = delivery.rules.map((rule, index) => ({ ...texts[index]!, id: "r_" + hash(rule.id).slice(0, 16),
      keptByOperatorAt: texts[index]!.keptByOperatorAt && texts[index]!.keptByOperatorAt! <= delivery.at ? texts[index]!.keptByOperatorAt : undefined,
      scope: texts[index]!.scope === "machine" ? "machine" : texts[index]!.scope.startsWith("project:") ? "project:eval"
        : texts[index]!.scope.startsWith("role:*:") ? "role:*:" + (request.roleId ?? "builder") : "role:eval:" + (request.roleId ?? "builder") }));
    const scopes = [...new Set(mapped.map(rule => rule.scope))].map(scope => ({ scope, rules: mapped.filter(rule => rule.scope === scope) }));
    const labels = (ids: string[] = []) => ids.filter(id => delivery.rules.some(rule => rule.id === id)).map(id => "r_" + hash(id).slice(0, 16));
    const applied = labels(request.applied), misled = labels(request.misled);
    if (!applied.length && !misled.length) return;
    const id = hash(key(delivery.attempt)).slice(0, 16);
    if (cases.some(input => input.id === id)) return;
    cases.push({ id, cohort, role: request.roleId ?? "builder",
      brief: [pipeline.task?.slice(0, 2000), pipeline.spec?.slice(0, 8000), stage.prompt?.slice(0, 3000)].filter(Boolean).join("\n"), scopes, applied, misled });
  }
  // Actual ledger hashes replace inferred four-scope order across successions.
  for (const pipeline of [...pipelines].sort((a, b) => hash(a.id).localeCompare(hash(b.id)))) {
    if (cases.filter(input => input.cohort === "replay").length >= 10) break;
    const attempts = pipeline.runs.flatMap(run => run.attempts.map(attempt => ({ ...attempt, stageId: run.stageId })));
    const first = attempts.filter(attempt => attempt.effectiveRole?.roleId === "builder" && !attempt.activatedBy)
      .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""))[0];
    if (!first) continue;
    const review = attempts.filter(attempt => attempt.effectiveRole?.roleId === "reviewer" && attempt.verdict && Date.parse(attempt.startedAt ?? "") >= Date.parse(first.completedAt ?? ""))
      .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""))[0];
    if (review?.verdict?.status !== "fail") continue;
    const delivery = deliveries.find(delivery => key(delivery.attempt) === key({ pipelineId: pipeline.id, stageId: first.stageId, attempt: first.n }));
    if (delivery) assemble(delivery, "replay");
  }
  const recent = [...deliveries].reverse();
  for (const delivery of recent) {
    const request = requests.find(request => key(request) === key(delivery.attempt));
    if (request?.misled?.length) assemble(delivery, "recent");
  }
  for (const delivery of recent) { if (cases.filter(input => input.cohort === "recent").length >= 14) break; assemble(delivery, "recent"); }
  fs.writeFileSync(root + "/corpus.json", JSON.stringify(cases), { mode: 0o600 });
  const manifest = { version: 1, digest: hash(JSON.stringify(cases)), sourceDigest: hash(fs.readFileSync(stateFile)), deliveryDigest: hash(fs.readFileSync(ledgerFile)),
    source: "#3406 failed-first-builder protocol joined to exact delivery hashes; recent applied/misled reports",
    cases: cases.map(input => ({ id: input.id, cohort: input.cohort, role: input.role, briefDigest: hash(input.brief), rules: input.scopes.reduce((sum, scope) => sum + scope.rules.length, 0), applied: input.applied, misled: input.misled })), dropped };
  fs.writeFileSync(root + "/inputs.json", JSON.stringify(manifest, null, 2) + "\n");
  return { cases: cases.length, applied: cases.reduce((sum, input) => sum + input.applied.length, 0), misled: cases.reduce((sum, input) => sum + input.misled.length, 0), dropped };
}
if (import.meta.main) {
  const [stateFile, ledgerFile, root] = process.argv.slice(2);
  if (!root) throw Error("usage: role-selection-inputs STATE_SNAPSHOT DELIVERY_SNAPSHOT OUTPUT_DIRECTORY");
  console.log(JSON.stringify(assembleInputs(stateFile, ledgerFile, root)));
}
