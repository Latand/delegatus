import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { VoiceToolHub, voiceToolEnvironment } from "./hub";
import { VoiceToolsStore } from "./store";

const roots: string[] = [];
const listeners: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.stop(true);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const at = "2026-01-01T00:00:00.000Z";
const actor = { kind: "conversation" as const, conversationId: "conversation_worker", at };
const tools = [{ name: "search", description: "Search", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-hub-")); roots.push(root);
  return { root, store: new VoiceToolsStore(root, () => at) };
}
function fake(list: (params: Record<string, unknown>) => unknown | Promise<unknown> = () => ({ tools }), initialize?: () => void) {
  const requests: { method: string; receivedHeader: string | null }[] = [];
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    const message = await req.json() as { method: string; id?: number; params: Record<string, unknown> };
    requests.push({ method: message.method, receivedHeader: req.headers.get("authorization") });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      initialize?.();
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result: await list(message.params) });
  } });
  listeners.push(listener);
  return { url: `http://127.0.0.1:${listener.port}/mcp`, requests };
}
async function propose(store: VoiceToolsStore, url: string, headers = {}) {
  await store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "http", url, headers } }, actor);
  return (await store.view()).servers.music.digest;
}

test("HTTP dry run initializes, paginates tools, stops and keeps credentials out of records", async () => {
  const { store, root } = await setup();
  const server = fake(params => params.cursor ? { tools: [{ ...tools[0], name: "play", annotations: {} }] } : { tools, nextCursor: "page2" });
  const expected = await propose(store, server.url, { Authorization: { secretRef: "music-token" } });
  await store.saveSecrets({ "music-token": "synthetic-voice-credential" });
  await new VoiceToolHub(store).dryRun("music", expected);
  const view = await store.view();
  expect(view.servers.music.lastDryRun?.code).toBe("OK");
  expect(view.servers.music.catalog?.tools.map(tool => tool.name)).toEqual(["search", "play"]);
  expect(view.servers.music.tools).toEqual({ search: { enabled: false, acts: false }, play: { enabled: false, acts: true } });
  expect(server.requests.filter(r => r.method === "tools/list")).toHaveLength(2);
  expect(server.requests.every(r => r.receivedHeader === "synthetic-voice-credential")).toBe(true);
  expect(JSON.stringify(view)).not.toContain("synthetic-voice-credential");
  expect(await fs.readFile(store.file, "utf8")).not.toContain("synthetic-voice-credential");
  const helpers = await fs.readdir(path.join(root, "helpers")).catch(() => []);
  expect(helpers.filter(name => name.endsWith(".json"))).toEqual([]);
});

test("a hung peer ends on the one owned deadline while unrelated loop work continues", async () => {
  const { store } = await setup();
  const entered = barrier(), release = barrier();
  const server = fake(async () => { entered.release(); await release.promise; return { tools }; });
  const expected = await propose(store, server.url);
  let expire!: () => void, disposed = false;
  const scheduled: number[] = [];
  const hub = new VoiceToolHub(store, 20_000, (callback, milliseconds) => { scheduled.push(milliseconds); if (milliseconds === 17_000) expire = callback; return () => { disposed = true; }; });
  const pending = hub.dryRun("music", expected);
  try {
    await entered.promise;
    expect(scheduled).toEqual([17_000, 20_000]);
    expect((await store.view()).servers.music.state).toBe("pending");
    await new Promise<void>(resolve => setImmediate(resolve));
    expire(); await pending;
    expect((await store.view()).servers.music.lastDryRun?.code).toBe("TIMEOUT");
    expect(disposed).toBe(true);
  } finally { release.release(); await pending; }
}, 15_000);

test("the outer deadline bounds blocked preparation and no late server starts", async () => {
  const { store } = await setup(); const peer = fake(); const expected = await propose(store, peer.url);
  const entered = barrier(), release = barrier(), recorded = barrier();
  const input = store.probeInput.bind(store), record = store.recordProbe.bind(store);
  store.probeInput = async (...args) => { entered.release(); await release.promise; return input(...args); };
  store.recordProbe = async (...args) => { try { await record(...args); } finally { recorded.release(); } };
  const timers = new Map<number, () => void>();
  const hub = new VoiceToolHub(store, 20_000, (callback, milliseconds) => { timers.set(milliseconds, callback); return () => {}; });
  const pending = hub.dryRun("music", expected);
  try {
    await entered.promise;
    timers.get(17_000)!(); timers.get(20_000)!();
    await expect(pending).rejects.toThrow("TIMEOUT");
  } finally { release.release(); }
  await recorded.promise;
  expect(peer.requests).toEqual([]);
  expect((await store.view()).servers.music.lastDryRun?.code).toBe("TIMEOUT");
});

