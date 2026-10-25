import { afterEach, expect, spyOn, test } from "bun:test";
import { startTestRelay } from "./testRelay";
import { clonePairing, cloneReceipt } from "./clone.fixture";
import { cloneClientKey, clonePayloadSupported, sendAsClone, type CloneSendInput } from "./cloneSend";
import { publishedRelayReference } from "./publishedReferences";

const servers: Array<Awaited<ReturnType<typeof startTestRelay>>> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
async function server(handler: Parameters<typeof startTestRelay>[0]) { const s = await startTestRelay(handler); servers.push(s); return clonePairing(s.origin); }
const input = (overrides: Partial<CloneSendInput> = {}): CloneSendInput => ({ client_key: cloneClientKey("fixture", "caller", "request", 0),
  chat_id: -1000000000101, text: "Fixture report", parse_mode: null, silent: true, ...overrides });

test("plain and HTML send preserve the contract and record both fresh and replayed references", async () => {
  let count = 0;
  const relay = await server((req, body) => {
    expect(req.url).toBe("/api/relay/v1/targets/fixture-clone/send");
    expect(req.headers["delegatus-relay-version"]).toBe("1");
    expect(req.headers.authorization).toBe(`Bearer ${relay.credential}`);
    expect(body).toEqual(input({ parse_mode: count ? "HTML" : null, reply_to_message_id: 17, message_thread_id: 12 }));
    return { body: cloneReceipt(101, count++ > 0) };
  });
  for (const parse_mode of [null, "HTML"] as const) {
    expect(await sendAsClone(relay, "fixture-clone", input({ parse_mode, reply_to_message_id: 17, message_thread_id: 12 })))
      .toMatchObject({ kind: "sent", messageId: 101, replayed: parse_mode === "HTML" });
  }
  expect(publishedRelayReference(relay.api_base, "fixture-clone", "fixture_message_101"))
    .toMatchObject({ chatId: String(input().chat_id), messageId: 101, topicId: 12 });
});

for (const [status, code, mapped, fallback] of [
  [400,"malformed","bad_request",true], [400,"format_invalid","format_invalid",true], [400,"text_too_long","text_too_long",true],
  [401,"unauthorized","chat_not_allowed",true], [403,"chat_not_allowed","chat_not_allowed",true], [404,"not_found","bot_not_in_chat",true],
  [409,"clone_inactive","bot_not_in_chat",true], [409,"clone_not_in_chat","bot_not_in_chat",true], [413,"too_large","bad_request",true],
  [422,"telegram_rejected","bad_request",true], [426,"unsupported_version","telegram_failed",true], [503,"telegram_unavailable","telegram_failed",true],
  [429,"rate_limited","rate_limited",false],
] as const) test(`unused key ${status}/${code} has explicit fallback=${fallback}`, async () => {
  const relay = await server(() => ({ status, body: { error: { code, retry_after_s: 7 } } }));
  expect(await sendAsClone(relay, "fixture-clone", input())).toMatchObject({ kind: "refused", code: mapped, fallback,
    ...(status === 429 ? { retryAfterSeconds: 7 } : {}) });
});
for (const code of ["send_uncertain", "idempotency_conflict", "unrecognised"] as const)
  test(`409/${code} stops without fallback`, async () => {
    const relay = await server(() => ({ status: 409, body: { error: { code } } }));
    expect(await sendAsClone(relay, "fixture-clone", input())).toEqual({ kind: "uncertain", ...(code === "unrecognised" ? {} : { cause: code }) });
  });

