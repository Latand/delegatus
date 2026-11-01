import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { yieldToRuntime } from "@/lib/cooperative";
import { roleMemoryEnabled } from "./settings";
import { ruleLine } from "./roleConsolidate";
import { renderLearnedRulesSelection } from "./roleRender";
import type { RoleMemoryRule } from "./roleTypes";
import { reserveSelectionSpend, settleSelectionSpend } from "./roleSelectionSpend";
import { emptySelectionEvidence, openRouterRoleSelectionProvider, RoleSelectionProviderError, type RoleSelectionProvider, type SelectionEvidence } from "./roleSelectionProvider";

export const MEMORY_SELECTION_DEADLINE_MS = 3_000;
export const SHADOW_BLOCK_MAX_BYTES = 24_000;
const BM25_SCORE_BATCH_SIZE = 16;
type Scopes = readonly { scope: string; rules: readonly RoleMemoryRule[] }[];
export interface ShadowSelection { selector: "whole" | "bm25" | "jev"; selectorVersion: string; reason: string; scores: [string, number][]; shadowIds: string[]; evidence?: SelectionEvidence }
type Options = { apiKey?: string | null; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: () => Date; provider?: RoleSelectionProvider };
const stop = new Set("the and for with from this that before after when then into every only its any are not all one each has was have than your you of to in on at by is it as an a or be do".split(" "));
const terms = (text: string) => (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => !stop.has(term));
const points = (text: string) => [...text].length;
const failure = (reason: string): ShadowSelection => ({ selector: "whole", selectorVersion: "1", reason, scores: [], shadowIds: [] });
function alwaysOn(rules: readonly RoleMemoryRule[]): Set<string> {
  let reserved = 0;
  return new Set(rules.filter(rule => {
    const length = points(ruleLine(rule)) + (reserved ? 1 : 0);
    if (!rule.keptByOperatorAt || reserved + length > 3_000) return false;
    reserved += length;
    return true;
  }).map(rule => rule.id));
}

async function bm25(rules: readonly RoleMemoryRule[], brief: string, signal: AbortSignal): Promise<number[]> {
  const query = new Set(terms(brief));
  const documents: Map<string, number>[] = [], lengths: number[] = [];
  const frequencies = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    if (i % 16 === 0) { await yieldToRuntime(); signal.throwIfAborted(); }
    const counts = new Map<string, number>();
    const words = terms(rules[i].rule);
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of query) if (counts.has(word)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    documents.push(counts); lengths.push(words.length);
  }
  const mean = lengths.reduce((a, b) => a + b, 0) / (rules.length || 1) || 1;
  const words = [...query];
  const scores: number[] = [];
  for (let start = 0; start < documents.length; start += BM25_SCORE_BATCH_SIZE) {
    signal.throwIfAborted();
    const end = Math.min(start + BM25_SCORE_BATCH_SIZE, documents.length);
    for (let i = start; i < end; i++) {
      const doc = documents[i];
      let score = 0;
      for (const word of words) {
        const tf = doc.get(word) ?? 0, df = frequencies.get(word) ?? 0;
        score += Math.log(1 + (rules.length - df + 0.5) / (df + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * lengths[i] / mean));
      }
      scores.push(score);
    }
    if (end < documents.length) { await yieldToRuntime(); signal.throwIfAborted(); }
  }
  return scores;
}

async function pack(scopes: Scopes, rules: RoleMemoryRule[], scores: number[], threshold: number, signal: AbortSignal): Promise<Pick<ShadowSelection, "scores" | "shadowIds">> {
  // Layers arrive in slice 3; operator-kept rules already exist today.
  const protectedIds = alwaysOn(rules);
  const selected = new Set(protectedIds);
  let chars = 0;
  const order = rules.map((rule, rank) => ({ rule, rank, score: scores[rank] })).sort((a, b) => b.score - a.score || a.rank - b.rank || a.rule.id.localeCompare(b.rule.id));
  for (let i = 0; i < order.length; i++) {
    if (i % 16 === 0) { await yieldToRuntime(); signal.throwIfAborted(); }
    const { rule, score } = order[i];
    if (selected.has(rule.id) || score < threshold) continue;
    const length = points(ruleLine(rule)) + (chars ? 1 : 0);
    if (chars + length > 9_000) continue;
    selected.add(rule.id);
    const rendered = renderLearnedRulesSelection(scopes.map(scope => ({ scope: scope.scope, rules: scope.rules.filter(rule => selected.has(rule.id)) })));
    if (Buffer.byteLength(rendered.block) > SHADOW_BLOCK_MAX_BYTES) { selected.delete(rule.id); continue; }
    chars += length;
  }
  return { shadowIds: rules.filter(rule => selected.has(rule.id)).map(rule => rule.id), scores: rules.flatMap((rule, i) => selected.has(rule.id) && !protectedIds.has(rule.id) ? [[rule.id, Math.round(scores[i] * 1000) / 1000] as [string, number]] : []) };
}

