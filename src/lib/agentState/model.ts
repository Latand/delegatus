import type { ProcessIdentity } from "@/lib/processIdentity";
import type { Determinable } from "@/lib/runtime/determinable";

export const AGENT_STATE_POLICY = Object.freeze({ version: 1, reconcileMs: 2 * 60_000, observationMs: 5000, stuckMs: 10 * 60_000, startupGraceMs: 5 * 60_000, idleMs: 3_600_000 });
export type AgentState = "working" | "waiting-operator" | "idle" | "stuck" | "unowned" | "dead";
export interface Evidence {
  source: "proc" | "host-memory" | "native-transcript" | "registry-cache" | "operation-ledger";
  observedAt: number;
  eventAt?: number;
  validUntil?: number;
  subjectRevision: string;
  ref: string;
}
export type Fact<T> = (Determinable<T> & { evidence: Evidence });
export function fact<T>(value: T, evidence: Evidence): Fact<T> { return { determined: true, value, evidence }; }
export function unknown(why: string, evidence: Evidence): Fact<never> { return { determined: false, why, evidence }; }
export interface NativeTurn {
  state: "open" | "closed" | "absent";
  nativeId: string | null;
  localRef: string | null;
  opening: string | null;
  closing: string | null;
  at: number | null;
  /** Native formal completion settles historical turn-local calls. */
  tools: number;
  outcome?: "completed" | "interrupted" | "error";
  promptOrdinal?: number | null;
  modelReady?: boolean;
  ancestry?: string[];
}
export interface NativePromptAnchor {
  device: string | null;
  inode: string | null;
  offset: number;
  edgeHash: string;
}
export function validNativePromptAnchor(value: unknown): value is NativePromptAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as NativePromptAnchor;
  return Number.isSafeInteger(v.offset) && v.offset >= 0 && /^[a-f0-9]{64}$/.test(v.edgeHash)
    && ((v.device === null && v.inode === null && v.offset === 0)
      || typeof v.device === "string" && /^\d+$/.test(v.device) && typeof v.inode === "string" && /^\d+$/.test(v.inode));
}
export interface TranscriptVersion {
  artifact: string;
  signature: string;
  size: number;
  mtimeMs: number;
  coveredFrom: number;
  bytesRead: number;
}
export interface AgentFacts {
  subject: string;
  engine: "codex" | "claude" | "copilot";
  revision: string;
  process: Fact<{ status: "alive" | "dead"; identity: ProcessIdentity }>;
  owner: Fact<"held" | "other" | "absent">;
  turn: Fact<NativeTurn>;
  attention: Fact<string[]>;
  readonly transcript: Fact<TranscriptVersion>;
  obligations: Fact<string[]>;
  activity: Fact<{ tools: number; flags: string[]; providerRetry: boolean }>;
}
export interface AgentVerdict {
  state: AgentState | null;
  quality: "verified" | "unverified";
  reason: string;
  since: number | null;
  evaluatedAt: number;
  policyVersion: number;
  projectionRevision: number;
  stuck: boolean;
  missing: string[];
}
export function evaluateAgentState(facts: AgentFacts, now: number, policy = AGENT_STATE_POLICY): AgentVerdict {
  const missing = (["process", "owner", "turn", "attention", "transcript", "obligations", "activity"] as const).flatMap(key => {
    const value = facts[key];
    return !value || !value.determined || (value.evidence.validUntil !== undefined && value.evidence.validUntil < now) ? [key] : [];
  });
  const available = (key: (typeof missing)[number]) => !missing.includes(key);
  const stuck = available("process") && facts.process.determined && facts.process.value.status === "alive" && available("turn") && available("transcript") && facts.turn.determined && facts.transcript.determined
    && facts.turn.value.state === "open" && now - facts.transcript.value.mtimeMs >= policy.stuckMs;
  let state: AgentState | null = null;
  let reason = missing.length ? `unverified ${missing.join(", ")}` : "boundary-unresolved";
  if (available("process") && facts.process.determined) {
    if (facts.process.value.status === "dead") { state = "dead"; reason = "recorded process ended"; }
    else if (available("owner") && facts.owner.determined) {
      if (facts.owner.value === "absent") { state = "unowned"; reason = "recorded process has no live holder"; }
      else if (available("attention") && facts.attention.determined) {
        if (facts.attention.value.length) { state = "waiting-operator"; reason = "current question or permission awaits an answer"; }
        else if (available("turn") && facts.turn.determined) {
          if (facts.turn.value.state !== "open") { state = "idle"; reason = "native turn settled"; }
          else if (available("transcript")) {
            state = stuck ? "stuck" : "working";
            reason = stuck ? "open turn with silent transcript" : facts.turn.value.opening === "accepted" ? "accepted work awaiting a native prompt" : "verified open turn";
            if (stuck && facts.activity?.determined && facts.activity.value.flags.length) reason += `; ${facts.activity.value.flags.join(", ")}`;
          }
        }
      }
    }
  }
  return { state, quality: state === null ? "unverified" : "verified", reason,
    since: facts.turn.determined ? facts.turn.value.at : null, evaluatedAt: now,
    policyVersion: policy.version, projectionRevision: 0, stuck, missing };
}

