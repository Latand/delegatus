/** Offline replay of fixed inputs. Never imports a live store. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { openAiRoleSelectionProvider, openRouterRoleSelectionProvider, type RoleSelectionProvider } from "../src/lib/memory/roleSelectionProvider";
import { alwaysOn, packRoleSelection, selectRoleMemory, ROLE_SELECTION_THRESHOLD, type SelectionScopes } from "../src/lib/memory/roleSelect";
import { renderLearnedRulesSelection } from "../src/lib/memory/roleRender";
import type { SelectionPromptVersion } from "../src/lib/memory/roleSelectionPrompt";

export const EVAL_CAP_USD = 5;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface EvalCase {
  id: string; cohort: "replay" | "recent"; role: string; brief: string;
  scopes: SelectionScopes; applied: string[]; misled: string[];
  /** Captured baseline decisions and timing keep privacy-safe replays stable. */
  baselineIds?: string[]; baselineReason?: string; baselineLatencyMs?: number; wholeLatencyMs?: number;
}
type Receipt = { key: string; ceiling: number; cost: number | null; complete: boolean; scores?: number[]; latencyMs?: number; reason?: string; observedUsd?: number; usageVersion?: 2 };

/** A dispatched cell is reserved durably before its first POST. An incomplete
 * cell keeps its full reservation and cannot be dispatched again on restart. */
