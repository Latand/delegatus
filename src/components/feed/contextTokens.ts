import { translate, type Locale } from "@/lib/i18n";
import type { ToolEvent } from "./parse";
import type { FeedEngine } from "./tools";

/* Context tokens per tool call (docs/design/tool-call-tokens.md). Pure: the
   parser drives the ledger once per transcript line, the cards only format a
   label and pick a band from the stored value. */

export type ContextTokens = {
  /** Integer ≥ 1. */
  n: number;
  /** measured: the provider's own prompt growth across one call's round.
      shared: that growth split by result size among parallel calls.
      estimate: result characters over a calibrated ratio. */
  basis: "measured" | "shared" | "estimate";
  /** Shared only: the round's measured total and how many calls split it. */
  round?: { total: number; calls: number };
};

/** Characters per token, calibrated on clean one-call rounds (§2.3). */
export const CHARS_PER_TOKEN: Partial<Record<FeedEngine, number>> = { claude: 2.4, codex: 3.6 };
/** Split weight of one picture; never shown on its own. */
export const PICTURE_TOKENS = 1_600;

export function estimateContextTokens(engine: FeedEngine, chars: number, rasters: number): ContextTokens | undefined {
  const ratio = CHARS_PER_TOKEN[engine];
  if (ratio === undefined || rasters > 0 || !(chars >= 1)) return undefined;
  return { n: Math.max(1, Math.round(chars / ratio)), basis: "estimate" };
}

