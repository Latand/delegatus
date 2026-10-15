import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { TelegramBotStore } from "@/lib/telegram/bot/store";
import { TelegramBotService, productionTelegramBotDependencies } from "@/lib/telegram/bot/service";
import { FakeBotTransport, fakeBotToken, ok } from "@/lib/telegram/bot/fakeTransport";
import { publishDurableTelegramMessage } from "./telegramPublication";
import { updateRelayStore } from "./store";
import { destinationRelay } from "./ownerDestination.fixture";
import { sampleRequest } from "./request.fixture";
import { requestSchema } from "./protocol";
import { ownerTierFor } from "./profile";
import { publishedRelayReference } from "./publishedReferences";
import { scopedOutbound, ownerQuestionCutoff } from "@/lib/telegram/bot/outbound";
import { resolveOwnerOutboundContext } from "./ownerOutboundContext";
import { runOwnerAgent } from "./ownerRun";

const mode = process.argv[2];
const scenario = process.argv[3] ?? "ordinary";
const split = scenario.startsWith("explicit-");
const sameSecond = scenario === "same-second";
const filename = path.join(process.env.LLV_STATE_DIR!, "telegram/bot.sqlite");
fs.mkdirSync(path.dirname(filename), { recursive: true });
const store = new TelegramBotStore(filename);
const relay = destinationRelay();
relay.api_base = `${process.env.RELAY_FIX_ORIGIN}/v1`;
updateRelayStore(s => ({ ...s, relays: [relay] }));
const target = { relayId: relay.id, apiBase: relay.api_base, targetId: "first", ownerId: "41" };
const transport = new FakeBotTransport();
const service = new TelegramBotService({ ...productionTelegramBotDependencies(), openStore: () => store,
  removeStoreFiles: () => {}, transportFor: () => transport, saveToken: () => {}, removeToken: () => {},
  withStoredToken: consume => consume(fakeBotToken(), "42"), now: () => new Date(mode === "send" ? 1791724802000 : mode === "recover-late" ? 1791724862000 : 1791724805000),
  publicationTarget: () => target,
  publishMessage: (receipt, authorize) => publishDurableTelegramMessage(receipt, authorize!),
});
try {
  if (mode === "send") {
    store.recordLookedUpChat({ id: 41, type: "private", first_name: "Fixture" }, null, new Date(1791724800000));
    store.setChatSettings("41", { alias: "fixture", postAllowed: true });
    transport.script("sendMessage", ok({ message_id: 17, date: 1791724800 }), ok({ message_id: 18, date: 1791724801 }),
      ok({ message_id: 19, date: 1791724802 }), ok({ message_id: 20, date: 1791724803 }));
    await service.send({ conversationId: "conversation_fixture", clientRequestId: "anchor", chat: "fixture",
      text: sameSecond ? "Earlier settled question?\n1) Old sample\n2) Other old sample" : "Earlier local report." });
    await service.waitForPublications();
    if (sameSecond) await ownerQuestionCutoff(filename, JSON.stringify([relay.id, "first", "42", "41", null]), "prior", 1791724801);
    await service.send({ conversationId: "conversation_fixture", clientRequestId: "question", chat: "fixture",
      text: split ? "Which sample?\n" + "x".repeat(4080) + "\n\n1) Small\n2) Large" : "Which sample should run?\n1) Small sample\n2) Large sample" });
    await service.waitForPublications();
    if (split) {
      await service.send({ conversationId: "conversation_fixture", clientRequestId: "other", chat: "fixture", text: "Unrelated question?\n1) Other" });
      await service.waitForPublications();
    }
    await service.stopPublications();
    console.log(JSON.stringify({ sends: transport.callsOf("sendMessage").length }));
  } else {
    // A fresh real process owns a newly opened service and both databases.
    service.ensurePoller();
    await service.stopPoller();
    await service.waitForPublications();
    const next = mode === "recover-next";
    const request = requestSchema.parse({ ...sampleRequest, request_id: next ? "next-owner" : "restart-owner", target_id: "first", chat: { key: "opaque_chat_fixture" },
      input: { ...sampleRequest.input, requester: { key: "owner", is_owner: true, is_admin: false, is_anonymous_admin: false,
        can_restrict_members: false, can_delete_messages: false }, respond_to: "answer", conversation: [
        { id: "published_anchor", author: { key: "bot", name: "Assistant", self: true }, sent_at: "2026-10-11T13:20:00Z", text: "Earlier local report.", reply_to: null },
        { id: "answer", author: { key: "owner", name: "Owner", self: false }, sent_at: next ? "2026-10-11T13:20:09Z" : "2026-10-11T13:20:05Z",
          text: "так, 1", reply_to: split ? scenario === "explicit-first" ? "published_question" : "published_options" : null },
      ] } });
    const owner = ownerTierFor({ ownerTier: true }, request)!;
    owner.localContext = await resolveOwnerOutboundContext(request, owner, relay, {
      botId: () => "42", reference: key => Promise.resolve(publishedRelayReference(relay.api_base, "first", key)),
      messages: (bot, chat, topic, before, messageId) => scopedOutbound(filename, bot, chat, topic, before, messageId),
      cutoff: (scope, id, at) => ownerQuestionCutoff(filename, scope, id, at),
    });
    let prompt: unknown;
    const run = runOwnerAgent({ request, owner, target: relay.targets[0]!, accountId: null, hardCapMs: 5000,
      onConversation: () => {}, ports: { launch: async body => { prompt = body.prompt; return { status: 200, body: { conversationId: "conversation_fixture", initialMessage: "delivered" } }; },
        observe: async () => ({ state: "ended", finalText: "Sample selected." }), stop: async () => {}, pollMs: 1 } });
    await run.done;
    await service.stopPublications();
    const db = new Database(filename, { readonly: true });
    const rows = db.query("SELECT state, attempts FROM relay_outbound WHERE message_id=18").get(); db.close();
    console.log(JSON.stringify({ sends: transport.callsOf("sendMessage").length, prompt, rows, context: owner.localContext }));
  }
} finally { await service.stopPoller(); await service.stopPublications(); store.close(); }
