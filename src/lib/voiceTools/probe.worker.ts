// Runs under a leased helper. No registry imports or state-owner claim.
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import { digest, validateCatalog, voiceToolBounds, type VoiceToolServer } from "./contracts";
import { verifyEntry } from "./entry";

let received = 0;
const input: Buffer[] = [];
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > 3 * 1024 * 1024) process.exit(1);
  input.push(chunk);
}
const request = JSON.parse(Buffer.concat(input).toString("utf8")) as {
  name: string; server: VoiceToolServer; secrets: Record<string, string>; home: string;
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
    const inherited = Object.fromEntries(["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "PATHEXT"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
    const child = this.child = spawn(transport.command, transport.args, { cwd: transport.cwd ?? request.home,
      env: { ...inherited, NODE_ENV: "production", XDG_CONFIG_HOME: `${request.home}/.config`, XDG_CACHE_HOME: `${request.home}/.cache`, TMPDIR: request.home,
        ...resolveValues(transport.env), HOME: request.home }, stdio: ["pipe", "pipe", "ignore"] });
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
  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child?.stdin) throw new Error("START_FAILED");
    await new Promise<void>((resolve, reject) => child.stdin!.write(JSON.stringify(message) + "\n", error => error ? reject(new Error("START_FAILED")) : resolve()));
  }
  async close(): Promise<void> { this.child?.stdin?.end(); this.child?.kill("SIGTERM"); await this.closed; }
}

// A single response body and total incoming bytes are bounded, including SSE.
const boundedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (request.server.transport.type !== "http" || url.href !== new URL(request.server.transport.url).href) throw new Error("PROTOCOL_ERROR");
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
  if (Object.values(request.secrets).some(secret => raw.includes(secret) || raw.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error("SECRET_ECHO");
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const catalog = validateCatalog(request.name, tools, schema => { ajv.removeSchema(); ajv.compile(schema); });
  answer = { code: "OK", catalog: { digest: digest(catalog), fetchedAt: new Date().toISOString(), tools: catalog } };
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  answer = { code: ["START_FAILED", "CATALOG_BOUNDS", "SECRET_ECHO", "ENTRY_CHANGED"].includes(message) ? message : "PROTOCOL_ERROR" };
} finally {
  // The parent deadline also owns close; a peer cannot extend it during shutdown.
  await client?.close().catch(() => undefined);
}
process.stdout.write(JSON.stringify(answer), () => process.exit(0));
