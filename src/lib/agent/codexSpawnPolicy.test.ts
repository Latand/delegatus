import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { CODEX_SINGLE_AGENT_FEATURES, codexSubagentArgs, codexSubagentConfig, parseCodexFeatures, readCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";
import { reviewerCommand, prepareHeadlessPublication } from "./headless";
import { buildEphemeralCommand } from "./ephemeral";
import { prepareAgentPublicationSpec, resumeSpecForSession, freshSpecFor, withSpawnCapability, shellQuote } from "./cli";
import { sendShellCommandToPane } from "@/lib/tmux";
import type { AccountContext } from "@/lib/accounts/contracts";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";

test("every agent-spawning feature of the installed CLI is classified by the policy", () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  const installed = readCodexFeatures(binary);
  const agentFeatures = installed.filter((feature) => /agent|collab|fanout|guardian|memories|daemon/.test(feature.name));
  expect(agentFeatures.length).toBeGreaterThan(0);
  // The native parser proves every emitted flag is accepted, without a turn,
  // subscription credentials, tools, or a real sub-agent.
  const effective = spawnSync(binary, [...codexSubagentArgs(binary), "features", "list"], { encoding: "utf8", timeout: 10_000 });
  expect(effective.status).toBe(0);
  const actual = parseCodexFeatures(effective.stdout);
  expect(actual.map((feature) => feature.name)).toEqual(installed.map((feature) => feature.name));
  for (const feature of actual) {
    if (feature.stage !== "removed" && !CODEX_SINGLE_AGENT_FEATURES.has(feature.name)) expect(feature.enabled).toBe(false);
  }
});

test("unknown features default off regardless of their spelling or default", () => {
  const features = parseCodexFeatures("multi_agent stable true\nmulti_agent_v2 stable false\nfuture_worker stable true\nfuture_branch experimental false\nshell_tool stable true");
  const restore = setCodexFeatureReaderForTest(() => features);
  try {
    const args = codexSubagentArgs("fixture");
    expect(args).toContain("agents.enabled=false");
    expect(args).toContain('approvals_reviewer="user"');
    for (const name of ["multi_agent", "multi_agent_v2", "future_worker", "future_branch"]) {
      expect(args[args.indexOf(name) - 1]).toBe("--disable");
    }
    expect(args).not.toContain("shell_tool");
    expect(codexSubagentArgs("fixture", true)).toEqual(["-c", "agents.enabled=true"]);
  } finally { restore(); }
});

