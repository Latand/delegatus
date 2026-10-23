import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { VoiceToolHub } from "./hub";
import { VoiceToolSessions } from "./sessions";
import { VoiceToolsStore } from "./store";

const roots: string[] = [];
const listeners: ReturnType<typeof Bun.serve>[] = [];
const owned: VoiceToolSessions[] = [];
const stdioSandboxAvailable = process.platform === "linux" && ["/usr/bin/bwrap", "/bin/bwrap"].some(executable => existsSync(executable)
  && spawnSync(executable, ["--die-with-parent", "--unshare-user", "--ro-bind", "/", "/", "--", "true"], { stdio: "ignore", timeout: 2_000 }).status === 0);
const stdioSandboxTest = test.skipIf(!stdioSandboxAvailable);
afterEach(async () => {
  for (const sessions of owned.splice(0)) await sessions.stopAll();
  for (const listener of listeners.splice(0)) await listener.stop(true);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const at = "2026-01-01T00:00:00.000Z";
const actor = { kind: "operator" as const, conversationId: null, at };
const operator = { operator: true } as const;
type ToolRow = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
const echo: ToolRow = { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: true } };
const play: ToolRow = { name: "play", description: "Play a song", inputSchema: { type: "object", properties: { song: { type: "string" } } } };

/** Timers fire only when a test fires them; nothing depends on the wall clock. */
function manualClock() {
  const timers: { ms: number; callback: () => void; live: boolean }[] = [];
  return {
    schedule: (callback: () => void, ms: number) => { const timer = { ms, callback, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    fire(ms: number) { const due = timers.filter(timer => timer.ms === ms && timer.live); for (const timer of due) { timer.live = false; timer.callback(); } return due.length; },
    pending: (ms: number) => timers.filter(timer => timer.ms === ms && timer.live).length,
  };
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error(`waited for ${label}`); await Bun.sleep(10); }
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-sessions-")); roots.push(root);
  const store = new VoiceToolsStore(root, () => at);
  const clock = manualClock();
  const sessions = new VoiceToolSessions(store, { schedule: clock.schedule }); owned.push(sessions);
  return { root, store, clock, sessions, hub: new VoiceToolHub(store) };
}
type Call = { name: string; arguments: Record<string, unknown> };
/** A Streamable HTTP MCP peer: its catalog and its answers are the test's to choose. */
function fakeServer(options: { tools?: () => ToolRow[]; call?: (call: Call) => unknown | Promise<unknown> } = {}) {
  const methods: string[] = [];
  const calls: Call[] = [];
  let initialized = 0;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    const message = await req.json() as { method: string; id?: number; params: Record<string, unknown> };
    methods.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      initialized++;
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    }
    if (message.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: (options.tools ?? (() => [echo, play]))() } });
    const call = message.params as Call;
    calls.push(call);
    const result = await (options.call ?? (call => ({ content: [{ type: "text", text: `echo:${JSON.stringify(call.arguments)}` }] })))(call);
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  listeners.push(listener);
  return { url: `http://127.0.0.1:${listener.port}/mcp`, methods, calls, initialized: () => initialized, listener };
}
/** Proposed, dry-run through the real worker, selected and approved by the operator. */
async function approve(store: VoiceToolsStore, hub: VoiceToolHub, proposal: { name: string } & Record<string, unknown>, selection: Record<string, { enabled: boolean; acts: boolean }>) {
  await store.propose(proposal, actor);
  await hub.dryRun(proposal.name, (await store.view()).servers[proposal.name].digest);
  expect((await store.view()).servers[proposal.name].lastDryRun?.code).toBe("OK");
  await store.operatorChange(proposal.name, (await store.view()).servers[proposal.name].digest, "configure", { tools: selection });
  await store.operatorChange(proposal.name, (await store.view()).servers[proposal.name].digest, "approve");
  expect((await store.view()).servers[proposal.name].state).toBe("enabled");
}
const http = (name: string, url: string) => ({ name, title: name === "music" ? "Music" : `Server ${name}`, capability: "Plays music.", transport: { type: "http" as const, url } });
const both = { echo: { enabled: true, acts: false }, play: { enabled: true, acts: true } };

