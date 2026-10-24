import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { checkEnvironment, checkInputEnvironment } from "./gate-cache";
import { HostedCloudError as CloudRpcError, hostedRpcFailure as rpcFailure } from "../src/lib/pipelines/cloudHostedErrors";
import type { HostedCloudDependencies } from "../src/lib/pipelines/cloudHostedClient";
import type { CloudCheckConfig } from "./cloud-check-config";
export { CloudRpcError, rpcFailure };

/** Cloud and local execute the same admitted pre-push plan. Only infrastructure
 * failures permit a confirmed, single local fallback; check failures never do. */
export type CloudCheckInputs = Record<string, string | null | { file: string }>;
export interface CloudJob { head: string; tree: string; base: string; inputs: CloudCheckInputs; bundle: string; timeoutMs: number }
export type CloudResult = { kind: "verdict"; head: string; tree: string; base: string; inputs: string; code: number }
  | { kind: "unavailable" | "cloud-limit" | "account-limit" | "invalid" };
export interface CloudTransport { run(job: CloudJob, signal?: AbortSignal): Promise<CloudResult> }
export async function runCloudChecks(job: CloudJob, transport: CloudTransport, local: () => Promise<number>, signal?: AbortSignal): Promise<number> {
  const until = Date.now() + job.timeoutMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return 75;
    const result = await transport.run({ ...job, timeoutMs: Math.max(1, until - Date.now()) }, signal);
    if (signal?.aborted) return 75;
    if (result.kind === "verdict") return result.head === job.head && result.tree === job.tree && result.base === job.base && result.inputs === cloudInputDigest(job.inputs)
      && Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : 1;
    if (result.kind === "account-limit") return 75;
    if (result.kind === "invalid") return 1;
  }
  return signal?.aborted ? 75 : local();
}

export type CloudConfig = CloudCheckConfig;
export interface CloudRpc {
  cwd: string;
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}
export type ConnectCloud = (config: CloudConfig, signal?: AbortSignal, timeoutMs?: number) => Promise<CloudRpc>;
interface CloudClock { now(): number; sleep(ms: number): Promise<void> }
const cloudClock: CloudClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/** Native ChatGPT authentication, environment resolution and RPC are shared
 * with stage execution. Publication owns only transfer and verdict policy. */
export async function connectCloud(config: CloudConfig, signal = new AbortController().signal, timeoutMs = 30_000,
  dependencies?: HostedCloudDependencies): Promise<CloudRpc> {
  const { openHostedCloudSession, resolveHostedCloudEnvironment } = await import("../src/lib/pipelines/cloudHostedClient");
  const session = await openHostedCloudSession({ account: config.account, signal, assertCurrent: config.assertCurrent ?? (() => {}) }, timeoutMs, dependencies);
  try {
    const cwd = await resolveHostedCloudEnvironment(config.environmentId, session.auth, session.scope, dependencies);
    return { cwd, call: (method, params) => session.client.rpc(method, params), close: session.close };
  } catch (error) { session.close(); throw error; }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function inputName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ["PATH", "HOME", "TMPDIR", "NODE_ENV", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR",
    "GEMINI_CLI_HOME", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "LLV_LANG", "LLV_LAUNCHER_REEXEC", "LLV_LAUNCHER_CHECKOUT", "LLV_TOKEN", "LLV_DEBUG", "LLV_SKIP_HOOKS", "DELEGATUS_DEBUG"].includes(name)
    || /^(?:XDG_|LLV_(?:STATE|INBOX|VIEWER|SIGNAL|CPU|OWNED)_|DELEGATUS_|GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG(?:_COUNT|_PARAMETERS|_KEY_\d+|_VALUE_\d+)?)$)/.test(name)
    || (name.startsWith("LLV_GATE_") && !["LLV_GATE_CHECK_ENV", "LLV_GATE_BUN"].includes(name))) {
    throw new Error("Unsupported Cloud check input name");
  }
}

/** Capture exactly the canonical scalar inputs. Tracked file references are
 * remapped to the candidate checkout. Host files and compound path options
 * cannot silently disappear or read a different Cloud file. */
