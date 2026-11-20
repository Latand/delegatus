// Adapted from the retained verifier scratch test; long pending uses a virtual clock.
import { test, expect, spyOn } from "bun:test";
import path from "node:path";
import samples from "./fixtures/relay_v1/action_finality.json";
import { toolCallResultSchema, requestSchema } from "./protocol";
import { createToolLoop, callBody } from "./toolLoop";
import { x1Request } from "./toolLoop.fixture";
import { actionOutcomeAnswer } from "./actionOutcome";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";
const receiptReadLimit = 3;
type SampleName = keyof typeof samples;
const sampleNames = Object.keys(samples) as SampleName[];
const resultFor = (name: SampleName) => {
  const sample = samples[name];
  if (!("result" in sample)) throw new Error("sample has no result");
  return toolCallResultSchema.parse(sample.result);
};
function requestFor(name: SampleName) {
  const request = x1Request("actions_admin");
  request.request_id = "finality_" + name;
  request.input.tools = [...new Map(sampleNames.filter(name => "result" in samples[name]).map(name => [samples[name].request.tool, {
    name: samples[name].request.tool, summary: "Synthetic operation", mode: "direct" as const, effect: resultFor(name).effect,
    parameters: { type: "object", additionalProperties: true }, audience: "admin" as const
  }])).values()];
  return requestSchema.parse(request);
}
const callFor = (name: SampleName) => ({tool: samples[name].request.tool, arguments: JSON.stringify(samples[name].request.arguments), cursor: null});
type WireBody = ReturnType<typeof callBody>;
async function setup(name: SampleName, response: (body: WireBody, n: number) => unknown) {
  const request = requestFor(name), controller = new AbortController(), posts: WireBody[] = [], waits: number[] = [], progress: unknown[] = [], states: boolean[] = [];
  let clock = 0;
  const server = await startTestRelay((req, raw) => {
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`/v1/requests/${request.request_id}/tool-calls`);
    const body = raw as WireBody; posts.push(body); return { body: response(body, posts.length) }; });
  const paired = {api_base: server.origin + "/v1", credential: "x".repeat(43)} as PairedRelay;
  const makeLoop = (overrides: Partial<Parameters<typeof createToolLoop>[2]> = {}) => createToolLoop(paired, request, {signal: controller.signal, ack: async () => true, lose: () => controller.abort(), ...overrides},
    {now: () => clock, monotonicNow: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }},
    (...args) => progress.push(args), pending => states.push(pending));
  return {request, posts, waits, progress, states, makeLoop, advance: (ms: number) => { clock += ms; }, close: server.close};
}
test("all 13 producer results preserve every supplied field", () => {
  const rows = sampleNames.filter(name => "result" in samples[name]).map(name => [name, resultFor(name)] as const);
  expect(rows).toHaveLength(13);
  for (const name of sampleNames) {
    const sample = samples[name];
    if ("result" in sample) expect<unknown>(toolCallResultSchema.parse(sample.result)).toEqual(sample.result);
  }
});
for (const name of sampleNames.filter(name => "result" in samples[name] && name !== "image_pending")) test("producer sample through real loop: " + name, async () => {
  const run = await setup(name, body => ({...resultFor(name), call_id: body.call_id}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor(name)], 1);
    expect(run.posts).toHaveLength(name === "external_unknown" ? 1 + receiptReadLimit : 1);
    if (name === "scope_loss_denied") expect(loop.results[0]?.outcome).toBe("verification_failed");
    else expect(loop.results[0]?.status).toBe(resultFor(name).status);
    expect(loop.records[0]?.replayed).toBe(resultFor(name).replayed);
  } finally { await run.close(); }
});
for (const settle of ["image_delivered", "image_refunded", "external_unknown"] as const) test("300 seconds pending then " + settle, async () => {
  const run = await setup("image_pending", (body, n) => ({...resultFor(n <= 60 ? "image_pending" : settle), tool: body.tool, call_id: body.call_id}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("image_pending")], 1);
    expect(run.posts).toHaveLength(61 + (settle === "external_unknown" ? receiptReadLimit : 0));
    expect(run.waits).toEqual([...Array(60).fill(5000), ...(settle === "external_unknown" ? Array(receiptReadLimit).fill(1000) : [])]);
    expect(new Set(run.posts.map(body => JSON.stringify(body))).size).toBe(1);
    expect(loop.results).toHaveLength(1);
    expect(loop.results[0]?.status).toBe(resultFor(settle).status);
    expect(loop.records).toHaveLength(1);
    expect(loop.results[0]?.delivered).toBe(settle === "image_delivered" ? true : undefined);
    expect(loop.callsLeft()).toBe(0);
    expect(run.states).toEqual([true, false]);
  } finally { await run.close(); }
});
for (const status of ["ok", "error"]) for (const output of ["", "Дію виконано.", "Дію…"]) test("empty/localized/truncated " + status + JSON.stringify(output), async () => {
  const run = await setup("nonterminal_applied", body => ({...resultFor("nonterminal_applied"), call_id: body.call_id, status, output, truncated: output.endsWith("…")}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("nonterminal_applied")], 1);
    expect(loop.results[0]).toMatchObject({status, output, truncated: output.endsWith("…")});
    expect(loop.results[0]?.next_cursor).toBeUndefined();
    expect(run.posts).toHaveLength(1);
  } finally { await run.close(); }
});
for (const status of ["ok", "error", "confirmation_pending"] as const) test("unknown receipt reconciles to " + status, async () => {
  const run = await setup("external_unknown", (body, n) => ({...resultFor("external_unknown"), call_id: body.call_id,
    ...(n === 2 ? {status: "pending", calls_remaining: 0, replayed: false, retry_after_s: 5} : {}),
    ...(n >= 3 ? {status, replayed: true, calls_remaining: 16, output: status === "confirmation_pending" ? "" : "Generic summary."} : {})}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(3);
    expect(run.waits).toEqual([1000, 5000]);
    expect(run.posts.every(body => JSON.stringify(body) === JSON.stringify(run.posts[0]))).toBe(true);
    expect(loop.results).toHaveLength(1);
    expect(loop.results[0]).toMatchObject({status});
    expect(loop.results[0]?.execution_unknown).toBeUndefined();
    expect(loop.records[0]).toMatchObject({status, replayed: true});
    expect(loop.sawUnknown).toBe(false);
    expect(loop.callsLeft()).toBe(0);
    await loop.runCalls([callFor("external_unknown")], 2);
    expect(run.posts).toHaveLength(3);
    expect(loop.results.filter(row => row.status === status)).toHaveLength(1);
    if (status === "confirmation_pending") expect(actionOutcomeAnswer(run.request, loop.results)?.text).toBe(
      "A confirmation for create_poll was posted in the chat. Its eventual outcome is not visible to me.");
  } finally { await run.close(); }
});
test("unknown remains unknown after three same-call reads, even if compensation stays pending", async () => {
  const run = await setup("external_unknown", (body, n) => ({...resultFor("external_unknown"), call_id: body.call_id,
    ...(n > 1 ? {status: "pending", calls_remaining: 0, retry_after_s: 5} : {})}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(4);
    expect(run.waits).toEqual([1000, 5000, 5000, 5000]);
    expect(loop.results[0]).toMatchObject({status: "outcome_unknown", execution_unknown: true});
    expect(loop.sawUnknown).toBe(true);
    expect(actionOutcomeAnswer(run.request, loop.results)?.text).toBe("The outcome of create_poll remains unknown.");
  } finally { await run.close(); }
});
test("confirmation receipt is never polled, and its later outcome is unavailable", async () => {
  const run = await setup("confirmation_replay", body => ({...resultFor("confirmation_replay"), call_id: body.call_id}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("confirmation_replay")], 1);
    await loop.runCalls([callFor("confirmation_replay")], 2);
    expect(run.posts).toHaveLength(1);
    expect(run.waits).toEqual([]);
    expect(loop.results[0]).toMatchObject({summary: samples.confirmation_replay.result.summary,
      expires_in_s: Math.ceil(Date.parse(samples.confirmation_replay.result.expires_at) / 1000)});
    expect(loop.results[0]).not.toHaveProperty("confirmation_id");
    expect(actionOutcomeAnswer(run.request, loop.results)?.text).toBe(
      "A confirmation for request_kick_participant was posted in the chat. Its eventual outcome is not visible to me.");
  } finally { await run.close(); }
});
for (const calls_remaining of [0, 16]) test("saved replay budget is ignored: " + calls_remaining, async () => {
  const run = await setup("nonterminal_applied", body => ({...resultFor("nonterminal_applied"), call_id: body.call_id, replayed: true, calls_remaining}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("nonterminal_applied")], 1);
    expect(loop.callsLeft()).toBe(15);
    expect(loop.results[0]?.status).toBe("ok");
  } finally { await run.close(); }
});
for (const action of [true, false]) test("only a read exposes a paging cursor: " + action, async () => {
  const name = action ? "nonterminal_applied" : "fresh_read_after_unknown";
  const run = await setup(name, body => ({...resultFor(name), call_id: body.call_id, truncated: true, cursor: "c".repeat(32)}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor(name)], 1);
    expect(loop.results[0]?.next_cursor).toBe(action ? undefined : "c".repeat(32));
    expect(loop.results[0]).toMatchObject({status: "ok", truncated: true, output: resultFor(name).output});
    expect(run.posts).toHaveLength(1);
  } finally { await run.close(); }
});
test("same error call is cached and never automatically retried", async () => {
  const run = await setup("paid_voice_refused", body => ({...resultFor("paid_voice_refused"), call_id: body.call_id}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("paid_voice_refused")], 1);
    await loop.runCalls([callFor("paid_voice_refused")], 2);
    expect(run.posts).toHaveLength(1);
    expect(run.waits).toEqual([]);
    expect(loop.results).toHaveLength(1);
  } finally { await run.close(); }
});
test("changed argument HTTP 409 is conservative uncertainty", async () => {
  const request = requestFor("changed_argument_conflict"), controller = new AbortController();
  const server = await startTestRelay(() => ({status: 409, body: JSON.parse(samples.changed_argument_conflict.error)}));
  try {
    const loop = createToolLoop({api_base: server.origin + "/v1", credential: "x".repeat(43)} as PairedRelay, request,
      {signal: controller.signal, ack: async()=>true, lose:()=>controller.abort()}, {sleep: async()=>{}});
    await loop.runCalls([callFor("changed_argument_conflict")], 1);
    expect(loop.sawUnknown).toBe(true);
  } finally { await server.close(); }
});

