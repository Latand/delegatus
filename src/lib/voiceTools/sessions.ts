import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { performanceSpans } from "@/lib/performanceSpans";
import { digest, voiceToolBounds, type Tool } from "./contracts";
import { prepareLaunch, voiceToolEnvironment, voiceToolHub } from "./hub";
import { EMPTY_VOICE_TOOLS, findSnapshotTool, type VoiceToolCalls, type VoiceToolOutcome, type VoiceToolOutcomeCode, type VoiceToolSnapshot,
  type VoiceToolSnapshotServer } from "./snapshot";
import { VoiceToolsError, type VoiceToolsStore } from "./store";

type Schedule = (callback: () => void, milliseconds: number) => () => void;
type WorkerResult = { status: "done" | "failed"; code?: VoiceToolOutcomeCode; content?: string; omitted?: string[]; images?: Array<{ mime: string; data: string }> };
interface Live {
  name: string; title: string; approval: string;
  state: "starting" | "ready" | "closed";
  /** Why it closed first: a revocation, or the server or its worker going away. */
  closedBy?: VoiceToolOutcomeCode;
  ready: Promise<void>;
  child?: ChildProcess; input?: Writable; runRoot?: string;
  /** Approved tools the live server no longer lists (§3.7): calling one fails with a plain message. */
  removed: Set<string>;
  pending: Map<string, (result: WorkerResult) => void>;
  /** One call at a time per server, so each call's incoming bytes are bounded on their own. */
  chain: Promise<unknown>;
  /** Open voice calls that took this server. */
  calls: Set<string>;
  idle?: () => void; afterCalls?: () => void;
}
export interface VoiceToolSessionOptions {
  schedule?: Schedule;
  /** Children the hub runs for other work (dry runs); all of them share one cap of eight. */
  busy?(): number;
  /** v1 servers belong to the owner (design §8, question 5): a member's call gets them only as the team owner. */
  isOwner?(memberId: string): boolean;
}
const SPEECH: Record<VoiceToolOutcomeCode, (title: string) => string> = {
  TOOL_NOT_ALLOWED: () => "That tool is not available in this call. Nothing was run.",
  TOOL_REVOKED: title => `${title} was removed from the voice tools. Nothing was run.`,
  TOOL_REMOVED: title => `${title} no longer offers this tool. Nothing was run.`,
  INVALID_TOOL_ARGUMENTS: title => `The arguments do not match what ${title} accepts. Nothing was run.`,
  TOOL_SERVER_UNAVAILABLE: title => `${title} did not start.`,
  TOOL_TIMEOUT: title => `${title} did not answer in time.`,
  TOOL_ERROR: title => `${title} reported an error.`,
};
const failed = (code: VoiceToolOutcomeCode, title: string, speech = SPEECH[code](title)): VoiceToolOutcome => ({ status: "failed", code, speech });
const codeOf = (error: unknown): string => error instanceof VoiceToolsError ? error.code : error instanceof Error ? error.message : "START_FAILED";

/**
 * The hub's voice side (design §4.2): one leased worker per approved server, shared by the open voice calls that
 * took it, each started through the same sandboxed launch as the dry run. Nothing here reads the registry file:
 * snapshots, revocation and session input come from the store's memory, and revocation arrives by commit.
 */
