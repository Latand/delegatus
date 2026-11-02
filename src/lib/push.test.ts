import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "./types";
import { setLegacyDocumentWriteHookForTests } from "./state/legacyDocumentStore";

const previous = process.env.LLV_STATE_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-sqlite-"));
process.env.LLV_STATE_DIR = root;
const { notifyQuestion, notifyVoiceTimer, retireVoiceTimerPush, saveSubscription, pushSubscriptionStore, pushSentStore, voiceTimerPushStore } = await import("./push");
const subscriptions = path.join(root, "push-subscriptions.json"), sent = path.join(root, "push-sent.json"), timerClaims = path.join(root, "voice-timer-push.json");
// The stores keep their connections open, so a removed directory would leave a stale read behind for the next case.
beforeEach(() => { setLegacyDocumentWriteHookForTests(null); pushSubscriptionStore.clear(subscriptions); pushSentStore.clear(sent); voiceTimerPushStore.clear(timerClaims); });
afterAll(() => { setLegacyDocumentWriteHookForTests(null); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });

function subscription(endpoint: string) {
  const receiver = crypto.createECDH("prime256v1");
  receiver.setPrivateKey(Buffer.alloc(32, 1));
  return { endpoint, expirationTime: null, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } };
}
function question(id: string): FileEntry {
  return { path: "/fixtures/conversation.jsonl", conversationId: "conversation_fixture", engine: "codex", title: "Fixture", mtime: 1,
    pendingQuestion: { kind: "question", toolUseId: id, askedAt: "2026-10-01T00:00:00.000Z", questions: [{ header: "Fixture", question: "Choose" }] } } as unknown as FileEntry;
}

/** Opens an aes128gcm body with the fixture receiver's own key, as the browser would. */
function openPush(body: Buffer): Record<string, unknown> {
  const receiver = crypto.createECDH("prime256v1");
  receiver.setPrivateKey(Buffer.alloc(32, 1));
  const salt = body.subarray(0, 16), senderPublic = body.subarray(21, 21 + body[20]!), sealed = body.subarray(21 + body[20]!);
  const shared = receiver.computeSecret(senderPublic);
  const expand = (key: Buffer, info: Buffer | string, length: number) => crypto.createHmac("sha256", key).update(info).update(Buffer.from([1])).digest().subarray(0, length);
  const prkKey = crypto.createHmac("sha256", Buffer.alloc(16, 2)).update(shared).digest();
  const ikm = expand(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), senderPublic]), 32);
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const decipher = crypto.createDecipheriv("aes-128-gcm", expand(prk, "Content-Encoding: aes128gcm\0", 16), expand(prk, "Content-Encoding: nonce\0", 12));
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, -1).toString("utf8")) as Record<string, unknown>;
}

test("a voice timer pushes once under its own tag and a 900 s TTL; a failure is reported and asked again; no device answers none", async () => {
  const seen: Array<{ ttl: string | null; payload: Record<string, unknown> }> = [];
  let status = 503;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    seen.push({ ttl: request.headers.get("ttl"), payload: openPush(Buffer.from(await request.arrayBuffer())) });
    return new Response(null, { status });
  } });
  try {
    const message = { id: "vt_fixture", title: "Timer is up", body: "The 15-minute timer «tea», set at 10:05, is up." };
    expect(await notifyVoiceTimer(message)).toBe("none");
    expect(seen).toEqual([]);
    await saveSubscription(subscription(`http://127.0.0.1:${server.port}/push`));
    expect(await notifyVoiceTimer(message)).toBe("failed");
    expect(voiceTimerPushStore.read(timerClaims)).toEqual([]);
    status = 201;
    expect(await notifyVoiceTimer(message)).toBe("sent");
    expect(await notifyVoiceTimer(message)).toBe("sent");
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ ttl: "900", payload: { title: "Timer is up", body: message.body, url: "/", tag: "voice-timer:vt_fixture" } });
    expect(voiceTimerPushStore.read(timerClaims).every(key => key.startsWith("voice-timer:vt_fixture:"))).toBe(true);
    expect(voiceTimerPushStore.read(timerClaims)).toHaveLength(2);
    expect(pushSentStore.read(sent)).toEqual([]);
    await notifyQuestion(question("attention_timer_beside"));
    expect(seen.at(-1)!.ttl).toBe("60");
    expect(seen.at(-1)!.payload.tag).toBeUndefined();
  } finally { await server.stop(true); }
});

function acceptingServer(status: () => number = () => 201) {
  const seen = { sends: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => { await request.arrayBuffer(); seen.sends += 1; return new Response(null, { status: status() }); } });
  return { seen, server, endpoint: `http://127.0.0.1:${server.port}/push` };
}
const timerMessage = { id: "vt_ledger", title: "Timer is up", body: "The 15-minute timer «tea», set at 10:05, is up." };

