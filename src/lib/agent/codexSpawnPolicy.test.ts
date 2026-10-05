import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { CODEX_SINGLE_AGENT_FEATURES, codexDeniedFeatures, codexSubagentArgs, parseCodexFeatures, readCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";

test("every agent-spawning feature of the installed CLI is classified by the policy", () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  const installed = readCodexFeatures(binary);
  const denied = codexDeniedFeatures(installed);
  const agentFeatures = installed.filter((feature) => /agent|collab|fanout|guardian|memories|daemon/.test(feature.name));
  expect(agentFeatures.length).toBeGreaterThan(0);
  for (const feature of agentFeatures) {
    expect(denied.includes(feature.name) || feature.stage === "removed" || CODEX_SINGLE_AGENT_FEATURES.has(feature.name)).toBe(true);
  }
  // The native parser proves every emitted flag is accepted, without a turn,
  // subscription credentials, tools, or a real sub-agent.
  const effective = spawnSync(binary, [...codexSubagentArgs(binary), "features", "list"], { encoding: "utf8", timeout: 10_000 });
  expect(effective.status).toBe(0);
  for (const feature of parseCodexFeatures(effective.stdout)) {
    if (denied.includes(feature.name)) expect(feature.enabled).toBe(false);
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

test("the installed v2 tool router exposes collaboration under the old policy, closes it when denied, and preserves a grant", async () => {
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  // A synthetic model selects v2 just as the affected model catalog does.
  // The provider returns only a final message: no tool or agent is executed.
  const model = {
    slug: "policy-fixture", display_name: "Policy fixture", description: null,
    base_instructions: "Return the synthetic fixture answer.",
    supported_reasoning_levels: [], shell_type: "shell_command", visibility: "list",
    supported_in_api: true, priority: 0, availability_nux: null, upgrade: null,
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [],
    tool_mode: "direct", multi_agent_version: "v2", context_window: 32000,
  };
  const collaboration = ["followup_task", "interrupt_agent", "list_agents", "send_message", "spawn_agent", "wait_agent"];
  for (const policy of ["old", "denied", "allowed"] as const) {
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
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'model="policy-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`,
      'approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"',
      "[model_providers.fixture]", 'name="fixture"', `base_url="http://127.0.0.1:${provider.port}/v1"`,
      'wire_api="responses"', "requires_openai_auth=false", "supports_websockets=false",
      "[features]", "apps=false", "plugins=false", "[analytics]", "enabled=false",
    ].join("\n"));
    // No inherited credentials or account configuration can reach this child.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"),
      LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    const args = policy === "old" ? ["--disable", "multi_agent"] : codexSubagentArgs(binary, policy === "allowed", env);
    const child = spawn(binary, [...args, "exec", "--skip-git-repo-check", "-C", root, "--json", "Return fixture complete."], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
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
      if (code !== 0) throw new Error(`Codex policy fixture exited ${code}: ${diagnostic.replaceAll(root, "<sandbox>")}`);
      expect(code).toBe(0);
      expect(requests).toBe(1);
      for (const name of collaboration) expect(tools.has(name)).toBe(policy !== "denied");
      expect(tools.has("exec_command")).toBe(true);
    } finally {
      clearTimeout(timer);
      if (!reaped && pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } await completed.catch(() => {}); }
      provider.stop(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);
