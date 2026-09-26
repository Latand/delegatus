import { providerCredentialChangedAt as changedAt, providerCredentialRevision as revision, readProviderMessageHealth as readHealth } from "../../../bin/claude-provider-health.mjs";

export type ProviderMessageHealth = { state: "error" | "authenticated"; checkedAt: number };
export const providerCredentialRevision: (home: string) => string | null = revision;
export const providerCredentialChangedAt: (home: string) => number | null = changedAt;
export const readProviderMessageHealth: (home: string) => ProviderMessageHealth | null = readHealth;
