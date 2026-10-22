import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { yieldToRuntime } from "@/lib/cooperative";
import { JEV_ENDPOINT, JEV_MODEL, JEV_INPUT_PRICE_USD, redactForClassifier } from "@/lib/asks/jev";
import { openRouterKeyPath } from "@/lib/asks/settings";
import { roleMemoryEnabled } from "./settings";
import { ruleLine } from "./roleConsolidate";
import { renderLearnedRulesSelection } from "./roleRender";
import type { RoleMemoryRule } from "./roleTypes";
import { reserveSelectionSpend, settleSelectionSpend } from "./roleSelectionSpend";

export const MEMORY_SELECTION_DEADLINE_MS = 3_000;
export const SHADOW_BLOCK_MAX_BYTES = 24_000;
const BM25_SCORE_BATCH_SIZE = 16;
type Scopes = readonly { scope: string; rules: readonly RoleMemoryRule[] }[];
export interface ShadowSelection { selector: "whole" | "bm25" | "jev"; selectorVersion: string; reason: string; scores: [string, number][]; shadowIds: string[] }
type Options = { apiKey?: string | null; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: () => Date };
const stop = new Set("the and for with from this that before after when then into every only its any are not all one each has was have than your you of to in on at by is it as an a or be do".split(" "));
const terms = (text: string) => (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => !stop.has(term));
const points = (text: string) => [...text].length;
const safe = (text: string) => redactForClassifier(text.replace(/^.*(?:api[_-]?key|token|password|secret|credential)\s*[:=].*$/gim, "<credential line>"));
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

/** The injected fetch and abort signal exercise the real request, parser,
 * reservations and deadline without a paid provider call. */
export async function selectRoleMemory(scopes: Scopes, brief: string, options: Options = {}): Promise<ShadowSelection> {
  return withViewerOperation("memory.select", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MEMORY_SELECTION_DEADLINE_MS);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    // Race every external await, including a stalled body or an uncooperative
    // adapter. The request still receives cancellation and late results cannot write.
    let abort!: () => void;
    const expired = new Promise<never>((_, reject) => { abort = () => reject(Error("timeout")); signal.addEventListener("abort", abort, { once: true }); });
    void expired.catch(() => {});
    const bounded = async <T>(work: Promise<T>): Promise<T> => { signal.throwIfAborted(); const result = await Promise.race([work, expired]); signal.throwIfAborted(); return result; };
    try {
      if (process.env.LLV_ROLE_MEMORY_SHADOW === "off") return failure("whole");
      const rules = scopes.flatMap(scope => [...scope.rules]);
      const protectedIds = alwaysOn(rules);
      const candidates = rules.filter(rule => !protectedIds.has(rule.id));
      const candidateScores = await bm25(candidates, brief, signal);
      const byId = new Map(candidates.map((rule, i) => [rule.id, candidateScores[i]]));
      const scores = rules.map(rule => byId.get(rule.id) ?? 0);
      const fallback = await pack(scopes, rules, scores, -Infinity, signal);
      const suffix = scores.some(score => score > 0) ? "bm25" : "bm25-no-match";
      const result = (reason: string): ShadowSelection => ({ selector: "bm25", selectorVersion: "bm25-1", reason: `${reason},${suffix}`, ...fallback });
      if (!brief.trim()) return failure("no-brief");
      if (points(candidates.map(ruleLine).join("\n")) > 120_000) return result("jev-pool");
      let reservation: Awaited<ReturnType<typeof reserveSelectionSpend>> = null;
      try {
        const readKey = async () => {
          if (options.apiKey !== undefined) return options.apiKey;
          const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
          return fromEnv || await bounded(fs.readFile(openRouterKeyPath(), { encoding: "utf8", signal }).then(text => text.trim(), () => ""));
        };
        const key = await readKey();
        if (!key) return result("jev-no-key");
        const request = options.fetch ?? fetch;
        const state = { task: "An agent is about to start work. Decide whether each proposed rule should be given at the start.", role: scopes.find(scope => scope.scope.startsWith("role:"))?.scope.split(":").at(-1) ?? "agent", project: "A", brief: safe(brief), rubric: "Give a rule when its trigger fits this work and its check can change an action. For receipt recovery, an ownership check applies. For a translation, checking every locale applies. A browser layout check does not apply to a database migration." };
        const batches: { model: string; state: typeof state; questions: Record<string, { type: string; instructions: string }> }[] = [];
        const ids = candidates.map(rule => createHash("sha256").update(rule.id).digest("hex").slice(0, 24));
        for (let i = 0; i < candidates.length; i += 32) batches.push({ model: JEV_MODEL, state, questions: Object.fromEntries(candidates.slice(i, i + 32).map((rule, j) => [ids[i + j], { type: "noul", instructions: `The proposed learned rule should be given to the agent at the start of this work: ${safe(rule.rule)}` }])) });
        if (!batches.length) return result("jev-empty");
        const ceilings = batches.map(batch => (462 + Buffer.byteLength(JSON.stringify(batch))) * JEV_INPUT_PRICE_USD);
        const ceiling = ceilings.reduce((sum, cost) => sum + cost, 0);
        signal.throwIfAborted();
        const limit = await bounded(request("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal, redirect: "error" }));
        if (!limit.ok) return result("jev-provider-limit");
        const limits = record(record(await bounded(limit.json())).data);
        const remaining = limits.limit_remaining;
        if (!(limits.limit === null && remaining === null) && !(typeof remaining === "number" && Number.isFinite(remaining) && remaining >= ceiling)) return result("jev-provider-limit");
        reservation = await bounded(reserveSelectionSpend(ceiling, signal, options.now?.()));
        if (!reservation) return result("jev-cap");
        if (await readKey() !== key || !roleMemoryEnabled()) {
          await bounded(settleSelectionSpend(reservation, 0, signal));
          return result("jev-authority-changed");
        }
        signal.throwIfAborted();
        const replies = await bounded(Promise.all(batches.map(async (batch, index) => {
          const currentKey = await readKey();
          signal.throwIfAborted();
          if (currentKey !== key || !roleMemoryEnabled()) throw Error("selection authority changed");
          const response = await bounded(request(JEV_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(batch), signal, redirect: "error" }));
          if (!response.ok) return { reason: "http", cost: 0, scores: null };
          const body = record(await bounded(response.json()));
          const cost = record(body.usage).cost;
          const validCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
          const answers = record(body.answers);
          const values = Object.keys(batch.questions).map(id => record(answers[id]).noul);
          if (!validCost || values.some(score => typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)) return { reason: "shape", cost: validCost ? cost : ceilings[index], scores: null };
          return { reason: "jev", cost, scores: values as number[] };
        })));
        await bounded(settleSelectionSpend(reservation, replies.reduce((sum, reply) => sum + reply.cost, 0), signal));
        if (replies.some(reply => !reply.scores)) return result(`jev-${replies.find(reply => !reply.scores)!.reason}`);
        const probabilities = replies.flatMap(reply => reply.scores!);
        const jevScores = new Map(candidates.map((rule, i) => [rule.id, probabilities[i]]));
        return { selector: "jev", selectorVersion: `${JEV_MODEL}-1`, reason: "jev", ...await pack(scopes, rules, rules.map(rule => jevScores.get(rule.id) ?? 0), 0.3, signal) };
      } catch (error) {
        return result(signal.aborted ? "jev-timeout" : error instanceof SyntaxError ? "jev-shape" : "jev-network");
      }
    } catch { return failure(signal.aborted ? "selector-timeout" : "selector-error"); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
  });
}