for (const first of ["drop", "500", "in-progress"] as const) test(`${first} retries with the original key and accepts replay`, async () => {
  const keys: string[] = []; let now = 1000;
  const relay = await server((_req, body) => {
    keys.push((body as CloneSendInput).client_key);
    return keys.length > 1 ? { body: cloneReceipt(101, true) } : first === "drop" ? { drop: true }
      : { status: first === "500" ? 500 : 409, body: { error: { code: first === "500" ? "server_error" : "send_in_progress", retry_after_s: 1 } } };
  });
  expect(await sendAsClone(relay, "fixture-clone", input(), { now: () => now, sleep: async ms => { now += ms; } }))
    .toMatchObject({ kind: "sent", replayed: true });
  expect(keys).toEqual([input().client_key, input().client_key]);
});
test("unknown send outcomes exhaust the deadline and later connection failures cannot permit fallback", async () => {
  let now = 1000, count = 0;
  const relay = await server(() => { count++; return { drop: true }; });
  expect(await sendAsClone(relay, "fixture-clone", input(), { now: () => now, deadline: 1300, sleep: async ms => { now += ms; } }))
    .toEqual({ kind: "uncertain" });
  expect(count).toBe(3);
  expect(cloneClientKey("fixture", "caller", "request", 0)).not.toBe(cloneClientKey("fixture", "caller", "request", 1));
  let attempts = 0;
  const laterRefusal = await server(() => ++attempts === 1 ? { drop: true }
    : { status: 503, body: { error: { code: "telegram_unavailable" } } });
  expect(await sendAsClone(laterRefusal, "fixture-clone", input(), { now: () => now, deadline: now + 300,
    sleep: async ms => { now += ms; } })).toEqual({ kind: "uncertain" });
  expect(attempts).toBe(2);
});
test("closed port falls back; oversized payloads and withdrawn authority issue no request; logs contain only fixed metadata", async () => {
  let count = 0;
  const relay = await server(() => { count++; return { body: cloneReceipt() }; });
  const logs: string[] = [], log = spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
  try {
    expect(await sendAsClone(relay, "fixture-clone", input({ text: "a".repeat(4097) }))).toMatchObject({ kind: "refused" });
    expect(clonePayloadSupported(input({ text: "😀".repeat(16385), parse_mode: "HTML" }))).toBe(false);
    expect(clonePayloadSupported(input({ text: "\u0000".repeat(12000), parse_mode: "HTML" }))).toBe(false);
    expect(await sendAsClone(relay, "fixture-clone", input(), { beforeSend: () => { throw new Error(relay.credential); } }))
      .toMatchObject({ kind: "refused", code: "chat_not_allowed" });
    expect(count).toBe(0);
    await sendAsClone(relay, "fixture-clone", input());
    for (const secret of [relay.credential, input().text, String(input().chat_id), input().client_key, "fixture-clone"])
      expect(logs.join("\n")).not.toContain(secret);
    await servers[0]!.close(); servers.shift();
    expect(await sendAsClone(relay, "fixture-clone", input())).toMatchObject({ kind: "refused", code: "network_failed", fallback: true });
  } finally { log.mockRestore(); }
});

test("the real deadline cancels a silent partner in an owned child without falling back", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const relay = await server(async () => { requests++; await held; return { body: cloneReceipt() }; });
  const script = `import {sendAsClone} from './src/lib/externalRelay/cloneSend';
    console.log('clone-test-ready');
    const result = await sendAsClone(JSON.parse(process.env.CLONE_TEST_RELAY), 'fixture-clone', JSON.parse(process.env.CLONE_TEST_INPUT), {deadline: Date.now()+250});
    console.log('clone-test-result:'+JSON.stringify(result));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env,
    CLONE_TEST_RELAY: JSON.stringify(relay), CLONE_TEST_INPUT: JSON.stringify(input()) }, stdout: "pipe", stderr: "pipe" });
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  let output = "";
  const reading = (async () => {
    const reader = child.stdout.getReader();
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        output += Buffer.from(chunk.value).toString(); if (output.includes("clone-test-ready")) ready();
      }
    } finally { reader.releaseLock(); }
  })();
  const errors = new Response(child.stderr).text();
  const bounded = async <T,>(promise: Promise<T>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("owned clone deadline probe exceeded its parent bound")), ms);
    })]); } finally { clearTimeout(timer); }
  };
  try {
    await bounded(readiness, 10000);
    expect(await bounded(child.exited, 5000)).toBe(0);
    await reading;
    expect(await errors).toBe("");
    expect(output).toContain('clone-test-result:{"kind":"uncertain"}');
    expect(requests).toBe(1);
  } finally {
    release();
    if (child.exitCode === null) child.kill();
    await child.exited; await reading; await errors;
  }
});
