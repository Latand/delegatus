import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareOwnerPrompt, ownerContinuationPrompt, ownerAnswer } from "./ownerRun";
import { openOwnerAnswer, relayAnswerOp, sealOwnerAnswer } from "./ownerAnswer";
import { richRequest } from "./rich.fixture";
import { reserveRun, updateRelayStore } from "./store";
import { procBackend } from "@/lib/proc";
import type { ExternalRelayRequest } from "./protocol";

const probe = process.env.LLV_RELAY_REPLY_PROBE === "1" ? test : test.skip;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reply-probe-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let replays = 0;
// What the owner turn posts: the recorded relay_answer calls replace the parts
// through the production operation, in order, and the sealed text wins over
// the last message exactly as in ownerRun.
async function postedReply(base: ExternalRelayRequest, calls: unknown[], lastMessage: string) {
  const id = `${++replays}`;
  const request: ExternalRelayRequest = { ...base, request_id: `rq_reply_probe_${id}` };
  const conversationId = `conversation_reply_probe_${id}`;
  const relay = { id: `relay_reply_probe_${id}`, paused: false, targets: [{ id: request.target_id, enabled: true, ownerTier: true }] };
  updateRelayStore(store => ({ ...store, relays: [...store.relays, relay as never] }));
  reserveRun({ requestId: request.request_id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id, childPid: null, childIdentity: null,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid)!, runDir: root, startedAt: "2026-11-12T00:00:00.000Z", conversationId,
    ownerTurn: { clientAttemptId: `relay-owner-${request.request_id}`, request: { text: "probe", requestText: null } } });
  const entry = openOwnerAnswer(relay.id, request, root, [], () => true);
  try {
    for (const call of calls) expect(await relayAnswerOp(conversationId, call)).not.toBeNull();
    const text = sealOwnerAnswer(request.request_id)?.text;
    return { composed: text, reply: text ?? lastMessage };
  } finally { await entry.dispose(); }
}

