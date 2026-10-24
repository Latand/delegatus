import { randomUUID } from "node:crypto";
import WebSocket from "ws";

/** Cloud and local execute the same admitted pre-push plan. Only infrastructure
 * failures permit a confirmed, single local fallback; check failures never do. */
export interface CloudJob { head: string; tree: string; base: string; bundle: string; timeoutMs: number }
export type CloudResult = { kind: "verdict"; head: string; tree: string; base: string; code: number }
  | { kind: "unavailable" | "cloud-limit" | "account-limit" | "invalid" };
export interface CloudTransport { run(job: CloudJob, signal?: AbortSignal): Promise<CloudResult> }
export async function runCloudChecks(job: CloudJob, transport: CloudTransport, local: () => Promise<number>, signal?: AbortSignal): Promise<number> {
  const until = Date.now() + job.timeoutMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return 75;
    const result = await transport.run({ ...job, timeoutMs: Math.max(1, until - Date.now()) }, signal);
    if (signal?.aborted) return 75;
    if (result.kind === "verdict") return result.head === job.head && result.tree === job.tree && result.base === job.base
      && Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : 1;
    if (result.kind === "account-limit") return 75;
    if (result.kind === "invalid") return 1;
  }
  return signal?.aborted ? 75 : local();
}

export interface CloudConfig { url: string; headers?: Record<string, string>; protocols?: string[]; environmentId: string; cwd: string }
export interface CloudRpc {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}
export type ConnectCloud = (config: CloudConfig) => Promise<CloudRpc>;
interface CloudClock { now(): number; sleep(ms: number): Promise<void> }
const cloudClock: CloudClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export class CloudRpcError extends Error {
  constructor(message: string, readonly category: "unavailable" | "cloud-limit" | "account-limit" | "invalid") { super(message); }
}
export function rpcFailure(error: { code?: unknown; message?: unknown; data?: { code?: unknown; codexErrorInfo?: unknown } }): CloudRpcError {
  const info = error.data?.codexErrorInfo;
  const code = String(error.data?.code ?? (info && typeof info === "object" && Object.keys(info).length === 1 ? Object.keys(info)[0] : info) ?? error.code);
  const category = ["usageLimitExceeded", "rateLimitExceeded", "accountLimitExceeded", "insufficientQuota", "sessionBudgetExceeded", "unauthorized"].includes(code) ? "account-limit"
    : ["cloudCapacityExceeded", "environmentTimeLimitExceeded", "environmentUnavailable", "serverOverloaded"].includes(code) ? "cloud-limit"
    : "invalid";
  return new CloudRpcError("Cloud RPC refused", category);
}