test("a device that accepted a timer is not sent it again when the answer could not be recorded", async () => {
  const { seen, server, endpoint } = acceptingServer();
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await saveSubscription(subscription(endpoint));
    let writes = 0;
    setLegacyDocumentWriteHookForTests(collection => { if (collection === "voice_timer_push" && ++writes === 2) throw new Error("fixture write refused"); });
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    expect(seen.sends).toBe(1);
    setLegacyDocumentWriteHookForTests(null);
    expect(await notifyVoiceTimer(timerMessage)).toBe("uncertain");
    expect(seen.sends).toBe(1);
  } finally { errors.mockRestore(); await server.stop(true); }
});

test("question churn cannot forget a timer's claim: past the question ledger's cap, a replay and a restart send it no second time", async () => {
  const { seen, server, endpoint } = acceptingServer();
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await saveSubscription(subscription(endpoint));
    let writes = 0;
    setLegacyDocumentWriteHookForTests(collection => { if (collection === "voice_timer_push" && ++writes === 2) throw new Error("fixture write refused"); });
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    setLegacyDocumentWriteHookForTests(null);
    expect(seen.sends).toBe(1);
    pushSentStore.mutate(sent, () => ({ next: Array.from({ length: 499 }, (_, index) => `attention_${index}`), result: undefined }));
    await notifyQuestion(question("attention_499"));
    await notifyQuestion(question("attention_500"));
    expect(seen.sends).toBe(3);
    expect(pushSentStore.read(sent)).toHaveLength(500);
    expect(await notifyVoiceTimer(timerMessage)).toBe("uncertain");
    expect(seen.sends).toBe(3);
    const child = Bun.spawn([process.execPath, "-e", 'const {notifyVoiceTimer}=await import("./src/lib/push"); console.log(await notifyVoiceTimer(await new Response(Bun.stdin).json()));'], {
      env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(timerMessage)); child.stdin.end();
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("uncertain");
    expect(seen.sends).toBe(3);
  } finally { errors.mockRestore(); await server.stop(true); }
}, 60_000);

test("a device that refused stays free past question churn, and a timer's claims retire with it and no other timer's", async () => {
  let status = 503;
  const { seen, server, endpoint } = acceptingServer(() => status);
  try {
    await saveSubscription(subscription(endpoint));
    expect(await notifyVoiceTimer(timerMessage)).toBe("failed");
    status = 201;
    pushSentStore.mutate(sent, () => ({ next: Array.from({ length: 500 }, (_, index) => `attention_${index}`), result: undefined }));
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    expect(await notifyVoiceTimer({ ...timerMessage, id: "vt_other" })).toBe("sent");
    expect(seen.sends).toBe(3);
    expect(voiceTimerPushStore.read(timerClaims)).toHaveLength(4);
    await retireVoiceTimerPush(timerMessage.id);
    expect(voiceTimerPushStore.read(timerClaims).every(key => key.startsWith("voice-timer:vt_other:"))).toBe(true);
    expect(voiceTimerPushStore.read(timerClaims)).toHaveLength(2);
    expect(pushSentStore.read(sent)).toHaveLength(500);
    await retireVoiceTimerPush(timerMessage.id);
    expect(voiceTimerPushStore.read(timerClaims)).toHaveLength(2);
  } finally { await server.stop(true); }
});

test("a claim that cannot be written sends nothing, and the next attempt sends once", async () => {
  const { seen, server, endpoint } = acceptingServer();
  try {
    await saveSubscription(subscription(endpoint));
    setLegacyDocumentWriteHookForTests(collection => { if (collection === "voice_timer_push") throw new Error("fixture write refused"); });
    expect(await notifyVoiceTimer(timerMessage)).toBe("failed");
    expect(seen.sends).toBe(0);
    setLegacyDocumentWriteHookForTests(null);
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    expect(seen.sends).toBe(1);
  } finally { await server.stop(true); }
});

test("a request that left with no answer may have arrived: it is reported uncertain and never repeated", async () => {
  const net = await import("node:net");
  let connections = 0;
  const silent = net.createServer(socket => { connections += 1; socket.on("error", () => undefined); socket.once("data", () => socket.destroy()); });
  await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
  try {
    await saveSubscription(subscription(`http://127.0.0.1:${(silent.address() as { port: number }).port}/push`));
    expect(await notifyVoiceTimer(timerMessage)).toBe("uncertain");
    const reached = connections;
    expect(reached).toBeGreaterThan(0);
    expect(await notifyVoiceTimer(timerMessage)).toBe("uncertain");
    expect(connections).toBe(reached);
  } finally { await new Promise(resolve => silent.close(resolve)); }
});

