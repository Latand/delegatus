import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexProcessCleanupArgs } from "./processCleanupPolicy";

// No account, credentials or external provider: the model is a port-0 fixture.
// Even a missing guard can execute only our harmless pattern-command stand-in.
test("native Codex refuses pattern cleanup and executes recorded-PID cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-native-"));
  const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
  const bin = path.join(root, "bin"), marker = path.join(root, "pattern-executed");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "tmp"));
  fs.writeFileSync(path.join(bin, "pkill"), '#!/bin/sh\nprintf executed > "$CLEANUP_MARKER"\n', { mode: 0o700 });
  const standIn = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  let requests = 0;
  const inputs: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { input: Array<{ type: string; output?: string }> };
    inputs.push(...body.input.filter(item => item.type === "function_call_output").map(item => item.output ?? ""));
    requests++;
    const command = requests === 1 ? "pkill fixture-server" : `kill ${standIn.pid}`;
    const output = requests <= 2
      ? { type: "function_call", id: `call-${requests}`, call_id: `call-${requests}`, name: "exec_command", arguments: JSON.stringify({ cmd: command, login: false }) }
      : { type: "message", id: "fixture-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: `response-${requests}` } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: `response-${requests}`, status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const catalog = path.join(root, "models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "cleanup-fixture", display_name: "Cleanup fixture", description: null,
    base_instructions: "Run the synthetic commands.", supported_reasoning_levels: [],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [], tool_mode: "direct", context_window: 32000, prefer_websockets: false,
  }] }));
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    'model="cleanup-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`,
    'web_search="disabled"', "[model_providers.fixture]", 'name="fixture"',
    `base_url="http://127.0.0.1:${provider.port}/v1"`, 'wire_api="responses"',
    "requires_openai_auth=false", "supports_websockets=false", "[analytics]", "enabled=false",
  ].join("\n"));
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    LLV_STATE_DIR: path.join(root, "state"), TMPDIR: path.join(root, "tmp"),
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", CLEANUP_MARKER: marker };
  const child = Bun.spawn([process.env.LLV_CODEX_BINARY ?? "codex", "exec", ...codexProcessCleanupArgs(codexHome),
    "--enable", "unified_exec", "--enable", "shell_tool", "--disable", "enable_request_compression", "--disable", "apps", "--disable", "plugins",
    "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "Run the fixture."],
  { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exitTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const [code, stdout, stderr] = await Promise.race([finished, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Native cleanup fixture timed out")), 15_000);
    })]);
    expect(code, stderr).toBe(0);
    expect(requests).toBe(3);
    expect(inputs.join("\n")).toContain("PID-only");
    expect(inputs.at(-1)).not.toContain("PID-only");
    expect(stdout).not.toContain("unrecognized configuration");
    expect(fs.existsSync(marker)).toBe(false);
    await Promise.race([standIn.exited, new Promise<never>((_, reject) => {
      exitTimeout = setTimeout(() => reject(new Error(`Recorded-PID cleanup did not stop the fixture: ${inputs.at(-1)}`)), 1000);
    })]);
    expect(standIn.signalCode).toBe("SIGTERM");
  } finally {
    clearTimeout(timeout);
    clearTimeout(exitTimeout);
    child.kill(); await child.exited;
    standIn.kill(); await standIn.exited;
    provider.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
