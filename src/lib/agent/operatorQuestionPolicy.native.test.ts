import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexProcessCleanupArgs } from "./processCleanupPolicy";

const binary = process.env.LLV_CODEX_BINARY ?? "codex";
test("native Codex denies async seat questions and preserves worker questions", async () => {
  const { codexOperatorQuestionPolicy } = await import("./operatorQuestionPolicy");
  for (const seat of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-question-native-"));
    const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(root, "tmp"));
    let requests = 0;
    const inputs: string[] = [];
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { input: Array<{ type: string; output?: string }> };
      inputs.push(...body.input.filter(item => item.type === "function_call_output").map(item => item.output ?? ""));
      requests++;
      const output = requests === 1
        ? { type: "function_call", id: "question-call", call_id: "question-call", name: "request_user_input_async",
          arguments: JSON.stringify({ questions: [{ title: "Proceed with the fixture?", options: ["Proceed", "Hold"] }] }) }
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
      slug: "question-fixture", display_name: "Question fixture", description: null,
      base_instructions: "Run the synthetic question.", supported_reasoning_levels: [],
      shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
      availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
      apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: ["request_user_input_async"], tool_mode: "direct", context_window: 32000, prefer_websockets: false,
    }] }));
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'model="question-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`,
      'web_search="disabled"', "[model_providers.fixture]", 'name="fixture"',
      `base_url="http://127.0.0.1:${provider.port}/v1"`, 'wire_api="responses"',
      "requires_openai_auth=false", "supports_websockets=false", "[analytics]", "enabled=false",
    ].join("\n"));
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
      LLV_STATE_DIR: path.join(root, "state"), TMPDIR: path.join(root, "tmp"), CLAUDE_CODE_TMPDIR: path.join(root, "tmp"),
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    const args = codexProcessCleanupArgs(codexHome);
    if (seat) args.push(...codexOperatorQuestionPolicy(codexHome).args);
    const child = Bun.spawn([binary, "exec", ...args,
      "--disable", "enable_request_compression", "--disable", "apps", "--disable", "plugins",
      "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "Run the fixture."],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const [code, , stderr] = await Promise.race([finished, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Native question fixture timed out")), 15_000);
      })]);
      expect(code, stderr).toBe(0);
      expect(requests).toBe(2);
      if (seat) expect(inputs.join("\n")).toContain("publish_prototype_review");
      else expect(inputs.join("\n")).toContain('"accepted":true');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      await child.exited;
      provider.stop(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 40_000);