export class EvalBudget {
  constructor(readonly file: string) {}
  read(): Receipt[] { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : []; }
  private write(rows: Receipt[]) {
    const file = this.file + ".next";
    const fd = fs.openSync(file, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(rows)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(file, this.file);
  }
  reserve(key: string, ceiling: number): boolean {
    const rows = this.read();
    if (rows.some(row => row.key === key)) return false;
    if (rows.some(row => !row.complete) || !Number.isFinite(ceiling) || ceiling <= 0
      || rows.reduce((sum, row) => sum + (row.cost ?? row.ceiling), 0) + ceiling > EVAL_CAP_USD) return false;
    this.write([...rows, { key, ceiling, cost: null, complete: false }]);
    return true;
  }
  finish(receipt: Receipt) {
    const rows = this.read();
    const index = rows.findIndex(row => row.key === receipt.key && !row.complete);
    if (index < 0) throw Error("no pending eval reservation");
    rows[index] = receipt;
    this.write(rows);
  }
  observe(key: string, cost: number) {
    const rows = this.read();
    const row = rows.find(row => row.key === key && !row.complete);
    if (!row) throw Error("no pending eval dispatch");
    row.observedUsd = (row.observedUsd ?? 0) + cost;
    this.write(rows);
  }
}

export function measure(input: EvalCase, ids: string[]) {
  const rendered = renderLearnedRulesSelection(input.scopes.map(scope => ({ ...scope, rules: scope.rules.filter(rule => ids.includes(rule.id)) })), 24_000, {}, alwaysOn(input.scopes.flatMap(scope => [...scope.rules])));
  const delivered = new Set(rendered.rules.map(rule => rule.id));
  return { applied: input.applied.length, recalled: input.applied.filter(id => delivered.has(id)).length,
    misled: input.misled.length, misledDelivered: input.misled.filter(id => delivered.has(id)).length,
    delivered: delivered.size, bytes: Buffer.byteLength(rendered.block) };
}

export async function evaluate(cases: EvalCase[], budget: EvalBudget, providers: { id: string; key: string; make(version: SelectionPromptVersion): RoleSelectionProvider }[], replay = false) {
  const results = [];
  for (const input of cases) {
    const signal = AbortSignal.timeout(120_000);
    const rules = input.scopes.flatMap(scope => [...scope.rules]);
    const protectedIds = alwaysOn(rules);
    const candidates = rules.filter(rule => !protectedIds.has(rule.id));
    const wholeStart = performance.now();
    const whole = measure(input, rules.map(rule => rule.id));
    results.push({ case: input.id, arm: "whole", ...whole, latencyMs: input.wholeLatencyMs ?? performance.now() - wholeStart, cost: 0, reason: "whole" });
    const bm = input.baselineIds
      ? { selector: "bm25", shadowIds: input.baselineIds, reason: input.baselineReason ?? "captured-bm25", evidence: { latencyMs: input.baselineLatencyMs ?? 0 } }
      : await selectRoleMemory(input.scopes, input.brief, { apiKey: null, timeoutMs: 30_000 });
    if (bm.selector !== "bm25") throw Error("BM25 baseline failed");
    results.push({ case: input.id, arm: "bm25", ...measure(input, bm.shadowIds), latencyMs: input.baselineLatencyMs ?? bm.evidence!.latencyMs, cost: 0, reason: bm.reason });
    for (const provider of providers) for (const version of ["v1", "v2"] as const) {
      const plan = provider.make(version).prepare({ role: input.role, brief: input.brief, rules: candidates });
      const key = digest([digest(cases), input.id, provider.id, version, plan.requestDigest]);
      let receipt = budget.read().find(row => row.key === key);
      if (!receipt) {
        if (replay) throw Error("missing frozen response in offline replay");
        if (!budget.reserve(key, plan.ceilingUsd)) throw Error("eval cap or unresolved dispatch: stopped before next call");
        const started = performance.now();
        let billed = 0, observedUsd = 0, accounted = 0, unknown = false;
        let scores: number[] | undefined, reason = "decisions";
        try {
          scores = await plan.decide(provider.key, signal, async () => { signal.throwIfAborted(); }, (cost, ceiling) => {
            accounted += ceiling; billed += cost ?? ceiling; unknown ||= cost === null;
            if (cost !== null) { observedUsd += cost; budget.observe(key, cost); }
          });
        } catch { reason = "provider-failure"; }
        receipt = { key, ceiling: plan.ceilingUsd, cost: unknown || Math.abs(accounted - plan.ceilingUsd) > 1e-10 ? null : billed,
          complete: true, scores, latencyMs: performance.now() - started, reason, observedUsd, usageVersion: 2 };
        budget.finish(receipt);
      }
      if (!receipt.complete) throw Error("unresolved eval dispatch: no further calls permitted");
      const scores = new Map(candidates.map((rule, index) => [rule.id, receipt.scores?.[index] ?? 0]));
      const selected = receipt.scores ? await packRoleSelection(input.scopes, rules, rules.map(rule => scores.get(rule.id) ?? 0), ROLE_SELECTION_THRESHOLD, signal) : bm;
      results.push({ case: input.id, arm: `${provider.id}-${version}`, ...measure(input, selected.shadowIds),
        latencyMs: receipt.latencyMs!, cost: receipt.cost, usageConfirmedUsd: receipt.cost ?? (receipt.usageVersion === 2 ? receipt.observedUsd ?? 0 : 0),
        retainedUsd: receipt.cost ?? receipt.ceiling, reason: receipt.reason! });
    }
  }
  return results;
}

if (import.meta.main) {
  const [corpusFile, manifestFile, ledgerFile, outputFile, mode] = process.argv.slice(2);
  if (!outputFile) throw Error("usage: role-selection-eval CORPUS MANIFEST LEDGER OUTPUT");
  const cases: EvalCase[] = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.digest !== digest(cases)) throw Error("fixed input digest mismatch");
  const lock = fs.openSync(ledgerFile + ".lock", "wx", 0o600);
  try {
    // Credentials are passed by the invoking process; no balance or admin API.
    const providers = [
      { id: "openai", key: process.env.OPENAI_API_KEY, make: openAiRoleSelectionProvider },
      { id: "openrouter", key: process.env.OPENROUTER_API_KEY, make: openRouterRoleSelectionProvider },
    ].filter(row => row.key || mode === "--replay").map(row => ({ ...row, key: row.key ?? "offline", make: (promptVersion: SelectionPromptVersion) => row.make({ promptVersion }) }));
    const results = await evaluate(cases, new EvalBudget(ledgerFile), providers, mode === "--replay");
    const receipts = new EvalBudget(ledgerFile).read();
    const spend = { usageConfirmedUsd: receipts.reduce((sum, row) => sum + (row.cost ?? (row.usageVersion === 2 ? row.observedUsd ?? 0 : 0)), 0),
      retainedUsd: receipts.reduce((sum, row) => sum + (row.cost ?? row.ceiling), 0), unpricedCells: receipts.filter(row => row.cost === null).length };
    fs.writeFileSync(outputFile, JSON.stringify({ digest: manifest.digest, threshold: ROLE_SELECTION_THRESHOLD, results, spend }, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ cases: cases.length, providers: providers.map(row => row.id), results: results.length }));
  } finally { fs.closeSync(lock); fs.unlinkSync(ledgerFile + ".lock"); }
}
