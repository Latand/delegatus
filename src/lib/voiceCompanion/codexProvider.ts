import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { installedCodexVersion } from "@/lib/accounts/codexPinnedProtocol";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { CODEX_VIEWER_SPAWN_FEATURES } from "@/lib/agent/spawnPolicy";
import { agentRegistry } from "@/lib/agent/registry";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { accountProjectBindings, type AccountProjectBinding } from "@/lib/accounts/projectBindings";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { recordLiveObservation } from "@/lib/accounts/liveLimits";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import type { QuotaObservation } from "@/lib/accounts/migration/quotaPolicy";
import { mapAppServerRateLimits } from "@/lib/limits";
import { CodexAppServerClient, codexAccountBinary, type AppServerNotification, type AppServerRateLimits, type CodexAppServerChild } from "@/lib/accounts/codexAppServer";
import type { Locale } from "./contract";
import { jsonObject, type LiveConnection, type LiveProvider, type LiveToolHandler } from "./provider";
import { BACKEND_INSTRUCTIONS, LIVE_BACKEND_MODEL, liveInstructions } from "./sessionConfig";
import { COMPANION_TOOL_REGISTRY } from "./tools";

type VoiceAccount = { id: string; kind: "managed" | "legacy"; home: string; authPresent: boolean };
export interface CodexVoiceOptions {
  accounts?(): readonly VoiceAccount[];
  observations?(): readonly DurableQuotaObservation[];
  bindings?(): readonly AccountProjectBinding[];
  environment?: NodeJS.ProcessEnv;
  now?(): number;
  startTimeoutMs?: number;
  /** Canary compares this with Codex's default startup prompt before selection. */
  compactPrompt?: boolean;
  recordObservation?(observation: QuotaObservation): void;
}
export class CodexVoiceError extends Error {
  constructor(code: "NO_CODEX_ACCOUNT" | "CODEX_LIMIT_REACHED" | "CODEX_AUTH_REQUIRED" | "CODEX_UNSUPPORTED" | "PROVIDER_ERROR", readonly resetsAt: number | null = null) { super(code); }
}
export function selectVoiceAccount(accounts: readonly VoiceAccount[], observations: readonly DurableQuotaObservation[], bindings: readonly AccountProjectBinding[], project: string | null, now = Date.now()): VoiceAccount {
  // Exclusions are a fallback tier in headless selection. Remove legacy homes
  // from the candidate set itself, so exhaustion can never pick the main home.
  const candidates = accounts.filter(account => account.kind === "managed" && account.authPresent);
  const picked = selectProjectAccount({ accounts: candidates, observations, bindings, project, engine: "codex", unbound: "capacity", model: LIVE_BACKEND_MODEL, now });
  if (picked.kind === "exhausted") throw new CodexVoiceError("CODEX_LIMIT_REACHED", picked.resetsAt);
  const account = picked.kind === "available" ? candidates.find(account => account.id === picked.accountId) : undefined;
  if (!account) throw new CodexVoiceError("NO_CODEX_ACCOUNT");
  return account;
}
export const CODEX_VOICE_ARGS = ["-c", "cli_auth_credentials_store=file", "-c", "mcp_servers={}", "-c", "analytics.enabled=false", "-c", "features.shell_tool=false",
  ...Object.entries(CODEX_VIEWER_SPAWN_FEATURES).flatMap(([name, value]) => ["-c", `features.${name}=${value}`]), "--enable", "realtime_conversation", "app-server"];