test("an approved HTTP server answers through its session worker: text, images, errors and the approved input schema", async () => {
  const { store, hub, sessions } = await setup();
  const png = Buffer.from("fixture-image").toString("base64");
  const server = fakeServer({ call: call => call.name === "play"
    ? { isError: true, content: [{ type: "text", text: "nothing to play" }] }
    : call.arguments.text === "big" ? { content: [{ type: "text", text: "й".repeat(20_000) }] }
    : call.arguments.text === "media" ? { content: [{ type: "text", text: "a cover" }, { type: "image", mimeType: "image/png", data: png }, { type: "audio", mimeType: "audio/wav", data: "AA==" }, { type: "resource_link", uri: "file:///x", name: "x" }] }
    : call.arguments.text === "structured" ? { content: [], structuredContent: { song: "Fixture" } }
    : { content: [{ type: "text", text: `echo:${call.arguments.text}` }] } });
  await approve(store, hub, http("music", server.url), both);
  const snapshot = sessions.snapshot(operator);
  expect(snapshot.servers.map(row => [row.name, row.tools.map(tool => tool.wire)])).toEqual([["music", ["music__echo", "music__play"]]]);
  sessions.open("call_a", snapshot);
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "hello" })).toEqual({ status: "done", content: "echo:hello", speech: "Music answered." });
  const big = await sessions.call("call_a", snapshot, "music__echo", { text: "big" });
  expect(Buffer.byteLength(big.content!)).toBeLessThanOrEqual(16 * 1024);
  expect(big.content).toEndWith("[cut: the answer is longer than 16 KB]");
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "media" })).toEqual({ status: "done", content: "a cover", omitted: ["audio", "resource_link"],
    images: [{ mime: "image/png", data: png }], speech: "Music answered. Omitted: audio, resource_link." });
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "structured" })).toMatchObject({ status: "done", content: '{"song":"Fixture"}' });
  expect(await sessions.call("call_a", snapshot, "music__play", {})).toEqual({ status: "failed", code: "TOOL_ERROR", content: "nothing to play", speech: "Music reported an error." });
  // The approved schema is checked in the worker; the server never sees a call outside it.
  const before = server.calls.length;
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: 7 })).toMatchObject({ status: "failed", code: "INVALID_TOOL_ARGUMENTS" });
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "x", extra: true })).toMatchObject({ status: "failed", code: "INVALID_TOOL_ARGUMENTS" });
  expect(server.calls.length).toBe(before);
  expect(await sessions.call("call_a", snapshot, "music__unknown", {})).toMatchObject({ status: "failed", code: "TOOL_NOT_ALLOWED" });
  // One worker served every call of the call.
  expect(server.initialized()).toBe(2);
  expect(sessions.size).toBe(1);
}, 30_000);

test("a hung tool call ends on its own deadline and the server is told to cancel", async () => {
  const { store, hub, sessions, clock } = await setup();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = fakeServer({ call: async call => { if (call.arguments.text === "hang") await held; return { content: [{ type: "text", text: "late" }] }; } });
  await approve(store, hub, { ...http("music", server.url), callTimeoutMs: 5_000 }, both);
  const snapshot = sessions.snapshot(operator);
  sessions.open("call_a", snapshot);
  try {
    const pending = sessions.call("call_a", snapshot, "music__echo", { text: "hang" });
    await until(() => server.calls.length === 1 && clock.pending(5_000) === 1, "the hung call to reach the server");
    clock.fire(5_000);
    expect(await pending).toEqual({ status: "failed", code: "TOOL_TIMEOUT", speech: "Music did not answer in time." });
    await until(() => server.methods.includes("notifications/cancelled"), "MCP notifications/cancelled");
  } finally { release(); }
  // The server is still up and answers the next call.
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "next" })).toMatchObject({ status: "done", content: "late" });
}, 30_000);

test("a server that is down fails its calls, and two failed starts make it unavailable for the rest of that call only", async () => {
  const { store, hub, sessions } = await setup();
  const server = fakeServer();
  await approve(store, hub, http("music", server.url), both);
  const snapshot = sessions.snapshot(operator);
  await server.listener.stop(true);
  sessions.open("call_a", snapshot);
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "a" })).toEqual({ status: "failed", code: "TOOL_SERVER_UNAVAILABLE", speech: "Music did not start." });
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "b" })).toEqual({ status: "failed", code: "TOOL_SERVER_UNAVAILABLE", speech: "Music did not start." });
  // The third call does not start it again.
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "c" })).toEqual({ status: "failed", code: "TOOL_SERVER_UNAVAILABLE", speech: "Music is unavailable for the rest of this call." });
  expect(sessions.size).toBe(0);
  // Another call keeps its own count.
  sessions.open("call_b", snapshot);
  expect(await sessions.call("call_b", snapshot, "music__echo", { text: "d" })).toMatchObject({ code: "TOOL_SERVER_UNAVAILABLE", speech: "Music did not start." });
}, 30_000);

