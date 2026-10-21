import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { VoiceToolHub } from "./hub";
import { VoiceToolsStore } from "./store";

const [scenario, root] = process.argv.slice(2);
const actor = { kind: "conversation" as const, conversationId: "conversation_deadline", at: "2026-01-01T00:00:00.000Z" };
const tools = [{ name: "search", description: "Search", inputSchema: { type: "object" } }];
const store = new VoiceToolsStore(root);
let listener: ReturnType<typeof Bun.serve> | undefined;
const pendingResponses: (() => void)[] = [];
let recordedResolve!: () => void;
const recorded = new Promise<void>(resolve => { recordedResolve = resolve; });
const record = store.recordProbe.bind(store);
store.recordProbe = async (...args) => { try { await record(...args); } finally { recordedResolve(); } };

async function main() {
  let url = "";
  if (scenario === "http") {
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = await request.json() as { id?: number; method: string };
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "deadline", version: "1" } } });
      if (message.method === "tools/list") process.stdout.write("PEER_READY\n");
      return await new Promise<Response>(resolve => pendingResponses.push(() => resolve(Response.json({ jsonrpc: "2.0", id: message.id, result: { tools } }))));
    } });
    url = `http://127.0.0.1:${listener.port}/mcp`;
  } else if (scenario === "stdio") {
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { process.stdout.write("PEER_READY\n"); return new Response("ready"); } });
    const entry = path.join(root, "server");
    const source = `import readline from 'node:readline';
process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){void fetch(process.env.READY_URL)} });`;
    await fs.writeFile(entry, source);
    await store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "stdio", command: "bun", args: [entry], cwd: root, env: { READY_URL: { value: `http://127.0.0.1:${listener.port}/ready` } } },
      entryFile: { path: entry, sha256: createHash("sha256").update(source).digest("hex") } }, actor);
  }
  if (scenario === "http") await store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "http", url } }, actor);
  if (scenario === "prepare") {
    await store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "http", url: "http://127.0.0.1:1/mcp" } }, actor);
    store.probeInput = async () => await new Promise(() => {});
  }
  const expected = (await store.view()).servers.music.digest;
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats++; process.stdout.write("HEARTBEAT\n"); }, 20);
  process.stdout.write("STARTED\n");
  let result = "OK";
  try { await new VoiceToolHub(store, 3_200).dryRun("music", expected); }
  catch (error) { result = error instanceof Error && "code" in error ? String(error.code) : "ERROR"; }
  for (const release of pendingResponses.splice(0)) release();
  if (scenario !== "prepare") {
    await recorded;
    result = (await store.view()).servers.music.lastDryRun?.code ?? result;
  }
  await listener?.stop(true);
  clearInterval(heartbeat);
  process.stdout.write(`RESULT:${result}:HEARTBEATS:${heartbeats}\n`);
  process.exit(0);
}

await main();