export function codexVoiceEnvironment(home: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(source).filter(([name]) => !/_API_KEY$/i.test(name) && !/^(OPENAI_|CHATGPT_)/i.test(name))), NODE_ENV: source.NODE_ENV, CODEX_HOME: home };
}
export function codexVoiceThread(cwd: string, compactPrompt = true) {
  const instructions = BACKEND_INSTRUCTIONS.replace("whose answer is under Reads earlier in this call", "whose answer is in this thread");
  return { model: LIVE_BACKEND_MODEL, cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
    dynamicTools: COMPANION_TOOL_REGISTRY.filter(tool => tool.class !== "delegation").map(({ name, description, parameters }) => ({ type: "function", name, description, inputSchema: parameters })),
    developerInstructions: instructions, ...(compactPrompt ? { environments: [], baseInstructions: instructions } : {}) };
}
export function codexVoiceStart(threadId: string, locale: Locale, sdp: string, projectName?: string) {
  return { threadId, version: "v3", model: "gpt-live-1-codex", outputModality: "audio", transport: { type: "webrtc", sdp: sdp.replace(/\r?\n/g, "\r\n") },
    clientManagedHandoffs: false, prompt: liveInstructions(locale, projectName) };
}
interface Call {
  client: CodexAppServerClient; account: VoiceAccount; cwd: string; id: string; createdAt: number;
  events: unknown[]; event?(value: unknown): void; lost?(): void; tool?: LiveToolHandler;
  stopping?: Promise<void>; reaped: Promise<void>; sdpReceived?: boolean; failed?: boolean;
}

/** Companion-owned stdio protocol. No conversation host, writer or composer
 * transcript code participates in a voice call. */
export class CodexLiveProvider implements LiveProvider {
  readonly backend = "codex" as const;
  private readonly calls = new Map<string, Call>();
  private readonly now: () => number;
  constructor(private readonly options: CodexVoiceOptions = {}) { this.now = options.now ?? Date.now; }

