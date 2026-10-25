// Runs under a leased helper. No registry imports or state-owner claim.
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import { constants } from "node:fs";
import path from "node:path";
import * as fs from "node:fs/promises";
import { assertSecretDestinations, type SecretPolicies, digest, launchShapingEnv, packageLaunch, validateCatalog, voiceToolBounds, type VoiceToolServer, type ContainmentReason } from "./contracts";
import { stdioContainment } from "./containment";
import { verifyEntry } from "./entry";
import { encodedForms } from "../voiceCompanion/credentialMask";

/** Lines of the owned input pipe. A dry run sends one request and closes it; a session keeps it open for calls. */
async function* inputLines(): AsyncGenerator<string> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
      yield buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
    }
    if (buffer.length > 3 * 1024 * 1024) process.exit(1);
  }
  if (buffer.length) yield buffer.toString("utf8");
}
const lines = inputLines();
const first = await lines.next();
if (first.done) process.exit(1);
const request = JSON.parse(first.value) as {
  confirmUncontained?: ContainmentReason;
  name: string; server: VoiceToolServer; secrets: Record<string, string>; policies?: SecretPolicies; home: string;
  /** Chosen by the Viewer (hub.ts): the launcher's absolute path, an empty Bun config and an empty folder. */
  launch: { executable: string; config: string; runDir: string; runRoot: string; stateDirectory: string } | null;
  /** A voice call's session (sessions.ts): stay connected and answer calls of these approved input schemas. */
  mode?: "session"; approved?: Record<string, Record<string, unknown>>;
};
const resolveValues = (values: Record<string, { value: string } | { secretRef: string }>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, entry]) => [key, "value" in entry ? entry.value : request.secrets[entry.secretRef]]));
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function sandboxLayout(launch: { runRoot: string; stateDirectory: string }, executable: string) {
  if (path.resolve(launch.stateDirectory) === path.parse(launch.stateDirectory).root) return null;
  const base = ["/run", "/tmp"].find(candidate => !isWithin(launch.stateDirectory, candidate) && !isWithin(candidate, launch.stateDirectory));
  if (!base) return null;
  const runDir = path.join(base, "delegatus-voice-tools");
  const home = path.join(runDir, ".home");
  await fs.mkdir(path.join(launch.runRoot, ".home"), { recursive: true, mode: 0o700 });
  return { executable, base, runDir, home, mapPath: (file: string) => isWithin(launch.runRoot, file) ? path.join(runDir, path.relative(launch.runRoot, file)) : file };
}
let containmentReason: ContainmentReason | undefined;
let wireBytes = 0, wireLimit: number = voiceToolBounds.wireBytes;
function count(bytes: number) { wireBytes += bytes; if (wireBytes > wireLimit) throw new Error("CATALOG_BOUNDS"); }

