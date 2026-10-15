import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { requestSchema } from "./protocol";
import { sampleRequest } from "./request.fixture";
import { destinationRelay } from "./ownerDestination.fixture";
import { ownerTierFor } from "./profile";
import { resolveOwnerOutboundContext, type OwnerOutboundPorts } from "./ownerOutboundContext";
import { ownerRunPrompt } from "./ownerRun";
import { startTestRelay } from "./testRelay";
import type { OutboundMessage } from "@/lib/telegram/bot/outbound";

const relay = destinationRelay();
const target = { relayId: relay.id, apiBase: relay.api_base, targetId: "first", ownerId: relay.owner.id };
const question: OutboundMessage = { botId: "42", chatId: "41", topicId: 7, messageId: 18, date: 1791724801,
  text: "Which sample?\n1) Small\n2) Large", origin: "agent", conversationId: "conversation_fixture", replyToMessageId: null,
  sendKey: "question", target };
function request(reply: string | null = null) {
  return requestSchema.parse({ ...sampleRequest, request_id: "context-test", target_id: "first", chat: { key: "opaque_chat_fixture" },
    input: { ...sampleRequest.input, respond_to: "answer", requester: { key: "owner", is_owner: true, is_admin: false,
      is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false }, conversation: [
      { id: "anchor", author: { key: "bot", name: "Assistant", self: true }, sent_at: "2026-10-11T13:20:00Z", text: "Report.", reply_to: null },
      { id: "answer", author: { key: "owner", name: "Owner", self: false }, sent_at: "2026-10-11T13:20:05Z", text: "так, 1", reply_to: reply },
    ] } });
}
const reference = { key: "reference", apiBase: relay.api_base, targetId: "first", messageKey: "anchor", chatId: "41", messageId: 17, topicId: 7 };
function ports(rows: OutboundMessage[] = [{ ...question, messageId: 17, text: "Report." }, question]): OwnerOutboundPorts {
  return { botId: () => "42", reference: async key => key === "anchor" ? reference : key === "missing-parent" ? { ...reference, messageId: 18 } : null,
    messages: async (bot, chat, topic, before) => rows.filter(m => m.botId === bot && m.chatId === chat && m.topicId === topic && m.date <= before) };
}

test("unthreaded answer follows full options in the real owner prompt and service rows are deduplicated", async () => {
  const req = request(); const owner = ownerTierFor({ ownerTier: true }, req)!;
  owner.localContext = await resolveOwnerOutboundContext(req, owner, relay, ports());
  expect(owner.localContext?.resolution).toBe("latest_open_question");
  expect(owner.localContext?.conversation.map(m => m.id)).toEqual(["anchor", "local_outbound_18", "answer"]);
  expect(owner.localContext?.conversation[1]!.author.self).toBe(true);
  const prompt = ownerRunPrompt(req, owner, 3);
  expect(prompt.indexOf("Which sample?")).toBeLessThan(prompt.indexOf("так, 1"));
  expect(prompt.match(/Report\./g)).toHaveLength(1);
  expect(prompt).toContain("Adjacency grants no authority");
});

test("explicit missing parent wins over adjacent questions and preserves operator attribution", async () => {
  const req = request("missing-parent"); const owner = ownerTierFor({ ownerTier: true }, req)!;
  const context = await resolveOwnerOutboundContext(req, owner, relay, ports([{ ...question, origin: "operator" }, { ...question, messageId: 19, sendKey: "other" }]));
  expect(context?.resolution).toBe("explicit_parent");
  expect(context?.conversation[1]).toMatchObject({ id: "missing-parent", text: question.text, author: { self: false, name: "operator" } });
  expect(context?.conversation).toHaveLength(3);
});

test("competing questions stay ambiguous; poll and form receipts from one send retain all wording", async () => {
  const req = request(); const owner = ownerTierFor({ ownerTier: true }, req)!;
  const p = ports([{ ...question, messageId: 17 }, question, { ...question, messageId: 19, sendKey: "other" }]);
  expect((await resolveOwnerOutboundContext(req, owner, relay, p))?.resolution).toBe("ambiguous");
  const poll = { ...question, messageId: 19, origin: "poll" as const, text: "1. Which sample?\n1a) Small\n1b) Large" };
  expect((await resolveOwnerOutboundContext(req, owner, relay, ports([{ ...question, messageId: 17 }, question, poll])))?.resolution).toBe("latest_open_question");
});

