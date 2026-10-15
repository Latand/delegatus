import path from "node:path";

import type { AgentRegistry } from "@/lib/agent/registry";
type RegistrySnapshot = ReturnType<AgentRegistry["readOnlySnapshot"]>;
import type { ProcessIdentity, ProcessIdentityStatus } from "@/lib/processIdentity";

export type NativeCallerReason =
  | "platform-unverified" | "no-claude-ancestor" | "capability-unresolved" | "capability-conflict"
  | "foreign-host" | "unknown-claude-home" | "session-record-missing" | "session-record-invalid"
  | "session-kind" | "process-identity-mismatch" | "domain-mismatch" | "record-predates-process"
  | "session-held-twice" | "session-not-scanned" | "generation-ambiguous"
  | "generation-not-current" | "transcript-outside-home" | "generation-hosted"
  | "session-changed" | "session-proof-unavailable" | "approval-waiting" | "approval-refused" | "approval-unavailable";
export interface NativeCallerRefusal { reason: NativeCallerReason; retryable: boolean }
export type NativeCallerVerdict =
  | { kind: "admitted"; conversationId: string; proof: string }
  | ({ kind: "refused" } & NativeCallerRefusal);
export interface NativeSessionRecord {
  pid: number; sessionId: string; procStart: string; pidDomain: string; startedAt: number; kind: string;
}
export interface NativeAdmissionEvidence {
  home: string; pid: number; processIdentity: string; domain: string; sessionId: string; transcript: string;
  recordRevision: string; generationProof: string; conversationId: string; cwd: string; startedAt: number;
}
export type NativeRecordRead = { kind: "record"; value: unknown; revision?: string } | { kind: "missing" | "invalid" };
export interface NativeCallerSources {
  platform: string;
  ancestry(): readonly number[];
  isClaude(pid: number): boolean;
  hostStamp(pid: number): string | null;
  home(pid: number): string | null;
  accounts(): readonly { home: string; projectsDir: string }[];
  realpath(file: string): string | null;
  record(home: string, pid: number): NativeRecordRead;
  identity(pid: number): string | null;
  domain(pid: number): string | null;
  bootTime(): number | null;
  processStartedAt(pid: number): number | null;
  sessionHeldElsewhere(sessionId: string, pid: number): boolean;
  snapshot(): Pick<RegistrySnapshot, "conversations" | "entries">;
  generationProof(pid: number, transcript: string): string | null;
  association(evidence: NativeAdmissionEvidence): { status: "approved" | "waiting" | "refused"; proof: string };
  cwd(pid: number): string | null;
  hostStatus(identity: ProcessIdentity): ProcessIdentityStatus;
}

export function nativeCallerRefusal(reason: NativeCallerReason): NativeCallerVerdict & { kind: "refused" } {
  return { kind: "refused", reason, retryable: reason === "session-not-scanned" };
}

export function nativeSessionRecord(value: unknown, pid: number): NativeSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.pid !== pid || typeof record.sessionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.sessionId)
    || typeof record.procStart !== "string" || !/^\d+$/.test(record.procStart)
    || typeof record.pidDomain !== "string" || typeof record.kind !== "string"
    || typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return null;
  return record as unknown as NativeSessionRecord;
}