for (const phase of ["next", "expired"] as const) test("generic receipt read bound survives real process restarts: " + phase, async () => {
  const posts: unknown[] = [];
  const server = await startTestRelay((_req, raw) => {
    const body = raw as { call_id: string; tool: string };
    posts.push(body);
    return { body: {...resultFor("external_unknown"), call_id: body.call_id, tool: body.tool,
      replayed: posts.length > 1, calls_remaining: posts.length === 1 ? 0 : 16} };
  });
  const client = async (step: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "actionOutcome.client.fixture.ts"),
      server.origin, "generic_restart_" + phase, step, "create_poll"], { stdout: "pipe", stderr: "pipe", env: {...process.env} });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({exit, stderr}).toEqual({exit: 0, stderr: ""});
    return stdout ? JSON.parse(stdout) : [];
  };
  try {
    await client("crash");
    expect(posts).toHaveLength(1);
    for (let generation = 0; generation < 3; generation++) {
      const results = await client(phase);
      expect(results[0]).toMatchObject({status: "outcome_unknown"});
      expect(actionOutcomeAnswer(requestFor("external_unknown"), results)?.text).toBe(phase === "next" && generation === 0
        ? "The outcome of create_poll remains unknown."
        : "Verification failed for create_poll: the saved action outcome could not be read. The outcome remains unknown.");
      expect(posts).toHaveLength(phase === "expired" ? 1 : 4);
    }
    expect(new Set(posts.map(body => JSON.stringify(body))).size).toBe(1);
  } finally { await server.close(); }
});

