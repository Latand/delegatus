import path from "node:path";

import type { AgentRegistry } from "@/lib/agent/registry";
type RegistrySnapshot = ReturnType<AgentRegistry["readOnlySnapshot"]>;
import type { ProcessIdentity, ProcessIdentityStatus } from "@/lib/processIdentity";

export type NativeCallerReason =
  | "platform-unverified" | "no-claude-ancestor" | "capability-unresolved" | "capability-conflict"
  | "foreign-host" | "unknown-claude-home" | "session-record-missing" | "session-record-invalid"
  | "session-kind" | "process-identity-mismatch" | "domain-mismatch" | "record-predates-process"
  | "session-held-twice" | "session-not-scanned" | "generation-ambiguous"
  | "generation-not-current" | "transcript-outside-home" | "generation-hosted";
export interface NativeCallerRefusal { reason: NativeCallerReason; retryable: boolean }
export type NativeCallerVerdict =
  | { kind: "admitted"; conversationId: string }
  | ({ kind: "refused" } & NativeCallerRefusal);
export interface NativeSessionRecord {
  pid: number; sessionId: string; procStart: string; pidDomain: string; startedAt: number; kind: string;
}
export type NativeRecordRead = { kind: "record"; value: unknown } | { kind: "missing" | "invalid" };
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

/** Every call proves its nearest native parent anew; cwd and caller claims are absent from these sources. */
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
    const record = nativeSessionRecord(read.value, pid);
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
      || (conversation.migration && !["committed", "rolled-back"].includes(conversation.migration.phase))) {
      return refuse("generation-not-current");
    }
    const transcript = sources.realpath(generation.path);
    const projects = sources.realpath(account.projectsDir);
    const relative = transcript && projects ? path.relative(projects, transcript) : null;
    if (!transcript || !relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.basename(transcript) !== `${record.sessionId}.jsonl`) return refuse("transcript-outside-home");
    for (const entry of Object.values(snapshot.entries)) {
      if (entry.artifactPath !== generation.path && sources.realpath(entry.artifactPath) !== transcript) continue;
      for (const host of [entry.host?.agent, entry.structuredHost?.process]) {
        if (host?.pid && sources.hostStatus(host) !== "dead") return refuse("generation-hosted");
      }
    }
    // Recheck after filesystem and registry reads, which can outlive the parent.
    if (sources.identity(pid) !== expected || !sources.ancestry().slice(1).includes(pid)) return refuse("process-identity-mismatch");
    return { kind: "admitted", conversationId: conversation.id };
  } catch {
    return refuse("session-record-invalid");
  }
}

const REASONS: Record<NativeCallerReason, string> = {
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
  return `${admission ? `[${admission.reason}] ${REASONS[admission.reason]} ` : ""}A Claude Code session started outside Delegatus is admitted automatically when this viewer MCP server runs over stdio as a child of Claude on Linux, and its sessions/<pid>.json record matches the live process and names a current conversation Delegatus has scanned and is not hosting. Otherwise open the conversation in Delegatus and continue it there under its host.`;
}
