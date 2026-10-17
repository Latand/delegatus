import { afterEach, expect, test } from "bun:test";
import { startTaskChannel } from "./taskChannelServer";
import { callTaskChannel, decodeTaskChannel, encodeTaskChannel, TASK_CHANNEL_INPUT_BYTES,
  TASK_CHANNEL_METADATA_BYTES, TASK_CHANNEL_REPLY_BYTES, type TaskChannelRequest, type TaskChannelResponse } from "./taskChannel";

const servers: Array<NonNullable<Awaited<ReturnType<typeof startTaskChannel>>>> = [];
const capability = "a".repeat(43);
const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
afterEach(() => { for (const server of servers.splice(0)) server.close(); });
const linux = test.skipIf(process.platform !== "linux");

async function fixture(dispatch: (body: unknown, signal: AbortSignal) => Promise<TaskChannelResponse>, onRelease = () => {}) {
  let identified = 0, admitted = 0;
  const server = await startTaskChannel({
    identify: token => { identified++; return token === capability ? "conversation_fixture" : null; },
    admit: () => {
      admitted++;
      const controller = new AbortController(); let closed = false;
      return { signal: controller.signal, cancel: () => controller.abort(), close: () => {
        if (!closed) { closed = true; admitted--; onRelease(); }
      } };
    },
    dispatch: (body, _capability, _headers, signal) => dispatch(body, signal),
  });
  if (!server) throw new Error("fixture task channel could not start");
  servers.push(server);
  return { ...server, counts: () => ({ identified, admitted }) };
}

test("invalid or non-abstract task channel descriptors are refused", () => {
  for (const value of [null, "not-json", Buffer.from('{}').toString("base64url"),
    Buffer.from(JSON.stringify({ socketPath: "/foreign/socket", nonce: "a".repeat(43), identity: { pid: 1 } })).toString("base64url")]) {
    expect(decodeTaskChannel(value)).toBeNull();
  }
});

linux("a task channel pins the kernel identity and process start before sending credentials", async () => {
  let calls = 0;
  const server = await fixture(async () => { calls++; return { status: 200, headers: [], body: "{}" }; });
  expect(decodeTaskChannel(encodeTaskChannel(server.channel)) !== null).toBe(true);
  for (const identity of [
    { ...server.channel.identity, pid: server.channel.identity.pid + 1 },
    { ...server.channel.identity, startIdentity: `${server.channel.identity.startIdentity}:stale` },
    { ...server.channel.identity, bootEpoch: `${server.channel.identity.bootEpoch}:stale` },
  ]) {
    await expect(callTaskChannel({ ...server.channel, identity }, "{}", capability, headers, Date.now() + 30_000, new AbortController().signal))
      .rejects.toThrow("worker identity changed");
  }
  expect(calls).toBe(0); expect(server.counts()).toEqual({ identified: 0, admitted: 0 });
  expect((await callTaskChannel(server.channel, "{}", capability, headers, Date.now() + 30_000, new AbortController().signal)).status).toBe(200);
  expect(calls).toBe(1);
});

linux("the delegation nonce is checked before capability lookup or body admission", async () => {
  let calls = 0;
  const server = await fixture(async () => { calls++; return { status: 200, headers: [], body: "{}" }; });
  const answer = await callTaskChannel({ ...server.channel, nonce: "z".repeat(43) }, "{}", capability, headers, Date.now() + 30_000, new AbortController().signal);
  expect(answer.status).toBe(403); expect(calls).toBe(0); expect(server.counts()).toEqual({ identified: 0, admitted: 0 });
});

linux("task channel cancellation releases admission after the interrupted dispatch settles", async () => {
  let entered!: () => void, released!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const done = new Promise<void>(resolve => { released = resolve; });
  const server = await fixture(async (_body, signal) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  }, released);
  const controller = new AbortController();
  const pending = callTaskChannel(server.channel, "{}", capability, headers, Date.now() + 30_000, controller.signal);
  void pending.catch(() => {});
  await started; controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await done; expect(server.counts().admitted).toBe(0);
});

linux("task channel input admits exact UTF-8 bytes and refuses an additional astral character", async () => {
  let calls = 0;
  const server = await fixture(async body => {
    calls++;
    return { status: 200, headers: [], body: JSON.stringify({ bytes: Buffer.byteLength(body as string) }) };
  });
  const deadlineAt = Date.now() + 30_000;
  const metadata: TaskChannelRequest = { nonce: server.channel.nonce, capability, deadlineAt, bytes: TASK_CHANNEL_INPUT_BYTES, headers: [...headers] };
  const budget = TASK_CHANNEL_INPUT_BYTES - Buffer.byteLength(JSON.stringify(metadata)) - 2;
  const text = "🙂".repeat(Math.floor((budget - 2) / 4)) + "x".repeat((budget - 2) % 4);
  const body = JSON.stringify(text);
  expect(Buffer.byteLength(body)).toBe(budget);
  const accepted = await callTaskChannel(server.channel, body, capability, headers, deadlineAt, new AbortController().signal);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ bytes: budget - 2 });
  await expect(callTaskChannel(server.channel, JSON.stringify(text + "🙂"), capability, headers, deadlineAt, new AbortController().signal))
    .rejects.toThrow("input exceeds its bound");
  expect(calls).toBe(1);
});

linux("task channel metadata is bounded before opening its connection", async () => {
  let calls = 0;
  const server = await fixture(async () => { calls++; return { status: 200, headers: [], body: "{}" }; });
  await expect(callTaskChannel(server.channel, "{}", capability, new Headers({ accept: "x".repeat(TASK_CHANNEL_METADATA_BYTES) }),
    Date.now() + 30_000, new AbortController().signal)).rejects.toThrow("input exceeds its bound");
  expect(calls).toBe(0); expect(server.counts()).toEqual({ identified: 0, admitted: 0 });
});

linux("task channel reply bounds include metadata and both delimiters", async () => {
  const replyHeaders: [string, string][] = [["content-type", "application/json"]];
  const header = JSON.stringify({ status: 200, headers: replyHeaders });
  const bytes = TASK_CHANNEL_REPLY_BYTES - Buffer.byteLength(header) - 2;
  let body = "x".repeat(bytes);
  const server = await fixture(async () => ({ status: 200, headers: replyHeaders, body }));
  const accepted = await callTaskChannel(server.channel, "{}", capability, headers, Date.now() + 30_000, new AbortController().signal);
  expect(accepted.status).toBe(200); expect((await accepted.text()).length).toBe(bytes);
  body += "x";
  const refused = await callTaskChannel(server.channel, "{}", capability, headers, Date.now() + 30_000, new AbortController().signal);
  expect(refused.status).toBe(503); expect(server.counts().admitted).toBe(0);
}, 15_000);