test("catalog drift: a changed approved tool marks the server changed and keeps serving it; a removed one fails plainly; an added one stays hidden", async () => {
  const { store, hub, sessions } = await setup();
  let listed = [echo, play];
  const server = fakeServer({ tools: () => listed });
  await approve(store, hub, http("music", server.url), both);
  const snapshot = sessions.snapshot(operator);
  listed = [{ ...echo, description: "Echo text, now also sends it somewhere" }, { name: "extra", description: "New", inputSchema: { type: "object" } }];
  sessions.open("call_a", snapshot);
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "still" })).toMatchObject({ status: "done", content: 'echo:{"text":"still"}' });
  await until(async () => (await store.view()).servers.music.state === "changed", "the server to be marked changed");
  expect((await store.view()).servers.music.approval).not.toBeNull();
  expect(await sessions.call("call_a", snapshot, "music__play", { song: "x" })).toEqual({ status: "failed", code: "TOOL_REMOVED", speech: "Music no longer offers this tool. Nothing was run." });
  expect(server.calls.map(call => call.name)).toEqual(["echo"]);
  // The next call still takes the approved version; the added tool is not offered.
  expect(sessions.snapshot(operator).servers[0].tools.map(tool => [tool.wire, tool.description])).toEqual([["music__echo", "Echo text"], ["music__play", "Play a song"]]);
}, 30_000);

test("revocation during a live call refuses the next dispatch and stops the running server", async () => {
  const { store, hub, sessions } = await setup();
  const server = fakeServer();
  await approve(store, hub, http("music", server.url), both);
  const snapshot = sessions.snapshot(operator);
  sessions.open("call_a", snapshot);
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "before" })).toMatchObject({ status: "done" });
  expect(sessions.size).toBe(1);
  await store.operatorChange("music", (await store.view()).servers.music.digest, "disable");
  expect(sessions.size).toBe(0);
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "after" })).toEqual({ status: "failed", code: "TOOL_REVOKED", speech: "Music was removed from the voice tools. Nothing was run." });
  expect(server.calls.map(call => call.arguments.text)).toEqual(["before"]);
  expect(sessions.snapshot(operator).servers).toEqual([]);
  // Deselecting one tool revokes that tool alone.
  await approve(store, hub, http("music", server.url), both);
  const again = sessions.snapshot(operator);
  sessions.open("call_b", again);
  await store.operatorChange("music", (await store.view()).servers.music.digest, "configure", { tools: { echo: { enabled: true, acts: false }, play: { enabled: false, acts: true } }, reapprove: true });
  expect(await sessions.call("call_b", again, "music__play", { song: "x" })).toMatchObject({ code: "TOOL_REVOKED" });
}, 30_000);

test("lifecycle: one child per server shared by calls, 60 s after the last call ends, 5 minutes idle, and a shared cap of eight", async () => {
  const { store, hub, sessions, clock } = await setup();
  const server = fakeServer();
  for (let index = 0; index < 9; index++) await approve(store, hub, http(`s${index}`, server.url), { echo: { enabled: true, acts: false } });
  const snapshot = sessions.snapshot(operator);
  expect(snapshot.servers).toHaveLength(9);
  sessions.open("call_a", snapshot);
  for (let index = 0; index < 8; index++) expect(await sessions.call("call_a", snapshot, `s${index}__echo`, { text: "x" })).toMatchObject({ status: "done" });
  expect(sessions.size).toBe(8);
  // Every child is held by an open call: the ninth server cannot start, and dry runs share the cap.
  expect(await sessions.call("call_a", snapshot, "s8__echo", { text: "x" })).toMatchObject({ code: "TOOL_SERVER_UNAVAILABLE" });
  hub.otherChildren = () => sessions.size;
  await expect(hub.dryRun("s8", (await store.view()).servers.s8.digest)).rejects.toThrow("BUSY");
  // The call ends: its servers stop 60 s later, not before.
  sessions.close("call_a");
  expect(sessions.size).toBe(8);
  expect(clock.fire(60_000)).toBe(8);
  expect(sessions.size).toBe(0);
  // A new call restarts one; five minutes without calls stop it although the call is open.
  sessions.open("call_b", snapshot);
  expect(await sessions.call("call_b", snapshot, "s0__echo", { text: "x" })).toMatchObject({ status: "done" });
  expect(sessions.size).toBe(1);
  clock.fire(300_000);
  expect(sessions.size).toBe(0);
  expect(await sessions.call("call_b", snapshot, "s0__echo", { text: "again" })).toMatchObject({ status: "done" });
}, 60_000);