test("native CLI denial overrides legacy aliases in account and trusted project config", () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-alias-policy-test-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const project = path.join(root, "project");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(root, "tmp"));
  fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"),
    LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
  const hostile = "[features]\nmemory_tool=true\ntelepathy=true\nconnectors=true\ncollab=true\n";
  try {
    expect(spawnSync("git", ["init", project], { env }).status).toBe(0);
    for (const layer of ["account", "project"]) {
      fs.writeFileSync(path.join(codexHome, "config.toml"), layer === "account" ? hostile
        : `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
      fs.writeFileSync(path.join(project, ".codex", "config.toml"), layer === "project" ? hostile : "");
      const inventory = (args: string[]) => {
        const result = spawnSync(binary, [...args, "features", "list"], { env, cwd: project, encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(0);
        return parseCodexFeatures(result.stdout);
      };
      const before = inventory([]);
      const after = inventory(codexSubagentArgs(binary, false, env, true));
      const granted = inventory(codexSubagentArgs(binary, true, env, true));
      for (const name of ["memories", "chronicle", "apps", "multi_agent"]) {
        expect(before.find((feature) => feature.name === name)?.enabled).toBe(true);
        expect(after.find((feature) => feature.name === name)?.enabled).toBe(false);
        expect(granted.find((feature) => feature.name === name)?.enabled).toBe(true);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an explicit synchronous Guardian reviewer is overridden only for denied launches", async () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  for (const allowed of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reviewer-policy-test-"));
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(root, "tmp"));
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'approvals_reviewer="auto_review"\n[features]\nguardian_approval=false\nguardianv2=false\napps=false\nplugins=false\n[analytics]\nenabled=false\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"),
      LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    const child = spawn(binary, [...codexSubagentArgs(binary, allowed, env), "app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const pid = child.pid;
    const lines = createInterface({ input: child.stdout });
    let reaped = false;
    const done = new Promise<void>((resolve) => { child.once("close", () => { reaped = true; resolve(); }); });
    const timer = setTimeout(() => { if (!reaped && pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } } }, 10_000);
    child.stderr.resume();
    let observed = false;
    try {
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "policy-fixture", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
      for await (const line of lines) {
        const response = JSON.parse(line);
        if (response.id === 1) {
          expect(response.error).toBeUndefined();
          child.stdin.write(JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: false } }) + "\n");
        }
        if (response.id === 2) {
          expect(response.error).toBeUndefined();
          expect(response.result.config.approvals_reviewer).toBe(allowed ? "auto_review" : "user");
          observed = true;
          break;
        }
      }
      expect(observed).toBe(true);
    } finally {
      lines.close();
      child.stdin.end();
      if (!reaped && pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
      await done;
      clearTimeout(timer);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("native app-server threads deny hostile legacy aliases and never request a background memory agent", async () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-alias-test-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(root, "tmp"));
  const catalog = path.join(root, "models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "policy-fixture", display_name: "Policy fixture", description: null,
    base_instructions: "Return the synthetic fixture answer.", supported_reasoning_levels: [],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [], tool_mode: "direct", multi_agent_version: "v2", context_window: 32000, prefer_websockets: false,
  }] }));
  const subagentHeaders: Array<string | null> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.arrayBuffer();
    subagentHeaders.push(request.headers.get("x-openai-subagent"));
    const output = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "fixture-response" } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    'model="policy-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`,
    'approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"',
    "[model_providers.fixture]", 'name="fixture"', `base_url="http://127.0.0.1:${provider.port}/v1"`,
    'wire_api="responses"', "requires_openai_auth=false", "supports_websockets=false",
    "[features]", "memory_tool=true", "telepathy=true", "connectors=true", "plugins=false",
    "[analytics]", "enabled=false",
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"),
    LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
  const inventory = readCodexFeatures(binary, env);
  // The real host's process overrides, followed by its real thread builder.
  const args = ["-c", "agents.enabled=false", "-c", 'approvals_reviewer="user"',
    ...Object.entries(codexSubagentConfig(inventory, false)).flatMap(([name, enabled]) => ["-c", `features.${name}=${enabled}`]),
    "app-server", "--enable", "realtime_conversation"];
  const child = spawn(binary, args, { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const pid = child.pid;
  child.stderr.resume();
  let reaped = false;
  const done = new Promise<void>((resolve) => child.once("close", () => { reaped = true; resolve(); }));
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let complete!: () => void;
  const turnDone = new Promise<void>((resolve) => { complete = resolve; });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    if (response.method === "turn/completed") complete();
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error("Native policy fixture RPC failed"));
    else request.resolve(response.result);
  });
  const rpc = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const timer = setTimeout(() => { if (!reaped && pid) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } } }, 15_000);
  const run = async () => {
    await rpc("initialize", { clientInfo: { name: "policy-fixture", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const configRead = await rpc("config/read", { cwd: root, includeLayers: false });
    const config = headlessCodexThreadConfig(configRead, false, [], [], "stdio", inventory);
    const started = await rpc("thread/start", { cwd: root, config, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only" }) as { thread: { id: string } };
    const threadId = started.thread.id;
    const listed = await rpc("experimentalFeature/list", { threadId, limit: 200 }) as { data: Array<{ name: string; enabled: boolean }>; nextCursor: string | null };
    expect(listed.nextCursor).toBeNull();
    for (const name of ["memories", "chronicle", "apps"]) expect(listed.data.find((feature) => feature.name === name)?.enabled).toBe(false);
    await rpc("turn/start", { threadId, input: [{ type: "text", text: "Return fixture complete." }] });
    await turnDone;
    expect(subagentHeaders).toHaveLength(1);
    expect(subagentHeaders.every((header) => header === null)).toBe(true);
  };
  try {
    await Promise.race([run(), done.then(() => { throw new Error("Native policy fixture exited before verification completed"); })]);
  } finally {
    lines.close();
    child.stdin.end();
    if (!reaped && pid) { try { process.kill(pid, "SIGTERM"); } catch { /* exited */ } }
    await done;
    clearTimeout(timer);
    provider.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

test("feature discovery refuses empty, malformed, duplicate and failed inventories", () => {
  for (const text of ["", "multi_agent stable unknown", "multi_agent stable true\nunparsed row", "multi_agent stable true\nmulti_agent stable false"]) {
    expect(() => parseCodexFeatures(text)).toThrow("could not be enumerated safely");
  }
  expect(() => readCodexFeatures("missing-codex-policy-fixture")).toThrow("refuses this launch");
});

test("terminal launches use their own daemon when the interpreter supports it", () => {
  const restore = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true\ndaemon_auto_start stable true"));
  try {
    expect(codexSubagentArgs("fixture", false, process.env, true)).toContain("--no-daemon");
    expect(codexSubagentArgs("fixture", true, process.env, true)).toEqual(["--no-daemon", "-c", "agents.enabled=true"]);
  } finally { restore(); }
  const older = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true"));
  try {
    const args = codexSubagentArgs("fixture", false, process.env, true);
    expect(args).not.toContain("--no-daemon");
    expect(args).not.toContain("multi_agent_v2");
    expect(args).toContain("multi_agent");
  } finally { older(); }
});

test("host-namespace discovery keeps shim HOME and isolates config on the shared mount", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shim-policy-test-"));
  try {
    const binary = path.join(root, "fixture-cli");
    fs.writeFileSync(binary, '#!/bin/sh\n[ "$PWD" = "$HOME" ] || exit 1\n[ -d "$CODEX_HOME" ] || exit 2\ncase "$CODEX_HOME" in "$HOME"/.cache/delegatus/codex-feature-probes/*) ;; *) exit 3 ;; esac\nprintf "multi_agent stable true\\n"\n', { mode: 0o700 });
    expect(readCodexFeatures(binary, { ...process.env, HOME: root, LLV_DOCKER_NSENTER_SHIMS: "1" })).toEqual([{ name: "multi_agent", stage: "stable", enabled: true }]);
    expect(fs.readdirSync(path.join(root, ".cache", "delegatus", "codex-feature-probes"))).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const policy of ["old", "denied", "allowed", "headless", "ephemeral", "terminal-denied", "terminal-allowed", "resume-denied", "resume-allowed"] as const) {
  test.skipIf((policy.startsWith("terminal-") || policy.startsWith("resume-")) && spawnSync("tmux", ["-V"]).status !== 0)(`installed v2 router checks ${policy} with product launch arguments`, async () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  const prompt = "Return fixture complete.";
  // A synthetic model selects v2 just as the affected model catalog does.
  // The provider returns only a final message: no tool or agent is executed.
  const model = {
    slug: "policy-fixture", display_name: "Policy fixture", description: null,
    base_instructions: "Return the synthetic fixture answer.",
    supported_reasoning_levels: [], shell_type: "shell_command", visibility: "list",
    supported_in_api: true, priority: 0, availability_nux: null, upgrade: null,
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [],
    tool_mode: "direct", multi_agent_version: "v2", context_window: 32000, prefer_websockets: false,
  };
  const collaboration = ["followup_task", "interrupt_agent", "list_agents", "send_message", "spawn_agent", "wait_agent"];

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-router-policy-test-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(root, "tmp"));
  const catalog = path.join(root, "models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [model] }));
  const tools = new Set<string>();
  let requests = 0;
  const collectNames = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("name" in value && typeof value.name === "string") tools.add(value.name);
    for (const nested of Object.values(value)) collectNames(nested);
  };
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let bytes = Buffer.from(await request.arrayBuffer());
    if (request.headers.get("content-encoding") === "gzip") bytes = zlib.gunzipSync(bytes);
    const body = JSON.parse(bytes.toString()) as { tools?: unknown };
    collectNames(body.tools);
    requests += 1;
    const output = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "fixture-response" } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'model="policy-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`,
      'approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"',
      "[model_providers.fixture]", 'name="fixture"', `base_url="http://127.0.0.1:${provider.port}/v1"`,
      'wire_api="responses"', "requires_openai_auth=false", "supports_websockets=false",
      `[projects.${JSON.stringify(root)}]`, 'trust_level="trusted"',
      "[agents]", "enabled=true", '[features.multi_agent_v2]', "enabled=true",
      "[features]", "apps=false", "plugins=false", "[analytics]", "enabled=false",
    ].join("\n"));
    // No inherited credentials or account configuration can reach this child.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"),
      LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    };
    const args = policy === "old" ? ["--disable", "multi_agent"] : codexSubagentArgs(binary, policy === "allowed", env);
    // The fixture has no real credentials, and returns no tool calls.
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [model] }));
    let command = binary;
    let argv = [...args, "exec", "--skip-git-repo-check", "-C", root, "--json", "Return fixture complete."];
    const providerArgs = ["-c", 'model_provider="fixture"', "-c", `model_catalog_json=${JSON.stringify(catalog)}`,
      "-c", `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`];
    // Supply only provider plumbing alongside the builder's existing -c flags;
    // keep every permission/publication argument from the product unchanged.
    let childEnv = env;
    let stdin: string | null = null;
    let terminalCommand: string | null = null;
    const previous = { ...process.env };
    try {
      Object.assign(process.env, env, { LLV_CODEX_BINARY: binary, LLV_CODEX_HOME: codexHome });
      if (policy === "headless") {
        const built = await prepareHeadlessPublication(reviewerCommand({ engine: "codex", model: model.slug, effort: "high" },
          "Return fixture complete.", path.join(root, "answer.txt"), root, { home: codexHome, managed: true }, undefined, undefined,
          { sandbox: "read-only" }), root);
        command = built.command; argv = [...built.args, ...providerArgs]; childEnv = built.env; stdin = built.stdin;
      } else if (policy === "ephemeral") {
        const built = buildEphemeralCommand({ key: "fixture", engine: "codex", model: model.slug, effort: "high",
          account: { engine: "codex", accountId: "fixture", kind: "managed", home: codexHome, transcriptRoot: codexHome, env } as AccountContext,
          prompt, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
          runDir: root, hardCapMs: 60000 });
        // Exercise the exact product argv with a hostile v2 catalog too. The
        // answer catalog normally strips v2, which must not mask policy loss.
        fs.writeFileSync(path.join(root, "catalog.json"), JSON.stringify({ models: [model] }));
        command = built.command; argv = [...built.args, ...providerArgs]; childEnv = built.env; stdin = built.stdin;
      } else if (policy.startsWith("resume-")) {
        // Seed the recorded v2 selection without creating any native agents.
        const seed = spawn(binary, ["exec", "--skip-git-repo-check", "--json", "Return fixture complete."],
          { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let output = ""; seed.stdout.on("data", (bytes) => { output += bytes; }); seed.stderr.resume();
        const seedPid = seed.pid;
        const seedTimer = setTimeout(() => { if (seedPid) { try { process.kill(seedPid, "SIGKILL"); } catch { /* exited */ } } }, 10000);
        let seedCode: number | null;
        try { seedCode = await new Promise<number | null>((resolve, reject) => { seed.once("close", resolve); seed.once("error", reject); }); }
        finally { clearTimeout(seedTimer); }
        expect(seedCode).toBe(0);
        const threadId = output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.type === "thread.started")?.thread_id;
        expect(typeof threadId).toBe("string");
        const rollout = fs.readdirSync(path.join(codexHome, "sessions"), { recursive: true })
          .find((file) => String(file).endsWith(`${threadId}.jsonl`));
        expect(rollout).toBeDefined();
        const records = fs.readFileSync(path.join(codexHome, "sessions", String(rollout)), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        expect(records.some((row) => row.payload?.multi_agent_version === "v2")).toBe(true);
        for (const name of collaboration) expect(tools.has(name)).toBe(true);
        tools.clear(); requests = 0;
        const spec = resumeSpecForSession("codex", threadId, root, codexHome,
          { allowSubagents: policy === "resume-allowed", model: model.slug, effort: "high", permissionMode: "never", readOnly: true });
        expect(spec).not.toBeNull();
        const prepared = await prepareAgentPublicationSpec(spec!);
        terminalCommand = withSpawnCapability({ ...prepared, command: prepared.command.replace(/ \)$/, ` ${shellQuote(prompt)} )`) }, "c".repeat(43), env).command;
      } else if (policy.startsWith("terminal-")) {
        const spec = freshSpecFor("codex", root, { allowSubagents: policy === "terminal-allowed",
          model: model.slug, effort: "high", codexHome });
        const prepared = await prepareAgentPublicationSpec(spec);
        terminalCommand = withSpawnCapability({ ...prepared, command: prepared.command.replace(/ \)$/, ` ${shellQuote(prompt)} )`) }, "c".repeat(43), env).command;
      }
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
    }
    if (terminalCommand !== null) {
      // Keep the Unix socket below its path limit in nested gate sandboxes.
      const socketRoot = fs.mkdtempSync("/tmp/llv-codex-tmux-");
      const socket = path.join(socketRoot, "socket");
      const ready = path.join(root, "shell-ready");
      const rc = path.join(root, "bashrc");
      fs.writeFileSync(rc, `HISTFILE=/dev/null\nPS1='fixture> '\nPROMPT_COMMAND='sleep 0.05; touch ${shellQuote(ready)}'\n`);
      const run = async (args: string[]) => {
        const result = spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, encoding: "utf8" });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 500; i++) { if (predicate()) return; await Bun.sleep(20); }
        throw new Error(`installed CLI did not reach the stub provider through the tmux pane: ${(await run(["capture-pane", "-p", "-t", "fixture:0.0"])).stdout.slice(-1500).replaceAll(root, "<sandbox>")}`);
      };
      let serverPid: number | undefined;
      try {
        expect((await run(["new-session", "-d", "-x", "120", "-y", "40", "-s", "fixture",
          `bash --noprofile --rcfile ${shellQuote(rc)} -i`])).code).toBe(0);
        serverPid = Number((await run(["display-message", "-p", "#{pid}"])).stdout.trim());
        await waitFor(() => fs.existsSync(ready));
        await Bun.sleep(30);
        await sendShellCommandToPane("fixture:0.0", root, terminalCommand, run);
        await waitFor(() => requests > 0);
        const allowed = policy.endsWith("allowed");
        for (const name of collaboration) expect(tools.has(name)).toBe(allowed);
        expect(tools.has("exec_command")).toBe(true);
      } finally {
        // Reap the pane's CLI before stopping this one recorded tmux server.
        if (serverPid) {
          await run(["send-keys", "-t", "fixture:0.0", "C-c"]);
          await Bun.sleep(100);
          await run(["send-keys", "-t", "fixture:0.0", "C-d"]);
          await Bun.sleep(100);
          try { process.kill(serverPid, "SIGTERM"); } catch { /* private server exited */ }
        }
        fs.rmSync(socketRoot, { recursive: true, force: true });
      }
      return;
    }
    const child = spawn(command, argv, { cwd: root, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let terminalOutput = "";
    child.stdout.on("data", (bytes: Buffer) => {
      terminalOutput = (terminalOutput + bytes.toString()).slice(-4000);
      if (bytes.toString().includes("\x1b[6n")) child.stdin.write("\x1b[1;1R");
    });
    child.stdin.end(stdin ?? undefined);
    let diagnostic = "";
    child.stderr.on("data", (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-2000); });
    const pid = child.pid;
    let reaped = false;
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => { reaped = true; resolve(code); });
    });
    const timer = setTimeout(() => { if (!reaped && pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } } }, 10_000);
    try {
      const code = await completed;
      if (code !== 0) throw new Error(`Codex ${policy} policy fixture exited ${code}: ${(diagnostic + terminalOutput).replaceAll(root, "<sandbox>")}`);
      expect(code).toBe(0);
      expect(requests).toBeGreaterThan(0);
      expect(requests).toBe(1);
      const allowed = ["old", "allowed"].includes(policy);
      for (const name of collaboration) expect(tools.has(name)).toBe(allowed);
      if (policy !== "ephemeral") expect(tools.has("exec_command")).toBe(true);
    } finally {
      clearTimeout(timer);
      if (!reaped && pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } await completed.catch(() => {}); }
    }
  } finally {
    provider.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
}
