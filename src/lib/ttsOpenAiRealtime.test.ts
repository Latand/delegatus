import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/tts/route";
import { ttsBackendInfo, writeTtsBackend } from "./ttsBackend";
import { isPcmTtsBackend } from "./tts";
import { writeKey } from "./keys/store";
import { setSpeechSocketForTests } from "./ttsOpenAiRealtime";

let root: string, saved: Record<string, string | undefined>;
const variables = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_TTS_BACKEND", "LLV_TTS_OPENAI_MODEL", "LLV_TTS_OPENAI_VOICE", "OPENAI_API_KEY"];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  saved = Object.fromEntries(variables.map(name => [name, process.env[name]])); for (const name of variables) delete process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-read-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config"); process.env.LLV_STATE_DIR = path.join(root, "state");
  writeTtsBackend("openai"); await writeKey("openai", ["sk", "proj", "t".repeat(48)].join("-"));
});
afterEach(async () => {
  setSpeechSocketForTests(null);
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
type Command = { type: string; session?: unknown; item?: unknown; response?: unknown };
async function vendor(respond: (socket: WebSocket, commands: Command[]) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("port");
  let closed!: () => void, received!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const reached = new Promise<void>(resolve => { received = resolve; });
  const commands: Command[] = [];
  server.on("connection", socket => {
    socket.on("close", closed);
    socket.on("message", raw => { const command = JSON.parse(String(raw)); commands.push(command); if (command.type === "response.create") { received(); respond(socket, commands); } });
  });
  setSpeechSocketForTests((url, _key) => {
    expect(url).toBe(`wss://api.openai.com/v1/realtime?model=${ttsBackendInfo().options[0].model}`);
    return new WebSocket(`ws://127.0.0.1:${address.port}`);
  });
  return { commands, reached, disconnected };
}
function request(signal?: AbortSignal) { return new NextRequest("http://127.0.0.1/api/tts", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ text: "Read this answer.", mode: "pcm" }), signal }); }
const sendAudio = (socket: WebSocket) => {
  socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([1, 0, 2, 0]).toString("base64") }));
  socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([3, 0]).toString("base64") }));
  socket.send(JSON.stringify({ type: "response.done", response: { status: "completed" } }));
};
test("the real route migrates Speech to Realtime and streams ordered PCM with its actual identity", async () => {
  process.env.LLV_TTS_OPENAI_MODEL = "gpt-4o-mini-tts"; process.env.LLV_TTS_OPENAI_VOICE = "nova";
  const info = ttsBackendInfo(); expect(info.options[0]).toMatchObject({ model: "gpt-realtime-2.1-mini", voice: "alloy" }); expect(isPcmTtsBackend(info.backend)).toBe(true);
  const fixture = await vendor(sendAudio);
  const response = await POST(request()); expect(response.status).toBe(200);
  for (const [header, value] of Object.entries({ "x-tts-backend": "openai", "x-tts-model": info.options[0].model, "x-tts-voice": info.options[0].voice, "x-tts-encoding": "pcm_s16le", "x-tts-sample-rate": "24000", "x-tts-channels": "1" })) expect(response.headers.get(header)).toBe(value);
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 0, 2, 0, 3, 0]);
  expect(fixture.commands.map(row => row.type)).toEqual(["session.update", "conversation.item.create", "response.create"]);
  const session = fixture.commands[0].session as { audio: unknown; output_modalities: unknown };
  expect(session.audio).toEqual({ output: { voice: "alloy", format: { type: "audio/pcm", rate: 24000 } } });
  expect(session.output_modalities).toEqual(["audio"]);
  expect(fixture.commands[1].item).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Read this answer." }] });
  await fixture.disconnected;
});
test.each(["error", "close", "incomplete", "invalid"])("pre-audio %s returns 502 and releases admission", async kind => {
  const fixture = await vendor(socket => {
    if (kind === "close") socket.close();
    else socket.send(JSON.stringify(kind === "error" ? { type: "error", error: { message: "private-fixture" } } : kind === "invalid" ? { type: "response.output_audio.delta", delta: "bad" } : { type: "response.done", response: { status: "failed" } }));
  });
  // Four sequential failures exceed the three-synthesis cap if any slot leaks.
  for (let index = 0; index < 4; index++) { const response = await POST(request()); expect(response.status).toBe(502); expect(await response.text()).not.toContain("private-fixture"); }
  await fixture.disconnected;
});
test("client cancellation closes its socket and returns 499 before audio", async () => {
  const fixture = await vendor(() => {}); const abort = new AbortController();
  const pending = POST(request(abort.signal)); await fixture.reached; abort.abort(); expect((await pending).status).toBe(499); await fixture.disconnected;
});
test("failure after audio errors the stream, closes the socket and releases admission", async () => {
  const fixture = await vendor(socket => { socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([1, 0]).toString("base64") })); socket.send(JSON.stringify({ type: "error" })); });
  for (let index = 0; index < 4; index++) { const response = await POST(request()); expect(response.status).toBe(200); const reader = response.body!.getReader(); expect((await reader.read()).value).toEqual(new Uint8Array([1, 0])); await expect(reader.read()).rejects.toThrow(); }
  await fixture.disconnected;
});
