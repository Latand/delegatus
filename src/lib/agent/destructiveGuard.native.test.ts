// destructive-code: head-only. Real engines, no credentials, fake protected trees.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { guardFixture, ingestGuardFixture } from "./destructiveGuard.fixture";
import { ensureDestructiveGuard } from "./destructiveGuard";
import { codexProcessCleanupArgs, codexProcessCleanupConfig } from "./processCleanupPolicy";
import { attentionReason } from "@/components/attention";
import type { FileEntry } from "@/lib/types";

const binaries = { claude: process.env.LLV_CLAUDE_BINARY ?? Bun.which("claude"), codex: process.env.LLV_CODEX_BINARY ?? Bun.which("codex") };
const fixtures: ReturnType<typeof guardFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

for (const [engine, transport] of [["claude", "cli"], ["codex", "cli"], ["codex", "app-server"]] as const) for (const mode of ["literal", "incident"] as const) {
  test.skipIf(!binaries[engine])(`${engine} ${transport} native ${mode} call is refused and projects board attention`, async () => {
    const f = guardFixture(); fixtures.push(f);
    const version = Bun.spawnSync([binaries[engine]!, "--version"], { cwd: f.cwd, env: f.env });
    expect(version.exitCode).toBe(0); console.log(`guard-native ${engine} ${transport} ${mode}: ${version.stdout.toString().trim()}`);
    const protectedRoots = [f.home + "/Projects/a", f.home + "/Projects/b", f.state, f.home + "/.ssh"];
    for (const root of protectedRoots) fs.writeFileSync(root + "/keep", "protected");
    const stubDir = f.tmp + "/stubs"; fs.mkdirSync(stubDir);
    // The incident double executes a fixed fixture operation. It never reads
    // or executes the command it receives. Its only target is this fake tree.
    const fixed = `rm -rf '${f.home}/Projects/a/..'/*`;
    fs.writeFileSync(stubDir + "/ssh", `#!/bin/sh\nexec /bin/bash -c ${JSON.stringify(fixed)}\n`, { mode: 0o700 });
    const script = f.tmp + "/run-tests.sh";
    fs.writeFileSync(script, `#!/bin/sh\nPATH='${stubDir}':"$PATH"\nexport PATH\nssh fixture-host cleanup\n`);
    const command = mode === "literal" ? `rm -r '${f.state}'` : `bash '${script}'`;
    f.assertOwned(f.home); f.assertOwned(script); f.assertOwned(stubDir);
    let calls = 0;
    const results: string[] = [];
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname.includes("count_tokens")) return Response.json({ input_tokens: 1 });
      const raw = new Uint8Array(await request.arrayBuffer());
      const body = JSON.parse(new TextDecoder().decode(request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(raw) : raw)) as { input?: { type: string; output?: string }[]; messages?: { role: string; content: unknown }[]; stream?: boolean };
      if (!body.input && !body.messages) return Response.json({});
      if (++calls > 4) return new Response("too many fixture calls", { status: 400 });
      if (body.input) results.push(...body.input.filter(item => /call_output/.test(item.type)).map(item => typeof item.output === "string" ? item.output : JSON.stringify(item.output)));
      if (body.messages) results.push(...body.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === "tool_result").map(part => JSON.stringify(part)) : []));
      const first = calls === 1;
      if (engine === "codex") {
        const item = first
          ? { type: "custom_tool_call", id: "guard-call", call_id: "guard-call", namespace: "functions", name: "exec", input: `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: f.cwd, max_output_tokens: 2000 })}));` }
          : { type: "message", role: "assistant", id: "guard-message", content: [{ type: "output_text", text: "Fixture complete." }] };
        return new Response(sse("response.created", { response: { id: `guard-response-${calls}` } })
          + sse("response.output_item.done", { output_index: 0, item })
          + sse("response.completed", { response: { id: `guard-response-${calls}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), { headers: { "content-type": "text/event-stream" } });
      }
      const block = first ? { type: "tool_use", id: "guard-call", name: "Bash", input: {} } : { type: "text", text: "" };
      const content = first ? { type: "tool_use", id: "guard-call", name: "Bash", input: { command } } : { type: "text", text: "Fixture complete." };
      if (!body.stream) return Response.json({ id: "guard-message", type: "message", role: "assistant", content: [content], model: "fixture-model", stop_reason: first ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      return new Response(sse("message_start", { message: { id: `guard-message-${calls}`, type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        + sse("content_block_start", { index: 0, content_block: block })
        + sse("content_block_delta", { index: 0, delta: first ? { type: "input_json_delta", partial_json: JSON.stringify({ command }) } : { type: "text_delta", text: "Fixture complete." } })
        + sse("content_block_stop", { index: 0 }) + sse("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) + sse("message_stop", {}), { headers: { "content-type": "text/event-stream" } });
    } });
    // Build an allowlisted engine env; no operator provider keys or endpoints.
    const env = Object.fromEntries(Object.entries(f.env).filter(([key]) => /^(?:HOME|PATH|BASH_ENV|TMPDIR|XDG_[A-Z_]+|LLV_(?:DESTRUCTIVE_GUARD_[A-Z_]+|STATE_DIR|VIEWER_CONTROL_URL)|CODEX_HOME|CLAUDE_CONFIG_DIR)$/.test(key))) as NodeJS.ProcessEnv;
    env.LANG = "C.UTF-8";
    let argv: string[];
    if (engine === "codex") {
      const catalog = f.tmp + "/models.json";
      fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: "guard-fixture", display_name: "Guard fixture", description: null, base_instructions: "Run the fixed fixture tool.", supported_reasoning_levels: [], shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 0, availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [], tool_mode: "code_mode_only", context_window: 32000, prefer_websockets: false }] }));
      fs.writeFileSync(env.CODEX_HOME + "/config.toml", ['model="guard-fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`, 'web_search="disabled"', '[model_providers.fixture]', 'name="fixture"', `base_url="${provider.url.origin}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'supports_websockets=false', '[analytics]', 'enabled=false'].join("\n"));
      ensureDestructiveGuard({ engine, home: env.CODEX_HOME!, source: f.env });
      argv = [binaries.codex!, "exec", ...codexProcessCleanupArgs(env.CODEX_HOME!, f.env), "--enable", "code_mode", "--enable", "code_mode_only", "--disable", "enable_request_compression", "--disable", "apps", "--disable", "plugins", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`, ...Object.entries(env).filter(([key]) => key === "BASH_ENV" || key.startsWith("LLV_DESTRUCTIVE_GUARD_")).flatMap(([key, value]) => ["-c", `shell_environment_policy.set.${key}=${JSON.stringify(value)}`]), "--json", "Run the fixture."];
    } else {
      fs.writeFileSync(env.CLAUDE_CONFIG_DIR + "/.claude.json", JSON.stringify({ hasCompletedOnboarding: true }));
      fs.writeFileSync(env.CLAUDE_CONFIG_DIR + "/settings.json", JSON.stringify({ env: Object.fromEntries(Object.entries(env).filter(([key]) => key === "PATH" || key === "BASH_ENV" || key.startsWith("LLV_DESTRUCTIVE_GUARD_"))) }));
      ensureDestructiveGuard({ engine, home: env.CLAUDE_CONFIG_DIR!, source: f.env });
      Object.assign(env, { ANTHROPIC_BASE_URL: provider.url.origin, ANTHROPIC_AUTH_TOKEN: "fixture-local", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_TMPDIR: f.tmp });
      argv = [binaries.claude!, "-p", "Run the fixture.", "--model", "fixture-model", "--permission-mode", "bypassPermissions", "--allowedTools", "Bash", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--output-format", "stream-json", "--verbose", "--max-turns", "3"];
    }
    if (transport === "app-server") argv = [binaries.codex!, "app-server", ...codexProcessCleanupArgs(env.CODEX_HOME!, f.env), "--enable", "code_mode", "--enable", "code_mode_only", "--disable", "enable_request_compression", "--disable", "apps", "--disable", "plugins"];
    const child = Bun.spawn(argv, { cwd: f.cwd, env, stdin: transport === "app-server" ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const stderr = new Response(child.stderr).text();
      if (transport === "app-server") {
        const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
        let next = 0, finished!: (value: unknown) => void;
        const completed = new Promise<unknown>(resolve => { finished = resolve; });
        const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
          const id = ++next; pending.set(id, { resolve, reject });
          child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
        });
        const stream = (async () => {
          const decoder = new TextDecoder(); let buffered = "";
          for await (const chunk of child.stdout as typeof child.stdout & AsyncIterable<Uint8Array>) {
            buffered += decoder.decode(chunk, { stream: true });
            for (let newline; (newline = buffered.indexOf("\n")) >= 0;) {
              const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
              if (!line.trim()) continue;
              const row = JSON.parse(line);
              if (typeof row.id === "number" && pending.has(row.id)) {
                const waiter = pending.get(row.id)!; pending.delete(row.id);
                if (row.error) waiter.reject(Error(JSON.stringify(row.error))); else waiter.resolve(row.result);
              }
              if (row.method === "turn/completed") finished(row.params.turn);
            }
          }
          for (const waiter of pending.values()) waiter.reject(Error("app-server closed before its reply"));
          finished(null);
        })();
        await rpc("initialize", { clientInfo: { name: "guard-fixture", version: "1" }, capabilities: { experimentalApi: true } });
        child.stdin!.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        const thread = await rpc("thread/start", { model: "guard-fixture", cwd: f.cwd, approvalPolicy: "never", sandbox: "danger-full-access", config: {
          shell_environment_policy: { set: Object.fromEntries(Object.entries(env).filter(([key]) => key === "PATH" || key === "BASH_ENV" || key.startsWith("LLV_DESTRUCTIVE_GUARD_"))) },
          hooks: codexProcessCleanupConfig(env.CODEX_HOME!, f.env).hooks,
        } }) as { thread: { id: string } };
        await rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Run the fixture." }] });
        const turn = await completed;
        expect(turn).toMatchObject({ status: "completed" });
        if (child.exitCode === null) child.kill("SIGTERM");
        const exit = await child.exited; await stream; await stderr;
        console.log("guard-native app-server completed; owned shutdown exit=" + exit);
      } else {
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), stderr]);
        expect(code, err + out).toBe(0);
      }
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(results.join("\n")).toContain("Delegatus stopped");
      for (const root of protectedRoots) expect(fs.readFileSync(root + "/keep", "utf8")).toBe("protected");
      const rows = fs.readFileSync(f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows).toHaveLength(1); expect(rows[0].layer).toBe(mode === "literal" ? "hook" : "wrapper");
      expect(rows[0].parents.length).toBeGreaterThan(0);
      const ingested = await ingestGuardFixture(f, engine);
      expect(ingested.errors).toEqual([]); expect(ingested.events).toHaveLength(1); expect(ingested.attempt.guardRefusals).toHaveLength(1);
      const refusal = ingested.refusal!;
      expect(attentionReason({ path: f.tmp + "/native.jsonl", guardRefusal: refusal } as FileEntry, Date.parse(refusal.at) / 1000 + 1)?.kind).toBe("refusal");
    } finally {
      clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; provider.stop(true);
    }
  }, 40_000);
}