for (const seam of ["ack", "reservation", "send"] as const) test("a stalled reread is stopped after " + seam, async () => {
  const run = await setup("external_unknown", body => ({...resultFor("external_unknown"), call_id: body.call_id}));
  let acks = 0, sends = 0;
  try {
    const loop = run.makeLoop({
      ack: async () => { if (++acks === 2 && seam === "ack") run.advance(360_000); return true; },
      verificationBudget: async (_id, deadlineAt, consume) => {
        if (consume === true && seam === "reservation") run.advance(360_000);
        return { deadlineAt, reads: 0, allowed: true };
      },
      beforeSend: async () => { if (++sends === 2 && seam === "send") run.advance(360_000); },
    });
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(1);
    expect(loop.results[0]?.status).toBe("outcome_unknown");
    expect(loop.sawUnknown).toBe(true);
  } finally { await run.close(); }
});
test("lease loss during receipt reread stops the same call", async () => {
  const run = await setup("external_unknown", body => ({...resultFor("external_unknown"), call_id: body.call_id}));
  let acks = 0;
  try {
    const loop = run.makeLoop({ack: async () => ++acks < 2});
    await expect(loop.runCalls([callFor("external_unknown")], 1)).rejects.toThrow();
    expect(run.posts).toHaveLength(1);
  } finally { await run.close(); }
});

