import { afterAll, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry } from "./types";
import { setLegacyDocumentWriteHookForTests } from "./state/legacyDocumentStore";

const previous = process.env.LLV_STATE_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-sqlite-"));
process.env.LLV_STATE_DIR = root;
const { notifyQuestion, notifyVoiceTimer, saveSubscription, pushSubscriptionStore, pushSentStore } = await import("./push");
const subscriptions = path.join(root, "push-subscriptions.json"), sent = path.join(root, "push-sent.json");
beforeEach(() => { setLegacyDocumentWriteHookForTests(null); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
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
    expect(pushSentStore.read(sent)).toEqual([]);
    status = 201;
    expect(await notifyVoiceTimer(message)).toBe("sent");
    expect(await notifyVoiceTimer(message)).toBe("sent");
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ ttl: "900", payload: { title: "Timer is up", body: message.body, url: "/", tag: "voice-timer:vt_fixture" } });
    expect(pushSentStore.read(sent)).toEqual(["voice-timer:vt_fixture"]);
    await notifyQuestion(question("attention_timer_beside"));
    expect(seen.at(-1)!.ttl).toBe("60");
    expect(seen.at(-1)!.payload.tag).toBeUndefined();
  } finally { await server.stop(true); }
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
    expect(stderr).toBe(""); expect(code).toBe(0);
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
