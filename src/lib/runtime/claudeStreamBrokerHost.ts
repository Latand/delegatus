import { CLAUDE_NATIVE_INPUT_LIMIT, claudeNativeUuid, nativeBoundary, nativeTurnBoundary, nativeTurnBoundaryMember, nativeConsumed, nativeInput, nativeResult, nativeResultMembers, nativeTerminal, nativeUuids, sameNativeWriter,
  deliveryRecord, parseDeliveryRecords, replayClaudeDeliveries, sameNormalizedEntry, type ClaudeNativeTurnBoundary, type ClaudeNativeConsumed, type ClaudeNativeInput, type ClaudeNativeResult, type ClaudeNativeTerminal, type ClaudeNativeWriter } from "./claudeNativeDelivery";
import { assertReleasedHostEventLedger } from "./hostEventWindow";
import { releaseIdleHostEventWindow } from "./idleHostEventWindow";
import { heapAttribution } from "@/lib/heapAttribution";
import { repositoryPublicationSource } from "@/lib/git/repositoryCommitIdentity";
import { hostExitProcess, observeHostExit, readHostExit, recordHostStop, withHostStopOrigin } from "./hostExit";
import { nativeProcessId, signalDomain, signalAgentDomain, signalBoundaryOff, spawnManagedEngine } from "./agentSignalSandbox";
import { memoryField, memoryKillText } from "./agentMemoryState";
import { CLAUDE_CHILD_EXITED, claudeHostEndText, HOST_END_REASON_MAX_CHARS, type HostEndCause } from "./hostEndCause";
import type { AgentMemoryCell } from "./agentMemory";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { statePath } from "@/lib/configDir";
import { claudeQueuedPromptUser, isClaudeTurnWindowMeta } from "@/lib/claudeProtocolUser";
import { effectiveClaudePermissionMode } from "@/lib/agent/cli";
import { readClaudePermissionMode } from "@/lib/agent/claudePermissionMode";
import type { ProcessIdentity } from "@/lib/agent/registry";
import { applyClaudeSpawnPolicy, NATIVE_MULTI_AGENT_TOOLS, viewerMcpTransportForLaunch } from "@/lib/agent/spawnPolicy";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { engineMemoryOff } from "@/lib/memory/source";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { procBackend } from "@/lib/proc";
import { captureProcessTree, signalDetachedProcessGroup, type ProcessSignal, type ProcessTreeCapture } from "@/lib/processGroup";
import { STRUCTURED_HOST_STAMP_ENV, structuredHostStamp } from "@/lib/scanner/process";
import { hardenedRedact } from "@/lib/view/compactText";
import { claudeProviderForHome, readClaudeProviderRuntime, UnsafeClaudeHomeError } from "@/lib/accounts/claude";
import { startClaudeProviderRelay } from "./claudeProviderRelay";
import { providerCredentialRevision } from "@/lib/accounts/claudeProviderHealth";

import type {
  DeliveryReceipt,
  DeliveryTimingMark,
  DeliveryTimingObserver,
  EngineHost,
  HostState,
  NormalizedQueueEntry,
  ProviderRetryEvidence,
  QueueEntry,
  RuntimeCompactOutcome,
  RuntimeCompactRequest,
  RuntimeEvent,
} from "./engineHost";
import {
  normalizeQueueEntry,
  StructuredCompactError,
  StructuredDispatchDeferredError,
  StructuredHostAdoptionCleanupError,
} from "./engineHost";
import { attachRuntimeEvents, HostEventWindow, type RuntimeEventSubscriber } from "./hostEventWindow";
import {
  FileRuntimeEventStore,
  nextRuntimeEventSequence,
  reconcileRuntimeEventCursor,
  type RuntimeEventCursorRecoveryReporter,
  type RuntimeEventStore,
} from "./eventStore";
import { withAgentConfigSandbox } from "./agentConfigSandbox";
import { assertViewerMcpTools } from "./viewerMcpLaunch";
import { pendingPermissionFrom, pendingQuestionFrom, pendingToolUseFrom, type PendingPermissionRequest, type PendingQuestionRequest } from "./permissionRequests";
import { NATIVE_MULTI_AGENT_DENY_FLAG } from "./hostActivityFlags";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES, runtimeImageStore } from "./runtimeImageStore";
import { resolveTelegramLaunchGrant, TELEGRAM_UNAVAILABLE_THIS_RUN_NOTICE, type TelegramLaunchGrant } from "./telegramConnectorEnv";
import {
  STRUCTURED_IMAGE_CAPABILITY,
  normalizeStructuredImageMime,
  structuredContent,
  type StructuredImageRef,
} from "./structuredContent";