/** SDK stdio's unbounded line buffer is inappropriate for an untrusted catalog. */
class BoundedStdio implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private child?: ChildProcess;
  private closed?: Promise<void>;
  async start(): Promise<void> {
    const transport = request.server.transport;
    if (transport.type !== "stdio") throw new Error("PROTOCOL_ERROR");
    // Recheck after connection setup and immediately before the pinned file is executed.
    await verifyEntry(request.server);
    const launch = request.launch;
    if (!launch || ![launch.executable, launch.config, launch.runDir, launch.runRoot, launch.stateDirectory].every(file => path.isAbsolute(file))) throw new Error("START_FAILED");
    const availability = await stdioContainment();
    const sandbox = availability.executable ? await sandboxLayout(launch, availability.executable).catch(() => null) : null;
    if (!sandbox) {
      containmentReason = availability.reason ?? "LAYOUT_UNAVAILABLE";
      if (request.confirmUncontained !== containmentReason) throw new Error("CONTAINMENT_REQUIRED");
    }
    const inherit = (names: string[]) => Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
    // The proposal schema refuses launch variables (contracts.ts); a request that still carries one
    // drops it here, and the platform's own variables and the private home win over the rest.
    const own = Object.fromEntries(Object.entries(resolveValues(transport.env)).filter(([name]) => !launchShapingEnv.test(name)));
    const env = { NODE_ENV: "production", ...inherit(["LANG", "LC_ALL"]), ...own, ...inherit(["PATH", "SYSTEMROOT", "WINDIR", "PATHEXT"]),
      XDG_CONFIG_HOME: `${request.home}/.config`, XDG_CACHE_HOME: `${request.home}/.cache`, TMPDIR: request.home, HOME: request.home } as NodeJS.ProcessEnv;
    const launcherEnv = { ...env };
    for (const [name, value] of Object.entries(transport.env)) if ("secretRef" in value) delete launcherEnv[name];
    let entry = request.server.entryFile?.path;
    const pkg = !entry && packageLaunch(transport);
    if (!entry && !pkg) throw new Error("START_FAILED");
    if (pkg) {
      // A previous server can write its private home, including global tools
      // and package-manager configuration. Package resolution gets a fresh home.
      const home = path.join(launch.runDir, ".home");
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), TMPDIR: home });
    }
    // Nothing found from a folder may choose what runs before the pinned entry: Bun reads the
    // Viewer's empty config and no .env file; uv neither builds a project nor reads its config, and it
    // runs the interpreter found while virtual environments are skipped, because finding one runs it.
    let args: string[];
    if (transport.command === "bun") {
      const file = entry ?? await this.installBunPackage(launch, transport.args[1], launcherEnv).catch(() => { throw new Error("START_FAILED"); });
      args = [`--config=${launch.config}`, "run", "--no-env-file", file, ...(entry ? transport.args.slice(2) : [])];
    }
    else if (pkg) args = ["tool", "run", "--no-config", ...transport.args.slice(2)];
    else args = ["run", "--python", await systemPython(launch, launcherEnv), "--no-project", "--no-config", "--no-env-file", entry!, ...transport.args.slice(2)];
    // Stage a pinned file that lives in Delegatus state into this probe's private run directory.
    // The sandbox can then hide the entire state tree without exposing sibling state files.
    if (entry) {
      const realEntry = await fs.realpath(entry);
      if (sandbox && isWithin(launch.stateDirectory, realEntry)) {
        const staged = path.join(launch.runDir, `entry${path.extname(realEntry) || ".mjs"}`);
        await fs.copyFile(realEntry, staged, constants.COPYFILE_EXCL);
        await verifyEntry({ ...request.server, entryFile: { path: staged, sha256: request.server.entryFile!.sha256 } });
        entry = staged;
        const fileIndex = args.findIndex(value => value === request.server.entryFile!.path);
        if (fileIndex >= 0) args[fileIndex] = entry;
        else {
          const configArgument = args.findIndex(value => value === `--config=${launch.config}`);
          if (configArgument >= 0) args[configArgument] = `--config=${sandbox.mapPath(launch.config)}`;
          const entryArgument = args.findIndex(value => value === request.server.entryFile!.path);
          if (entryArgument >= 0) args[entryArgument] = entry;
        }
      } else {
        entry = realEntry;
        args = args.map(value => value === request.server.entryFile!.path ? realEntry : value);
      }
    }
    let child: ChildProcess;
    if (sandbox) {
      args = args.map(value => {
        if (value === `--config=${launch.config}`) return `--config=${sandbox.mapPath(launch.config)}`;
        return isWithin(launch.runRoot, value) ? sandbox.mapPath(value) : value;
      });
      const cwd = transport.cwd ?? request.home;
      const realCwd = await fs.realpath(cwd).catch(() => cwd);
      const childCwd = isWithin(launch.stateDirectory, realCwd) ? path.join(sandbox.runDir, "cwd") : realCwd;
      let targetExecutable = await fs.realpath(launch.executable);
      if (isWithin(launch.stateDirectory, targetExecutable)) {
        const stagedExecutable = path.join(launch.runRoot, ".launcher");
        await fs.copyFile(targetExecutable, stagedExecutable, constants.COPYFILE_EXCL);
        targetExecutable = sandbox.mapPath(stagedExecutable);
      }
      const sandboxArgs = ["--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        "--ro-bind", "/", "/", "--tmpfs", sandbox.base, "--dir", sandbox.runDir, "--bind", launch.runRoot, sandbox.runDir];
      const hidesTmp = !isWithin(sandbox.base, "/tmp");
      if (hidesTmp) sandboxArgs.push("--tmpfs", "/tmp");
      const hidesState = isWithin(sandbox.base, launch.stateDirectory) || (hidesTmp && isWithin("/tmp", launch.stateDirectory));
      if (!hidesState) sandboxArgs.push("--tmpfs", launch.stateDirectory);
      sandboxArgs.push("--proc", "/proc", "--dev", "/dev", "--chdir", childCwd, "--", targetExecutable, ...args);
      // The sandboxed process gets only a private run directory and home. Root is
      // read-only, and the complete Delegatus state path is overlaid before exec.
      Object.assign(env, { HOME: sandbox.home, XDG_CONFIG_HOME: path.join(sandbox.home, ".config"), XDG_CACHE_HOME: path.join(sandbox.home, ".cache"), TMPDIR: sandbox.home });
      child = spawn(sandbox.executable, sandboxArgs, { cwd: "/", env, stdio: ["pipe", "pipe", "ignore"] });
    } else {
      // The owner confirmed this exact unavailable-platform reason for this run.
      // Environment scrubbing still applies; filesystem and network access are unrestricted.
      child = spawn(launch.executable, args, { cwd: transport.cwd ?? request.home, env, stdio: ["pipe", "pipe", "ignore"] });
    }
    this.child = child;
    this.closed = new Promise(resolve => { child.once("close", () => { this.onclose?.(); resolve(); }); });
    let buffer = Buffer.alloc(0);
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        count(chunk.length); buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf(10); if (end < 0) break;
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (line.length) this.onmessage?.(JSON.parse(line.toString("utf8")));
        }
      } catch (error) { this.onerror?.(error as Error); child.kill("SIGTERM"); }
    });
    child.stdin!.on("error", () => { this.onerror?.(new Error("START_FAILED")); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new Error("START_FAILED"))); });
  }
  private async installBunPackage(launch: { executable: string; config: string; runDir: string }, target: string, env: NodeJS.ProcessEnv): Promise<string> {
    const versionAt = target.indexOf("@", 1);
    const name = versionAt < 0 ? target : target.slice(0, versionAt);
    const version = versionAt < 0 ? "latest" : target.slice(versionAt + 1);
    await fs.writeFile(path.join(launch.runDir, "package.json"), JSON.stringify({ private: true, workspaces: [], dependencies: { [name]: version } }), { flag: "wx", mode: 0o600 });
    // Installing into an explicit manifest avoids bun x's PATH/global fallback.
    // No lifecycle hook may run before the resolved registry entry is chosen.
    const installer = this.child = spawn(launch.executable, [`--config=${launch.config}`, "install", "--ignore-scripts", "--no-progress", "--no-cache", "--registry=https://registry.npmjs.org"],
      { cwd: launch.runDir, env, stdio: ["ignore", "ignore", "ignore"] });
    this.closed = new Promise(resolve => { installer.once("close", () => resolve()); });
    const code = await new Promise<number | null>(resolve => { installer.once("error", () => resolve(null)); installer.once("close", resolve); });
    if (code !== 0) throw new Error("START_FAILED");
    const directory = path.join(launch.runDir, "node_modules", ...name.split("/"));
    const manifest = path.join(directory, "package.json");
    if ((await fs.stat(manifest)).size > 64 * 1024) throw new Error("START_FAILED");
    const metadata = JSON.parse(await fs.readFile(manifest, "utf8"));
    const bins = metadata.bin;
    const shortName = name.split("/").at(-1)!;
    const bin = typeof bins === "string" ? bins : bins && typeof bins === "object" && !Array.isArray(bins)
      ? Object.hasOwn(bins, shortName) ? bins[shortName] : Object.keys(bins).length === 1 ? Object.values(bins)[0] : null : null;
    if (typeof bin !== "string" || !bin || path.isAbsolute(bin)) throw new Error("START_FAILED");
    const root = await fs.realpath(directory), file = await fs.realpath(path.resolve(directory, bin));
    // A workspace link or symlinked package root cannot substitute local code.
    if (root !== path.join(await fs.realpath(launch.runDir), "node_modules", ...name.split("/"))) throw new Error("START_FAILED");
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.stat(file)).isFile()) throw new Error("START_FAILED");
    return file;
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child?.stdin) throw new Error("START_FAILED");
    await new Promise<void>((resolve, reject) => child.stdin!.write(JSON.stringify(message) + "\n", error => error ? reject(new Error("START_FAILED")) : resolve()));
  }
  async close(): Promise<void> { this.child?.stdin?.end(); this.child?.kill("SIGTERM"); await this.closed; }
}