/** The hosted endpoint and credentials belong to private configuration. */
export const connectCloud: ConnectCloud = async config => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(config.url, config.protocols ?? [], { headers: config.headers, handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  } catch { throw new CloudRpcError("Cloud configuration refused", "invalid"); }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new CloudRpcError("Cloud connection unavailable", "unavailable")); }, 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new CloudRpcError("Cloud connection unavailable", "unavailable")); }, { once: true });
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume(); socket.terminate();
      reject(new CloudRpcError("Cloud handshake refused", [401, 403, 429].includes(response.statusCode ?? 0) ? "account-limit" : "unavailable"));
    });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(rpcFailure(message.error));
    else waiter.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new CloudRpcError("Cloud connection lost", "unavailable")); }
    pending.clear();
  });
  return {
    call(method, params) {
      if (method === "initialized") { socket.send(JSON.stringify({ jsonrpc: "2.0", method, params })); return Promise.resolve({}); }
      return new Promise((resolve, reject) => {
        const request = ++id;
        const timer = setTimeout(() => { pending.delete(request); reject(new CloudRpcError("Cloud RPC timed out", "unavailable")); }, 30_000);
        pending.set(request, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request, method, params }));
      });
    },
    close() { socket.close(); },
  };
};

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function cloudCommand(job: CloudJob, upload?: { directory: string; source: string }): string {
  const receipt = `DELEGATUS_GATE ${job.head} ${job.tree} ${job.base}`;
  return `set -eu
root=$(mktemp -d)
${upload ? `upload=${quote(upload.directory)}\ntrap 'rm -rf "$root" "$upload"' EXIT` : `trap 'rm -rf "$root"' EXIT`}
${upload ? `base64 -d ${quote(`${upload.directory}/bundle`)} > "$root/source.bundle"
git clone -q --no-hardlinks ${quote(upload.source)} "$root/repo"
git -C "$root/repo" fetch -q "$root/source.bundle" HEAD` : `printf %s ${quote(job.bundle)} | base64 -d > "$root/source.bundle"
git clone -q "$root/source.bundle" "$root/repo"`}
cd "$root/repo"
git checkout -q --detach ${quote(job.head)}
git update-ref refs/remotes/origin/main ${quote(job.base)}
test "$(git rev-parse HEAD^{tree})" = ${quote(job.tree)}
bun install --frozen-lockfile --ignore-scripts
mkdir -p "$root/home" "$root/config" "$root/tmp" "$root/state"
set +e
HOME="$root/home" XDG_CONFIG_HOME="$root/config" TMPDIR="$root/tmp" LLV_STATE_DIR="$root/state" LLV_SKIP_HOOKS=0 LLV_GATE_PUSH_HEAD=${quote(job.head)} LLV_GATE_RUNNER=off LLV_GATE_EXECUTION=local DELEGATUS_AGENT_CPU=off bun scripts/local-gate.ts pre-push --admitted
code=$?
set -e
test "$(git rev-parse HEAD^{tree})" = ${quote(job.tree)}
test -z "$(git status --porcelain --untracked-files=normal)"
printf '\\n${receipt} %s\\n' "$code"
exit "$code"`;
}

interface RemoteTurn { id: string; status: string; error?: { code?: unknown; codexErrorInfo?: unknown } }
async function readTurn(rpc: CloudRpc, threadId: string, turnId: string): Promise<RemoteTurn | undefined> {
  let cursor: unknown;
  const seen = new Set<string>();
  for (let pageCount = 0; pageCount < 100; pageCount++) {
    const page = await rpc.call("thread/turns/list", { threadId, cursor, itemsView: "notLoaded" });
    if (!Array.isArray(page.data)) throw new Error("Missing Cloud turn records");
    const turn = (page.data as RemoteTurn[]).find(value => value.id === turnId);
    if (turn) return turn;
    cursor = page.nextCursor;
    if (!cursor) return;
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error("Repeated Cloud result cursor");
    seen.add(key);
  }
  throw new Error("Cloud turn pagination limit");
}
function isExactCommand(actual: string, expected: string): boolean {
  return actual === expected || ["bash", "/bin/bash"].some(shell => ["-c", "-lc"].some(flag => actual === `${shell} ${flag} ${quote(expected)}`));
}

interface CommandEntry { turnId: string; item: { type: string; status: string; command: string; exitCode?: number; aggregatedOutput?: string } }
async function commandEntries(rpc: CloudRpc, threadId: string, turnId?: string): Promise<CommandEntry[]> {
  let cursor: unknown;
  const seen = new Set<string>();
  const entries: CommandEntry[] = [];
  for (let pageCount = 0; pageCount < 100; pageCount++) {
    const page = await rpc.call("thread/items/list", { threadId, turnId, cursor });
    if (!Array.isArray(page.data)) throw new Error("Missing Cloud command records");
    entries.push(...page.data as CommandEntry[]);
    if (entries.length > 10_000) throw new Error("Cloud command record limit");
    cursor = page.nextCursor;
    if (!cursor) return entries;
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error("Repeated Cloud result cursor");
    seen.add(key);
  }
  throw new Error("Cloud command pagination limit");
}
/** Shell uploads avoid sending source bytes through the model context. Each
 * bounded chunk has an independently observed command exit before the next. */