type JsonObject = Record<string, unknown>;
type Subscriber = RuntimeEventSubscriber;
type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;
type PendingControl = {
  resolve(value?: JsonObject): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  interruptTurnId: string | null;
};
type PendingDelivery = {
  promise: Promise<DeliveryReceipt>;
  resolve(receipt: DeliveryReceipt): void;
  reject(error: Error): void;
  /** Null while the input waits behind another turn in the CLI's own queue. */
  timer: ReturnType<typeof setTimeout> | null;
};
type PendingAnswer = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingCompaction = {
  promise: Promise<RuntimeCompactOutcome>;
  resolve(outcome: RuntimeCompactOutcome): void;
  reject(error: StructuredCompactError): void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export interface ClaudeDeliveryState {
  entry: NormalizedQueueEntry;
  disposition: "turn-started" | "queued-next-turn";
  delivered: boolean;
  queuedAt?: string;
  engineMessageId?: string | null;
  confirmation?: "operation-bound" | "inferred" | "unverified";
  native?: ClaudeNativeInput;
  nativeUnverified?: boolean;
  nativeNoWrite?: boolean;
  nativeResult?: ClaudeNativeResult;
  nativeTerminal?: ClaudeNativeTerminal;
  nativeTurnBoundary?: ClaudeNativeTurnBoundary;
  nativeConsumed?: ClaudeNativeConsumed;
  /** Scalar replay checks survive releasing a closed/zero-byte payload. */
  nativeReplayShape?: { textDigest: string; imageCount: number };
}

export type ClaudeDeliveryConfirmation = "accepted" | "already-confirmed" | "refused";

export interface ClaudeDeliveryLedger {
  load(sessionId: string): ClaudeDeliveryState[];
  loadDurable?(sessionId: string, seedNativeCache?: boolean): Promise<ClaudeDeliveryState[]>;
  recordNativeIntent?(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"], input: ClaudeNativeInput): Promise<void>;
  recordNativeTurnBoundary?(sessionId: string, evidence: ClaudeNativeTurnBoundary): Promise<ClaudeDeliveryConfirmation>;
  recordNativeTerminal?(sessionId: string, evidence: ClaudeNativeTerminal): Promise<ClaudeDeliveryConfirmation>;
  recordNativeConsumed?(sessionId: string, evidence: ClaudeNativeConsumed): Promise<ClaudeDeliveryConfirmation>;
  confirmNativeResult?(sessionId: string, proof: ClaudeNativeResult): Promise<ClaudeDeliveryConfirmation>;
  recordNativeNoWrite?(sessionId: string, entryId: string, inputUuid: string): Promise<void>;
  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void;
  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null, confirmation?: "operation-bound" | "inferred"): ClaudeDeliveryConfirmation;
}

export type ClaudeDeliveryRecord =
  | { kind: "native-turn-boundary"; evidence: ClaudeNativeTurnBoundary }
  | { kind: "native-terminal"; evidence: ClaudeNativeTerminal }
  | { kind: "native-consumed"; evidence: ClaudeNativeConsumed }
  | { kind: "native-result"; proof: ClaudeNativeResult }
  | { kind: "native-no-write"; entryId: string; inputUuid: string }
  | { kind: "queued"; entry: NormalizedQueueEntry; disposition: ClaudeDeliveryState["disposition"]; queuedAt: string; native?: unknown }
  | { kind: "delivered"; entryId: string; engineMessageId: string | null; deliveredAt: string; confirmation?: "operation-bound" | "inferred" | "unverified" };

export class FileClaudeDeliveryLedger implements ClaudeDeliveryLedger {
  constructor(private readonly directory = statePath("claude-delivery-ledger")) {}

  load(sessionId: string): ClaudeDeliveryState[] {
    return replayClaudeDeliveries(this.readRecords(sessionId), sessionId);
  }

  /** A concurrently visible line can precede the writer's fsync. Positive
   * readers establish durability on the same descriptor they read. */
  async loadDurable(sessionId: string, seedNativeCache = false): Promise<ClaudeDeliveryState[]> {
    const file = await fs.promises.open(this.filename(sessionId), "r").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!file) { if (seedNativeCache) this.rememberNativeStates(sessionId, []); return []; }
    try {
      const states = replayClaudeDeliveries(parseDeliveryRecords(await file.readFile("utf8")), sessionId);
      if (states.some(state => state.nativeResult || state.nativeTerminal || state.nativeTurnBoundary || state.nativeConsumed?.turnId)) await file.sync();
      if (seedNativeCache) this.rememberNativeStates(sessionId, states);
      return states;
    } finally { await file.close(); }
  }

  private readonly nativeSessions = new Map<string, ClaudeDeliveryState[]>();
  // Fixed-size negative lookup filter. A possible historical hit is always
  // resolved from the durable ledger; collisions grant no authority.
  private readonly nativeHistory = new Map<string, Uint8Array>();
  private nativeWriting: Promise<unknown> = Promise.resolve();

  private serializeNative<T>(action: () => Promise<T>): Promise<T> {
    const next = this.nativeWriting.then(action);
    this.nativeWriting = next.catch(() => {});
    return next;
  }

  private nativeKeys(state: ClaudeDeliveryState): string[] {
    return [state.entry.id, state.native?.inputUuid, state.engineMessageId,
      state.nativeResult?.resultUuid, state.nativeTerminal?.resultUuid, state.nativeTurnBoundary?.resultUuid]
      .filter((key): key is string => Boolean(key));
  }

  private historyBits(key: string): number[] {
    const hash = crypto.createHash("sha256").update(key).digest();
    return [0, 4, 8].map(offset => hash.readUInt32LE(offset) % (8192 * 8));
  }

  private async nativeStates(sessionId: string, lookup: readonly string[] = []): Promise<ClaudeDeliveryState[]> {
    if (!this.nativeSessions.has(sessionId)) await this.loadDurable(sessionId, true);
    const cached = this.nativeSessions.get(sessionId)!;
    const history = this.nativeHistory.get(sessionId)!;
    const historical = lookup.some(key => !cached.some(state => this.nativeKeys(state).includes(key))
      && this.historyBits(key).every(bit => (history[bit >> 3]! & 1 << (bit & 7)) !== 0));
    return historical ? this.loadDurable(sessionId) : cached;
  }

  private rememberNativeStates(sessionId: string, states: ClaudeDeliveryState[]): void {
    if (!this.nativeSessions.has(sessionId) && this.nativeSessions.size >= 8) {
      const oldest = this.nativeSessions.keys().next().value!;
      this.nativeSessions.delete(oldest); this.nativeHistory.delete(oldest);
    }
    const history = this.nativeHistory.get(sessionId) ?? new Uint8Array(8192);
    for (const state of states) for (const key of this.nativeKeys(state)) for (const bit of this.historyBits(key)) {
      history[bit >> 3] = history[bit >> 3]! | 1 << (bit & 7);
    }
    this.nativeHistory.set(sessionId, history);
    this.nativeSessions.set(sessionId, states.filter(state => state.native
      && !state.nativeResult && !state.nativeTerminal && !state.nativeTurnBoundary && !state.nativeNoWrite)
      .map(state => ({ ...state, entry: settledDeliveryEntry(state.entry) })));
  }

  async recordNativeIntent(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"], input: ClaudeNativeInput): Promise<void> {
    return this.serializeNative(async () => {
      const normalized = normalizeQueueEntry(entry);
      const parsed = nativeInput(input);
      if (!parsed || parsed.sessionId !== sessionId) throw new Error("Claude native input binding is invalid");
      const states = await this.nativeStates(sessionId, [entry.id, parsed.inputUuid]);
      const existing = states.find(row => row.entry.id === entry.id);
      if (existing) {
        if (!sameNormalizedEntry(existing.entry, normalized) || !existing.native || existing.native.inputUuid !== parsed.inputUuid
          || !existing.nativeNoWrite && JSON.stringify(existing.native) !== JSON.stringify(parsed)) throw new Error("Claude native input allocation conflicts");
        if (!existing.nativeNoWrite) return;
      }
      if (states.some(row => row.entry.id !== entry.id && (row.native?.inputUuid === parsed.inputUuid || row.delivered && row.engineMessageId === parsed.inputUuid))) {
        throw new Error("Claude native input identity is already allocated");
      }
      if (states.filter(state => state.native && !state.nativeResult && !state.nativeTerminal && !state.nativeTurnBoundary && !state.nativeNoWrite).length >= CLAUDE_NATIVE_INPUT_LIMIT) {
        throw new Error("Claude native active input capacity is exhausted");
      }
      const row: ClaudeDeliveryRecord = { kind: "queued", entry: normalized, disposition, queuedAt: new Date().toISOString(), native: parsed };
      await this.appendNative(sessionId, row);
      if (existing) {
        existing.native = parsed; existing.nativeNoWrite = false; existing.disposition = disposition;
        states.splice(states.indexOf(existing), 1); states.push(existing);
      }
      else states.push({ entry: settledDeliveryEntry(normalized), disposition, queuedAt: row.queuedAt, delivered: false, native: parsed });
      this.rememberNativeStates(sessionId, states);
    });
  }

  async recordNativeTurnBoundary(sessionId: string, value: ClaudeNativeTurnBoundary): Promise<ClaudeDeliveryConfirmation> {
    return this.serializeNative(async () => {
      const proof = nativeTurnBoundary(value);
      if (!proof || proof.sessionId !== sessionId) return "refused";
      const states = await this.nativeStates(sessionId, [proof.resultUuid]);
      const prior = states.find(state => state.nativeTurnBoundary?.resultUuid === proof.resultUuid)?.nativeTurnBoundary;
      if (prior) return JSON.stringify(prior) === JSON.stringify(proof) ? "already-confirmed" : "refused";
      if (states.some(state => state.nativeResult?.resultUuid === proof.resultUuid || state.nativeTerminal?.resultUuid === proof.resultUuid)) return "refused";
      const state = nativeTurnBoundaryMember(states, proof);
      if (!state || state.nativeTurnBoundary) return "refused";
      await this.appendNative(sessionId, { kind: "native-turn-boundary", evidence: proof });
      state.nativeTurnBoundary = proof;
      this.rememberNativeStates(sessionId, states);
      return "accepted";
    });
  }

  async recordNativeTerminal(sessionId: string, value: ClaudeNativeTerminal): Promise<ClaudeDeliveryConfirmation> {
    return this.serializeNative(async () => {
      const evidence = nativeTerminal(value);
      if (!evidence || evidence.sessionId !== sessionId) return "refused";
      const states = await this.nativeStates(sessionId, [evidence.resultUuid, ...evidence.inputUuids]);
      const prior = states.find(state => state.nativeTerminal?.resultUuid === evidence.resultUuid)?.nativeTerminal;
      if (prior) return JSON.stringify(prior) === JSON.stringify(evidence) ? "already-confirmed" : "refused";
      if (states.some(state => state.nativeResult?.resultUuid === evidence.resultUuid || state.nativeTurnBoundary?.resultUuid === evidence.resultUuid)) return "refused";
      const attempted = nativeResultMembers(states, { ...evidence, status: "completed" });
      if (!attempted || attempted.some(row => row.nativeNoWrite)) return "refused";
      await this.appendNative(sessionId, { kind: "native-terminal", evidence });
      await this.retireNativeImageRefs(sessionId, attempted.filter(state => state.delivered));
      for (const state of attempted) { state.nativeTerminal = evidence; state.entry = settledDeliveryEntry(state.entry); }
      this.rememberNativeStates(sessionId, states);
      return "accepted";
    });
  }

  async recordNativeConsumed(sessionId: string, value: ClaudeNativeConsumed): Promise<ClaudeDeliveryConfirmation> {
    return this.serializeNative(async () => {
      const evidence = nativeConsumed(value);
      if (!evidence || evidence.sessionId !== sessionId) return "refused";
      const states = await this.nativeStates(sessionId, [evidence.entryId]);
      const state = states.find(row => row.entry.id === evidence.entryId);
      if (!state?.native || !sameNativeWriter(state.native, evidence) || state.native.inputUuid !== evidence.inputUuid
        || state.entry.contentDigest !== evidence.contentDigest || state.nativeNoWrite
        || evidence.turnId !== null && state.disposition !== "turn-started") return "refused";
      if (state.nativeConsumed) return JSON.stringify(state.nativeConsumed) === JSON.stringify(evidence) ? "already-confirmed" : "refused";
      await this.appendNative(sessionId, { kind: "native-consumed", evidence });
      state.nativeConsumed = evidence;
      state.engineMessageId = evidence.canonicalUuid;
      if (evidence.turnId) { state.delivered = true; state.confirmation = "operation-bound"; }
      this.rememberNativeStates(sessionId, states);
      return "accepted";
    });
  }

  async confirmNativeResult(sessionId: string, value: ClaudeNativeResult): Promise<ClaudeDeliveryConfirmation> {
    return this.serializeNative(async () => {
      const proof = nativeResult(value);
      if (!proof || proof.sessionId !== sessionId) return "refused";
      const states = await this.nativeStates(sessionId, [proof.resultUuid, ...proof.inputUuids]);
      const prior = states.find(state => state.nativeResult?.resultUuid === proof.resultUuid)?.nativeResult;
      if (prior) return JSON.stringify(prior) === JSON.stringify(proof) ? "already-confirmed" : "refused";
      if (states.some(state => state.nativeTerminal?.resultUuid === proof.resultUuid || state.nativeTurnBoundary?.resultUuid === proof.resultUuid)) return "refused";
      const members = nativeResultMembers(states, proof);
      if (!members || members.some(row => row.nativeNoWrite)) return "refused";
      // One fsynced record carries the entire batch. A cut cannot confirm only
      // some members and forget the others on replay.
      await this.appendNative(sessionId, { kind: "native-result", proof });
      await this.retireNativeImageRefs(sessionId, members);
      for (const state of members) {
        state.nativeResult = proof;
        state.delivered = true;
        state.confirmation = "operation-bound";
        state.entry = settledDeliveryEntry(state.entry);
      }
      this.rememberNativeStates(sessionId, states);
      return "accepted";
    });
  }

  async recordNativeNoWrite(sessionId: string, entryId: string, inputUuid: string): Promise<void> {
    return this.serializeNative(async () => {
      const states = await this.nativeStates(sessionId, [entryId]);
      const state = states.find(row => row.entry.id === entryId);
      if (!state?.native || state.native.inputUuid !== inputUuid || state.nativeResult || state.nativeTerminal || state.nativeTurnBoundary || state.nativeConsumed) throw new Error("Claude native no-write binding conflicts");
      await this.appendNative(sessionId, { kind: "native-no-write", entryId, inputUuid });
      state.nativeNoWrite = true;
      state.entry = settledDeliveryEntry(state.entry);
      this.rememberNativeStates(sessionId, states);
    });
  }

  private async retireNativeImageRefs(sessionId: string, members: readonly ClaudeDeliveryState[]): Promise<void> {
    // Existing image reachability reads queued/delivered pairs. Only a closed,
    // proven input receives its normal retirement timestamp. A failed optional
    // marker retains the image; the fsynced native proof keeps its authority.
    for (const state of members) {
      try { await this.appendNative(sessionId, { kind: "delivered", entryId: state.entry.id,
        engineMessageId: state.engineMessageId ?? null, deliveredAt: new Date().toISOString(), confirmation: "operation-bound" }); }
      catch { return; }
    }
  }

  private async appendNative(sessionId: string, record: ClaudeDeliveryRecord): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await fs.promises.open(this.filename(sessionId), "a+", 0o600);
    try {
      await file.chmod(0o600);
      const size = (await file.stat()).size;
      if (size) {
        const tail = Buffer.alloc(1);
        await file.read(tail, 0, 1, size - 1);
        // A torn append is uncertain. Do not put a new intent behind it.
        if (tail[0] !== 10) throw new Error("Claude native ledger has an unresolved partial record");
      }
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync();
    } finally { await file.close(); }
  }

  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void {
    const normalized = normalizeQueueEntry(entry);
    const existing = this.load(sessionId).find((state) => state.entry.id === normalized.id);
    if (existing) {
      if (!sameQueueEntry(existing.entry, normalized)) {
        throw new Error("Claude delivery ledger entry id belongs to a different payload");
      }
      return;
    }
    this.append(sessionId, { kind: "queued", entry: normalized, disposition, queuedAt: new Date().toISOString() });
  }

  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null, confirmation: "operation-bound" | "inferred" = "operation-bound"): ClaudeDeliveryConfirmation {
    const states = this.load(sessionId);
    const state = states.find((candidate) => candidate.entry.id === entryId);
    if (!state || state.native || state.nativeUnverified
      || confirmation === "inferred" && states.some(candidate => candidate.nativeUnverified)
      || engineMessageId && states.some(candidate => candidate.native?.inputUuid === engineMessageId)) return "refused";
    if (state.delivered && state.confirmation !== "unverified") {
      return state.engineMessageId === engineMessageId ? "already-confirmed" : "refused";
    }
    if (state.delivered && state.engineMessageId !== engineMessageId) return "refused";
    if (engineMessageId && this.load(sessionId).some((candidate) => candidate.delivered
      && candidate.engineMessageId === engineMessageId && candidate.entry.id !== entryId)) return "refused";
    this.append(sessionId, { kind: "delivered", entryId, engineMessageId, deliveredAt: new Date().toISOString(), confirmation });
    const allocation = this.load(sessionId).find((candidate) => candidate.entry.id === entryId);
    if (!allocation?.delivered || allocation.engineMessageId !== engineMessageId
      || allocation.confirmation === "unverified") return "refused";
    return "accepted";
  }

  private readRecords(sessionId: string): ClaudeDeliveryRecord[] {
    let contents: string;
    try { contents = fs.readFileSync(this.filename(sessionId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseDeliveryRecords(contents);
  }

  private append(sessionId: string, record: ClaudeDeliveryRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(sessionId);
    const fd = fs.openSync(filename, "a+", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      repairJsonlTail(fd, filename, deliveryRecord);
      writeAllSync(fd, Buffer.from(`${JSON.stringify(record)}\n`));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      this.nativeSessions.delete(sessionId);
      this.nativeHistory.delete(sessionId);
    }
  }

  private filename(sessionId: string): string {
    return path.join(this.directory, `${encodeURIComponent(sessionId)}.jsonl`);
  }
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  version?: string | null;
}

export interface ClaudeSessionIdentity { sessionId: string }

export interface ClaudeStreamBrokerHostOptions {
  memoryQueuePath?: string;
  /** Reserved admission request. This evidence-only slice keeps it contained. */
  nativeQueuedSend?: boolean;
  cwd: string;
  sessionId?: string;
  claudeConfigDir?: string;
  claudeProjectsDir?: string;
  spawnPolicyBaseSettingsPath?: string | null;
  allowSubagents?: boolean;
  /** Seats ask operator decisions through Delegatus forms. Workers keep native tools. */
  operatorDecisionForms?: boolean;
  /** No automatic memory: no shared-memory hook and Claude's auto memory off. */
  cleanMemory?: boolean;
  appendSystemPrompt?: string;
  mcpServers?: string[];
  validateTelegramGrant?: () => void;
  mcpStatePath?: string;
  readOnly?: boolean;
  /** Confine tools and network to Claude's engine-owned restricted boundary. */
  restricted?: boolean;
  binary?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permissionMode?: string;
  tools?: string[];
  env?: NodeJS.ProcessEnv;
  /** Only the resolved provider account may forward its Anthropic endpoint. */
  providerAccount?: boolean;
  forwardGitHubConfig?: boolean;
  releaseCleanup?: () => void;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  onEventCursorRecovery?: RuntimeEventCursorRecoveryReporter;
  memoryCell?: AgentMemoryCell | null;
  /** Rechecked at native exec admission and after asynchronous preparation. */
  assertCurrent?: () => void;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  signalProcess?: ProcessSignal;
  processIdentity?: (pid: number) => string | null;
  /** Reads the processes the child started, before its first stop signal. */
  captureProcessTree?: (root: number) => ProcessTreeCapture;
  /** How long a failed host waits before it reads its child's tree again
      when the last read could not be recorded whole. */
  terminationCaptureRetryMs?: number;
  readAuthStatus?: () => ClaudeAuthStatus | Promise<ClaudeAuthStatus>;
  readTranscript?: (cwd: string, sessionId: string) => ClaudeTranscriptUser[];
  compactEvidenceTimeoutMs?: number;
  eventStore?: RuntimeEventStore;
  deliveryLedger?: ClaudeDeliveryLedger;
  readImage?: (ref: StructuredImageRef) => Buffer;
}

export interface ClaudeTranscriptUser {
  sessionId?: string | null;
  mergedSendUuids?: string[];
  prompt?: boolean;
  nativeIdentityInvalid?: boolean;
  text: string;
  contentDigest?: string;
  imageCount?: number;
  uuid: string | null;
  timestamp: string | null;
}

const CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  /* Explicit opt-in for Claude's bypass-permissions mode under container root. */
  "IS_SANDBOX",
  "LLV_SPAWN_CAPABILITY",
  "LLV_EVIDENCE_DIR",
  "LLV_GATE_CPU_PRIORITY_SOURCE",
  /* Where Claude Code writes background-task output. A pipeline stage runs
     with TMPDIR in its scratch directory and this pinned to the temp root the
     Viewer scans for those tasks (#1957). */
  "CLAUDE_CODE_TMPDIR",
  /* The re-hosted Viewer MCP launcher resolves the current release and the
     runtime host's stable listener from these non-secret inputs. */
  "LLV_STATE_DIR", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_PORT",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_CAPTURE_RETRY_MS = 1_000;

/** Records the tree a stop read, and true only once it is durable (#2790). */
export type TerminationCaptureListener = (root: number, tree: readonly ProcessIdentity[]) => boolean | Promise<boolean>;

export { claudeHostEndText };

/** What pending work is told when a release cannot prove its child ended:
    the process may still be running, so nothing says it was released (#2790). */
export const CLAUDE_RELEASE_UNCONFIRMED =
  "Claude stream host is stopping and could not confirm that the Claude process stopped";

/** Why a stop sent nothing: the processes the child started could not all be
    named and recorded, and a signal then could leave one nothing can find. */
export const CLAUDE_TREE_UNCAPTURED =
  "Claude child's process tree could not be recorded, so nothing was signalled";

/** The command this control types into the conversation (#1214). */
export const CLAUDE_COMPACT_COMMAND = "/compact";

/**
 * The durable receipt reason for a compaction that was sent and never
 * witnessed. It is a machine token like every other receipt reason
 * (`busy-turn`, `stale-generation`, …) so the strip can say it in both
 * languages: "sent — completion could not be confirmed". It is an outcome, not
 * a failure to act: the operator asked for the command and the command went.
 */
export const CLAUDE_COMPACT_UNOBSERVED_REASON = "compact-sent-unobserved";

/**
 * The durable receipt reason for a `/compact` the engine handled and declined.
 * The CLI answers the command with a `result` frame once it is done with it,
 * and that frame belongs to no turn — the compaction takes no turn slot. A
 * boundary always precedes it when there was one to emit, so a `result` with
 * no boundary behind it is the engine saying it compacted nothing ("Error: No
 * messages to compact" is the everyday case). Waiting out the evidence budget
 * for a boundary the engine already declined to write would be a silent wait,
 * so this terminalizes at once.
 */
export const CLAUDE_COMPACT_DECLINED_REASON = "compact-declined";

/** How long a compaction may run before its outcome counts as unobservable.
    Compaction re-reads the whole thread through the model — a manual one
    observed locally took ~2.5 minutes — so the budget is generous. */
const DEFAULT_COMPACT_EVIDENCE_TIMEOUT_MS = 5 * 60_000;

/* The flag itself lives beside the classifier that has to recognise it as an
   advertisement rather than as activity (#747); re-exported here because this
   is the host that raises it. */
export { NATIVE_MULTI_AGENT_DENY_FLAG };
const MAX_REPLAY_ENVELOPE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = MAX_STRUCTURED_IMAGE_ENCODED_BYTES + MAX_REPLAY_ENVELOPE_BYTES;

/** Bounded tail kept only long enough to match a terminal exit signature. */
const TERMINAL_EXIT_MATCH_BYTES = 512;

/** CLI exits that mean this launch can never start, whatever retries it gets.
    A resume of a session the CLI never created is the incident case (#1071):
    the child prints this and exits before the broker delivers anything. */
const TERMINAL_CLI_EXIT_SIGNATURES: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /no conversation found with session id/i,
    reason: "the Claude CLI found no conversation with this session id",
  },
  {
    pattern: /--dangerously-skip-permissions cannot be used with root\/sudo privileges/i,
    reason: "the Claude CLI refused bypass permissions under root; set IS_SANDBOX=1 in the container environment or run as a non-root user",
  },
];

/** The canonical phrase for a terminal CLI exit, or null when the diagnostic
    is not one. The caller's text never reaches a durable receipt. */
export function terminalClaudeExitReason(diagnostic: string): string | null {
  return TERMINAL_CLI_EXIT_SIGNATURES.find((signature) => signature.pattern.test(diagnostic))?.reason ?? null;
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

/** Two normalized entries carry the same payload: what a resend is compared by. */
/** A delivery the engine has confirmed keeps only what a resend is compared
    by and what its echo reports. Its message stays in the delivery ledger on
    disk; the host kept every message body it had ever sent. */
function settledDeliveryEntry(entry: NormalizedQueueEntry): NormalizedQueueEntry {
  return {
    id: entry.id,
    content: { text: "", images: [] },
    contentDigest: entry.contentDigest,
    ...(entry.expectedTurnId !== undefined ? { expectedTurnId: entry.expectedTurnId } : {}),
    ...(entry.parts ? { parts: entry.parts } : {}),
  };
}

function nativeReplayShape(entry: NormalizedQueueEntry): ClaudeDeliveryState["nativeReplayShape"] {
  return entry.content.images.length ? { imageCount: entry.content.images.length,
    textDigest: crypto.createHash("sha256").update(entry.content.text).digest("hex") } : undefined;
}

function sameQueueEntry(left: QueueEntry, right: QueueEntry): boolean {
  const normalizedLeft = normalizeQueueEntry(left);
  const normalizedRight = normalizeQueueEntry(right);
  return normalizedLeft.id === normalizedRight.id
    && normalizedLeft.contentDigest === normalizedRight.contentDigest
    && normalizedLeft.expectedTurnId === normalizedRight.expectedTurnId
    && JSON.stringify(normalizedLeft.parts) === JSON.stringify(normalizedRight.parts);
}

function repairJsonlTail<T>(fd: number, filename: string, validate: (value: unknown) => T | null): void {
  const size = fs.fstatSync(fd).size;
  if (size === 0) return;
  const contents = fs.readFileSync(filename, "utf8");
  if (contents.endsWith("\n")) return;
  const boundary = contents.lastIndexOf("\n") + 1;
  const tail = contents.slice(boundary);
  let parsed: unknown;
  try { parsed = JSON.parse(tail); } catch { parsed = null; }
  if (validate(parsed)) fs.writeSync(fd, "\n");
  else fs.ftruncateSync(fd, Buffer.byteLength(contents.slice(0, boundary)));
}

function writeAllSync(fd: number, buffer: Uint8Array): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = fs.writeSync(fd, buffer, offset, buffer.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("Claude delivery ledger write made no progress");
    }
    offset += written;
  }
}

export function redactClaudeHostDiagnostic(value: unknown): string {
  return hardenedRedact(value instanceof Error ? value.message : String(value))
    .replace(/(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 500);
}

const safeError = redactClaudeHostDiagnostic;

function subscriptionEnv(
  source: NodeJS.ProcessEnv,
  claudeConfigDir?: string,
  forwardGitHubConfig = false,
  providerAccount = false,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  for (const name of CHILD_ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  if (forwardGitHubConfig && source.GH_CONFIG_DIR !== undefined) env.GH_CONFIG_DIR = source.GH_CONFIG_DIR;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  if (providerAccount) {
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"] as const) {
      if (source[name] !== undefined) env[name] = source[name];
    }
    if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_MODEL) throw new Error("Claude provider account is incomplete");
  }
  /* The commands this agent runs resolve their own config and state root, not
     the operator's (#1905). The account home above and the Viewer MCP server's
     own environment are what keep pointing at the real installation. */
  withAgentConfigSandbox(env, source, claudeConfigDir);
  /* Provenance the resources rail can verify later: a process wearing this
     command line is only ever treated as the viewer's host — and only ever
     killable from the rail — when it carries this viewer's stamp (#1199). */
  env[STRUCTURED_HOST_STAMP_ENV] = structuredHostStamp();
  return env;
}

