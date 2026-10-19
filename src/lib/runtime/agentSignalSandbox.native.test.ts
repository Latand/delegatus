import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexAppServerHost } from "./codexAppServerHost";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { prepareCodexIntegrationTestHome } from "./integrationTestHome";
import { FileRuntimeEventStore } from "./eventStore";
import { materializeStructuredHostAccess, type StructuredHostAccessMaterialization } from "./structuredSpawn";
import type { EngineHost } from "./engineHost";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { launchDetached, reviewerCommand, headlessRuns, type BuiltHeadlessCommand } from "@/lib/agent/headless";
import { headlessFixtureTransport, setHeadlessSpawnForTests, signalDomain, spawnManagedEngine } from "./agentSignalSandbox";
import { CodexSocketTransport } from "./codexSocketTransport";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { AgentRegistry } from "@/lib/agent/registry";
import { adoptCodexRegistryHosts, bindCodexHostPersistence, codexHostColumns, detachCodexHostForViewerRestart, stopTerminalStructuredOrphan } from "./registry";
import type { AgentSignalDomain } from "./agentSignalSandbox";

async function proveHeadless(built: BuiltHeadlessCommand, root: string, marker: string): Promise<void> {
  const previous = headlessFixtureTransport();
  const key = `headless-signal-${crypto.randomUUID()}`;
  const stdout = path.join(root, "headless.stdout"), stderr = path.join(root, "headless.stderr");
  let resolve!: (code: number | null) => void;
  const ended = new Promise<number | null>(done => { resolve = done; });
  try {
    setHeadlessSpawnForTests(null);
    expect(launchDetached({ key, built, cwd: root, stdoutPath: stdout, stderrPath: stderr, timeoutMs: 30_000, onExit: run => resolve(run.exit!.code) })).not.toBeNull();
    const code = await Promise.race([ended, Bun.sleep(35_000).then(() => { throw new Error("headless signal fixture did not exit"); })]);
    expect(code, fs.readFileSync(stderr, "utf8")).toBe(0);
    expect(fs.existsSync(marker), fs.readFileSync(stdout, "utf8")).toBeTrue();
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ foreignRefused: true, ownStopped: true });
  } finally {
    setHeadlessSpawnForTests(previous);
    const run = headlessRuns.get(key);
    if (run && !run.exit) { run.child.kill("SIGTERM"); await ended; }
    headlessRuns.delete(key);
  }
}

const enabled = process.env.LLV_SIGNAL_SANDBOX_NATIVE_TEST === "1";
const profiles: Array<"full" | "restricted" | "read-only"> = ["full", "restricted", "read-only"];
const source = String.raw`
import json,os,signal,subprocess,sys
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
assert os.readlink('/proc/self/ns/pid')!=context['hostPidNamespace']
try:
    os.kill(int(sys.argv[1]),signal.SIGTERM)
    raise AssertionError('foreign signal succeeded')
except ProcessLookupError: pass
child=subprocess.Popen(['/bin/sleep','30'],start_new_session=True)
os.kill(child.pid,signal.SIGTERM)
assert child.wait(timeout=3)==-signal.SIGTERM
env=dict(os.environ,LLV_GATE_LOCK_DIR=os.path.dirname(sys.argv[2])+'/slots',LLV_GATE_SLOTS='1',DELEGATUS_CPU_PRESSURE='off',LLV_GATE_MEM='64M')
gate=subprocess.run(['bash',sys.argv[3],'/bin/echo','native-gate'],env=env,capture_output=True,text=True,timeout=10)
assert gate.returncode==0,gate.stderr
assert gate.stdout.strip()=='native-gate'
open(sys.argv[2],'w').write(json.dumps({'foreignRefused':True,'ownStopped':True,'namespace':context['pidNamespace']}))
print('native proof complete')
`;

