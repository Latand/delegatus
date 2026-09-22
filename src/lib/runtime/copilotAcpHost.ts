import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { ProcessIdentity } from "@/lib/agent/registry";
import { viewerMcpServerEntry, VIEWER_SPAWN_CAPABILITY_ENV, type ViewerMcpServerEntry } from "@/lib/agent/spawnPolicy";
import { procBackend } from "@/lib/proc";
import { signalDetachedProcessGroup, type ProcessSignal } from "@/lib/processGroup";
import { STRUCTURED_HOST_STAMP_ENV, structuredHostStamp } from "@/lib/scanner/process";

import type {
  DeliveryReceipt,
  EngineHost,
  HostState,
  QueueEntry,
  RuntimeEvent,
  SessionMaterializationEvidence,
} from "./engineHost";
import { normalizeQueueEntry, RuntimeReplayGapError, StructuredHostAdoptionCleanupError } from "./engineHost";
import {
  FileRuntimeEventStore,
  nextRuntimeEventSequence,
  reconcileRuntimeEventCursor,
  type RuntimeEventCursorRecoveryReporter,
  type RuntimeEventStore,
} from "./eventStore";
import { withAgentConfigSandbox } from "./agentConfigSandbox";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES, runtimeImageStore } from "./runtimeImageStore";
import { STRUCTURED_IMAGE_CAPABILITY, type StructuredImageRef } from "./structuredContent";

/**
 * GitHub Copilot CLI hosted over ACP (Agent Client Protocol) on stdio
 * (docs/design/copilot-engine.md, section 3).
 *
 * One `copilot --acp` child per conversation. Model, effort and the MCP
 * servers are fixed per process by flags in CLI 1.0.87, so a shared process
 * could not give two conversations different settings.
 *
 * ACP has no steer. A message for a running turn is delivered by
 * interrupt-and-resend: the delivery queue calls {@link CopilotAcpHost.interrupt},
 * which sends `session/cancel` and waits a bounded time for the running
 * `session/prompt` to return, then calls {@link CopilotAcpHost.send} on the
 * idle host. `steerFallback = "interrupt"` is how the queue learns to take that
 * path for a steer as well.
 */

type JsonObject = Record<string, unknown>;
type Subscriber = { afterSeq: number; queue: RuntimeEvent[]; wake: (() => void) | null; closed: boolean };
type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;
type PendingRequest = {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
};
type RunningPrompt = {
  turnId: string;
  entryId: string;
  /** Settles after the turn-ended event for this prompt was emitted. */
  settled: Promise<void>;
};

export interface CopilotSessionIdentity {
  sessionId: string;
  /** `$COPILOT_HOME/session-state/<id>/events.jsonl`, the transcript the CLI writes. */
  path: string;
}

export interface CopilotAcpHostOptions {
  cwd: string;
  /** The account home, exported to the child as `COPILOT_HOME`. */
  copilotHome: string;
  /** `auto` or a model id; omitted leaves the CLI's own default. */
  model?: string;
  /** `--reasoning-effort` tier; omitted leaves the CLI's default. */
  effort?: string;
  /** Bypass launch profiles only: `--allow-all` grants tool, path and URL
      permission without trusting the folder. */
  allowAll?: boolean;
  allowSubagents?: boolean;
  /** Granted MCP servers from the launch profile; `viewer` is attached
      through `--additional-mcp-config`. */
  mcpServers?: readonly string[];
  binary?: string;
  env?: NodeJS.ProcessEnv;
  /** Test instrument only: provider variables (`COPILOT_PROVIDER_*`,
      `COPILOT_OFFLINE`) applied after the environment was filtered. No
      production caller passes it, so a provider in the Viewer's own
      environment can never reach a spawned Copilot. */
  providerEnv?: Record<string, string>;
  /** The Viewer MCP server definition; null attaches none. Defaults to the
      package's own launcher. */
  viewerMcpServer?: ViewerMcpServerEntry | null;
  releaseCleanup?: () => void;
  requestTimeoutMs?: number;
  /** Bound on the wait for a cancelled `session/prompt` to return. */
  interruptTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  onEventCursorRecovery?: RuntimeEventCursorRecoveryReporter;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  signalProcess?: ProcessSignal;
  processIdentity?: (pid: number) => string | null;
  eventStore?: RuntimeEventStore;
  readImage?: (ref: StructuredImageRef) => Buffer;
}

