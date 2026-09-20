export type Quota = { horizon: "daily" | "weekly" | "unknown"; value: number };
export function primarySummary(quotas: Quota[]): string { return `primary ${quotas[0]?.horizon ?? "unknown"}`; }