test("a peer echo, count overflow, schema rejection and repeated cursors return fixed codes", async () => {
  for (const [reply, code] of [
    [{ tools: [{ ...tools[0], description: "synthetic-voice-credential" }] }, "SECRET_ECHO"],
    [{ tools: Array.from({ length: 129 }, (_, i) => ({ ...tools[0], name: `tool${i}` })) }, "CATALOG_BOUNDS"],
    [{ tools: [{ ...tools[0], inputSchema: { type: "object", properties: { invalid: { type: "invalid-type" } } } }] }, "CATALOG_BOUNDS"],
    [{ tools: [], nextCursor: "again" }, "CATALOG_BOUNDS"],
  ] as const) {
    const { store } = await setup(); const server = fake(() => reply);
    const expected = await propose(store, server.url); await store.saveSecrets({ "music-token": "synthetic-voice-credential" });
    await new VoiceToolHub(store).dryRun("music", expected);
    expect((await store.view()).servers.music.lastDryRun?.code).toBe(code);
    expect((await store.view()).servers.music.catalog).toBeNull();
  }
}, 20_000);

test("probe cancellation and proposal replacement cannot publish a stale catalog", async () => {
  const { store } = await setup(); const entered = barrier(), release = barrier();
  const server = fake(async () => { entered.release(); await release.promise; return { tools }; });
  const expected = await propose(store, server.url);
  const controller = new AbortController();
  const pending = new VoiceToolHub(store).dryRun("music", expected, controller.signal);
  await entered.promise;
  await store.propose({ name: "music", title: "Replacement", capability: "Search", transport: { type: "http", url: server.url } }, actor);
  controller.abort();
  try { await expect(pending).rejects.toThrow("STALE_APPROVAL"); }
  finally { release.release(); }
  expect((await store.view()).servers.music.catalog).toBeNull();
  const preaborted = new AbortController(); preaborted.abort();
  await expect(new VoiceToolHub(store).dryRun("music", (await store.view()).servers.music.digest, preaborted.signal)).rejects.toThrow("CANCELLED");
});

test("stdio starts under the lease with a private environment, checks entry drift and is reaped", async () => {
  const { store, root } = await setup();
  const entry = path.join(root, "fake");
  const source = `import readline from 'node:readline';
const input = readline.createInterface({input:process.stdin});
input.on('line', line => { const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}:
 {tools:[{name:'search',description: Object.keys(process.env).some(k=>k.startsWith('LLV_')||k.startsWith('OPENAI_'))?'leaked-env':process.env.NODE_ENV==='development'?'Search':'wrong-env',inputSchema:{type:'object'}}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); });`;
  await fs.writeFile(entry, source);
  await expect(store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "stdio", command: "bun", args: ["--preload", entry, entry], env: {} },
    entryFile: { path: entry, sha256: createHash("sha256").update(source).digest("hex") } }, actor)).rejects.toThrow("INVALID_PROPOSAL");
  await store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "stdio", command: "bun", args: [entry], env: { NODE_ENV: { value: "development" } } },
    entryFile: { path: entry, sha256: createHash("sha256").update(source).digest("hex") } }, actor);
  await new VoiceToolHub(store).dryRun("music", (await store.view()).servers.music.digest);
  expect((await store.view()).servers.music.lastDryRun?.code).toBe("OK");
  expect((await store.view()).servers.music.catalog?.tools[0].description).toBe("Search");
  await store.operatorChange("music", (await store.view()).servers.music.digest, "approve");
  await fs.appendFile(entry, "\n// drift\n");
  await new VoiceToolHub(store).dryRun("music", (await store.view()).servers.music.digest);
  expect((await store.view()).servers.music.lastDryRun?.code).toBe("ENTRY_CHANGED");
  expect((await store.view()).servers.music.state).toBe("pending");
  await expect(store.operatorChange("music", (await store.view()).servers.music.digest, "approve")).rejects.toThrow("DRY_RUN_REQUIRED");
});

