/** Counts are disjoint except for the two explicitly named subsets. */
export interface TokenCounts {
  input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number;
  output: number; reasoning: number; requests: number;
}

export const TOKEN_FIELDS = ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "reasoning", "requests"] as const;
export const emptyTokens = (): TokenCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0 });
export const tokenTotal = (counts: TokenCounts) => counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
export function addTokens(into: TokenCounts, counts: TokenCounts): void {
  for (const key of TOKEN_FIELDS) into[key] += counts[key];
}

export interface UsageRecord {
  engine: "claude" | "codex";
  id: string;
  at: number;
  model: string | null;
  tier: string | null;
  counts: TokenCounts;
  /** Codex cumulative counters, including cached input in input. */
  cumulative?: CodexCounters;
  legacy?: boolean;
  baseline?: CodexCounters;
}
export interface CodexCounters {
  total: number; input: number; cached: number; cacheWrite: number; output: number; reasoning: number;
}
export interface UsageFacts {
  thread?: string;
  model?: string;
  recordsSeen?: boolean;
}
export interface UsageAttribution {
  account: string; member: string; model: string | null; tier: string | null;
}

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;

/** Used only by the existing activity line reader; it never opens a file. */
export class UsageLineReader {
  readonly records: UsageRecord[] = [];
  readonly state: UsageFacts;
  malformed = 0;
  private claude = new Map<string, UsageRecord>();
  constructor(state?: UsageFacts) { this.state = { ...state }; }

  accept(engine: "claude" | "codex", line: Record<string, unknown>): void {
    const payload = object(line.payload);
    if (engine === "codex") {
      if (line.type === "session_meta") this.state.thread = text(payload?.id) ?? this.state.thread;
      if (line.type === "turn_context") this.state.model = text(payload?.model) ?? this.state.model;
    }
    const message = object(line.message);
    const legacy = engine === "codex" && line.type === "event_msg" && payload?.type === "token_count" && !this.state.recordsSeen;
    const modern = engine === "codex" && line.type === "token_usage_record";
    const claude = engine === "claude" && line.type === "assistant" && object(message?.usage) && message?.model !== "<synthetic>";
    if (!legacy && !modern && !claude) return;
    // Some Codex builds emit bookkeeping token_count events with no usage at
    // all. They are not responses and must not affect coverage or mode state.
    if (legacy && !object(payload?.info)) return;
    const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    const id = engine === "claude" ? text(message?.id) : text(payload?.thread_id) ?? this.state.thread;
    if (!Number.isFinite(at) || !id || (modern && !text(payload?.response_id))) { this.malformed++; return; }
    let bad = false;
    const number = (value: unknown, optional = false): number => {
      if (optional && value === undefined) return 0;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) { bad = true; return 0; }
      return value;
    };
    const counts = emptyTokens();
    counts.requests = 1;
    if (engine === "claude") {
      const usage = object(message!.usage)!;
      counts.input = number(usage.input_tokens);
      counts.cacheRead = number(usage.cache_read_input_tokens, true);
      counts.cacheWrite = number(usage.cache_creation_input_tokens, true);
      counts.cacheWrite1h = number(object(usage.cache_creation)?.ephemeral_1h_input_tokens, true);
      counts.output = number(usage.output_tokens);
      counts.reasoning = number(object(usage.output_tokens_details)?.thinking_tokens, true);
      if (counts.cacheWrite1h > counts.cacheWrite || counts.reasoning > counts.output) bad = true;
      counts.cacheWrite1h = Math.min(counts.cacheWrite1h, counts.cacheWrite);
      counts.reasoning = Math.min(counts.reasoning, counts.output);
      const prior = this.claude.get(id);
      if (prior) { for (const key of TOKEN_FIELDS) prior.counts[key] = Math.max(prior.counts[key], counts[key]); }
      else {
        const row: UsageRecord = { engine, id, at, model: text(message!.model), tier: text(usage.speed), counts };
        this.claude.set(id, row); this.records.push(row);
      }
    } else {
      const counters = (value: unknown): CodexCounters => {
        const u = object(value);
        return { input: number(u?.input_tokens), cached: number(u?.cached_input_tokens, true), cacheWrite: number(u?.cache_write_input_tokens, true),
          output: number(u?.output_tokens), reasoning: number(u?.reasoning_output_tokens, true), total: number(u?.total_tokens) };
      };
      const info = object(payload?.info);
      const cumulative = counters(modern ? payload?.thread_token_usage : info?.total_token_usage);
      const usage = counters(modern ? payload?.usage : info?.last_token_usage);
      if (usage.cached + usage.cacheWrite > usage.input || usage.reasoning > usage.output || cumulative.cached + cumulative.cacheWrite > cumulative.input
        || cumulative.reasoning > cumulative.output || usage.total !== usage.input + usage.output || cumulative.total !== cumulative.input + cumulative.output) bad = true;
      counts.input = Math.max(0, usage.input - usage.cached - usage.cacheWrite);
      counts.cacheRead = usage.cached; counts.cacheWrite = usage.cacheWrite;
      counts.output = usage.output; counts.reasoning = Math.min(usage.output, usage.reasoning);
      const baseline = { ...cumulative };
      for (const key of Object.keys(baseline) as Array<keyof CodexCounters>) baseline[key] = Math.max(0, baseline[key] - usage[key]);
      if (bad) { this.malformed++; return; }
      if (modern) this.state.recordsSeen = true;
      this.records.push({ engine, id, at, model: this.state.model ?? null, tier: null, counts, cumulative, ...(legacy ? { legacy: true, baseline } : {}) });
    }
    if (bad) this.malformed++;
  }
}
