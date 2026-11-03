import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { JEV_ENDPOINT, JEV_MODEL, JEV_INPUT_PRICE_USD, JevError, redactForClassifier } from "@/lib/asks/jev";
import { openRouterKeyPath } from "@/lib/asks/settings";
import { resolveService } from "@/lib/openaiServices/policy";
import { decisionsRequest, decideWithOpenAi, decisionsCostCeilingUsd, DECISIONS_MODEL } from "@/lib/openaiServices/decisions";

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

function selectionBatches(input: SelectionInput) {
  const state = { task: "An agent is about to start work. Decide whether each proposed rule should be given at the start.", role: input.role, project: "A", brief: safe(input.brief), rubric: "Give a rule when its trigger fits this work and its check can change an action. For receipt recovery, an ownership check applies. For a translation, checking every locale applies. A browser layout check does not apply to a database migration." };
  const batches = [];
  for (let i = 0; i < input.rules.length; i += 32) {
    batches.push({ model: JEV_MODEL, state, questions: Object.fromEntries(input.rules.slice(i, i + 32).map(rule => [createHash("sha256").update(rule.id).digest("hex").slice(0, 24), { type: "noul", instructions: `The proposed learned rule should be given to the agent at the start of this work: ${safe(rule.rule)}` }])) });
  }
  return batches;
}

/** Explicit credentials retain the OpenRouter test/embedding default. Saved
 * credentials follow the operator's per-feature choice on every authority read. */
export function configuredRoleSelectionProvider(options: { apiKey?: string | null; fetch?: typeof fetch } = {}): RoleSelectionProvider {
  if (options.apiKey !== undefined) return openRouterRoleSelectionProvider(options);
  const selected = resolveService("rules").effective;
  const provider = selected === "openai" ? openAiRoleSelectionProvider(options) : openRouterRoleSelectionProvider(options);
  return { ...provider, async readKey(signal) {
    signal.throwIfAborted();
    const current = resolveService("rules");
    return current.effective === selected ? current.apiKey : null;
  } };
}

export function openAiRoleSelectionProvider(options: { apiKey?: string | null; fetch?: typeof fetch } = {}): RoleSelectionProvider {
  return {
    id: "openai", model: `openai/${DECISIONS_MODEL}`,
    async readKey(signal) {
      signal.throwIfAborted();
      if (options.apiKey !== undefined) return options.apiKey;
      const current = resolveService("rules");
      return current.effective === "openai" ? current.apiKey : null;
    },
    prepare(input) {
      const batches = selectionBatches(input).map(batch => {
        const body = decisionsRequest(batch);
        return { body, ceiling: decisionsCostCeilingUsd(body) };
      });
      const ceilingUsd = batches.reduce((sum, batch) => sum + batch.ceiling, 0);
      return {
        ceilingUsd,
        async admit(_key, signal) {
          signal.throwIfAborted();
          // OpenAI has no OpenRouter key-balance endpoint. Local spend admission
          // still reserves the complete ceiling; HTTP refusals settle at zero.
          return { status: "admitted", httpStatus: 200, limit: null, remaining: null, ceilingUsd };
        },
        async decide(key, signal, authorize, observe) {
          const probabilities: number[] = [];
          for (const batch of batches) {
            await authorize();
            signal.throwIfAborted();
            try {
              const reply = await decideWithOpenAi(batch.body, { apiKey: key, signal, fetch: options.fetch });
              signal.throwIfAborted();
              observe(reply.cost, batch.ceiling);
              probabilities.push(...batch.body.questions.map(question => reply.scores[question.name]));
            } catch (error) {
              signal.throwIfAborted();
              observe(error instanceof JevError ? error.code === "http" ? 0 : error.billedUsd : null, batch.ceiling);
              throw error instanceof JevError ? new RoleSelectionProviderError(error.code) : error;
            }
          }
          return probabilities;
        },
      };
    },
  };
}

export function openRouterRoleSelectionProvider(options: { apiKey?: string | null; fetch?: typeof fetch } = {}): RoleSelectionProvider {
  const request = options.fetch ?? fetch;
  return {
    id: "openrouter", model: JEV_MODEL,
    async readKey(signal) {
      if (options.apiKey !== undefined) return options.apiKey;
      return process.env.OPENROUTER_API_KEY?.trim() || await fs.readFile(openRouterKeyPath(), { encoding: "utf8", signal }).then(text => text.trim() || null, () => null);
    },
    prepare(input) {
      const batches = selectionBatches(input).map(body => ({ body, ceiling: (462 + Buffer.byteLength(JSON.stringify(body))) * JEV_INPUT_PRICE_USD }));
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
          // Remaining credit governs a funded key even if its total-limit
          // metadata is absent. Only an explicit null/null pair is unlimited.
          details.status = data.limit === null && data.limit_remaining === null ? "admitted"
            : finite(data.limit_remaining) ? (data.limit_remaining >= ceilingUsd ? "admitted" : "insufficient") : "shape";
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