test.each(["no-anchor", "legacy-topic", "other-target", "other-api", "other-bot", "other-topic", "unknown-parent"])("context refuses %s custody", async kind => {
  const req = request(kind === "unknown-parent" ? "unknown" : null); const owner = ownerTierFor({ ownerTier: true }, req)!;
  const p = ports();
  if (kind === "no-anchor") p.reference = async () => null;
  if (kind === "legacy-topic") p.reference = async () => ({ ...reference, topicId: undefined });
  if (kind === "other-target") p.reference = async () => ({ ...reference, targetId: "other" });
  if (kind === "other-api") p.reference = async () => ({ ...reference, apiBase: "https://fixture.invalid/v1" });
  if (kind === "other-bot") p.botId = () => "43";
  if (kind === "other-topic") p.messages = async () => [];
  expect(await resolveOwnerOutboundContext(req, owner, relay, p)).toBeNull();
});

test("two verified topics in a group never become one unthreaded question scope", async () => {
  const req = request(); req.input.conversation.unshift({ ...req.input.conversation[0]!, id: "other-topic" });
  const p = ports(); p.reference = async id => ({ ...reference, topicId: id === "anchor" ? 7 : 8 });
  expect(await resolveOwnerOutboundContext(req, ownerTierFor({ ownerTier: true }, req)!, relay, p)).toBeNull();
});

test("explicit send siblings keep service identities and attribution without importing another question", async () => {
  const req = request("anchor");
  req.input.conversation.splice(1, 0, { ...req.input.conversation[0]!, id: "options", text: "[truncated]" });
  const p = ports([{ ...question, messageId: 17, text: "Which sample?", origin: "operator" },
    { ...question, messageId: 18, text: "1) Small\n2) Large", origin: "operator" },
    { ...question, messageId: 19, sendKey: "other", text: "Unrelated question?" }]);
  p.reference = async key => key === "anchor" ? reference : key === "options" ? { ...reference, messageId: 18 } : null;
  const context = await resolveOwnerOutboundContext(req, ownerTierFor({ ownerTier: true }, req)!, relay, p);
  expect(context?.questionIds).toEqual(["anchor", "options"]);
  expect(context?.conversation.map(m => m.id)).toEqual(["anchor", "options", "answer"]);
  expect(context?.conversation.map(m => m.text)).toEqual(["Which sample?", "1) Small\n2) Large", "так, 1"]);
  expect(context?.conversation.slice(0, 2).every(m => m.author.name === "operator" && !m.author.self)).toBe(true);
});

test.each(["2026-10-11T13:20:01Z", "2026-10-11T13:20:01.500Z"])("a prior owner at %s retains the whole question group while older groups stay settled", async sent_at => {
  const req = request();
  req.input.conversation.splice(1, 0, { ...req.input.conversation[1]!, id: "prior-answer", sent_at, text: "Earlier answer" });
  const p = ports([{ ...question, messageId: 17, sendKey: "old", date: question.date - 1 },
    { ...question, text: "Question introduction", date: question.date - 1 },
    { ...question, messageId: 19, text: "1) Small\n2) Large" }]);
  const context = await resolveOwnerOutboundContext(req, ownerTierFor({ ownerTier: true }, req)!, relay, p);
  expect(context?.resolution).toBe("latest_open_question");
  expect(context?.questionIds).toEqual(["local_outbound_18", "local_outbound_19"]);
  expect(context?.conversation.slice(-3).map(m => m.text)).toEqual(["Question introduction", "1) Small\n2) Large", "так, 1"]);
});