/** Display is allowed to retain old evidence; effect callers require every fence. */
export function centralIdleEligible(facts: AgentFacts, now: number, idleMs = AGENT_STATE_POLICY.idleMs): boolean {
  const verdict = evaluateAgentState(facts, now);
  return verdict.missing.length === 0 && (verdict.state === "idle" || verdict.state === "unowned")
    && facts.turn.determined && facts.turn.value.state !== "open"
    && facts.attention.determined && facts.attention.value.length === 0
    && facts.obligations.determined && facts.obligations.value.length === 0
    && facts.transcript.determined && now - facts.transcript.value.mtimeMs >= idleMs;
}

export interface AgentProjection {
  version: 1;
  subject: string;
  entryKey: string;
  conversationId: string | null;
  facts: AgentFacts;
  verdict: AgentVerdict;
  revision: number;
  pendingPublication: boolean;
  publishable?: boolean;
  divergence: string | null;
  divergenceKey?: string | null;
  rssBytes: number | null;
  rssCapturedAt?: number;
  terminalAt?: number;
}
export interface AgentStateJournal {
  version: 1;
  id: string;
  subject: string;
  at: number;
  from: AgentState | null;
  to: AgentState | null;
  reason: string;
  divergence: string | null;
  writer: ProcessIdentity;
  release: string;
  evidence: Evidence[];
  conversationId?: string | null;
  entryKey?: string;
  effectiveAt?: number | null;
  fromTurn?: { state: NativeTurn["state"] | null; nativeId: string | null; cacheRef: string | null };
  toTurn?: { state: NativeTurn["state"] | null; nativeId: string | null; cacheRef: string | null };
}
export interface AgentStateMetrics {
  version: 1;
  revision: number;
  at: number;
  registryTranscriptDivergencesTotal: number;
  registryTranscriptDivergencesCurrent: number;
  unownedHosts: number;
  unownedRssBytes: number | null;
  unownedRssMeasured: number;
  unownedRssUnknown: number;
  stuckTurns: number;
  stuckByEngine: { codex: number; claude: number; copilot: number };
  stuckByReason: { silent: number; checking: number; providerWait: number };
  subjectsObserved: number;
  subjectsUnverified: number;
  subjectsDeferred: number;
  physicalAliasesUnverified: number;
  pendingProjectionPublications: number;
  journalRows: number;
  terminalSubjects: number;
  lastCompleteReconciliationAt: number | null;
  afterKey: string | null;
  physicalSubjects?: string[];
}
export function emptyAgentStateMetrics(): AgentStateMetrics {
  return { version: 1, revision: 0, at: 0, registryTranscriptDivergencesTotal: 0, registryTranscriptDivergencesCurrent: 0,
    unownedHosts: 0, unownedRssBytes: null, unownedRssMeasured: 0, unownedRssUnknown: 0, stuckTurns: 0, stuckByEngine: { codex: 0, claude: 0, copilot: 0 }, stuckByReason: { silent: 0, checking: 0, providerWait: 0 },
    subjectsObserved: 0, subjectsUnverified: 0, subjectsDeferred: 0, pendingProjectionPublications: 0,
    lastCompleteReconciliationAt: null, afterKey: null, journalRows: 0, terminalSubjects: 0, physicalAliasesUnverified: 0 };
}

