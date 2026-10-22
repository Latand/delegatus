import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { approvalDigest, digest, type VoiceToolServer } from "./contracts";
import { VoiceToolsStore } from "./store";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const at = "2026-01-01T00:00:00.000Z";
const actor = { kind: "conversation" as const, conversationId: "conversation_worker", at };
const proposal = (name = "music") => ({ name, title: "Music", capability: "Search music", transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: { secretRef: "music-token" } } } });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-store-")); roots.push(root);
  return { root, store: new VoiceToolsStore(root, () => at) };
}
async function server(store: VoiceToolsStore, name = "music") { return (await store.view()).servers[name]; }
async function catalog(store: VoiceToolsStore, count = 1, name = "music") {
  const tools = Array.from({ length: count }, (_, i) => ({ name: `search${i}`, description: "Search music", inputSchema: { type: "object", properties: {} } }));
  await store.recordProbe(name, (await server(store, name)).digest, { code: "OK", catalog: { digest: digest(tools), fetchedAt: at, tools } });
}

async function saveSecrets(store: VoiceToolsStore, values: Record<string, string>, authorize?: () => void) {
  const view = await store.view();
  const destinations = Object.fromEntries(Object.entries(values).map(([ref, value]) => [ref, { value, destinations: Object.entries(view.servers)
    .filter(([, server]) => server.secretRefs.includes(ref)).map(([name, server]) => server.transport.type === "http" ? new URL(server.transport.url).origin : `stdio:${name}`) }]));
  for (const entry of Object.values(destinations)) if (!entry.destinations.length) entry.destinations.push("https://example.invalid");
  return store.saveSecrets(destinations, authorize);
}

test("secret values live only in the owner-only file; public views show a secret header by name", async () => {
  const { store, root } = await setup();
  await store.propose(proposal(), actor);
  const value = "synthetic-voice-credential";
  await saveSecrets(store, { "music-token": value });
  const view = await store.view();
  expect(JSON.stringify(view)).not.toContain(value);
  expect(view.servers.music.transport).toEqual({ type: "http", url: "https://example.invalid/mcp", headerNames: ["Authorization"], headerValues: {} });
  expect(view.servers.music.missingSecrets).toEqual([]);
  expect((await fs.stat(path.join(root, "voice-tools-secrets.json"))).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(store.file, "utf8")).not.toContain(value);
  await expect(store.propose({ ...proposal(), title: value }, actor)).rejects.toThrow("SECRET_ECHO");
  await expect(store.recordProbe("music", (await server(store)).digest, { code: "OK", catalog: { digest: "irrelevant", fetchedAt: at,
    tools: [{ name: "search", description: value, inputSchema: { type: "object" } }] } })).rejects.toThrow("SECRET_ECHO");
  expect(JSON.stringify(await new VoiceToolsStore(root).view())).not.toContain(value);
  await fs.chmod(path.join(root, "voice-tools-secrets.json"), 0o644);
  await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
});

test("approval requires a matching successful probe; pinned edits and stale clicks fail closed across reloads", async () => {
  const { store, root } = await setup();
  await store.propose(proposal(), actor);
  await expect(store.operatorChange("music", (await server(store)).digest, "approve")).rejects.toThrow("MISSING_SECRET");
  await saveSecrets(store, { "music-token": "synthetic-voice-credential" });
  await catalog(store);
  const before = (await server(store)).digest;
  await store.operatorChange("music", before, "approve");
  expect((await server(store)).state).toBe("enabled");
  await saveSecrets(store, { "music-token": "synthetic-replacement-credential" });
  expect((await server(store)).state).toBe("enabled");
  await store.propose({ ...proposal(), capability: "Find music" }, actor);
  expect((await server(store)).state).toBe("pending");
  await expect(store.operatorChange("music", before, "approve")).rejects.toThrow("STALE_APPROVAL");
  const reloaded = new VoiceToolsStore(root, () => at);
  expect((await server(reloaded)).state).toBe("pending");
  await reloaded.operatorChange("music", (await server(reloaded)).digest, "approve");
  await reloaded.operatorChange("music", (await server(reloaded)).digest, "configure", { askBeforeActing: true });
  expect((await server(reloaded)).state).toBe("pending");
  // A hand-edited pinned field cannot retain its approval on a fresh process load.
  await reloaded.operatorChange("music", (await server(reloaded)).digest, "approve");
  const raw = JSON.parse(await fs.readFile(store.file, "utf8")); raw.servers.music.transport.url = "https://example.invalid/other";
  await fs.writeFile(store.file, JSON.stringify(raw), { mode: 0o600 });
  expect((await server(new VoiceToolsStore(root))).state).toBe("pending");
});