for (const status of ["confirmation_pending", "outcome_unknown"] as const) test("declared action preserves " + status, async () => {
  const run = await setup("local_applied", body => ({...resultFor("local_applied"), call_id: body.call_id, status}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("local_applied")], 1);
    expect(run.posts).toHaveLength(status === "confirmation_pending" ? 1 : 4);
    expect(loop.results[0]?.status).toBe(status);
    const answer = actionOutcomeAnswer(run.request, loop.results);
    expect(answer?.action).toBe("reply");
    expect(answer?.text).toBe(status === "confirmation_pending"
      ? "A confirmation for trigger rule update was posted in the chat. Its eventual outcome is not visible to me."
      : "Verification failed for trigger rule update: the saved action outcome could not be read. The outcome remains unknown.");
    run.request.input.request_text = "Виконай дію";
    expect(actionOutcomeAnswer(run.request, loop.results)?.text).toBe(status === "confirmation_pending"
      ? "Підтвердження для дії «оновлення правила тригера» опубліковано в чаті. Його подальший результат мені недоступний."
      : "Не вдалося перевірити результат дії «оновлення правила тригера»: збережений результат недоступний. Результат залишається невідомим.");
  } finally { await run.close(); }
});

for (const status of ["ok", "error"] as const) test("unknown at zero budget resolves without a new action: " + status, async () => {
  const run = await setup("external_unknown", (body, n) => ({...resultFor("external_unknown"), call_id: body.call_id,
    calls_remaining: n === 1 ? 0 : 16, replayed: n > 1, ...(n > 1 ? {status, output: "Resolved summary."} : {})}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(2);
    expect(run.posts[1]).toEqual(run.posts[0]);
    expect(loop.results).toHaveLength(1);
    expect(loop.results[0]).toMatchObject({status, output: "Resolved summary."});
    expect(loop.callsLeft()).toBe(0);
    expect(loop.sawUnknown).toBe(false);
  } finally { await run.close(); }
});

for (const code of ["unavailable", "not_permitted"] as const) test("receipt read refusal preserves the earlier unknown outcome: " + code, async () => {
  const run = await setup("external_unknown", (body, n) => ({...resultFor("external_unknown"), call_id: body.call_id,
    output: n === 1 ? "Synthetic earlier detail" : "",
    ...(n > 1 ? {status: "denied", code, calls_remaining: 0, retry_after_s: 5} : {})}));
  try {
    const loop = run.makeLoop();
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(code === "unavailable" ? 4 : 2);
    expect(loop.results[0]).toMatchObject({status: "outcome_unknown", output: "", code, execution_unknown: true});
    expect(actionOutcomeAnswer(run.request, loop.results)?.text).toBe("The outcome of create_poll remains unknown.");
  } finally { await run.close(); }
});

for (const shortDeadline of [false, true]) test("persisted deadline uses wall time with a virtual loop clock: " + shortDeadline, async () => {
  const wall = 2_000_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(wall);
  const run = await setup("external_unknown", (body, n) => ({...resultFor("external_unknown"), call_id: body.call_id,
    calls_remaining: 0, replayed: n > 1, ...(n > 1 ? {status: "ok"} : {})}));
  const reservations: (boolean | "send")[] = [];
  try {
    const loop = run.makeLoop({...(shortDeadline ? {deadlineAt: 2000} : {}),
      verificationBudget: async (_id, deadlineAt, consume) => {
        expect(deadlineAt).toBe(wall + (shortDeadline ? 1000 : 360_000));
        reservations.push(consume);
        return {deadlineAt, reads: consume === true ? 1 : 0, allowed: true};
      },
    });
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(shortDeadline ? 1 : 2);
    expect(reservations).toEqual(shortDeadline ? ["send"] : ["send", true]);
    expect(loop.results[0]?.status).toBe(shortDeadline ? "outcome_unknown" : "ok");
  } finally { clock.mockRestore(); await run.close(); }
});

for (const unavailable of [false, true]) test("a missing saved bound stops before dispatch: " + unavailable, async () => {
  const run = await setup("external_unknown", body => ({...resultFor("external_unknown"), call_id: body.call_id}));
  try {
    const loop = run.makeLoop({verificationBudget: async (_id, deadlineAt) => {
      if (unavailable) throw new Error("Synthetic unavailable bound");
      return {deadlineAt, reads: 3, allowed: false, recovering: true};
    }});
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(run.posts).toHaveLength(0);
    expect(loop.results[0]?.status).toBe("outcome_unknown");
    expect(loop.sawUnknown).toBe(true);
    if (unavailable) expect(loop.records[0]?.code).toBe("verification_bound_unavailable");
  } finally { await run.close(); }
});

for (const status of [400, 401, 413, 426]) test("HTTP receipt refusal cannot erase the unknown outcome: " + status, async () => {
  const request = requestFor("external_unknown"), controller = new AbortController(), posts: WireBody[] = [];
  const server = await startTestRelay((_req, raw) => {
    const body = raw as WireBody;
    posts.push(body);
    return posts.length === 1
      ? {body: {...resultFor("external_unknown"), call_id: body.call_id, output: "Synthetic earlier detail"}}
      : {status, body: {error: {code: "refused"}}};
  });
  try {
    const loop = createToolLoop({api_base: server.origin + "/v1", credential: "x".repeat(43)} as PairedRelay, request,
      {signal: controller.signal, ack: async () => true, lose: () => controller.abort()}, {sleep: async () => {}});
    await loop.runCalls([callFor("external_unknown")], 1);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(loop.results[0]).toMatchObject({status: "outcome_unknown", code: "refused", output: "", execution_unknown: true});
    expect(loop.sawUnknown).toBe(true);
    expect(loop.actionSent).toBe(true);
    expect(actionOutcomeAnswer(request, loop.results)?.text).toBe("The outcome of create_poll remains unknown.");
  } finally { await server.close(); }
});