function hasInlineCitations(reply: string): boolean {
  const links = [...reply.matchAll(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gu)];
  if (links.length === 0 || reply.split(/\n\s*\n/u).length !== 1) return false;
  return links.every((link) => {
    const lineStart = reply.lastIndexOf("\n", link.index) + 1;
    const lineEndIndex = reply.indexOf("\n", link.index);
    const lineEnd = lineEndIndex === -1 ? reply.length : lineEndIndex;
    const line = reply.slice(lineStart, lineEnd);
    const before = line.slice(0, link.index - lineStart).trim();
    const after = line.slice(link.index - lineStart + link[0].length).trim();
    // A list of sources is a colon followed only by links and separators up to
    // the end of the sentence; a link inside a sentence that goes on is inline.
    const rest = after.split(/(?<=[.!?…])\s/u)[0] ?? "";
    const listed = before.endsWith(":") && sourceListTail.test(rest);
    return before.length > 0 && !/^(?:[-*+]\s|\d+[.)]\s)/u.test(before) && !listed && /[.!?…]["'”’)]*$/u.test(after);
  });
}
const sourceListTail = /^(?:\s*(?:[,;]|і|та|and)?\s*\[[^\]]+\]\(https?:\/\/[^)]+\))*\s*[.!?…]?["'”’)]*$/u;

test("inline citation structure accepts ordinary linked prose", () => {
  expect(hasInlineCitations("IANA зберігає ці імена для прикладів ([IANA](https://www.iana.org/help/example-domains)).")).toBe(true);
  expect(hasInlineCitations("IANA зберігає ці імена для прикладів.\n\nSources:\n- [IANA](https://www.iana.org/help/example-domains)")).toBe(false);
  // Shapes observed in native replies: a closing sources sentence fails, a
  // link after a colon inside a continuing sentence passes.
  expect(hasInlineCitations("Базовий стандарт — RFC 2606. Джерела: [IANA: Example Domains](https://www.iana.org/help/example-domains), [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606).")).toBe(false);
  expect(hasInlineCitations("Імена зарезервовано. Sources: [IANA](https://www.iana.org/help/example-domains).")).toBe(false);
  expect(hasInlineCitations("Сторінка IANA пише так: [IANA: Example domains](https://www.iana.org/help/example-domains), а правила закріплені в [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606).")).toBe(true);
});

test("the probe posts the text of the last relay_answer call, falling back to the last message when it cleared text", async () => {
  const inline = "Домен example.com зарезервовано для прикладів ([IANA](https://www.iana.org/help/example-domains)).";
  const footer = "Відповіла в чат.\n\nSources:\n- [IANA](https://www.iana.org/help/example-domains)";
  const cleared = await postedReply(richRequest(), [{ text: inline }, { format: "rich_markdown" }], footer);
  expect(cleared).toEqual({ composed: undefined, reply: footer });
  expect(hasInlineCitations(cleared.reply)).toBe(false);
  const rewritten = await postedReply(richRequest(), [{ format: "rich_markdown" }, { text: inline }], footer);
  expect(rewritten).toEqual({ composed: inline, reply: inline });
  expect(hasInlineCitations(rewritten.reply)).toBe(true);
});

probe("native chat reply and continuation post the relay_answer text with inline web citations", async () => {
  // The project preload replaces CLAUDE_CONFIG_DIR. Pin the private probe
  // config separately, keeping every ordinary test home isolated.
  expect(process.env.LLV_RELAY_REPLY_CONFIG).toBeTruthy();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: process.env.LLV_RELAY_REPLY_CONFIG! };
  const request = richRequest();
  request.input.instructions = "Відповідай українською, від першої особи жіночого роду, як учасниця чату.";
  request.input.owner_instructions = "Короткі відповіді, один абзац.";
  const owner = { messageId: request.input.respond_to!,
    text: "Поясни нам у чаті, для чого існує example.com. Перевір офіційне джерело через вебпошук та додай посилання поруч із поясненням.", requestText: null };
  const initial = prepareOwnerPrompt(request, owner, 3);
  const prompts = [initial.prompt, ownerContinuationPrompt(request, { ...owner, text: "А example.org має таке саме призначення? Перевір джерело й поясни нам з посиланням." }, 3,
    { seen: initial.seen, staticDigest: initial.digest }).prompt];
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
  // The production relay_answer contract, served by a recording stub.
  // --safe-mode would skip MCP servers; the private config and empty setting
  // sources keep the session free of local customizations instead.
  const calls = path.join(root, "relay-answer.jsonl");
  const mcp = JSON.stringify({ mcpServers: { viewer: { command: process.execPath, args: [path.join(import.meta.dir, "ownerReply.native.fixture.ts"), calls] } } });
  for (const [index, prompt] of prompts.entries()) {
    fs.writeFileSync(calls, "");
    const child = Bun.spawn([process.env.LLV_RELAY_REPLY_CLAUDE ?? "claude", "-p", "--output-format", "json", "--model", "haiku", "--effort", "low",
      "--restricted", "--tools", "WebSearch,WebFetch,ToolSearch", "--allowedTools", "WebSearch,WebFetch,ToolSearch,mcp__viewer__relay_answer", "--strict-mcp-config", "--mcp-config", mcp,
      "--setting-sources", "", ...(index === 0 ? ["--session-id", sessionId] : ["--resume", sessionId])],
    { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await child.stdin.write(prompt);
    child.stdin.end();
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout.trim() || stderr).not.toBe("");
    const response = JSON.parse(stdout);
    expect({ status, stderr, result: response.is_error ? response.result : "ok" }).toEqual({ status: 0, stderr: "", result: "ok" });
    expect(response.is_error).toBe(false);
    const answers = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
    const { composed, reply } = await postedReply(request, answers, String(response.result));
    console.log(JSON.stringify({ turn: index + 1, turns: response.num_turns, calls: answers.length, reply, lastMessage: response.result }));
    expect(composed).toBeDefined();
    expect(ownerAnswer(reply, request, owner)).toMatchObject({ action: "reply", format: "rich_markdown", text: reply.trim() });
    if (index === 0) expect(response.num_turns).toBeGreaterThan(1);
    expect(reply).toMatch(/[іїєґ]/iu);
    expect(hasInlineCitations(reply)).toBe(true);
    expect(reply).not.toMatch(/^\s*(?:Sources:|Відповіла в чат|Розповіла .+ про)/mi);
    expect(reply.split(/\n\s*\n/)).toHaveLength(1);
  }
}, 240_000);