test("a device that answered with a refusal may be asked again, one that accepted is not, and a dead one retires", async () => {
  const refusing = { code: 503 };
  const a = acceptingServer(() => refusing.code);
  const b = acceptingServer();
  const dead = acceptingServer(() => 410);
  try {
    await saveSubscription(subscription(a.endpoint));
    await saveSubscription(subscription(b.endpoint));
    await saveSubscription(subscription(dead.endpoint));
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    expect([a.seen.sends, b.seen.sends, dead.seen.sends]).toEqual([1, 1, 1]);
    expect(pushSubscriptionStore.read(subscriptions).map(row => row.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
    refusing.code = 201;
    expect(await notifyVoiceTimer(timerMessage)).toBe("sent");
    expect([a.seen.sends, b.seen.sends]).toEqual([2, 1]);
  } finally { await Promise.all([a.server.stop(true), b.server.stop(true), dead.server.stop(true)]); }
});

test("every device gone answers none, which the worker never asks again", async () => {
  const dead = acceptingServer(() => 404);
  try {
    await saveSubscription(subscription(dead.endpoint));
    expect(await notifyVoiceTimer(timerMessage)).toBe("none");
    expect(pushSubscriptionStore.read(subscriptions)).toEqual([]);
  } finally { await dead.server.stop(true); }
});

test("the service worker shows a timer under its own tag, so it never replaces a waiting question", async () => {
  const code = fs.readFileSync(path.join(import.meta.dir, "../../public/question-push-sw.js"), "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Array<{ title: string; options: { tag: string } }> = [];
  const worker = { addEventListener: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); },
    registration: { showNotification: async (title: string, options: { tag: string }) => { shown.push({ title, options }); } } };
  new Function("self", code)(worker);
  const push = (payload: unknown) => listeners.get("push")!({ data: { json: () => payload }, waitUntil: () => undefined });
  push({ title: "Timer is up", body: "tea", url: "/", tag: "voice-timer:vt_fixture" });
  push({ title: "Fixture", body: "Choose", url: "/" });
  expect(shown.map(row => row.options.tag)).toEqual(["voice-timer:vt_fixture", "agent-question"]);
});

test("successful sends dedupe, failed sends retry, and dead subscriptions retire", async () => {
  let status = 503, calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => { await request.arrayBuffer(); calls++; return new Response(null, { status }); } });
  try {
    await saveSubscription(subscription(`http://127.0.0.1:${server.port}/push`));
    await notifyQuestion(question("attention_fixture"));
    expect(calls).toBe(1); expect(pushSentStore.read(sent)).toEqual([]);
    status = 201;
    await notifyQuestion(question("attention_fixture"));
    await notifyQuestion(question("attention_fixture"));
    expect(calls).toBe(2); expect(pushSentStore.read(sent)).toEqual(["attention_fixture"]);
    status = 410;
    await notifyQuestion(question("attention_next"));
    expect(pushSubscriptionStore.read(subscriptions)).toEqual([]);
    expect(pushSentStore.read(sent)).toEqual(["attention_fixture"]);
  } finally { await server.stop(true); }
});

test("a peer renewal while a dead response is in flight survives cleanup", async () => {
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => { await request.arrayBuffer(); arrived(); await response; return new Response(null, { status: 410 }); } });
  let sending: Promise<void> | undefined;
  try {
    const original = subscription(`http://127.0.0.1:${server.port}/push`);
    await saveSubscription(original);
    let retireAttempts = 0;
    setLegacyDocumentWriteHookForTests(collection => { if (collection === "push_subscriptions") retireAttempts++; });
    sending = notifyQuestion(question("attention_race"));
    await ready;
    const renewed = { ...original, expirationTime: 2_000_000_000_000 };
    const child = Bun.spawn([process.execPath, "-e", 'const {saveSubscription}=await import("./src/lib/push"); await saveSubscription(await new Response(Bun.stdin).json());'], {
      env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(renewed)); child.stdin.end();
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    // A loaded machine makes the child report its lock wait; anything else on stderr is a failure.
    expect(stderr.split("\n").filter(line => line && !line.startsWith("[blocking-wait] "))).toEqual([]); expect(code).toBe(0);
    release(); await sending;
    expect(retireAttempts).toBe(1);
    expect(pushSubscriptionStore.read(subscriptions)).toEqual([renewed]);
  } finally { release(); await sending; await server.stop(true); }
});

test("a non-string endpoint refuses before it can create an unreadable row", async () => {
  await expect(saveSubscription({ endpoint: 1 } as never)).rejects.toThrow("endpoint must be a string");
  expect(pushSubscriptionStore.read(subscriptions)).toEqual([]);
});

test("a subscription persistence refusal reaches its caller and the next save recovers", async () => {
  setLegacyDocumentWriteHookForTests(collection => { if (collection === "push_subscriptions") throw new Error("fixture write refused"); });
  try { await expect(saveSubscription(subscription("https://push.example.invalid/fixture"))).rejects.toThrow("fixture write refused"); }
  finally { setLegacyDocumentWriteHookForTests(null); }
  await saveSubscription(subscription("https://push.example.invalid/fixture"));
  expect(pushSubscriptionStore.read(subscriptions)).toHaveLength(1);
});
