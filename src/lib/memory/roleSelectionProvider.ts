import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { JEV_ENDPOINT, JEV_MODEL, JEV_INPUT_PRICE_USD, redactForClassifier } from "@/lib/asks/jev";
import { openRouterKeyPath } from "@/lib/asks/settings";

export interface ProviderAdmission {
  status: "admitted" | "http" | "shape" | "insufficient";
  httpStatus: number;
  limit: number | null;
  remaining: number | null;
  ceilingUsd: number;
}
export interface SelectionEvidence {
  provider: string;
  model: string;
  admission: ProviderAdmission | null;
  phase: string;
  latencyMs: number;
  timings: [string, number][];
  ceilingUsd: number;
  reservedUsd: number;
  /** Conservative charge retained by the local cap, including lost replies. */
  costUsd: number;
  /** Null when any dispatched request has an unknown bill. */
  billedUsd: number | null;
  scoreSource: "bm25" | "jev";
  allScores: [string, number][];
}
export function emptySelectionEvidence(phase: string, latencyMs = 0): SelectionEvidence {
  return { provider: "openrouter", model: JEV_MODEL, admission: null, phase, latencyMs, timings: [], ceilingUsd: 0, reservedUsd: 0, costUsd: 0, billedUsd: 0, scoreSource: "bm25", allScores: [] };
}
/** Optional on old rows; new writers always store the complete observation. */
export function isSelectionEvidence(value: unknown): value is SelectionEvidence {
  if (!value || typeof value !== "object") return false;
  const row = value as SelectionEvidence;
  const admission = row.admission;
  return typeof row.provider === "string" && typeof row.model === "string" && typeof row.phase === "string"
    && nonnegative(row.latencyMs) && nonnegative(row.ceilingUsd) && nonnegative(row.reservedUsd) && nonnegative(row.costUsd)
    && (row.billedUsd === null || nonnegative(row.billedUsd))
    && ["bm25", "jev"].includes(row.scoreSource)
    && Array.isArray(row.timings) && row.timings.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && nonnegative(pair[1]))
    && Array.isArray(row.allScores) && row.allScores.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && nonnegative(pair[1]))
    && (admission === null || typeof admission === "object" && ["admitted", "http", "shape", "insufficient"].includes(admission.status)
      && Number.isInteger(admission.httpStatus) && admission.httpStatus >= 100 && admission.httpStatus <= 599
      && (admission.limit === null || finite(admission.limit)) && (admission.remaining === null || finite(admission.remaining)) && nonnegative(admission.ceilingUsd));
}
export interface SelectionInput {
  role: string;
  brief: string;
  rules: readonly { id: string; rule: string }[];
}
export interface PreparedRoleSelection {
  ceilingUsd: number;
  admit(key: string, signal: AbortSignal): Promise<ProviderAdmission>;
  decide(key: string, signal: AbortSignal, authorize: () => Promise<void>, observe: (cost: number | null, ceiling: number) => void): Promise<number[]>;
}
/** Protocol, pricing and credentials belong to the adapter. The selector owns
 * the deadline, local cap, authority checks, packing and durable evidence. */
export interface RoleSelectionProvider {
  id: string;
  model: string;
  readKey(signal: AbortSignal): Promise<string | null>;
  prepare(input: SelectionInput): PreparedRoleSelection;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safe = (text: string) => redactForClassifier(text.replace(/^.*(?:api[_-]?key|token|password|secret|credential)\s*[:=].*$/gim, "<credential line>"));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;

export function openRouterRoleSelectionProvider(options: { apiKey?: string | null; fetch?: typeof fetch } = {}): RoleSelectionProvider {
  const request = options.fetch ?? fetch;
  return {
    id: "openrouter", model: JEV_MODEL,
    async readKey(signal) {
      if (options.apiKey !== undefined) return options.apiKey;
      return process.env.OPENROUTER_API_KEY?.trim() || await fs.readFile(openRouterKeyPath(), { encoding: "utf8", signal }).then(text => text.trim() || null, () => null);
    },
    prepare(input) {
      const state = { task: "An agent is about to start work. Decide whether each proposed rule should be given at the start.", role: input.role, project: "A", brief: safe(input.brief), rubric: "Give a rule when its trigger fits this work and its check can change an action. For receipt recovery, an ownership check applies. For a translation, checking every locale applies. A browser layout check does not apply to a database migration." };
      const batches = [];
      for (let i = 0; i < input.rules.length; i += 32) {
        const body = { model: JEV_MODEL, state, questions: Object.fromEntries(input.rules.slice(i, i + 32).map(rule => [createHash("sha256").update(rule.id).digest("hex").slice(0, 24), { type: "noul", instructions: `The proposed learned rule should be given to the agent at the start of this work: ${safe(rule.rule)}` }])) };
        batches.push({ body, ceiling: (462 + Buffer.byteLength(JSON.stringify(body))) * JEV_INPUT_PRICE_USD });
      }
      const ceilingUsd = batches.reduce((sum, batch) => sum + batch.ceiling, 0);
      return {
        ceilingUsd,
        async admit(key, signal) {
          const response = await request("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal, redirect: "error" });
          signal.throwIfAborted();
          const details: ProviderAdmission = { status: "http", httpStatus: response.status, limit: null, remaining: null, ceilingUsd };
          if (!response.ok) return details;
          let data: Record<string, unknown>;
          try { data = record(record(await response.json()).data); }
          catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof SyntaxError)) throw error;
            return { ...details, status: "shape" };
          }
          signal.throwIfAborted();
          details.limit = finite(data.limit) ? data.limit : null;
          details.remaining = finite(data.limit_remaining) ? data.limit_remaining : null;
          // An unlimited key has no per-key cap. A finite cap requires an
          // observed remaining balance; missing or malformed values fail closed.
          details.status = data.limit === null && data.limit_remaining === null ? "admitted"
            : nonnegative(data.limit) && finite(data.limit_remaining) ? (data.limit_remaining >= ceilingUsd ? "admitted" : "insufficient") : "shape";
          return details;
        },
        async decide(key, signal, authorize, observe) {
          const replies = await Promise.all(batches.map(async batch => {
            await authorize();
            signal.throwIfAborted();
            const response = await request(JEV_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(batch.body), signal, redirect: "error" });
            signal.throwIfAborted();
            if (!response.ok) { observe(0, batch.ceiling); return { reason: "http", scores: null }; }
            const body = record(await response.json());
            signal.throwIfAborted();
            const cost = record(body.usage).cost;
            observe(nonnegative(cost) ? cost : null, batch.ceiling);
            const answers = record(body.answers);
            const values = Object.keys(batch.body.questions).map(id => record(answers[id]).noul);
            return !nonnegative(cost) || values.some(score => !nonnegative(score) || score > 1)
              ? { reason: "shape", scores: null } : { reason: "jev", scores: values as number[] };
          }));
          const failed = replies.find(reply => !reply.scores);
          if (failed) throw new RoleSelectionProviderError(failed.reason);
          return replies.flatMap(reply => reply.scores!);
        },
      };
    },
  };
}
export class RoleSelectionProviderError extends Error {}
