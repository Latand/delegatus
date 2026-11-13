import { cacheAgentObservation, clearAgentObservations } from "./projectionCache";
import { listenForAgentStateInvalidation } from "./invalidation";
import { statePath } from "@/lib/configDir";
import { hotStateWriterRevision } from "@/lib/state/hotStateAuthority";
import { blockingHostActivityFlags } from "@/lib/runtime/hostActivityFlags";
import { observeAgentProcess } from "./process";
import fs from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";
import { agentRegistry, structuredClaimIdentity, type AgentRegistry, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { registryCollectionPage, registryConversationsForEntryKey, registryRowsMatching, registryKeysMatchingBounded } from "@/lib/agent/sqliteRegistryStore";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { yieldToRuntime } from "@/lib/cooperative";
import { AGENT_STATE_POLICY, evaluateAgentState, fact, unknown, type AgentFacts, type AgentProjection, type Evidence, type NativeTurn } from "./model";
import { AgentTranscriptCache, fileSignature } from "./transcript";
import { acknowledgeAgentProjection, artifactRevision, commitAgentObservation, conversationRevision, entryRevision,
  readAgentProjection, readAgentStateMetrics, subjectId, copyAgentStateRow, recordAgentProcessEnded, pruneTerminalAgentProjection } from "./store";

const digest = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const AGENT_STATE_INTERVAL_MS = AGENT_STATE_POLICY.reconcileMs;
type Memory = { activeTurnRef: string | null; pendingAttention: string[]; eventCursor: number; nativeTurnId?: string | null; promptOrdinal?: number | null; startedAt?: number | null; attentionUnverified?: boolean };
export interface AgentStatePorts {
  registry: AgentRegistry;
  now: () => number;
  owns: () => boolean;
  process: (identity: ProcessIdentity) => "alive" | "dead" | "unverified";
  memory: (entry: AgentRegistryEntry, conversationId: string | null) => Memory | null;
  publish: (projection: AgentProjection, current: () => boolean) => Promise<boolean>;
  release: string;
  settleMemory?: (entry: AgentRegistryEntry, conversationId: string | null, turn: NativeTurn) => boolean;
}
function snapshotFacts(file: RegistryFile, entry: AgentRegistryEntry) {
  const conversations = registryConversationsForEntryKey(file, sessionKeyId(entry.key));
  const conversation = conversations.find(row => row.generations.at(-1)?.id === entry.key.sessionId) ?? conversations[0];
  const ids = conversations.map(row => row.id);
  const receiptKeys = registryKeysMatchingBounded(file, "receipts", [
    { field: "key.sessionId", value: entry.key.sessionId },
    { field: "state", value: ["starting", "path-pending", "pane-bound", "host-verified", "prompt-delivered"] },
  ], 33);
  const receipts = receiptKeys.map(key => file.receipts[key]!).filter(row => row.key?.engine === entry.key.engine);
  const deliveryKeys = ids.length ? registryKeysMatchingBounded(file, "heldDeliveries", [
    { field: "conversationId", value: ids }, { field: "state", value: ["held", "assigned", "delivery-uncertain"] },
  ], 33) : [];
  const deliveries = deliveryKeys.map(key => file.heldDeliveries[key]!);
  const ownerKeys = ids.length ? registryKeysMatchingBounded(file, "deliveryOperationOwners", [
    { field: "conversationId", value: ids }, { field: "custodyState", value: "pending" },
  ], 33) : [];
  const owners = ownerKeys.map(key => file.deliveryOperationOwners[key]!);
  const obligations = [
    ...(entry.pendingAction ? [`pending-${entry.pendingAction}`] : []),
    ...receipts.filter(row => !["completed", "failed", "conflicted"].includes(row.state)).map(row => `launch:${row.state}`),
    ...deliveries.filter(row => row.state !== "delivered").map(row => `delivery:${row.state}`),
    ...owners.filter(row => !row.terminalState).map(() => "delivery-owner"),
    ...((entry.structuredTerminationSurvivors?.length ?? 0) ? ["retained-descendants"] : []),
  ];
  return { conversationId: conversation?.id ?? null, conversationRevision: conversationRevision(file, entry),
    conversationCurrent: conversation?.generations.at(-1)?.id === entry.key.sessionId, conversationTurnState: conversation?.turn.state ?? null,
    obligationsComplete: Math.max(receiptKeys.length, deliveryKeys.length, ownerKeys.length) < 33,
    obligations, obligationsRevision: digest([receipts, deliveries, owners]),
    artifactBound: Boolean(conversations.some(row => row.generations.some(g => g.id === entry.key.sessionId && g.path === entry.artifactPath))) };
}
export class AgentStateService {
  readonly cache = new AgentTranscriptCache();
  private running: Promise<void> | null = null;
  private readonly rssSamples = new Map<string, { bytes: number; at: number }>();
  private generation = 0;
  private readonly invalidated = new Set<string>();
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null;
  private unlisten: (() => void) | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dueTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly due = new Map<string, number>();
  private readonly writer = captureProcessIdentity(process.pid);
  constructor(readonly ports: AgentStatePorts) {}
  start(schedule: typeof setInterval = setInterval): void {
    if (this.timer) return;
    this.stopped = false;
    this.unlisten = listenForAgentStateInvalidation((filename, key) => {
      if (filename === this.ports.registry.filename) this.invalidate(sessionKeyId(key));
    });
    this.timer = schedule(() => { void this.request().catch(error => console.error("[agent state] reconciliation failed", error)); }, AGENT_STATE_INTERVAL_MS);
    this.timer.unref?.();
    void this.request().catch(error => console.error("[agent state] startup failed", error));
  }
  stop(): void {
    this.stopped = true; this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unlisten?.(); this.unlisten = null;
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    this.invalidationTimer = null; this.invalidated.clear();
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null; this.due.clear(); this.cache.clear(); clearAgentObservations();
  }
  invalidate(entryKey: string): void {
    if (this.stopped || !this.ports.owns()) return;
    if (this.invalidated.size < 4096) this.invalidated.add(entryKey);
    if (this.invalidationTimer) return;
    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = null;
      if (this.running) { this.invalidate(entryKey); return; }
      const generation = this.generation;
      const allowed = () => !this.stopped && this.generation === generation && this.ports.owns();
      const keys = [...this.invalidated].slice(0, 32);
      for (const key of keys) this.invalidated.delete(key);
      const pending = withViewerOperation("agents.reconcile", async () => {
        for (let offset = 0; offset < keys.length && allowed(); offset += 4) {
          const entries = this.ports.registry.agentStateRead(file => keys.slice(offset, offset + 4)
            .flatMap(key => file.entries[key]?.structuredHost?.process ? [copyAgentStateRow(file.entries[key]!)] : []));
          const results = await Promise.allSettled(entries.map(entry => this.reconcile(entry, allowed)));
          for (const result of results) if (result.status === "rejected") console.error("[agent state] changed subject deferred", result.reason);
          await yieldToRuntime();
        }
      });
      this.running = pending;
      void pending.finally(() => {
        if (this.running === pending) this.running = null;
        this.armDueWake();
        const next = this.invalidated.values().next().value;
        if (next) this.invalidate(next);
      }).catch(error => console.error("[agent state] changed refresh failed", error));
    }, 100);
    this.invalidationTimer.unref?.();
  }
  observeResourceSample(rows: readonly { agentState?: { subject: string }; rssBytes: number }[], at: number): void {
    if (!Number.isFinite(at)) return;
    for (const row of rows) {
      if (!row.agentState || !Number.isFinite(row.rssBytes) || row.rssBytes < 0) continue;
      this.rssSamples.delete(row.agentState.subject);
      this.rssSamples.set(row.agentState.subject, { bytes: row.rssBytes, at });
    }
    while (this.rssSamples.size > 4096) this.rssSamples.delete(this.rssSamples.keys().next().value!);
  }
  request(): Promise<void> {
    if (this.running) return this.running;
    const pending = new Promise<void>(resolve => setImmediate(resolve)).then(() => withViewerOperation("agents.reconcile", () => this.cycle()));
    this.running = pending;
    void pending.finally(() => { if (this.running === pending) { this.running = null; this.armDueWake(); } }).catch(() => undefined);
    return pending;
  }
  private async cycle(): Promise<void> {
    const generation = this.generation;
    const allowed = () => !this.stopped && this.generation === generation && this.ports.owns();
    if (!allowed()) return;
    const { registry, now } = this.ports;
    const started = performance.now();
    const cursor = readAgentStateMetrics(registry).afterKey;
    const entries = registry.agentStateRead(file => registryRowsMatching(file, "entries", "structuredHost.kind",
      ["codex-app-server", "claude-broker", "copilot-acp"]).filter(row => row.structuredHost?.process).map(row => copyAgentStateRow(row)))
      .sort((a, b) => sessionKeyId(a.key).localeCompare(sessionKeyId(b.key)));
    const after = cursor === null ? 0 : entries.findIndex(row => sessionKeyId(row.key) > cursor);
    const start = after < 0 ? 0 : after;
    const ordered = entries.slice(start);
    let examined = 0;
    // A completed suffix cannot erase failures from the earlier pages of a
    // scan interrupted by its budget or a serving-process restart.
    let failures = cursor === null ? 0 : registry.agentStateRead(file => file.agentStateMetrics.scanProgress?.subjectsDeferred ?? 1);
    for (let page = 0; page < ordered.length && allowed() && performance.now() - started < 30_000; page += 32) {
      const batch = ordered.slice(page, page + 32);
      for (let offset = 0; offset < batch.length && allowed(); offset += 4) {
        const results = await Promise.allSettled(batch.slice(offset, offset + 4).map(entry => this.reconcile(entry, allowed)));
        for (const result of results) if (result.status === "rejected" || result.value === null || result.value.verdict.missing.length > 0) {
          failures++; if (result.status === "rejected") console.error("[agent state] subject deferred", result.reason);
        }
        examined += Math.min(4, batch.length - offset);
        await yieldToRuntime();
      }
      if (!allowed()) return;
      await registry.deliveryWriteOrBusy({ label: "agent-state.cursor" }, () => {
        if (!allowed()) return;
        registry.agentStateWrite(file => {
          const metrics = file.agentStateMetrics.current ?? readAgentStateMetrics(registry);
          metrics.afterKey = sessionKeyId(batch.at(-1)!.key);
          metrics.subjectsDeferred = Math.max(0, ordered.length - examined) + failures;
          file.agentStateMetrics.current = metrics;
          file.agentStateMetrics.scanProgress = { ...metrics, subjectsDeferred: failures };
        });
      });
    }
    if (!allowed()) return;
    const maintenanceAfter = registry.agentStateRead(file => file.agentStateMetrics.maintenance?.afterKey ?? "");
    const maintenance = registry.agentStateRead(file => registryCollectionPage(file, "agentStates", maintenanceAfter, 32)
      .map(key => copyAgentStateRow(file.agentStates[key]!)));
    for (const row of maintenance) {
      if (!allowed()) return;
      const identity = row.facts.process.determined ? row.facts.process.value.identity : null;
      if (identity && row.verdict.state !== "dead" && this.ports.process(identity) === "dead") {
        await registry.deliveryWriteOrBusy({ label: "agent-state.ended" }, () => recordAgentProcessEnded(registry, row, {
          version: 1, id: `${String(now()).padStart(14, "0")}:${digest([row.subject, "process-ended"]).slice(0, 40)}`,
          subject: row.subject, at: now(), from: row.verdict.state, to: "dead", reason: "recorded process ended; retained obligations preserved",
          divergence: null, writer: this.writer, release: this.ports.release, evidence: [row.facts.process.evidence],
        }, () => allowed() && this.ports.process(identity) === "dead"));
      }
      if (row.verdict.state === "dead") await registry.deliveryWriteOrBusy({ label: "agent-state.prune" }, () => {
        if (allowed()) pruneTerminalAgentProjection(registry, row.subject, now(), allowed);
      });
      await yieldToRuntime();
    }
    if (!allowed()) return;
    const complete = examined === ordered.length;
    await registry.deliveryWriteOrBusy({ label: "agent-state.cycle" }, () => {
      if (!allowed()) return;
      registry.agentStateWrite(file => {
        const metrics = file.agentStateMetrics.current ?? readAgentStateMetrics(registry);
        metrics.at = now();
        if (complete) { metrics.afterKey = null; if (!failures) metrics.lastCompleteReconciliationAt = now(); metrics.subjectsDeferred = failures; }
        file.agentStateMetrics.current = metrics;
        file.agentStateMetrics.scanProgress = { ...metrics, subjectsDeferred: complete ? 0 : failures };
        file.agentStateMetrics.maintenance = { ...metrics, afterKey: maintenance.length === 32 ? maintenance.at(-1)!.subject : null };
        const sampleKey = `series:${String(Math.floor(now() / 60_000)).padStart(14, "0")}`;
        file.agentStateMetrics[sampleKey] = { ...metrics };
        // Prune a bounded page per cycle. Totals outlive journal/series rows.
        const journalPage = registryCollectionPage(file, "agentStateJournal", file.agentStateMetrics.journalMaintenance?.afterKey ?? "", 256);
        for (const key of journalPage) {
          if (file.agentStateJournal[key]!.at < now() - 7 * 86400_000 || metrics.journalRows > 16384) {
            delete file.agentStateJournal[key]; metrics.journalRows = Math.max(0, metrics.journalRows - 1);
          }
        }
        file.agentStateMetrics.journalMaintenance = { ...metrics, afterKey: journalPage.length === 256 ? journalPage.at(-1)! : null };
        for (const key of registryCollectionPage(file, "agentStateMetrics", "series:", 256)) {
          if (key.startsWith("series:") && file.agentStateMetrics[key]!.at < now() - 86400_000) delete file.agentStateMetrics[key];
        }
      });
    });
  }
  private armDueWake(): void {
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
    if (!this.timer || !this.due.size || this.stopped) return;
    const next = Math.min(...this.due.values());
    this.dueTimer = setTimeout(() => { this.dueTimer = null; void this.request().catch(error => console.error("[agent state] due refresh failed", error)); }, Math.max(1, next - this.ports.now()));
    this.dueTimer.unref?.();
  }
  async reconcile(entry: AgentRegistryEntry, allowed = () => !this.stopped && this.ports.owns()): Promise<AgentProjection | null> {
    const { registry, now } = this.ports;
    const process = entry.structuredHost?.process;
    if (!process || !allowed()) return null;
    const revision = entryRevision(entry);
    const source = registry.agentStateRead(file => snapshotFacts(file, entry));
    const previous = readAgentProjection(registry, subjectId(entry));
    if (previous?.facts.revision === revision) this.cache.seed({ engine: entry.key.engine, path: entry.artifactPath ?? "", revision: artifactRevision(entry), anchor: entry.structuredHost!.agentStateNativePromptAnchor },
      { turn: previous.facts.turn, transcript: previous.facts.transcript });
    const native = await this.cache.acquire({ engine: entry.key.engine, path: entry.artifactPath ?? "", revision: artifactRevision(entry),
      localRef: entry.structuredHost!.activeTurnRef, observedAt: now(), anchor: entry.structuredHost!.agentStateNativePromptAnchor });
    if (!allowed()) return null;
    const ledgerPath = entry.key.engine === "claude" && entry.structuredHost!.activeTurnRef && (!native.turn.determined || native.turn.value.nativeId !== entry.structuredHost!.agentStateNativeTurnId)
      ? statePath("structured-host-events", `${encodeURIComponent(entry.key.sessionId)}.jsonl`) : null;
    const ledger = ledgerPath ? await this.cache.acquire({ engine: "claude-ledger", path: ledgerPath, revision: artifactRevision(entry),
      localRef: entry.structuredHost!.activeTurnRef, observedAt: now() }) : null;
    if (!allowed()) return null;
    const current = registry.hostEntry(entry.key);
    if (!current || entryRevision(current) !== revision) return null;
    const observedAt = now();
    const ev = (source: Evidence["source"], ref: string, volatile = false): Evidence => ({ source, observedAt, subjectRevision: revision, ref,
      ...(volatile ? { validUntil: observedAt + AGENT_STATE_POLICY.observationMs } : {}) });
    const processStatus = this.ports.process(process);
    const processFact: AgentFacts["process"] = processStatus === "unverified" ? unknown("process identity unavailable", ev("proc", "process", true))
      : fact({ status: processStatus, identity: process }, ev("proc", "process", true));
    const claimIdentity = entry.claimOwner ? structuredClaimIdentity(entry.claimOwner) : null;
    const claimStatus = claimIdentity ? this.ports.process(claimIdentity) : "unverified";
    const candidateMemory = source.conversationCurrent ? this.ports.memory(entry, source.conversationId) : null;
    const memory = claimIdentity && claimStatus === "alive" && entry.structuredHost!.writerClaimEpoch === entry.claimEpoch
      && candidateMemory && candidateMemory.eventCursor >= entry.structuredHost!.eventCursor ? candidateMemory : null;
    let owner: AgentFacts["owner"];
    if (memory && entry.structuredHost!.writerClaimEpoch === entry.claimEpoch) owner = fact("held", ev("host-memory", "writer", true));
    else if (entry.claimOwner === null) owner = fact("absent", ev("registry-cache", "released", true));
    else {
      const identity = structuredClaimIdentity(entry.claimOwner);
      const status = identity ? this.ports.process(identity) : "unverified";
      owner = status === "dead" ? fact("absent", ev("proc", "writer-ended", true)) : unknown("holder binding cannot be verified", ev("proc", "writer", true));
    }
    let turn = native.turn;
    if (!source.artifactBound) turn = unknown("artifact-generation binding unverified", ev("registry-cache", "binding"));
    if (memory) {
      // Host memory wins over a delayed native page. Incompatible current
      // memory remains an explicit divergence and cannot grant an effect.
      const startedAt = memory.startedAt ?? entry.structuredHost!.agentStateTurnStartedAt
        ?? (previous?.facts.turn.determined && previous.facts.turn.value.localRef === memory.activeTurnRef ? previous.facts.turn.value.at : null)
        ?? Date.parse(entry.updatedAt);
      const nativeOpening = native.turn.determined && native.turn.value.state === "open" && (entry.key.engine === "claude"
        ? native.turn.value.nativeId === memory.nativeTurnId : entry.key.engine === "copilot" ? native.turn.value.promptOrdinal === memory.promptOrdinal : true);
      const provisional = memory.activeTurnRef !== null && entry.key.engine !== "codex" && !nativeOpening;
      turn = fact({ state: memory.activeTurnRef ? "open" : "closed", nativeId: entry.key.engine === "codex" ? memory.activeTurnRef : memory.nativeTurnId ?? null,
        localRef: memory.activeTurnRef, opening: provisional ? "accepted" : nativeOpening && native.turn.determined ? native.turn.value.opening : null,
        closing: memory.activeTurnRef ? null : "host-terminal", at: memory.activeTurnRef ? startedAt : native.turn.determined ? native.turn.value.at : null, tools: 0 },
        { ...ev("host-memory", `seq:${memory.eventCursor}`), ...(provisional ? { validUntil: startedAt + AGENT_STATE_POLICY.startupGraceMs } : {}) });
    }
    const localRef = memory?.activeTurnRef ?? entry.structuredHost!.activeTurnRef;
    const idleMemoryNativeOpen = Boolean(memory && memory.activeTurnRef === null && source.artifactBound
      && native.turn.determined && native.turn.value.state === "open");
    if (idleMemoryNativeOpen) {
      // A live host's idle snapshot cannot prove that its native turn ended.
      // Keep the transcript's opposing evidence visible and block effects until
      // a later observation establishes the order of the two boundaries.
      turn = unknown("host-memory-idle-conflicts-with-native-open-turn", ev("native-transcript", "open-turn"));
    }
    const nativeClosed = native.turn.determined && native.turn.value.state === "closed";
    const correlation = nativeClosed && source.artifactBound && (entry.key.engine === "codex"
      ? native.turn.determined && native.turn.value.nativeId === localRef
      : entry.key.engine === "claude"
        ? native.turn.determined && (entry.structuredHost!.agentStateNativeTurnId != null || ledger?.turn.determined)
          && (native.turn.value.nativeId === entry.structuredHost!.agentStateNativeTurnId || ledger?.turn.determined && native.turn.value.nativeId === ledger.turn.value.nativeId)
        : native.turn.determined && entry.structuredHost!.agentStateNativePromptOrdinal != null && entry.structuredHost!.agentStateNativePromptAnchor != null
          && native.turn.value.promptOrdinal === entry.structuredHost!.agentStateNativePromptOrdinal);
    const currentMemoryBoundary = !memory || entry.key.engine === "codex"
      || entry.key.engine === "claude" && (memory.nativeTurnId != null && native.turn.determined && native.turn.value.nativeId === memory.nativeTurnId)
      || entry.key.engine === "copilot" && (memory.promptOrdinal != null && native.turn.determined && native.turn.value.promptOrdinal === memory.promptOrdinal);
    if (localRef !== null && nativeClosed && !correlation && !memory) turn = unknown("boundary-unresolved", ev("native-transcript", "correlation"));
    const superseded = entry.key.engine === "codex" && source.artifactBound && native.turn.determined && native.turn.value.state === "open"
      && native.turn.value.nativeId !== null && native.turn.value.nativeId !== localRef && native.turn.value.opening !== null;
    const repair = Boolean(localRef !== null && owner.determined && (owner.value === "absent" && (correlation || superseded)
      || owner.value === "held" && correlation && currentMemoryBoundary && memory?.pendingAttention.length === 0
        && !memory.attentionUnverified && Boolean(this.ports.settleMemory)));
    let divergence = idleMemoryNativeOpen ? "native-open-memory-idle"
      : localRef !== null && (nativeClosed && correlation || superseded)
        ? (repair ? superseded ? "native-start-superseded-cache" : "native-terminal-cache-open" : "boundary-unresolved") : null;
    const attention = memory?.pendingAttention ?? entry.structuredHost!.agentStateAttention?.pending ?? entry.structuredHost!.pendingAttention;
    const attentionUnverified = memory?.attentionUnverified ?? entry.structuredHost!.agentStateAttention?.unverified ?? false;
    const facts: AgentFacts = { subject: subjectId(entry), engine: entry.key.engine, revision, process: processFact, owner, turn,
      attention: attentionUnverified || entry.structuredHost!.attentionVerified === false || attention.length > 16 || attention.some(ref => ref.length > 128) ? unknown("attention evidence missing", ev("registry-cache", "attention"))
        : fact(attention.slice(0, 32), ev(memory ? "host-memory" : "registry-cache", "attention", Boolean(memory))),
      activity: native.turn.determined ? fact({ tools: native.turn.value.tools,
        flags: blockingHostActivityFlags(entry.structuredHost!.activeFlags).slice(0, 16).map(flag => flag.slice(0, 64)),
        providerRetry: native.turn.value.state === "open" && Boolean(entry.structuredHost!.providerRetry) }, ev(memory ? "host-memory" : "registry-cache", "activity"))
        : unknown("native activity boundary unavailable", ev("native-transcript", "activity")), transcript: native.transcript, obligations: !source.obligationsComplete || source.obligations.length > 32 ? unknown("obligation coverage truncated", ev("operation-ledger", "obligations"))
        : fact(source.obligations, ev("operation-ledger", "obligations")) };
    if (repair && native.turn.determined) facts.turn = fact({ ...native.turn.value, localRef: null }, native.turn.evidence);
    const repairConversation = source.conversationCurrent && owner.determined && owner.value === "absent" && facts.turn.determined
      && facts.turn.evidence.source === "native-transcript" && (facts.turn.value.state === "open" ? source.conversationTurnState !== "busy"
        : !["terminal", "idle"].includes(source.conversationTurnState ?? "unknown"));
    if (repairConversation && !divergence) divergence = "native-turn-conversation-cache";
    const rss = this.rssSamples.get(facts.subject);
    const measuredRss = rss && observedAt >= rss.at && observedAt - rss.at < AGENT_STATE_INTERVAL_MS ? rss : null;
    const projection: AgentProjection = { version: 1, subject: facts.subject, entryKey: sessionKeyId(entry.key), conversationId: source.conversationId,
      facts, verdict: evaluateAgentState(facts, observedAt), revision: 0, pendingPublication: false, publishable: source.conversationCurrent && facts.process.determined && facts.owner.determined && facts.turn.determined, divergence,
      divergenceKey: divergence ? digest([facts.subject, revision, source.conversationRevision, native.transcript.determined ? native.transcript.value.signature : "unknown"]) : previous?.divergenceKey ?? null, rssBytes: measuredRss?.bytes ?? null, ...(measuredRss ? { rssCapturedAt: measuredRss.at } : {}) };
    const eventId = `${String(observedAt).padStart(14, "0")}:${digest([facts.subject, revision, native.transcript.determined ? native.transcript.value.signature : "unknown", projection.verdict.state, divergence]).slice(0, 40)}`;
    const guard = () => {
      if (!allowed() || this.ports.process(process) !== processStatus) return false;
      if (claimIdentity && this.ports.process(claimIdentity) !== claimStatus) return false;
      const latest = registry.hostEntry(entry.key);
      if (!latest || entryRevision(latest) !== revision) return false;
      if (registry.agentStateRead(file => snapshotFacts(file, latest).obligationsRevision) !== source.obligationsRevision) return false;
      if (digest(source.conversationCurrent ? this.ports.memory(latest, source.conversationId) : null) !== digest(candidateMemory)) return false;
      if (entry.claimOwner) {
        const identity = structuredClaimIdentity(entry.claimOwner);
        if (owner.determined && owner.value === "absent" && (!identity || this.ports.process(identity) !== "dead")) return false;
      }
      if (ledgerPath && ledger?.transcript.determined) {
        try { if (fileSignature(fs.statSync(ledgerPath, { bigint: true })) !== ledger.transcript.value.signature) return false; }
        catch { return false; }
      }
      if (native.transcript.determined) {
        try { if (fileSignature(fs.statSync(entry.artifactPath!, { bigint: true })) !== native.transcript.value.signature) return false; }
        catch { return false; }
      }
      return true;
    };
    const committed = await registry.deliveryWriteOrBusy({ label: "agent-state.reconcile" }, () => {
      const committed = commitAgentObservation(registry,
      { entry, conversationRevision: source.conversationRevision, projection, repair, repairConversation,
        journal: { version: 1, id: eventId, subject: facts.subject, at: observedAt, from: null, to: projection.verdict.state,
          reason: divergence ?? projection.verdict.reason, divergence, writer: this.writer, release: this.ports.release,
          evidence: [facts.process.evidence, facts.owner.evidence, facts.turn.evidence,
            ...(idleMemoryNativeOpen ? [ev("host-memory", `seq:${memory!.eventCursor}`)] : []),
            ...(ledger?.turn.determined ? [ledger.turn.evidence] : [])] } }, guard);
      // No await separates the committed repair from its host-memory adapter.
      // A journal insertion refusal therefore has no native-memory effects.
      if (committed && repair && owner.determined && owner.value === "held" && native.turn.determined) {
        this.ports.settleMemory?.(entry, source.conversationId, { ...native.turn.value, localRef });
      }
      return committed;
    });
    if (committed) {
      // Persist only semantic changes; renew volatile observations in this
      // bounded cache so no-op passes can still authorize a fresh idle check.
      if (entryRevision(registry.hostEntry(entry.key) ?? entry) === committed.facts.revision) cacheAgentObservation({
        ...committed, facts: { ...facts, revision: committed.facts.revision },
        verdict: { ...projection.verdict, projectionRevision: committed.revision },
      });
      const due = committed.facts.turn.determined && committed.facts.turn.value.state === "open" && committed.facts.transcript.determined
        ? committed.facts.transcript.value.mtimeMs + AGENT_STATE_POLICY.stuckMs : null;
      this.due.delete(committed.subject);
      if (due !== null && due > now()) this.due.set(committed.subject, due);
      while (this.due.size > 4096) this.due.delete(this.due.keys().next().value!);
    }
    if (committed && allowed() && committed.pendingPublication) {
      const publicationEntry = registry.hostEntry(entry.key);
      const publicationSource = publicationEntry ? registry.agentStateRead(file => snapshotFacts(file, publicationEntry)) : null;
      const publicationMemory = digest(publicationEntry ? this.ports.memory(publicationEntry, committed.conversationId) : null);
      const stillCurrent = () => allowed() && readAgentProjection(registry, committed.subject)?.revision === committed.revision
        && (() => {
          const row = registry.hostEntry(entry.key);
          if (!row || entryRevision(row) !== committed.facts.revision || this.ports.process(process) !== processStatus) return false;
          if (claimIdentity && this.ports.process(claimIdentity) !== claimStatus) return false;
          const currentSource = registry.agentStateRead(file => snapshotFacts(file, row));
          if (!publicationSource || !currentSource.conversationCurrent || currentSource.conversationId !== committed.conversationId
            || currentSource.conversationRevision !== publicationSource.conversationRevision
            || currentSource.obligationsRevision !== publicationSource.obligationsRevision) return false;
          if (digest(this.ports.memory(row, committed.conversationId)) !== publicationMemory) return false;
          const held = this.ports.memory(row, committed.conversationId);
          if (held && committed.facts.turn.determined && held.activeTurnRef !== committed.facts.turn.value.localRef) return false;
          if (committed.facts.transcript.determined) {
            try { return fileSignature(fs.statSync(row.artifactPath!, { bigint: true })) === committed.facts.transcript.value.signature; }
            catch { return false; }
          }
          return true;
        })();
      if (await this.ports.publish(committed, stillCurrent) && stillCurrent()) {
        await registry.deliveryWriteOrBusy({ label: "agent-state.publish-ack" }, () => {
          if (stillCurrent()) acknowledgeAgentProjection(registry, committed.subject, committed.revision, now());
        });
      }
    }
    return committed;
  }
}

