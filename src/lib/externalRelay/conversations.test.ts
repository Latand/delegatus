import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { conversationContext, reserveConversations, releaseConversation, readConversations, prepareConversationAccount, isRelayConversationDir, sweepConversations } from "./conversations";
import { sampleRequest } from "./request.fixture";
import { newTargetSettings, type PairedRelay } from "./store";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conversations-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const target = { ...newTargetSettings({ target_id: "t", name: "Target", answered_by: "install", fallback: "service" }), engine: "claude" as const, model: "haiku" };
const relay = { id: "r", targets: [target] } as PairedRelay;
test("owner and member contexts are separate; administrators remain one-shot", () => {
  expect(conversationContext(undefined)).toBe("member");
  expect(conversationContext({ is_owner: true, is_admin: true } as never)).toBe("owner");
  for (const is_anonymous_admin of [false, true]) expect(conversationContext({ is_owner: false, is_admin: true, is_anonymous_admin } as never)).toBeNull();
});
test("one turn per chat across both contexts; orphan and retention recovery", () => {
  const chat = "c".repeat(32);
  const first = reserveConversations(relay, target, chat, sampleRequest.request_id, ["member"])!;
  expect(first).toHaveLength(1);
  expect(reserveConversations(relay, target, chat, "other", ["owner"])).toBeNull();
  releaseConversation(first[0]!.id, { turns: 1 });
  const both = reserveConversations(relay, target, chat, "compact", ["member", "owner"])!;
  expect(both).toHaveLength(2);
  sweepConversations([relay], [], Date.now());
  expect(readConversations().every((r) => r.state === "idle")).toBe(true);
  expect(isRelayConversationDir(path.basename(both[0]!.cwd).replace(/[^a-zA-Z0-9]/g, "-"))).toBe(true);
  expect(isRelayConversationDir("ordinary-project")).toBe(false);
  sweepConversations([relay], [], Date.now() + 31 * 86400000);
  expect(readConversations()).toEqual([]);
});

test("conversation turns catch up service fallback messages and refresh static context after compaction", async () => {
  const { conversationTurnPrompt } = await import("./prompt"); const { requestSchema } = await import("./protocol");
  const request = requestSchema.parse(sampleRequest);
  const record = reserveConversations(relay, target, "p".repeat(32), "prompt_one", ["member"])![0]!;
  const first = conversationTurnPrompt(request, record, [], "[round]");
  const next = { ...record, seen: first.seen, staticDigest: first.digest };
  request.input.conversation.push({ id: "fallback_message", author: { key: "assistant", name: "Assistant", self: true }, sent_at: "2026-10-08T12:00:00Z", text: "Service fallback answer", reply_to: null });
  const second = conversationTurnPrompt(request, next, [], "[round]");
  expect(second.prompt).toContain("Service fallback answer"); expect(second.prompt).toContain(request.input.respond_to!); expect(second.prompt).not.toContain("<service_instructions>");
  expect(conversationTurnPrompt(request, { ...next, staticDigest: null, seen: [] }, [], "[round]").prompt).toContain("<service_instructions>");
  releaseConversation(record.id);
});

test("a missing Claude transcript starts fresh while preserving the chat reservation", () => {
  const record = reserveConversations(relay, target, "m".repeat(32), "missing_session", ["member"])![0]!;
  Object.assign(record, { sessionId: "00000000-0000-0000-0000-000000000000", seen: ["old"], staticDigest: "old", turnsSinceCompaction: 1 });
  fs.mkdirSync(record.cwd, { recursive: true }); fs.utimesSync(record.cwd, new Date(0), new Date(0));
  prepareConversationAccount(record, { transcriptRoot: path.join(root, "empty-account") } as never);
  expect(record.sessionId).toBeNull(); expect(record.seen).toEqual([]); expect(record.staticDigest).toBeNull();
  expect(record.state).toBe("running"); expect(record.runningRequestId).toBe("missing_session");
  expect(fs.statSync(record.cwd).mtimeMs).toBeGreaterThan(Date.now() - 5000);
  releaseConversation(record.id, record);
});

test("a malformed conversation map is preserved and replaced on recovery", () => {
  const file = path.join(root, "external-relay/conversations.json"); fs.writeFileSync(file, "broken JSON");
  expect(readConversations()).toEqual([]);
  const saved = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith("conversations.json.corrupt-"))!;
  expect(fs.readFileSync(path.join(path.dirname(file), saved), "utf8")).toBe("broken JSON");
  expect(reserveConversations(relay, target, "r".repeat(32), "recover", ["member"])).toHaveLength(1);
  sweepConversations([], []);
});
