import type { Locale } from "@/lib/i18n/core";
import type { ScopeKind } from "./roleTypes";

export type ProfileTopic = { title: string; text?: string; rules: number[] };
export type ProfileAnswer = { headline: string; text: string; topics: ProfileTopic[] };
export type ProfileBasis = { id: string; changedAt: string }[];
export type ProfilePart = {
  scope: string;
  model: string;
  promptVersion: number;
  hash: string;
  basis: ProfileBasis;
  answer: ProfileAnswer;
  createdAt: string;
  durationMs: number;
};
export type ProfileError = "account" | "size" | "language" | "invalid" | "timeout" | "failed" | "interrupted";
export type ProfileRow = {
  project: string;
  locale: Locale;
  model: string;
  promptVersion: number;
  parts: ProfilePart[];
  run?: { state: "running" | "failed" | "done"; startedAt: string; errors: { scope: string; code: ProfileError }[]; durationMs?: number; firstResultMs?: number };
};
export type ProfilePartView = Omit<ProfilePart, "basis" | "hash" | "answer"> & {
  stale: boolean;
  answer: { headline: string; text: string; topics: { title: string; text?: string; ruleIds: string[] }[] };
};
export type MemoryProfileView = {
  project: string;
  locale: Locale;
  enabled: boolean;
  model: string;
  ruleCount: number;
  stale: boolean;
  changes: { added: number; rewritten: number; removed: number };
  overall: ProfilePartView | null;
  slices: { scope: string; kind: ScopeKind; roleId: string | null; acrossProjects: boolean; count: number; summary: ProfilePartView | null }[];
  run: ProfileRow["run"] | null;
};
