// Runs under a leased helper. No registry imports or state-owner claim.
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import path from "node:path";
import * as fs from "node:fs/promises";
import { assertSecretDestinations, type SecretPolicies, digest, launchShapingEnv, packageLaunch, validateCatalog, voiceToolBounds, type VoiceToolServer } from "./contracts";
import { verifyEntry } from "./entry";

let received = 0;
const input: Buffer[] = [];
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > 3 * 1024 * 1024) process.exit(1);
  input.push(chunk);
}
const request = JSON.parse(Buffer.concat(input).toString("utf8")) as {
  name: string; server: VoiceToolServer; secrets: Record<string, string>; policies?: SecretPolicies; home: string;
  /** Chosen by the Viewer (hub.ts): the launcher's absolute path, an empty Bun config and an empty folder. */
  launch: { executable: string; config: string; runDir: string } | null;
};
const resolveValues = (values: Record<string, { value: string } | { secretRef: string }>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, entry]) => [key, "value" in entry ? entry.value : request.secrets[entry.secretRef]]));
let wireBytes = 0;
function count(bytes: number) { wireBytes += bytes; if (wireBytes > voiceToolBounds.wireBytes) throw new Error("CATALOG_BOUNDS"); }

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
    if (!launch || ![launch.executable, launch.config, launch.runDir].every(file => path.isAbsolute(file))) throw new Error("START_FAILED");
    const inherit = (names: string[]) => Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
    // The proposal schema refuses launch variables (contracts.ts); a request that still carries one
    // drops it here, and the platform's own variables and the private home win over the rest.
    const own = Object.fromEntries(Object.entries(resolveValues(transport.env)).filter(([name]) => !launchShapingEnv.test(name)));
    const env = { NODE_ENV: "production", ...inherit(["LANG", "LC_ALL"]), ...own, ...inherit(["PATH", "SYSTEMROOT", "WINDIR", "PATHEXT"]),
      XDG_CONFIG_HOME: `${request.home}/.config`, XDG_CACHE_HOME: `${request.home}/.cache`, TMPDIR: request.home, HOME: request.home } as NodeJS.ProcessEnv;
    const entry = request.server.entryFile?.path;
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
      const file = entry ?? await this.installBunPackage(launch, transport.args[1], env).catch(() => { throw new Error("START_FAILED"); });
      args = [`--config=${launch.config}`, "run", "--no-env-file", file, ...(entry ? transport.args.slice(2) : [])];
    }
    else if (pkg) args = ["tool", "run", "--no-config", ...transport.args.slice(2)];
    else args = ["run", "--python", await systemPython(launch, env), "--no-project", "--no-config", "--no-env-file", entry!, ...transport.args.slice(2)];
    // Package execution never asks PATH or a global bin directory to satisfy the target.
    const child = this.child = spawn(launch.executable, args, { cwd: pkg ? launch.runDir : transport.cwd ?? request.home, env, stdio: ["pipe", "pipe", "ignore"] });
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

let client: Client | undefined;
let answer: unknown;
try {
  assertSecretDestinations(request.name, request.server, request.policies ?? {});
  await verifyEntry(request.server);
  const transport = request.server.transport;
  client = new Client({ name: "delegatus-voice-tools-probe", version: "1" });
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
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const catalog = validateCatalog(request.name, tools, schema => { ajv.removeSchema(); ajv.compile(schema); });
  answer = { code: "OK", catalog: { digest: digest(catalog), fetchedAt: new Date().toISOString(), tools: catalog } };
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  answer = { code: ["START_FAILED", "CATALOG_BOUNDS", "SECRET_ECHO", "SECRET_DESTINATION", "ENTRY_CHANGED"].includes(message) ? message : "PROTOCOL_ERROR" };
} finally {
  // The parent deadline also owns close; a peer cannot extend it during shutdown.
  await client?.close().catch(() => undefined);
}
process.stdout.write(JSON.stringify(answer), () => process.exit(0));
