import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { codexAccountBinary } from "@/lib/accounts/codexAppServer";
import { signalDetachedProcessGroup } from "@/lib/processGroup";
import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import type { AccountContext } from "@/lib/accounts/contracts";
import { validCloudThreadReference, type CloudStageClient, type CloudTaskAccess } from "./cloudStage";

// Desktop app protocol, verified against the hosted service; not a public API.
const ENDPOINT = "https://codex-cloud-backend.chatgpt.com";
const MODEL = "gpt-6.1-sol";
const MAX_FRAME = 16 * 1024 * 1024;
type Row = Record<string, unknown>;
type Auth = { token: string; account?: string };
type Input = Parameters<CloudStageClient["submit"]>[0];
type Guard = Pick<Input, "signal" | "assertCurrent">;
export type HostedCloudDependencies = {
  authenticate: (account: AccountContext, signal: AbortSignal) => Promise<Auth>;
  socket: (auth: Auth) => WebSocket;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  uuid: () => string;
};
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
function requireCloud(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`Codex Cloud ${code}`);
}
function text(value: unknown, code: string): string {
  requireCloud(typeof value === "string" && value.length > 0, code);
  return value;
}
function guard(input: Guard) { input.signal.throwIfAborted(); input.assertCurrent(); }
function shell(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
async function configuration(response: Response): Promise<Row> {
  requireCloud(response.body, "environment response missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCloud(size <= 1024 * 1024, "environment response too large");
      chunks.push(value);
    }
    return row(JSON.parse(Buffer.concat(chunks).toString()));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Raw native auth responses and stderr never cross this boundary. No API-key fallback. */
async function authenticate(account: AccountContext, signal: AbortSignal): Promise<Auth> {
  const env = { ...withoutUnsupportedApiCredentials({ ...process.env, ...account.env }), CODEX_HOME: account.home, RUST_LOG: "off" };
  const child = spawn(codexAccountBinary(env), ["app-server", "--listen", "stdio://"], {
    env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const pending = new Map<number, (message: Row) => void>();
  const lines = createInterface({ input: child.stdout });
  let bytes = 0;
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > MAX_FRAME) signalDetachedProcessGroup(child, "SIGKILL"); });
  lines.on("line", line => {
    try { const message = row(JSON.parse(line)); pending.get(Number(message.id))?.(message); }
    catch { /* Native diagnostics are deliberately discarded. */ }
  });
  let id = 0;
  const rpc = async (method: string, params: Row) => {
    const requestId = ++id;
    const response = await new Promise<Row>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer); signal.removeEventListener("abort", stop); pending.delete(requestId);
        reject(new Error("Codex Cloud native authentication stopped"));
      };
      const timer = setTimeout(stop, 15_000);
      const done = (message: Row) => {
        clearTimeout(timer); signal.removeEventListener("abort", stop); pending.delete(requestId);
        resolve(message);
      };
      pending.set(requestId, done);
      signal.addEventListener("abort", stop, { once: true });
      // Attach rejection handling before checking an already expired scope.
      if (signal.aborted) stop();
      else child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
    });
    requireCloud(!response.error, "native authentication refused");
    return row(response.result);
  };
  const stop = () => signalDetachedProcessGroup(child, "SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  try {
    await rpc("initialize", { clientInfo: { name: "delegatus_cloud", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const auth = await rpc("getAuthStatus", { includeToken: true, refreshToken: false });
    requireCloud(["chatgpt", "chatgptAuthTokens"].includes(String(auth.authMethod)), "requires an existing ChatGPT sign-in");
    const token = text(auth.authToken, "ChatGPT token unavailable");
    let claims: Row;
    try { claims = row(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())); }
    catch { throw new Error("Codex Cloud native authentication response invalid"); }
    const accountId = row(claims["https://api.openai.com/auth"]).chatgpt_account_id;
    requireCloud(typeof accountId === "string" && accountId.length > 0, "ChatGPT routing unavailable");
    return { token, account: accountId };
  } finally {
    signal.removeEventListener("abort", stop);
    for (const resolve of pending.values()) resolve({ error: true });
    pending.clear(); lines.close(); child.stdin.end();
    // Reap precisely the detached auth process group created above.
    const timer = setTimeout(stop, 1_000);
    await exited;
    clearTimeout(timer);
  }
}

class HostedConnection {
  private id = 0;
  private pending = new Map<number, { method: string; resolve: (value: Row) => void; reject: (error: Error) => void }>();
  private ownThread: string | null = null;
  private watchedThread: string | null = null;
  private rerouted = false;
  constructor(private ws: WebSocket, private input: Guard) {
    ws.on("error", () => this.fail("socket error"));
    ws.on("close", () => this.fail("socket closed"));
    ws.on("message", bytes => {
      const data = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer);
      if (data.length > MAX_FRAME) { this.fail("socket frame too large"); ws.terminate(); return; }
      let message: Row;
      try { message = row(JSON.parse(data.toString())); }
      catch { this.fail("socket protocol changed"); return; }
      const params = row(message.params);
      if (message.method && message.id !== undefined) {
        // Account-wide server request IDs are independent of our request IDs.
        if (params.threadId !== this.ownThread || !this.ownThread) return;
        try {
          guard(input);
          const approval = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(String(message.method));
          ws.send(JSON.stringify(approval ? { id: message.id, result: { decision: "acceptForSession" } }
            : { id: message.id, error: { code: -32601, message: "Unsupported unattended request" } }));
        } catch { this.fail("operation superseded"); }
        return;
      }
      if (message.method === "model/rerouted" && params.threadId === this.watchedThread && this.watchedThread) {
        this.rerouted = true; this.fail("model was rerouted");
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending || message.method) return;
      this.pending.delete(Number(message.id));
      // Remote messages may contain credentials; publish only the error code.
      if (message.error) pending.reject(new Error(`Codex Cloud RPC refused (${Number(row(message.error).code) || "unknown"})`));
      else {
        const result = row(message.result);
        if (pending.method === "thread/start" && typeof row(result.thread).id === "string") this.watch(String(row(result.thread).id));
        pending.resolve(result);
      }
    });
  }
  own(thread: string) { this.ownThread = thread; this.watch(thread); }
  watch(thread: string) { this.watchedThread = thread; }
  private fail(reason: string) {
    for (const pending of this.pending.values()) pending.reject(new Error(`Codex Cloud ${reason}`));
    this.pending.clear();
  }
  async open() {
    await new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", resolve);
      this.ws.once("error", () => reject(new Error("Codex Cloud handshake failed")));
      this.ws.once("close", () => reject(new Error("Codex Cloud handshake closed")));
      const stop = () => reject(new Error("Codex Cloud handshake timed out"));
      this.input.signal.addEventListener("abort", stop, { once: true });
      this.ws.once("open", () => this.input.signal.removeEventListener("abort", stop));
      if (this.input.signal.aborted) stop();
    });
    await this.rpc("initialize", { clientInfo: { name: "delegatus_cloud", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    guard(this.input);
    this.ws.send('{"method":"initialized","params":{}}');
  }
  async rpc(method: string, params: Row, receipt = false): Promise<Row> {
    guard(this.input);
    requireCloud(!this.rerouted, "model was rerouted");
    const id = ++this.id;
    const response = new Promise<Row>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params }), error => { if (error) this.fail("socket send failed"); }); }
      catch { this.fail("socket send failed"); }
    });
    const result = await response;
    if (!receipt) guard(this.input);
    requireCloud(!this.rerouted, "model was rerouted");
    return result;
  }
  close() { this.fail("operation stopped"); this.ws.terminate(); }
}

