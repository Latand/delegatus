import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { checkEnvironment, checkInputEnvironment } from "./gate-cache";
import { decisiveRefusal } from "../src/lib/pipelines/publication";
import { HostedCloudError as CloudRpcError, HostedSessionTimeout, HostedRpcRefusal, HostedEnvironmentOffline, cloudDiagnosticText, hostedRpcFailure as rpcFailure } from "../src/lib/pipelines/cloudHostedErrors";
import type { HostedCloudDependencies } from "../src/lib/pipelines/cloudHostedClient";
import type { CloudCheckConfig } from "./cloud-check-config";
export { CloudRpcError, rpcFailure };

/** Cloud and local execute the same admitted pre-push plan. Only infrastructure
 * failures permit a confirmed, single local fallback; check failures never do. */
export type CloudCheckInputs = Record<string, string | null | { file: string }>;
export interface CloudJob { head: string; tree: string; base: string; inputs: CloudCheckInputs; bundle: string; timeoutMs: number; deadlineAt?: number }
export interface CloudDiagnostic {
  category: "connect/transport" | "environment" | "task failed" | "test failure" | "timeout" | "missing receipt" | "invalid receipt" | "account-limit" | "cloud-limit" | "cancelled";
  reason: string;
  taskUrl?: string;
}
export type CloudResult = ({ kind: "verdict"; head: string; tree: string; base: string; inputs: string; code: number }
  | { kind: "invalid"; code?: number }
  | { kind: "unavailable" | "cloud-limit" | "account-limit" }) & { diagnostic?: CloudDiagnostic };
export interface CloudTransport { run(job: CloudJob, signal?: AbortSignal): Promise<CloudResult> }
function validCloudReceipt(job: CloudJob, result: Extract<CloudResult, { kind: "verdict" }>): boolean {
  return result.head === job.head && result.tree === job.tree && result.base === job.base && result.inputs === cloudInputDigest(job.inputs)
    && Number.isInteger(result.code) && result.code >= 0 && result.code <= 255;
}
export async function runCloudChecks(job: CloudJob, transport: CloudTransport, local: () => Promise<number>, signal?: AbortSignal, report: (line: string) => void = console.error): Promise<number> {
  const until = Date.now() + job.timeoutMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) { report(cloudRefusalLine({ category: "cancelled", reason: "publication cancelled" })); return 75; }
    const result = await transport.run({ ...job, timeoutMs: Math.max(1, until - Date.now()) }, signal);
    if (signal?.aborted) { report(cloudRefusalLine({ ...result.diagnostic, category: "cancelled", reason: "publication cancelled" })); return 75; }
    if (result.kind === "verdict") {
      const valid = validCloudReceipt(job, result);
      if (!valid || result.code !== 0) report(cloudRefusalLine({ ...result.diagnostic,
        category: valid ? "test failure" : "invalid receipt",
        reason: valid ? result.diagnostic?.reason ?? `admitted checks exited ${result.code}` : "receipt does not bind the requested head, tree, base, inputs and exit" }));
      return valid ? result.code : 1;
    }
    report(cloudRefusalLine(result.diagnostic ?? { category: result.kind === "invalid" ? "missing receipt" : result.kind === "unavailable" ? "connect/transport" : result.kind, reason: "Cloud checks returned no valid verdict" }));
    if (result.kind === "account-limit") return 75;
    if (result.kind === "invalid" && result.diagnostic?.category === "timeout") {
      return /\bcleanup confirmed\b/.test(result.diagnostic.reason) ? 75 : 1;
    }
    if (result.kind === "invalid") {
      const code = result.code;
      return typeof code === "number" && Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
    }
  }
  return signal?.aborted ? 75 : local();
}

/** Only scrubbed local causes and reduced provider codes enter publication.
 * Provider prose and raw command logs stay inside the transport. */
export function cloudRefusalLine(diagnostic: CloudDiagnostic): string {
  return `pre-push: Cloud checks refused [${diagnostic.category}]: ${diagnostic.reason}${diagnostic.taskUrl ? `; ${diagnostic.taskUrl}` : ""}`;
}

