export type SpendEngine = "claude" | "codex";
export type SpendBasis = "measured" | "plan" | "mixed";
export interface SpendBudget { low: number; mid: number; high: number; grade: "measured" | "measured-thin" | "inferred" | "published" }
export interface SpendRange { low: number; high: number }
export type SpendIssue = "planMissing" | "noFixedLimit" | "noPlanBudget";
export interface TaskSpendAccount {
  /** Engine-qualified account key, or unknown when attribution is unavailable. */
  key: string;
  label: string;
  plan: string | null;
  planTier: string | null;
  /** Task tokens converted to percentage points of this account's weekly allowance. */
  weeklyPp: number | null;
  basis: SpendBasis | null;
  range: SpendRange | null;
  budget: SpendBudget | null;
  apiUsd: number | null;
  tokens: number;
  week: { usedPercent: number; taskPp: number | null } | null;
  sessionPp: number | null;
}
export interface TaskSpendProvider {
  engine: SpendEngine;
  weeklyPp: number;
  tokens: number;
  bound: "approx" | "floor" | "tokens";
  floor: "before-counting" | null;
  basis: SpendBasis | null;
  range: SpendRange | null;
  budgets: SpendBudget[];
  outsideBudget: boolean;
  apiUsd: number | null;
  apiPricedTokens: number;
  unpricedModels: string[];
  unpricedTokens: number;
  issues: SpendIssue[];
  /** Account detail is returned only to the owner. */
  accounts: TaskSpendAccount[] | null;
}
export interface TaskSpendSummary { providers: TaskSpendProvider[] }
export interface TaskSpendResponse { generatedAt: number; tasks: Record<string, TaskSpendSummary> }