/** The adapter's real requests run against an injected fetch in tests. */
export async function selectRoleMemory(scopes: Scopes, brief: string, options: Options = {}): Promise<ShadowSelection> {
  return withViewerOperation("memory.select", async () => {
    const provider = options.provider ?? openRouterRoleSelectionProvider(options);
    const start = performance.now();
    let phaseStart = start;
    const evidence: SelectionEvidence = { ...emptySelectionEvidence("bm25"), provider: provider.id, model: provider.model };
    const phase = (next: string) => {
      const now = performance.now();
      evidence.timings.push([evidence.phase, Math.max(0, now - phaseStart)]);
      evidence.phase = next; phaseStart = now;
    };
    const controller = new AbortController();
    const budgetMs = Math.max(0, options.timeoutMs ?? MEMORY_SELECTION_DEADLINE_MS);
    const deadline = start + budgetMs;
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let abort!: () => void;
    const expired = new Promise<never>((_, reject) => { abort = () => reject(Error("timeout")); signal.addEventListener("abort", abort, { once: true }); });
    void expired.catch(() => {});
    const checkDeadline = () => {
      if (performance.now() >= deadline) controller.abort();
      signal.throwIfAborted();
    };
    // Start external work only after checking the monotonic deadline. A timer
    // callback can run late when the event loop is busy.
    const bounded = async <T>(work: () => Promise<T>, observe?: (value: T) => void): Promise<T> => { checkDeadline(); const result = await Promise.race([work(), expired]); observe?.(result); checkDeadline(); return result; };
    const evaluate = async (): Promise<ShadowSelection> => {
      try {
        if (process.env.LLV_ROLE_MEMORY_SHADOW === "off") return failure("whole");
        if (!brief.trim()) return failure("no-brief");
        checkDeadline();
        const rules = scopes.flatMap(scope => [...scope.rules]);
        const protectedIds = alwaysOn(rules);
        const candidates = rules.filter(rule => !protectedIds.has(rule.id));
        const candidateScores = await bm25(candidates, brief, signal);
        const byId = new Map(candidates.map((rule, i) => [rule.id, candidateScores[i]]));
        const scores = rules.map(rule => byId.get(rule.id) ?? 0);
        evidence.allScores = candidates.map((rule, i) => [rule.id, candidateScores[i]]);
        phase("pack-bm25");
        const fallback = await pack(scopes, rules, scores, -Infinity, signal);
        const suffix = scores.some(score => score > 0) ? "bm25" : "bm25-no-match";
        const result = (reason: string): ShadowSelection => ({ selector: "bm25", selectorVersion: "bm25-1", reason: `${reason},${suffix}`, ...fallback });
        if (points(candidates.map(ruleLine).join("\n")) > 120_000) return result("jev-pool");
        if (!candidates.length) return result("jev-empty");
        let reservation: Awaited<ReturnType<typeof reserveSelectionSpend>> = null;
        try {
          phase("key");
          const key = await bounded(() => provider.readKey(signal));
          if (!key) return result("jev-no-key");
          phase("prepare");
          const plan = provider.prepare({ role: scopes.find(scope => scope.scope.startsWith("role:"))?.scope.split(":").at(-1) ?? "agent", brief, rules: candidates });
          if (!Number.isFinite(plan.ceilingUsd) || plan.ceilingUsd <= 0) throw new RoleSelectionProviderError("shape");
          evidence.ceilingUsd = plan.ceilingUsd;
          phase("admission");
          const admission = await bounded(() => plan.admit(key, signal), value => { evidence.admission = value; });
          if (admission.status !== "admitted") return result("jev-provider-limit");
          phase("reserve");
          reservation = await bounded(() => reserveSelectionSpend(plan.ceilingUsd, signal, options.now?.()), held => {
            if (held) evidence.reservedUsd = evidence.costUsd = held.ceiling;
          });
          if (!reservation) return result("jev-cap");
          phase("authority");
          const authorize = async () => {
            if (await bounded(() => provider.readKey(signal)) !== key || !roleMemoryEnabled()) throw new RoleSelectionProviderError("authority-changed");
            signal.throwIfAborted();
          };
          try { await authorize(); }
          catch (error) {
            await bounded(() => settleSelectionSpend(reservation!, 0, signal), () => { evidence.costUsd = 0; });
            throw error;
          }
          phase("decisions");
          let accounted = 0, billed = 0, unknown = false;
          evidence.billedUsd = null;
          let probabilities: number[];
          try {
            probabilities = await bounded(() => plan.decide(key, signal, authorize, (cost, ceiling) => {
              signal.throwIfAborted();
              accounted += ceiling;
              billed += cost ?? ceiling;
              unknown ||= cost === null;
              if (!unknown && Math.abs(accounted - reservation!.ceiling) < 1e-12) evidence.billedUsd = billed;
            }));
          } finally {
            // Replies that were never observed keep their reserved ceiling.
            // Late callbacks cannot refund a timed-out or cancelled request.
            if (!signal.aborted) {
              phase("settle");
              const charge = Math.max(0, reservation.ceiling - accounted) + billed;
              await bounded(() => settleSelectionSpend(reservation!, charge, signal), () => { evidence.costUsd = charge; });
              if (!unknown && Math.abs(accounted - reservation.ceiling) < 1e-12) evidence.billedUsd = billed;
            }
          }
          if (probabilities.length !== candidates.length || probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new RoleSelectionProviderError("shape");
          evidence.allScores = candidates.map((rule, i) => [rule.id, probabilities[i]]);
          evidence.scoreSource = "jev";
          const jevScores = new Map(evidence.allScores);
          phase("pack-jev");
          return { selector: "jev", selectorVersion: `${provider.model}-1`, reason: "jev", ...await pack(scopes, rules, rules.map(rule => jevScores.get(rule.id) ?? 0), 0.3, signal) };
        } catch (error) {
          return result(signal.aborted ? "jev-timeout" : error instanceof RoleSelectionProviderError ? `jev-${error.message}` : error instanceof SyntaxError ? "jev-shape" : "jev-network");
        }
      } catch { return failure(signal.aborted ? "selector-timeout" : "selector-error"); }
    };
    try {
      const result = await evaluate();
      const finished = performance.now();
      evidence.latencyMs = Math.max(0, finished - start);
      evidence.timings.push([evidence.phase, Math.max(0, finished - phaseStart)]);
      return { ...result, evidence };
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
  });
}