/** `uv python find --system` skips virtual environments; the answer is one absolute path. */
async function systemPython(launch: { executable: string; runDir: string }, env: NodeJS.ProcessEnv): Promise<string> {
  const finder = spawn(launch.executable, ["python", "find", "--system", "--no-project", "--no-config"], { cwd: launch.runDir, env, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  finder.stdout!.setEncoding("utf8");
  finder.stdout!.on("data", (chunk: string) => { output += chunk; if (output.length > 4096) finder.kill("SIGKILL"); });
  const code = await new Promise<number | null>(resolve => { finder.once("error", () => resolve(null)); finder.once("close", resolve); });
  const found = output.trim();
  if (code !== 0 || !path.isAbsolute(found) || /[\r\n]/.test(found)) throw new Error("START_FAILED");
  return found;
}

// A single response body and total incoming bytes are bounded, including SSE.
const boundedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (request.server.transport.type !== "http" || url.href !== new URL(request.server.transport.url).href) throw new Error("PROTOCOL_ERROR");
  assertSecretDestinations(request.name, request.server, request.policies ?? {});
  const response = await fetch(input, { ...init, redirect: "error" });
  if (!response.body) return response;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        count(next.value.length); controller.enqueue(next.value);
      } catch { await reader.cancel().catch(() => undefined); controller.error(new Error("CATALOG_BOUNDS")); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
};

const write = (value: unknown) => new Promise<void>(resolve => process.stdout.write(JSON.stringify(value) + "\n", () => resolve()));
// A secret is masked as written and in every form an answer can encode it: JSON escaping inside structuredContent, a
// percent-encoded URL, base64 and base64url.
const masked = (text: string) => Object.values(request.secrets).filter(secret => secret.length >= 8).flatMap(secret => [secret, ...encodedForms(secret)])
  .reduce((value, form) => value.replaceAll(form, "[masked]"), text);
function cutText(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const marker = `\n[cut: the answer is longer than ${Math.round(limit / 1024)} KB]`;
  let kept = "";
  for (const char of text) { if (Buffer.byteLength(kept + char) > limit - Buffer.byteLength(marker)) break; kept += char; }
  return kept + marker;
}
/** A tool result as the backend receives it (design §3.5 step 5); mapped here, so the Viewer only reads a bounded line. */
function mapResult(result: Record<string, unknown>) {
  const texts: string[] = [], images: { mime: string; data: string }[] = [], omitted = new Set<string>();
  let imageBytes = 0;
  for (const item of Array.isArray(result.content) ? result.content as Record<string, unknown>[] : []) {
    if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
    else if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string" && /^image\/(?:png|jpeg|webp|gif)$/.test(item.mimeType)) {
      const bytes = Math.floor(item.data.length * 3 / 4);
      if (images.length < voiceToolBounds.callImages && bytes <= voiceToolBounds.callImageBytes && imageBytes + bytes <= voiceToolBounds.callImagesBytes && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
        images.push({ mime: item.mimeType, data: item.data }); imageBytes += bytes;
      } else omitted.add("image");
    } else omitted.add(typeof item?.type === "string" && /^[a-z_]{1,32}$/.test(item.type) ? item.type : "unknown");
  }
  let text = texts.join("\n");
  if (!text && result.structuredContent && typeof result.structuredContent === "object") text = JSON.stringify(result.structuredContent);
  return { status: result.isError === true ? "failed" : "done", ...(result.isError === true ? { code: "TOOL_ERROR" } : {}),
    content: cutText(masked(text), voiceToolBounds.callTextBytes), omitted: [...omitted].sort(), images };
}
/** Session mode: one approved server for the voice calls of this Viewer, one call at a time (the hub serializes them). */
async function serve(connected: Client, live: unknown[]): Promise<void> {
  let tools: unknown = null;
  try { tools = validateCatalog(request.name, live); } catch { /* A catalog outside the bounds is drift: every approved tool reads as changed. */ }
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const validators = new Map(Object.entries(request.approved ?? {}).map(([tool, schema]) => [tool, ajv.compile(schema)]));
  let closed = false;
  const lost = new Promise<void>(resolve => { connected.onclose = () => { closed = true; resolve(); }; });
  await write({ type: "ready", tools });
  const running = new Map<string, AbortController>();
  const work: Promise<void>[] = [];
  const answer = async (command: Record<string, unknown>) => {
    const id = String(command.id).slice(0, 64), tool = String(command.tool);
    const validate = validators.get(tool);
    if (!validate) return write({ type: "result", id, status: "failed", code: "TOOL_NOT_ALLOWED" });
    if (!command.arguments || typeof command.arguments !== "object" || Array.isArray(command.arguments) || !validate(command.arguments)) return write({ type: "result", id, status: "failed", code: "INVALID_TOOL_ARGUMENTS" });
    const controller = new AbortController();
    running.set(id, controller);
    // Each call has its own incoming-byte bound; a server that floods it is stopped.
    wireBytes = 0; wireLimit = voiceToolBounds.callWireBytes;
    const timeout = Math.min(Math.max(Number(command.timeoutMs) || 15_000, 1), 60_000);
    try {
      const result = await connected.request({ method: "tools/call", params: { name: tool, arguments: command.arguments as Record<string, unknown> } }, CallToolResultSchema,
        { signal: controller.signal, timeout, maxTotalTimeout: timeout });
      await write({ type: "result", id, ...mapResult(result as Record<string, unknown>) });
    } catch (error) {
      // A JSON-RPC error or an answer outside the result schema is the tool's failure; a lost transport is the server's.
      const timedOut = controller.signal.aborted || error instanceof McpError && error.code === ErrorCode.RequestTimeout;
      const answered = error instanceof McpError || (error as Error)?.name === "ZodError";
      await write({ type: "result", id, status: "failed", code: closed ? "TOOL_SERVER_UNAVAILABLE" : timedOut ? "TOOL_TIMEOUT" : answered ? "TOOL_ERROR" : "TOOL_SERVER_UNAVAILABLE" });
    } finally { running.delete(id); }
  };
  const reading = (async () => {
    for await (const line of lines) {
      let command: Record<string, unknown>;
      try { command = JSON.parse(line); } catch { continue; }
      if (command?.type === "cancel") running.get(String(command.id))?.abort();
      else if (command?.type === "call") work.push(answer(command));
    }
  })();
  // The Viewer closing the pipe ends the session; so does the server going away.
  await Promise.race([reading, lost]);
  for (const controller of running.values()) controller.abort();
  await Promise.allSettled(work);
}