/** Every call revalidates the nearest native parent and its approved generation. */
export function resolveNativeCaller(sources: NativeCallerSources): NativeCallerVerdict {
  const refuse = nativeCallerRefusal;
  try {
    if (sources.platform !== "linux") return refuse("platform-unverified");
    const pid = sources.ancestry().slice(1).find((candidate) => sources.isClaude(candidate));
    if (!pid) return refuse("no-claude-ancestor");
    if (sources.hostStamp(pid) !== null) return refuse("foreign-host");
    const home = sources.home(pid);
    const realHome = home ? sources.realpath(home) : null;
    const account = realHome ? sources.accounts().find((candidate) => sources.realpath(candidate.home) === realHome) : null;
    if (!account || !realHome) return refuse("unknown-claude-home");
    const before = sources.identity(pid);
    const read = sources.record(realHome, pid);
    if (read.kind !== "record") return refuse(read.kind === "missing" ? "session-record-missing" : "session-record-invalid");
    const parsed = nativeSessionRecord(read.value, pid);
    const record = parsed ? { ...parsed } : null;
    if (!record) return refuse("session-record-invalid");
    if (record.kind !== "interactive") return refuse("session-kind");
    const expected = `${pid}:${record.procStart}`;
    if (!before || before !== expected || sources.identity(pid) !== before || !sources.ancestry().slice(1).includes(pid)) {
      return refuse("process-identity-mismatch");
    }
    const domain = sources.domain(pid);
    if (!domain || domain !== record.pidDomain) return refuse("domain-mismatch");
    const boot = sources.bootTime();
    const start = sources.processStartedAt(pid);
    if (boot === null || start === null || record.startedAt < boot || record.startedAt < start - 5_000) {
      return refuse("record-predates-process");
    }
    if (sources.sessionHeldElsewhere(record.sessionId, pid)) return refuse("session-held-twice");
    const snapshot = sources.snapshot();
    const matches = Object.values(snapshot.conversations).flatMap((conversation) => conversation.engine === "claude"
      ? conversation.generations.filter((generation) => generation.id === record.sessionId).map((generation) => ({ conversation, generation })) : []);
    if (!matches.length) return refuse("session-not-scanned");
    if (matches.length !== 1) return refuse("generation-ambiguous");
    const { conversation, generation } = matches[0]!;
    if (generation !== conversation.generations.at(-1) || generation.archivedAt !== null || conversation.supersededBy !== null
      || (conversation.migration && !["committed", "rolled-back", "failed-recoverable"].includes(conversation.migration.phase))) {
      return refuse("generation-not-current");
    }
    const transcript = sources.realpath(generation.path);
    const projects = sources.realpath(account.projectsDir);
    const relative = transcript && projects ? path.relative(projects, transcript) : null;
    if (!transcript || !relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.basename(transcript) !== `${record.sessionId}.jsonl`) return refuse("transcript-outside-home");
    for (const entry of Object.values(snapshot.entries)) {
      if (entry.artifactPath !== generation.path && sources.realpath(entry.artifactPath) !== transcript) continue;
      if ((entry.host && !entry.host.agent?.pid) || (entry.structuredHost && !entry.structuredHost.process?.pid)) {
        return refuse("generation-hosted");
      }
      for (const host of [entry.host?.agent, entry.structuredHost?.process]) {
        if (host?.pid && sources.hostStatus(host) !== "dead") return refuse("generation-hosted");
      }
    }
    const recordBytes = JSON.stringify(record);
    const generationProof = sources.generationProof(pid, transcript);
    if (!generationProof) return refuse("session-proof-unavailable");
    const stableSession = () => {
      const next = sources.record(realHome, pid);
      return next.kind === "record" && next.revision === read.revision
        && JSON.stringify(nativeSessionRecord(next.value, pid)) === recordBytes
        && sources.generationProof(pid, transcript) === generationProof;
    };
    // Recheck the session as well as its process after the registry read.
    if (!stableSession()) return refuse("session-changed");
    const cwd = sources.cwd(pid);
    if (!cwd || !read.revision) return refuse("session-proof-unavailable");
    let association: ReturnType<NativeCallerSources["association"]>;
    try {
      association = sources.association({ home: realHome, pid, processIdentity: expected, domain, sessionId: record.sessionId,
        transcript, recordRevision: read.revision, generationProof, conversationId: conversation.id, cwd, startedAt: start });
    } catch { return refuse("approval-unavailable"); }
    if (!stableSession()) return refuse("session-changed");
    if (sources.identity(pid) !== expected || !sources.ancestry().slice(1).includes(pid)) return refuse("process-identity-mismatch");
    if (association.status !== "approved") return refuse(association.status === "waiting" ? "approval-waiting" : "approval-refused");
    return { kind: "admitted", conversationId: conversation.id, proof: association.proof };
  } catch {
    return refuse("session-record-invalid");
  }
}

const REASONS: Record<NativeCallerReason, string> = {
  "session-changed": "The native session changed during verification. Nothing was admitted; repeat after the session settles and approve its new association.",
  "session-proof-unavailable": "A fresh native session proof is missing, stale or names another generation. Configure the synchronous Delegatus Claude hooks (https://github.com/Latand/delegatus/blob/main/docs/guide/mcp.md#approving-an-external-claude-session), then repeat with the original clientRequestId; otherwise continue under a Delegatus host.",
  "approval-waiting": "An association approval is waiting in Delegatus → Waiting for you → Decisions. Ask the operator to verify the engine, cwd, start time and transcript, then approve this generation and repeat with the original clientRequestId.",
  "approval-unavailable": "Delegatus could not read or record the association approval. Retry the original clientRequestId when Decisions is available, or continue under a Delegatus host.",
  "approval-refused": "The operator refused or revoked this generation's association. Continue under a Delegatus host.",
  "platform-unverified": "Native process evidence is verified only on Linux.",
  "no-claude-ancestor": "This MCP server has no eligible Claude Code parent; HTTP callers need a launch credential.",
  "capability-unresolved": "The presented Delegatus launch credential is unrecognised or malformed. Start the session from this Delegatus.",
  "capability-conflict": "The process and launch credential name different conversations.",
  "foreign-host": "The Claude parent carries a Delegatus host stamp that this installation cannot attribute.",
  "unknown-claude-home": "The Claude parent's config directory is not a known account home.",
  "session-record-missing": "The Claude parent's session record is missing. Restart Claude Code.",
  "session-record-invalid": "The Claude parent's session record could not be safely verified. Restart Claude Code.",
  "session-kind": "Only interactive Claude Code sessions support native admission.",
  "process-identity-mismatch": "The session record is stale or the parent changed during verification. Restart Claude Code.",
  "domain-mismatch": "The session record belongs to another machine or PID namespace.",
  "record-predates-process": "The session record predates this boot or process. Restart Claude Code.",
  "session-held-twice": "Two live processes name this session. Continue from a single session.",
  "session-not-scanned": "Delegatus has not scanned this session yet. Repeat with the same clientRequestId after the next inventory pass, about a minute.",
  "generation-ambiguous": "More than one registry generation names this session.",
  "generation-not-current": "This session is archived, superseded, migrating or no longer current.",
  "transcript-outside-home": "The session transcript is outside the matched account's projects directory.",
  "generation-hosted": "Delegatus already hosts this generation, or its host identity cannot be verified. Continue it there.",
};

export function nativeAdmissionMessage(admission?: NativeCallerRefusal): string {
  return `${admission ? `[${admission.reason}] ${REASONS[admission.reason]} ` : ""}A Claude Code session started outside Delegatus needs explicit operator approval for its live process and transcript generation. Otherwise open the conversation in Delegatus and continue it there under its host.`;
}
