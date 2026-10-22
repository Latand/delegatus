import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexMemoryHookArgs, installCodexMemoryHook } from "./hook";
import { codexOperatorQuestionPolicy } from "@/lib/agent/operatorQuestionPolicy";

// The native interpreter and a local model fixture: no login or external API.
test("native Codex scopes trusted memory to managed fresh/resumed launches and leaves personal launches alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-native-"));
  const home = path.join(root, "codex"); fs.mkdirSync(home);
  const tmp = path.join(root, "tmp"); fs.mkdirSync(tmp);
  let injections = 0;
  const contexts: boolean[] = [];
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = await request.json();
    if (input.delegatus_confirm) return Response.json({});
    injections++;
    return Response.json({ block: "Synthetic launch-only memory marker" });
  } });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.text();
    contexts.push(body.includes("Synthetic launch-only memory marker"));
    const output = { type: "message", id: "fixture-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "fixture-response" } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const catalog = path.join(root, "models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "memory-fixture", display_name: "Memory fixture", description: null, base_instructions: "Reply to the fixture.", supported_reasoning_levels: [],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0, availability_nux: null, upgrade: null,
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [], tool_mode: "direct", context_window: 32000, prefer_websockets: false,
  }] }));
  const config = ['model="memory-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`, 'web_search="disabled"',
    '[model_providers.fixture]', 'name="fixture"', `base_url="http://127.0.0.1:${provider.port}/v1"`, 'wire_api="responses"',
    'requires_openai_auth=false', 'supports_websockets=false', '[analytics]', 'enabled=false'].join("\n");
  fs.writeFileSync(path.join(home, "config.toml"), config);
  const nativeHooks = '{ "hooks" : { "UserPromptSubmit" : [] }, "personal" : "preserve bytes" }\n';
  fs.writeFileSync(path.join(home, "hooks.json"), nativeHooks);
  const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, HOME: root, CODEX_HOME: home, XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: tmp,
    LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${memory.port}`, LLV_SPAWN_CAPABILITY: "synthetic-capability" };
  const hook = installCodexMemoryHook(home, env)!;
  const questionPolicy = codexOperatorQuestionPolicy(home);
  const managedArgs = [...questionPolicy.args, ...codexMemoryHookArgs(hook, questionPolicy.config.hooks.state)];
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  async function run(managed: boolean, resume?: string, capability = "synthetic-capability") {
    const args = ["exec", ...(managed ? managedArgs : []), "--disable", "enable_request_compression", "--disable", "apps", "--disable", "plugins",
      "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", ...(resume ? ["resume", resume] : []), "Reply to the fixture."];
    const child = Bun.spawn([binary, ...args], { cwd: root, env: { ...env, LLV_SPAWN_CAPABILITY: capability }, stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [code, stdout, stderr] = await Promise.race([
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Native memory fixture timed out")), 15000); }),
      ]);
      expect(code, stderr).toBe(0);
      expect(stderr).not.toContain("unrecognized configuration");
      return stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "thread.started")?.thread_id as string;
    } finally { clearTimeout(timer); child.kill(); await child.exited; }
  }
  try {
    const thread = await run(true);
    expect(thread).toBeString();
    expect(injections).toBe(1); expect(contexts).toEqual([true]);
    await run(true, thread);
    expect(injections).toBe(2); expect(contexts.at(-1)).toBe(true);
    await run(true, undefined, "");
    expect(injections).toBe(2); expect(contexts.at(-1)).toBe(false);
    await run(false);
    expect(injections).toBe(2); expect(contexts.at(-1)).toBe(false);
    expect(fs.readFileSync(path.join(home, "hooks.json"), "utf8")).toBe(nativeHooks);
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe(config);
  } finally { memory.stop(true); provider.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