test("environment scrub preserves only platform launch variables", () => {
  const env = voiceToolEnvironment("/private/server", { NODE_ENV: "test", PATH: "/bin", OPENAI_API_KEY: "hidden", LLV_TOKEN: "hidden", OTHER_API_KEY: "hidden", NODE_OPTIONS: "hidden", LANG: "en" });
  expect(env).toEqual({ NODE_ENV: "production", HOME: "/private/server", XDG_CONFIG_HOME: "/private/server/.config", XDG_CACHE_HOME: "/private/server/.cache", TMPDIR: "/private/server", PATH: "/bin", LANG: "en" });
});

test("HTTP redirects never forward credentials to another endpoint; wire overflow is bounded", async () => {
  const { store } = await setup();
  let followed = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { followed++; return Response.json({}); } }); listeners.push(target);
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/mcp` } }); } }); listeners.push(redirect);
  const expected = await propose(store, `http://127.0.0.1:${redirect.port}/mcp`, { Authorization: { secretRef: "music-token" } });
  await store.saveSecrets({ "music-token": "synthetic-voice-credential" });
  await new VoiceToolHub(store).dryRun("music", expected);
  expect(followed).toBe(0); expect((await store.view()).servers.music.lastDryRun?.code).toBe("PROTOCOL_ERROR");
  const huge = fake(() => ({ tools: [{ ...tools[0], description: "x".repeat(3 * 1024 * 1024) }] }));
  const next = await propose(store, huge.url);
  await new VoiceToolHub(store).dryRun("music", next);
  expect((await store.view()).servers.music.lastDryRun?.code).not.toBe("OK");
  expect((await store.view()).servers.music.catalog).toBeNull();
});

test("at most eight probes run, cancellation reaps them before admitting another", async () => {
  const { store } = await setup(); const entered = barrier(), release = barrier(); let count = 0;
  const server = fake(async () => { if (++count === 8) entered.release(); await release.promise; return { tools }; });
  const names = Array.from({ length: 9 }, (_, i) => `server${i}`);
  for (const name of names) await store.propose({ name, title: "Music", capability: "Search", transport: { type: "http", url: server.url } }, actor);
  const view = await store.view(); const controller = new AbortController(); const hub = new VoiceToolHub(store);
  const pending = names.slice(0, 8).map(name => hub.dryRun(name, view.servers[name].digest, controller.signal));
  try {
    await entered.promise;
    await expect(hub.dryRun(names[8], view.servers[names[8]].digest)).rejects.toThrow("BUSY");
    controller.abort(); await Promise.all(pending);
    expect(count).toBe(8);
    release.release();
    // A fresh owner has no retained phantom slot after all old helpers stop.
    await new VoiceToolHub(store).dryRun(names[8], view.servers[names[8]].digest);
    expect((await store.view()).servers[names[8]].lastDryRun?.code).toBe("OK");
  } finally { controller.abort(); release.release(); await Promise.allSettled(pending); }
}, 20_000);

test("revoked operator authority during preparation dispatches no server", async () => {
  const { store } = await setup(); const server = fake(); const expected = await propose(store, server.url);
  await expect(new VoiceToolHub(store).dryRun("music", expected, undefined, () => { throw new Error("REVOKED"); })).rejects.toThrow("REVOKED");
  expect(server.requests).toEqual([]);
});

test("missing credentials are recorded without starting the peer", async () => {
  const { store } = await setup(); const server = fake();
  const expected = await propose(store, server.url, { Authorization: { secretRef: "music-token" } });
  await new VoiceToolHub(store).dryRun("music", expected);
  expect((await store.view()).servers.music.lastDryRun?.code).toBe("MISSING_SECRET");
  expect(server.requests).toEqual([]);
});