export function cloudCheckInputs(root: string, env: Partial<NodeJS.ProcessEnv>): CloudCheckInputs {
  const canonical = checkInputEnvironment(checkEnvironment(env));
  const result: CloudCheckInputs = {};
  const repository = realpathSync(root);
  for (const [name, value] of Object.entries(canonical)) {
    inputName(name);
    if (value === null) { Object.defineProperty(result, name, { value: null, enumerable: true }); continue; }
    if (value.includes("\0")) throw new Error("Unsupported Cloud check input value");
    let input: CloudCheckInputs[string] = value;
    if (name === "SHELL" && /^\/bin\/(?:ba)?sh$/.test(value)) { /* Standard Cloud shell path. */ }
    else if (path.isAbsolute(value)) {
      try {
        const file = realpathSync(value), relative = path.relative(repository, file);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !statSync(file).isFile()) throw new Error();
        execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root, stdio: "pipe" });
        input = { file: relative.split(path.sep).join("/") };
      } catch { throw new Error("Cloud check input is outside tracked files"); }
    } else if (/(?:^|[=\s])(?:\/|[A-Za-z]:[\\/])/.test(value) || value.startsWith("\\\\")) throw new Error("Unsupported Cloud check input path");
    Object.defineProperty(result, name, { value: input, enumerable: true });
  }
  return result;
}