const MAX_AUTH_PROBE_STDOUT_BYTES = 1024 * 1024;

/* The auth probe runs on the Viewer request loop while other structured
   launches, runtime-socket calls, and broker stdout pumps share it. It must
   never block the event loop: production #367 saw four simultaneous Claude
   launches starve each other's 3s runtime-host calls into "runtime host
   request timed out" behind synchronous CLI probes. */
function claudeCliProbe(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_AUTH_PROBE_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.on("data", () => { /* Provider diagnostics may contain credentials. */ });
    child.on("error", (error) => reject(new Error(`Claude subscription authentication probe failed: ${safeError(error)}`)));
    child.on("close", (code) => resolve({ status: code, stdout }));
  });
}

export async function claudeCliAuthStatus(binary: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ClaudeAuthStatus> {
  const result = await claudeCliProbe(binary, ["auth", "status"], cwd, env);
  if (result.status !== 0) throw new Error("Claude subscription authentication check failed");
  let value: JsonObject | null = null;
  try { value = record(JSON.parse(result.stdout)); } catch { /* handled below */ }
  if (!value) throw new Error("Claude subscription authentication status was invalid");
  const versionResult = await claudeCliProbe(binary, ["--version"], cwd, env);
  const version = versionResult.status === 0 ? versionResult.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null : null;
  return {
    loggedIn: value.loggedIn === true,
    authMethod: typeof value.authMethod === "string" ? value.authMethod : null,
    subscriptionType: typeof value.subscriptionType === "string" ? value.subscriptionType : null,
    version,
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => stringField(part, "text") ?? "").join("");
}

function userText(message: JsonObject): string {
  return textContent(record(message.message)?.content);
}

function messageContent(message: JsonObject): ReturnType<typeof structuredContent> | null {
  const blocks = record(message.message)?.content;
  if (typeof blocks === "string") return blocks.trim() ? structuredContent(blocks, []) : null;
  if (!Array.isArray(blocks)) return null;
  const images: StructuredImageRef[] = [];
  let text = "";
  for (const block of blocks) {
    const item = record(block);
    if (item?.type === "text" && typeof item.text === "string") {
      text += item.text;
      continue;
    }
    if (item?.type !== "image") continue;
    const source = record(item.source);
    const mime = typeof source?.media_type === "string" ? normalizeStructuredImageMime(source.media_type) : null;
    if (source?.type !== "base64" || !mime || typeof source.data !== "string") return null;
    const data = Buffer.from(source.data, "base64");
    if (!data.length || data.toString("base64") !== source.data) return null;
    images.push({
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      mime,
      bytes: data.byteLength,
    });
  }
  try { return structuredContent(text, images); } catch { return null; }
}

function matchesClaudeUserContent(
  entry: NormalizedQueueEntry,
  observed: { contentDigest: string; text: string; imageCount: number },
): boolean {
  if (entry.contentDigest === observed.contentDigest) return true;
  return entry.content.images.length > 0
    && observed.imageCount === entry.content.images.length
    && observed.text === entry.content.text;
}

function sanitizedUserReplay(
  message: JsonObject,
  content: ReturnType<typeof structuredContent> | null,
): JsonObject {
  const providerMessage = record(message.message) ?? {};
  const sanitizedBlocks: JsonObject[] = content
    ? content.content.images.map((image) => ({
        type: "image",
        source: {
          type: "runtime_ref",
          sha256: image.sha256,
          media_type: image.mime,
          bytes: image.bytes,
        },
      }))
    : [];
  const text = content?.content.text ?? userText(message);
  if (text) sanitizedBlocks.push({ type: "text", text });
  /* Tool results keep only their identity and outcome (issue #1100): the live
     turn marks the matching `tool_use` row finished/failed from this, while the
     result body itself stays in the transcript. */
  const blocks = record(message.message)?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const result = record(block);
      const toolUseId = stringField(result, "tool_use_id");
      if (result?.type !== "tool_result" || !toolUseId) continue;
      sanitizedBlocks.push({
        type: "tool_result",
        tool_use_id: toolUseId,
        ...(result.is_error === true ? { is_error: true } : {}),
      });
    }
  }
  return {
    ...message,
    ...(content ? { contentDigest: content.contentDigest } : {}),
    message: { ...providerMessage, content: sanitizedBlocks },
  };
}

function defaultTranscriptUsers(cwd: string, sessionId: string, projectsRoot?: string): ClaudeTranscriptUser[] {
  return readClaudeTranscriptUsers(claudeTranscriptPath(cwd, sessionId, projectsRoot));
}

/** Canonical user records shared by adoption and delivery settlement. */
export function readClaudeTranscriptUsers(filename: string): ClaudeTranscriptUser[] {
  let contents: string;
  try { contents = fs.readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const users: ClaudeTranscriptUser[] = [];
  const seen = new Set<string>();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    let value: JsonObject | null = null;
    try { value = record(JSON.parse(line)); } catch { continue; }
    if (value) {
      const queued = claudeQueuedPromptUser(value);
      if (queued) value = { ...value, ...queued, uuid: queued.uuid };
    }
    if (value?.type !== "user" || record(value.message)?.role !== "user") continue;
    const content = messageContent(value);
    const prompt = content !== null && !isClaudeTurnWindowMeta(value) && value.isSidechain !== true && value.parent_tool_use_id == null && value.agent_id == null && value.isCompactSummary !== true
        && !(Array.isArray(record(value.message)?.content) && (record(value.message)!.content as unknown[]).some(block => record(block)?.type === "tool_result"));
    const user: ClaudeTranscriptUser = {
      text: userText(value),
      sessionId: stringField(value, "sessionId") ?? stringField(value, "session_id"),
      prompt,
      ...(value.mergedSendUuids !== undefined && (!nativeUuids(value.mergedSendUuids)
        || (value.mergedSendUuids as unknown[]).includes(value.uuid)) ? { nativeIdentityInvalid: true } : {}),
      ...(nativeUuids(value.mergedSendUuids) ? { mergedSendUuids: nativeUuids(value.mergedSendUuids)! } : {}),
      ...(content ? { contentDigest: content.contentDigest } : {}),
      ...(content ? { imageCount: content.content.images.length } : {}),
      uuid: stringField(value, "uuid"),
      timestamp: stringField(value, "timestamp"),
    };
    // One input can have both an attachment and a user record. Allocate its
    // engine UUID once, retaining the first observation. Content matching
    // already accepts equal text and image counts across image transcoding.
    const identity = user.uuid ? JSON.stringify([user.uuid, user.text, user.imageCount]) : null;
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    users.push(user);
  }
  return users;
}

const CLAUDE_BACKGROUND_TURN_PREFIX = "claude-background:";

/** One durable writer around a long-lived Claude stream-json process. */
export class ClaudeStreamBrokerHost implements EngineHost {
  readonly supportsSteer = false;
  // Admission remains contained for this evidence slice. Enabling two pending
  // writes also requires the queue/admission and full native acceptance slice.
  readonly supportsQueuedSend = false;
  readonly coalescesQueuedInput = true;
  // Claude Code answers an interrupt during a tool call by rejecting that tool
  // use ("The user doesn't want to proceed with this tool use. ... STOP what
  // you are doing"), so an ordinary message that interrupted would reach the
  // model as a refusal. It waits for the turn; the Stop control still interrupts.
  readonly sendWaitsForRunningTurn = true;
  // The CLI reads an input written during a turn at the next tool boundary and
  // echoes it before that turn's result. The existing one-pending join remains
  // bounded; native queued echoes retain unresolved terminal ownership.
  get acceptsInputDuringTurn(): boolean { return !this.nativeUncertain; }
  readonly identity: ClaudeSessionIdentity;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly memoryQueuePath?: string;
  private readonly eventTranscriptPath: string;
  private readonly eventStore: RuntimeEventStore;
  private readonly deliveryLedger: ClaudeDeliveryLedger;
  private readonly nativeWriter: ClaudeNativeWriter | null;
  private nativeWork: Promise<unknown> = Promise.resolve();
  private nativeWorkCount = 0;
  private nativeQueuedBytes = 0;
  private nativeBoundaryPending = 0;
  private nativeUncertain = false;
  private nativeProtocolUncertain = false;
  private nativeDeadlineEpoch = 0;
  private nativeFailureReported = false;
  private readonly readImage: (ref: StructuredImageRef) => Buffer;
  private readonly compactEvidenceTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly onEventCursorRecovery: RuntimeEventCursorRecoveryReporter | undefined;
  private readonly signalProcess: ProcessSignal;
  private readonly processIdentity: (pid: number) => string | null;
  private readonly captureProcessTree: (root: number) => ProcessTreeCapture;
  private readonly terminationCaptureRetryMs: number;
  private terminationCapture: TerminationCaptureListener | null = null;
  private treeCaptured = false;
  private captureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly childStartIdentity: string | null;
  private readonly exitProcess: import("@/lib/processIdentity").ProcessIdentity | null;

  /** Scalar reads only; independent of event-window retention policy. */
  heapAttribution() {
    let queuedEvents = 0;
    for (const subscriber of this.subscribers) queuedEvents += subscriber.queue.length;
    return { engine: "claude", events: this.events.length, ...this.eventWindow.heapAttribution(), eventSubscribers: this.subscribers.size,
      stateSubscribers: this.stateListeners.size, queuedEvents };
  }

  private readonly subscribers = new Set<Subscriber>();
  private readonly eventWindow = new HostEventWindow();
  private readonly events = this.eventWindow.events;
  private eventWindowReleased = false;
  private eventWindowRevision = 0;

  releaseIdleEventWindow(canRelease: () => boolean): Promise<boolean> {
    const transcriptPath = this.eventTranscriptPath;
    return releaseIdleHostEventWindow({
      events: this.events,
      revision: () => this.eventWindowRevision,
      transcriptPath,
      eligible: () => this.eventTranscriptPath === transcriptPath && !this.dead && !this.releasing && !this.released
        && !(this.activeTurnId !== null || this.manualCompaction !== null) && canRelease(),
      onRelease: () => { this.eventWindow.release(); this.eventWindowReleased = true; },
    });
  }

  private refillEventWindow(): void {
    if (!this.eventWindowReleased) return;
    const stored = this.eventStore.load(this.identity.sessionId);
    assertReleasedHostEventLedger(this.events, stored);
    this.eventWindow.restore(stored);
    this.eventWindowReleased = false;
  }

  private readonly deliveries: ClaudeDeliveryState[] = [];
  private readonly turnQueue: string[] = [];
  /** Engine ids of the inputs the running turn read at a tool boundary. */
  private readonly joinedUserUuids = new Set<string>();
  private readonly attentions = new Map<string, JsonObject>();
  /** When each open attention arrived, for the permission requests the state
      reports (#2215). Pruned against `attentions` on every state read. */
  private readonly attentionSince = new Map<string, string>();
  /** The provider retry the CLI announced for the running turn (#2215). */
  private providerRetry: ProviderRetryEvidence | null = null;
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly pendingAnswers = new Map<string, PendingAnswer>();
  /** Compactions this host issued, keyed by durable operation and kept after
      they settle: a retry replays the outcome instead of typing `/compact` a
      second time into the conversation (#1214). */
  private readonly compactions = new Map<string, PendingCompaction>();
  private readonly interruptedTurns = new Set<string>();
  private readonly partialTurns = new Set<string>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrTail = "";
  private terminalExit: string | null = null;
  private cursor: number;
  private activeTurnId: string | null = null;
  private assistantCandidate: { id: string | null; userUuid: string | null } | null = null;
  private activeUserUuid: string | null = null;
  /** The command still owns the stream after its evidence promise settles. */
  private manualCompaction: PendingCompaction | null = null;
  private lastResultUuid: string | null = null;
  private protocolVersion: string | null;
  private account: HostState["account"];
  private readonly memoryCell: AgentMemoryCell | null;
  private releasing = false;
  private released = false;
  private dead = false;
  private reaped = false;
  private ledgerFailed = false;
  private writerFence: (() => boolean) | null = null;
  private releasePromise: Promise<void> | null = null;
  private releaseCleanup: (() => void) | null;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private terminationStarted = false;
  /** Why this host ended; the first cause recorded wins (#2790). */
  private endCause: HostEndCause | null = null;
  private exitNoted = false;
  private releaseFence: Readonly<ProcessIdentity> | null = null;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;
  private readonly launchFlags: readonly string[];

