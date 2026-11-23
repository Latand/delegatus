import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { afterEach, beforeEach, spyOn } from "bun:test";
import * as pinnedProtocol from "@/lib/accounts/codexPinnedProtocol";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";
import { type RuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { parseCodexFeatures, setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import type { NativeQueuedSubmission } from "./nativeCodexQueue";

export const COMPACT_SELECTED: SelectedContextRef = { version: 1, state: "selected", conversationId: "conversation_marker_fixture", capturedAt: "2026-09-22T00:00:00.000Z" };

export const DENIED_FEATURE_ARGS = ["-c", "agents.enabled=false", "-c", 'approvals_reviewer="user"', "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-c", "features.future_worker=false", "-c", "features.collab=false", "-c", "features.plugins=false"];

export function deliveryDedup(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

export class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();

  load(threadId: string): RuntimeEvent[] {
    return structuredClone(this.events.get(threadId) ?? []);
  }

  append(threadId: string, event: RuntimeEvent): void {
    const events = this.events.get(threadId) ?? [];
    events.push(structuredClone(event));
    this.events.set(threadId, events);
  }
}

export function modelNegotiationServer(threadId: string, defaultModel = "text-model") {
  const server = new FakeAppServer(threadId);
  server.modelList = ["text-model", "image-model"].map(id => ({ id, model: id, isDefault: id === defaultModel, inputModalities: id === "image-model" ? ["text", "image"] : ["text"] }));
  return server;
}

export const MODEL_NEGOTIATION_IMAGE = { sha256: "a".repeat(64), mime: "image/png" as const, bytes: 67 };

export class FailingEventStore implements RuntimeEventStore {
  readonly stored: RuntimeEvent[] = [];
  appendAttempts = 0;

  load(): RuntimeEvent[] {
    return structuredClone(this.stored);
  }

  append(_threadId: string, event: RuntimeEvent): void {
    this.appendAttempts += 1;
    if (this.appendAttempts >= 2) throw new Error("ENOSPC oauth_token=must-stay-private");
    this.stored.push(structuredClone(event));
  }
}

export class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly signals: NodeJS.Signals[] = [];
  viewerStatus: unknown[] = [{ name: "viewer", tools: { stage_report: {} } }];
  requireViewerThread = false;
  beforeViewerStatus: (() => void) | null = null;
  autoResolveServerRequests = true;
  autoCompleteUserMessage = true;
  steerError: { code: number; message: string; data?: unknown } | null = null;
  holdSteer = false;
  /** Persist the recipient-side user record while withholding the app-server
      confirmation, reproducing a successful delivery whose confirmation is
      lost during a host respawn. */
  persistUserMessages = false;
  readTurns: unknown[] | null = null;
  readError: string | null = null;
  turnsError: string | null = null;
  userAgent = "codex_desktop_app/0.144.1 (Linux)";
  paginatedHistory = false;
  nativeQueueItems: NativeQueuedSubmission[] = [];
  nativeQueueStartError: string | null = null;
  beforeNativeQueueStart: (() => void) | null = null;
  nativeQueueListNotification: { method: string; params: Record<string, unknown> } | null = null;
  /* Rejects only hydrated reads (includeTurns), the way codex 0.151+ paginated
     threads do; metadata-only reads and thread/turns/list keep answering. */
  hydratedReadError: string | null = null;
  /* Rejects full-history thread/resume the way paginated threads do; a resume
     with excludeTurns succeeds and omits thread.turns. */
  paginatedResume = false;
  shellPolicy: Record<string, unknown> = {};
  features: Record<string, unknown> = {};
  mcpServers: Record<string, unknown> = {
    playwright: { command: "npx", enabled: true },
    "telegram-readonly": { command: "uv", enabled: true },
  };
  modelList: unknown[] = [{ id: "gpt-5.3-codex-spark", isDefault: true, inputModalities: ["text"] }];
  modelListFailuresRemaining = 0;
  threadModel: string | null = null;
  threadResponseExtra: Record<string, unknown> = {};
  beforeTurnStartReply: ((turnId: string) => void) | null = null;
  realtimeStartError: string | null = null;
  realtimeStartDelayMs: number | null = null;
  suppressRealtimeStartNotifications = false;
  realtimeAppendErrorAt: number | null = null;
  responseChunkBytes: number | null = null;
  oversizedTurnStartResult = false;
  readonly acceptedRealtimeSpeech: string[] = [];
  injectItemsError: string | null = null;
  injectItemsDelayMs: number | null = null;
  holdInjectItems = false;
  readonly heldInjectItemIds: number[] = [];
  omitThreadPath = false;
  omitThreadReadPath = false;
  threadPath: string | null = null;
  threadCwdOverride: string | null = null;
  private readonly serverRequestIds = new Set<string | number>();
  private turn = 0;

  constructor(
    private readonly threadId = "thread-149",
    private readonly resumedThreadId = threadId,
    private readonly ignoreTerm = false,
    private readonly turns: unknown[] = [],
    private readonly resumeStatus: unknown = undefined,
    private readonly resumeRequest: { id?: string; method: string; params: Record<string, unknown> }
      | Array<{ id?: string; method: string; params: Record<string, unknown> }>
      | null = null,
    private readonly ignoredMethods: string[] = [],
  ) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.emit("fixture-signal", signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    queueMicrotask(() => this.emit("close", signal === "SIGKILL" ? null : 0, signal));
    return true;
  }

  async signalObserved(signal: NodeJS.Signals): Promise<void> {
    if (this.signals.includes(signal)) return;
    await new Promise<void>(resolve => {
      const received = (value: NodeJS.Signals) => {
        if (value !== signal) return;
        this.off("fixture-signal", received); resolve();
      };
      this.on("fixture-signal", received);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(id: string | number, method: string, params: Record<string, unknown>): void {
    // Model complete native ingress. Tests of malformed frames use rawRequest.
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
      params = { threadId: this.threadId, turnId: "turn-1", itemId: `item-${id}`, startedAtMs: 1, ...params };
    }
    if (method === "item/tool/requestUserInput") {
      params = { threadId: this.threadId, turnId: "turn-1", itemId: `item-${id}`, isBlocking: true, ...params,
        questions: Array.isArray(params.questions) ? params.questions.map(question => ({ header: "Question", isOther: true, isSecret: false, options: null, ...question })) : params.questions };
    }
    this.rawRequest(id, method, params);
  }

  rawRequest(id: string | number, method: string, params: Record<string, unknown>): void {
    this.serverRequestIds.add(id);
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private accept(message: Record<string, unknown>): void {
    this.requests.push(message);
    this.emit("client-request", message);
    if ((typeof message.id === "string" || typeof message.id === "number")
      && this.serverRequestIds.delete(message.id)) {
      if (this.autoResolveServerRequests) {
        this.notify("serverRequest/resolved", { threadId: this.threadId, requestId: message.id });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (method === "mcpServerStatus/list") {
      this.beforeViewerStatus?.();
      const scoped = !this.requireViewerThread || (message.params as Record<string, unknown>)?.threadId === this.threadId;
      return this.respond(message.id, { data: scoped ? this.viewerStatus : [{ name: "viewer", tools: { global_only: {} } }], nextCursor: null });
    }
    if (typeof method === "string" && this.ignoredMethods.includes(method)) return;
    if (method === "initialize") return this.respond(message.id, { userAgent: this.userAgent });
    if (method === "thread/queue/list") {
      if (!this.paginatedHistory) return this.respondError(message.id, "method not found");
      if (this.nativeQueueListNotification) this.notify(this.nativeQueueListNotification.method, this.nativeQueueListNotification.params);
      return this.respond(message.id, { data: this.nativeQueueItems, nextCursor: null });
    }
    if (method === "thread/queue/start") {
      this.beforeNativeQueueStart?.();
      if (this.nativeQueueStartError) {
        this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
          error: { code: -32600, message: this.nativeQueueStartError } })}\n`);
        return;
      }
      const queued = this.nativeQueueItems.shift()!;
      const turn = { id: "recovered-native-turn", status: "inProgress", items: [] };
      this.notify("turn/started", { threadId: this.threadId, turn });
      this.notify("item/completed", { threadId: this.threadId, turnId: turn.id,
        item: { type: "userMessage", clientId: queued.clientUserMessageId, content: queued.input } });
      return this.respond(message.id, { turn });
    }
    if (method === "account/read") return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    if (method === "modelProvider/capabilities/read") return this.respond(message.id, { webSearch: true, imageGeneration: false });
    if (method === "model/list") {
      if (this.modelListFailuresRemaining > 0) {
        this.modelListFailuresRemaining -= 1;
        return this.respondError(message.id, "model list probe timed out");
      }
      return this.respond(message.id, { data: this.modelList });
    }
    if (method === "config/read") return this.respond(message.id, {
      config: {
        mcp_servers: this.mcpServers,
        shell_environment_policy: this.shellPolicy,
        features: this.features,
      },
    });
    if (method === "thread/start" || method === "thread/resume") {
      const id = method === "thread/resume" ? this.resumedThreadId : this.threadId;
      const excludeTurns = Boolean((message.params as { excludeTurns?: boolean } | undefined)?.excludeTurns);
      if (method === "thread/resume" && this.paginatedResume && !excludeTurns) {
        return this.respondError(message.id, "list_turns is not supported yet");
      }
      if (method === "thread/resume" && this.resumeRequest) {
        for (const request of Array.isArray(this.resumeRequest) ? this.resumeRequest : [this.resumeRequest]) {
          if (request.id) this.request(request.id, request.method, request.params);
          else this.notify(request.method, request.params);
        }
      }
      return this.respond(message.id, {
        ...this.threadResponseExtra,
        ...(this.threadModel ? { model: this.threadModel } : {}),
        thread: {
          id,
          ...(this.threadCwdOverride ? { cwd: this.threadCwdOverride } : typeof (message.params as { cwd?: unknown } | undefined)?.cwd === "string"
            ? { cwd: (message.params as { cwd: string }).cwd } : {}),
          ...(!this.omitThreadPath ? { path: this.threadPath ?? `/sessions/${id}.jsonl` } : {}),
          ...(excludeTurns ? {} : { turns: this.turns }),
          ...(this.resumeStatus ? { status: this.resumeStatus } : {}),
        },
      });
    }
    if (method === "thread/read") {
      if (this.readError) return this.respondError(message.id, this.readError);
      const hydrated = Boolean((message.params as { includeTurns?: boolean } | undefined)?.includeTurns);
      if (hydrated && this.hydratedReadError) return this.respondError(message.id, this.hydratedReadError);
      return this.respond(message.id, {
        thread: {
          id: this.threadId,
          ...(!this.omitThreadReadPath ? { path: this.threadPath ?? `/sessions/${this.threadId}.jsonl` } : {}),
          ...(hydrated ? { turns: this.readTurns ?? this.turns } : {}),
        },
      });
    }
    if (method === "thread/turns/list") {
      if (!this.paginatedHistory) return this.respondError(message.id, "method not found");
      if (this.turnsError) return this.respondError(message.id, this.turnsError);
      if (this.readError) return this.respondError(message.id, this.readError);
      const turns = [...(this.readTurns ?? this.turns)];
      if ((message.params as { sortDirection?: string } | undefined)?.sortDirection === "desc") turns.reverse();
      if (this.paginatedHistory) {
        const params = message.params as { cursor?: string; limit: number; itemsView: string };
        const offset = Number(params.cursor ?? 0);
        return this.respond(message.id, {
          data: turns.slice(offset, offset + params.limit).map(value => {
            const turn = value as { items: unknown[] };
            return { ...turn, items: params.itemsView === "full" ? turn.items : [], itemsView: params.itemsView };
          }),
          nextCursor: offset + params.limit < turns.length ? String(offset + params.limit) : null,
        });
      }
      return this.respond(message.id, {
        data: turns,
        nextCursor: null,
        backwardsCursor: null,
      });
    }
    if (method === "thread/items/list" && this.paginatedHistory) {
      const params = message.params as { turnId: string; cursor?: string; limit: number };
      const turn = (this.readTurns ?? this.turns).find(value => (value as { id: string }).id === params.turnId) as {items: unknown[]};
      const offset = Number(params.cursor ?? 0);
      return this.respond(message.id, {
        data: turn.items.slice(offset, offset + params.limit).map(item => ({turnId: params.turnId, item})),
        nextCursor: offset + params.limit < turn.items.length ? String(offset + params.limit) : null,
      });
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      this.beforeTurnStartReply?.(turnId);
      if (this.oversizedTurnStartResult) {
        return this.respond(message.id, { turn: { id: turnId }, padding: "p".repeat(26 * 1024 * 1024) });
      }
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      this.persistUserMessage(message, turnId);
      this.completeUserMessage(message, turnId);
      return;
    }
    if (method === "turn/steer") {
      if (this.holdSteer) return;
      if (this.steerError) {
        this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: this.steerError })}\n`);
        return;
      }
      const turnId = (message.params as { expectedTurnId: string }).expectedTurnId;
      this.respond(message.id, { turnId });
      this.persistUserMessage(message, turnId);
      this.completeUserMessage(message, turnId);
      return;
    }
    if (method === "turn/interrupt") return this.respond(message.id, {});
    if (method === "thread/inject_items") {
      if (this.injectItemsError) return this.respondError(message.id, this.injectItemsError);
      if (this.holdInjectItems) {
        this.heldInjectItemIds.push(message.id);
        return;
      }
      if (this.injectItemsDelayMs !== null) {
        const requestId = message.id;
        setTimeout(() => {
          this.persistInjectedItems(message);
          this.respond(requestId, {});
        }, this.injectItemsDelayMs);
        return;
      }
      this.persistInjectedItems(message);
      return this.respond(message.id, {});
    }
    if (method === "thread/realtime/start") {
      if (this.realtimeStartDelayMs !== null) {
        const requestId = message.id;
        setTimeout(() => this.completeRealtimeStart(requestId), this.realtimeStartDelayMs);
        return;
      }
      this.completeRealtimeStart(message.id);
      return;
    }
    if (method === "thread/realtime/appendSpeech") {
      const attempt = this.requests.filter((request) =>
        request.method === "thread/realtime/appendSpeech").length;
      if (attempt === this.realtimeAppendErrorAt) {
        return this.respondError(message.id, "realtime channel replaced");
      }
      this.acceptedRealtimeSpeech.push((message.params as { text: string }).text);
      return this.respond(message.id, {});
    }
    if (method === "thread/realtime/stop") {
      return this.respond(message.id, {});
    }
  }

  completeNextInject(error: string | null = null): void {
    const id = this.heldInjectItemIds.shift();
    if (id === undefined) throw new Error("no held persona insertion");
    if (error) this.respondError(id, error);
    else this.respond(id, {});
  }

  private persistInjectedItems(message: Record<string, unknown>): void {
    if (!this.threadPath) return;
    const items = (message.params as { items?: unknown[] }).items ?? [];
    fs.appendFileSync(this.threadPath, items.map((payload) => JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-02T10:00:00.000Z",
      payload,
    })).join("\n") + "\n");
  }

  private completeRealtimeStart(requestId: number): void {
    this.respond(requestId, {});
    if (this.suppressRealtimeStartNotifications) return;
    if (this.realtimeStartError) {
      this.notify("thread/realtime/error", {
        threadId: this.threadId,
        message: this.realtimeStartError,
      });
      return;
    }
    this.notify("thread/realtime/started", {
      threadId: this.threadId,
      realtimeSessionId: "realtime-1",
      version: "v3",
    });
    this.notify("thread/realtime/sdp", {
      threadId: this.threadId,
      sdp: "v=0\r\nanswer",
    });
  }

  private respond(id: number, result: unknown): void {
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
    if (this.responseChunkBytes) {
      for (let offset = 0; offset < line.length; offset += this.responseChunkBytes) {
        this.stdout.write(line.slice(offset, offset + this.responseChunkBytes));
      }
      return;
    }
    this.stdout.write(line);
  }

  private respondError(id: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: /method not found/.test(message) ? -32601 : -32603, message } })}\n`);
  }

  private completeUserMessage(message: Record<string, unknown>, turnId: string): void {
    if (!this.autoCompleteUserMessage) return;
    const params = message.params as { clientUserMessageId?: string; input?: unknown };
    if (!params.clientUserMessageId) return;
    this.notify("item/completed", {
      threadId: this.threadId,
      turnId,
      item: { type: "userMessage", clientId: params.clientUserMessageId, content: params.input },
    });
  }

  private persistUserMessage(message: Record<string, unknown>, turnId: string): void {
    if (!this.persistUserMessages || !this.threadPath) return;
    const input = (message.params as { input?: unknown } | undefined)?.input;
    if (!Array.isArray(input)) return;
    const text = input.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("");
    fs.appendFileSync(this.threadPath, `${JSON.stringify({
      timestamp: "2026-09-01T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: text },
    })}\n`);
  }
}

export function fakeSpawn(server: FakeAppServer, captured?: { args?: string[]; options?: SpawnOptionsWithoutStdio }) {
  return (_command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    if (captured) {
      captured.args = args;
      captured.options = options;
    }
    return server as unknown as ChildProcessWithoutNullStreams;
  };
}

export async function waitForCondition(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

/** Control host deadlines while metadata I/O and the request barrier keep
 * using the real event loop. Install only after the host has booted. */
export function controlHostTimeouts() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  const pending = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
    const handle = realSetTimeout(run, 120_000);
    pending.set(handle, { at: now + delay, run });
    return handle;
  }) as typeof setTimeout);
  const cancellations = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    pending.delete(handle as ReturnType<typeof setTimeout>);
    realClearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  return {
    pendingCount: () => pending.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        pending.delete(handle);
        realClearTimeout(handle);
        now = timer.at;
        timer.run();
      }
      now = target;
    },
    restore() {
      timers.mockRestore();
      cancellations.mockRestore();
      for (const handle of pending.keys()) realClearTimeout(handle);
      pending.clear();
    },
  };
}

export const ownedFakeProcess = {
  pidAlive: () => true,
  processIdentity: () => "4242:owned",
};

export async function nextEvent(iterable: AsyncIterable<unknown>): Promise<unknown> {
  return (await iterable[Symbol.asyncIterator]().next()).value;
}

export let metadataState: string;

export function installCodexHostFixture(setState?: (directory: string) => void) {
  let previousMetadataState: string | undefined;
  let restoreFeatures: () => void;
  let restoreVersion: () => void;
  beforeEach(() => {
    const versionSpy = spyOn(pinnedProtocol, "installedCodexVersion").mockReturnValue("0.162.1");
    restoreVersion = () => versionSpy.mockRestore();
    restoreFeatures = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true\nmulti_agent_v2 stable false\nfuture_worker stable true"));
    previousMetadataState = process.env.LLV_STATE_DIR;
    metadataState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-metadata-"));
    process.env.LLV_STATE_DIR = metadataState;
    setState?.(metadataState);
  });
  afterEach(() => {
    restoreVersion();
    restoreFeatures();
    if (previousMetadataState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousMetadataState;
    fs.rmSync(metadataState, { recursive: true, force: true });
  });
}
