import WebSocket from "ws";
import type { EphemeralAgentRun, EphemeralAgentResult } from "@/lib/agent/ephemeral";

export const CLOUD_MODEL = "gpt-6.1-sol";
export type CloudRequest = {
  ["prompt"]: string;
  environmentId: string;
  fullAccess: boolean;
  schema?: object;
  effort?: string | null;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (observation: { queued?: boolean; writingAnswer?: boolean }) => void;
};
/** A rejected call is safe to retry locally only when no Cloud turn remains running. */
export class CloudFailure extends Error {
  constructor(public readonly confirmed: boolean) { super("Codex Cloud unavailable"); }
}
export type CloudTransport = (request: CloudRequest) => Promise<string>;

/** One WebSocket per one-shot thread. No local account or execution slot is used. */
type CloudSocket = {
  send(data: string): void;
  close(): void;
  on(event: "open" | "close" | "error" | "message", listener: (data: unknown) => void): unknown;
};
export function createCloudTransport(connect: (endpoint: string, headers: Record<string, string>) => CloudSocket): CloudTransport {
  return async request => {
    const endpoint = process.env.LLV_CODEX_CLOUD_URL;
    if (!request.environmentId || !endpoint || !/^wss:\/\//.test(endpoint)) throw new CloudFailure(true);
    return new Promise<string>((resolve, reject) => {
      let socket: CloudSocket;
      try { socket = connect(endpoint, process.env.LLV_CODEX_CLOUD_TOKEN
        ? { Authorization: `Bearer ${process.env.LLV_CODEX_CLOUD_TOKEN}` } : {}); }
      catch { reject(new CloudFailure(true)); return; }
      let sequence = 0, threadId: string | undefined, turnId: string | undefined;
      let started = false, settled = false, output = "";
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(admissionTimer); clearTimeout(cancelTimer); request.signal.removeEventListener("abort", cancel);
        for (const call of pending.values()) call.reject(error ?? new CloudFailure(false));
        pending.clear(); socket.close();
        if (error) reject(error); else resolve(output);
      };
      const rpc = (method: string, params: object) => new Promise<Record<string, unknown>>((yes, no) => {
        const id = ++sequence; pending.set(id, { resolve: yes, reject: no });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
      // An interruption acknowledgement alone does not prove the turn ended.
      const cancel = () => {
        cancelTimer ??= setTimeout(() => finish(new CloudFailure(false)), 1000);
        if (!started) { finish(new CloudFailure(true)); return; }
        if (threadId && turnId) void rpc("turn/interrupt", { threadId, turnId }).catch(() => finish(new CloudFailure(false)));
        else finish(new CloudFailure(false));
      };
      const timer = setTimeout(cancel, request.timeoutMs);
      const admissionTimer = setTimeout(() => finish(new CloudFailure(true)), Math.min(15_000, request.timeoutMs));
      request.signal.addEventListener("abort", cancel, { once: true });
      socket.on("error", () => finish(new CloudFailure(!started)));
      socket.on("close", () => finish(new CloudFailure(!started)));
      socket.on("message", event => {
        try {
          const message = JSON.parse(String(event));
          if (typeof message.id === "number" && pending.has(message.id)) {
            const call = pending.get(message.id)!; pending.delete(message.id);
            if (message.error) call.reject(new CloudFailure(true)); else call.resolve(message.result ?? {});
            return;
          }
          if (message.params?.threadId !== threadId) return;
          if (message.method === "item/agentMessage/delta") output += message.params.delta ?? "";
          if (message.method === "item/completed" && message.params.item?.type === "agentMessage") output = message.params.item.text ?? output;
          if (message.method === "turn/started") { turnId = message.params.turn?.id; request.onProgress?.({}); }
          if (message.method === "turn/completed") {
            const status = message.params.turn?.status;
            if (status === "completed") { request.onProgress?.({ writingAnswer: true }); finish(); }
            else finish(new CloudFailure(status === "failed" || status === "interrupted"));
          }
        } catch { finish(new CloudFailure(!started)); }
      });
      socket.on("open", () => { void (async () => {
        try {
          await rpc("initialize", { clientInfo: { name: "delegatus-relay", version: "1" }, capabilities: {} });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          const response = await rpc("thread/start", {
            model: CLOUD_MODEL, approvalPolicy: "never", serviceTier: "ultrafast",
            environmentConfigId: request.environmentId,
            sandbox: request.fullAccess ? "danger-full-access" : "read-only",
            config: { ...(request.effort ? { model_reasoning_effort: request.effort } : {}), ...(request.fullAccess ? {} : {
              ...Object.fromEntries(["shell_tool", "unified_exec", "apps", "plugins", "goals", "memories", "browser_use", "computer_use", "sleep_tool", "view_image", "image_generation", "multi_agent"].map(feature => [`features.${feature}`, false])),
              project_doc_max_bytes: 0, "skills.include_instructions": false,
              include_environment_context: false, include_apps_instructions: false,
              include_collaboration_mode_instructions: false, include_permissions_instructions: false,
              "tools.experimental_request_user_input.enabled": false, web_search: "live", mcp_servers: {},
            }) },
          });
          threadId = (response.thread as { id?: string } | undefined)?.id;
          if (!threadId) throw new CloudFailure(true);
          request.signal.throwIfAborted();
          clearTimeout(admissionTimer);
          started = true;
          const turn = await rpc("turn/start", { threadId, input: [{ type: "text", text: request.prompt }], ...(request.schema ? { outputSchema: request.schema } : {}) });
          turnId = (turn.turn as { id?: string } | undefined)?.id;
        } catch (error) { finish(error instanceof CloudFailure ? error : new CloudFailure(!started)); }
      })(); });
      if (request.signal.aborted) cancel();
    });
  };
}
export const cloudTransport = createCloudTransport((endpoint, headers) => new WebSocket(endpoint, { headers, handshakeTimeout: 15_000, maxPayload: 1_048_576 }));

/** The local factory is lazy: Cloud never waits on local account admission. */
export function runCloudRelay(input: Omit<CloudRequest, "signal"> & {
  transport?: CloudTransport;
  local(): Promise<EphemeralAgentRun>;
  onFallback?(): void;
  decode?(text: string): unknown;
  authorize?(): void;
}): EphemeralAgentRun {
  const abort = new AbortController();
  const started = Date.now();
  let local: EphemeralAgentRun | undefined;
  const authorizationTimer = input.authorize ? setInterval(() => {
    try { input.authorize!(); } catch { abort.abort(); local?.cancel(); }
  }, 100) : undefined;
  authorizationTimer?.unref();
  const done = (async (): Promise<EphemeralAgentResult> => {
    try {
      input.authorize?.();
      const text = await (input.transport ?? cloudTransport)({ ...input, signal: abort.signal });
      const answer = input.decode ? input.decode(text) : JSON.parse(text);
      return { status: "done", answer, durationMs: Date.now() - started, code: null, signal: null };
    } catch (error) {
      if (abort.signal.aborted) return { status: "cancelled", answer: null, durationMs: Date.now() - started, code: null, signal: null };
      if (!(error instanceof CloudFailure) || !error.confirmed) throw error;
      input.onFallback?.();
      local = await input.local();
      if (abort.signal.aborted) local.cancel();
      return await local.done;
    } finally { clearInterval(authorizationTimer); }
  })();
  return { pid: null, identity: null, done, cancel() { abort.abort(); local?.cancel(); } };
}

/** Repository bindings take precedence over the target's general answer environment. */
export function cloudEnvironment(target: { project: string | null; cloudEnvironmentId?: string | null }, owner = false): string | null {
  if (target.project) {
    const bindings = JSON.parse(process.env.LLV_CODEX_CLOUD_PROJECT_ENVIRONMENTS ?? "{}") as Record<string, unknown>;
    const bound = bindings[target.project];
    if (typeof bound === "string" && bound) return bound;
  }
  if (owner) return target.project ? target.cloudEnvironmentId || null : null;
  return target.cloudEnvironmentId || process.env.LLV_CODEX_CLOUD_ENVIRONMENT_ID || null;
}