const global = process as typeof process & { __llvAgentStateService?: AgentStateService; __llvAgentStateGeneration?: number };
export function servingAgentStateService(): AgentStateService | null { return global.__llvAgentStateService ?? null; }
export async function startAgentStateService(): Promise<void> {
  if (global.__llvAgentStateService) return;
  const generation = global.__llvAgentStateGeneration ?? 0;
  const controller = await import("@/lib/runtime/structuredDeliveryController");
  const { runtimeHostClient, readRuntimeSession } = await import("@/lib/runtime/client");
  const registry = agentRegistry();
  const owns = () => viewerReleaseOwnsTraffic() && controller.structuredDeliveryPublicationState() === "ready";
  const service = new AgentStateService({ registry, now: Date.now, owns, process: observeAgentProcess,
    release: hotStateWriterRevision(dirname(registry.filename)) ?? "unknown",
    memory: (entry, conversationId) => {
      if (!conversationId) return null;
      const held = controller.structuredDeliveryHostForConversation(conversationId, registry);
      const owner = entry.claimOwner ? structuredClaimIdentity(entry.claimOwner) : null;
      return held && owner?.pid === process.pid && processIdentityStatus(owner) === "alive"
        && entry.structuredHost?.writerClaimEpoch === entry.claimEpoch ? held.agentStateMemory?.() ?? null : null;
    },
    settleMemory: (entry, conversationId, turn) => {
      if (!conversationId || !turn.localRef || turn.at === null) return false;
      const held = controller.structuredDeliveryHostForConversation(conversationId, registry);
      return held?.reconcileAgentStateTerminal?.(turn.localRef, turn.nativeId, turn.at, turn.outcome) ?? false;
    },
    publish: async (projection, current) => {
      const client = runtimeHostClient();
      if (!client || !projection.conversationId || !current()) return false;
      const session = await readRuntimeSession(client, { conversationId: projection.conversationId });
      if (!current() || !session || sessionKeyId(session.sessionKey) !== projection.entryKey) return false;
      const entry = registry.agentStateRead(file => file.entries[projection.entryKey]);
      if (!entry || !projection.facts.turn.determined || !projection.facts.owner.determined || !projection.facts.process.determined) return false;
      const writerClaim = entry.claimOwner ? `${entry.claimOwner}:${entry.structuredHost!.writerClaimEpoch}` : null;
      if (session.writerClaim && writerClaim !== session.writerClaim) return false;
      await controller.publishStructuredHostProjection(client, { scope: { type: "session", id: projection.conversationId }, kind: "session-status",
        expectedSessionRevision: session.revision,
        producer: { kind: "viewer", eventKey: `agent-state:${projection.subject}:${projection.revision}` },
        payload: { conversationId: projection.conversationId, sessionKey: entry.key,
          host: projection.facts.process.determined && projection.facts.process.value.status === "dead" ? "dead" : projection.facts.owner.determined && projection.facts.owner.value === "held" ? "hosted" : "unhosted",
          turn: projection.facts.turn.value.state === "open" ? "running" : "idle",
          activeTurnId: projection.facts.turn.value.localRef, writerClaim, reconciliationRevision: projection.revision } });
      return current();
    } });
  // Publication may still be rebinding when startup installs controllers.
  // Keep the scheduler armed; each cycle refuses work until serving custody
  // is ready. A demotion during the imports revokes this pending installation.
  if ((global.__llvAgentStateGeneration ?? 0) !== generation) return;
  global.__llvAgentStateService = service;
  service.start();
}
export function stopAgentStateService(): void {
  global.__llvAgentStateGeneration = (global.__llvAgentStateGeneration ?? 0) + 1;
  global.__llvAgentStateService?.stop();
  delete global.__llvAgentStateService;
}