function cloudErrorReason(error: unknown, config: CloudConfig | null): string {
  if (error instanceof HostedRpcRefusal) {
    const rpc = error.message.match(/\brpc (-?\d+)\b/)?.[1];
    const code = error.message.match(/\bcode (-?\d+)\b/)?.[1];
    // Provider prose may name accounts. Its typed category and numeric RPC
    // code explain the refusal without copying that prose into publication.
    return `provider RPC refused (category ${error.refusal}${rpc || code ? `, code ${rpc ?? code}` : ""})`;
  }
  const secrets = [config?.account.accountId, config?.account.home, config?.account.transcriptRoot, config?.environmentId,
    ...Object.entries(config?.account.env ?? {}).filter(([name]) => /token|key|secret|password|account|email/i.test(name)).map(([, value]) => value)];
  // Node exposes these fields on spawn/open failures. Keep only a finite
  // operation and native code; the message itself may contain a spaced path.
  const nativeCodes = new Set(["EACCES", "EADDRINUSE", "ECONNREFUSED", "EEXIST", "EIO", "EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "ENOTEMPTY", "EPERM", "EPIPE", "ETIMEDOUT"]);
  const operations: Record<string, string> = { access: "access", connect: "connect", copyfile: "copy", mkdir: "create directory", open: "open", read: "read", rename: "rename", spawn: "spawn", stat: "inspect", unlink: "remove", write: "write" };
  if (error && typeof error === "object") {
    const native = error as { code?: unknown; syscall?: unknown };
    if (typeof native.code === "string" && nativeCodes.has(native.code)) {
      const syscall = typeof native.syscall === "string" ? native.syscall.split(/[\s(]/, 1)[0]! : "";
      const operation = Object.hasOwn(operations, syscall) ? operations[syscall] : undefined;
      if (operation) return `${operation} failed (${native.code})`;
    }
  }
  const rawMessage = error instanceof Error ? error.message : "";
  // An unquoted absolute path can contain arbitrary spaces. Once one appears,
  // retaining any suffix risks publishing the remainder of that private path.
  if (/(?:^|[\s("'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*/.test(rawMessage)) return "operation failed (path redacted)";
  const message = rawMessage;
  return cloudDiagnosticText(message, secrets, 400) || "operation failed without a recognised diagnostic";
}

export type CloudConfig = CloudCheckConfig;
export interface CloudRpc {
  cwd: string;
  call(method: string, params: Record<string, unknown>, onDispatch?: () => void): Promise<Record<string, unknown>>;
  close(): void;
}
export type ConnectCloud = (config: CloudConfig, signal?: AbortSignal, timeoutMs?: number) => Promise<CloudRpc>;
interface CloudClock { now(): number; sleep(ms: number): Promise<void> }
const cloudClock: CloudClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/** Native ChatGPT authentication, environment resolution and RPC are shared
 * with stage execution. Publication owns only transfer and verdict policy. */
export async function connectCloud(config: CloudConfig, signal = new AbortController().signal, timeoutMs = 30_000,
  dependencies?: HostedCloudDependencies): Promise<CloudRpc> {
  const { CloudEnvironmentMissingError, openHostedCloudSession, resolveHostedCloudEnvironment } = await import("../src/lib/pipelines/cloudHostedClient");
  const session = await openHostedCloudSession({ account: config.account, signal, assertCurrent: config.assertCurrent ?? (() => {}) }, timeoutMs, dependencies);
  try {
    const cwd = await resolveHostedCloudEnvironment(config.environmentId, session.auth, session.scope, dependencies);
    return { cwd, call: (method, params, onDispatch) => session.client.rpc(method, params, false, onDispatch), close: session.close };
  } catch (error) {
    session.close();
    // Stages can replace a missing environment. For publication a catalogue
    // 404 is a configuration refusal and supplies no evidence of a Cloud limit.
    if (error instanceof CloudEnvironmentMissingError) throw new CloudRpcError(error.message, "invalid", error.diagnostic);
    throw error;
  }
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
  // Tool routing is selected by the trusted Cloud command below. It is not a
  // candidate-controlled portable input and must never cross input capture.
  delete canonical.LLV_GATE_CANONICAL_TOOLS;
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
  const environment = `env -i PATH="$PATH" ${inputs} LLV_GATE_CANONICAL_TOOLS=1 LLV_GATE_CHECKPOINT_CLEANUP=cloud-owned-runner HOME="$root/home" XDG_CONFIG_HOME="$root/config" TMPDIR="$root/tmp" LLV_STATE_DIR="$root/state"`;
  const deadlineAt = job.deadlineAt ?? Date.now() + job.timeoutMs;
  return `set -eu
setup_source=${upload ? quote(upload.source) : '"$PWD"'}
git_common=$(git rev-parse --git-common-dir)
case "$git_common" in /*) ;; *) git_common="$PWD/$git_common" ;; esac
root="$git_common/delegatus-cloud-checks"
umask 077
mkdir -p "$root"
chmod 700 "$root"
${upload ? `upload=${quote(upload.directory)}\ntrap 'rm -rf "$upload"' EXIT` : ""}
${upload ? `base64 -d ${quote(`${upload.directory}/bundle`)} > "$root/source.bundle"
if ! git -C "$root/repo" rev-parse --git-dir >/dev/null 2>&1; then git clone -q --no-hardlinks ${quote(upload.source)} "$root/repo"; fi
if ! git -C "$root/repo" cat-file -e ${quote(`${job.base}^{commit}`)} 2>/dev/null; then
  git -C "$root/repo" fetch -q --no-tags "$(git -C ${quote(upload.source)} remote get-url origin)" ${quote(job.base)}
fi
git -C "$root/repo" fetch -q "$root/source.bundle" HEAD` : `printf %s ${quote(job.bundle)} | base64 -d > "$root/source.bundle"
if ! git -C "$root/repo" rev-parse --git-dir >/dev/null 2>&1; then git clone -q "$root/source.bundle" "$root/repo"; else git -C "$root/repo" fetch -q "$root/source.bundle" HEAD; fi`}
rm -f "$root/source.bundle"
cd "$root/repo"
git reset --hard -q
git clean -fdq
git checkout -q --detach ${quote(job.head)}
git update-ref refs/remotes/origin/main ${quote(job.base)}
test "$(git rev-parse HEAD^{tree})" = ${quote(job.tree)}
test "$(git status --porcelain --untracked-files=normal)" = ""
${files}
mkdir -p "$root/home" "$root/config" "$root/tmp" "$root/state"
${environment} bun scripts/cloud-check-dependencies.ts "$setup_source"
set +e
${environment} LLV_SKIP_HOOKS=0 LLV_GATE_PUSH_HEAD=${quote(job.head)} LLV_GATE_PUSH_DEADLINE=${quote(String(deadlineAt))} LLV_GATE_RUNNER=off LLV_GATE_EXECUTION=local DELEGATUS_AGENT_CPU=off bun "$setup_source/scripts/local-gate.ts" pre-push --admitted
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
export function isExactCommand(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (actual.includes("\0")) return false;
  // Decode literal argv renderings only, without evaluating a shell. Adjacent
  // quoted fragments and escaped quotes may spell the same argument. Expansion,
  // operators and a second wrapper cannot prove the submitted command ran.
  const words: string[] = [];
  let word = "", started = false, quoted: "'" | '"' | undefined;
  for (let index = 0; index < actual.length; index++) {
    const char = actual[index]!;
    if (quoted === "'") {
      if (char === "'") quoted = undefined;
      else word += char;
    } else if (char === "\\") {
      const next = actual[index + 1];
      if (next === undefined) return false;
      // Double quotes preserve backslashes except before these shell bytes.
      if (quoted === '"' && !'$`"\\\n'.includes(next)) word += char;
      else {
        if (next !== "\n") { word += next; started = true; }
        index++;
      }
    } else if (quoted === '"' && char === '"') quoted = undefined;
    else if (!quoted && (char === "'" || char === '"')) { quoted = char; started = true; }
    else if (!quoted && (char === " " || char === "\t")) {
      if (started) { words.push(word); word = ""; started = false; }
      if (words.length > 3) return false;
    } else {
      if (char === "$" || char === "`" || (!quoted && !/[a-zA-Z0-9_./-]/.test(char))) return false;
      word += char;
      started = true;
    }
  }
  if (quoted) return false;
  if (started) words.push(word);
  return words.length === 3 && ["bash", "/bin/bash"].includes(words[0]!) && ["-c", "-lc"].includes(words[1]!) && words[2] === expected;
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
/** A terminal turn can still have an executing command. Cleanup is confirmed
 * only when the exact launched command has a terminal provider record. */
async function terminalCommandObserved(rpc: CloudRpc, threadId: string, turnId: string, command: string): Promise<boolean> {
  let found = false;
  let allTerminal = true;
  for await (const entry of commandEntries(rpc, threadId, turnId)) {
    const item = entry.item;
    if (entry.turnId !== turnId || item?.type !== "commandExecution" || !isExactCommand(item.command, command)) continue;
    found = true;
    if (!["completed", "failed", "declined"].includes(item.status)) allTerminal = false;
  }
  return found && allTerminal;
}
/** Shell uploads avoid sending source bytes through the model context. Each
 * bounded chunk has an independently observed command exit before the next. */
async function uploadBundle(rpc: CloudRpc, environmentId: string, directory: string, bundle: string, until: number, clock: CloudClock, signal?: AbortSignal): Promise<void> {
  const chunks = bundle.match(/.{1,32768}/g) ?? [];
  if (!chunks.length) throw new Error("Empty source bundle");
  for (const [index, chunk] of chunks.entries()) {
    const command = `umask 077; mkdir -p ${quote(directory)} && printf %s ${quote(chunk)} ${index ? ">>" : ">"} ${quote(`${directory}/bundle`)} # chunk ${index}`;
    const processId = randomUUID();
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted || clock.now() >= until) throw new CloudRpcError("Cloud source transfer unavailable", "unavailable");
      try {
        const result = await rpc.call("command/exec", { environmentId, processId, command: ["sh", "-lc", command], cwd: rpc.cwd,
          outputBytesCap: 1024, timeoutMs: Math.min(15_000, Math.max(1, until - clock.now())) });
        if (result.exitCode !== 0) throw new CloudRpcError("Cloud source transfer refused", "invalid");
        break;
      } catch (error) {
        // Only this provider refusal proves that nothing ran. Lost responses
        // and other conflicts never replay an append.
        if (!(error instanceof HostedEnvironmentOffline) || attempt >= 40) throw error;
        await clock.sleep(3_000);
      }
    }
  }
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
        const output = item.aggregatedOutput ?? "";
        const deadlineExit = item.exitCode === 75
          && /^(?:pre-push: no verdict within the push budget of \d+ s:|touched-tests: no verdict: |owned runner: (?:deadline expired|execution guard expired)|command timed out after \d+ms)/m.test(output)
          && !output.split("\n").some(line => decisiveRefusal(line.trim()));
        if (deadlineExit) return { kind: "invalid", code: 75,
          diagnostic: { category: "timeout", reason: "Cloud check deadline expired; remote cleanup confirmed" } };
        // The raw command log can contain private test output; the bound exit
        // and reduced diagnostic are the publication record.
        const failedStep = item.aggregatedOutput?.match(/^pre-push: (types|eslint|touched tests|Linux tests|Linux backend|runtime verdict tests|Viewer build|MCP size budgets|Viewer runtime|runtime host|runtime negative controls|supply chain|frozen install): failed \(/m)?.[1];
        return { kind: "verdict", head: match[1]!, tree: match[2]!, base: match[3]!, inputs: match[4]!, code: item.exitCode!,
          ...(item.exitCode !== 0 ? { diagnostic: { category: "test failure" as const, reason: `admitted checks exited ${item.exitCode}${failedStep ? ` (${failedStep})` : ""}` } } : {}) };
      }
      // Terminal exact-command evidence is decisive before another page or RPC.
      if (/^DELEGATUS_ENVIRONMENT: installed dependencies do not match setup; rerun environment setup$/m.test(item.aggregatedOutput ?? "")) return { kind: "invalid", code: item.exitCode,
        diagnostic: { category: "environment", reason: "Cloud installed dependencies do not match the candidate lockfile, manifest or patches; rerun environment setup" } };
      if (/Repository lacks these prerequisite commits/.test(item.aggregatedOutput ?? "")) return { kind: "invalid",
        diagnostic: { category: "environment", reason: "Cloud source checkout lacks the incremental bundle base commit" } };
      if (/\bbun: (?:command )?not found\b|^env: (?:‘bun’|'bun'|bun): No such file or directory\r?$/m.test(item.aggregatedOutput ?? "")) return { kind: "invalid", code: item.exitCode,
        diagnostic: { category: "environment", reason: `Cloud environment has no bun executable (exit ${Number.isInteger(item.exitCode) ? item.exitCode : "unknown"}); admitted checks did not start` } };
      return { kind: "invalid", diagnostic: { category: match ? "invalid receipt" : "missing receipt",
        reason: `exact command ${item.status} (exit ${Number.isInteger(item.exitCode) ? item.exitCode : "unknown"}); ${match ? "receipt and command exit disagree" : "no bound receipt"}` } };
    }
  }
  async run(job: CloudJob, signal?: AbortSignal): Promise<CloudResult> {
    const context: { phase: CloudDiagnostic["category"]; threadId?: string; reason?: string } = { phase: "connect/transport" };
    const result = await this.runRemote(job, context, signal);
    if (result.kind === "verdict" && result.code === 0 && validCloudReceipt(job, result)) return result;
    const taskUrl = context.threadId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(context.threadId) ? `codex://threads/${context.threadId}?hostId=durable` : undefined;
    const category: CloudDiagnostic["category"] = result.kind === "account-limit" ? "account-limit"
      : result.kind === "cloud-limit" && context.phase !== "timeout" ? "cloud-limit" : context.phase;
    const diagnostic: CloudDiagnostic = result.kind === "verdict"
      ? validCloudReceipt(job, result)
        ? result.diagnostic ?? { category: "test failure", reason: `admitted checks exited ${result.code}` }
        : { category: "invalid receipt", reason: "receipt does not bind the requested head, tree, base, inputs and exit" }
      : result.diagnostic ?? { category, reason: context.reason ?? "Cloud task ended without a command receipt" };
    const diagnosed: CloudResult = { ...result, diagnostic: { ...diagnostic, ...(taskUrl ? { taskUrl } : {}) } };
    this.report(cloudRefusalLine(diagnosed.diagnostic!));
    return diagnosed;
  }
  /** Cleanup has its own short deadline after the observation session expires.
   * Never resume or start work on this connection; only stop the bound turn. */
  private async stopExpiredTurn(threadId: string, turnId: string, command: string, interruptRequested: boolean): Promise<string> {
    const abort = new AbortController();
    let recovery: CloudRpc | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<string>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve("unresolved (cleanup deadline expired)"); }, 10_000);
    });
    const cleanup = async () => {
      try {
        recovery = await this.connect(this.config!, abort.signal, 10_000);
        if (abort.signal.aborted) return "unresolved (cleanup deadline expired)";
        if (!interruptRequested) await recovery.call("turn/interrupt", { threadId, turnId });
        for (let attempt = 0; attempt < 20 && !abort.signal.aborted; attempt++) {
          const turn = await readTurn(recovery, threadId, turnId);
          if (turn && ["completed", "failed", "interrupted"].includes(turn.status)
            && await terminalCommandObserved(recovery, threadId, turnId, command)) return "confirmed";
          await this.clock.sleep(500);
        }
        return "unresolved (termination not confirmed)";
      } catch { return "unresolved (cleanup connection or confirmation refused)"; }
      finally { recovery?.close(); }
    };
    try { return await Promise.race([cleanup(), stopped]); }
    finally { clearTimeout(timer); abort.abort(); recovery?.close(); }
  }
  /** After the polling deadline every failed interrupt or confirmation read
   * keeps the timeout policy: bounded cleanup on a fresh connection, no
   * account-limit or availability verdict, so neither a second Cloud attempt
   * nor the local fallback can start beside the still-bound remote command. */
  private async expiredAfterFailure(error: unknown, context: { phase: CloudDiagnostic["category"]; reason?: string },
    threadId: string, turnId: string, command: string, interruptRequested: boolean): Promise<CloudResult> {
    const failure = cloudErrorReason(error, this.config);
    const cleanup = await this.stopExpiredTurn(threadId, turnId, command, interruptRequested);
    context.phase = "timeout";
    context.reason = `Cloud check deadline expired; remote cleanup ${cleanup}; interrupt or confirmation failed: ${failure}; no bound command receipt`;
    return { kind: "invalid" };
  }
  private async runRemote(job: CloudJob, context: { phase: CloudDiagnostic["category"]; threadId?: string; reason?: string }, signal?: AbortSignal): Promise<CloudResult> {
    if (signal?.aborted) { context.phase = "cancelled"; context.reason = "publication cancelled"; return { kind: "invalid" }; }
    if (!this.config) { context.phase = "environment"; context.reason = "Cloud configuration is missing"; return { kind: "invalid" }; }
    const until = this.clock.now() + job.timeoutMs;
    let rpc: CloudRpc;
    try { rpc = await this.connect(this.config, signal, Math.max(1, until - this.clock.now())); }
    catch (error) { if (error instanceof HostedSessionTimeout) { context.phase = "timeout"; context.reason = "Cloud session deadline expired before task submission"; return { kind: "invalid" }; }
      context.reason = cloudErrorReason(error, this.config); if (/environment|authentication|ChatGPT|ENOENT/.test(context.reason)) context.phase = "environment";
      return { kind: error instanceof CloudRpcError ? error.category : "invalid" }; }
    let threadId: string | undefined, turnId: string | undefined, terminal = false, timedOut = false, command = "";
    let terminalFailure: "invalid" | "cloud-limit" | "account-limit" | "unavailable" = "invalid";
    let turnRequested = false, interruptRequested = false;
    try {
      if (signal?.aborted) return { kind: "invalid" };
      context.phase = "environment";
      context.reason = "Cloud thread model or environment does not match the requested configuration";
      const started = await rpc.call("thread/start", {
        model: "gpt-6.1-sol", allowProviderModelFallback: false, approvalPolicy: "never",
        sandbox: "danger-full-access", serviceName: "codex_cloud", ephemeral: false,
        environments: [{ environmentConfigId: this.config.environmentId, cwd: rpc.cwd }], deferredEnvironment: false,
      });
      threadId = context.threadId = (started.thread as { id?: string } | undefined)?.id;
      const environments = (started.thread as { environments?: { environmentConfigId?: string; environmentId?: string; cwd?: string }[] } | undefined)?.environments;
      if (!threadId || started.model !== "gpt-6.1-sol" || !Array.isArray(environments) || environments.length !== 1
        || environments[0]?.cwd !== rpc.cwd || !environments[0]?.environmentId?.startsWith("ccarenv_")
        || (environments[0]?.environmentConfigId != null && environments[0].environmentConfigId !== this.config.environmentId)) return { kind: "invalid" };
      if (signal?.aborted) return { kind: "invalid" };
      context.phase = "task failed"; context.reason = "Cloud source transfer or task submission failed";
      const upload = { directory: `${rpc.cwd.replace(/\/$/, "")}/.delegatus-check-${randomUUID()}`, source: rpc.cwd };
      await uploadBundle(rpc, environments[0].environmentId, upload.directory, job.bundle, until, this.clock, signal);
      command = cloudCommand(job, upload);
      turnRequested = true;
      const turned = await rpc.call("turn/start", { threadId, sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: `Execute this exact shell command once. Do not edit source or repair failures. Return the command result.\n${command}` }] });
      turnId = (turned.turn as { id?: string } | undefined)?.id;
      if (!turnId) { context.reason = "Cloud task submission returned no turn identity"; return { kind: "invalid" }; }
      context.phase = "missing receipt"; context.reason = "Cloud task ended without an exact command receipt";
      while (this.clock.now() < until && !signal?.aborted) {
        const verdict = await this.commandVerdict(rpc, threadId, turnId, command);
        if (verdict) return verdict;
        const turn = await readTurn(rpc, threadId, turnId);
        if (turn && ["completed", "failed", "interrupted"].includes(turn.status)) {
          terminal = true;
          if (turn.status !== "completed") { context.phase = "task failed"; context.reason = `Cloud task ${turn.status}`; }
          if (turn.error) { const error = rpcFailure({ data: turn.error }); terminalFailure = error.category; context.reason = cloudErrorReason(error, this.config); }
          break;
        }
        await this.clock.sleep(500);
      }
      if (!terminal) {
        timedOut = !signal?.aborted;
        context.phase = timedOut ? "timeout" : "cancelled"; context.reason = timedOut ? "Cloud check deadline expired" : "publication cancelled";
        try {
          await rpc.call("turn/interrupt", { threadId, turnId }, () => { interruptRequested = true; });
          // Give Cloud time to record termination before another attempt.
          for (let attempt = 0; attempt < 20; attempt++) {
            const turn = await readTurn(rpc, threadId, turnId);
            if (turn && ["completed", "failed", "interrupted"].includes(turn.status)) { terminal = true; break; }
            await this.clock.sleep(500);
          }
        } catch (error) {
          if (!timedOut) throw error;
          return await this.expiredAfterFailure(error, context, threadId, turnId, command, interruptRequested);
        }
        if (!terminal) {
          context.phase = "timeout";
          context.reason = "Cloud check deadline expired; remote cleanup unresolved (turn termination not confirmed)";
          return { kind: "invalid" };
        }
      }
      let verdict: CloudResult | undefined;
      try { verdict = await this.commandVerdict(rpc, threadId, turnId, command); }
      catch (error) {
        if (!timedOut) throw error;
        return await this.expiredAfterFailure(error, context, threadId, turnId, command, interruptRequested);
      }
      if (timedOut) {
        // A terminal model turn alone does not prove its exact command stopped.
        // Capacity fallback would race that command and could publish without
        // its receipt, so timeout is decisive unless a bound command receipt exists.
        if (verdict?.kind === "verdict" && validCloudReceipt(job, verdict)) return verdict;
        const cleanup = await this.stopExpiredTurn(threadId, turnId, command, interruptRequested);
        context.phase = "timeout";
        context.reason = `Cloud check deadline expired; remote cleanup ${cleanup}; no bound command receipt`;
        return { kind: "invalid" };
      }
      if (verdict) return verdict;
      return { kind: terminalFailure };
    } catch (error) {
      if (signal?.aborted) {
        context.phase = "cancelled";
        context.reason = "publication cancelled; remote cleanup unresolved";
        return { kind: "invalid" };
      }
      if (error instanceof HostedSessionTimeout) {
        context.phase = "timeout";
        const cleanup = threadId && turnId
          ? await this.stopExpiredTurn(threadId, turnId, command, interruptRequested) : "unresolved (no bound turn identity)";
        context.reason = `Cloud session deadline expired; remote cleanup ${cleanup}`;
        return { kind: "invalid" };
      }
      context.reason = cloudErrorReason(error, this.config);
      if (error instanceof HostedRpcRefusal) context.reason += ` during ${context.phase === "environment" ? "thread/start" : !turnRequested ? "source upload" : "task execution"}`;
      if (error instanceof CloudRpcError && error.category === "unavailable") context.phase = "connect/transport";
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
          const originalReason = context.reason ?? "remote operation failed";
          const recoveryReason = cloudErrorReason(recoveryError, this.config);
          context.reason = `recovery connection refused: ${recoveryReason}; original operation: ${originalReason}`;
          if (recoveryError instanceof CloudRpcError && recoveryError.category === "account-limit") {
            context.phase = "account-limit";
            return { kind: "account-limit" };
          }
          if (!(recoveryError instanceof CloudRpcError) || recoveryError.category === "invalid") {
            context.phase = recoveryError instanceof HostedRpcRefusal && recoveryError.refusal === "configuration" ? "environment" : "connect/transport";
            return { kind: "invalid" };
          }
          // The coordinator confirms availability with its second attempt.
        }
        finally { recovery?.close(); }
        return { kind: "unavailable" };
      }
      return { kind: error instanceof CloudRpcError ? error.category : "invalid" };
    } finally { rpc.close(); }
  }
}