async function uploadBundle(rpc: CloudRpc, threadId: string, directory: string, bundle: string, until: number, clock: CloudClock, signal?: AbortSignal): Promise<string> {
  const chunks = bundle.match(/.{1,32768}/g) ?? [];
  if (!chunks.length) throw new Error("Empty source bundle");
  let firstTurnId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted || clock.now() >= until) throw new CloudRpcError("Cloud source transfer unavailable", "unavailable");
    const command = `umask 077; mkdir -p ${quote(directory)} && printf %s ${quote(chunk)} ${index ? ">>" : ">"} ${quote(`${directory}/bundle`)} # chunk ${index}`;
    await rpc.call("thread/shellCommand", { threadId, command, timeoutMs: Math.max(1, until - clock.now()) });
    let done = false;
    while (clock.now() < until && !signal?.aborted) {
      const entry = (await commandEntries(rpc, threadId)).find(value => value.item?.type === "commandExecution" && isExactCommand(value.item.command, command));
      if (entry && ["completed", "failed", "declined"].includes(entry.item.status)) {
        if (entry.item.exitCode !== 0 || !entry.turnId) throw new CloudRpcError("Cloud source transfer failed", "unavailable");
        firstTurnId ??= entry.turnId;
        done = true; break;
      }
      await clock.sleep(100);
    }
    if (!done) throw new CloudRpcError("Cloud source transfer unavailable", "unavailable");
  }
  return firstTurnId!;
}