/** Largest-remainder split of `total` by `weights`; every share is at least 1. */
export function splitRound(total: number, weights: readonly number[]): number[] {
  if (!weights.length) return [];
  let sum = 0;
  for (const weight of weights) sum += weight;
  const w = sum > 0 ? weights : weights.map(() => 1);
  if (sum <= 0) sum = w.length;
  const shares = w.map((weight) => Math.floor((total * weight) / sum));
  const order = w
    .map((weight, index) => ({ index, rest: (total * weight) % sum }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  let left = total - shares.reduce((acc, share) => acc + share, 0);
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return shares.map((share) => Math.max(1, share));
}

/** `352` · `9.8k` · `12.4k` · `123k` · `1.2M`, floored so a label never claims
    a band the count has not reached; `~` marks a shared or estimated value. */
export function formatContextTokens(t: Pick<ContextTokens, "n" | "basis">): string {
  const n = Math.floor(t.n);
  let label: string;
  if (n < 1_000) label = String(n);
  else if (n < 100_000) label = tenths(Math.floor(n / 100), "k");
  else if (n < 1_000_000) label = `${Math.floor(n / 1_000)}k`;
  else label = tenths(Math.floor(n / 100_000), "M");
  return t.basis === "measured" ? label : `~${label}`;
}

function tenths(tenthsOfUnit: number, suffix: string): string {
  const whole = Math.floor(tenthsOfUnit / 10);
  const fraction = tenthsOfUnit % 10;
  return fraction ? `${whole}.${fraction}${suffix}` : `${whole}${suffix}`;
}

export type ContextTokenBand = 0 | 1 | 2 | 3;

export function contextTokenBand(n: number): ContextTokenBand {
  if (n >= 20_000) return 3;
  if (n >= 10_000) return 2;
  if (n >= 1_000) return 1;
  return 0;
}

/** The sum over a group's settled calls. Undefined when none has a number;
    measured only when every settled call is measured. */
export function sumContextTokens(events: readonly Pick<ToolEvent, "status" | "contextTokens">[]): ContextTokens | undefined {
  let n = 0;
  let any = false;
  let exact = true;
  for (const event of events) {
    if (event.status === "run") continue;
    const value = event.contextTokens;
    if (value) {
      n += value.n;
      any = true;
    }
    if (value?.basis !== "measured") exact = false;
  }
  return any ? { n, basis: exact ? "measured" : "estimate" } : undefined;
}

const NUMBER_LOCALE: Record<Locale, string> = { en: "en-US", uk: "uk-UA" };

const numberFormats = new Map<Locale, Intl.NumberFormat>();

function numberFormat(locale: Locale): Intl.NumberFormat {
  let format = numberFormats.get(locale);
  if (!format) numberFormats.set(locale, (format = new Intl.NumberFormat(NUMBER_LOCALE[locale])));
  return format;
}

export function contextTokensTitle(t: ContextTokens, scope: "call" | "calls", locale: Locale): string {
  const format = numberFormat(locale);
  const params = {
    count: t.n,
    n: format.format(t.n),
    total: format.format(t.round?.total ?? t.n),
    calls: t.round?.calls ?? 1,
  };
  if (scope === "calls") {
    return translate(locale, t.basis === "measured" ? "tools.contextTokens.groupMeasured" : "tools.contextTokens.groupEstimate", params);
  }
  return translate(locale, `tools.contextTokens.${t.basis}` as const, params);
}

/* ---------------------------------------------------------------- ledger */

type Round = {
  /** Prompt size of the response that issued the round's calls; null when unknown. */
  before: number | null;
  output: number;
  members: string[];
  contaminated: boolean;
  /** The window may have opened inside this response, so its calls are not all known. */
  partial: boolean;
};

export type ContextLedger = {
  /** A Claude assistant line with usage. `prompt` is null when the line carries none. */
  claudeResponse(id: string | null, prompt: number | null, output: number): void;
  /** A Codex `token_count` with `last_token_usage`. */
  codexUsage(prompt: number, output: number, totalTokens: number | undefined): void;
  /** A call the current response issued. `hosted` marks one the provider runs and bills inside that response. */
  member(id: string, hosted?: boolean): void;
  /** A result attached to a call. A repeat result for the same call replaces
      the recorded size (the last, model-facing one wins); a `quiet` one adds to
      it, records its size and shows no estimate. */
  result(id: string, chars: number, rasters: number, quiet?: boolean): void;
  /** Something else entered the prompt between two responses. */
  contaminate(): void;
  /** A Codex `exec` whose nested items represent it in the feed. */
  represent(outerId: string, nestedIds: readonly string[]): void;
  /** Show the estimate of a row from its own recorded result, if it has one. */
  estimate(id: string): void;
  /** A call left the window. Returns the nested rows whose number came from it. */
  forget(id: string): string[];
  /** `partial` when the window starts past the beginning of the transcript. */
  reset(partial: boolean): void;
  /** Names everything a later line can still read from before this one, or
      null while a round waits on a later response: its calls, their recorded
      sizes, or the nested rows of a code-mode exec. Two ledgers that report
      the same signature settle every later round identically. */
  signature(): string | null;
};

const SIZE_LIMIT = 256;

export function createContextLedger(
  engine: FeedEngine,
  apply: (id: string, value: ContextTokens) => void,
  hasCard: (id: string) => boolean = () => true,
): ContextLedger {
  const ratio = CHARS_PER_TOKEN[engine] ?? CHARS_PER_TOKEN.claude!;
  const sizes = new Map<string, { chars: number; rasters: number }>();
  const represented = new Map<string, string[]>();
  let round: Round | null = null;
  let pending: string[] = [];
  let pendingContaminated = false;
  let pendingHosted = false;
  let lastTotal: number | undefined;
  let fresh = false;

  const weight = (id: string): number => {
    const size = sizes.get(id);
    return Math.round((size?.chars ?? 0) + (size?.rasters ?? 0) * PICTURE_TOKENS * ratio);
  };

  const emit = (id: string, value: ContextTokens) => {
    const nested = represented.get(id);
    if (!nested) return apply(id, value);
    if (nested.length === 1) return apply(nested[0], value);
    const shares = splitRound(value.n, nested.map(weight));
    nested.forEach((nestedId, index) => {
      const n = shares[index];
      if (value.basis === "estimate") apply(nestedId, { n, basis: "estimate" });
      else apply(nestedId, { n, basis: "shared", round: { total: value.round?.total ?? value.n, calls: (value.round?.calls ?? 1) - 1 + nested.length } });
    });
  };

  const resolve = (closing: Round | null, nextPrompt: number | null, hosted = false) => {
    if (!closing || !closing.members.length) return;
    const { members } = closing;
    const growth = closing.before === null || nextPrompt === null ? 0 : nextPrompt - closing.before - closing.output;
    const eligible = !closing.contaminated && !closing.partial && !hosted && growth > 0
      && members.every((id) => sizes.has(id) && hasCard(id));
    if (eligible) {
      if (members.length === 1) emit(members[0], { n: growth, basis: "measured" });
      else {
        const shares = splitRound(growth, members.map(weight));
        members.forEach((id, index) => emit(id, { n: shares[index], basis: "shared", round: { total: growth, calls: members.length } }));
      }
    }
    for (const id of members) if (!represented.has(id)) sizes.delete(id);
  };

  const open = (prompt: number | null, output: number, members: string[], contaminated: boolean): Round => {
    const partial = fresh;
    fresh = false;
    return { before: prompt, output, members, contaminated, partial };
  };

  let currentId: string | null | undefined;

  return {
    claudeResponse(id, prompt, output) {
      if (round && id !== null && id === currentId) {
        round.output = Math.max(round.output, output);
        return;
      }
      resolve(round, prompt);
      currentId = id;
      round = open(id === null ? null : prompt, output, [], false);
    },
    codexUsage(prompt, output, totalTokens) {
      if (totalTokens !== undefined && totalTokens === lastTotal) return;
      lastTotal = totalTokens;
      resolve(round, prompt, pendingHosted);
      round = open(prompt, output, pending, pendingContaminated);
      pending = [];
      pendingContaminated = false;
      pendingHosted = false;
    },
    member(id, hosted = false) {
      if (hosted) pendingHosted = true;
      if (engine === "codex") pending.push(id);
      else round?.members.push(id);
    },
    result(id, chars, rasters, quiet = false) {
      const previous = sizes.get(id);
      sizes.set(id, quiet && previous ? { chars: previous.chars + chars, rasters: previous.rasters + rasters } : { chars, rasters });
      if (!previous && sizes.size > SIZE_LIMIT) sizes.delete(sizes.keys().next().value!);
      if (quiet) return;
      const total = sizes.get(id)!;
      const estimate = estimateContextTokens(engine, total.chars, total.rasters);
      if (estimate) emit(id, estimate);
    },
    estimate(id) {
      const size = sizes.get(id);
      const estimate = size && estimateContextTokens(engine, size.chars, size.rasters);
      if (estimate) emit(id, estimate);
    },
    contaminate() {
      if (engine === "codex" && pending.length) pendingContaminated = true;
      else if (round?.members.length) round.contaminated = true;
    },
    represent(outerId, nestedIds) {
      represented.set(outerId, [...nestedIds]);
    },
    forget(id) {
      const nested = represented.get(id) ?? [];
      represented.delete(id);
      sizes.delete(id);
      return nested;
    },
    signature() {
      if (pending.length || sizes.size || represented.size || round?.members.length) return null;
      const held = round ? `${round.before}/${round.output}/${round.contaminated ? 1 : 0}/${round.partial ? 1 : 0}` : "-";
      return `${fresh ? 1 : 0}|${currentId ?? ""}|${lastTotal ?? ""}|${held}|${pendingContaminated ? 1 : 0}${pendingHosted ? 1 : 0}`;
    },
    reset(partial) {
      sizes.clear();
      represented.clear();
      round = null;
      currentId = undefined;
      pending = [];
      pendingContaminated = false;
      pendingHosted = false;
      lastTotal = undefined;
      fresh = partial;
    },
  };
}
