import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareOwnerPrompt, ownerContinuationPrompt } from "./ownerRun";
import { richRequest } from "./rich.fixture";

const probe = process.env.LLV_RELAY_REPLY_PROBE === "1" ? test : test.skip;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reply-probe-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

probe("native chat reply and continuation address the chat with inline web citations", async () => {
  // The project preload replaces CLAUDE_CONFIG_DIR. Pin the private probe
  // config separately, keeping every ordinary test home isolated.
  expect(process.env.LLV_RELAY_REPLY_CONFIG).toBeTruthy();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: process.env.LLV_RELAY_REPLY_CONFIG! };
  const request = richRequest();
  request.input.instructions = "Відповідай українською, від першої особи жіночого роду, як учасниця чату.";
  request.input.owner_instructions = "Короткі відповіді, один абзац.";
  const owner = { messageId: request.input.respond_to,
    text: "Поясни нам у чаті, для чого існує example.com. Перевір офіційне джерело через вебпошук та додай посилання поруч із поясненням.", requestText: null };
  const initial = prepareOwnerPrompt(request, owner, 3);
  const prompts = [initial.prompt, ownerContinuationPrompt(request, { ...owner, text: "А example.org має таке саме призначення? Перевір джерело й поясни нам з посиланням." }, 3,
    { seen: initial.seen, staticDigest: initial.digest }).prompt];
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
  for (const [index, prompt] of prompts.entries()) {
    const child = Bun.spawn([process.env.LLV_RELAY_REPLY_CLAUDE ?? "claude", "-p", "--output-format", "json", "--model", "haiku", "--effort", "low",
      "--safe-mode", "--restricted", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "", ...(index === 0 ? ["--session-id", sessionId] : ["--resume", sessionId])],
    { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await child.stdin.write(prompt);
    child.stdin.end();
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout.trim() || stderr).not.toBe("");
    const response = JSON.parse(stdout);
    expect({ status, stderr, result: response.is_error ? response.result : "ok" }).toEqual({ status: 0, stderr: "", result: "ok" });
    expect(response.is_error).toBe(false);
    const reply = String(response.result);
    console.log(JSON.stringify({ turn: index + 1, turns: response.num_turns, reply }));
    if (index === 0) expect(response.num_turns).toBeGreaterThan(1);
    expect(reply).toMatch(/[іїєґ]/iu);
    expect(reply).toMatch(/https:\/\/(?:www\.)?iana\.org\//);
    expect(reply).not.toMatch(/^\s*(?:Sources:|Відповіла в чат|Розповіла .+ про)/mi);
    expect(reply.split(/\n\s*\n/)).toHaveLength(1);
  }
}, 240_000);