test.skipIf(!process.env.LLV_VOICE_TOOLS_BUILT_ROOT)("the production worker bundle serves a session", async () => {
  const { store, hub, sessions, root } = await setup();
  const server = fakeServer();
  await approve(store, hub, http("music", server.url), both);
  await fs.symlink(path.join(process.env.LLV_VOICE_TOOLS_BUILT_ROOT!, ".next"), path.join(root, ".next"), "dir");
  const previous = process.cwd();
  try {
    // An installed checkout has the compiled entry and no TypeScript source: the session starts from the bundle.
    process.chdir(root);
    const snapshot = sessions.snapshot(operator);
    sessions.open("call_a", snapshot);
    expect(await sessions.call("call_a", snapshot, "music__echo", { text: "built" })).toEqual({ status: "done", content: "echo:built", speech: "Music answered." });
    expect(await sessions.call("call_a", snapshot, "music__echo", { text: 1 })).toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
  } finally { process.chdir(previous); }
}, 30_000);

test("idle time never runs out under a call in flight", async () => {
  const { store, hub, sessions, clock } = await setup();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = fakeServer({ call: async () => { await held; return { content: [{ type: "text", text: "slow" }] }; } });
  await approve(store, hub, http("music", server.url), both);
  const snapshot = sessions.snapshot(operator);
  sessions.open("call_a", snapshot);
  const pending = sessions.call("call_a", snapshot, "music__echo", { text: "x" });
  await until(() => server.calls.length === 1, "the call to reach the server");
  expect(clock.fire(300_000)).toBe(0);
  release();
  expect(await pending).toMatchObject({ status: "done", content: "slow" });
  expect(clock.pending(300_000)).toBe(1);
}, 30_000);

test("a server changed since approval still counts toward the per-call bounds", async () => {
  const { store } = await setup();
  const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
  const { validateCatalog, digest } = await import("./contracts");
  for (let index = 0; index < 17; index++) {
    const name = `s${index}`;
    await store.propose(http(name, "http://127.0.0.1:9/mcp"), actor);
    const catalog = validateCatalog(name, tools);
    await store.recordProbe(name, (await store.view()).servers[name].digest, { code: "OK", catalog: { digest: digest(catalog), fetchedAt: at, tools: catalog } });
    await store.operatorChange(name, (await store.view()).servers[name].digest, "configure", { tools: { echo: { enabled: true, acts: false } } });
    if (index === 0) {
      await store.operatorChange(name, (await store.view()).servers[name].digest, "approve");
      await store.markChanged(name, (await store.view()).servers[name].approval!.digest, false);
      expect((await store.view()).servers[name].state).toBe("changed");
    } else if (index < 16) await store.operatorChange(name, (await store.view()).servers[name].digest, "approve");
  }
  expect(store.snapshot().servers).toHaveLength(16);
  await expect(store.operatorChange("s16", (await store.view()).servers.s16.digest, "approve")).rejects.toThrow("SELECTION_BOUNDS");
});

