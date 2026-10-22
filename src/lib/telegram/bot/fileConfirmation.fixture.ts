/** Private-state subprocess proof. Every Telegram operation uses FakeBotTransport. */
import fs from "node:fs";
import path from "node:path";
import { TelegramBotService, productionTelegramBotDependencies, TelegramBotError } from "./service";
import { FakeBotTransport, fakeBotToken, ok } from "./fakeTransport";
const transport = new FakeBotTransport();
const home = process.env.HOME!;
const now = new Date("2026-10-22T12:00:00Z");
const service = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport,
  now: () => now, sleep: async () => {}, documentEnvironment: () => ({ home, stateDir: process.env.LLV_STATE_DIR! }),
  fileConfirmationId: () => "restart-fixture" });
try {
  const mode = process.argv[2];
  if (mode === "pending" || mode === "sent") {
    transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Fixture bot" }));
    await service.connect(fakeBotToken()); await service.stopPoller();
    transport.script("getUpdates", ok([{ update_id: 1, my_chat_member: { chat: { id: -1000000000101, type: "supergroup", title: "Fixture reports" }, date: 1, new_chat_member: { status: "administrator" } } }]));
    await service.pollOnce(new AbortController().signal);
    service.setChat("-1000000000101", "reports", true);
    const filename = path.join(home, ".private", "credentials.md");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, ["-----BEGIN ", "PRIVATE KEY-----"].join(""));
    let id = "";
    try { await service.sendDocument({ conversationId: "conversation_fixture", clientRequestId: "fixture", chat: "reports", document: { path: filename } }); }
    catch (error) { if (!(error instanceof TelegramBotError) || !error.extra.confirmation) throw error; id = error.extra.confirmation.id; }
    const view = service.fileConfirmation(id);
    if (mode === "sent") {
      transport.script("sendDocument", ok({ message_id: 100, date: 1 }));
      await service.decideFileConfirmation(id, view.digest, true, () => {});
    }
    console.log(JSON.stringify({ id, digest: view.digest, state: service.fileConfirmation(id).state, sends: transport.callsOf("sendDocument").length }));
  } else {
    const [id, digest] = process.argv.slice(3);
    let code = "unexpected-success";
    try { await service.decideFileConfirmation(id!, digest!, true, () => {}); }
    catch (error) { if (!(error instanceof TelegramBotError)) throw error; code = error.code; }
    console.log(JSON.stringify({ code, state: service.fileConfirmation(id!).state, sends: transport.callsOf("sendDocument").length }));
  }
} finally {
  await service.stopPoller(); await service.stopPublications(); service["store"]().close();
}