async function prove(host: EngineHost, marker: string, trigger: () => Promise<unknown>, waitForTurn = false): Promise<void> {
  const state = await host.health();
  expect(state.signalDomain?.native.pid).toBe(state.pid!);
  let failure: Error | undefined;
  let turnEnded = false;
  const trace: string[] = [];
  const reader = host.attach(state.eventCursor)[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const next = await reader.next();
      if (next.done) return;
      trace.push(JSON.stringify(next.value).slice(0, 1000));
      if (next.value.kind === "attention") await host.answer(next.value.id, { behavior: "allow" });
      if (next.value.kind === "turn-ended") { turnEnded = true; return; }
    }
  })().catch(error => { failure = error; });
  try {
    await trigger();
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(marker) && !failure && !turnEnded && Date.now() < deadline) await Bun.sleep(25);
    if (failure) throw failure;
    expect(fs.existsSync(marker), trace.slice(-8).join("\n") + String((host as unknown as { stderrTail?: string }).stderrTail ?? "")).toBeTrue();
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ foreignRefused: true, ownStopped: true });
    if (waitForTurn) await Promise.race([pump, Bun.sleep(10_000).then(() => { throw new Error("native fixture did not finish its turn"); })]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${trace.slice(-8).join("\n")}\n${String((host as unknown as { stderrTail?: string }).stderrTail ?? "")}`, { cause: error });
  } finally {
    await host.release();
    await pump;
  }
}

test.skipIf(!enabled || !process.env.LLV_CODEX_BINARY).each(profiles)("real structured Codex signal domain, fresh and resumed: %s", async profile => {
  const binary = process.env.LLV_CODEX_BINARY!;
  const home = prepareCodexIntegrationTestHome(binary);
  if (!home) throw new Error("native signal test requires an isolated Codex subscription credential");
  const foreign = spawn("/bin/sleep", ["90"], { stdio: "ignore" });
  const identity = captureProcessIdentity(foreign.pid!);
  const script = path.join(home.directory, "proof.py"); fs.writeFileSync(script, source);
  let access: StructuredHostAccessMaterialization | null = null;
  let host: CodexAppServerHost | null = null;
  try {
    let session: string | undefined;
    for (const resumed of [false, true]) {
      access = materializeStructuredHostAccess(profile === "read-only" ? true : { readOnly: false, sandbox: profile === "restricted" ? "restricted" : "full" }, home.env, null, home.directory);
      const options = { binary, cwd: home.directory, codexHome: home.codexHome, env: access.env,
        ...access.codex, ...access.host, mcpServers: [], fileAuthCredentials: true, approvalPolicy: "never", eventStore: new FileRuntimeEventStore(path.join(home.directory, "events")) };
      host = resumed ? await CodexAppServerHost.adopt(session!, options) : await CodexAppServerHost.start(options);
      session = host.identity.threadId;
      const marker = path.join(access.env.TMPDIR ?? home.directory, `codex-${resumed}.json`);
      const current = host;
      await prove(current, marker, async () => {
        const rpc = (current as unknown as { rpc(method: string, params: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> }).rpc.bind(current);
        const result = await rpc("command/exec", { command: ["python3", script, String(foreign.pid), marker, path.resolve("scripts/gate-slot.sh")],
          ...(access!.codex.permissionProfile ? { permissionProfile: access!.codex.permissionProfile }
            : { sandboxPolicy: profile === "full" ? { type: "dangerFullAccess" } : { type: "workspaceWrite", writableRoots: [home.directory] } }), timeoutMs: 10_000 });
        expect(result.exitCode, result.stderr).toBe(0);
        await rpc("thread/name/set", { threadId: current.identity.threadId, name: "Signal sandbox native fixture" });
      });
      host = null;
      expect(processIdentityStatus(identity)).toBe("alive");
    }
    if (profile === "full") {
      const marker = path.join(home.directory, "codex-headless.json");
      const command = "python3 " + [script, String(foreign.pid), marker, path.resolve("scripts/gate-slot.sh")].map(word => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
      let requests = 0;
      const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        await request.json();
        const output = ++requests === 1
          ? { type: "function_call", id: "call-proof", call_id: "call-proof", name: "exec_command", arguments: JSON.stringify({ cmd: command, login: false }) }
          : { type: "message", id: "fixture-final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
        const events = [{ type: "response.created", response: { id: `fixture-${requests}` } },
          { type: "response.output_item.done", output_index: 0, item: output },
          { type: "response.completed", response: { id: `fixture-${requests}`, status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
      try {
        const catalog = path.join(home.directory, "models.json");
        fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: "signal-fixture", display_name: "Signal fixture", description: null,
          base_instructions: "Run the synthetic command.", supported_reasoning_levels: [], shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
          availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
          experimental_supported_tools: [], tool_mode: "direct", context_window: 32000, prefer_websockets: false }] }));
        const restoreFeatures = setCodexFeatureReaderForTest(undefined);
        let built: BuiltHeadlessCommand;
        try { built = reviewerCommand({ engine: "codex", model: "signal-fixture", effort: null }, "Run the fixture.", path.join(home.directory, "final.txt"), home.directory, { home: home.codexHome, managed: true }); }
        finally { restoreFeatures(); }
        built.command = binary;
        built.env = { ...home.env, TMPDIR: home.directory };
        for (const setting of ['model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`, 'web_search="disabled"',
          `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${api.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
          "features.enable_request_compression=false", "features.apps=false", "features.plugins=false"]) built.args.push("-c", setting);
        await proveHeadless(built, home.directory, marker);
        expect(requests).toBe(2);
        expect(processIdentityStatus(identity)).toBe("alive");
      } finally { api.stop(true); }
    }
  } finally {
    await host?.release(); foreign.kill("SIGKILL");
    await new Promise<void>(resolve => foreign.exitCode !== null || foreign.signalCode !== null ? resolve() : foreign.once("close", () => resolve()));
    access?.cleanup(); home.cleanup();
  }
}, 90_000);

test.skipIf(!enabled)("a missing sandbox dependency stays explicit over the persistent socket launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socket-preflight-"));
  const tools = path.join(root, "tools"); fs.mkdirSync(tools);
  fs.symlinkSync(fs.realpathSync(Bun.which("python3")!), path.join(tools, "python3"));
  const env = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"),
    LLV_STATE_DIR: path.join(root, "state"), PATH: tools, LLV_GATE_SLOT_LEASE: undefined };
  try {
    await expect(CodexSocketTransport.launch("/bin/sleep", ["60"], { env, detached: true }, undefined,
      (command, args, options, base) => spawnManagedEngine(command, args, options, null, undefined, env, base)))
      .rejects.toThrow("required host dependency is missing: bwrap");
    expect(fs.readdirSync(root)).toEqual(["tools"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!enabled)("a failed protected socket listener start reaps its monitor and namespace", async () => {
  let domain: AgentSignalDomain | undefined;
  const env = { ...process.env, LLV_GATE_SLOT_LEASE: undefined };
  try {
    await expect(CodexSocketTransport.launch("/bin/sleep", ["60"], { env, detached: true }, undefined,
      async (_command, _args, options, base) => {
        const child = await spawnManagedEngine("/bin/sleep", ["60"], options, null, undefined, env, base);
        domain = signalDomain(child);
        return child;
      })).rejects.toThrow("listener did not start");
    expect(domain).toBeDefined();
    for (const record of [domain!.monitor, domain!.bubblewrap, domain!.init, domain!.native]) expect(processIdentityStatus(record)).toBe("dead");
  } finally {
    if (domain && processIdentityStatus(domain.init) === "alive") process.kill(domain.init.pid, "SIGKILL");
  }
}, 20_000);

test.skipIf(!enabled || !process.env.LLV_CODEX_BINARY)("real Codex socket adoption retains the living signal domain and its cleanup authority", async () => {
  const binary = process.env.LLV_CODEX_BINARY!;
  const home = prepareCodexIntegrationTestHome(binary);
  if (!home) throw new Error("native signal test requires an isolated Codex subscription credential");
  const registry = new AgentRegistry(path.join(home.directory, "registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: path.join(home.directory, "registry.sqlite") });
  const foreign = spawn("/bin/sleep", ["90"], { stdio: "ignore" });
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  let host: CodexAppServerHost | undefined;
  let domain: AgentSignalDomain | undefined;
  try {
    const options = { binary, cwd: home.directory, codexHome: home.codexHome, env: home.env,
      mcpServers: [], fileAuthCredentials: true, approvalPolicy: "never" as const,
      eventStore: new FileRuntimeEventStore(path.join(home.directory, "events")) };
    host = await CodexAppServerHost.start(options);
    await (host as unknown as { rpc(method: string, params: unknown): Promise<unknown> }).rpc("thread/name/set", {
      threadId: host.identity.threadId, name: "Signal socket adoption fixture" });
    const state = await host.health();
    domain = state.signalDomain!;
    expect(state.endpoint).toStartWith("codex-unix:");
    expect(domain.native.pid).toBe(state.pid!);
    const key = { engine: "codex" as const, sessionId: host.identity.threadId };
    registry.upsert({ key, artifactPath: path.join(home.directory, "session.jsonl"), cwd: home.directory,
      accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
      structuredHost: codexHostColumns(state, 0) });
    const writer = captureProcessIdentity(process.pid);
    expect(registry.claimStructuredHost(key, writer, { allowUnhosted: true })).toBeNull();
    expect(registry.claimStructuredHost(key, writer, { reconnectCodex: { endpoint: state.endpoint,
      process: { ...domain.native, startIdentity: "replacement" } } })).toBeNull();
    const claim = registry.claimStructuredHost(key, writer, { reconnectCodex: { endpoint: state.endpoint, process: domain.native } })!;
    expect(claim.claimOwner).toBeTruthy();
    await bindCodexHostPersistence(registry, key, host, claim.claimOwner!, claim.claimEpoch);
    expect(await detachCodexHostForViewerRestart(registry, key, host)).toBeTrue();
    const adopted = await adoptCodexRegistryHosts(registry, () => options, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" }, () => true, undefined, { admit: () => null });
    expect(adopted).toHaveLength(1);
    host = adopted[0]!.host;
    expect((await host.health()).signalDomain).toEqual(domain);
    expect((await host.health()).pid).toBe(domain.native.pid);
    const script = path.join(home.directory, "proof.py"), marker = path.join(home.directory, "reconnected-proof.json");
    fs.writeFileSync(script, source);
    const current = host;
    await prove(current, marker, async () => {
      const result = await (current as unknown as { rpc(method: string, params: unknown): Promise<{ exitCode: number; stderr: string }> }).rpc("command/exec", {
        command: ["python3", script, String(foreign.pid), marker, path.resolve("scripts/gate-slot.sh")], sandboxPolicy: { type: "dangerFullAccess" }, timeoutMs: 10_000 });
      expect(result.exitCode, result.stderr).toBe(0);
    });
    const entry = registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
    registry.upsert({ ...entry, claimOwner: null, status: "dead" });
    const stopped = await stopTerminalStructuredOrphan(registry, key, { graceMs: 100, deadlineMs: 3_000 });
    expect(stopped, JSON.stringify({ statuses: [domain.monitor, domain.bubblewrap, domain.init, domain.native].map(record => processIdentityStatus(record)),
      row: registry.readOnlySnapshot().entries[`codex:${key.sessionId}`] })).toBeTrue();
    for (const record of [domain.monitor, domain.bubblewrap, domain.init, domain.native]) expect(processIdentityStatus(record)).toBe("dead");
    expect(registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!.structuredHost!.signalDomain?.retired).toBeTrue();
    expect(processIdentityStatus(foreignIdentity)).toBe("alive");
  } finally {
    await host?.release();
    if (domain && processIdentityStatus(domain.init) === "alive") process.kill(domain.init.pid, "SIGKILL");
    if (domain) {
      const records = [domain.monitor, domain.bubblewrap, domain.init, domain.native];
      const deadline = Date.now() + 5_000;
      while (records.some(record => processIdentityStatus(record) !== "dead") && Date.now() < deadline) await Bun.sleep(10);
      for (const record of records) expect(processIdentityStatus(record)).toBe("dead");
    }
    foreign.kill("SIGKILL");
    await new Promise<void>(resolve => foreign.exitCode !== null || foreign.signalCode !== null ? resolve() : foreign.once("close", () => resolve()));
    registry.close(); home.cleanup();
  }
}, 60_000);

test.skipIf(!enabled || !process.env.LLV_CLAUDE_BINARY).each(profiles)("real structured Claude signal domain with loopback provider, fresh and resumed: %s", async profile => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-signal-native-"));
  const config = path.join(root, ".claude"); fs.mkdirSync(config);
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  const script = path.join(root, "proof.py"); fs.writeFileSync(script, source);
  const foreign = spawn("/bin/sleep", ["90"], { stdio: "ignore" });
  const identity = captureProcessIdentity(foreign.pid!);
  let marker = "", requests = 0, offerTool = true;
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 10 });
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/messages")) return Response.json({}, { status: 404 });
    const body = await request.json();
    if (!body.stream) return Response.json({ id: "msg_classifier_fixture", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "<block>no</block>" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
    const tool = offerTool;
    offerTool = false;
    const content = tool ? { type: "tool_use", id: `tool_fixture_${++requests}`, name: "Bash", input: {
      command: "python3 " + [script, String(foreign.pid), marker, path.resolve("scripts/gate-slot.sh")].map(word => `'${word.replaceAll("'", "'\\''")}'`).join(" "), description: "Run owned signal fixture",
    } } : { type: "text", text: "Fixture complete" };
    const message = { id: `msg_fixture_${++requests}`, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    return new Response([
      event("message_start", { type: "message_start", message }),
      event("content_block_start", { type: "content_block_start", index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify((content as { input: unknown }).input) } : { type: "text_delta", text: "Fixture complete" } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      event("message_stop", { type: "message_stop" }),
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const token = "local-signal-fixture";
  const provider = { baseUrl: `http://127.0.0.1:${api.port}`, model: "fixture-model", smallFastModel: null };
  fs.writeFileSync(path.join(config, ".provider-token"), token, { mode: 0o600 });
  fs.writeFileSync(path.join(config, ".provider-runtime"), JSON.stringify({ config: provider, token, headers: {} }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    ANTHROPIC_BASE_URL: provider.baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: provider.model };
  const options = { binary: process.env.LLV_CLAUDE_BINARY!, cwd: root, env, claudeConfigDir: config,
    claudeProjectsDir: path.join(config, "projects"), providerAccount: true, model: provider.model,
    readOnly: profile === "read-only", restricted: profile === "restricted", permissionMode: profile === "read-only" ? "plan" : profile === "restricted" ? "auto" : "bypassPermissions",
    tools: ["Bash"], mcpServers: [], eventStore: new FileRuntimeEventStore(path.join(root, "events")), deliveryLedger: new FileClaudeDeliveryLedger(path.join(root, "deliveries")), requestTimeoutMs: 30_000 };
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    let session: string | undefined;
    for (const resumed of [false, true]) {
      host = resumed ? await ClaudeStreamBrokerHost.adopt(session!, options) : await ClaudeStreamBrokerHost.start(options);
      session = host.identity.sessionId;
      marker = path.join(root, `claude-${resumed}.json`);
      offerTool = true;
      const current = host;
      await prove(current, marker, () => current.send({ id: `proof-${resumed}`, text: "Run the signal-proof fixture using Bash." }), true);
      host = null;
      expect(processIdentityStatus(identity)).toBe("alive");
    }
    if (profile === "full") {
      marker = path.join(root, "claude-headless.json"); offerTool = true;
      const built = reviewerCommand({ engine: "claude", model: provider.model, effort: null }, "Run the signal-proof fixture using Bash.", path.join(root, "final.txt"), root,
        null, { home: config, projectsDir: path.join(config, "projects"), managed: false });
      built.command = process.env.LLV_CLAUDE_BINARY!;
      built.env = { ...env, CLAUDE_CONFIG_DIR: config };
      built.args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--setting-sources", "");
      await proveHeadless(built, root, marker);
      expect(processIdentityStatus(identity)).toBe("alive");
    }
  } finally {
    await host?.release(); api.stop(true); foreign.kill("SIGKILL");
    await new Promise<void>(resolve => foreign.exitCode !== null || foreign.signalCode !== null ? resolve() : foreign.once("close", () => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