export function cloudInputDigest(inputs: CloudCheckInputs): string {
  const declared = Object.hasOwn(inputs, "LLV_GATE_CHECK_ENV") ? inputs.LLV_GATE_CHECK_ENV : null;
  if (declared !== null && typeof declared !== "string") throw new Error("Invalid Cloud check input declaration");
  for (const name of (declared ?? "").split(",").map(name => name.trim()).filter(Boolean)) {
    inputName(name);
    if (!Object.hasOwn(inputs, name)) throw new Error("Missing declared Cloud check input");
  }
  return createHash("sha256").update(JSON.stringify(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

export function cloudCommand(job: CloudJob, upload?: { directory: string; source: string }): string {
  const receipt = `DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)}`;
  const inputs = Object.entries(job.inputs).map(([name, value]) => {
    inputName(name);
    if (value === null) return ""; // env -i also removes a Cloud environment's value.
    if (typeof value === "string") return `${name}=${quote(value)}`;
    if (!value.file || value.file.startsWith("/") || value.file.split("/").some(part => part === ".." || part === ".git")) throw new Error("Invalid Cloud input file");
    return `${name}="$PWD"/${quote(value.file)}`;
  }).filter(Boolean).join(" ");
  const files = Object.values(job.inputs).filter((value): value is { file: string } => value !== null && typeof value === "object")
    .map(value => `test -f "$PWD"/${quote(value.file)}`).join("\n");
  const environment = `env -i PATH="$PATH" ${inputs} HOME="$root/home" XDG_CONFIG_HOME="$root/config" TMPDIR="$root/tmp" LLV_STATE_DIR="$root/state"`;
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
${files}
mkdir -p "$root/home" "$root/config" "$root/tmp" "$root/state"
${environment} bun install --frozen-lockfile --ignore-scripts
set +e
${environment} LLV_SKIP_HOOKS=0 LLV_GATE_PUSH_HEAD=${quote(job.head)} LLV_GATE_RUNNER=off LLV_GATE_EXECUTION=local DELEGATUS_AGENT_CPU=off bun scripts/local-gate.ts pre-push --admitted
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
async function* commandEntries(rpc: CloudRpc, threadId: string, turnId?: string): AsyncGenerator<CommandEntry> {
  let cursor: unknown;
  const seen = new Set<string>();
  let count = 0;
  for (let pageCount = 0; pageCount < 100; pageCount++) {
    const page = await rpc.call("thread/items/list", { threadId, turnId, cursor });
    if (!Array.isArray(page.data)) throw new Error("Missing Cloud command records");
    count += page.data.length;
    if (count > 10_000) throw new Error("Cloud command record limit");
    for (const entry of page.data as CommandEntry[]) yield entry;
    cursor = page.nextCursor;
    if (!cursor) return;
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
      for await (const entry of commandEntries(rpc, threadId)) {
        if (entry.item?.type === "commandExecution" && isExactCommand(entry.item.command, command) && ["completed", "failed", "declined"].includes(entry.item.status)) {
          if (entry.item.status !== "completed" || entry.item.exitCode !== 0 || !entry.turnId) throw new CloudRpcError("Cloud source transfer refused", "invalid");
          firstTurnId ??= entry.turnId;
          done = true; break;
        }
      }
      if (done) break;
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
    for await (const entry of commandEntries(rpc, threadId, turnId)) {
      const item = entry.item;
      if (entry.turnId !== turnId || item?.type !== "commandExecution" || !["completed", "failed", "declined"].includes(item.status)
        || !isExactCommand(item.command, command)) continue;
      const match = item.aggregatedOutput?.match(/DELEGATUS_GATE ([a-f0-9]{40}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([a-f0-9]{64}) (\d+)\s*$/);
      if (item.status !== "declined" && !(item.status === "failed" && item.exitCode === 0) && match && Number(match[5]) === item.exitCode) {
        this.report(item.aggregatedOutput!);
        return { kind: "verdict", head: match[1]!, tree: match[2]!, base: match[3]!, inputs: match[4]!, code: item.exitCode! };
      }
      // Terminal exact-command evidence is decisive before another page or RPC.
      return { kind: "invalid" };
    }
  }
  async run(job: CloudJob, signal?: AbortSignal): Promise<CloudResult> {
    if (signal?.aborted) return { kind: "invalid" };
    if (!this.config) return { kind: "invalid" };
    const until = this.clock.now() + job.timeoutMs;
    let rpc: CloudRpc;
    try { rpc = await this.connect(this.config, signal, Math.max(1, until - this.clock.now())); }
    catch (error) { return { kind: error instanceof CloudRpcError ? error.category : "invalid" }; }
    let threadId: string | undefined, turnId: string | undefined, terminal = false, timedOut = false;
    let terminalFailure: "invalid" | "cloud-limit" | "account-limit" | "unavailable" = "invalid";
    let turnRequested = false;
    try {
      if (signal?.aborted) return { kind: "invalid" };
      const started = await rpc.call("thread/start", {
        model: "gpt-6.1-sol", allowProviderModelFallback: false, approvalPolicy: "never",
        sandbox: "danger-full-access", serviceName: "codex_cloud", ephemeral: false,
        environments: [{ environmentConfigId: this.config.environmentId, cwd: rpc.cwd }], deferredEnvironment: false,
      });
      threadId = (started.thread as { id?: string } | undefined)?.id;
      const environments = (started.thread as { environments?: { environmentConfigId?: string; cwd?: string }[] } | undefined)?.environments;
      if (!threadId || started.model !== "gpt-6.1-sol" || !Array.isArray(environments) || environments.length !== 1
        || environments[0]?.cwd !== rpc.cwd
        || (environments[0]?.environmentConfigId != null && environments[0].environmentConfigId !== this.config.environmentId)) return { kind: "invalid" };
      if (signal?.aborted) return { kind: "invalid" };
      const upload = { directory: `${rpc.cwd.replace(/\/$/, "")}/.delegatus-check-${randomUUID()}`, source: rpc.cwd };
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
          recovery = await this.connect(this.config, signal, Math.max(1, until - this.clock.now()));
          if (turnId) await recovery.call("turn/interrupt", { threadId, turnId });
        } catch (recoveryError) {
          if (recoveryError instanceof CloudRpcError && recoveryError.category === "account-limit") return { kind: "account-limit" };
          if (!(recoveryError instanceof CloudRpcError) || recoveryError.category === "invalid") return { kind: "invalid" };
          // The coordinator confirms availability with its second attempt.
        }
        finally { recovery?.close(); }
        return { kind: "unavailable" };
      }
      return { kind: error instanceof CloudRpcError ? error.category : "invalid" };
    } finally { rpc.close(); }
  }
}