let client: Client | undefined;
let answer: unknown;
try {
  assertSecretDestinations(request.name, request.server, request.policies ?? {});
  await verifyEntry(request.server);
  const transport = request.server.transport;
  client = new Client({ name: request.mode === "session" ? "delegatus-voice-tools" : "delegatus-voice-tools-probe", version: "1" });
  const connection = transport.type === "stdio" ? new BoundedStdio()
    : new StreamableHTTPClientTransport(new URL(transport.url), { fetch: boundedFetch,
      requestInit: { headers: resolveValues(transport.headers) }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  await client.connect(connection);
  const tools: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    if (tools.length > voiceToolBounds.tools) throw new Error("CATALOG_BOUNDS");
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= voiceToolBounds.tools)) throw new Error("CATALOG_BOUNDS");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  // No echo from the peer, including fields discarded during normalization, may escape.
  const raw = JSON.stringify(tools);
  if (Object.values(request.secrets).some(secret => secret.length >= 8 && (raw.includes(secret) || raw.includes(JSON.stringify(secret).slice(1, -1))))) throw new Error("SECRET_ECHO");
  if (request.mode === "session") await serve(client, tools);
  else {
    const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
    const catalog = validateCatalog(request.name, tools, schema => { ajv.removeSchema(); ajv.compile(schema); });
    answer = { code: "OK", catalog: { digest: digest(catalog), fetchedAt: new Date().toISOString(), tools: catalog } };
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  answer = { code: ["CONTAINMENT_REQUIRED", "START_FAILED", "CATALOG_BOUNDS", "SECRET_ECHO", "SECRET_DESTINATION", "ENTRY_CHANGED"].includes(message) ? message : "PROTOCOL_ERROR", ...(containmentReason ? { containmentReason } : {}) };
} finally {
  // The parent deadline also owns close; a peer cannot extend it during shutdown.
  await client?.close().catch(() => undefined);
}
if (request.mode === "session") {
  if (answer) await write({ type: "failed", ...(answer as object) });
  process.exit(0);
}
process.stdout.write(JSON.stringify(answer), () => process.exit(0));