/** Command records, never model prose, determine the verdict. */
export class AppServerCloudTransport implements CloudTransport {
  constructor(private config: CloudConfig | null, private connect: ConnectCloud = connectCloud, private report: (output: string) => void = console.error, private clock: CloudClock = cloudClock) {}
  private async commandVerdict(rpc: CloudRpc, threadId: string, turnId: string, command: string): Promise<CloudResult | undefined> {
    for (const entry of await commandEntries(rpc, threadId, turnId)) {
      const item = entry.item;
      if (entry.turnId !== turnId || item?.type !== "commandExecution" || !["completed", "failed"].includes(item.status)
        || !isExactCommand(item.command, command)) continue;
      const match = item.aggregatedOutput?.match(/DELEGATUS_GATE ([a-f0-9]{40}) ([a-f0-9]{40}) ([a-f0-9]{40}) (\d+)\s*$/);
      if (match && Number(match[4]) === item.exitCode) {
        this.report(item.aggregatedOutput!);
        return { kind: "verdict", head: match[1]!, tree: match[2]!, base: match[3]!, code: item.exitCode! };
      }
    }
  }
  async run(job: CloudJob, signal?: AbortSignal): Promise<CloudResult> {
    if (signal?.aborted) return { kind: "invalid" };
    if (!this.config) return { kind: "unavailable" };
    const until = this.clock.now() + job.timeoutMs;
    let rpc: CloudRpc;
    try { rpc = await this.connect(this.config); }
    catch (error) { return { kind: error instanceof CloudRpcError ? error.category : "unavailable" }; }
    let threadId: string | undefined, turnId: string | undefined, terminal = false, timedOut = false;
    let terminalFailure: "invalid" | "cloud-limit" | "account-limit" | "unavailable" = "invalid";
    let turnRequested = false;
    try {
      if (signal?.aborted) return { kind: "invalid" };
      await rpc.call("initialize", { clientInfo: { name: "delegatus-checks", version: "1" }, capabilities: { experimentalApi: true } });
      await rpc.call("initialized", {});
      const started = await rpc.call("thread/start", {
        model: "gpt-6.1-sol", allowProviderModelFallback: false, approvalPolicy: "never",
        sandbox: "danger-full-access", serviceName: "codex_cloud", ephemeral: false,
        environments: [{ environmentConfigId: this.config.environmentId, cwd: this.config.cwd }], deferredEnvironment: false,
      });
      threadId = (started.thread as { id?: string } | undefined)?.id;
      const environments = (started.thread as { environments?: { environmentConfigId?: string; cwd?: string }[] } | undefined)?.environments;
      if (!threadId || started.model !== "gpt-6.1-sol" || !Array.isArray(environments) || environments.length !== 1
        || environments[0]?.cwd !== this.config.cwd
        || (environments[0]?.environmentConfigId != null && environments[0].environmentConfigId !== this.config.environmentId)) return { kind: "invalid" };
      if (signal?.aborted) return { kind: "invalid" };
      const upload = { directory: `${this.config.cwd.replace(/\/$/, "")}/.delegatus-check-${randomUUID()}`, source: this.config.cwd };
      const firstUploadTurn = await uploadBundle(rpc, threadId, upload.directory, job.bundle, until, this.clock, signal);
      // Revert conversation history, not files: source bytes must not enter the model context.
      await rpc.call("thread/revert", { threadId, beforeTurnId: firstUploadTurn });
      const command = cloudCommand(job, upload);
      turnRequested = true;
      const turned = await rpc.call("turn/start", { threadId, sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: `Execute this exact shell command once. Do not edit source or repair failures. Return the command result.\n${command}` }] });
      turnId = (turned.turn as { id?: string } | undefined)?.id;
      if (!turnId) return { kind: "invalid" };
      while (this.clock.now() < until && !signal?.aborted) {
        const verdict = await this.commandVerdict(rpc, threadId, turnId, command);
        if (verdict) return verdict;
        const turn = await readTurn(rpc, threadId, turnId);
        if (turn && ["completed", "failed", "interrupted"].includes(turn.status)) {
          terminal = true;
          if (turn.error) terminalFailure = rpcFailure({ data: turn.error }).category;
          break;
        }
        await this.clock.sleep(500);
      }
      if (!terminal) {
        timedOut = !signal?.aborted;
        await rpc.call("turn/interrupt", { threadId, turnId });
        // Give Cloud time to record termination before another attempt.
        for (let attempt = 0; attempt < 20; attempt++) {
          const turn = await readTurn(rpc, threadId, turnId);
          if (turn && ["completed", "failed", "interrupted"].includes(turn.status)) { terminal = true; break; }
          await this.clock.sleep(500);
        }
        if (!terminal) return { kind: "cloud-limit" };
      }
      const verdict = await this.commandVerdict(rpc, threadId, turnId, command);
      if (verdict) return verdict;
      return { kind: timedOut ? "cloud-limit" : terminalFailure };
    } catch (error) {
      // Account refusals never spend the local fallback.
      if (error instanceof CloudRpcError && error.category === "account-limit") return { kind: "account-limit" };
      if (error instanceof CloudRpcError && error.category === "cloud-limit" && !turnId) return { kind: "cloud-limit" };
      if (turnRequested && !terminal && error instanceof CloudRpcError && error.category === "unavailable") {
        // Recover once to stop the old job when the connection permits it.
        // A confirmed transport outage still follows the bounded local fallback.
        let recovery: CloudRpc | undefined;
        try {
          recovery = await this.connect(this.config);
          await recovery.call("initialize", { clientInfo: { name: "delegatus-checks", version: "1" }, capabilities: { experimentalApi: true } });
          await recovery.call("initialized", {});
          if (turnId) await recovery.call("turn/interrupt", { threadId, turnId });
        } catch (recoveryError) {
          if (recoveryError instanceof CloudRpcError && recoveryError.category === "account-limit") return { kind: "account-limit" };
          // The coordinator confirms availability with its second attempt.
        }
        finally { recovery?.close(); }
        return { kind: "unavailable" };
      }
      return { kind: error instanceof CloudRpcError ? error.category : "invalid" };
    } finally { rpc.close(); }
  }
}
