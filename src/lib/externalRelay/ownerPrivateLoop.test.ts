import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { decodeHTML } from "entities";
import { TelegramBotService, productionTelegramBotDependencies } from "@/lib/telegram/bot/service";
import { TelegramBotStore } from "@/lib/telegram/bot/store";
import { FakeBotTransport, fakeBotToken, ok } from "@/lib/telegram/bot/fakeTransport";
import { renderPrototypeTelegram } from "@/lib/prototypeReview/telegramPost";
import { prototypeCopyLine } from "@/lib/prototypeReview/telegramAnswer";
import { telegramRound, telegramTask } from "@/lib/prototypeReview/telegram.fixture";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { relayClaimBody } from "./poller";
import { createTelegramPublisher } from "./telegramPublication";
import { knownRelay } from "./knownRelays";
import { startTestRelay } from "./testRelay";
import { sampleRequest } from "./request.fixture";
import { runClaimedRequest } from "./runner";
import { ownerTierFor } from "./profile";
import { callableTools, createToolLoop } from "./toolLoop";
import { requestSchema, type ExternalRelayRequest } from "./protocol";
import { readRelayStore, updateRelayStore, type PairedRelay } from "./store";
import { relayCall } from "./client";

const captures: Record<string, unknown> = {};
test.each([true, false])("owner private loop captures real selection, claim, Telegram publish, copied answer and completion (owner tier %s)", async ownerTier => {
  const round = telegramRound("owner-private");
  saveTasks([telegramTask([round])]);
  const wire: Record<string, unknown> = { claim: null, publish: null, polls: [], copied_answer: null, completion: null };
  let claimed: ExternalRelayRequest | undefined;
  let completeCount = 0, publishes = 0;
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/requests/claim")) {
      wire.claim = body;
      return { body: { request: claimed } };
    }
    if (req.url?.endsWith("/messages")) {
      expect(req.url).toBe("/v1/targets/target_1/messages");
      publishes++;
      if ((body as { message_id: number }).message_id === 17) wire.publish = body;
      else (wire.polls as unknown[]).push(body);
      return { body: { message_key: (body as { message_id: number }).message_id === 17 ? "m_review" : `m_poll_${(body as { message_id: number }).message_id}`, replayed: false } };
    }
    if (req.url?.endsWith("/complete")) { completeCount++; wire.completion = body; }
    return { body: { status: "ok" } };
  });
  const paired: PairedRelay = { id: `private_fixture_${ownerTier}`, origin: knownRelay("celestia")!.origin, api_base: `${server.origin}/v1`,
    name: "Fixture", description: "", credential: "q".repeat(43), owner: { namespace: "telegram", id: "41", display_name: "Owner", handle: null },
    pairedAt: "2026-10-11T16:00:00Z", paused: false, limits: { max_wait_s: 25, max_response_bytes: 1048576, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Fixture", answered_by: "install", fallback: "none", enabled: true,
      engine: "codex", model: "fixture", effort: null, project: round.project, concurrency: 1, hardCapMinutes: 1, ownerTier }] };
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  expect(relayClaimBody(paired).features).toContain("requester_context");
  const store = new TelegramBotStore(path.join(process.env.TMPDIR!, `owner-private-bot-${ownerTier}.sqlite`));
  const transport = new FakeBotTransport();
  let token: string | null = null;
  let published: Promise<unknown> | undefined;
  const publisher = createTelegramPublisher(() => readRelayStore().relays, () => token ? "123" : null);
  const service = new TelegramBotService({ ...productionTelegramBotDependencies(), openStore: () => store, removeStoreFiles: () => {},
    transportFor: () => transport, saveToken: t => { token = t; }, removeToken: () => { token = null; },
    withStoredToken: consume => token ? consume(token, "123") : null,
    publishMessage: receipt => {
      expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
      published = publisher(receipt);
      return published;
    } });
  try {
    transport.script("getMe", ok({ id: 123, is_bot: true, first_name: "Fixture" }));
    await service.connect(fakeBotToken()); await service.stopPoller();
    transport.handlers.getChat = () => ok({ id: 41, type: "private", first_name: "Owner" });
    transport.script("sendRichMessage", ok({ message_id: 17, date: 1791724800, chat: { id: 41 } }));
    transport.script("sendPoll", ...[18, 19, 20].map(message_id => ok({ message_id, date: 1791724800 })));
    const rich = renderPrototypeTelegram(round, [], "Review layout");
    await service.sendOwnerReview({ clientRequestId: round.id, message: rich });
    expect(transport.callsOf("sendRichMessage")[0]!.params.chat_id).toBe(41);
    expect(store.chat("41")!.postAllowed).toBe(false);
    const sentMarkdown = (transport.callsOf("sendRichMessage")[0]!.params.rich_message as { markdown: string }).markdown;
    const copyButton = sentMarkdown.match(/<tg-button type="copy_text"[^>]* text="([^"]*)">Варіант 2<\/tg-button>/);
    expect(copyButton).not.toBeNull();
    const copied = decodeHTML(copyButton![1]!);
    expect(copied).toBe(prototypeCopyLine(round, 2));
    expect(await published).toBe("published");
    await service.waitForReviewPolls();
    await published;
    expect((wire.publish as { text: string }).text).toBe(rich.plainText!);
    expect((wire.publish as { text: string }).text).not.toContain("<tg-");
    await service.sendOwnerReview({ clientRequestId: round.id, message: rich });
    await service.waitForReviewPolls();
    expect(publishes).toBe(4);
    wire.copied_answer = copied;
    const request: ExternalRelayRequest = requestSchema.parse({ ...sampleRequest, request_id: `owner_private_${ownerTier}`, chat: { key: "private_chat_fixture" },
      answer: { max_chars: 4000, progress: "notes" }, input: { ...sampleRequest.input,
        requester: { key: "owner", is_owner: true, is_admin: false, is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false },
        tools: [{ name: "owner_get_clone", summary: "Owner read", mode: "handoff" }],
        conversation: [{ id: "m_review", author: { key: "bot", name: "Clone", self: true }, sent_at: (wire.publish as { sent_at: string }).sent_at, text: rich.plainText!, reply_to: null },
          { id: "m_answer", author: { key: "owner", name: "Owner", self: false }, sent_at: "2026-10-11T13:21:00Z", text: copied, reply_to: "m_review" }], respond_to: "m_answer" } });
    expect(request.chat).toEqual({ key: "private_chat_fixture" });
    expect(ownerTierFor(paired.targets[0]!, request)?.text ?? null).toBe(ownerTier ? copied : null);
    expect(callableTools(request)).toEqual([]);
    const loop = createToolLoop(paired, request, { signal: new AbortController().signal, lose: () => {}, ack: async () => true });
    expect(loop.tools).toEqual([]);
    await loop.runCalls([{ tool: "owner_get_clone", arguments: "{}", cursor: null }], 1);
    expect(loop.results[0]?.code).toBe("not_permitted");
    claimed = request;
    const claim = await relayCall<{ request: unknown }>(paired.api_base, "/requests/claim", "POST", relayClaimBody(paired), paired.credential);
    expect(claim.body?.request).toEqual(request);
    // The runner emits elapsed time on the wire. A held clock makes those
    // actual completion bytes reproducible without rewriting the capture.
    const clock = spyOn(Date, "now").mockReturnValue(1791724860000);
    let result;
    try { result = await runClaimedRequest(paired, claim.body!.request, undefined, { command: "/missing-fixture-agent" }); }
    finally { clock.mockRestore(); }
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: "m_answer" } });
    expect(completeCount).toBe(1);
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toMatchObject({ chosen: [2] });
    captures[String(ownerTier)] = wire;
    if (process.env.LLV_RELAY_PRIVATE_LOOP_OUTPUT) fs.writeFileSync(process.env.LLV_RELAY_PRIVATE_LOOP_OUTPUT, JSON.stringify(captures, null, 2) + "\n");
    else expect(wire).toEqual(JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/relay_v1/install_owner_private_loop.json"), "utf8"))[String(ownerTier)]);
  } finally { await service.waitForReviewPolls(); await service.remove(); await server.close(); }
});