/** Copilot's native sub-agent tools, excluded unless subagents are allowed.
    The Copilot equivalent of `NATIVE_MULTI_AGENT_TOOLS` for Claude. */
export const COPILOT_NATIVE_MULTI_AGENT_TOOLS = ["task", "read_agent", "write_agent", "list_agents"] as const;

/** The ACP bound the design measured at 6–8 ms, kept more than a thousand
    times wider so load cannot trip it. */
export const COPILOT_INTERRUPT_TIMEOUT_MS = 10_000;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const SESSION_CLOSE_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 256 * 1024;
const ACP_PROTOCOL_VERSION = 1;

/** The only variables a Copilot child inherits. Everything else, including
    `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN` (which outrank the
    account's stored login), `COPILOT_PROVIDER_*`, `COPILOT_MODEL` and
    `COPILOT_ALLOW_ALL` (which would trust the folder), is dropped. */
const CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  VIEWER_SPAWN_CAPABILITY_ENV,
  "LLV_STATE_DIR", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_PORT",
] as const;

const PROVIDER_ENV = /^(COPILOT_PROVIDER_[A-Z_]+|COPILOT_OFFLINE)$/;

export function copilotTranscriptPath(copilotHome: string, sessionId: string): string {
  return path.join(copilotHome, "session-state", sessionId, "events.jsonl");
}

/** The environment a Copilot child runs under. Pure over its inputs. */
export function copilotChildEnv(
  source: NodeJS.ProcessEnv,
  copilotHome: string,
  providerEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  for (const name of CHILD_ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  withAgentConfigSandbox(env, source, copilotHome);
  env.COPILOT_HOME = copilotHome;
  env.COPILOT_AUTO_UPDATE = "false";
  env[STRUCTURED_HOST_STAMP_ENV] = structuredHostStamp();
  for (const [name, value] of Object.entries(providerEnv)) {
    if (!PROVIDER_ENV.test(name)) throw new Error(`Copilot provider override ${name} is not a provider variable`);
    env[name] = value;
  }
  return env;
}

/** The `--additional-mcp-config` document. ACP `session/new` rejects stdio
    servers, so the Viewer MCP attaches at process start instead. The spawn
    capability rides the server's own `env` table, never a command line. */
export function copilotMcpConfig(
  viewer: ViewerMcpServerEntry | null,
  capability: string | null,
): { mcpServers: Record<string, JsonObject> } {
  if (!viewer) return { mcpServers: {} };
  return {
    mcpServers: {
      viewer: {
        type: "local",
        command: viewer.command,
        args: viewer.args,
        tools: ["*"],
        env: { ...viewer.env, ...(capability ? { [VIEWER_SPAWN_CAPABILITY_ENV]: capability } : {}) },
      },
    },
  };
}

/** The launch argv after the binary. Pure, so the flag set is asserted
    without a child. */
export function copilotLaunchArgs(
  options: Pick<CopilotAcpHostOptions, "cwd" | "model" | "effort" | "allowAll" | "allowSubagents">,
  mcpConfigPath: string | null,
): string[] {
  const args = ["--acp", "--no-auto-update", "-C", options.cwd];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--reasoning-effort", options.effort);
  if (mcpConfigPath) args.push("--additional-mcp-config", `@${mcpConfigPath}`);
  args.push("--disable-builtin-mcps");
  if (!options.allowSubagents) args.push("--excluded-tools", ...COPILOT_NATIVE_MULTI_AGENT_TOOLS);
  if (options.allowAll) args.push("--allow-all");
  return args;
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, "$1[redacted]").slice(0, 500);
}