test("old probe answers cannot overwrite a changed or removed-and-recreated proposal", async () => {
  const { store } = await setup(); await store.propose(proposal(), actor);
  const before = (await server(store)).digest;
  await store.operatorChange("music", before, "remove"); await store.propose(proposal(), actor);
  expect((await server(store)).digest).not.toBe(before);
  await expect(store.recordProbe("music", before, { code: "TIMEOUT" })).rejects.toThrow("STALE_APPROVAL");
  expect((await server(store)).lastDryRun).toBeNull();
  const current = (await server(store)).digest;
  await store.operatorChange("music", current, "reject");
  await expect(store.recordProbe("music", current, { code: "TIMEOUT" })).rejects.toThrow("STALE_APPROVAL");
  expect((await server(store)).state).toBe("rejected");
  const rejected = (await server(store)).digest;
  await store.propose({ ...proposal(), title: "Changed" }, actor);
  await store.propose(proposal(), actor);
  await expect(store.recordProbe("music", rejected, { code: "TIMEOUT" })).rejects.toThrow("STALE_APPROVAL");
});

test("selection enforces aggregate tool count, server count and JSON byte budget", async () => {
  const { store } = await setup();
  await store.propose({ ...proposal(), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor);
  await catalog(store, 33);
  const tools = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`search${i}`, { enabled: true, acts: false }]));
  await store.operatorChange("music", (await server(store)).digest, "configure", { tools });
  await expect(store.operatorChange("music", (await server(store)).digest, "approve")).rejects.toThrow("SELECTION_BOUNDS");
  delete tools.search32;
  await store.operatorChange("music", (await server(store)).digest, "configure", { tools });
  await store.operatorChange("music", (await server(store)).digest, "approve");
  expect((await server(store)).state).toBe("enabled");
  // Large individually valid schemas can still exceed the aggregate wire budget.
  const large = Array.from({ length: 8 }, (_, i) => ({ name: `large${i}`, description: "x".repeat(1024), inputSchema: { type: "object", description: "x".repeat(7000) } }));
  await store.recordProbe("music", (await server(store)).digest, { code: "OK", catalog: { digest: digest(large), fetchedAt: at, tools: large } });
  await store.operatorChange("music", (await server(store)).digest, "configure", { tools: Object.fromEntries(large.map(t => [t.name, { enabled: true, acts: false }])) });
  await expect(store.operatorChange("music", (await server(store)).digest, "approve")).rejects.toThrow("SELECTION_BOUNDS");
  await store.operatorChange("music", (await server(store)).digest, "remove");
  for (let i = 0; i < 17; i++) {
    const name = `server${i}`; await store.propose({ ...proposal(name), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor); await catalog(store, 0, name);
    if (i < 16) await store.operatorChange(name, (await server(store, name)).digest, "approve");
    else await expect(store.operatorChange(name, (await server(store, name)).digest, "approve")).rejects.toThrow("SELECTION_BOUNDS");
  }
});

