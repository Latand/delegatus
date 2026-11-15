import { expect, test } from "bun:test";
import { relayRetrySleep } from "./rateLimit";
import { createToolLoop } from "./toolLoop";
import { x1Request, x1Results } from "./toolLoop.fixture";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";

const epoch = Date.parse("2026-11-15T12:00:00Z");
const call = (index: number) => ({ tool: "get_media", arguments: JSON.stringify({ index }), cursor: null });
const readRequest = () => {
  const request = x1Request("member");
  request.input.tools = [{ name: "get_media", summary: "Read media", mode: "direct", effect: "read", parameters: { type: "object" } }];
  return request;
};
const limited = (form: string, body: { call_id: string; tool: string }, seconds = 1) => {
  if (form === "object") return { status: 429, body: { error: { code: "rate_limited", retry_after_s: seconds } } };
  if (form === "array") return { status: 429, body: { error: [{ code: "rate_limited", retry_after: seconds }] } };
  if (form === "header") return { status: 429, headers: { "retry-after": String(seconds) }, body: { error: { code: "rate_limited" } } };
  return { body: { ...x1Results.ok, ...body, status: form, output: "Transfer busy", code: "rate_limited", retry_after_s: seconds } };
};

for (const retrySeconds of [1, 7, 60])
for (const form of ["object", "array", "header", "denied", "error"]) test(`three parallel reads recover the third ${form} ${retrySeconds}s rate limit before projecting to the model`, async () => {
  const posts: { call_id: string; tool: string; arguments: { index: number } }[] = [];
  let active = 0, maximum = 0, time = epoch;
  let refusedAt: number | undefined;
  let release!: () => void;
  const firstPair = new Promise<void>(resolve => { release = resolve; });
  const server = await startTestRelay(async (_req, raw) => {
    const body = raw as typeof posts[number]; posts.push(body);
    if (posts.length === 3) { refusedAt = time; release(); }
    if (body.arguments.index === 3 && refusedAt !== undefined && time < refusedAt + retrySeconds * 1000) return limited(form, body, retrySeconds);
    active++; maximum = Math.max(maximum, active);
    if (posts.length <= 2) await firstPair;
    active--;
    return { body: { ...x1Results.ok, call_id: body.call_id, tool: body.tool, output: `Photo ${body.arguments.index}` } };
  });
  const waits: number[] = [];
  const controller = new AbortController();
  const loop = createToolLoop({ api_base: `${server.origin}/v1`, credential: "x".repeat(43) } as PairedRelay,
    readRequest(), { signal: controller.signal, ack: async () => true, lose: () => controller.abort(), deadlineAt: epoch + 120000 },
    { now: () => time, sleep: async ms => { waits.push(ms); time += ms; await firstPair; } });
  try {
    await loop.runCalls([call(1), call(2), call(3)], 1);
    expect(loop.results.map(result => ({ status: result.status, output: result.output }))).toEqual(
      [1, 2, 3].map(index => ({ status: "ok", output: `Photo ${index}` })));
    expect(posts).toHaveLength(4);
    expect(posts[3]).toEqual(posts[2]);
    expect(waits).toEqual([retrySeconds * 1000]);
    expect(maximum).toBe(2);
  } finally { release(); await server.close(); }
});

async function boundedCase(form: string, config: { deadlineMs?: number; wakeLate?: boolean; abort?: boolean; action?: boolean; revoke?: boolean; beforeSendLate?: boolean; nativeAbort?: boolean; seconds?: number } = {}) {
  let time = epoch, posts = 0, sends = 0;
  const waits: number[] = [];
  const controller = new AbortController();
  const bodies: unknown[] = [];
  const server = await startTestRelay((_req, raw) => {
    posts++; bodies.push(raw);
    const response = limited(form, raw as { call_id: string; tool: string }, config.seconds ?? 1);
    if (config.action && response.body && "effect" in response.body) response.body.effect = "action";
    return response;
  });
  const request = readRequest();
  if (config.action) request.input.tools![0]!.effect = "action";
  const loop = createToolLoop({ api_base: `${server.origin}/v1`, credential: "x".repeat(43) } as PairedRelay, request,
    { signal: controller.signal, ack: async () => true, lose: () => controller.abort(), deadlineAt: epoch + (config.deadlineMs ?? 10000),
      beforeSend: () => { if (++sends === 2) { if (config.revoke) controller.abort(new Error("lease revoked")); if (config.beforeSendLate) time = epoch + 10000; } } },
    { now: () => time, sleep: async (ms, signal) => {
      waits.push(ms); time += config.wakeLate ? 10000 : ms;
      if (config.nativeAbort) {
        const sleeping = relayRetrySleep(ms, signal);
        controller.abort(new Error("cancelled"));
        await sleeping;
      }
      if (config.abort) { controller.abort(new Error("cancelled")); signal.throwIfAborted(); }
    } });
  try {
    if (config.abort || config.nativeAbort || config.revoke) await expect(loop.runCalls([call(1)], 1)).rejects.toThrow(config.abort || config.nativeAbort ? "cancelled" : "lease revoked");
    else await loop.runCalls([call(1)], 1);
    return { posts, waits, results: loop.results, bodies };
  } finally { await server.close(); }
}
for (const form of ["object", "denied", "error"]) {
  test(`${form} retries stop after three waits and preserve the wire identity`, async () => {
    const run = await boundedCase(form);
    expect(run.posts).toBe(4); expect(run.waits).toEqual([1000, 1000, 1000]);
    expect(new Set(run.bodies.map(body => JSON.stringify(body))).size).toBe(1);
    expect(run.results[0]).toMatchObject({ status: form === "object" ? "error" : form, code: "rate_limited" });
  });
  for (const deadlineMs of [500, 1000]) test(`${form} refuses without waiting when ${deadlineMs}ms remain`, async () => {
    const run = await boundedCase(form, { deadlineMs });
    expect(run.posts).toBe(1); expect(run.waits).toEqual([]); expect(run.results[0]!.status).not.toBe("ok");
  });
  test(`${form} never sends after a late wake`, async () => {
    const run = await boundedCase(form, { wakeLate: true });
    expect(run.posts).toBe(1); expect(run.waits).toEqual([1000]);
  });
  test(`${form} cancellation during its wait prevents another send`, async () => {
    const run = await boundedCase(form, { abort: true });
    expect(run.posts).toBe(1); expect(run.waits).toEqual([1000]);
  });
  test(`${form} rechecks lease authorization after waiting`, async () => {
    const run = await boundedCase(form, { revoke: true }); expect(run.posts).toBe(1);
  });
  test(`${form} rechecks the deadline after beforeSend awaits`, async () => {
    const run = await boundedCase(form, { beforeSendLate: true }); expect(run.posts).toBe(1);
  });
}
for (const seconds of [0, 120]) test(`HTTP read retry clamps ${seconds}s`, async () => {
  const run = await boundedCase("object", { seconds, deadlineMs: 300000 });
  expect(run.waits).toEqual(Array(3).fill(Math.min(60, Math.max(1, seconds)) * 1000));
});
for (const form of ["denied", "error"]) test(`an action ${form} rate-limit result does not prove non-admission`, async () => {
  const run = await boundedCase(form, { action: true }); expect(run.posts).toBe(1); expect(run.waits).toEqual([]);
});

test("a cancelled native retry timer settles the real tool loop and releases the timer", async () => {
  const run = await boundedCase("object", { nativeAbort: true });
  expect(run.posts).toBe(1); expect(run.waits).toEqual([1000]);
});
