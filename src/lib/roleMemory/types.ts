import type { StaticFindingClass } from "@/lib/privacy/staticDetectors";

/* Role memory (docs/design/role-memory.md, §3.1 as built): stage agents leave
   abstract lessons when they report, and the next agent of the same role,
   project or machine starts with them. Everything here lives in Delegatus's
   own state and nowhere else. */

/** Each scope's injected text stays within this many characters (code points). */
export const ROLE_MEMORY_BOUND = 10_000;
export const RULE_MAX_CHARS = 300;
export const WHY_MAX_CHARS = 160;
/** A rule shorter than this names nothing a later agent can act on. */
export const RULE_MIN_CHARS = 20;
export const MAX_LESSONS_PER_ATTEMPT = 3;

/** Roles that stay clean: they read no learned rules and leave none. */
export const CLEAN_ROLE_IDS = ["reviewer", "verifier", "issue-reporter"] as const;

export type ScopeKind = "role" | "project" | "machine";

export type RuleState = "active" | "merged" | "archived";
export type RuleLeftReason = "duplicate" | "budget" | "deleted";

export interface RuleSource {
  project: string;
  pipelineId: string;
  stageId: string;
  attempt: number;
  /** The role of the stage that wrote the rule; null for a stage with no preset. */
  roleId: string | null;
  /** The attempt was activated by a fail edge: a fix round. */
  fixRound: boolean;
  conversationId: string;
}

export interface RoleMemoryRule {
  kind: "rule";
  id: string;
  scope: string;
  rule: string;
  why: string;
  state: RuleState;
  /** Why a rule left the injected text: a near-duplicate merged into a fuller rule, the bound, or the operator removed it. */
  reason?: RuleLeftReason;
  mergedInto?: string;
  hints: StaticFindingClass[];
  source: RuleSource;
  createdAt: string;
  changedAt: string;
}

export interface ScopeHistoryEntry {
  revision: number;
  at: string;
  /** Who changed the scope: a stage agent's lesson, or the operator in the rules window. */
  by: "agent" | "operator";
  added: string[];
  merged: { from: string; into: string }[];
  archived: string[];
  restored?: string[];
}

export interface RoleMemoryScopeRow {
  kind: "scope";
  scope: string;
  revision: number;
  /** Active rule ids in injection order, oldest first. */
  active: string[];
  history: ScopeHistoryEntry[];
}

/** One stage attempt that was asked for a lesson, and what it left. */
export interface LessonRequestRow {
  kind: "request";
  pipelineId: string;
  stageId: string;
  attempt: number;
  project: string;
  roleId: string | null;
  conversationId: string;
  at: string;
  ruleIds: string[];
  /** The one line an agent gave when it left no lesson. */
  none: string | null;
}

export type RoleMemoryRow = RoleMemoryRule | RoleMemoryScopeRow | LessonRequestRow;

export interface LessonInput {
  scope: ScopeKind;
  /** With scope role: the role the rule is for, when it is not the writer's own. */
  role?: string;
  rule: string;
  why: string;
}

/** What the window and the card read: no conversation ids leave the server. */
export interface RuleView {
  id: string;
  rule: string;
  why: string;
  state: RuleState;
  reason?: RuleLeftReason;
  mergedInto?: string;
  hints: StaticFindingClass[];
  roleId: string | null;
  fixRound: boolean;
  stageId: string;
  /** Left within the last day, as the server read it. */
  fresh: boolean;
  createdAt: string;
  changedAt: string;
}

export interface ScopeView {
  scope: string;
  kind: ScopeKind;
  roleId: string | null;
  revision: number;
  chars: number;
  bound: number;
  addedToday: number;
  active: RuleView[];
  /** Rules that left the injected text, newest first: merged and archived. */
  left: RuleView[];
}

export interface RoleMemoryProjectView {
  project: string;
  /** False only while the installation's kill switch (`LLV_ROLE_MEMORY=off`) is set. */
  enabled: boolean;
  scopes: ScopeView[];
}

export interface StageLessonView {
  pipelineId: string;
  stageId: string;
  attempt: number;
  rules: { id: string; rule: string; scope: ScopeKind; roleId: string | null }[];
  none: string | null;
}