test("invalid catalog or secret artifact fails closed; secrets cannot be introduced into existing metadata", async () => {
  const { store, root } = await setup(); await store.propose(proposal(), actor);
  await expect(saveSecrets(store, { token: "Search music" })).rejects.toThrow("SECRET_ECHO");
  const target = path.join(root, "private.json"); await fs.writeFile(target, "{}", { mode: 0o600 });
  await fs.symlink(target, path.join(root, "voice-tools-secrets.json"));
  await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
  await fs.rm(path.join(root, "voice-tools-secrets.json"));
  await catalog(store);
  const raw = JSON.parse(await fs.readFile(store.file, "utf8")); raw.servers.music.catalog.tools[0].description = "drift";
  await fs.writeFile(store.file, JSON.stringify(raw), { mode: 0o600 });
  await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
});

test("a restarted store refuses a persisted catalog with invalid JSON Schema", async () => {
  const { store, root } = await setup();
  await store.propose(proposal(), actor);
  await catalog(store);
  const raw = JSON.parse(await fs.readFile(store.file, "utf8"));
  raw.servers.music.catalog.tools[0].inputSchema = { type: "object", properties: { broken: { type: "invalid-type" } } };
  raw.servers.music.catalog.digest = digest(raw.servers.music.catalog.tools);
  await fs.writeFile(store.file, JSON.stringify(raw), { mode: 0o600 });
  const restarted = new VoiceToolsStore(root, () => at);
  await expect(restarted.view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
  await expect(restarted.operatorChange("music", "irrelevant", "approve")).rejects.toThrow("REGISTRY_UNAVAILABLE");
});

test("digest covers the selected catalog separately from ephemeral probe timestamps", async () => {
  const { store } = await setup(); await store.propose(proposal(), actor); await catalog(store);
  await saveSecrets(store, { "music-token": "synthetic-voice-credential" });
  const raw = (await store.probeInput("music", (await server(store)).digest)).server;
  const before = approvalDigest("music", raw);
  const changed: VoiceToolServer = structuredClone(raw); changed.catalog!.fetchedAt = "2026-02-01T00:00:00Z";
  expect(approvalDigest("music", changed)).toBe(before);
  changed.catalog!.digest = digest("changed"); expect(approvalDigest("music", changed)).not.toBe(before);
});

test("the proposal cap survives a real process restart", async () => {
  const { store, root } = await setup();
  for (let i = 0; i < 64; i++) await store.propose({ ...proposal(`server${i}`), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor);
  const source = `import {VoiceToolsStore} from './src/lib/voiceTools/store.ts';
const store=new VoiceToolsStore(process.env.VOICE_TOOLS_TEST_ROOT);
try { await store.propose(${JSON.stringify({ ...proposal("overflow"), transport: { type: "http", url: "https://example.invalid/mcp" } })},${JSON.stringify(actor)}); process.exit(1); }
catch(error) { if(error.code!=='REGISTRY_BOUNDS')process.exit(2); }
console.log(Object.keys((await store.view()).servers).length);`;
  const child = Bun.spawn([process.execPath, "--eval", source], { env: { ...process.env, VOICE_TOOLS_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status).toBe(0); expect(error).toBe(""); expect(output.trim()).toBe("64");
});

test("normalized names cannot collide across two selected servers", async () => {
  const { store } = await setup();
  for (const [name, tool] of [["music", "search__all"], ["music__search", "all"]]) {
    await store.propose({ ...proposal(name), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor);
    const tools = [{ name: tool, description: "Search", inputSchema: { type: "object" } }];
    await store.recordProbe(name, (await server(store, name)).digest, { code: "OK", catalog: { digest: digest(tools), fetchedAt: at, tools } });
    await store.operatorChange(name, (await server(store, name)).digest, "configure", { tools: { [tool]: { enabled: true, acts: false } } });
    if (name === "music") await store.operatorChange(name, (await server(store, name)).digest, "approve");
    else await expect(store.operatorChange(name, (await server(store, name)).digest, "approve")).rejects.toThrow("CATALOG_BOUNDS");
  }
});

test("authority is rechecked after lock admission and before committing a secret or approval", async () => {
  const { store } = await setup(); await store.propose({ ...proposal(), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor); await catalog(store);
  let checks = 0;
  const authorize = () => { if (++checks > 1) throw new Error("REVOKED"); };
  await expect(store.operatorChange("music", (await server(store)).digest, "approve", {}, authorize)).rejects.toThrow("REVOKED");
  expect((await server(store)).state).toBe("pending");
  checks = 0;
  await expect(saveSecrets(store, { token: "synthetic-voice-credential" }, authorize)).rejects.toThrow("REVOKED");
  await expect(fs.access(path.join(store.directory, "voice-tools-secrets.json"))).rejects.toThrow();
  expect((await fs.readdir(store.directory)).some(name => name.endsWith(".tmp"))).toBe(false);
});

test("prototype property names remain ordinary server, tool and secret-reference names", async () => {
  const { store } = await setup();
  await store.propose({ ...proposal("constructor"), transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: { secretRef: "constructor" } } } }, actor);
  expect((await server(store, "constructor")).missingSecrets).toEqual(["constructor"]);
  await expect(store.probeInput("constructor", (await server(store, "constructor")).digest)).rejects.toThrow("MISSING_SECRET");
  await saveSecrets(store, { constructor: "synthetic-voice-credential" });
  const tools = [{ name: "constructor", description: "Search", inputSchema: { type: "object" } }];
  await store.recordProbe("constructor", (await server(store, "constructor")).digest, { code: "OK", catalog: { digest: digest(tools), fetchedAt: at, tools } });
  expect((await server(store, "constructor")).tools).toEqual({ constructor: { enabled: false, acts: true } });
});

test("reserved names, relative working directories and unpinned script entries are refused", async () => {
  const { store } = await setup();
  await expect(store.propose(proposal("list_tasks"), actor)).rejects.toThrow("INVALID_PROPOSAL");
  await expect(store.propose({ ...proposal(), transport: { type: "stdio", command: "bun", args: [], cwd: "relative" } }, actor)).rejects.toThrow("INVALID_PROPOSAL");
  await expect(store.propose({ ...proposal(), transport: { type: "stdio", command: "bun", args: ["server.ts"] } }, actor)).rejects.toThrow("INVALID_PROPOSAL");
});

test("a launch variable is refused at proposal and on load, and allowed variables still show", async () => {
  const { store, root } = await setup();
  const launch = (env: Record<string, unknown>) => ({ ...proposal(), transport: { type: "stdio", command: "bun", args: ["x", "harmless-mcp"], env } });
  await expect(store.propose(launch({ PATH: { value: "/srv/agent/bin" }, LD_PRELOAD: { value: "/srv/agent/x.so" }, BUN_CONFIG_REGISTRY: { value: "https://registry.example.test" } }), actor))
    .rejects.toThrow("INVALID_PROPOSAL");
  await expect(store.propose(launch({ NODE_OPTIONS: { value: "--require /srv/agent/x.js" } }), actor)).rejects.toThrow("INVALID_PROPOSAL");
  expect((await store.view()).servers).toEqual({});
  await store.propose(launch({ SPOTIFY_REDIRECT_URI: { value: "http://127.0.0.1:8888/callback" }, SPOTIFY_CLIENT_ID: { secretRef: "spotify-client-id" } }), actor);
  const shown = (await server(store)).transport;
  expect(shown).toEqual({ type: "stdio", command: "bun", args: ["x", "harmless-mcp"], cwd: null, envNames: ["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"],
    envValues: { SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8888/callback" } });
  /* A record edited on disk to carry one fails closed on the next load. */
  const raw = JSON.parse(await fs.readFile(store.file, "utf8")); raw.servers.music.transport.env.PATH = { value: "/srv/agent/bin" };
  await fs.writeFile(store.file, JSON.stringify(raw), { mode: 0o600 });
  await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
});

test("re-approving the operator's own change on an approved server commits both or neither", async () => {
  const { store } = await setup();
  await store.propose({ ...proposal(), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor);
  await catalog(store, 33);
  const first32 = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`search${i}`, { enabled: true, acts: false }]));
  await store.operatorChange("music", (await server(store)).digest, "configure", { tools: { ...first32, search32: { enabled: false, acts: false } } });
  await store.operatorChange("music", (await server(store)).digest, "approve");
  const approved = await server(store);
  expect(approved.state).toBe("enabled");
  const bytes = await fs.readFile(store.file);
  /* A 33rd tool exceeds the selection bound: the configure that would have landed is refused with it. */
  await expect(store.operatorChange("music", approved.digest, "configure", { tools: { ...first32, search32: { enabled: true, acts: false } }, reapprove: true }))
    .rejects.toThrow("SELECTION_BOUNDS");
  expect(Buffer.compare(await fs.readFile(store.file), bytes)).toBe(0);
  const reread = await server(new VoiceToolsStore(store.directory, () => at));
  expect([reread.state, reread.digest, reread.approval, reread.askBeforeActing, reread.tools.search32.enabled]).toEqual(["enabled", approved.digest, approved.approval, false, false]);
  /* An accepted change is approved under its new digest in the same write. */
  await store.operatorChange("music", approved.digest, "configure", { askBeforeActing: true, reapprove: true });
  const changed = await server(store);
  expect([changed.state, changed.askBeforeActing, changed.approval?.digest]).toEqual(["enabled", true, changed.digest]);
  expect(changed.digest).not.toBe(approved.digest);
  /* Re-approval is only for a server the operator saw approved; a pending one keeps its digest-bound flow. */
  await store.operatorChange("music", changed.digest, "disable");
  const disabled = await server(store);
  const before = await fs.readFile(store.file);
  await expect(store.operatorChange("music", disabled.digest, "configure", { askBeforeActing: false, reapprove: true })).rejects.toThrow("STALE_APPROVAL");
  await expect(store.operatorChange("music", disabled.digest, "configure", { askBeforeActing: false, reapprove: "yes" })).rejects.toThrow("INVALID_REQUEST");
  expect(Buffer.compare(await fs.readFile(store.file), before)).toBe(0);
});

test("local stdio pins the actual explicit entry against its execution cwd", async () => {
  const { store, root } = await setup();
  const cwd = path.join(root, "voice-tools-data", "music");
  const pinned = path.join(cwd, "server");
  const decoy = path.join(cwd, "preload.mjs");
  const pin = { path: pinned, sha256: "a".repeat(64) };
  const config = (command: "bun" | "uv", args: string[], entryFile: typeof pin | null = pin) => ({
    ...proposal(), transport: { type: "stdio" as const, command, args, cwd: null, env: {} }, entryFile,
  });
  const pinnedArgs = async () => {
    const current = await server(store);
    if (current.transport.type !== "stdio") throw new Error("Expected a stdio server");
    return current.transport.args;
  };
  await store.propose(config("bun", ["server" ]), actor);
  expect(await pinnedArgs()).toEqual(["run", pinned]);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await store.propose(config("bun", ["./server"]), actor);
  expect(await pinnedArgs()).toEqual(["run", pinned]);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await store.propose(config("bun", ["run", path.join(cwd, "actual.mjs")], { ...pin, path: path.join(cwd, "actual.mjs") }), actor);
  expect(await pinnedArgs()).toEqual(["run", path.join(cwd, "actual.mjs")]);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await expect(store.propose(config("bun", ["run", path.join(cwd, "actual.mjs")], { ...pin, path: path.join(cwd, "run") }), actor)).rejects.toThrow("INVALID_PROPOSAL");
  await store.propose(config("bun", ["x", "music-mcp"], { ...pin, path: path.join(cwd, "x") }), actor);
  expect(await pinnedArgs()).toEqual(["run", path.join(cwd, "x"), "music-mcp"]);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await store.propose(config("bun", ["./run"], { ...pin, path: path.join(cwd, "run") }), actor);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await expect(store.propose(config("bun", ["--preload", decoy, pinned]), actor)).rejects.toThrow("INVALID_PROPOSAL");
  await expect(store.propose(config("bun", ["server"], { ...pin, path: path.join(root, "server") }), actor)).rejects.toThrow("INVALID_PROPOSAL");
  await store.propose(config("bun", ["server", "--mode", "voice"]), actor);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await store.propose(config("uv", ["run", "server.py", "--mode", "voice"], { ...pin, path: path.join(cwd, "server.py") }), actor);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await store.propose(config("bun", ["x", "@example/music-mcp"], null), actor);
  await store.operatorChange("music", (await server(store)).digest, "remove");
  await store.propose(config("uv", ["tool", "run", "music-mcp"], null), actor);
});

test("persisted defaults are normalized on load and invalid catalog shapes are refused", async () => {
  const { store, root } = await setup(); await store.propose(proposal(), actor);
  const raw = JSON.parse(await fs.readFile(store.file, "utf8"));
  delete raw.servers.music.askBeforeActing; delete raw.servers.music.callTimeoutMs;
  await fs.writeFile(store.file, JSON.stringify(raw), { mode: 0o600 });
  const loaded = await new VoiceToolsStore(root).view();
  expect(loaded.servers.music.askBeforeActing).toBe(false); expect(loaded.servers.music.callTimeoutMs).toBe(15_000);
  raw.servers.music.catalog = false;
  await fs.writeFile(store.file, JSON.stringify(raw), { mode: 0o600 });
  await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
});

test("the approval view shows the value of each literal variable and header, and only the name of a secret one", async () => {
  const { store } = await setup();
  await store.propose({ ...proposal(), transport: { type: "stdio", command: "bun", args: ["x", "harmless-mcp"],
    env: { NOTES_FORMAT: { value: "markdown" }, SERVER_TOKEN: { secretRef: "server-token" } } } }, actor);
  await store.propose({ ...proposal("radio"), transport: { type: "http", url: "https://example.invalid/mcp",
    headers: { "X-Workspace": { value: "studio-a" }, Authorization: { secretRef: "radio-token" } } } }, actor);
  await saveSecrets(store, { "server-token": "synthetic-voice-credential", "radio-token": "synthetic-radio-credential" });
  const view = await store.view();
  expect(view.servers.music.transport).toEqual({ type: "stdio", command: "bun", args: ["x", "harmless-mcp"], cwd: null,
    envNames: ["NOTES_FORMAT", "SERVER_TOKEN"], envValues: { NOTES_FORMAT: "markdown" } });
  expect(view.servers.radio.transport).toEqual({ type: "http", url: "https://example.invalid/mcp",
    headerNames: ["Authorization", "X-Workspace"], headerValues: { "X-Workspace": "studio-a" } });
  expect(JSON.stringify(view)).not.toContain("synthetic-");
});

test("a package launch runs from a fresh folder, so a proposed folder for it is refused", async () => {
  const { store } = await setup();
  for (const args of [["x", "harmless-mcp"], ["tool", "run", "harmless-mcp"]]) {
    await expect(store.propose({ ...proposal(), transport: { type: "stdio", command: args[0] === "x" ? "bun" : "uv", args, cwd: "/srv/agent/project" } }, actor))
      .rejects.toThrow("INVALID_PROPOSAL");
  }
  expect((await store.view()).servers).toEqual({});
});

test("approved non-registry package records fail a fresh load even with a matching approval digest", async () => {
  const { store, root } = await setup();
  await store.propose({ ...proposal(), transport: { type: "stdio", command: "bun", args: ["x", "music-mcp@1.2.3"] } }, actor);
  await catalog(store);
  await store.operatorChange("music", (await server(store)).digest, "approve");
  const approved = JSON.parse(await fs.readFile(store.file, "utf8"));
  expect((await server(new VoiceToolsStore(root))).state).toBe("enabled");
  for (const [command, args] of [
    ["bun", ["x", "name@file:/abs"]], ["bun", ["x", "/abs"]], ["uv", ["tool", "run", "/abs"]],
    ["uv", ["tool", "run", "n @ file:///abs"]], ["bun", ["x", "git+file:/abs"]], ["uv", ["tool", "run", "git+file:/abs"]],
  ] as const) {
    const raw = structuredClone(approved);
    raw.servers.music.transport = { type: "stdio", command, args: [...args], cwd: null, env: {} };
    raw.servers.music.approval.digest = approvalDigest("music", raw.servers.music);
    await fs.writeFile(store.file, JSON.stringify(raw));
    await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
  }
});


test("a self-written approval digest cannot enable a server on fresh load", async () => {
  const { store, root } = await setup();
  await store.propose({ ...proposal(), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor);
  await catalog(store);
  const raw = JSON.parse(await fs.readFile(store.file, "utf8"));
  raw.servers.music.state = "enabled";
  raw.servers.music.approval = { by: "operator", at, digest: approvalDigest("music", raw.servers.music) };
  await fs.writeFile(store.file, JSON.stringify(raw));
  const loaded = (await new VoiceToolsStore(root).view()).servers.music;
  expect(loaded.state).toBe("pending");
  expect(loaded.approval).toBeNull();
});

test("a global secret name cannot be proposed to a different destination", async () => {
  const { store } = await setup();
  await saveSecrets(store, { "music-token": "synthetic-voice-credential" });
  await expect(store.propose({ ...proposal(), transport: { type: "http", url: "https://other.example.test/mcp", headers: { Authorization: { secretRef: "music-token" } } } }, actor))
    .rejects.toThrow("SECRET_DESTINATION");
});


test("approved records and destination grants fail closed after a real process restart", async () => {
  const { store, root } = await setup();
  await store.propose(proposal(), actor);
  await saveSecrets(store, { "music-token": "synthetic-voice-credential" });
  await catalog(store);
  await store.operatorChange("music", (await server(store)).digest, "approve");
  expect((await server(new VoiceToolsStore(root))).state).toBe("enabled");
  const source = `import {VoiceToolsStore} from './src/lib/voiceTools/store.ts';
const store = new VoiceToolsStore(process.env.VOICE_TOOLS_TEST_ROOT);
const view = await store.view();
let code;
try { await store.probeInput('music', view.servers.music.digest); } catch (error) { code = error.code; }
await store.saveSecrets({'music-token':{destinations:['https://example.invalid']}});
await store.recordProbe('music',view.servers.music.digest,{code:'OK',catalog:view.servers.music.catalog});
await store.operatorChange('music',view.servers.music.digest,'approve');
console.log(JSON.stringify({state:view.servers.music.state, approval:view.servers.music.approval, policies:view.servers.music.secretDestinations, code, renewedState:(await store.view()).servers.music.state}));`;
  const child = Bun.spawn([process.execPath, "--eval", source], { env: { ...process.env, VOICE_TOOLS_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status).toBe(0); expect(error).toBe("");
  expect(JSON.parse(output)).toEqual({ state: "pending", approval: null, policies: { "music-token": [] }, code: "SECRET_DESTINATION", renewedState: "enabled" });
  // A new owner grant can reuse the private value without returning it to the browser.
  await store.saveSecrets({ "music-token": { destinations: ["https://example.invalid"] } });
  expect((await store.probeInput("music", (await server(store)).digest)).secrets).toEqual({ "music-token": "synthetic-voice-credential" });
});

test("editing a signed approval or destination file never widens authority", async () => {
  const { store, root } = await setup(); await store.propose(proposal(), actor);
  await saveSecrets(store, { "music-token": "synthetic-voice-credential" }); await catalog(store);
  await store.operatorChange("music", (await server(store)).digest, "approve");
  const approved = JSON.parse(await fs.readFile(store.file, "utf8"));
  approved.servers.music.askBeforeActing = true;
  approved.servers.music.approval.digest = approvalDigest("music", approved.servers.music);
  await fs.writeFile(store.file, JSON.stringify(approved));
  expect((await server(new VoiceToolsStore(root))).approval).toBeNull();
  const secretFile = path.join(root, "voice-tools-secrets.json");
  const raw = JSON.parse(await fs.readFile(secretFile, "utf8"));
  raw["music-token"].destinations.push("https://other.example.test");
  await fs.writeFile(secretFile, JSON.stringify(raw));
  const fresh = new VoiceToolsStore(root);
  expect((await server(fresh)).secretDestinations).toEqual({ "music-token": [] });
  await expect(fresh.probeInput("music", (await server(fresh)).digest)).rejects.toThrow("SECRET_DESTINATION");
  await expect(fresh.operatorChange("music", (await server(fresh)).digest, "approve")).rejects.toThrow("SECRET_DESTINATION");
  await expect(fresh.propose({ ...proposal(), transport: { type: "http", url: "https://other.example.test/mcp", headers: { Authorization: { secretRef: "music-token" } } } }, actor)).rejects.toThrow("SECRET_DESTINATION");
});

test("short secrets are rejected explicitly and legacy short values do not disable every view", async () => {
  const { store, root } = await setup(); await store.propose({ ...proposal(), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor);
  await expect(store.saveSecrets({ token: { value: "s", destinations: ["https://example.invalid"] } })).rejects.toThrow("INVALID_REQUEST");
  await fs.writeFile(path.join(root, "voice-tools-secrets.json"), JSON.stringify({ token: "s" }), { mode: 0o600 });
  expect((await new VoiceToolsStore(root).view()).servers.music.title).toBe("Music");
});


test("restoring a previously signed approval or secret policy cannot undo revocation", async () => {
  const { store, root } = await setup(); await store.propose(proposal(), actor);
  await saveSecrets(store, { "music-token": "synthetic-voice-credential" }); await catalog(store);
  await store.operatorChange("music", (await server(store)).digest, "approve");
  const approved = await fs.readFile(store.file);
  const secretFile = path.join(root, "voice-tools-secrets.json"), granted = await fs.readFile(secretFile);
  await store.operatorChange("music", (await server(store)).digest, "disable");
  await fs.writeFile(store.file, approved);
  expect((await server(new VoiceToolsStore(root))).state).toBe("pending");
  await store.saveSecrets({ "music-token": { destinations: ["https://other.example.test"] } });
  await fs.writeFile(secretFile, granted);
  const fresh = new VoiceToolsStore(root);
  await expect(fresh.probeInput("music", (await server(fresh)).digest)).rejects.toThrow("SECRET_DESTINATION");
});

test("a signed temporary approval copied before a refused commit grants no authority", async () => {
  const { store, root } = await setup();
  await store.propose({ ...proposal(), transport: { type: "http", url: "https://example.invalid/mcp" } }, actor); await catalog(store);
  const sync = await import("node:fs");
  let checks = 0, stolen = "";
  await expect(store.operatorChange("music", (await server(store)).digest, "approve", {}, () => {
    if (++checks !== 3) return;
    const temp = sync.readdirSync(root).find(file => file.startsWith("voice-tools.json.") && file.endsWith(".tmp"));
    expect(temp).toBeDefined(); stolen = sync.readFileSync(path.join(root, temp!), "utf8");
    throw new Error("REVOKED");
  })).rejects.toThrow("REVOKED");
  expect(stolen.length).toBeGreaterThan(0);
  await fs.writeFile(store.file, stolen);
  expect((await server(new VoiceToolsStore(root))).approval).toBeNull();
});


test("legacy and signed vault loads preserve reference and count bounds", async () => {
  const { root } = await setup();
  for (const values of [
    { "invalid name": "synthetic-voice-credential" },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`secret${i}`, "synthetic-voice-credential"])),
    { "invalid name": { value: "synthetic-voice-credential", destinations: [] } },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`secret${i}`, { value: "synthetic-voice-credential", destinations: [] }])),
  ]) {
    await fs.writeFile(path.join(root, "voice-tools-secrets.json"), JSON.stringify(values), { mode: 0o600 });
    await expect(new VoiceToolsStore(root).view()).rejects.toThrow("REGISTRY_UNAVAILABLE");
  }
});