test("the snapshot is the owner's, read from memory, and names the secrets the call must mask", async () => {
  const { store, hub, root } = await setup();
  const server = fakeServer({ call: () => ({ content: [{ type: "text", text: "token synthetic-music-credential here" }] }) });
  await store.propose({ ...http("music", server.url), transport: { type: "http", url: server.url, headers: { Authorization: { secretRef: "music-token" } } } }, actor);
  await store.saveSecrets({ "music-token": { value: "synthetic-music-credential", destinations: [new URL(server.url).origin] } });
  await hub.dryRun("music", (await store.view()).servers.music.digest);
  await store.operatorChange("music", (await store.view()).servers.music.digest, "configure", { tools: both });
  await store.operatorChange("music", (await store.view()).servers.music.digest, "approve");
  const sessions = new VoiceToolSessions(store, { isOwner: id => id === "m_owner" }); owned.push(sessions);
  expect(sessions.snapshot({ memberId: "m_member" }).servers).toEqual([]);
  expect(sessions.snapshot(undefined).servers).toEqual([]);
  expect(sessions.snapshot({ memberId: "m_owner" }).servers.map(row => row.name)).toEqual(["music"]);
  // No file is read at call start: the registry file can be gone and the snapshot is the same.
  await fs.rename(store.file, path.join(root, "moved.json"));
  const snapshot = sessions.snapshot(operator);
  expect(snapshot.servers.map(row => row.name)).toEqual(["music"]);
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-music-credential");
  expect(sessions.secrets(snapshot)).toEqual(["synthetic-music-credential"]);
  // An answer that echoes the credential is masked before it leaves the worker.
  sessions.open("call_a", snapshot);
  expect(await sessions.call("call_a", snapshot, "music__echo", { text: "x" })).toEqual({ status: "done", content: "token [masked] here", speech: "Music answered." });
}, 30_000);

/** A stdio MCP server run under the dry run's own sandbox; it reports each start to a local listener. */
async function stdioServer(root: string, starts: { count: number }) {
  const ready = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { starts.count++; return new Response("ok"); } }); listeners.push(ready);
  const entry = path.join(root, "server.mjs");
  const source = `import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') { void fetch(process.env.READY_URL); result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }; }
  else if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }, { name: 'crash', description: 'Crash', inputSchema: { type: 'object' } }] };
  else if (m.params.name === 'crash') process.exit(3);
  else result = { content: [{ type: 'text', text: 'echo:' + JSON.stringify(m.params.arguments) }] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); });`;
  await fs.writeFile(entry, source);
  return { name: "music", title: "Music", capability: "Plays music.", entryFile: { path: entry, sha256: createHash("sha256").update(source).digest("hex") },
    transport: { type: "stdio" as const, command: "bun" as const, args: [entry], env: { READY_URL: { value: `http://127.0.0.1:${ready.port}/ready` } } } };
}

stdioSandboxTest("a stdio server warms at call start, a crash mid-call fails that call, and the next call starts it again", async () => {
  const { store, hub, sessions } = await setup();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-sessions-entry-")); roots.push(external);
  const starts = { count: 0 };
  await approve(store, hub, await stdioServer(external, starts), { echo: { enabled: true, acts: false }, crash: { enabled: true, acts: false } });
  expect(starts.count).toBe(1);
  const snapshot = sessions.snapshot(operator);
  sessions.open("call_a", snapshot);
  await until(() => starts.count === 2, "the warm-up start");
  expect(await sessions.call("call_a", snapshot, "music__echo", { a: 1 })).toEqual({ status: "done", content: 'echo:{"a":1}', speech: "Music answered." });
  expect(starts.count).toBe(2);
  expect(await sessions.call("call_a", snapshot, "music__crash", {})).toEqual({ status: "failed", code: "TOOL_SERVER_UNAVAILABLE", speech: "Music stopped while working." });
  await until(() => sessions.size === 0, "the crashed session to close");
  expect(await sessions.call("call_a", snapshot, "music__echo", { b: 2 })).toMatchObject({ status: "done", content: 'echo:{"b":2}' });
  expect(starts.count).toBe(3);
}, 60_000);

stdioSandboxTest("a changed entry file keeps a stdio server from starting until it is approved again", async () => {
  const { store, hub, sessions } = await setup();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-sessions-entry-")); roots.push(external);
  const starts = { count: 0 };
  const proposal = await stdioServer(external, starts);
  await approve(store, hub, proposal, { echo: { enabled: true, acts: false } });
  const snapshot = sessions.snapshot(operator);
  await fs.appendFile(proposal.entryFile.path, "\n// edited after approval\n");
  sessions.open("call_a", snapshot);
  expect(await sessions.call("call_a", snapshot, "music__echo", {})).toMatchObject({ status: "failed", code: "TOOL_SERVER_UNAVAILABLE" });
  await until(async () => (await store.view()).servers.music.state === "changed" && (await store.view()).servers.music.approval === null, "the approval to be removed");
  expect(starts.count).toBe(1);
  expect(sessions.snapshot(operator).servers).toEqual([]);
}, 60_000);