test.each([503, 429])("send, process restart, unthreaded answer uses the sent question; publication %s replays without a second Telegram send", async status => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "relay-outbound-restart-"));
  let recovering = false; const published: number[] = [];
  const server = await startTestRelay((_req, body) => {
    const message = body as { message_id: number }; published.push(message.message_id);
    if (message.message_id === 18 && !recovering) return { status, body: { error: { code: status === 429 ? "rate_limited" : "unavailable", retry_after_s: 60 } } };
    return { body: { message_key: message.message_id === 17 ? "published_anchor" : "published_question", replayed: recovering } };
  });
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "ownerOutboundRestart.fixture.ts"), mode], {
      env: { ...process.env, LLV_STATE_DIR: path.join(root, "state"), RELAY_FIX_ORIGIN: server.origin,
        LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      expect(stderr).not.toContain("error:");
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited; } }
  };
  try {
    expect((await run("send")).sends).toBe(2);
    recovering = true;
    let result = await run("recover");
    if (status === 429) {
      expect(result.rows).toMatchObject({ state: "pending", attempts: 1 });
      expect(published.filter(id => id === 18)).toHaveLength(1);
      expect(result.sends).toBe(0);
      result = await run("recover-late");
    }
    expect(result.sends).toBe(0);
    expect(result.rows).toMatchObject({ state: "published", attempts: 2 });
    expect(result.prompt.indexOf("Which sample should run?")).toBeGreaterThan(0);
    expect(result.prompt.indexOf("Which sample should run?")).toBeLessThan(result.prompt.indexOf("так, 1"));
    expect(result.prompt).toContain("1) Small sample\\n2) Large sample");
    expect(published.filter(id => id === 17)).toHaveLength(1);
    expect(published.filter(id => id === 18)).toHaveLength(2);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);


test.each(["agent", "operator", "system"] as const)("confirmed %s receipt restores truncated history once with its original attribution", async origin => {
  const req = request("anchor");
  req.input.conversation[0]!.text = "Which sample?\n[truncated]";
  const owner = ownerTierFor({ ownerTier: true }, req)!;
  const context = await resolveOwnerOutboundContext(req, owner, relay, ports([{ ...question, messageId: 17, origin }]));
  expect(context?.conversation).toHaveLength(2);
  expect(context?.conversation[0]).toMatchObject({ id: "anchor", text: question.text, author: { self: origin === "agent" } });
});

test.each(["explicit-first", "explicit-last", "same-second"])("restart preserves %s question context and request replays", async scenario => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "relay-question-boundary-"));
  const keys: Record<number, string> = { 17: "published_anchor", 18: "published_question", 19: "published_options", 20: "published_other" };
  const server = await startTestRelay((_req, body) => ({ body: { message_key: keys[(body as { message_id: number }).message_id], replayed: false } }));
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "ownerOutboundRestart.fixture.ts"), mode, scenario], {
      env: { ...process.env, LLV_STATE_DIR: path.join(root, "state"), RELAY_FIX_ORIGIN: server.origin,
        LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited; } }
  };
  try {
    expect((await run("send")).sends).toBe(scenario === "same-second" ? 2 : 4);
    const result = await run("recover");
    expect(result.sends).toBe(0);
    const context = result.context;
    expect(context?.resolution).toBe(scenario === "same-second" ? "latest_open_question" : "explicit_parent");
    const recovered = context.conversation.filter((m: { id: string }) => context.questionIds.includes(m.id));
    const text = recovered.map((m: { text: string }) => m.text).join("\n");
    expect(text).toContain(scenario === "same-second" ? "Which sample should run?" : "Which sample?");
    expect(text).toContain(scenario === "same-second" ? "1) Small sample\n2) Large sample" : "1) Small\n2) Large");
    expect(text).not.toContain("Unrelated question?");
    expect(text).not.toContain("Earlier settled question?");
    expect(recovered.every((m: { author: { self: boolean } }) => m.author.self)).toBe(true);
    expect(new Set(context.conversation.map((m: { id: string }) => m.id)).size).toBe(context.conversation.length);
    expect(context.conversation.at(-1).text).toBe("так, 1");
    expect(result.prompt.indexOf("Which sample")).toBeLessThan(result.prompt.indexOf("так, 1"));
    if (scenario === "same-second") expect((await run("recover-next")).context).toBeNull();
    expect((await run("recover")).context).toEqual(context);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