const defaults: HostedCloudDependencies = {
  authenticate,
  socket: auth => new WebSocket(ENDPOINT.replace("https:", "wss:") + "/", ["codex-app-server", "codex-client.desktop", `openai-bearer.${auth.token}`], {
    headers: { "X-OpenAI-Product-Sku": "codex", ...(auth.account ? { "ChatGPT-Account-Id": auth.account } : {}) },
    handshakeTimeout: 15_000, perMessageDeflate: false, maxPayload: MAX_FRAME,
  }),
  fetch,
  uuid: randomUUID,
};

/** Each controller job owns one bounded socket. There is no credential/session cache. */
export function createHostedCloudStageClient(dependencies: HostedCloudDependencies = defaults): CloudStageClient {
  async function using<T>(input: Guard & { account: AccountContext }, run: (client: HostedConnection, auth: Auth, scope: Guard) => Promise<T>, receipt = false): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    const scope = { ...input, signal: AbortSignal.any([input.signal, abort.signal]) };
    let client: HostedConnection | undefined;
    const stop = () => client?.close();
    scope.signal.addEventListener("abort", stop, { once: true });
    try {
      guard(scope);
      const auth = await dependencies.authenticate(input.account, scope.signal);
      guard(scope);
      client = new HostedConnection(dependencies.socket(auth), scope);
      await client.open();
      const result = await run(client, auth, scope);
      if (!receipt) guard(scope);
      return result;
    } catch (error) {
      if (scope.signal.aborted) throw new Error("Codex Cloud operation timed out");
      // Never forward dependency errors, URLs, auth stderr or raw RPC payloads.
      throw new Error(error instanceof Error && /^Codex Cloud [A-Za-z0-9 ()/-]+$/.test(error.message)
        ? error.message : "Codex Cloud transport failed");
    } finally { clearTimeout(timer); scope.signal.removeEventListener("abort", stop); client?.close(); }
  }
  async function command(client: HostedConnection, environment: Row, script: string) {
    const result = await client.rpc("command/exec", { environmentId: text(environment.environmentId, "environment instance missing"),
      processId: dependencies.uuid(), command: ["sh", "-lc", script], cwd: text(environment.cwd, "environment cwd missing"), outputBytesCap: 8192, timeoutMs: 15_000 });
    requireCloud(result.exitCode === 0 && typeof result.stdout === "string", "environment command failed");
    return result.stdout;
  }
  async function status(client: HostedConnection, input: CloudTaskAccess) {
    requireCloud(validCloudThreadReference(input.thread) && input.thread.hosted?.model === MODEL && input.taskId === input.thread.threadId
      && /^[a-f0-9]{40}$/i.test(input.headSha), "thread receipt missing");
    const threadId = input.thread.threadId;
    client.watch(threadId);
    // Status never adopts, resumes, interrupts or grants approvals on a live turn.
    const result = await client.rpc("thread/read", { threadId, includeTurns: false });
    const thread = row(result.thread), environments = thread.environments;
    requireCloud(thread.id === threadId && thread.ephemeral === false && Array.isArray(environments) && environments.length === 1, "thread identity mismatch");
    const environment = row(environments[0]);
    requireCloud((environment.environmentConfigId == null || environment.environmentConfigId === input.environmentId)
      && environment.environmentId === input.thread.hosted!.environmentId && environment.cwd === input.thread.hosted!.cwd, "thread environment mismatch");
    requireCloud((result.model == null || result.model === MODEL) && (thread.model == null || thread.model === MODEL), "resolved model mismatch");
    let cursor: unknown;
    for (let page = 0; page < 100; page++) {
      const turns = await client.rpc("thread/turns/list", { threadId, itemsView: "notLoaded", limit: 20, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
      requireCloud(Array.isArray(turns.data), "turn list changed");
      const turn = turns.data.map(row).find(turn => turn.id === input.thread!.turnId || turn.rootTurnId === input.thread!.turnId);
      if (turn) {
        requireCloud(turn.model == null || turn.model === MODEL, "turn model mismatch");
        return { threadId, environment, turn, model: MODEL };
      }
      if (!turns.nextCursor) break;
      requireCloud(JSON.stringify(cursor) !== JSON.stringify(turns.nextCursor), "turn cursor repeated");
      cursor = turns.nextCursor;
    }
    throw new Error("Codex Cloud recorded turn not found");
  }
  return {
    supportsModel: (model, effort) => model === MODEL && (effort === null || ["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)),
    submit: input => using(input, async (client, auth, scope) => {
      requireCloud(input.model === MODEL && input.allowProviderModelFallback === false, "explicit model unsupported");
      requireCloud(/(?:^|~)asenvcfg_[A-Za-z0-9]+$/.test(input.environmentId), "environment must be an ASB configuration");
      requireCloud(/^[a-f0-9]{40}$/i.test(input.headSha) && Buffer.byteLength(input.prompt) <= 1024 * 1024, "submission input invalid");
      guard(input);
      const response = await dependencies.fetch(`${ENDPOINT}/v1/environment-configs/${encodeURIComponent(input.environmentId)}`, {
        headers: { Authorization: `Bearer ${auth.token}`, "X-OpenAI-Product-Sku": "codex", ...(auth.account ? { "ChatGPT-Account-Id": auth.account } : {}) },
        redirect: "error", signal: scope.signal,
      });
      guard(input);
      requireCloud(response.ok, `environment HTTP ${response.status}`);
      const detail = await configuration(response);
      guard(input);
      requireCloud(detail.id === input.environmentId && Array.isArray(detail.repositories) && detail.repositories.length === 1, "environment configuration mismatch");
      const repository = row(detail.repositories[0]);
      const cwd = text(repository.mount_path, "environment mount missing");
      requireCloud(cwd.startsWith("/") && !cwd.includes("\0"), "environment mount invalid");
      const started = await client.rpc("thread/start", { model: input.model, allowProviderModelFallback: false, ephemeral: false,
        approvalPolicy: "never", sandbox: "danger-full-access", serviceName: "codex_cloud",
        config: { "features.mcp_app_ui": true, ...(input.reasoningEffort ? { model_reasoning_effort: input.reasoningEffort } : {}) },
        pluginsMcp: { productSku: "codex" }, environments: [{ environmentConfigId: input.environmentId, cwd }], deferredEnvironment: true });
      requireCloud(started.model === input.model, "resolved model mismatch");
      const thread = row(started.thread), environments = thread.environments;
      const threadId = text(thread.id, "thread id missing");
      requireCloud(/^[A-Za-z0-9_-]{1,160}$/.test(threadId) && thread.ephemeral === false
        && Array.isArray(environments) && environments.length === 1, "thread identity mismatch");
      const environment = row(environments[0]);
      requireCloud(environment.cwd === cwd && (environment.environmentConfigId == null || environment.environmentConfigId === input.environmentId)
        && String(environment.environmentId).startsWith("ccarenv_"), "resolved environment mismatch");
      client.own(threadId);
      // Provisioning uses the environment's default ref. Select and verify the
      // published lane explicitly before starting any model work.
      const branch = shell(input.branch), location = shell(cwd);
      requireCloud(input.branch.length > 0 && !input.branch.startsWith("-") && !input.branch.includes("\0"), "branch invalid");
      const head = await command(client, environment,
        `git -C ${location} fetch -q --no-tags origin ${shell("refs/heads/" + input.branch)} && git -C ${location} checkout -q -B ${branch} FETCH_HEAD && git -C ${location} rev-parse HEAD`);
      requireCloud(head.trim() === input.headSha, "published branch head mismatch");
      const accepted = await client.rpc("turn/start", { threadId, model: input.model, allowProviderModelFallback: false,
        approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
        input: [{ type: "text", text: input.prompt, text_elements: [] }] }, true);
      const turnId = text(row(accepted.turn).id, "accepted turn missing");
      requireCloud(/^[A-Za-z0-9_-]{1,160}$/.test(turnId), "accepted turn invalid");
      return { taskId: threadId, taskUrl: `https://chatgpt.com/codex/tasks/${threadId}`,
        thread: { threadId, turnId, hosted: { environmentId: String(environment.environmentId), cwd, model: input.model } } };
    }, true),
    poll: input => using(input, async client => {
      const { turn, model } = await status(client, input);
      if (turn.status === "completed" && !turn.error) return { state: "completed", model };
      if (turn.error || ["failed", "interrupted"].includes(String(turn.status))) return { state: "failed", error: `Codex Cloud turn ${turn.error ? "failed" : turn.status}`, model };
      requireCloud(turn.status === "inProgress", "turn status unknown");
      return { state: "pending", model };
    }),
    readFinalMessage: input => using(input, async (client, auth) => {
      const { threadId, turn, model, environment } = await status(client, input);
      requireCloud(turn.status === "completed" && !turn.error, "turn is not completed");
      const head = await command(client, environment, `git rev-parse HEAD`);
      requireCloud(head.trim() === input.headSha, "reviewed head changed");
      let cursor: unknown, message = "", size = 0;
      for (let page = 0; page < 100; page++) {
        const items = await client.rpc("thread/items/list", { threadId, turnId: turn.id, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) });
        requireCloud(Array.isArray(items.data), "item list changed");
        for (const entry of items.data.map(row)) {
          requireCloud(entry.turnId === turn.id, "item belongs to another turn");
          const item = row(entry.item);
          if (item.type === "agentMessage") {
            const value = text(item.text, "final message missing"); size += Buffer.byteLength(value);
            requireCloud(size <= 1024 * 1024, "final message too large"); message = value.replaceAll(auth.token, "[redacted]");
          }
        }
        if (!items.nextCursor) { requireCloud(message, "final message missing"); return { message, model }; }
        requireCloud(JSON.stringify(cursor) !== JSON.stringify(items.nextCursor), "item cursor repeated"); cursor = items.nextCursor;
      }
      throw new Error("Codex Cloud item pagination limit");
    }),
    // Slice 1 never asks for a diff. Keep export capability explicit for the next
    // transport consumer; no staging, follow-up model turn or patch application.
    readDiff: input => using(input, async (client, auth) => {
      const { turn, environment } = await status(client, input);
      requireCloud(turn.status === "completed" && !turn.error, "turn is not completed");
      const snapshot = `delegatus-review-${input.thread!.turnId}.patch`;
      const script = `import hashlib,json,pathlib,subprocess\np=pathlib.Path(subprocess.check_output(['git','rev-parse','--absolute-git-dir']).decode().strip())/${JSON.stringify(snapshot)}\nwith p.open('wb') as f: subprocess.run(['git','diff','--binary','--full-index','--no-ext-diff','--no-textconv',${JSON.stringify(input.headSha)},'--'],stdout=f,check=True)\nb=p.read_bytes()\nassert len(b)<=16777216\nprint(json.dumps({'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}))`;
      const manifest = row(JSON.parse(await command(client, environment, `python3 -c ${shell(script)}`)));
      requireCloud(Number.isSafeInteger(manifest.bytes) && Number(manifest.bytes) >= 0 && Number(manifest.bytes) <= MAX_FRAME
        && /^[a-f0-9]{64}$/.test(String(manifest.sha256)), "diff manifest invalid");
      const chunks: Buffer[] = [], digest = createHash("sha256");
      for (let offset = 0; offset < Number(manifest.bytes); offset += 3072) {
        const count = Math.min(3072, Number(manifest.bytes) - offset);
        const read = `import base64,pathlib,subprocess\np=pathlib.Path(subprocess.check_output(['git','rev-parse','--absolute-git-dir']).decode().strip())/${JSON.stringify(snapshot)}\nwith p.open('rb') as f:\n f.seek(${offset}); b=f.read(${count})\nprint(base64.b64encode(b).decode())`;
        const encoded = (await command(client, environment, `python3 -c ${shell(read)}`)).trim();
        const bytes = Buffer.from(encoded, "base64");
        requireCloud(bytes.length === count && bytes.toString("base64") === encoded, "diff chunk invalid");
        chunks.push(bytes); digest.update(bytes);
      }
      requireCloud(digest.digest("hex") === manifest.sha256, "diff checksum mismatch");
      const patch = Buffer.concat(chunks).toString("utf8");
      requireCloud(!patch.includes(auth.token), "diff contains credential");
      return patch;
    }),
  };
}

export const hostedCloudStageClient = createHostedCloudStageClient();