  private constructor(
    child: ChildProcessWithoutNullStreams,
    identity: ClaudeSessionIdentity,
    auth: ClaudeAuthStatus,
    options: ClaudeStreamBrokerHostOptions,
  ) {
    heapAttribution.hosts.add(this, null);
    this.child = child;
    this.memoryQueuePath = options.memoryQueuePath;
    this.eventTranscriptPath = claudeTranscriptPath(options.cwd, identity.sessionId, options.claudeProjectsDir);
    this.memoryCell = options.memoryCell ?? null;
    this.memoryCell?.onChange(() => this.notifyStateListeners());
    this.identity = identity;
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.deliveryLedger = options.deliveryLedger ?? new FileClaudeDeliveryLedger();
    this.readImage = options.readImage ?? ((ref) => runtimeImageStore().read(ref));
    this.compactEvidenceTimeoutMs = options.compactEvidenceTimeoutMs ?? DEFAULT_COMPACT_EVIDENCE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.onEventCursorRecovery = options.onEventCursorRecovery;
    this.signalProcess = options.signalProcess ?? process.kill;
    this.processIdentity = options.processIdentity ?? ((pid) => procBackend.processIdentity(pid));
    this.captureProcessTree = options.captureProcessTree ?? ((root) => captureProcessTree(root));
    this.terminationCaptureRetryMs = Math.max(0, options.terminationCaptureRetryMs ?? DEFAULT_TERMINATION_CAPTURE_RETRY_MS);
    this.childStartIdentity = nativeProcessId(child) ? this.processIdentity(nativeProcessId(child)!) : null;
    this.exitProcess = signalDomain(child)?.native ?? hostExitProcess(nativeProcessId(child), this.childStartIdentity);
    this.memoryCell?.setExitProcess(this.exitProcess);
    if (!signalDomain(child)) observeHostExit(child, this.exitProcess);
    this.releaseCleanup = options.releaseCleanup ?? null;
    this.cursor = options.initialEventCursor ?? 0;
    this.protocolVersion = auth.version ?? null;
    // Protocol evidence is exact-version scoped. Native admission remains off,
    // including when its future kill-switch setting requests activation.
    this.nativeWriter = auth.version === "2.1.323" && claudeNativeUuid(identity.sessionId) && this.childStartIdentity
      && this.deliveryLedger.recordNativeIntent && this.deliveryLedger.recordNativeConsumed && this.deliveryLedger.confirmNativeResult && this.deliveryLedger.recordNativeNoWrite
      ? { sessionId: identity.sessionId, writerId: crypto.randomUUID(),
        process: { pid: nativeProcessId(child)!, startIdentity: this.childStartIdentity } } : null;
    this.account = { type: auth.authMethod, planType: auth.subscriptionType };
    this.launchFlags = options.allowSubagents
      ? [STRUCTURED_IMAGE_CAPABILITY]
      : [STRUCTURED_IMAGE_CAPABILITY, NATIVE_MULTI_AGENT_DENY_FLAG];
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.acceptStdout(typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk));
    });
    child.stdout.on("end", () => {
      const tail = this.stdoutDecoder.end();
      if (tail) this.acceptStdout(tail);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      /* Provider diagnostics may contain credentials, so none of this text is
         retained: a bounded tail is matched against the terminal launch exits
         (#1071) and only the canonical phrase survives the match. */
      this.stderrTail = (this.stderrTail + (typeof chunk === "string" ? chunk : chunk.toString("utf8")))
        .slice(-TERMINAL_EXIT_MATCH_BYTES);
      this.terminalExit ??= terminalClaudeExitReason(this.stderrTail);
      if (this.terminalExit) this.stderrTail = "";
    });
    child.stdin.on("error", (error) => {
      if (!this.releasing && !this.released) this.fail(new Error(`Claude stream stdin failed: ${safeError(error)}`));
    });
    child.on("error", (error) => this.fail(new Error(`Claude child failed: ${safeError(error)}`)));
    // Exit arrives before inherited pipes close; reap OOM survivors immediately.
    child.on("exit", (code, signal) => {
      if (signalDomain(child)) {
        const native = readHostExit(this.exitProcess)?.exit;
        code = native?.code ?? null;
        signal = (native?.signal ?? null) as NodeJS.Signals | null;
      }
      const kill = this.memoryCell?.settleExit({ expected: this.releasing || this.released });
      if (kill?.fatal && !this.releasing && !this.released) {
        const reason = memoryKillText(kill);
        this.recordEnd("memory-kill", reason, code, signal);
        this.noteChildExit(code, signal);
        this.fail(new Error(reason));
        return;
      }
      this.noteChildExit(code, signal);
    });
    child.on("close", (code, signal) => {
      if (signalDomain(child)) {
        const native = readHostExit(this.exitProcess)?.exit;
        code = native?.code ?? null;
        signal = (native?.signal ?? null) as NodeJS.Signals | null;
      }
      this.memoryCell?.settleExit({ expected: this.releasing || this.released });
      this.noteChildExit(code, signal);
      this.reaped = true;
      this.clearCaptureRetry();
      if (this.terminationTimer) {
        clearTimeout(this.terminationTimer);
        this.terminationTimer = null;
      }
      this.resolveReaped();
      const finish = () => {
        if (this.releasing) this.finishRelease();
        else if (this.dead) this.notifyStateListeners();
        else if (!this.releasing && !this.released) {
          // Pipes may deliver the diagnostic after exit, before close.
          const launchFailure = this.terminalExit ?? this.memoryCell?.launchFailure() ?? null;
          if (launchFailure && this.endCause?.kind === "child-exit" && this.endCause.reason === CLAUDE_CHILD_EXITED) {
            this.endCause = { ...this.endCause, reason: boundedEndReason(launchFailure) };
          }
          this.fail(new Error(this.endCause ? claudeHostEndText(this.endCause) : CLAUDE_CHILD_EXITED));
        }
      };
      // The pipe is closed, while a captured result can still be waiting for
      // its durable append. Retain its owner through that bounded drain.
      if (this.nativeWriter && this.nativeWorkCount) {
        void this.joinNativePersistence().catch(error => this.noteNativeFailure("reducer", error))
          .then(finish).catch(error => this.noteNativeFailure("reducer", error));
      } else finish();
    });
  }

  static async start(options: ClaudeStreamBrokerHostOptions): Promise<ClaudeStreamBrokerHost> {
    return this.open(options.sessionId ?? crypto.randomUUID(), false, {
      ...options, permissionMode: options.permissionMode ?? (options.readOnly ? "plan" : "bypassPermissions"),
    });
  }

  static async adopt(sessionId: string, options: ClaudeStreamBrokerHostOptions): Promise<ClaudeStreamBrokerHost> {
    if (!sessionId) throw new Error("Claude session id is required for adoption");
    const permissionMode = options.permissionMode ?? (options.readOnly ? "plan"
      : /^[0-9a-f-]{36}$/.test(sessionId)
        ? await readClaudePermissionMode(claudeTranscriptPath(options.cwd, sessionId, options.claudeProjectsDir))
        : null);
    return this.open(sessionId, true, { ...options, permissionMode: permissionMode ?? undefined });
  }

  private static async open(
    sessionId: string,
    resume: boolean,
    options: ClaudeStreamBrokerHostOptions,
  ): Promise<ClaudeStreamBrokerHost> {
    if (options.claudeConfigDir && (options.env ?? process.env).LLV_SPAWN_CAPABILITY) {
      const queueRoot = path.join(options.claudeConfigDir, ".llv", "memory-queues");
      try {
        fs.mkdirSync(queueRoot, { recursive: true, mode: 0o700 });
        const memoryQueuePath = path.join(queueRoot, `${crypto.randomUUID()}.jsonl`);
        fs.writeFileSync(memoryQueuePath, "", { mode: 0o600 });
        options = { ...options, memoryQueuePath };
      } catch { /* hook installation remains optional */ }
    }
    const binary = options.binary ?? process.env.LLV_CLAUDE_BINARY ?? "claude";
    let env: NodeJS.ProcessEnv;
    let auth: ClaudeAuthStatus;
    try {
      options = { ...options, env: await repositoryPublicationSource(options.cwd, options.env ?? process.env) };
      env = subscriptionEnv(
        options.env ?? process.env,
        options.claudeConfigDir,
        options.forwardGitHubConfig === true,
        options.providerAccount === true,
      );
      auth = options.providerAccount
        ? { loggedIn: true, authMethod: "provider", subscriptionType: null }
        : await (options.readAuthStatus?.() ?? claudeCliAuthStatus(binary, env, options.cwd));
    } catch (error) {
      options.releaseCleanup?.();
      throw error;
    }
    if (!auth.loggedIn || (!options.providerAccount && (auth.authMethod !== "claude.ai" || !auth.subscriptionType))) {
      options.releaseCleanup?.();
      throw new Error("Claude stream hosting requires a claude.ai subscription login");
    }
    let relay: Awaited<ReturnType<typeof startClaudeProviderRelay>> | null = null;
    if (options.providerAccount) {
      try {
        let headers: Record<string, string> = {};
        if (options.claudeConfigDir) {
          try {
            const runtime = readClaudeProviderRuntime(options.claudeConfigDir,
              claudeProviderForHome(options.claudeConfigDir) ?? undefined);
            if (runtime.config.baseUrl !== env.ANTHROPIC_BASE_URL || runtime.token !== env.ANTHROPIC_AUTH_TOKEN
              || runtime.config.model !== env.ANTHROPIC_MODEL
              || (runtime.config.smallFastModel ?? undefined) !== env.ANTHROPIC_SMALL_FAST_MODEL)
              throw new UnsafeClaudeHomeError();
            headers = runtime.headers;
          } catch (error) { if (!options.spawnProcess) throw error; }
        }
        relay = await startClaudeProviderRelay({
          baseUrl: env.ANTHROPIC_BASE_URL!, token: env.ANTHROPIC_AUTH_TOKEN!, sessionId,
          headers,
          ...(options.claudeConfigDir ? { healthHome: options.claudeConfigDir,
            credentialRevision: providerCredentialRevision(options.claudeConfigDir) } : {}),
        });
        env.ANTHROPIC_BASE_URL = relay.baseUrl;
        env.ANTHROPIC_AUTH_TOKEN = relay.alias;
      } catch (error) { options.releaseCleanup?.(); throw error; }
    }
    let telegram: TelegramLaunchGrant;
    try {
      telegram = await resolveTelegramLaunchGrant(env, options.mcpServers, {
        validateGrant: options.validateTelegramGrant,
      });
    } catch (error) { relay?.close(); options.releaseCleanup?.(); throw error; }
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--replay-user-messages",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", effectiveClaudePermissionMode(options),
      ...(options.restricted ? ["--restricted"] : []),
    ];
    const disallowedTools = [
      ...(!options.allowSubagents ? NATIVE_MULTI_AGENT_TOOLS : []),
      ...(options.readOnly ? ["Edit", "Write", "NotebookEdit"] : []),
      ...(options.operatorDecisionForms ? ["AskUserQuestion", "ExitPlanMode"] : []),
    ];
    if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));
    if (options.claudeConfigDir) {
      const profileId = `structured-${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
      let settings: ReturnType<typeof applyClaudeSpawnPolicy>;
      try {
        settings = applyClaudeSpawnPolicy(options.claudeConfigDir, {
          allowSubagents: options.allowSubagents,
          cleanMemory: options.cleanMemory,
          baseSettingsPath: options.spawnPolicyBaseSettingsPath,
          providerAccount: options.providerAccount,
          publicationEnv: options.env ?? process.env,
          memoryQueuePath: options.memoryQueuePath,
          profileId,
          cwd: options.cwd,
          mcpServers: telegram.mcpServers,
          mcpStatePath: options.mcpStatePath,
          viewerTransport: viewerMcpTransportForLaunch(env),
        });
      } catch (error) { relay?.close(); options.releaseCleanup?.(); throw error; }
      args.push(
        "--settings", settings.settingsPath,
        "--strict-mcp-config", "--mcp-config", settings.mcpConfigPath,
      );
    } else args.push("--settings", JSON.stringify({
      ...(engineMemoryOff(options) ? { autoMemoryEnabled: false } : {}),
      env: { ...agentPublicationIdentityEnv(options.env ?? process.env), ...(engineMemoryOff(options) ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}) },
    }), "--strict-mcp-config");
    if (options.providerAccount) args.push("--setting-sources", "");
    if (resume) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    const appended = [options.cleanMemory ? "" : options.appendSystemPrompt, telegram.unavailable ? TELEGRAM_UNAVAILABLE_THIS_RUN_NOTICE : ""].filter(Boolean).join("\n\n");
    if (appended) args.push("--append-system-prompt", appended);
    if (options.tools) args.push("--tools", options.tools.join(","));
    let child: ChildProcessWithoutNullStreams;
    let initialDeliveries: ClaudeDeliveryState[];
    options = { ...options, deliveryLedger: options.deliveryLedger ?? new FileClaudeDeliveryLedger() };
    try {
      initialDeliveries = options.deliveryLedger!.loadDurable
        ? await options.deliveryLedger!.loadDurable(sessionId, auth.version === "2.1.323")
        : options.deliveryLedger!.load(sessionId);
      options.assertCurrent?.();
      child = await spawnManagedEngine(binary, args, {
        cwd: options.cwd,
        env: telegram.env,
        detached: true,
      }, options.memoryCell, options.spawnProcess, options.env ?? process.env, undefined, options.assertCurrent);
    } catch (error) {
      relay?.close();
      options.releaseCleanup?.();
      throw error;
    }
    child.once("close", () => relay?.close());
    const host = new ClaudeStreamBrokerHost(child, { sessionId }, auth, {
      ...options, releaseCleanup: () => { relay?.close(); options.releaseCleanup?.(); },
    });
    try {
      if (options.claudeConfigDir) await host.verifyViewerMcp();
      host.restore(initialDeliveries);
      host.reconcileTranscript(options.readTranscript
        ? options.readTranscript(options.cwd, sessionId)
        : defaultTranscriptUsers(options.cwd, sessionId, options.claudeProjectsDir));
      host.emit({ kind: "session-status", status: "idle" });
      return host;
    } catch (error) {
      try {
        await withHostStopOrigin({ path: "claude-startup-cleanup", operationId: host.identity.sessionId }, () => host.release());
      } catch (cleanupError) {
        throw new StructuredHostAdoptionCleanupError(safeError(error), host, { cause: cleanupError });
      }
      throw new Error(safeError(error));
    }
  }

  private async verifyViewerMcp(): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    const request = (subtype: string) => new Promise<JsonObject>((resolve, reject) => {
      if (this.unavailable()) return reject(new Error("Viewer MCP launch failed: Claude closed during startup"));
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new Error("Viewer MCP launch failed: Claude tool discovery timed out"));
      }, Math.max(1, deadline - Date.now()));
      this.pendingControls.set(requestId, { resolve: value => resolve(value ?? {}), reject, timer, interruptTurnId: null });
      this.write({ type: "control_request", request_id: requestId, request: { subtype } });
    });
    try {
      await request("initialize");
      // The CLI acknowledges initialize before its MCP connections settle.
      // Wait for its own catalog under the same launch deadline.
      for (;;) {
        const status = await request("mcp_status");
        const viewer = Array.isArray(status.mcpServers)
          ? status.mcpServers.find(entry => stringField(entry, "name") === "viewer") : null;
        if (stringField(viewer, "status") !== "pending") {
          assertViewerMcpTools(status.mcpServers, structuredHostStamp());
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Claude Viewer tool discovery timed out while pending");
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remaining)));
      }
    } catch (error) {
      const reason = safeError(error);
      throw new Error(reason.startsWith("Viewer MCP launch failed") ? reason : `Viewer MCP launch failed: ${reason}`);
    }
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    this.eventWindowRevision += 1;
    this.refillEventWindow();
    return attachRuntimeEvents(afterSeq, {
      window: () => this.events,
      ledger: () => this.eventStore.load(this.identity.sessionId),
      subscribers: this.subscribers,
    });
  }

  async send(entry: QueueEntry, _firstDispatch?: import("./engineHost").FirstDispatchEvidence, authorizeDispatch?: () => void,
    observeTiming?: DeliveryTimingObserver): Promise<DeliveryReceipt> {
    const restored = this.deliveries.find(state => state.entry.id === entry.id);
    if (restored?.native || restored?.nativeUnverified || this.nativeWriter && !restored) {
      return this.sendNative(entry, authorizeDispatch, observeTiming);
    }
    if (this.nativeUncertain && !this.nativeIdleSafe()) return { outcome: "rejected", reason: "stale-turn" };
    if (this.unavailable()) return { outcome: "rejected", reason: "dead-host" };
    if (!entry.id) throw new Error("queue entry id is required");
    const normalized = normalizeQueueEntry(entry);
    const duplicate = this.deliveries.find((state) => state.entry.id === entry.id);
    if (duplicate && !sameNormalizedEntry(duplicate.entry, normalized)) {
      throw new Error("Claude queue entry id belongs to a different payload");
    }
    if (!duplicate && normalized.expectedTurnId !== undefined && normalized.expectedTurnId !== this.activeTurnId) {
      return { outcome: "rejected", reason: "stale-turn" };
    }
    if (duplicate?.delivered) {
      if (duplicate.confirmation === "unverified") {
        throw new Error("Claude delivery outcome is uncertain; recipient evidence is ambiguous");
      }
      return { outcome: duplicate.disposition, turnId: duplicate.entry.id };
    }
    const existingPending = this.pendingDeliveries.get(entry.id);
    if (existingPending) return existingPending.promise;
    /* One input waits behind the running turn at a time. A second one could be
       joined with it into one echo, which would confirm neither. */
    if (this.activeTurnId && this.turnQueue.some((id) => id !== this.activeTurnId && id !== entry.id)) {
      return { outcome: "rejected", reason: "stale-turn" };
    }
    /* A turn the CLI began on its own carries no input of ours to tell its
       result from the next one's, so a write aimed into it waits for its end. */
    if (!duplicate && typeof normalized.expectedTurnId === "string" && this.backgroundTurn(this.activeTurnId)) {
      return { outcome: "rejected", reason: "stale-turn" };
    }
    const markTiming = (mark: DeliveryTimingMark) => {
      try { observeTiming?.(mark); } catch { /* Timing observers cannot affect delivery. */ }
    };
    markTiming("claude-prepare-start");
    const blocks = this.prepareUserBlocks(normalized);
    markTiming("claude-prepare-end");
    authorizeDispatch?.();
    const disposition: ClaudeDeliveryState["disposition"] = duplicate?.disposition
      ?? (this.activeTurnId ? "queued-next-turn" : "turn-started");
    try {
      this.deliveryLedger.recordQueued(this.identity.sessionId, normalized, disposition);
    } catch (error) {
      this.failWithoutLedger(new Error(`Claude delivery ledger failed: ${safeError(error)}`));
      throw new Error(`Claude delivery ledger failed: ${safeError(error)}`);
    }
    const delivery: ClaudeDeliveryState = duplicate
      ?? { entry: structuredClone(normalized), disposition, delivered: false };
    if (!duplicate) this.deliveries.push(delivery);
    let resolveDelivery!: PendingDelivery["resolve"];
    let rejectDelivery!: PendingDelivery["reject"];
    const promise = new Promise<DeliveryReceipt>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const pending: PendingDelivery = {
      promise,
      resolve: (receipt) => resolveDelivery(receipt),
      reject: (error) => rejectDelivery(error),
      timer: null,
    };
    this.pendingDeliveries.set(entry.id, pending);
    if (this.memoryQueuePath) {
      try { fs.appendFileSync(this.memoryQueuePath, JSON.stringify({ id: entry.id, digest: crypto.createHash("sha256").update(normalized.content.text).digest("hex") }) + "\n"); }
      catch { /* no matching receipt means the hook abstains */ }
    }
    markTiming("claude-write-start");
    this.write({
      type: "user",
      session_id: this.identity.sessionId,
      message: { role: "user", content: blocks },
    });
    markTiming("claude-write-end");
    this.turnQueue.push(entry.id);
    if (!this.activeTurnId) {
      this.activeTurnId = entry.id;
      this.armDeliveryConfirmation(entry.id);
      this.emit({ kind: "turn-started", turnId: entry.id, accountingAt: new Date().toISOString() });
    } else {
      this.notifyStateListeners();
    }
    return pending.promise;
  }

  private prepareUserBlocks(normalized: NormalizedQueueEntry): JsonObject[] {
    const imageBlock = (image: StructuredImageRef): JsonObject => ({ type: "image", source: {
      type: "base64", media_type: image.mime, data: this.readImage(image).toString("base64"),
    } });
    const blocks: JsonObject[] = [];
    if (normalized.parts?.length) {
      let end = 0;
      for (const [index, part] of normalized.parts.entries()) {
        if (part.textStart > end) blocks.push({ type: "text", text: normalized.content.text.slice(end, part.textStart) });
        blocks.push(...normalized.content.images.slice(part.imageStart, part.imageEnd).map(imageBlock));
        end = normalized.parts[index + 1]?.headerStart ?? normalized.content.text.length;
        blocks.push({ type: "text", text: normalized.content.text.slice(part.textStart, end) });
      }
    } else {
      blocks.push(...normalized.content.images.map(imageBlock));
      if (normalized.content.text) blocks.push({ type: "text", text: normalized.content.text });
    }
    return blocks;
  }

  private nativeCurrent(capturedStream = false): boolean {
    const writer = this.nativeWriter;
    if (!writer || this.dead || this.released || !capturedStream && (this.releasing || this.reaped || this.exitNoted)) return false;
    try { if (this.writerFence?.() === false) return false; } catch { return false; }
    // Captured frames retain the original pipe/process binding through exit.
    // Dispatch requires a live kernel identity; both retain the writer claim.
    return capturedStream || this.processIdentity(writer.process.pid) === writer.process.startIdentity;
  }

  private noteNativeFailure(phase: "intent" | "no-write" | "reducer", error: unknown): void {
    this.nativeUncertain = true;
    if (this.nativeFailureReported) return;
    this.nativeFailureReported = true;
    const cause = error instanceof Error && ["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "AggregateError"].includes(error.name) ? error.name : "Error";
    const code = record(error)?.code;
    const errno = typeof code === "string" && ["EACCES", "EBADF", "EIO", "EINVAL", "EMFILE", "ENFILE", "ENOSPC", "EPERM"].includes(code) ? code : null;
    console.error("[claude-native] evidence processing failed", { errorClass: "ClaudeNativeEvidenceError", phase, cause, errno });
  }

  /** Input writes and proof appends share one asynchronous, bounded lane.
   * Receipt promises wait outside it, leaving permission controls serviceable. */
  private enqueueNative<T>(action: () => Promise<T>, discardUnstarted = false): Promise<T> {
    if (++this.nativeWorkCount > 512) {
      this.nativeWorkCount--;
      this.nativeUncertain = this.nativeProtocolUncertain = true;
      return Promise.reject(new Error("Claude native evidence backlog is uncertain"));
    }
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    let started = false, expired = false;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      expired = true;
      if (!started && discardUnstarted) {
        reject(new StructuredDispatchDeferredError("Claude native dispatch is waiting for local persistence"));
      } else {
        this.nativeUncertain = true;
        this.nativeDeadlineEpoch++;
        reject(new Error("Claude native delivery persistence timed out; outcome is uncertain"));
      }
    }, this.requestTimeoutMs);
    // A deadline ends the caller's wait. The actual I/O still owns this lane
    // until it settles; a late append cannot race the following result reducer.
    const work = this.nativeWork.then(async () => {
      try {
        if (expired && discardUnstarted) return;
        started = true;
        resolve(await action());
      } catch (error) { reject(error); }
      finally { clearTimeout(timer); this.nativeWorkCount--; }
    });
    this.nativeWork = work;
    return result;
  }

  private async sendNative(entry: QueueEntry, authorize?: () => void, timing?: DeliveryTimingObserver): Promise<DeliveryReceipt> {
    const task = await this.enqueueNative(async (): Promise<{ receipt: DeliveryReceipt } | { pending: PendingDelivery }> => {
      const attemptEpoch = this.nativeDeadlineEpoch;
      const normalized = normalizeQueueEntry(entry);
      const existing = this.deliveries.find(state => state.entry.id === entry.id);
      if (existing && !sameNormalizedEntry(existing.entry, normalized)) throw new Error("Claude queue entry id belongs to a different payload");
      if (existing?.nativeResult) return { receipt: { outcome: existing.nativeResult.turnId === entry.id ? existing.disposition : "steered", turnId: existing.nativeResult.turnId } };
      if (existing?.nativeConsumed?.turnId) return { receipt: { outcome: existing.disposition, turnId: existing.nativeConsumed.turnId } };
      const pending = this.pendingDeliveries.get(entry.id);
      if (pending) return { pending };
      // Adoption of a possibly written input never grants another write.
      if (existing && !existing.nativeNoWrite) throw new Error("Claude native delivery outcome is uncertain; input remains fenced");
      if (!this.nativeCurrent()) return { receipt: { outcome: "rejected", reason: "dead-host" } };
      if (this.nativeUncertain && !this.nativeIdleSafe(entry.id) || this.attentions.size || this.nativeBoundaryPending || this.backgroundTurn(this.activeTurnId)
        || this.activeTurnId && this.turnQueue.some(id => id !== this.activeTurnId && id !== entry.id)
        || normalized.expectedTurnId !== undefined && normalized.expectedTurnId !== this.activeTurnId) {
        return { receipt: { outcome: "rejected", reason: "stale-turn" } };
      }
      const mark = (value: DeliveryTimingMark) => { try { timing?.(value); } catch { /* observation only */ } };
      mark("claude-prepare-start");
      const blocks = this.prepareUserBlocks(normalized);
      mark("claude-prepare-end");
      authorize?.();
      if (this.memoryQueuePath) {
        try { await fs.promises.appendFile(this.memoryQueuePath, JSON.stringify({ id: entry.id,
          digest: crypto.createHash("sha256").update(normalized.content.text).digest("hex") }) + "\n", { mode: 0o600 }); }
        catch { /* no matching receipt means the hook abstains */ }
      }
      authorize?.();
      if (!this.nativeCurrent() || this.nativeUncertain && !this.nativeIdleSafe(entry.id) || attemptEpoch !== this.nativeDeadlineEpoch || this.attentions.size || this.nativeBoundaryPending
        || normalized.expectedTurnId !== undefined && normalized.expectedTurnId !== this.activeTurnId) return { receipt: { outcome: "rejected", reason: "stale-turn" } };
      const observedTurn = this.activeTurnId;
      const resumingNoWrite = existing?.nativeNoWrite === true;
      const disposition = existing && !resumingNoWrite ? existing.disposition : (observedTurn ? "queued-next-turn" : "turn-started");
      const input: ClaudeNativeInput = existing?.native
        ? { ...existing.native, ...(existing.nativeNoWrite ? this.nativeWriter! : {}) }
        : { ...this.nativeWriter!, version: 1, inputUuid: crypto.randomUUID(), intent: "may-have-written" };
      if (!sameNativeWriter(input, this.nativeWriter!)) throw new Error("Claude native input writer changed; input remains fenced");
      const state: ClaudeDeliveryState = existing ?? { entry: normalized, disposition, native: input, nativeReplayShape: nativeReplayShape(normalized), delivered: false };
      // Keep the in-memory fence even if append/sync has an unknown outcome.
      if (!existing) this.deliveries.push(state);
      try { await this.deliveryLedger.recordNativeIntent!(this.identity.sessionId, normalized, disposition, input); }
      catch (error) { this.noteNativeFailure("intent", error); throw new Error("Claude native intent persistence failed; outcome is uncertain"); }
      state.native = input;
      state.entry = normalized;
      state.nativeNoWrite = false;
      state.disposition = disposition;
      if (resumingNoWrite) { this.deliveries.splice(this.deliveries.indexOf(state), 1); this.deliveries.push(state); }
      let fenceChanged = false;
      try {
        authorize?.();
        fenceChanged = !this.nativeCurrent() || this.nativeUncertain && !this.nativeIdleSafe(entry.id) || attemptEpoch !== this.nativeDeadlineEpoch || this.attentions.size > 0
          || this.nativeBoundaryPending > 0 || observedTurn !== this.activeTurnId;
        if (fenceChanged) throw new Error("Claude native dispatch fence changed before write");
      } catch (error) {
        try {
          await this.deliveryLedger.recordNativeNoWrite!(this.identity.sessionId, entry.id, input.inputUuid);
          state.nativeNoWrite = true;
          state.entry = settledDeliveryEntry(state.entry);
        } catch (failure) {
          this.noteNativeFailure("no-write", failure);
          throw new Error("Claude native no-write persistence failed; outcome is uncertain");
        }
        if (fenceChanged) return { receipt: { outcome: "rejected", reason: "stale-turn" } };
        throw error;
      }
      state.native = input;
      state.nativeNoWrite = false;
      let resolve!: PendingDelivery["resolve"];
      let reject!: PendingDelivery["reject"];
      const promise = new Promise<DeliveryReceipt>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      const waiting: PendingDelivery = { promise, resolve, reject, timer: null };
      this.pendingDeliveries.set(entry.id, waiting);
      this.turnQueue.push(entry.id);
      const startsTurn = !this.activeTurnId;
      if (startsTurn) this.activeTurnId = entry.id;
      mark("claude-write-start");
      try {
        this.write({ type: "user", session_id: this.identity.sessionId, uuid: input.inputUuid,
          message: { role: "user", content: blocks } });
      } catch (error) { this.nativeUncertain = true; waiting.reject(error as Error); throw error; }
      mark("claude-write-end");
      if (startsTurn) this.emit({ kind: "turn-started", turnId: entry.id, accountingAt: new Date().toISOString() });
      this.armDeliveryConfirmation(entry.id);
      this.notifyStateListeners();
      return { pending: waiting };
    }, true);
    return "receipt" in task ? task.receipt : task.pending.promise;
  }

  private async noteNativeConsumed(entryIds: readonly string[]): Promise<void> {
    if (!this.memoryQueuePath) return;
    try { await fs.promises.appendFile(this.memoryQueuePath + ".consumed", entryIds.join("\n") + "\n", { mode: 0o600 }); }
    catch { /* optional hook receipt */ }
  }

  private async acceptNativeReplay(message: JsonObject, receivedAt: string): Promise<void> {
    const content = messageContent(message);
    const state = this.deliveries.find(row => row.native?.inputUuid === message.uuid);
    let echo: string | null = null;
    if (this.nativeCurrent(true) && state?.native && sameNativeWriter(state.native, this.nativeWriter!) && content && message.isReplay === true
      && message.session_id === this.identity.sessionId && message.parent_tool_use_id == null && message.agent_id == null
      && stringField(message.message, "role") === "user" && (state.entry.contentDigest === content.contentDigest
        || state.nativeReplayShape && state.nativeReplayShape.imageCount === content.content.images.length
          && state.nativeReplayShape.textDigest === crypto.createHash("sha256").update(content.content.text).digest("hex"))) {
      const evidence: ClaudeNativeConsumed = { ...state.native, canonicalUuid: state.native.inputUuid,
        entryId: state.entry.id, contentDigest: state.entry.contentDigest,
        turnId: state.disposition === "turn-started" ? state.entry.id : null };
      const result = await this.deliveryLedger.recordNativeConsumed!(this.identity.sessionId, evidence);
      if (result !== "refused") await this.noteNativeConsumed([state.entry.id]);
      if (result !== "refused" && this.nativeCurrent(true)) {
        state.nativeConsumed = evidence;
        state.engineMessageId = evidence.canonicalUuid;
        // For an idle-origin input its owner is already established. Queued
        // inputs keep waiting: their echo cannot choose a terminal owner.
        if (evidence.turnId) {
          state.delivered = true;
          state.confirmation = "operation-bound";
          if (state.nativeTerminal || state.nativeTurnBoundary) this.refreshNativeUncertainty();
          const waiting = this.pendingDeliveries.get(state.entry.id);
          if (waiting) {
            if (waiting.timer) clearTimeout(waiting.timer);
            this.pendingDeliveries.delete(state.entry.id);
            waiting.resolve({ outcome: state.disposition, turnId: evidence.turnId });
          }
          echo = state.entry.id;
        }
      }
    }
    this.emit({ kind: "item", turnId: this.activeTurnId, item: sanitizedUserReplay(message, content),
      phase: "completed", accountingAt: receivedAt,
      ...(echo ? { deliveryEcho: { operationId: echo, at: receivedAt, attachedAt: new Date().toISOString(),
        ...(state?.entry.parts ? { memberOperationIds: state.entry.parts.map(part => part.operationId) } : {}) } } : {}) });
  }

  private async acceptNativeResult(message: JsonObject): Promise<void> {
    if (!this.nativeCurrent(true) || !this.activeTurnId) return;
    if (message.parent_tool_use_id != null || message.agent_id != null) return;
    const prior = this.deliveries.map(state => state.nativeResult ?? state.nativeTerminal ?? state.nativeTurnBoundary).find(proof => proof?.resultUuid === message.uuid);
    if (prior) {
      if ("inputUuids" in prior && JSON.stringify(prior.inputUuids) !== JSON.stringify(message.user_message_uuids)) this.nativeUncertain = this.nativeProtocolUncertain = true;
      return;
    }
    const interrupted = this.interruptedTurns.has(this.activeTurnId) || message.subtype === "interrupted";
    if (interrupted || message.subtype !== "success" || message.is_error === true) {
      const attempted = nativeBoundary({ ...message, subtype: "success", is_error: false, error: null }, this.nativeWriter!, this.activeTurnId, this.deliveries);
      if (!attempted) { await this.acceptNativeTurnBoundary(message); return; }
      const evidence: ClaudeNativeTerminal = { ...attempted, status: interrupted ? "interrupted" : "error" };
      const members = nativeResultMembers(this.deliveries, attempted)!;
      if (!this.deliveryLedger.recordNativeTerminal || await this.deliveryLedger.recordNativeTerminal(this.identity.sessionId, evidence) === "refused") {
        this.nativeUncertain = this.nativeProtocolUncertain = true; return;
      }
      if (!this.nativeCurrent(true)) return;
      for (const state of members) {
        state.nativeTerminal = evidence;
        const index = this.turnQueue.indexOf(state.entry.id);
        if (index >= 0) this.turnQueue.splice(index, 1);
        const pending = this.pendingDeliveries.get(state.entry.id);
        if (pending) {
          this.pendingDeliveries.delete(state.entry.id);
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error("Claude native terminal did not establish consumption; outcome is uncertain"));
        }
        if (!state.delivered) this.nativeUncertain = true;
        state.entry = settledDeliveryEntry(state.entry);
      }
      this.emit({ kind: "turn-ended", turnId: evidence.turnId, status: evidence.status, claudeResultUuid: evidence.resultUuid });
      if (!this.ledgerFailed) { this.refreshNativeUncertainty(); this.finishResultTurn(evidence.turnId); }
      return;
    }
    const proof = nativeBoundary(message, this.nativeWriter!, this.activeTurnId, this.deliveries);
    if (!proof) {
      // Repeated old boundaries cannot close a newer batch.
      if (this.deliveries.some(state => state.nativeResult?.resultUuid === message.uuid)) return;
      await this.acceptNativeTurnBoundary(message);
      return;
    }
    const members = nativeResultMembers(this.deliveries, proof)!;
    const accepted = await this.deliveryLedger.confirmNativeResult!(this.identity.sessionId, proof);
    if (accepted === "refused") { this.nativeUncertain = this.nativeProtocolUncertain = true; return; }
    await this.noteNativeConsumed(members.map(state => state.entry.id));
    // A lost writer cannot project a boundary or settle receipts for its successor.
    if (!this.nativeCurrent(true)) return;
    for (const state of members) {
      state.nativeResult = proof;
      state.delivered = true;
      state.confirmation = "operation-bound";
    }
    // Persisted proof precedes the single projected terminal event. Reopening
    // the ledger can replay that boundary if projection fails here.
    this.emit({ kind: "turn-ended", turnId: proof.turnId, status: proof.status,
      claudeResultUuid: proof.resultUuid, accountingAt: new Date().toISOString() });
    if (this.ledgerFailed) return;
    this.lastResultUuid = proof.resultUuid;
    for (const state of members) {
      const index = this.turnQueue.indexOf(state.entry.id);
      if (index >= 0) this.turnQueue.splice(index, 1);
      const waiting = this.pendingDeliveries.get(state.entry.id);
      if (waiting) {
        if (waiting.timer) clearTimeout(waiting.timer);
        this.pendingDeliveries.delete(state.entry.id);
        waiting.resolve({ outcome: state.entry.id === proof.turnId ? state.disposition : "steered", turnId: proof.turnId });
      }
      state.entry = settledDeliveryEntry(state.entry);
    }
    this.refreshNativeUncertainty();
    this.finishResultTurn(proof.turnId);
  }

  private async acceptNativeTurnBoundary(message: JsonObject): Promise<void> {
    const state = this.deliveries.find(row => row.entry.id === this.activeTurnId);
    // Singular identity proves only this incumbent's terminal boundary. It
    // cannot supply the absent/invalid membership of other written inputs.
    if (!this.nativeCurrent(true) || !state?.native || !sameNativeWriter(state.native, this.nativeWriter!)
      || state.nativeNoWrite || state.nativeUnverified || message.session_id !== this.identity.sessionId
      || !claudeNativeUuid(message.uuid) || message.user_message_uuid !== state.native.inputUuid
      || !["success", "interrupted", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(String(message.subtype))) {
      this.nativeUncertain = this.nativeProtocolUncertain = true; return;
    }
    const proof: ClaudeNativeTurnBoundary = { ...state.native, resultUuid: message.uuid, turnId: state.entry.id,
      status: this.interruptedTurns.has(state.entry.id) || message.subtype === "interrupted" ? "interrupted"
        : message.subtype === "success" && message.is_error !== true && message.aborted !== true && message.error == null ? "completed" : "error" };
    if (!this.deliveryLedger.recordNativeTurnBoundary || await this.deliveryLedger.recordNativeTurnBoundary(this.identity.sessionId, proof) === "refused") {
      this.nativeUncertain = this.nativeProtocolUncertain = true; return;
    }
    if (!this.nativeCurrent(true)) return;
    state.nativeTurnBoundary = proof;
    state.entry = settledDeliveryEntry(state.entry);
    this.emit({ kind: "turn-ended", turnId: proof.turnId, status: proof.status, claudeResultUuid: proof.resultUuid });
    if (this.ledgerFailed) return;
    this.lastResultUuid = proof.resultUuid;
    this.turnQueue.splice(0);
    // Any already-written followers retain their intents and receipts. With
    // unknown membership they acquire no invented new running turn.
    this.refreshNativeUncertainty();
    this.finishResultTurn(proof.turnId);
  }

  private nativeIdleSafe(unwrittenEntryId?: string): boolean {
    return this.activeTurnId === null && !this.nativeProtocolUncertain && this.deliveries.every(state => !state.nativeUnverified
      && (state.entry.id === unwrittenEntryId || !state.native || state.delivered || state.nativeNoWrite || state.nativeTerminal || state.nativeTurnBoundary));
  }

  private refreshNativeUncertainty(): void {
    this.nativeUncertain = this.nativeProtocolUncertain || this.deliveries.some(state => state.nativeUnverified
      || state.native && !state.nativeNoWrite && !state.delivered);
  }

  /* Legacy queued inputs start their echo budget with their own turn. Native
     inputs retain their write fence when this observation budget expires. */
  private armDeliveryConfirmation(id: string): void {
    const pending = this.pendingDeliveries.get(id);
    if (!pending || pending.timer) return;
    pending.timer = setTimeout(() => {
      if (this.pendingDeliveries.get(id) !== pending) return;
      // A missing replay echo says nothing about the incumbent turn's liveness.
      // Keep the original ledger entry and transport for late canonical evidence.
      // Retain the rejected promise too: another call with this id must not
      // write the same input again while its original replay echo is pending.
      if (this.deliveries.find(state => state.entry.id === id)?.native) {
        this.nativeUncertain = true;
        this.nativeDeadlineEpoch++;
      }
      pending.reject(new Error("Claude delivery confirmation timed out; outcome is uncertain"));
    }, this.requestTimeoutMs);
  }

  async interrupt(turnRef: string): Promise<void> {
    if (this.unavailable()) throw new Error("Claude stream host is unavailable");
    if (!turnRef || turnRef !== this.activeTurnId) throw new Error("active turn fence is stale");
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        const error = new Error("Claude interrupt timed out; outcome is uncertain");
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pendingControls.set(requestId, { resolve: () => resolve(), reject, timer, interruptTurnId: turnRef });
      this.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
    });
  }

  /**
   * Manual context compaction (#1214). The stream-json transport exposes
   * `interrupt` and `can_use_tool` as its whole client-originated control
   * channel — there is no compact subtype to send — so this control reaches
   * compaction the one way the transport allows: it types `/compact` into the
   * conversation, exactly as the operator would in the terminal.
   *
   * That mechanism buys no knowledge of the outcome, so none is claimed. The
   * promise settles only on a *witnessed* compaction: the `compact_boundary`
   * frame the CLI announces on this host's own stream, which is the same
   * boundary it writes to the transcript and arrives without anyone tailing a
   * file for it. An engine that declines the command answers it with a
   * boundary-less `result` and terminalizes `CLAUDE_COMPACT_DECLINED_REASON`
   * on the spot. Only a compaction that neither finished nor was declined
   * inside the evidence budget terminalizes `unverified` with
   * `CLAUDE_COMPACT_UNOBSERVED_REASON` — "sent, completion not observable" —
   * which is the honest verdict and an acceptable outcome. It is never
   * reported as success, and it never spins forever.
   *
   * The compaction is deliberately left out of the turn plane: it is not a
   * delivery, so it takes no ledger row and no turn slot, which is exactly why
   * the `result` the CLI answers with is legible as this command's. The
   * delivery queue holds messages behind an unfinished compaction, so the turn
   * queue is empty for the duration.
   */
  async compact(request: RuntimeCompactRequest): Promise<RuntimeCompactOutcome> {
    /* One durable operation, one `/compact`. A caller that timed out and
       retried — or a queue pass that re-read the same effect — joins the
       in-flight control or replays the settled outcome; it never types the
       command into the conversation a second time. */
    const existing = this.compactions.get(request.operationId);
    if (existing) return existing.promise;
    if (this.unavailable()) throw new StructuredCompactError("Claude stream host is unavailable", "refused");
    if (request.threadId && request.threadId !== this.identity.sessionId) {
      throw new StructuredCompactError("compact target session is not the session this host owns", "refused");
    }
    /* Admission fenced the durable turn axis, but a turn can start in between,
       and a `/compact` typed underneath a running turn is queued behind it
       instead of compacting anything the operator is looking at. */
    if (this.activeTurnId) {
      throw new StructuredCompactError("a turn is active; compaction would race it", "refused");
    }
    if (this.manualCompaction) {
      throw new StructuredCompactError("a compaction is already running on this conversation", "refused");
    }

    let resolveOutcome!: PendingCompaction["resolve"];
    let rejectOutcome!: PendingCompaction["reject"];
    const promise = new Promise<RuntimeCompactOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const compaction: PendingCompaction = {
      promise,
      resolve: (outcome) => resolveOutcome(outcome),
      reject: (error) => rejectOutcome(error),
      settled: false,
      timer: null,
    };
    /* A retry that arrives while the command is being written finds the entry
       here, so the registration happens before the frame. */
    this.compactions.set(request.operationId, compaction);
    this.assistantCandidate = null;
    this.manualCompaction = compaction;
    void promise.catch(() => undefined);
    this.write({
      type: "user",
      session_id: this.identity.sessionId,
      message: { role: "user", content: [{ type: "text", text: CLAUDE_COMPACT_COMMAND }] },
    });
    compaction.timer = setTimeout(() => {
      this.settleCompaction(
        compaction,
        new StructuredCompactError(CLAUDE_COMPACT_UNOBSERVED_REASON, "unverified"),
      );
    }, this.compactEvidenceTimeoutMs);
    return promise;
  }

  /** Settles one compaction exactly once and drops its evidence budget. The
      entry stays in the map so a later retry replays this outcome. */
  private settleCompaction(
    compaction: PendingCompaction,
    outcome: RuntimeCompactOutcome | StructuredCompactError,
  ): void {
    if (compaction.settled) return;
    compaction.settled = true;
    if (compaction.timer) clearTimeout(compaction.timer);
    compaction.timer = null;
    if (outcome instanceof StructuredCompactError) compaction.reject(outcome);
    else compaction.resolve(outcome);
  }

  /** Every compaction still awaiting evidence, settled with one verdict. A
      host that dies or is released mid-compaction leaves the engine outcome
      unknown, which is `unverified`, never a failure to have acted. */
  private settlePendingCompactions(outcome: RuntimeCompactOutcome | StructuredCompactError): void {
    for (const compaction of this.compactions.values()) {
      if (!compaction.settled) this.settleCompaction(compaction, outcome);
    }
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    if (this.unavailable()) throw new Error("Claude stream host is unavailable");
    if (!this.attentions.has(attentionRef)) throw new Error("attention request is missing or already answered");
    const attention = this.attentions.get(attentionRef)!;
    const response = record(value);
    const answer = response?.behavior === "allow"
      ? { ...response, updatedInput: { ...(record(attention.input) ?? {}), ...(record(response.updatedInput) ?? {}) } }
      : value ?? {};
    if (this.pendingAnswers.has(attentionRef)) throw new Error("attention answer is already awaiting confirmation");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAnswers.delete(attentionRef);
        const error = new Error("Claude attention answer timed out; outcome is uncertain");
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pendingAnswers.set(attentionRef, { resolve, reject, timer });
      this.write({
        type: "control_response",
        response: { subtype: "success", request_id: attentionRef, response: answer },
      });
    });
  }

  async health(): Promise<HostState> { return this.currentState(); }

  /** The canonical phrase of the terminal CLI exit this child reported, when
      it reported one (#1071). Callers use it as the failure reason a launch
      receipt carries, so the operator sees why a resubmit is needed. */
  terminalExitReason(): string | null { return this.terminalExit; }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  setWriterFence(fence: () => boolean): void { this.writerFence = fence; }

  /** Told, before this host's first stop signal, which processes its child
      had started (#2790). A tool that left the child's process group outlives
      the group signal, and once the child exits nothing can name it, so
      whoever must prove the whole tree gone records it here. No signal is
      sent until the listener answers that the tree it was told is durable. */
  setTerminationCapture(listener: TerminationCaptureListener | null): void {
    this.terminationCapture = listener;
  }

  async release(): Promise<void> {
    if (this.released) { await this.joinNativePersistence(); return; }
    if (!this.releasePromise) {
      const attempt = this.releaseAndReap();
      this.releasePromise = attempt;
      void attempt.catch(() => {
        if (this.releasePromise === attempt) this.releasePromise = null;
      });
    }
    await this.releasePromise;
    await this.joinNativePersistence();
  }

  private async joinNativePersistence(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.nativeWork, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude native persistence cleanup could not be confirmed")), this.requestTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Resource cleanup may release only the exact child the operator's row
      authorized. The kernel identity is checked here and again inside the
      synchronous signal boundary. */
  async releaseIfOwned(expected: Readonly<ProcessIdentity>): Promise<boolean> {
    const pid = nativeProcessId(this.child);
    if (this.released || this.releasing || this.releasePromise !== null
      || !pid || expected.startIdentity === null
      || pid !== expected.pid
      || this.childStartIdentity !== expected.startIdentity
      || this.processIdentity(pid) !== expected.startIdentity) return false;
    this.releaseFence = expected;
    try {
      await this.release();
      return true;
    } finally {
      if (this.releaseFence === expected) this.releaseFence = null;
    }
  }

  private unavailable(capturedStream = false): boolean {
    if (this.dead || this.releasing || this.released || !capturedStream && this.nativeWriter && (this.reaped || this.exitNoted)) return true;
    try { return this.writerFence?.() === false; } catch { return true; }
  }

  private currentState(): HostState {
    const pid = this.reaped || this.released ? null : nativeProcessId(this.child) ?? null;
    const status: HostState["status"] = this.dead ? "dead"
      : this.released ? "unhosted"
      : this.attentions.size ? "attention"
      : this.activeTurnId ? "active"
      : "idle";
    return {
      status,
      sessionKey: this.identity.sessionId,
      endpoint: pid ? `stdio:${pid}` : "stdio:released",
      pid,
      processStartIdentity: pid ? this.processIdentity(pid) : null,
      ...(this.exitProcess ? { exitProcess: this.exitProcess } : {}),
      ...(signalDomain(this.child) ? { signalDomain: signalDomain(this.child) } : {}),
      ...(signalBoundaryOff(this.child) ? { signalBoundary: signalBoundaryOff(this.child) } : {}),
      eventCursor: this.cursor,
      protocolVersion: this.protocolVersion,
      activeTurnRef: this.activeTurnId,
      pendingAttention: [...this.attentions.keys()],
      pendingPermissions: this.pendingPermissions(),
      pendingQuestions: this.pendingQuestions(),
      ...this.pendingToolUses(),
      providerRetry: this.activeTurnId ? this.providerRetry : null,
      ...memoryField(this.memoryCell),
      ...(this.endCause ? { ended: { ...this.endCause } } : {}),
      activeFlags: [...this.launchFlags],
      account: this.account,
    };
  }

  /** Records the first cause of this host's end. */
  private recordEnd(kind: HostEndCause["kind"], reason: string, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.endCause) return;
    this.endCause = {
      kind,
      reason: boundedEndReason(reason),
      code: code ?? null,
      signal: signal ?? null,
      signalledByHost: this.terminationStarted,
      at: new Date().toISOString(),
    };
  }

  /** The child's own exit status, from whichever of `exit` and `close`
      reports it first. It completes a cause recorded before the child ended;
      an exit during a release Delegatus asked for records none. */
  private noteChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitNoted) return;
    this.exitNoted = true;
    if (!this.endCause) {
      if (!this.releasing && !this.released) this.recordEnd("child-exit", this.terminalExit ?? CLAUDE_CHILD_EXITED, code, signal);
      return;
    }
    if (this.endCause.code === null && this.endCause.signal === null) {
      this.endCause = { ...this.endCause, code: code ?? null, signal: signal ?? null, signalledByHost: this.terminationStarted };
    }
  }

  private pendingToolUses(): Pick<HostState, "pendingToolUses"> {
    const pendingToolUses = [...this.attentions].flatMap(([id, attention]) => pendingToolUseFrom(id, attention) ?? []);
    return pendingToolUses.length ? { pendingToolUses } : {};
  }

  private pendingPermissions(): PendingPermissionRequest[] {
    for (const id of this.attentionSince.keys()) if (!this.attentions.has(id)) this.attentionSince.delete(id);
    const requests: PendingPermissionRequest[] = [];
    for (const [id, attention] of this.attentions) {
      const request = pendingPermissionFrom(id, attention, this.attentionSince.get(id) ?? new Date().toISOString());
      if (request) requests.push(request);
    }
    return requests;
  }

  private pendingQuestions(): PendingQuestionRequest[] {
    const requests: PendingQuestionRequest[] = [];
    for (const [id, attention] of this.attentions) {
      const request = pendingQuestionFrom(id, attention, this.attentionSince.get(id) ?? new Date().toISOString());
      if (request) requests.push(request);
    }
    return requests;
  }

  private restore(initialDeliveries: ClaudeDeliveryState[]): void {
    const stored = this.eventStore.load(this.identity.sessionId);
    /* The restore below reads the whole ledger once; only the window stays. */
    this.eventWindow.restore(stored);
    this.cursor = reconcileRuntimeEventCursor(
      this.identity.sessionId,
      stored.at(-1)?.seq ?? 0,
      this.cursor,
      this.onEventCursorRecovery,
    );
    for (const delivery of initialDeliveries) {
      const entry = normalizeQueueEntry(delivery.entry);
      this.deliveries.push({ ...delivery, ...(delivery.native ? { nativeReplayShape: nativeReplayShape(entry) } : {}),
        entry: delivery.nativeTerminal || delivery.nativeTurnBoundary || delivery.nativeNoWrite || delivery.delivered && delivery.confirmation !== "unverified" ? settledDeliveryEntry(entry) : entry });
    }
    this.nativeUncertain = this.deliveries.some(state => state.nativeUnverified || state.native && !state.nativeResult && !state.nativeNoWrite && !state.delivered);
    let restoredTurn: string | null = null;
    for (const event of stored) {
      if (event.kind === "turn-started") restoredTurn = event.turnId;
      if (event.kind === "turn-ended") this.lastResultUuid = event.claudeResultUuid ?? null;
      if (event.kind === "turn-ended" && event.turnId === restoredTurn) restoredTurn = null;
      if (event.kind === "attention") this.attentions.set(event.id, record(event.attention) ?? {});
      if (event.kind === "attention-resolved") this.attentions.delete(event.id);
      if (event.kind === "session-status" && (event.status === "dead" || event.status === "unhosted")) {
        // A host status is not a terminal outcome for its last started turn.
        this.attentions.clear();
      }
    }
    const projected = new Set(stored.filter(event => event.kind === "turn-ended").map(event => event.claudeResultUuid));
    const restoredProofs = new Set<string>();
    for (const state of this.deliveries) {
      const proof = state.nativeResult ?? state.nativeTerminal ?? state.nativeTurnBoundary;
      if (!proof || projected.has(proof.resultUuid) || restoredProofs.has(proof.resultUuid)) continue;
      restoredProofs.add(proof.resultUuid);
      this.emit({ kind: "turn-ended", turnId: proof.turnId, status: proof.status, claudeResultUuid: proof.resultUuid });
      if (restoredTurn === proof.turnId) restoredTurn = null;
    }
    if (restoredTurn) this.emit({ kind: "turn-ended", turnId: restoredTurn, status: "error" });
    for (const attentionId of this.attentions.keys()) {
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "host-restarted" });
    }
    this.attentions.clear();
  }

  private reconcileTranscript(users: ClaudeTranscriptUser[]): void {
    if (this.deliveries.some(state => state.nativeUnverified)) return;
    const reserved = new Set(this.deliveries.flatMap(state => state.native ? [state.native.inputUuid] : []));
    const alreadyClaimed = new Set(this.deliveries.filter((delivery) => delivery.delivered
      && delivery.confirmation !== "unverified" && delivery.engineMessageId)
      .map((delivery) => delivery.engineMessageId));
    const unmatched = users.filter((user) => user.uuid && !user.nativeIdentityInvalid && !alreadyClaimed.has(user.uuid) && !reserved.has(user.uuid)
      && !user.mergedSendUuids?.some(uuid => reserved.has(uuid)));
    const candidatesFor = (delivery: typeof this.deliveries[number]) => unmatched.filter((user) => {
        const queuedAt = delivery.queuedAt ? Date.parse(delivery.queuedAt) : Number.NEGATIVE_INFINITY;
        const timestamp = user.timestamp ? Date.parse(user.timestamp) : Number.POSITIVE_INFINITY;
        /* A real Claude transcript ends a tool-using turn with a `user` role
           message that carries only a `tool_result` block — no text, no image,
           no content digest. It can never match a queued delivery (every entry
           carries content), so it is skipped rather than digested: computing a
           digest from its empty text threw "message content is required" inside
           adopt() and failed the resume-successor spawn (production #389). */
        const digest = user.contentDigest ?? (user.text.trim() ? structuredContent(user.text, []).contentDigest : null);
        if (digest === null) return false;
        return matchesClaudeUserContent(delivery.entry, {
          contentDigest: digest,
          text: user.text,
          imageCount: user.imageCount ?? 0,
        }) && timestamp >= queuedAt;
      });
    for (const delivery of this.deliveries) {
      if (delivery.delivered || delivery.native || delivery.nativeUnverified) continue;
      const candidates = candidatesFor(delivery);
      if (candidates.length !== 1) continue;
      const [user] = candidates;
      const competingDeliveries = this.deliveries.filter((candidate) => (!candidate.delivered || candidate.confirmation === "unverified")
        && candidatesFor(candidate).some((match) => match.uuid === user?.uuid));
      if (competingDeliveries.length !== 1) continue;
      const confirmation = this.deliveryLedger.confirmDelivered(this.identity.sessionId, delivery.entry.id, user?.uuid ?? null, "inferred");
      if (confirmation === "refused") continue;
      if (this.memoryQueuePath) { try { fs.appendFileSync(this.memoryQueuePath + ".consumed", delivery.entry.id + "\n", { mode: 0o600 }); } catch { /* optional hook receipt */ } }
      delivery.delivered = true;
      delivery.engineMessageId = user?.uuid ?? null;
      delivery.confirmation = "inferred";
      delivery.entry = settledDeliveryEntry(delivery.entry);
      const index = unmatched.findIndex((candidate) => candidate.uuid === user?.uuid);
      if (index >= 0) unmatched.splice(index, 1);
    }
  }

  private emit(event: UnsequencedEvent): void {
    if (this.ledgerFailed) return;
    let nextCursor: number;
    try {
      nextCursor = nextRuntimeEventSequence(this.cursor);
    } catch (error) {
      this.ledgerFailed = true;
      this.failWithoutLedger(new Error(safeError(error)));
      return;
    }
    this.cursor = nextCursor;
    const sequenced = { ...event, seq: nextCursor } as RuntimeEvent;
    try { this.refillEventWindow(); this.eventStore.append(this.identity.sessionId, sequenced); }
    catch (error) {
      this.cursor = this.events.at(-1)?.seq ?? Math.max(0, this.cursor - 1);
      this.ledgerFailed = true;
      this.failWithoutLedger(new Error(`runtime event ledger failed: ${safeError(error)}`));
      return;
    }
    this.eventWindowRevision += 1;
    this.eventWindow.append(sequenced);
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(sequenced);
      subscriber.wake?.();
    }
    this.notifyStateListeners();
  }

  private acceptStdout(chunk: string): void {
    if (this.dead || this.released || this.nativeWriter && this.reaped) return;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail(new Error("Claude emitted an oversized JSONL frame"));
      if (line) {
        if (this.nativeWriter) {
          // Guards must observe arrival during an asynchronous intent append,
          // before this frame reaches the serialized reducer.
          let envelope: JsonObject | null = null;
          try { envelope = record(JSON.parse(line)); } catch { /* normal parser refuses it below */ }
          if (["control_request", "control_response", "control_cancel_request"].includes(String(envelope?.type))) {
            const handled = this.acceptMessage(line);
            if (handled) void handled.catch(error => this.noteNativeFailure("reducer", error));
            if (this.dead) return;
            newline = this.stdoutBuffer.indexOf("\n");
            continue;
          }
          const bytes = Buffer.byteLength(line);
          if (this.nativeQueuedBytes + bytes > MAX_LINE_BYTES + 4 * 1024 * 1024) return this.fail(new Error("Claude native evidence backlog exceeded its byte limit"));
          this.nativeQueuedBytes += bytes;
          const main = !!envelope && (envelope.session_id == null || envelope.session_id === this.identity.sessionId)
            && envelope.parent_tool_use_id == null && envelope.agent_id == null;
          const terminal = main && envelope?.session_id === this.identity.sessionId && envelope.type === "result";
          if (terminal) this.nativeBoundaryPending++;
          void this.enqueueNative(async () => {
            try { await this.acceptMessage(line); }
            finally { if (terminal) this.nativeBoundaryPending--; this.nativeQueuedBytes -= bytes; }
          }).catch(error => this.noteNativeFailure("reducer", error));
        } else this.acceptMessage(line);
      }
      if (this.dead) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) this.fail(new Error("Claude emitted an oversized JSONL frame"));
  }

  private acceptMessage(line: string): void | Promise<void> {
    if (this.released || this.dead) return;
    const receivedAt = new Date().toISOString();
    let message: JsonObject | null = null;
    try { message = record(JSON.parse(line)); } catch { /* handled below */ }
    if (!message) return this.fail(new Error("Claude emitted malformed stream JSON"));
    const type = stringField(message, "type");
    const sessionId = stringField(message, "session_id");
    if (sessionId && sessionId !== this.identity.sessionId) {
      if (this.nativeWriter) { this.nativeUncertain = this.nativeProtocolUncertain = true; return; }
      return this.fail(new Error("Claude emitted a different session id"));
    }
    if (type === "system" && message.subtype === "init") {
      if (message.apiKeySource !== "none") return this.fail(new Error("Claude stream process did not use subscription OAuth"));
      return;
    }
    /* Where a compaction is witnessed (#1214). The CLI announces the same
       boundary it writes to the transcript on this stream, so the evidence is
       already here: nothing tails the transcript for a second copy of it. */
    if (type === "system" && message.subtype === "compact_boundary") {
      this.settlePendingCompactions({ compactionId: stringField(message, "uuid") });
      return;
    }
    /* The CLI retrying a provider error inside the running turn (#2215): the
       one piece of evidence that a quiet turn waits on the provider. */
    if (type === "system" && message.subtype === "api_retry") {
      const now = Date.now();
      const delay = typeof message.retry_delay_ms === "number" && Number.isFinite(message.retry_delay_ms)
        ? Math.max(0, message.retry_delay_ms)
        : 0;
      this.providerRetry = {
        at: new Date(now).toISOString(),
        retryAt: new Date(now + delay).toISOString(),
        status: typeof message.error_status === "number" ? message.error_status : null,
        error: stringField(message, "error"),
      };
      this.notifyStateListeners();
      return;
    }
    if (this.providerRetry && (type === "stream_event" || type === "assistant" || type === "result" || type === "control_request")) {
      this.providerRetry = null;
    }
    if (type === "user" && this.nativeWriter && (this.deliveries.some(state => state.native && state.native.inputUuid === message.uuid)
      || !this.deliveries.some(state => !state.native && !state.nativeUnverified && this.pendingDeliveries.has(state.entry.id)))) {
      return this.acceptNativeReplay(message, receivedAt);
    }
    if (type === "user") {
      let echoOperationId: string | null = null;
      const content = messageContent(message);
      const directUserEcho = stringField(message.message, "role") === "user" && content !== null;
      const directMatches = directUserEcho && !this.deliveries.some(state => state.native && state.native.inputUuid === message.uuid || state.nativeUnverified)
        ? this.deliveries.filter((candidate) => (!candidate.delivered || candidate.confirmation === "unverified") && !candidate.native && !candidate.nativeUnverified && matchesClaudeUserContent(candidate.entry, {
            contentDigest: content.contentDigest,
            text: content.content.text,
            imageCount: content.content.images.length,
          }))
        : [];
      const delivery = directMatches.length === 1 ? directMatches[0] : undefined;
      if (delivery) {
        try {
          const confirmation = this.deliveryLedger.confirmDelivered(this.identity.sessionId, delivery.entry.id, stringField(message, "uuid"), "inferred");
          if (confirmation === "refused") {
            this.emit({ kind: "item", turnId: this.activeTurnId, item: sanitizedUserReplay(message, content), phase: "completed" });
            return;
          }
          echoOperationId = delivery.entry.id;
          if (this.memoryQueuePath) { try { fs.appendFileSync(this.memoryQueuePath + ".consumed", delivery.entry.id + "\n", { mode: 0o600 }); } catch { /* optional hook receipt */ } }
          delivery.delivered = true;
          delivery.engineMessageId = stringField(message, "uuid");
          delivery.confirmation = "inferred";
          delivery.entry = settledDeliveryEntry(delivery.entry);
          /* An echo ahead of the running turn's result means that turn read
             the input at a tool boundary. It owns no turn of its own, so it
             leaves the turn queue and the one result ends the running turn. */
          const waiting = this.turnQueue.indexOf(delivery.entry.id);
          const joinedTurnId = this.activeTurnId && this.activeTurnId !== delivery.entry.id && waiting >= 0
            && !this.backgroundTurn(this.activeTurnId) ? this.activeTurnId : null;
          if (joinedTurnId) {
            this.turnQueue.splice(waiting, 1);
            if (delivery.engineMessageId) this.joinedUserUuids.add(delivery.engineMessageId);
          }
          const pending = this.pendingDeliveries.get(delivery.entry.id);
          if (pending) {
            this.pendingDeliveries.delete(delivery.entry.id);
            if (pending.timer) clearTimeout(pending.timer);
            pending.resolve(joinedTurnId
              ? { outcome: "steered", turnId: joinedTurnId }
              : { outcome: delivery.disposition, turnId: delivery.entry.id });
          }
        } catch (error) {
          return this.failWithoutLedger(new Error(`Claude delivery ledger failed: ${safeError(error)}`));
        }
      }
      const attachedAt = echoOperationId ? new Date().toISOString() : undefined;
      this.emit({ kind: "item", turnId: this.activeTurnId, item: sanitizedUserReplay(message, content), phase: "completed", accountingAt: receivedAt,
        ...(echoOperationId ? { deliveryEcho: { operationId: echoOperationId, at: receivedAt, attachedAt,
          ...(delivery?.entry.parts ? { memberOperationIds: delivery.entry.parts.map(part => part.operationId) } : {}) } } : {}) });
      return;
    }
    if (type === "stream_event") {
      try { if (this.writerFence?.() === false) return; } catch { return; }
      const event = record(message.event);
      const main = this.mainAssistantEnvelope(message);
      if (event?.type === "message_start") {
        const assistant = record(event.message);
        this.assistantCandidate = main && assistant?.role === "assistant" && !this.manualCompaction
          ? { id: stringField(assistant, "id"), userUuid: stringField(message, "user_message_uuid") }
          : null;
        if (main && this.activeTurnId) this.partialTurns.delete(this.activeTurnId);
      }
      const candidate = main ? this.assistantCandidate : null;
      const delta = record(event?.delta);
      const text = stringField(delta, "text");
      if (candidate && ((event?.type === "content_block_delta" && delta?.type === "text_delta" && Boolean(text?.trim()))
        || (event?.type === "content_block_start" && this.meaningfulAssistantBlock(event.content_block)))) {
        this.startBackgroundTurn(candidate.id, candidate.userUuid);
      }
      if (event?.type === "content_block_delta" && text !== null) {
        if (this.activeTurnId) this.partialTurns.add(this.activeTurnId);
        this.emit({ kind: "delta", turnId: this.activeTurnId ?? "unknown", text });
      }
      if (main && event?.type === "message_stop") this.assistantCandidate = null;
      return;
    }
    if (type === "assistant") {
      try { if (this.writerFence?.() === false) return; } catch { return; }
      const assistant = record(message.message);
      if (this.mainAssistantEnvelope(message) && assistant?.role === "assistant"
        && Array.isArray(assistant.content) && assistant.content.some(block => this.meaningfulAssistantBlock(block))) {
        this.startBackgroundTurn(stringField(assistant, "id"), stringField(message, "user_message_uuid"));
      }
      const text = textContent(assistant?.content);
      if (text && (!this.activeTurnId || !this.partialTurns.has(this.activeTurnId))) {
        this.emit({ kind: "delta", turnId: this.activeTurnId ?? "unknown", text });
      }
      this.emit({ kind: "item", turnId: this.activeTurnId, item: message, phase: "completed", accountingAt: new Date().toISOString() });
      return;
    }
    if (type === "control_request") {
      const requestId = stringField(message, "request_id");
      if (!requestId) return this.fail(new Error("Claude control request had no request id"));
      const request = record(message.request) ?? {};
      this.attentions.set(requestId, request);
      this.attentionSince.set(requestId, new Date().toISOString());
      this.emit({ kind: "attention", id: requestId, method: stringField(request, "subtype") ?? "control_request", attention: request });
      return;
    }
    if (type === "control_cancel_request") {
      const requestId = stringField(message, "request_id");
      if (!requestId) return this.fail(new Error("Claude control cancellation had no request id"));
      if (!this.attentions.has(requestId)) return;
      const pending = this.pendingAnswers.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAnswers.delete(requestId);
        pending.reject(new Error("Claude attention was cancelled before answer confirmation"));
      }
      this.attentions.delete(requestId);
      this.emit({ kind: "attention-resolved", id: requestId, resolution: "server-resolved" });
      return;
    }
    if (type === "control_response") {
      const response = record(message.response) ?? message;
      const requestId = stringField(response, "request_id");
      if (!requestId) return;
      const answer = this.pendingAnswers.get(requestId);
      if (answer) {
        clearTimeout(answer.timer);
        this.pendingAnswers.delete(requestId);
        this.attentions.delete(requestId);
          if (response.subtype === "error") {
          answer.reject(new Error("Claude attention answer failed"));
          this.emit({ kind: "attention-resolved", id: requestId, resolution: "server-resolved" });
        } else {
          answer.resolve();
          this.emit({ kind: "attention-resolved", id: requestId, resolution: "answered" });
        }
        return;
      }
      const pending = this.pendingControls.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingControls.delete(requestId);
      if (response.subtype === "error") pending.reject(new Error(`Claude control request failed: ${safeError(response.error ?? "unknown error")}`));
      else {
        if (pending.interruptTurnId) this.interruptedTurns.add(pending.interruptTurnId);
        pending.resolve(record(response.response) ?? {});
      }
      return;
    }
    if (type === "result") {
      if (this.nativeWriter && this.deliveries.some(state => state.native && this.turnQueue.includes(state.entry.id)
        || claudeNativeUuid(message.uuid) && (state.nativeResult ?? state.nativeTerminal ?? state.nativeTurnBoundary)?.resultUuid === message.uuid)) return this.acceptNativeResult(message);
      this.acceptResult(message);
    }
  }

  private mainAssistantEnvelope(message: JsonObject): boolean {
    return message.parent_tool_use_id == null && message.agent_id == null
      && message.error == null && message.aborted !== true;
  }

  private meaningfulAssistantBlock(value: unknown): boolean {
    const block = record(value);
    if (block?.type === "text") return Boolean(stringField(block, "text")?.trim());
    return block?.type === "tool_use" && Boolean(stringField(block, "id")?.trim())
      && Boolean(stringField(block, "name")?.trim()) && record(block.input) !== null;
  }

  private backgroundTurn(turnId: string | null): boolean {
    return turnId?.startsWith(CLAUDE_BACKGROUND_TURN_PREFIX) === true;
  }

  private startBackgroundTurn(messageId: string | null, userUuid: string | null): void {
    if (this.manualCompaction || this.unavailable(true)) return;
    if (this.activeTurnId) {
      this.activeUserUuid ??= userUuid;
      return;
    }
    const token = messageId ? `message:${messageId}` : `sequence:${this.cursor + 1}`;
    const digest = crypto.createHash("sha256").update(JSON.stringify([this.identity.sessionId, token])).digest("hex");
    this.activeTurnId = `${CLAUDE_BACKGROUND_TURN_PREFIX}${digest}`;
    this.activeUserUuid = userUuid;
    this.emit({ kind: "turn-started", turnId: this.activeTurnId, accountingAt: new Date().toISOString() });
  }

  private acceptResult(message: JsonObject): void {
    // Transcript reconciliation cannot substitute a singular synthetic result
    // for the native batch reducer's full membership and writer evidence.
    if (this.nativeWriter && this.deliveries.some(state => state.native && this.turnQueue.includes(state.entry.id))) return;
    // A result can still arrive while an owned release waits for reap.
    try { if (this.writerFence?.() === false) return; } catch { return; }
    const nativeUuid = stringField(message, "uuid");
    const resultUuid = nativeUuid && nativeUuid.length <= 128 ? nativeUuid : null;
    if (resultUuid && resultUuid === this.lastResultUuid) return;
    // A foreground delivery can already own a turn despite the queue barrier.
    // Its result retains that ownership; compact frames cannot start a turn.
    if (this.manualCompaction && !this.activeTurnId) {
      this.settleCompaction(this.manualCompaction, new StructuredCompactError(CLAUDE_COMPACT_DECLINED_REASON, "refused"));
      this.manualCompaction = null;
      this.assistantCandidate = null;
      return;
    }
    const turnId = this.activeTurnId;
    if (!turnId) {
      this.assistantCandidate = null;
      return;
    }
    const userUuid = stringField(message, "user_message_uuid");
    if (userUuid) {
      const deliveredUserUuid = this.deliveries.find(delivery => delivery.entry.id === turnId)?.engineMessageId;
      const expectedUserUuid = deliveredUserUuid ?? this.activeUserUuid;
      if (!this.joinedUserUuids.has(userUuid) && ((expectedUserUuid && userUuid !== expectedUserUuid)
        || this.deliveries.some(delivery => delivery.entry.id !== turnId && delivery.engineMessageId === userUuid))) return;
    }
    const interrupted = this.interruptedTurns.has(turnId);
    const status = interrupted || message.subtype === "interrupted"
      ? "interrupted"
      : message.subtype === "success" && message.is_error !== true ? "completed" : "error";
    this.emit({ kind: "turn-ended", turnId, status, accountingAt: new Date().toISOString(), ...(resultUuid ? { claudeResultUuid: resultUuid } : {}) });
    if (this.ledgerFailed) return;
    this.lastResultUuid = resultUuid;
    if (this.turnQueue[0] === turnId) this.turnQueue.shift();
    this.finishResultTurn(turnId);
  }

  private finishResultTurn(turnId: string): void {
    this.partialTurns.delete(turnId);
    this.interruptedTurns.delete(turnId);
    this.joinedUserUuids.clear();
    this.assistantCandidate = null;
    this.activeUserUuid = null;
    /* Issue #765: a `result` proves the CLI's turn is over, so any control
       request it left unanswered can never be answered — the await behind it
       died with the turn. Claude sends no `control_cancel_request` on this
       path (an interrupt cuts the turn, not the request), which stranded the
       question card as pinned-forever "awaiting input". Retire the leftovers
       the same way an explicit cancellation does. */
    for (const attentionId of this.attentions.keys()) {
      const pending = this.pendingAnswers.get(attentionId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAnswers.delete(attentionId);
        pending.reject(new Error("Claude attention expired with its turn before answer confirmation"));
      }
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "turn-ended" });
    }
    this.attentions.clear();
    this.activeTurnId = this.turnQueue[0] ?? null;
    if (this.activeTurnId) this.armDeliveryConfirmation(this.activeTurnId);
    if (this.activeTurnId) this.emit({ kind: "turn-started", turnId: this.activeTurnId });
    else this.emit({ kind: "session-status", status: "idle" });
  }

  private write(message: JsonObject): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) {
      const failure = new Error(`Claude stream stdin failed: ${safeError(error)}`);
      this.fail(failure);
      throw failure;
    }
  }

  private async releaseAndReap(): Promise<void> {
    this.releasing = true;
    /* Pending work hears "released" only from `finishRelease`, once the child
       is reaped. A stop that cannot prove the child ended says so instead, so
       no receipt reads "released" beside a process still writing (#2790). */
    if (!await this.startTermination() && this.releaseFence) {
      this.releasing = false;
      throw new Error("Claude child identity changed before signalling");
    }
    /* A tree that could not be recorded whole was not signalled at all: the
       child still runs, its stream intact, and the release is refused rather
       than leaving a process nothing could name afterwards. */
    if (!this.terminationStarted && !this.reaped) {
      this.releasing = false;
      throw new Error(CLAUDE_TREE_UNCAPTURED);
    }
    if (!await this.waitForReap(this.shutdownGraceMs * 2)) {
      if (!this.signalReleaseGroup("SIGKILL") && this.releaseFence) {
        this.releasing = false;
        throw new Error("Claude child identity changed before signalling");
      }
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        /* "close" waits on the stdio pipes, which an escaped descendant can
           hold open long after the leader died — a kill that keeps failing
           with an unreapable child wedges the session's terminal receipt
           forever. The recorded exit evidence is authoritative: when the
           leader is gone, destroy our pipe ends and settle the reap. */
        const leaderExited = nativeProcessId(this.child) === undefined
          || (this.child.exitCode ?? null) !== null
          || (this.child.signalCode ?? null) !== null;
        if (!leaderExited) {
          this.rejectPending(new Error(CLAUDE_RELEASE_UNCONFIRMED));
          throw new Error("Claude child could not be reaped");
        }
        for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
          try { stream?.destroy(); } catch { /* pipe already closed */ }
        }
        this.reaped = true;
        if (this.terminationTimer) {
          clearTimeout(this.terminationTimer);
          this.terminationTimer = null;
        }
        this.resolveReaped();
      }
    }
    await this.joinNativePersistence();
    this.finishRelease();
  }

  /** Settle only the turn whose start was published. Queued inputs retain
      their existing delivery evidence; termination cannot confirm them. */
  private endActiveTurn(): void {
    this.assistantCandidate = null;
    this.activeUserUuid = null;
    this.manualCompaction = null;
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.turnQueue.length = 0;
    this.partialTurns.clear();
    this.interruptedTurns.clear();
    if (turnId) this.emit({ kind: "turn-ended", turnId, status: "error" });
  }

  private finishRelease(): void {
    if (this.released) return;
    this.released = true;
    this.releasing = false;
    this.endActiveTurn();
    this.attentions.clear();
    this.rejectPending(new Error("Claude stream host released"));
    this.emit({ kind: "session-status", status: "unhosted" });
    if (this.ledgerFailed) this.notifyStateListeners();
    this.closeSubscribers();
    this.memoryCell?.close();
    const cleanup = this.releaseCleanup;
    this.releaseCleanup = null;
    cleanup?.();
  }

  private async waitForReap(timeoutMs: number): Promise<boolean> {
    if (this.reaped) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reapedPromise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    if (this.dead || this.released) return;
    this.recordEnd("host-fault", error.message, null, null);
    this.dead = true;
    this.endActiveTurn();
    this.attentions.clear();
    this.rejectPending(error);
    this.emit({ kind: "session-status", status: "dead" });
    this.closeSubscribers();
    void this.startTermination();
  }

  private failWithoutLedger(error: Error): void {
    this.assistantCandidate = null;
    this.activeUserUuid = null;
    this.manualCompaction = null;
    if (this.dead || this.released) {
      console.warn("[structured host] terminal event persistence failed", { reason: safeError(error) });
    }
    if (this.released) {
      this.notifyStateListeners();
      this.closeSubscribers();
      return;
    }
    if (this.dead) {
      this.notifyStateListeners();
      return;
    }
    this.recordEnd("host-fault", error.message, null, null);
    this.ledgerFailed = true;
    this.dead = true;
    this.activeTurnId = null;
    this.attentions.clear();
    this.rejectPending(error);
    this.notifyStateListeners();
    this.closeSubscribers();
    void this.startTermination();
  }

  private releaseFenceHolds(): boolean {
    const expected = this.releaseFence;
    if (!expected) return true;
    const pid = nativeProcessId(this.child);
    return Boolean(pid) && expected.startIdentity !== null
      && pid === expected.pid
      && this.childStartIdentity === expected.startIdentity
      && this.processIdentity(pid!) === expected.startIdentity;
  }

  private signalReleaseGroup(signal: NodeJS.Signals): boolean {
    // The memory cell owns fatal OOM cleanup through its unit or verified tree.
    if (this.memoryCell?.fatalMemoryExit) return true;
    if (!this.releaseFenceHolds()) return false;
    const record = () => recordHostStop(this.exitProcess, signal, this.dead ? "claude-host-fault" : "claude-host-release");
    const protectedSignal = signalAgentDomain(this.child, signal, record);
    if (protectedSignal !== undefined) return protectedSignal;
    const withdraw = record();
    if (!this.releaseFenceHolds()) { withdraw?.(); return false; }
    const signalled = signalDetachedProcessGroup(this.child, signal, this.signalProcess);
    if (!signalled) withdraw?.();
    return signalled;
  }

  /** Hands the child's process tree to the termination listener before the
      first stop effect, and true once nothing more is owed: no listener, a
      tree read whole with nothing in it, or a listener that recorded it. A
      read that names a running pid without its identity, a read that threw,
      and a listener that refused or threw all answer false, and the stop
      sends nothing (#2790). */
  private async captureTerminationTree(): Promise<boolean> {
    const listener = this.terminationCapture;
    const pid = nativeProcessId(this.child);
    if (!listener || this.treeCaptured || !pid) return true;
    let capture: ProcessTreeCapture;
    try { capture = this.captureProcessTree(pid); } catch { return false; }
    if (capture.unresolved.length > 0) return false;
    if (capture.identities.length > 0) {
      let recorded = false;
      try { recorded = await listener(pid, capture.identities) === true; } catch { recorded = false; }
      // Health names the engine PID even when its launcher is a sandbox wrapper.
      if (!recorded || this.terminationCapture !== listener || this.currentState().pid !== pid || !this.releaseFenceHolds()) return false;
      // Admission lets the child run. A new descendant must be captured on a
      // later attempt before any signal can make its parent disappear.
      let current: ProcessTreeCapture;
      try { current = this.captureProcessTree(pid); } catch { return false; }
      const captured = new Set(capture.identities.map(identity => `${identity.pid}:${identity.startIdentity}:${identity.bootEpoch ?? ""}`));
      if (current.unresolved.length > 0 || current.identities.some(identity => !captured.has(`${identity.pid}:${identity.startIdentity}:${identity.bootEpoch ?? ""}`))) return false;
    }
    this.treeCaptured = true;
    return true;
  }

  /** A failed stream cannot be kept, so its stop is asked again until the
      tree is recorded. Meanwhile the child keeps running under its recorded
      identity, which is itself what refuses a successor's claim. */
  private retryTerminationCapture(): void {
    if (this.captureRetryTimer || this.reaped || !this.dead) return;
    this.captureRetryTimer = setTimeout(() => {
      this.captureRetryTimer = null;
      if (this.reaped || this.terminationStarted) return;
      void this.startTermination();
    }, this.terminationCaptureRetryMs);
    this.captureRetryTimer.unref?.();
  }

  private clearCaptureRetry(): void {
    if (!this.captureRetryTimer) return;
    clearTimeout(this.captureRetryTimer);
    this.captureRetryTimer = null;
  }

  private terminationPending: Promise<boolean> | null = null;

  private startTermination(): Promise<boolean> {
    if (this.terminationPending) return this.terminationPending;
    const pending = this.startTerminationAdmitted();
    this.terminationPending = pending;
    const clear = () => { if (this.terminationPending === pending) this.terminationPending = null; };
    void pending.then(clear, clear);
    return pending;
  }

  private async startTerminationAdmitted(): Promise<boolean> {
    if (this.memoryCell?.fatalMemoryExit) {
      if (this.terminationTimer) clearTimeout(this.terminationTimer);
      this.terminationTimer = null;
      for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.destroy();
      this.reaped = true;
      this.resolveReaped();
      this.terminationStarted = true;
      return true;
    }
    if (this.terminationStarted || this.reaped) return true;
    /* Nothing is sent, stdin included, until the tree is on record. */
    if (this.releaseFenceHolds() && !await this.captureTerminationTree()) {
      this.retryTerminationCapture();
      return true;
    }
    if (this.terminationStarted || this.reaped) return true;
    if (!this.releaseFenceHolds()) return false;
    this.clearCaptureRetry();
    let withdrawEof: (() => void) | undefined;
    if (!this.reaped && this.childStartIdentity !== null && this.processIdentity(nativeProcessId(this.child)!) === this.childStartIdentity
      && !procBackend.processExited(nativeProcessId(this.child)!)) withdrawEof = recordHostStop(this.exitProcess, "EOF", "claude-host-release");
    try { this.child.stdin.end(); } catch { withdrawEof?.(); }
    if (!this.signalReleaseGroup("SIGTERM")) return false;
    this.terminationStarted = true;
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (this.reaped) return;
      this.signalReleaseGroup("SIGKILL");
    }, this.shutdownGraceMs);
    return true;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingDeliveries.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pendingDeliveries.clear();
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pendingControls.clear();
    for (const pending of this.pendingAnswers.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pendingAnswers.clear();
    /* A `/compact` that was already typed into the conversation cannot be
       taken back, and a host that goes away mid-compaction proves nothing
       about what became of it — which is exactly the unobserved outcome. */
    this.settlePendingCompactions(
      new StructuredCompactError(CLAUDE_COMPACT_UNOBSERVED_REASON, "unverified"),
    );
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
  }

  private notifyStateListeners(): void {
    const state = this.currentState();
    for (const listener of this.stateListeners) listener(state);
  }
}

function boundedEndReason(reason: string): string {
  return Array.from(safeError(reason)).slice(0, HOST_END_REASON_MAX_CHARS).join("");
}
