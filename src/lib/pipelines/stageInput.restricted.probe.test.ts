import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { prepareControllerArtifactDirectory } from "./controllerArtifacts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-stage-input-probe-"));
const probe = process.env.LLV_RESTRICTED_STAGE_INPUT_PROBE === "1" ? test : test.skip;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function agentRead(
  cwd: string,
  file: string,
  profile: { access: "read-only" | "read-write"; sandbox: "full" | "restricted" },
): Promise<{ denied: boolean; result: string }> {
  let sawToolResult!: (result: { denied: boolean; result: string }) => void;
  const toolResult = new Promise<{ denied: boolean; result: string }>((resolve) => { sawToolResult = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let request: Record<string, unknown>;
    try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400).end(); return; }
    if (req.url?.includes("/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
      return;
    }
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    const messages = request.messages as Array<{ content?: Array<Record<string, unknown>> }>;
    const results = messages.flatMap((message) => message.content ?? []).filter((item) => item.type === "tool_result");
    const result = results.at(-1);
    if (result) {
      sawToolResult({ denied: result.is_error === true, result: JSON.stringify(result.content ?? "") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(streamEvents([
        { type: "message_start", message: { id: "msg_final", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Read complete" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]));
      return;
    }
    const tool = (request.tools as Array<{ name: string }> | undefined)?.find((item) => item.name === "Read");
    if (!tool) { res.writeHead(400).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(streamEvents([
      { type: "message_start", message: { id: "msg_read", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_read", name: "Read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: file }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("probe server has no port");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "probe-key" };
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[key];
  const prompt = `Use the Read tool on ${file}, then finish.`;
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", profile.sandbox === "full" ? "bypassPermissions" : "auto"];
  if (profile.sandbox === "restricted") args.push("--restricted");
  if (profile.access === "read-only") args.push("--disallowedTools", "Edit,Write,NotebookEdit");
  args.push("--model", "claude-sonnet-4-5", "--no-session-persistence");
  const child = spawn("claude", args, {
    cwd, env, stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin?.end(prompt);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      toolResult,
      exited.then((code) => { throw new Error(`Claude exited ${code}: ${stderr.slice(-1500)}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude did not call Read: ${stderr.slice(-1500)}`)), 30_000); }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function streamEvents(events: object[]): string {
  return events.map((event) => {
    const item = event as { type?: string };
    return `event: ${item.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join("");
}

probe("Claude reads lane artifacts in all access/sandbox profiles and restricted profiles reject state artifacts", async () => {
  const cwd = path.join(root, "worktree");
  fs.mkdirSync(cwd, { recursive: true });
  const parts = [
    { name: "previous-output", checkpoints: ["Design head", "line 0:", "line 250:", "line 499:", "PREVIOUS_OUTPUT_TAIL_SENTINEL"], text: `Design head\n${Array.from({ length: 500 }, (_, index) => `line ${index}: ${"d".repeat(80)}`).join("\n")}\nPREVIOUS_OUTPUT_TAIL_SENTINEL` },
    { name: "specification", checkpoints: ["Specification head", "criterion 0:", "criterion 125:", "criterion 249:", "SPECIFICATION_TAIL_SENTINEL"], text: `Specification head\n${Array.from({ length: 250 }, (_, index) => `criterion ${index}: ${"界".repeat(40)}`).join("\n")}\nSPECIFICATION_TAIL_SENTINEL` },
  ];
  const profiles = [
    { access: "read-write", sandbox: "full" },
    { access: "read-write", sandbox: "restricted" },
    { access: "read-only", sandbox: "full" },
    { access: "read-only", sandbox: "restricted" },
  ] as const;
  for (const part of parts) {
    const external = path.join(root, "state", `${part.name}.md`);
    const lane = path.join(await prepareControllerArtifactDirectory(cwd), `${part.name}.md`);
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.mkdirSync(path.dirname(lane), { recursive: true });
    fs.writeFileSync(external, part.text, { mode: 0o600 });
    fs.writeFileSync(lane, part.text, { mode: 0o600 });

    for (const profile of profiles.filter((item) => item.sandbox === "restricted")) {
      const denied = await agentRead(cwd, external, profile);
      expect(denied.denied).toBe(true);
      expect(denied.result).not.toContain(part.checkpoints.at(-1)!);
    }
    for (const profile of profiles) {
      const allowed = await agentRead(cwd, lane, profile);
      expect(allowed.denied).toBe(false);
      for (const checkpoint of part.checkpoints) expect(allowed.result).toContain(checkpoint);
    }
  }
}, 360_000);