export interface AgentStateDisplay {
  stuck?: boolean;
  subject: string;
  state: AgentState | null;
  reason: string;
  quality: "verified" | "unverified";
  evaluatedAt: number;
  revision: number;
}
export function projectAgentStateDisplay(row: AgentProjection, now: number): AgentStateDisplay {
  const expired = Object.values(row.facts).some(value => value && typeof value === "object" && "evidence" in value
    && value.evidence.validUntil !== undefined && value.evidence.validUntil < now);
  return { subject: row.subject, state: row.verdict.state, reason: expired ? `cached observation expired; ${row.verdict.reason}` : row.verdict.reason,
    quality: expired ? "unverified" : row.verdict.quality, evaluatedAt: row.verdict.evaluatedAt, revision: row.revision, stuck: row.verdict.stuck };
}
export function validAgentStateDisplay(value: unknown): value is AgentStateDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 6 + Number(row.stuck !== undefined) && (row.stuck === undefined || typeof row.stuck === "boolean") && typeof row.subject === "string" && /^[a-f0-9]{48}$/.test(row.subject)
    && (row.state === null || ["working", "waiting-operator", "idle", "stuck", "unowned", "dead"].includes(row.state as string))
    && typeof row.reason === "string" && row.reason.length <= 1024
    && (row.quality === "verified" || row.quality === "unverified")
    && typeof row.evaluatedAt === "number" && Number.isFinite(row.evaluatedAt) && row.evaluatedAt >= 0
    && typeof row.revision === "number" && Number.isSafeInteger(row.revision) && row.revision >= 0;
}

export function validAgentFacts(value: unknown): value is AgentFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.subject !== "string" || !/^[a-f0-9]{48}$/.test(row.subject)
    || !["codex", "claude", "copilot"].includes(row.engine as string) || typeof row.revision !== "string" || row.revision.length > 128) return false;
  for (const key of ["process", "owner", "turn", "attention", "transcript", "obligations", "activity"]) {
    const field = row[key] as { determined?: unknown; evidence?: Evidence; value?: unknown; why?: unknown } | undefined;
    if (!field || typeof field.determined !== "boolean" || !field.evidence || !validAgentEvidence(field.evidence)) return false;
    if (!field.determined) {
      if (typeof field.why !== "string" || field.why.length > 512) return false;
      continue;
    }
    const item = field.value;
    const strings = (v: unknown, max: number, length: number) => Array.isArray(v) && v.length <= max && v.every(s => typeof s === "string" && s.length <= length);
    if (key === "owner" && !["held", "other", "absent"].includes(item as string)) return false;
    if ((key === "attention" || key === "obligations") && !strings(item, 32, 256)) return false;
    if (["process", "turn", "transcript", "activity"].includes(key)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const v = item as Record<string, unknown>;
      const number = (k: string) => typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= 0;
      if (key === "process") {
        const identity = v.identity as ProcessIdentity | undefined;
        if (!["alive", "dead"].includes(v.status as string) || !identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
          || typeof identity.startIdentity !== "string" || !identity.startIdentity || typeof identity.bootEpoch !== "string" || !identity.bootEpoch) return false;
      }
      if (key === "turn" && (!["open", "closed", "absent"].includes(v.state as string) || !number("tools")
        || v.ancestry !== undefined && !strings(v.ancestry, 16, 128)
        || v.promptOrdinal !== undefined && v.promptOrdinal !== null && !number("promptOrdinal")
        || v.modelReady !== undefined && typeof v.modelReady !== "boolean"
        || !["nativeId", "localRef", "opening", "closing"].every(k => v[k] === null || typeof v[k] === "string" && v[k].length <= 256)
        || !(v.at === null || number("at")))) return false;
      if (key === "transcript" && (!number("size") || !number("mtimeMs") || !number("coveredFrom") || !number("bytesRead")
        || typeof v.signature !== "string" || v.signature.length > 256 || typeof v.artifact !== "string" || !/^[a-f0-9]{24}$/.test(v.artifact))) return false;
      if (key === "activity" && (!number("tools") || !strings(v.flags, 16, 64) || typeof v.providerRetry !== "boolean")) return false;
    }
  }
  return true;
}
export function validAgentEvidence(value: unknown): value is Evidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ["proc", "host-memory", "native-transcript", "registry-cache", "operation-ledger"].includes(v.source as string)
    && typeof v.observedAt === "number" && Number.isFinite(v.observedAt)
    && typeof v.subjectRevision === "string" && v.subjectRevision.length <= 128 && typeof v.ref === "string" && v.ref.length <= 256
    && ["eventAt", "validUntil"].every(key => v[key] === undefined || typeof v[key] === "number" && Number.isFinite(v[key]));
}

export function agentStateActivity(display: AgentStateDisplay, open: boolean | null): "live" | "stalled" | "idle" | null {
  if (display.state === null) return null;
  if (display.state === "working" || display.state === "waiting-operator") return "live";
  if (display.state === "stuck") return "stalled";
  if (display.state === "unowned") return open === null ? null : open ? display.stuck ? "stalled" : "live" : "idle";
  return "idle";
}
