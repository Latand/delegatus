export type SpendEngine = "claude" | "codex";
export interface TaskSpendAccount {
  /** Engine-qualified account key; unknown when attribution is unavailable. */
  key: string;
  label: string;
  plan: string | null;
  /** Task tokens converted to percentage points of this account's weekly allowance. */
  weeklyPp: number | null;
  tokens: number;
  week: { usedPercent: number; taskPp: number | null } | null;
  sessionPp: number | null;
}
export interface TaskSpendProvider {
  engine: SpendEngine;
  weeklyPp: number;
  tokens: number;
  bound: "approx" | "floor" | "norate";
  floor: "before-counting" | "uncounted" | null;
  /** Account detail is returned only to the owner. */
  accounts: TaskSpendAccount[] | null;
}
export interface TaskSpendSummary { providers: TaskSpendProvider[] }
export interface TaskSpendResponse { generatedAt: number; tasks: Record<string, TaskSpendSummary> }