  async create(_key: string, locale: Locale, sdp: string, projectName?: string, project?: string) {
    const account = selectVoiceAccount((this.options.accounts ?? listCodexAccounts)(), (this.options.observations ?? (() => agentRegistry().quotaObservations("codex")))(),
      (this.options.bindings ?? accountProjectBindings)(), project ?? null, this.now());
    const directory = statePath("scratch", "voice-codex"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cwd = fs.mkdtempSync(path.join(directory, "call-"));
    let call: Call | undefined;
    let client: CodexAppServerClient | undefined;
    let resolveReaped!: () => void;
    const reaped = new Promise<void>(resolve => { resolveReaped = resolve; });
    try {
      const environment = codexVoiceEnvironment(account.home, this.options.environment ?? process.env);
      client = await CodexAppServerClient.start({ home: account.home, args: CODEX_VOICE_ARGS, requestTimeoutMs: this.options.startTimeoutMs ?? 20_000,
        protocolProfile: "voice", readProtocolVersion: () => installedCodexVersion(codexAccountBinary(environment), environment),
        // The guardian owns group signalling and its bounded TERM escalation.
        // The generic client's KILL fallback must never kill that guardian.
        signalProcess: () => { throw new Error("lease owns signals"); },
        spawn: (_home, args): CodexAppServerChild => {
          const child = spawnLeasedHelper("voice-codex", { command: codexAccountBinary(environment), args: [...args], cwd, env: environment }, undefined,
            { input: true, stdout: "pipe", stderr: "pipe", followRelease: false });
          child.once("close", resolveReaped);
          const input = leasedHelperInput(child);
          input.on("error", error => child.emit("error", error));
          return { pid: child.pid, stdin: { write: value => input.write(value), end: () => { child.stdin?.end(); return input.end(); } },
            stdout: child.stdout!, stderr: child.stderr!, on: child.on.bind(child), kill: () => { endLeasedHelper(child); return true; } };
        } });
      if ((await client.readAccount()).account?.type !== "chatgpt") throw new CodexVoiceError("CODEX_AUTH_REQUIRED");
      const started = jsonObject(await client.request("thread/start", codexVoiceThread(cwd, this.options.compactPrompt)));
      const id = jsonObject(started?.thread)?.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new CodexVoiceError("CODEX_UNSUPPORTED");
      call = { client, account, cwd, id, events: [], createdAt: this.now(), reaped };
      this.calls.set(id, call);
      const active = call;
      client.onRequest(async request => {
        const params = jsonObject(request.params);
        if (request.method !== "item/tool/call" || params?.threadId !== id || typeof params.tool !== "string" || typeof params.callId !== "string" || typeof params.turnId !== "string"
          || !COMPANION_TOOL_REGISTRY.some(tool => tool.class !== "delegation" && tool.name === params.tool))
          return { contentItems: [{ type: "inputText", text: "Tool is unavailable in this voice slice." }], success: false };
        if (!active.tool || active.stopping || active.failed) return { contentItems: [{ type: "inputText", text: "Voice session is unavailable." }], success: false };
        const result = await active.tool(params.tool, params.arguments, params.callId, params.turnId);
        return { contentItems: [{ type: "inputText", text: JSON.stringify(result) }], success: true };
      });
      let resolveSdp!: (sdp: string) => void; let rejectSdp!: (error: Error) => void;
      const answer = new Promise<string>((resolve, reject) => { resolveSdp = resolve; rejectSdp = reject; });
      // A notification can precede the RPC reply; attach the rejection handler
      // now so an early error never becomes an unhandled promise rejection.
      void answer.catch(() => {});
      const timer = setTimeout(() => rejectSdp(new CodexVoiceError("CODEX_UNSUPPORTED")), this.options.startTimeoutMs ?? 20_000);
      client.onNotification(notification => {
        const params = jsonObject(notification.params);
        if (notification.method === "account/rateLimits/updated") { this.limits(active, params?.rateLimits); return; }
        if (params?.threadId !== id) return;
        if (notification.method === "thread/realtime/sdp" && typeof params.sdp === "string" && params.sdp.length > 0 && params.sdp.length <= 96_000) {
          active.sdpReceived = true;
          resolveSdp(params.sdp);
        } else if (notification.method === "thread/realtime/error" && !active.sdpReceived) rejectSdp(new CodexVoiceError("PROVIDER_ERROR"));
        else this.notification(active, notification);
      });
      client.onLifecycle(event => {
        if (!active.stopping && (event.type === "failed" || event.type === "reaped")) {
          active.failed = true;
          rejectSdp(new CodexVoiceError("PROVIDER_ERROR"));
          active.lost?.();
        }
      });
      try {
        await client.request("thread/realtime/start", codexVoiceStart(id, locale, sdp, projectName));
        const answerSdp = await answer;
        if (active.failed || active.stopping) throw new CodexVoiceError("PROVIDER_ERROR");
        return { id, sdp: answerSdp };
      } catch (error) {
        if (error instanceof CodexVoiceError && error.message === "PROVIDER_ERROR") {
          const reading = jsonObject(await client.request("account/rateLimits/read").catch(() => null));
          const limit = this.limits(active, reading?.rateLimits);
          if (limit) throw new CodexVoiceError("CODEX_LIMIT_REACHED", limit.resetsAt);
        }
        throw error;
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (call) await this.hangup(call.id, "");
      else { client?.close(); await Promise.race([reaped, new Promise(resolve => setTimeout(resolve, 5000))]); fs.rmSync(cwd, { recursive: true, force: true }); }
      if (error instanceof CodexVoiceError) throw error;
      throw new CodexVoiceError("CODEX_UNSUPPORTED");
    }
  }
  private emit(call: Call, event: unknown) {
    if (call.event) call.event(event);
    else if (call.events.length < 1024) call.events.push(event);
    else if (!call.stopping) void this.hangup(call.id, "").catch(() => call.lost?.());
  }
  private notification(call: Call, notification: AppServerNotification) {
    const params = jsonObject(notification.params)!;
    if (notification.method === "thread/realtime/itemAdded") {
      const item = jsonObject(params.item);
      if (item?.type === "handoff_request" && typeof item.handoff_id === "string") this.emit(call, { type: "session.delegation.created", offset_ms: this.now() - call.createdAt, delegation: { id: item.handoff_id, target: "client" } });
    } else if (notification.method === "thread/tokenUsage/updated") {
      const usage = jsonObject(params.tokenUsage); const total = jsonObject(usage?.total);
      if (total) this.emit(call, { type: "codex.tokenUsage", tokens: Object.fromEntries(Object.entries(total).filter(([, value]) => Number.isSafeInteger(value) && (value as number) >= 0)) });
    } else if (notification.method === "thread/realtime/closed" || notification.method === "thread/realtime/error") {
      if (!call.stopping) {
        this.emit(call, { type: notification.method.endsWith("error") ? "error" : "session.closed" });
        void this.hangup(call.id, "").catch(() => call.lost?.());
      }
    } else if (notification.method === "turn/completed" && jsonObject(params.turn)?.status === "failed") {
      void call.client.request("thread/realtime/appendSpeech", { threadId: call.id, text: "The board could not be read just now." }).catch(() => call.lost?.());
    }
  }
  private limits(call: Call, value: unknown): { resetsAt: number | null } | null {
    const source = jsonObject(value); if (!source) return null;
    const window = (value: unknown): AppServerRateLimits["primary"] => {
      const row = jsonObject(value);
      return row && typeof row.usedPercent === "number" && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100
        ? { usedPercent: row.usedPercent, resetsAt: typeof row.resetsAt === "number" && Number.isSafeInteger(row.resetsAt) ? row.resetsAt : null,
          windowDurationMins: typeof row.windowDurationMins === "number" ? row.windowDurationMins : null } : null;
    };
    const rateLimits = { primary: window(source.primary), secondary: window(source.secondary), planType: typeof source.planType === "string" ? source.planType : null };
    const observation: QuotaObservation = { engine: "codex", accountId: call.account.id, authenticated: true, authCheckedAt: this.now(), observedAt: this.now(),
      limits: mapAppServerRateLimits(rateLimits, Math.floor(this.now() / 1000)), provenance: { source: "live", reason: null, staleSince: null } };
    if (this.options.recordObservation) this.options.recordObservation(observation); else recordLiveObservation(observation, "managed");
    const exhausted = [rateLimits.primary, rateLimits.secondary].filter(row => row && row.usedPercent >= 100);
    return exhausted.length || source.rateLimitReachedType ? { resetsAt: exhausted.every(row => row!.resetsAt !== null) && exhausted.length ? Math.max(...exhausted.map(row => row!.resetsAt!)) : null } : null;
  }
  async attach(id: string, _key: string, event: (value: unknown) => void, lost: () => void, tool?: LiveToolHandler): Promise<LiveConnection> {
    const call = this.calls.get(id); if (!call || call.stopping || call.failed) throw new CodexVoiceError("PROVIDER_ERROR");
    call.event = event; call.lost = lost; call.tool = tool;
    for (const queued of call.events.splice(0)) event(queued);
    return { send: command => {
      if (command.type === "session.close") void this.hangup(id, "").then(() => event({ type: "session.closed" }), lost);
      // Reports, context and interruption are added in slice 2.
    }, dispose: () => {
      call.event = undefined; call.lost = undefined; call.tool = undefined;
      // Session recovery retains the open flag until hangup confirms reaping.
      void this.hangup(id, "").catch(() => {});
    } };
  }
  async hangup(id: string, _key: string): Promise<void> {
    void _key;
    const call = this.calls.get(id); if (!call) return;
    if (call.stopping) return call.stopping;
    // Shutdown is irreversible even if reaping misses this attempt's deadline.
    call.failed = true;
    return call.stopping = (async () => {
      try { await call.client.request("thread/realtime/stop", { threadId: id }); } catch { /* closing stdio ends a failed call too */ }
      call.client.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([call.reaped, new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new CodexVoiceError("PROVIDER_ERROR")), 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      this.calls.delete(id); fs.rmSync(call.cwd, { recursive: true, force: true });
    })().catch(error => {
      // Keep the call for recovery, but let the next hangup await reaping anew.
      call.stopping = undefined;
      throw error;
    });
  }
  async respond(): Promise<never> { throw new CodexVoiceError("CODEX_UNSUPPORTED"); }
}
