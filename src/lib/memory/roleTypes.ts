import type { StaticFindingClass } from "@/lib/privacy/staticDetectors";

export type RulePrivacyHint = StaticFindingClass | "email_address";

/* Role memory (docs/design/role-memory.md, §3.1 as built): stage agents leave
   abstract lessons when they report, and the next agent of the same role,
   project or machine starts with them. Everything here lives in Delegatus's
   own state and nowhere else. */

/** Scope target in code points; unseen lessons can overflow until curation. */
export const ROLE_MEMORY_BOUND = 10_000;
export const CURATION_NEW_LESSONS = 10;
export const CURATION_INTERVAL_MS = 6 * 60 * 60_000;
export const RULE_MAX_CHARS = 300;
export const WHY_MAX_CHARS = 160;
export const PROBLEM_MAX_CHARS = 300;
export const PROBLEM_EVIDENCE_MAX_CHARS = 1000;
/** A rule shorter than this names nothing a later agent can act on. */
export const RULE_MIN_CHARS = 20;
export const MAX_LESSONS_PER_ATTEMPT = 1;

/** A lesson's text as it is stored: trimmed, each run of spacing one space. */
export function lessonText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** The length every lesson limit counts: code points of the stored text, so
    the MCP schema and the store admit exactly the same input. */
export function lessonTextLength(value: string): number {
  return [...lessonText(value)].length;
}

export type ScopeKind = "role" | "project" | "machine";

export type RuleState = "active" | "merged" | "archived";
export type CuratorReason = "task-specific" | "stale" | "in-code" | "in-instructions" | "no-reader" | "contradicted" | "duplicate" | "problem";
export type RuleLeftReason = CuratorReason | "budget" | "deleted" | "rewritten" | "undone";

export interface RuleRevision {
  by: "agent" | "curator" | "operator";
  at: string;
  source?: RuleSource;
  revertedTo?: string;
}

export type RuleRevisionView = Pick<RuleRevision, "by" | "at" | "revertedTo"> & { roleId?: string | null; fixRound?: boolean };

export interface RewriteInput {
  id: string;
  rule: string;
  why: string;
}

export interface StageRuleSource {
  origin?: "stage";
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

export interface SeatRuleSource {
  origin: "seat";
  project: string;
  roleId: "orchestrator";
  fixRound: false;
  conversationId: string;
}

export interface ImportRuleSource {
  origin: "import";
  project: string;
  roleId: string | null;
  fixRound: false;
  candidate: string;
  occurrences: import("./importTypes").ImportOccurrence[];
  engine: "claude" | "codex";
  sha256: string;
  importId: string;
}
export type RuleSource = StageRuleSource | SeatRuleSource | ImportRuleSource;

export interface RoleMemoryRule {
  kind: "rule";
  id: string;
  scope: string;
  rule: string;
  why: string;
  state: RuleState;
  /** Why a rule left the injected text, including the curator's disposition. */
  reason?: RuleLeftReason;
  mergedInto?: string;
  /** When this rule was merged; split descendants ignore merges added afterward. */
  mergedAt?: string;
  hints: RulePrivacyHint[];
  source: RuleSource;
  createdAt: string;
  changedAt: string;
  versionOf?: string;
  versions?: string[];
  revisedBy?: RuleRevision;
  curatedAt?: string;
  keptByOperatorAt?: string;
  note?: string;
  where?: string;
  against?: string;
  mergedFrom?: string[];
  movedFrom?: string;
  splitFrom?: string;
  /** Forward lineage lets import undo follow splits without scanning history. */
  splitChildren?: string[];
  /** Requests from the split source after this point belong only to its first part. */
  splitAt?: string;
  /** A curator transfer retained with the reversible archive. */
  problem?: ProblemInput;
  problemEpisode?: string;
  problemDeliveredAt?: string;
}

export interface ProblemInput {
  statement: string;
  evidence: string;
}

export interface ScopeHistoryEntry {
  revision: number;
  /** Revision counters are local to a scope until project succession joins them. */
  revisionScope?: string;
  at: string;
  /** Who changed the scope: a stage agent's lesson, the operator in the rules
      window, a curator, or the join of a scope stored under a project key that moved. */
  by: "agent" | "operator" | "succession" | "curator";
  pass?: string;
  counts?: CuratorPassView["counts"];
  before?: string[];
  prior?: { id: string; version: string | null; fields: Omit<RoleMemoryRule, "rule" | "why" | "hints"> }[];
  created?: string[];
  revertedAt?: string;
  undoSkipped?: string[];
  added: string[];
  merged: { from: string; into: string }[];
  archived: string[];
  restored?: string[];
  rewritten?: { id: string; version: string }[];
  moved?: { id: string; from: string; to: string }[];
  split?: { id: string; parts: string[] }[];
}

export interface RoleMemoryScopeRow {
  kind: "scope";
  scope: string;
  revision: number;
  /** Current revision counter namespace; succession starts a fresh joined namespace. */
  revisionScope?: string;
  /** Never-curated ids first, then curated low to high. Only curated ids can
      leave for budget; the first segment awaits curation. */
  active: string[];
  history: ScopeHistoryEntry[];
  curatedAt?: string;
  /** Raised only by a completed project import with a seat room trigger. */
  fourScopeTarget?: 24000;
}

/** One stage attempt that was asked for a lesson, and what it left. */
export interface LessonRequestRow {
  kind: "request";
  pipelineId: string;
  /** The board task at request time; older requests count their pipeline. */
  taskId?: string;
  stageId: string;
  attempt: number;
  project: string;
  roleId: string | null;
  conversationId: string;
  at: string;
  ruleIds: string[];
  /** The one line an agent gave when it left no lesson. */
  none: string | null;
  rewrote?: string;
  problem?: ProblemInput;
  problemDeliveredAt?: string;
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
  hints: RulePrivacyHint[];
  /** Distinct tasks behind the current rule's lineage; absent on older APIs. */
  tasks?: number;
  roleId: string | null;
  fixRound: boolean;
  stageId: string;
  importSource?: Pick<ImportRuleSource, "candidate" | "occurrences" | "engine" | "sha256" | "importId">;
  /** Left within the last day, as the server read it. */
  fresh: boolean;
  createdAt: string;
  changedAt: string;
  revisedBy?: RuleRevisionView;
  curatedAt?: string;
  /** Derived from scope history; optional for older API answers. */
  awaitingCuration?: boolean;
  keptByOperatorAt?: string;
  note?: string;
  where?: string;
  against?: string;
  mergedFrom?: string[];
  movedFrom?: string;
  splitFrom?: string;
  versions?: { id: string; rule: string; why: string; hints: RulePrivacyHint[]; createdAt: string; revisedBy?: RuleRevisionView }[];
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
  curation?: { lastAt: string | null; nextAt: string | null; newLessons: number; passes: CuratorPassView[] };
}

export interface StageLessonView {
  pipelineId: string;
  stageId: string;
  attempt: number;
  rules: { id: string; rule: string; scope: ScopeKind; roleId: string | null }[];
  rewrote?: string;
  none: string | null;
}

export interface CuratorPassView {
  id: string;
  state: "claimed" | "launching" | "running" | "succeeded" | "failed";
  claimedAt: string;
  endedAt: string | null;
  failure: string | null;
  counts: { calls: number; changed: number; rewritten: number; merged: number; moved: number; split: number; archived: number; restored: number };
  revertedAt?: string;
  skipped?: string[];
}