export class VoiceToolSessions implements VoiceToolCalls {
  private readonly live = new Map<string, Live>();
  private readonly calls = new Map<string, { failures: Map<string, number> }>();
  private readonly schedule: Schedule;
  constructor(private readonly store: VoiceToolsStore, private readonly options: VoiceToolSessionOptions = {}) {
    this.schedule = options.schedule ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref?.(); return () => clearTimeout(timer); });
    store.onCommit(() => this.reconcile());
  }
  /** Children running for voice calls. */
  get size(): number { return this.live.size; }
  snapshot(starter: { memberId: string } | { operator: true } | undefined): VoiceToolSnapshot {
    const visible = !!starter && ("operator" in starter || this.options.isOwner?.(starter.memberId) === true);
    return visible ? this.store.snapshot() : EMPTY_VOICE_TOOLS;
  }
  secrets(snapshot: VoiceToolSnapshot): string[] { return this.store.secretValues(snapshot.servers.map(server => server.name)); }
  open(callId: string, snapshot: VoiceToolSnapshot): void {
    if (!this.calls.has(callId)) this.calls.set(callId, { failures: new Map() });
    // Warm-up never delays the start; a tool call that arrives first waits for it under its own deadline.
    for (const server of snapshot.servers) if (server.transport === "stdio") void this.ensure(callId, server).catch(() => undefined);
  }
  close(callId: string): void {
    this.calls.delete(callId);
    for (const live of this.live.values()) {
      if (!live.calls.delete(callId) || live.calls.size) continue;
      live.afterCalls?.();
      live.afterCalls = this.schedule(() => this.stop(live, "TOOL_REVOKED"), voiceToolBounds.afterCallMs);
    }
  }
  async call(callId: string, snapshot: VoiceToolSnapshot, wire: string, args: unknown, signal?: AbortSignal): Promise<VoiceToolOutcome> {
    const found = findSnapshotTool(snapshot, wire);
    if (!found) return failed("TOOL_NOT_ALLOWED", "");
    const { server, tool } = found;
    // Revocation blocks the next dispatch, even inside a call that took the server earlier (§3.5 step 2).
    const current = this.store.serving(server.name);
    if (!current || current.approval!.digest !== server.approvalDigest || !current.tools[tool.tool]?.enabled) return failed("TOOL_REVOKED", server.title);
    if (!args || typeof args !== "object" || Array.isArray(args) || [...JSON.stringify(args)].length > 64_000) return failed("INVALID_TOOL_ARGUMENTS", server.title);
    const record = this.calls.get(callId);
    if (!record) return failed("TOOL_REVOKED", server.title, "This call has ended. Nothing was run.");
    if ((record.failures.get(server.name) ?? 0) >= voiceToolBounds.startFailures)
      return failed("TOOL_SERVER_UNAVAILABLE", server.title, `${server.title} is unavailable for the rest of this call.`);
    return performanceSpans.wait("voice-tools.call", async () => {
      let live: Live;
      try { live = await this.deadline(this.ensure(callId, server), voiceToolBounds.coldStartMs, signal); }
      catch (error) {
        const code = codeOf(error);
        return code === "TOOL_REVOKED" ? failed("TOOL_REVOKED", server.title) : failed("TOOL_SERVER_UNAVAILABLE", server.title);
      }
      if (live.removed.has(tool.tool)) return failed("TOOL_REMOVED", server.title);
      // Idle time starts again when this call is answered; it never runs out under a call in flight.
      live.idle?.(); live.idle = undefined;
      const result = await this.dispatch(live, tool.tool, args, server.callTimeoutMs, signal);
      this.idleAfter(live);
      if (result.status === "done") return { status: "done", content: result.content ?? "", ...(result.omitted?.length ? { omitted: result.omitted } : {}),
        ...(result.images?.length ? { images: result.images } : {}), speech: `${server.title} answered.${result.omitted?.length ? ` Omitted: ${result.omitted.join(", ")}.` : ""}` };
      const code = result.code && Object.hasOwn(SPEECH, result.code) ? result.code : "TOOL_ERROR";
      return { ...failed(code, server.title, code === "TOOL_SERVER_UNAVAILABLE" ? `${server.title} stopped while working.` : undefined),
        ...(code === "TOOL_ERROR" && result.content ? { content: result.content } : {}) };
    });
  }
  /** Ends every child and waits for each to close: the Viewer is stopping, or a test is done. */
  async stopAll(): Promise<void> {
    for (const live of [...this.live.values()]) this.stop(live, "TOOL_REVOKED");
    await Promise.all(this.closing);
  }
  /** Children told to stop whose guardian has not closed yet. */
  private readonly closing = new Set<Promise<void>>();

  private deadline<T>(work: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = this.schedule(() => reject(new VoiceToolsError("TOOL_TIMEOUT")), milliseconds);
      const abort = () => reject(new VoiceToolsError("TOOL_TIMEOUT"));
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => { cancel(); signal?.removeEventListener("abort", abort); });
    });
  }
  private ensure(callId: string, server: VoiceToolSnapshotServer): Promise<Live> {
    let live = this.live.get(server.name);
    if (live && (live.approval !== server.approvalDigest || live.state === "closed")) { this.stop(live, "TOOL_REVOKED"); live = undefined; }
    if (!live) {
      if (this.live.size + (this.options.busy?.() ?? 0) >= voiceToolBounds.children) {
        // Make room from a server no open call holds and no call is waiting on; else this one cannot start now.
        const idle = [...this.live.values()].find(row => !row.calls.size && !row.pending.size);
        if (!idle) return Promise.reject(new VoiceToolsError("BUSY"));
        this.stop(idle, "TOOL_REVOKED");
      }
      live = this.start(server);
      this.live.set(server.name, live);
    }
    live.calls.add(callId);
    live.afterCalls?.(); live.afterCalls = undefined;
    const started = live;
    return started.ready.then(() => started);
  }
  private start(server: VoiceToolSnapshotServer): Live {
    const live: Live = { name: server.name, title: server.title, approval: server.approvalDigest, state: "starting", ready: Promise.resolve(),
      removed: new Set(), pending: new Map(), chain: Promise.resolve(), calls: new Set() };
    live.ready = performanceSpans.wait("voice-tools.spawn", () => this.launch(live, server)).catch(error => {
      // A failed start counts once for every call that was waiting for it (§4.2: two within a call make it unavailable).
      for (const callId of live.calls) {
        const failures = this.calls.get(callId)?.failures;
        failures?.set(server.name, (failures.get(server.name) ?? 0) + 1);
      }
      this.stop(live, "TOOL_SERVER_UNAVAILABLE");
      throw error;
    });
    void live.ready.catch(() => undefined);
    return live;
  }
  private async launch(live: Live, server: VoiceToolSnapshotServer): Promise<void> {
    let input = this.store.sessionInput(server.name, server.approvalDigest);
    const prepared = await prepareLaunch(this.store.directory, server.name, input.server);
    live.runRoot = prepared.runRoot;
    if (prepared.stdio === null) throw new VoiceToolsError("START_FAILED");
    // Preparation awaited disk I/O: the approval and credential bindings are read again before dispatch.
    input = this.store.sessionInput(server.name, server.approvalDigest);
    if (live.closedBy) throw new VoiceToolsError("TOOL_REVOKED");
    const child = live.child = spawnLeasedHelper("voice-tools-session", { command: prepared.executable.executable, args: [prepared.executable.worker],
      cwd: process.cwd(), env: voiceToolEnvironment(prepared.home, process.env) }, this.store.directory, { input: true, stdout: "pipe", stderr: "ignore" });
    const pipe = live.input = leasedHelperInput(child);
    pipe.on("error", () => this.stop(live, "TOOL_SERVER_UNAVAILABLE"));
    let first!: (line: Record<string, unknown> | null) => void;
    const opened = new Promise<Record<string, unknown> | null>(resolve => { first = resolve; });
    let buffer = Buffer.alloc(0);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line.toString("utf8")); } catch { this.stop(live, "TOOL_SERVER_UNAVAILABLE"); return; }
        if (message?.type === "result" && typeof message.id === "string") live.pending.get(message.id)?.(message as unknown as WorkerResult);
        else first(message);
      }
      // A worker line is bounded: 16 KB of text and three images at most.
      if (buffer.length > voiceToolBounds.callLineBytes) this.stop(live, "TOOL_SERVER_UNAVAILABLE");
    });
    child.once("close", () => { first(null); this.stop(live, "TOOL_SERVER_UNAVAILABLE"); });
    child.once("error", () => { first(null); this.stop(live, "TOOL_SERVER_UNAVAILABLE"); });
    const approved = Object.fromEntries(server.tools.map(tool => [tool.tool, tool.inputSchema]));
    // Secrets cross the owned pipe only, never argv, logs or the helper record.
    pipe.write(JSON.stringify({ mode: "session", name: server.name, server: input.server, secrets: input.secrets, policies: input.policies,
      home: prepared.home, launch: prepared.stdio ?? null, approved }) + "\n");
    const message = await opened;
    if (live.closedBy === "TOOL_REVOKED") throw new VoiceToolsError("TOOL_REVOKED");
    if (message?.type !== "ready" || live.closedBy) {
      if (message?.code === "ENTRY_CHANGED") void this.store.markChanged(server.name, server.approvalDigest, true).catch(() => undefined);
      throw new VoiceToolsError(typeof message?.code === "string" ? message.code : "START_FAILED");
    }
    this.drift(live, input.server.catalog?.tools ?? [], Array.isArray(message.tools) ? message.tools as Tool[] : null);
    live.state = "ready";
    this.idleAfter(live);
  }
  /** A server stops after five minutes without calls (§4.2). */
  private idleAfter(live: Live): void {
    live.idle?.();
    live.idle = this.schedule(() => this.stop(live, "TOOL_REVOKED"), voiceToolBounds.idleMs);
  }
  /** Live `tools/list` against the approved catalog: added tools stay hidden, a changed or missing one marks the server changed. */
  private drift(live: Live, approved: Tool[], listed: Tool[] | null): void {
    const shape = (tool: Tool) => digest({ description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations ?? null });
    let changed = listed === null;
    for (const tool of approved) {
      const now = listed?.find(row => row.name === tool.name);
      if (listed && !now) { live.removed.add(tool.name); changed = true; }
      else if (now && shape(now) !== shape(tool)) changed = true;
    }
    if (changed) void this.store.markChanged(live.name, live.approval, false).catch(() => undefined);
  }
  private dispatch(live: Live, tool: string, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResult> {
    let resolve!: (result: WorkerResult) => void;
    const answered = new Promise<WorkerResult>(done => { resolve = done; });
    let id: string | undefined;
    let settled = false;
    const finish = (result: WorkerResult) => {
      if (settled) return;
      settled = true; if (id) live.pending.delete(id); cancel(); signal?.removeEventListener("abort", expire);
      resolve(result);
    };
    // One deadline from the moment the call is asked, a wait behind an earlier call to the same server included.
    // A call already sent is cancelled in the worker, which sends MCP notifications/cancelled.
    const expire = () => {
      if (id) try { live.input?.write(JSON.stringify({ type: "cancel", id }) + "\n"); } catch { /* the close handler answers */ }
      finish({ status: "failed", code: "TOOL_TIMEOUT" });
    };
    const cancel = this.schedule(expire, timeoutMs);
    if (signal?.aborted) expire();
    else signal?.addEventListener("abort", expire, { once: true });
    const run = () => {
      if (settled) return answered;
      if (live.state === "closed" || !live.input) { finish({ status: "failed", code: live.closedBy ?? "TOOL_SERVER_UNAVAILABLE" }); return answered; }
      id = randomUUID();
      live.pending.set(id, finish);
      try { live.input.write(JSON.stringify({ type: "call", id, tool, arguments: args, timeoutMs }) + "\n"); }
      catch { finish({ status: "failed", code: "TOOL_SERVER_UNAVAILABLE" }); }
      return answered;
    };
    // The next call to this server goes out once this one is answered or given up.
    live.chain = live.chain.then(run, run).catch(() => undefined);
    return answered;
  }
  /** After a committed registry write: a server whose approval no longer stands loses its running child. */
  private reconcile(): void {
    for (const live of [...this.live.values()]) {
      const current = this.store.serving(live.name);
      if (!current || current.approval!.digest !== live.approval) this.stop(live, "TOOL_REVOKED");
    }
  }
  private stop(live: Live, code: VoiceToolOutcomeCode): void {
    if (this.live.get(live.name) === live) this.live.delete(live.name);
    if (live.state === "closed") return;
    live.state = "closed"; live.closedBy = code;
    live.idle?.(); live.afterCalls?.();
    for (const finish of [...live.pending.values()]) finish({ status: "failed", code });
    // Closing the pipe ends the session; the guardian ends the whole process group.
    try { live.input?.end(); } catch { /* already closed */ }
    const child = live.child, runRoot = live.runRoot;
    const closed = !child || child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise<void>(resolve => child.once("close", () => resolve()));
    if (child) endLeasedHelper(child);
    const done = closed.then(() => runRoot ? fs.rm(runRoot, { recursive: true, force: true }) : undefined).catch(() => undefined).then(() => { this.closing.delete(done); });
    this.closing.add(done);
  }
}

const shared = globalThis as typeof globalThis & { __voiceToolSessions?: VoiceToolSessions };
/** The Viewer's one session owner, beside the hub that runs dry runs; both share the cap of eight children. */
export function voiceToolSessions(isOwner?: (memberId: string) => boolean): VoiceToolSessions {
  if (shared.__voiceToolSessions) return shared.__voiceToolSessions;
  const hub = voiceToolHub();
  const sessions = new VoiceToolSessions(hub.store, { busy: () => hub.running, isOwner });
  hub.otherChildren = () => sessions.size;
  return shared.__voiceToolSessions = sessions;
}
export function setVoiceToolSessionsForTests(value: VoiceToolSessions | undefined): void { shared.__voiceToolSessions = value; }
