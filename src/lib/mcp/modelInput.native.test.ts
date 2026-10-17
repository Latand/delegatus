import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { handleMcpHttpRequest, mcpHttpMethodNotAllowed, setMcpHttpDependenciesForTests } from "./http";
import { fixtureService, modelResultSamples } from "./modelInput.fixture";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

type ApiBody = { input?: Array<{ type?: string; output?: unknown }>; messages?: Array<{ content?: unknown }> };
function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(part => typeof part?.text === "string" ? [part.text as string] : []);
}
function toolResults(body: ApiBody, engine: string): unknown[] {
  if (engine === "codex") return (body.input ?? []).filter(item => item.type?.endsWith("tool_call_output") || item.type === "function_call_output").map(item => item.output);
  return (body.messages ?? []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part?.type === "tool_result") : []);
}
function sse(type: string, data: object) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }

// Native clients, local deterministic providers, no account or live Viewer.
// Opt in because these binaries are independent of the JS dependency graph.
for (const transport of ["stdio", "http"] as const) for (const engine of ["codex", "claude"] as const) {
  for (const index of [0, 3]) test.skipIf(process.env.LLV_MCP_MODEL_INPUT_TEST !== "1")(`${engine} ${transport} native model input contains sample ${index} once`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-model-input-"));
    const directories = ["home", "config", "cache", "tmp", "state", "codex", "claude"];
    for (const directory of directories) fs.mkdirSync(path.join(root, directory));
    const requests: ApiBody[] = [];
    let calls = 0;
    setMcpHttpDependenciesForTests({ service: async () => fixtureService(index), conversationForCapability: () => "conversation_fixture" });
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/api/mcp") {
        return request.method === "POST" ? handleMcpHttpRequest(new NextRequest(request)) : mcpHttpMethodNotAllowed();
      }
      const raw = new Uint8Array(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding");
      const bytes = encoding === "zstd" ? Bun.zstdDecompressSync(raw) : encoding === "gzip" ? Bun.gunzipSync(raw) : raw;
      let body: ApiBody;
      try { body = JSON.parse(new TextDecoder().decode(bytes)) as ApiBody; }
      catch { return Response.json({}); }
      if (!body.messages && !body.input) return Response.json({});
      requests.push(body);
      const n = ++calls;
      const first = !toolResults(body, engine).length;
      if (n > 2) return new Response("fixture received an unexpected extra model request", { status: 400 });
      if (engine === "codex") {
        const item = first
          ? { type: "custom_tool_call", id: "fc_fixture", call_id: "call_fixture", namespace: "functions", name: "exec", input: "text(await tools.mcp__viewer__list_tasks({}));" }
          : { type: "message", role: "assistant", id: "msg_fixture", content: [{ type: "output_text", text: "Probe complete." }] };
        return new Response(sse("response.created", { response: { id: `resp_${n}` } })
          + sse("response.output_item.done", { output_index: 0, item })
          + sse("response.completed", { response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
        { headers: { "content-type": "text/event-stream" } });
      }
      const block = first ? { type: "tool_use", id: "toolu_fixture", name: "mcp__viewer__list_tasks", input: {} } : { type: "text", text: "" };
      return new Response(sse("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        + sse("content_block_start", { index: 0, content_block: block })
        + sse("content_block_delta", { index: 0, delta: first ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: "Probe complete." } })
        + sse("content_block_stop", { index: 0 })
        + sse("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
        + sse("message_stop", {}), { headers: { "content-type": "text/event-stream" } });
    } });
    const env = {
      PATH: process.env.PATH!, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
      TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      CODEX_HOME: path.join(root, "codex"), LLV_CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), LLV_CLAUDE_HOME: path.join(root, "claude"),
      NODE_ENV: "test", LANG: "C.UTF-8", MCP_RESULT_SAMPLE: String(index), ANTHROPIC_BASE_URL: api.url.origin, ANTHROPIC_AUTH_TOKEN: "fixture-local",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    const fixture = path.join(import.meta.dir, "modelInput.fixture.ts");
    const mcp = { viewer: transport === "stdio" ? { command: process.execPath, args: [fixture], env }
      : { type: "http", url: `${api.url.origin}/api/mcp`, headers: { "x-llv-spawn-capability": "A".repeat(43) } } };
    const codexMcp = transport === "stdio"
      ? `command=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(fixture)}]\n[mcp_servers.viewer.env]\n${Object.entries(env).map(([key, value]) => key + "=" + JSON.stringify(value)).join("\n")}`
      : `url="${api.url.origin}/api/mcp"\n[mcp_servers.viewer.http_headers]\nx-llv-spawn-capability="${"A".repeat(43)}"`;
    fs.writeFileSync(path.join(root, "codex/config.toml"), `model="fixture-model"\nmodel_provider="fixture"\nweb_search="disabled"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="${api.url.origin}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[analytics]\nenabled=false\n[features]\napps=false\nplugins=false\n[mcp_servers.viewer]\n${codexMcp}\n`);
    fs.writeFileSync(path.join(root, "claude.json"), JSON.stringify({ mcpServers: mcp }));
    fs.writeFileSync(path.join(root, "claude/.claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    const prompt = "Call viewer list_tasks once, then finish.";
    const command = engine === "codex"
      ? [process.env.LLV_CODEX_BINARY ?? "codex", "exec", "--skip-git-repo-check", "--enable", "code_mode", "--enable", "code_mode_only", "--dangerously-bypass-approvals-and-sandbox", "--json", prompt]
      : [process.env.LLV_CLAUDE_BINARY ?? "claude", "-p", prompt, "--model", "fixture-model", "--mcp-config", path.join(root, "claude.json"), "--strict-mcp-config", "--allowedTools", "mcp__viewer__list_tasks", "--output-format", "stream-json", "--verbose", "--max-turns", "3"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = ownFixtureChild(Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" }));
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      expect(await child.exited).toBe(0);
      await stdout; await stderr;
      expect(calls).toBe(2);
      const results = toolResults(requests[1], engine);
      expect(results).toHaveLength(1);
      const expected = JSON.stringify(modelResultSamples[index]);
      if (engine === "codex") {
        const envelope = JSON.parse(textParts(results[0]).find(text => text.startsWith('{"content"'))!);
        expect(envelope).not.toHaveProperty("structuredContent");
        expect(envelope.content).toEqual([{ type: "text", text: expected }]);
        expect(envelope.isError === true).toBe(index === 3);
      } else {
        const result = results[0] as { content: unknown; is_error?: boolean };
        expect(textParts(result.content)).toEqual([expected]);
        expect(result.is_error === true).toBe(index === 3);
      }
      // Observe the engine's canonical transcript as well as the next provider
      // request. Never commit native transcripts, even for fixture calls.
      const transcripts = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: path.join(root, engine), absolute: true })];
      const rows = transcripts.flatMap(file => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)));
      const recorded = engine === "codex"
        ? rows.flatMap(row => row.payload?.type?.endsWith("tool_call_output") || row.payload?.type === "function_call_output" ? [row.payload.output] : [])
        : rows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content.filter((part: { type?: string }) => part.type === "tool_result") : []);
      expect(recorded).toHaveLength(1);
      if (engine === "codex") expect(textParts(recorded[0])).toEqual(textParts(results[0]));
      else expect(textParts((recorded[0] as { content: unknown }).content)).toEqual([expected]);
    } finally {
      clearTimeout(timer);
      await reapFixtureChildren();
      api.stop(true);
      setMcpHttpDependenciesForTests(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
}
