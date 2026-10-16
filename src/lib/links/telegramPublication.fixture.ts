/** Isolated two-install server: real pairing, sync, send, publish and claim. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import * as peer from "@/app/api/peer/v1/[...path]/route";
import { POST as selfCheck } from "@/app/api/peer/v1/self-check/route";
import { saveAddress } from "./self";
import { mintCode } from "./protocol";
import { setShared, readPeers } from "./state";
import { connectPeer, syncPeer } from "./client";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { TelegramBotStore } from "@/lib/telegram/bot/store";
import { TelegramBotService, productionTelegramBotDependencies } from "@/lib/telegram/bot/service";
import { FakeBotTransport, fakeBotToken, ok } from "@/lib/telegram/bot/fakeTransport";
import { saveBotToken } from "@/lib/telegram/bot/transport";
import { destinationRelay } from "@/lib/externalRelay/ownerDestination.fixture";
import { updateRelayStore } from "@/lib/externalRelay/store";
import { relayCall } from "@/lib/externalRelay/client";
import { requestSchema } from "@/lib/externalRelay/protocol";
import { answerPrompt } from "@/lib/externalRelay/prompt";

process.env.LLV_TOKEN = "fixture-access";
const root = process.env.LLV_STATE_DIR!;
let now = 1791724805000;
Date.now = () => now;
const filename = path.join(root, "telegram/bot.sqlite");
fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
const store = new TelegramBotStore(filename);
saveBotToken(fakeBotToken(), "42");
const relay = destinationRelay();
relay.api_base = `${process.env.RELAY_FIX_ORIGIN}/v1`;
if (process.env.PUBLICATION_SIDE === "sender") relay.origin = "https://development.example";
updateRelayStore(s => ({ ...s, relays: process.env.PUBLICATION_SIDE === "sender" && process.env.UNPAIRED_SENDER === "1" ? [] : [relay] }));
const transport = new FakeBotTransport();
const service = new TelegramBotService({ ...productionTelegramBotDependencies(), openStore: () => store,
  transportFor: () => transport, now: () => new Date(now) });
const remote = "code.example.test/acme/widget";
const project = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
fs.writeFileSync(path.join(root, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [project]: remote } }));
setShared({ v: 1, all: false, projects: [project] });
const json = (res: http.ServerResponse, value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  req.socket.on("error", () => {});
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const route = req.url!;
    if (route === "/fixture/code") { json(res, await mintCode()); return; }
    if (route === "/fixture/connect") { const input = JSON.parse(body); await connectPeer(input); json(res, { connected: true }); return; }
    if (route === "/fixture/sync") {
      for (const p of readPeers().peers) await syncPeer(p.id);
      json(res, { synced: true }); return;
    }
    if (route === "/fixture/advance") { now += JSON.parse(body).ms; json(res, { now }); return; }
    if (route === "/fixture/send") {
      store.recordLookedUpChat({ id: -41, type: "supergroup", title: "Fixture" }, null, new Date(now));
      store.setChatSettings("-41", { alias: "fixture", postAllowed: true });
      transport.script("sendMessage", ok({ message_id: 18, date: 1791724800, message_thread_id: 7, chat: { id: -41 }, text: "Choose a sample size: small, medium, large." }));
      json(res, await service.send({ conversationId: "conversation_fixture", clientRequestId: "report", chat: "fixture", topicId: 7, text: "Choose a sample size: small, medium, large." }));
      return;
    }
    if (route === "/fixture/state") {
      const db = new Database(filename, { readonly: true });
      try { json(res, { sends: transport.callsOf("sendMessage").length,
        rows: db.query("SELECT o.message_id, o.state, o.attempts, r.reason FROM relay_outbound o LEFT JOIN relay_publication_results r USING(key)").all() }); }
      finally { db.close(); }
      return;
    }
    if (route === "/fixture/claim") {
      const response = await relayCall(relay.api_base, "/targets/first/claim", "POST", {}, relay.credential);
      const request = requestSchema.parse(response.body);
      json(res, { input: request.input, prompt: answerPrompt(request) }); return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const request = new NextRequest(`http://127.0.0.1${route}`, { method: req.method, headers,
      ...(req.method === "GET" ? {} : { body }) });
    const response = route === "/api/peer/v1/self-check" ? selfCheck(request)
      : await (req.method === "GET" ? peer.GET : peer.POST)(request, { params: Promise.resolve({ path: route.replace(/^\/api\/peer\/v1\//, "").split("/") }) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); json(res, { error: error instanceof Error ? error.message : "fixture failure" }); }
});
await new Promise<void>(resolve => server.listen(Number(process.env.PUBLICATION_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address() as { port: number };
const origin = `http://127.0.0.1:${address.port}`;
await saveAddress(origin, "Fixture");
console.log(JSON.stringify({ origin }));
process.on("SIGTERM", () => { void (async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await service.stopPublications(); store.close(); process.exit(0);
})(); });