test("a hanging stdio server that ignores TERM is reaped by its deadline without relaying stderr", async () => {
  const { store, root } = await setup(); const ready = barrier();
  const notify = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { ready.release(); return new Response("ready"); } }); listeners.push(notify);
  const entry = path.join(root, "hang.mjs");
  const source = `import readline from 'node:readline';
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){console.error(process.env.SERVER_TOKEN);void fetch(process.env.READY_URL);}});`;
  await fs.writeFile(entry, source);
  await store.propose({ name: "music", title: "Music", capability: "Search", transport: { type: "stdio", command: "bun", args: [entry],
    env: { READY_URL: { value: `http://127.0.0.1:${notify.port}/ready` }, SERVER_TOKEN: { secretRef: "server-token" } } },
    entryFile: { path: entry, sha256: createHash("sha256").update(source).digest("hex") } }, actor);
  await store.saveSecrets({ "server-token": "synthetic-voice-credential" });
  let expire!: () => void;
  const hub = new VoiceToolHub(store, 20_000, (callback, milliseconds) => { if (milliseconds === 17_000) expire = callback; return () => {}; });
  const pending = hub.dryRun("music", (await store.view()).servers.music.digest);
  try {
    await ready.promise;
    const records = await fs.readdir(path.join(root, "helpers"));
    expect(records.length).toBeGreaterThan(0);
    for (const name of records) expect(await fs.readFile(path.join(root, "helpers", name), "utf8")).not.toContain("synthetic-voice-credential");
  } finally { expire(); await pending; }
  expect((await store.view()).servers.music.lastDryRun?.code).toBe("TIMEOUT");
  expect(JSON.stringify(await store.view())).not.toContain("synthetic-voice-credential");
  expect(await fs.readdir(path.join(root, "helpers"))).toEqual([]);
}, 15_000);

test("the real deadline settles HTTP, TERM-resistant stdio and blocked preparation under an independent watchdog", async () => {
  const fixture = path.join(import.meta.dir, "hub.deadline.fixture.ts");
  for (const scenario of ["http", "stdio", "prepare"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-watchdog-")); roots.push(root);
    const child = spawn(process.execPath, [fixture, scenario, root], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const lines: string[] = [];
    const waiters: { prefix: string; resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
    const accept = (line: string) => {
      lines.push(line);
      const index = waiters.findIndex(waiter => line.startsWith(waiter.prefix));
      if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(line); }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { buffer += chunk; for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; accept(buffer.slice(0, end)); buffer = buffer.slice(end + 1); } });
    const waitLine = (prefix: string, timeoutMs: number) => {
      const found = lines.find(line => line.startsWith(prefix));
      if (found) return Promise.resolve(found);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { const index = waiters.findIndex(waiter => waiter.prefix === prefix); if (index >= 0) waiters.splice(index, 1); reject(new Error(`watchdog timed out waiting for ${prefix}`)); }, timeoutMs);
        waiters.push({ prefix, resolve, reject, timer });
      });
    };
    let closed = false;
    child.once("close", () => { closed = true; });
    try {
      await waitLine("STARTED", 5_000);
      if (scenario !== "prepare") await waitLine("PEER_READY", 3_000);
      const result = await waitLine("RESULT:", 5_000);
      expect(result).toMatch(/^RESULT:(TIMEOUT):HEARTBEATS:([1-9]\d*)$/);
      expect(lines.some(line => line.startsWith("HEARTBEAT"))).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture did not exit after deadline cleanup")), 1_000);
        child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)); });
      });
      const helpers = await fs.readdir(path.join(root, "helpers")).catch(() => []);
      expect(helpers).toEqual([]);
    } finally {
      for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error("fixture cleanup")); }
      if (!closed) { child.kill("SIGTERM"); await new Promise<void>(resolve => child.once("close", () => resolve())); }
    }
  }
}, 20_000);

test.skipIf(!process.env.LLV_VOICE_TOOLS_BUILT_ROOT)("the production worker discovers tools and compiles schemas", async () => {
  const { store, root } = await setup(); const server = fake(); const expected = await propose(store, server.url);
  const built = process.env.LLV_VOICE_TOOLS_BUILT_ROOT!;
  await fs.symlink(path.join(built, ".next"), path.join(root, ".next"), "dir");
  const previous = process.cwd();
  try {
    // An installed checkout has the compiled entry and no TypeScript source.
    process.chdir(root);
    await new VoiceToolHub(store).dryRun("music", expected);
    expect((await store.view()).servers.music.lastDryRun?.code).toBe("OK");
  } finally { process.chdir(previous); }
});