/** Whether a transcript records the given engine-visible first message. */
function transcriptHasUserMessage(transcript: string): boolean | null {
  let text: string;
  try { text = fs.readFileSync(transcript, "utf8"); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
  for (const line of text.split("\n")) {
    if (!line.includes("\"user.message\"")) continue;
    try {
      if (record(JSON.parse(line))?.type === "user.message") return true;
    } catch { /* a partial trailing line */ }
  }
  return false;
}

export class CopilotAcpHost implements EngineHost {
  readonly supportsSteer = false;
  /** ACP has no steer: a steer takes the interrupt-and-resend path. */
  readonly steerFallback = "interrupt" as const;
  identity: CopilotSessionIdentity;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: CopilotAcpHostOptions;
  private readonly eventStore: RuntimeEventStore;
  private readonly readImage: (ref: StructuredImageRef) => Buffer;
  private readonly requestTimeoutMs: number;
  private readonly interruptTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly signalProcess: ProcessSignal;
  private readonly processIdentity: (pid: number) => string | null;
  private readonly childStartIdentity: string | null;
  private readonly subscribers = new Set<Subscriber>();
  private readonly events: RuntimeEvent[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  /** Open `session/request_permission` requests by attention id, with the
      JSON-RPC id the answer has to carry. */
  private readonly attentions = new Map<string, { rpcId: number | string; request: JsonObject }>();
  /** Turns this host cancelled. A cancelled prompt answers `end_turn` in CLI
      1.0.87, so the host remembers the cancel instead of trusting the reply. */
  private readonly cancelledTurns = new Set<string>();
  /** Entry id → turn started for it, so a retried send is idempotent. */
  private readonly sentEntries = new Map<string, string>();
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly launchFlags: readonly string[];
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private turnCounter = 0;
  private running: RunningPrompt | null = null;
  private firstPromptFailure: string | null = null;
  private cursor: number;
  private protocolVersion: string | null = null;
  private replaying = false;
  private dead = false;
  private releasing = false;
  private released = false;
  private reaped = false;
  private ledgerFailed = false;
  private writerFence: (() => boolean) | null = null;
  private releasePromise: Promise<void> | null = null;
  private releaseCleanup: (() => void) | null;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private terminationStarted = false;
  private releaseFence: Readonly<ProcessIdentity> | null = null;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;

  private constructor(child: ChildProcessWithoutNullStreams, options: CopilotAcpHostOptions) {
    this.child = child;
    this.options = options;
    this.identity = { sessionId: "pending", path: "" };
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.readImage = options.readImage ?? ((ref) => runtimeImageStore().read(ref));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? COPILOT_INTERRUPT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.signalProcess = options.signalProcess ?? process.kill;
    this.processIdentity = options.processIdentity ?? ((pid) => procBackend.processIdentity(pid));
    this.childStartIdentity = child.pid ? this.processIdentity(child.pid) : null;
    this.releaseCleanup = options.releaseCleanup ?? null;
    this.cursor = options.initialEventCursor ?? 0;
    /* ACP advertises `promptCapabilities.image`; images ride `session/prompt`
       as image content blocks. */
    /* Native sub-agents are excluded by `--excluded-tools` at launch; the
       Claude deny flag names Claude's tools, so it is not advertised here. */
    this.launchFlags = [STRUCTURED_IMAGE_CAPABILITY];
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.acceptStdout(typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk));
    });
    child.stdout.on("end", () => {
      const tail = this.stdoutDecoder.end();
      if (tail) this.acceptStdout(tail);
    });
    /* The CLI's stderr may carry provider or GitHub diagnostics; none of it is
       retained. */
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => {
      if (!this.releasing && !this.released) this.fail(new Error(`Copilot ACP stdin failed: ${safeError(error)}`));
    });
    child.on("error", (error) => this.fail(new Error(`Copilot child failed: ${safeError(error)}`)));
    child.on("close", () => {
      this.reaped = true;
      if (this.terminationTimer) {
        clearTimeout(this.terminationTimer);
        this.terminationTimer = null;
      }
      this.resolveReaped();
      if (this.releasing) this.finishRelease();
      else if (this.dead) this.notifyStateListeners();
      else if (!this.released) this.fail(new Error("Copilot child exited"));
    });
  }

  /** A fresh session: `session/new` mints the id (`--acp` refuses `--session-id`). */
  static async start(options: CopilotAcpHostOptions): Promise<CopilotAcpHost> {
    return this.open(null, options);
  }

  /** Resume from disk: a new child with the same launch flags, then `session/load`.
      Model and effort must be passed again — a restart without them silently
      runs the session at the CLI default. */
  static async adopt(sessionId: string, options: CopilotAcpHostOptions): Promise<CopilotAcpHost> {
    if (!sessionId) throw new Error("Copilot session id is required for adoption");
    return this.open(sessionId, options);
  }

  private static async open(resumeSessionId: string | null, options: CopilotAcpHostOptions): Promise<CopilotAcpHost> {
    const binary = options.binary ?? process.env.LLV_COPILOT_BIN ?? "copilot";
    const env = copilotChildEnv(options.env ?? process.env, options.copilotHome, options.providerEnv);
    let mcpConfigPath: string | null = null;
    const cleanups: Array<() => void> = [];
    if (options.releaseCleanup) cleanups.push(options.releaseCleanup);
    const releaseCleanup = () => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* best effort */ } } };
    let child: ChildProcessWithoutNullStreams;
    try {
      const viewer = options.viewerMcpServer === undefined
        ? (options.mcpServers ?? ["viewer"]).includes("viewer") ? viewerMcpServerEntry() : null
        : options.viewerMcpServer;
      if (viewer) {
        const directory = path.join(options.copilotHome, "llv-mcp");
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        mcpConfigPath = path.join(directory, `${crypto.randomUUID()}.json`);
        const capability = options.env?.[VIEWER_SPAWN_CAPABILITY_ENV] ?? null;
        fs.writeFileSync(mcpConfigPath, JSON.stringify(copilotMcpConfig(viewer, capability)), { mode: 0o600 });
        const written = mcpConfigPath;
        cleanups.push(() => fs.rmSync(written, { force: true }));
      }
      /* Never the capability: it is in the 0600 file, not in the child env. */
      delete env[VIEWER_SPAWN_CAPABILITY_ENV];
      const spawnProcess = options.spawnProcess ?? ((command, childArgs, spawnOptions) =>
        spawn(command, childArgs, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
      child = spawnProcess(binary, copilotLaunchArgs(options, mcpConfigPath), {
        cwd: options.cwd,
        env,
        detached: true,
      });
    } catch (error) {
      releaseCleanup();
      throw error;
    }
    const host = new CopilotAcpHost(child, { ...options, releaseCleanup });
    try {
      await host.handshake(resumeSessionId);
      return host;
    } catch (error) {
      try {
        await host.release();
      } catch (cleanupError) {
        throw new StructuredHostAdoptionCleanupError(safeError(error), host, { cause: cleanupError });
      }
      throw new Error(safeError(error));
    }
  }

  private async handshake(resumeSessionId: string | null): Promise<void> {
    const initialized = record(await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    }));
    const agentInfo = record(initialized?.agentInfo);
    this.protocolVersion = stringField(agentInfo, "version")
      ?? (initialized?.protocolVersion !== undefined ? String(initialized.protocolVersion) : null);
    let sessionId: string;
    if (resumeSessionId) {
      /* The history `session/load` replays is the engine proving it holds the
         session. The feed renders history from `events.jsonl`, so the replay
         is not re-emitted as new items. */
      this.replaying = true;
      try {
        await this.request("session/load", { sessionId: resumeSessionId, cwd: this.options.cwd, mcpServers: [] });
      } finally {
        this.replaying = false;
      }
      sessionId = resumeSessionId;
    } else {
      const created = record(await this.request("session/new", { cwd: this.options.cwd, mcpServers: [] }));
      const minted = stringField(created, "sessionId");
      if (!minted) throw new Error("Copilot session/new returned no session id");
      sessionId = minted;
    }
    this.identity = { sessionId, path: copilotTranscriptPath(this.options.copilotHome, sessionId) };
    this.restore();
    this.emit({ kind: "session-status", status: "idle" });
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const firstAvailable = this.events[0]?.seq;
    if (firstAvailable !== undefined && afterSeq + 1 < firstAvailable) {
      throw new RuntimeReplayGapError(afterSeq, firstAvailable);
    }
    const subscriber: Subscriber = { afterSeq, queue: this.events.filter((event) => event.seq > afterSeq), wake: null, closed: false };
    this.subscribers.add(subscriber);
    const subscribers = this.subscribers;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const event = subscriber.queue.shift();
            if (event) {
              if (event.seq > subscriber.afterSeq) {
                subscriber.afterSeq = event.seq;
                yield event;
              }
              continue;
            }
            if (subscriber.closed) break;
            await new Promise<void>((resolve) => { subscriber.wake = resolve; });
            subscriber.wake = null;
          }
        } finally {
          subscriber.closed = true;
          subscribers.delete(subscriber);
        }
      },
    };
  }

  /**
   * Starts a turn on an idle session.
   *
   * A second `session/prompt` during a running turn aborts that turn in CLI
   * 1.0.87 through an undocumented path, so a send while a prompt is in flight
   * is refused as `stale-turn` and writes nothing. Every interrupt is the
   * explicit, recorded one in {@link interrupt}.
   */
  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    if (this.unavailable()) return { outcome: "rejected", reason: "dead-host" };
    const normalized = normalizeQueueEntry(entry);
    const already = this.sentEntries.get(normalized.id);
    if (already) return { outcome: "turn-started", turnId: already };
    if (this.running) return { outcome: "rejected", reason: "stale-turn" };
    if (typeof normalized.expectedTurnId === "string") return { outcome: "rejected", reason: "stale-turn" };
    const prompt: JsonObject[] = [];
    if (normalized.content.text) prompt.push({ type: "text", text: normalized.content.text });
    for (const image of normalized.content.images) {
      prompt.push({ type: "image", mimeType: image.mime, data: this.readImage(image).toString("base64") });
    }
    if (prompt.length === 0) prompt.push({ type: "text", text: "" });
    this.turnCounter += 1;
    const turnId = `copilot:${this.turnCounter}-${crypto.randomBytes(4).toString("hex")}`;
    const firstPrompt = this.sentEntries.size === 0;
    this.sentEntries.set(normalized.id, turnId);
    let settle!: () => void;
    const running: RunningPrompt = { turnId, entryId: normalized.id, settled: new Promise((resolve) => { settle = resolve; }) };
    this.running = running;
    this.emit({ kind: "turn-started", turnId });
    const request = this.request("session/prompt", { sessionId: this.identity.sessionId, prompt }, null);
    void request.then(
      (result) => {
        const stopReason = stringField(result, "stopReason");
        const status = this.cancelledTurns.has(turnId) || stopReason === "cancelled"
          ? "interrupted"
          : stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests"
            ? "completed"
            : "error";
        this.finishTurn(running, status);
        settle();
      },
      (error) => {
        if (firstPrompt) this.firstPromptFailure = safeError(error);
        this.finishTurn(running, this.cancelledTurns.has(turnId) ? "interrupted" : "error");
        settle();
      },
    );
    return { outcome: "turn-started", turnId };
  }

  /**
   * Ends the named running turn: `session/cancel`, then a bounded wait for its
   * `session/prompt` to return. The turn ends `interrupted` whatever stop
   * reason the CLI answered. Past the bound this throws, so the delivery queue
   * puts a waiting message back instead of sending on top of a live turn.
   */
  async interrupt(turnRef: string): Promise<void> {
    const running = this.running;
    if (!running || running.turnId !== turnRef) return;
    if (this.unavailable()) throw new Error("Copilot host is unavailable");
    this.cancelledTurns.add(running.turnId);
    this.notify("session/cancel", { sessionId: this.identity.sessionId });
    /* ACP: after `session/cancel` the client answers every pending
       `session/request_permission` with `cancelled`. The CLI returned without
       it in 1.0.87, but only the answer is what the protocol promises. One
       session runs one turn, so every open request belongs to this one. */
    for (const [attentionId, open] of this.attentions) {
      this.write({ jsonrpc: "2.0", id: open.rpcId, result: { outcome: { outcome: "cancelled" } } });
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "turn-ended" });
    }
    this.attentions.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      running.settled.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.interruptTimeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!stopped) {
      throw new Error(`Copilot turn did not stop within ${this.interruptTimeoutMs}ms of session/cancel`);
    }
  }

  /** Answers an open `session/request_permission` with the chosen option. */
  async answer(attentionRef: string, value: unknown): Promise<void> {
    const open = this.attentions.get(attentionRef);
    if (!open) throw new Error("Copilot attention is not open");
    const optionId = typeof value === "string"
      ? value
      : stringField(value, "optionId") ?? stringField(record(record(value)?.outcome), "optionId");
    const options = Array.isArray(open.request.options) ? open.request.options.map(record).filter(Boolean) as JsonObject[] : [];
    const decision = stringField(value, "decision");
    const chosen = optionId
      ?? (decision === "accept" || decision === "approve" || decision === "allow"
        ? stringField(options.find((option) => stringField(option, "kind") === "allow_once"), "optionId")
        : decision === "decline" || decision === "deny" || decision === "reject"
          ? stringField(options.find((option) => stringField(option, "kind") === "reject_once"), "optionId")
          : null);
    if (!chosen) throw new Error("Copilot permission answer names no option");
    if (options.length > 0 && !options.some((option) => stringField(option, "optionId") === chosen)) {
      throw new Error("Copilot permission answer names an option the request did not offer");
    }
    this.write({ jsonrpc: "2.0", id: open.rpcId, result: { outcome: { outcome: "selected", optionId: chosen } } });
    this.attentions.delete(attentionRef);
    this.emit({ kind: "attention-resolved", id: attentionRef, resolution: "answered" });
  }

  async health(): Promise<HostState> { return this.currentState(); }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  setWriterFence(fence: () => boolean): void { this.writerFence = fence; }

  /** `materialized` once the transcript holds the first `user.message`;
      `failed` when the first prompt errored before writing one. */
  async sessionMaterializationEvidence(_clientMessageId: string): Promise<SessionMaterializationEvidence> {
    const present = transcriptHasUserMessage(this.identity.path);
    if (present === true) return { state: "materialized" };
    if (present === null) return { state: "unavailable", reason: "the Copilot transcript could not be read" };
    if (this.firstPromptFailure) return { state: "failed", reason: `Copilot rejected the first prompt: ${this.firstPromptFailure}` };
    if (this.dead) return { state: "failed", reason: "the Copilot host exited before writing the first message" };
    return { state: "absent", reason: "Copilot has not written the first message to its transcript yet" };
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (!this.releasePromise) {
      const attempt = this.releaseAndReap();
      this.releasePromise = attempt;
      void attempt.catch(() => {
        if (this.releasePromise === attempt) this.releasePromise = null;
      });
    }
    return this.releasePromise;
  }

  /** Resource cleanup may release only the exact child the row authorized. */
  async releaseIfOwned(expected: Readonly<ProcessIdentity>): Promise<boolean> {
    const pid = this.child.pid;
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

  private finishTurn(running: RunningPrompt, status: "completed" | "interrupted" | "error"): void {
    if (this.running !== running) return;
    this.running = null;
    this.cancelledTurns.delete(running.turnId);
    if (this.dead || this.released) return;
    if (this.releasing) {
      this.emit({ kind: "turn-ended", turnId: running.turnId, status: "interrupted" });
      return;
    }
    this.emit({ kind: "turn-ended", turnId: running.turnId, status });
    for (const attentionId of this.attentions.keys()) {
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "turn-ended" });
    }
    this.attentions.clear();
    this.emit({ kind: "session-status", status: "idle" });
  }

  private unavailable(): boolean {
    if (this.dead || this.releasing || this.released) return true;
    try { return this.writerFence?.() === false; } catch { return true; }
  }

  private currentState(): HostState {
    const pid = this.reaped || this.released ? null : this.child.pid ?? null;
    const status: HostState["status"] = this.dead ? "dead"
      : this.released ? "unhosted"
      : this.attentions.size ? "attention"
      : this.running ? "active"
      : "idle";
    return {
      status,
      sessionKey: this.identity.sessionId,
      endpoint: pid ? `stdio:${pid}` : "stdio:released",
      pid,
      processStartIdentity: pid ? this.processIdentity(pid) : null,
      eventCursor: this.cursor,
      protocolVersion: this.protocolVersion,
      activeTurnRef: this.running?.turnId ?? null,
      pendingAttention: [...this.attentions.keys()],
      activeFlags: [...this.launchFlags],
      account: null,
    };
  }

  private restore(): void {
    const stored = this.eventStore.load(this.identity.sessionId);
    this.events.push(...stored);
    this.cursor = reconcileRuntimeEventCursor(
      this.identity.sessionId,
      stored.at(-1)?.seq ?? 0,
      this.cursor,
      this.options.onEventCursorRecovery,
    );
    let restoredTurn: string | null = null;
    const restoredAttention = new Set<string>();
    for (const event of stored) {
      if (event.kind === "turn-started") restoredTurn = event.turnId;
      if (event.kind === "turn-ended" && event.turnId === restoredTurn) restoredTurn = null;
      if (event.kind === "attention") restoredAttention.add(event.id);
      if (event.kind === "attention-resolved") restoredAttention.delete(event.id);
      if (event.kind === "session-status" && (event.status === "dead" || event.status === "unhosted")) {
        restoredTurn = null;
        restoredAttention.clear();
      }
    }
    /* A turn the previous process left running died with that process. */
    if (restoredTurn) this.emit({ kind: "turn-ended", turnId: restoredTurn, status: "error" });
    for (const attentionId of restoredAttention) {
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "host-restarted" });
    }
  }

  private emit(event: UnsequencedEvent): void {
    if (this.ledgerFailed || this.identity.sessionId === "pending") return;
    let nextCursor: number;
    try {
      nextCursor = nextRuntimeEventSequence(this.cursor);
    } catch (error) {
      this.ledgerFailed = true;
      this.fail(new Error(safeError(error)));
      return;
    }
    this.cursor = nextCursor;
    const sequenced = { ...event, seq: nextCursor } as RuntimeEvent;
    try { this.eventStore.append(this.identity.sessionId, sequenced); }
    catch (error) {
      this.cursor = this.events.at(-1)?.seq ?? Math.max(0, this.cursor - 1);
      this.ledgerFailed = true;
      this.fail(new Error(`runtime event ledger failed: ${safeError(error)}`));
      return;
    }
    this.events.push(sequenced);
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(sequenced);
      subscriber.wake?.();
    }
    this.notifyStateListeners();
  }

  private request(method: string, params: JsonObject, timeoutMs: number | null = this.requestTimeoutMs): Promise<unknown> {
    if (this.dead || this.released) return Promise.reject(new Error("Copilot host is unavailable"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Copilot ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) {
      const failure = new Error(`Copilot ACP stdin failed: ${safeError(error)}`);
      this.fail(failure);
      throw failure;
    }
  }

  private acceptStdout(chunk: string): void {
    if (this.dead || this.released) return;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail(new Error("Copilot emitted an oversized ACP frame"));
      if (line.trim()) this.acceptMessage(line);
      if (this.dead) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) this.fail(new Error("Copilot emitted an oversized ACP frame"));
  }

  private acceptMessage(line: string): void {
    let message: JsonObject | null = null;
    try { message = record(JSON.parse(line)); } catch { /* not JSON-RPC */ }
    /* ACP owns stdout, but a stray diagnostic line is not a protocol failure. */
    if (!message) return;
    const method = stringField(message, "method");
    const id = message.id as number | string | undefined;
    if (!method && id !== undefined) {
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) return;
      this.pending.delete(id as number);
      if (pending.timer) clearTimeout(pending.timer);
      const error = record(message.error);
      if (error) pending.reject(new Error(`Copilot ${pending.method} failed: ${stringField(error, "message") ?? "error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (!method) return;
    if (method === "session/update") return this.acceptUpdate(record(message.params));
    if (method === "session/request_permission" && id !== undefined) {
      const params = record(message.params) ?? {};
      if (this.replaying || !this.running) {
        /* Nothing can answer a request no turn owns. */
        this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const attentionId = `copilot-permission:${String(id)}`;
      this.attentions.set(attentionId, { rpcId: id, request: params });
      const toolCall = record(params.toolCall);
      this.emit({
        kind: "attention",
        id: attentionId,
        method: "session/request_permission",
        attention: {
          /* `title` and `tool` are what the attention projection reads for
             every engine; the raw ACP request stays beside them. */
          ...(stringField(toolCall, "title") ? { title: stringField(toolCall, "title") } : {}),
          ...(stringField(toolCall, "kind") ? { tool: stringField(toolCall, "kind") } : {}),
          toolCall: params.toolCall ?? null,
          options: params.options ?? [],
          turnId: this.running.turnId,
        },
      });
      return;
    }
    /* The client advertises no fs or terminal capability, so any other agent
       request is one this client does not implement. */
    if (id !== undefined) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${method}` } });
    }
  }

  private acceptUpdate(params: JsonObject | null): void {
    if (this.replaying) return;
    const update = record(params?.update);
    const kind = stringField(update, "sessionUpdate");
    if (!update || !kind) return;
    const turnId = this.running?.turnId ?? null;
    if (kind === "agent_message_chunk") {
      const text = stringField(record(update.content), "text");
      if (text && turnId) this.emit({ kind: "delta", turnId, text });
      return;
    }
    if (kind === "tool_call") {
      this.emit({ kind: "item", turnId, item: update, phase: "started" });
      return;
    }
    if (kind === "tool_call_update") {
      const status = stringField(update, "status");
      this.emit({ kind: "item", turnId, item: update, phase: status === "completed" || status === "failed" ? "completed" : "started" });
    }
  }

  private async releaseAndReap(): Promise<void> {
    if (!this.dead && !this.reaped && this.identity.sessionId !== "pending") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.request("session/close", { sessionId: this.identity.sessionId }, SESSION_CLOSE_TIMEOUT_MS).catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    }
    this.releasing = true;
    this.rejectPending(new Error("Copilot ACP host released"));
    if (!this.startTermination() && this.releaseFence) {
      this.releasing = false;
      throw new Error("Copilot child identity changed before signalling");
    }
    if (!await this.waitForReap(this.shutdownGraceMs * 2)) {
      if (!this.signalReleaseGroup("SIGKILL") && this.releaseFence) {
        this.releasing = false;
        throw new Error("Copilot child identity changed before signalling");
      }
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        const leaderExited = this.child.pid === undefined
          || (this.child.exitCode ?? null) !== null
          || (this.child.signalCode ?? null) !== null;
        if (!leaderExited) throw new Error("Copilot child could not be reaped");
        for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
          try { stream?.destroy(); } catch { /* pipe already closed */ }
        }
        this.reaped = true;
        this.resolveReaped();
      }
    }
    this.finishRelease();
  }

  private finishRelease(): void {
    if (this.released) return;
    const running = this.running;
    this.running = null;
    this.attentions.clear();
    if (running && !this.dead) this.emit({ kind: "turn-ended", turnId: running.turnId, status: "interrupted" });
    this.released = true;
    this.releasing = false;
    this.emit({ kind: "session-status", status: "unhosted" });
    this.closeSubscribers();
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
    const running = this.running;
    this.running = null;
    this.attentions.clear();
    this.rejectPending(error);
    if (running) this.emit({ kind: "turn-ended", turnId: running.turnId, status: "error" });
    this.dead = true;
    this.emit({ kind: "session-status", status: "dead" });
    this.notifyStateListeners();
    this.closeSubscribers();
    this.startTermination();
  }

  private signalReleaseGroup(signal: NodeJS.Signals): boolean {
    const expected = this.releaseFence;
    if (expected) {
      const pid = this.child.pid;
      if (!pid || expected.startIdentity === null
        || pid !== expected.pid
        || this.childStartIdentity !== expected.startIdentity
        || this.processIdentity(pid) !== expected.startIdentity) return false;
    }
    return signalDetachedProcessGroup(this.child, signal, this.signalProcess);
  }

  private startTermination(): boolean {
    if (this.terminationStarted || this.reaped) return true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
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
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pending.clear();
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
