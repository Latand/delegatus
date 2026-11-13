import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolLoop, type ToolLoopRuntime } from "./toolLoop";
import { x1Request } from "./toolLoop.fixture";
import type { PairedRelay } from "./store";
import { actionOutcomeAnswer, establishActionOutcome } from "./actionOutcome";
import { answerRecorder, readAnswerRecord } from "./answers";
import { startTestRelay } from "./testRelay";

const call = { tool: "request_trigger_rule_update", arguments: JSON.stringify({ name: "Sample rule", filter: { words: ["sample"] }, action: { text: "Sample reply" } }), cursor: null };

async function client(origin: string, id: string, phase = "next") {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "actionOutcome.client.fixture.ts"), origin, id, phase],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return stdout ? JSON.parse(stdout) as { outcome: string }[] : [];
}

for (const version of ["next", "legacy"]) test(`restart and authorization refusal preserve uncertainty about an applied action: ${version}`, async () => {
  let posts = 0, effects = 0, revoked = false;
  const peer = await startTestRelay(() => {
    posts++;
    if (revoked) return { status: 401, body: { error: { code: "unauthorized" } } };
    effects++; return { drop: true };
  });
  try {
    const id = `restart_authorization_${version}`;
    await client(peer.origin, id, "crash");
    expect({ posts, effects }).toEqual({ posts: 1, effects: 1 });
    revoked = true;
    expect((await client(peer.origin, id, version))[0]?.outcome).toBe("verification_failed");
    expect({ posts, effects }).toEqual({ posts: 2, effects: 1 });
  } finally { await peer.close(); }
});

test("a crash at the emission boundary leaves a durable recovery marker", async () => {
  let posts = 0;
  const peer = await startTestRelay(() => { posts++; return { status: 401, body: { error: { code: "unauthorized" } } }; });
  try {
    await client(peer.origin, "restart_before_emission", "before_send_crash");
    expect(posts).toBe(0);
    expect((await client(peer.origin, "restart_before_emission"))[0]?.outcome).toBe("verification_failed");
    expect(posts).toBe(1);
  } finally { await peer.close(); }
});

for (const seam of ["budget", "initial send"]) test(`the initial action cannot emit after a stall in ${seam}`, async () => {
  const peer = await service("lost");
  let clock = 0;
  try {
    const loop = peer.loop(false, { now: () => clock, monotonicNow: () => clock }, {
      verificationBudget: async (_id, deadlineAt) => {
        if (seam === "budget") clock = 30_001;
        return { deadlineAt, reads: 0, allowed: true, recovering: false };
      },
      beforeSend: () => { if (seam === "initial send") clock = 30_001; },
    });
    await loop.runCalls([call], 1);
    expect(loop.results[0]?.outcome).toBe("verification_failed");
    expect((await peer.state()).calls).toBe(0);
  } finally { await peer.close(); }
});

for (const phase of ["next", "expired"]) test(`real client restarts cannot replenish the action bound: ${phase}`, async () => {
  let posts = 0;
  const peer = await startTestRelay((_req, raw) => {
    const body = raw as { call_id: string; tool: string };
    posts++;
    return { body: { ...body, effect: "action", status: "outcome_unknown", output: "", truncated: false,
      delivered: false, replayed: posts > 1, calls_remaining: 0 } };
  });
  try {
    const id = `restart_bound_${phase}`;
    expect((await client(peer.origin, id, phase === "expired" ? "crash" : "next"))[0]?.outcome)
      .toBe(phase === "expired" ? undefined : "verification_failed");
    const initialPosts = posts;
    for (let generation = 0; generation < 3; generation++) {
      expect((await client(peer.origin, id, phase))[0]?.outcome).toBe("verification_failed");
      expect(posts).toBe(initialPosts);
    }
    expect(posts).toBe(phase === "expired" ? 1 : 4);
  } finally { await peer.close(); }
});

test("pending action status respects the original request deadline", async () => {
  let clock = 0, posts = 0;
  const peer = await startTestRelay((_req, raw) => {
    const body = raw as { call_id: string; tool: string };
    posts++;
    return { body: { ...body, effect: "action", status: posts === 1 ? "pending" : "ok", retry_after_s: 60,
      output: "", truncated: false, delivered: false, replayed: posts > 1, calls_remaining: 0 } };
  });
  try {
    const loop = createToolLoop({ api_base: `${peer.origin}/v1`, credential: "x".repeat(43) } as PairedRelay, x1Request("actions_admin"),
      { signal: new AbortController().signal, ack: async () => true, lose: () => { throw new Error("lost"); }, deadlineAt: 2000 },
      { now: () => clock, monotonicNow: () => clock, sleep: async ms => { clock += ms; } });
    await loop.runCalls([call], 1);
    expect(clock).toBeLessThanOrEqual(2000);
    expect(posts).toBe(1);
    expect(loop.results[0]?.outcome).toBe("verification_failed");
  } finally { await peer.close(); }
});
async function service(mode: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-outcome-"));
  const start = async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "actionOutcome.service.fixture.ts"), mode, path.join(directory, "ledger.json")], { stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("fake service did not start");
      line += new TextDecoder().decode(chunk.value);
    }
    return { child, reader, origin: `http://127.0.0.1:${Number(line.trim())}` };
  };
  let running = await start();
  const stop = async () => { running.child.kill(); await running.child.exited; running.reader.releaseLock(); };
  const request = x1Request("actions_admin");
  request.request_id = "outcome_test";
  let stalled = false;
  const loop = (stall: boolean, runtime: ToolLoopRuntime = {}, lease: Partial<Parameters<typeof createToolLoop>[2]> = {}) => createToolLoop({ api_base: `${running.origin}/v1`, credential: "x".repeat(43) } as PairedRelay, request,
    { signal: new AbortController().signal, ack: async () => true, lose: () => { throw new Error("unexpected lease loss"); }, ...lease },
    { sleep: async () => {
      await fetch(`${running.origin}/release`);
      if (stall && !stalled) { stalled = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); }
    }, ...runtime });
  return { loop, restart: async () => { await stop(); running = await start(); },
    release: async () => { await fetch(`${running.origin}/release`); },
    post: (body: unknown) => fetch(`${running.origin}/v1/requests/${request.request_id}/tool-calls`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    state: async () => await (await fetch(`${running.origin}/state`)).json() as { calls: number; effects: number; bodies: unknown[]; order: string[] },
    close: async () => { await stop(); fs.rmSync(directory, { recursive: true }); } };
}

for (const stall of [false, true]) {
  for (const [mode, outcome, effects] of [
    ["lost", "done", 1], ["before_acceptance", "not_done", 0], ["slow", "done", 1], ["unreadable", "verification_failed", 0],
  ] as const) test(`${mode}: definite action outcome${stall ? " after a three-second event-loop stall" : ""}`, async () => {
    const peer = await service(mode);
    try {
      const loop = peer.loop(stall);
      await loop.runCalls([call], 1);
      expect(loop.results[0]).toMatchObject({ outcome });
      const request = x1Request("actions_admin"); request.input.request_text = "Create the sample rule";
      const answer = actionOutcomeAnswer(request, loop.results)!;
      expect(answer.text).toContain(outcome === "done" ? "Done:" : outcome === "not_done" ? "Not done:" : "Verification failed");
      const requestId = `${mode}_${stall}`;
      const recorder = answerRecorder({ requestId, relayId: "test", targetId: "sample", targetName: null, claimedAt: null, input: null })!;
      recorder.finish({ outcome: "answered", answer, delivery: "accepted", toolCalls: loop.records });
      expect(readAnswerRecord("test", "sample", requestId)?.toolCalls?.[0]).toMatchObject({ outcome });
      const state = await peer.state();
      expect(state.effects).toBe(effects);
      expect(state.calls).toBeLessThanOrEqual(4);
      expect(new Set(state.bodies.map(body => JSON.stringify(body))).size).toBe(1);
      expect(loop.records[0]).toMatchObject({ outcome });
      if (mode === "lost") expect(state.order).toEqual(["accepted", "disconnected", "committed", "replayed"]);
      if (mode === "slow") expect(state.order).toEqual(["accepted", "committed", "replayed"]);
      if (mode === "before_acceptance") {
        const retry = peer.loop(false);
        await retry.runCalls([call], 1);
        await peer.loop(false).runCalls([call], 1);
        const after = await peer.state();
        expect(after.effects).toBe(1);
        expect(new Set(after.bodies.map(body => JSON.stringify(body))).size).toBe(1);
        expect(retry.results[0]).toMatchObject({ outcome: "done" });
      }
      if (outcome === "verification_failed") {
        expect(loop.results[0]!.output).toContain("request_trigger_rule_update");
        expect(loop.results[0]!.output).toContain("could not");
        expect(loop.sawUnknown).toBe(true);
      } else expect(loop.sawUnknown).toBe(false);
    } finally { await peer.close(); }
  });
}

for (const mode of ["legacy_denied", "legacy_unknown"]) test(`${mode}: current service reports explicit verification failure`, async () => {
  const peer = await service(mode);
  try {
    const loop = peer.loop(false);
    await loop.runCalls([call], 1);
    expect(loop.results[0]).toMatchObject({ outcome: "verification_failed", code: "verification_failed" });
    expect(loop.results[0]!.output).toContain("request_trigger_rule_update");
    expect((await peer.state()).effects).toBe(0);
  } finally { await peer.close(); }
});

for (const seam of ["sleep", "send", "ack"]) test(`one verification deadline is enforced after ${seam}`, async () => {
  const peer = await service("legacy_unknown");
  let clock = 0, sends = 0, acks = 0;
  try {
    const loop = peer.loop(false, { monotonicNow: () => clock, sleep: async () => { if (seam === "sleep") clock = 30_001; } },
      { ack: async () => { if (++acks === 2 && seam === "ack") clock = 30_001; return true; },
        beforeSend: async () => { if (++sends === 2 && seam === "send") clock = 30_001; } });
    await loop.runCalls([call], 1);
    expect(loop.results[0]).toMatchObject({ outcome: "verification_failed" });
    expect(loop.results[0]!.output).toContain("deadline");
    expect((await peer.state()).calls).toBe(1);
    expect((await peer.state()).effects).toBe(0);
  } finally { await peer.close(); }
});

test("verification reserves completion time inside the original request deadline", async () => {
  const peer = await service("legacy_unknown"); let clock = 0;
  try {
    const loop = peer.loop(false, { now: () => 0, monotonicNow: () => clock, sleep: async () => { clock = 1001; } }, { deadlineAt: 2000 });
    await loop.runCalls([call], 1);
    expect(loop.results[0]).toMatchObject({ outcome: "verification_failed" });
    expect((await peer.state()).calls).toBe(1);
  } finally { await peer.close(); }
});

test("a late successful read cannot turn a spent deadline into done", async () => {
  let clock = 0, reads = 0;
  const result = await establishActionOutcome(call.tool, async () => { reads++; clock = 30_001; return {
    call_id: "a".repeat(43), tool: call.tool, status: "ok", output: "saved", truncated: false, effect: "action", delivered: false, replayed: true, calls_remaining: 0,
  }; }, new AbortController().signal, { now: () => clock, sleep: async () => {} });
  expect(result).toMatchObject({ outcome: "verification_failed" }); expect(reads).toBe(1);
});

test("a settled receipt survives a real service restart and never repeats its effect", async () => {
  const peer = await service("lost");
  try {
    const first = peer.loop(false); await first.runCalls([call], 1);
    const before = await peer.state(); expect(before.effects).toBe(1);
    await peer.restart();
    const replay = peer.loop(false); await replay.runCalls([call], 1);
    const after = await peer.state();
    expect(replay.results[0]).toMatchObject({ outcome: "done" });
    expect(after).toMatchObject({ effects: 1, calls: 1 });
    expect(after.bodies[0]).toEqual(before.bodies[0]);
  } finally { await peer.close(); }
});

test("the fake rejects changed arguments or a changed tool under an accepted call key", async () => {
  const peer = await service("lost");
  try {
    await peer.loop(false).runCalls([call], 1);
    const body = (await peer.state()).bodies[0] as Record<string, unknown>;
    expect((await peer.post({ ...body, arguments: { changed: true } })).status).toBe(409);
    expect((await peer.post({ ...body, tool: "another_action" })).status).toBe(409);
    expect((await peer.state()).effects).toBe(1);
  } finally { await peer.close(); }
});

test("a lost lease before verification sends no recovery read", async () => {
  const peer = await service("legacy_unknown");
  const controller = new AbortController(); let acks = 0;
  try {
    const loop = peer.loop(false, {}, { signal: controller.signal, ack: async () => ++acks === 1, lose: () => controller.abort() });
    await expect(loop.runCalls([call], 1)).rejects.toBeDefined();
    expect((await peer.state()).calls).toBe(1); expect((await peer.state()).effects).toBe(0);
  } finally { await peer.close(); }
});

for (const mode of ["unauthorized", "unsupported_version", "wrong_identity", "wrong_effect"]) test(`${mode}: verification cannot assert an effect`, async () => {
  const peer = await service(mode);
  try {
    const loop = peer.loop(false); await loop.runCalls([call], 1);
    expect(loop.results[0]).toMatchObject({ outcome: "verification_failed" });
    expect((await peer.state()).calls).toBe(mode.startsWith("wrong_") ? 4 : 2);
    expect((await peer.state()).effects).toBe(0);
  } finally { await peer.close(); }
});

test("a definite accepted no-effect receipt fences late writes and survives restart", async () => {
  const peer = await service("fenced");
  try {
    const loop = peer.loop(false); await loop.runCalls([call], 1);
    expect(loop.results[0]).toMatchObject({ outcome: "not_done" });
    await peer.release(); expect((await peer.state()).effects).toBe(0);
    await peer.restart();
    const retry = peer.loop(false); await retry.runCalls([call], 1);
    expect(retry.results[0]).toMatchObject({ outcome: "not_done" });
    await peer.release(); expect((await peer.state()).effects).toBe(0);
  } finally { await peer.close(); }
});

test("verification count and deadline survive client restart, lease change and claim release", () => {
  const modulePath = path.join(import.meta.dir, "store.ts");
  const code = `
    const { claimRelayRequestAsync, reserveRelayActionVerificationAsync, settleRelayRequestClaimAsync } = await import(process.argv[1]);
    const { procBackend } = await import(process.argv[2]);
    const index = Number(process.argv[3]);
    Date.now = () => 2000000000000 + index * 1000;
    const lease = index < 3 ? 'lease_first' : 'lease_next';
    await claimRelayRequestAsync('budget_restart', lease, Date.now() + 5000);
    const state = await reserveRelayActionVerificationAsync('budget_restart', lease, 'saved_call', 2000000030000 + index * 10000, true, 2000000000000 + index * 1000);
    await settleRelayRequestClaimAsync('budget_restart', lease, process.pid, procBackend.processIdentity(process.pid), 'release', null, Date.now() + 5000);
    console.log(JSON.stringify(state));
  `;
  for (let index = 0; index < 4; index++) {
    const child = Bun.spawnSync([process.execPath, "-e", code, modulePath, path.resolve(import.meta.dir, "../proc/index.ts"), String(index)], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ deadlineAt: 2_000_000_030_000, reads: Math.min(3, index + 1), allowed: index < 3 });
  }
});

test("a saved verification deadline stays spent after a fresh process claims the request", () => {
  const code = `
    const { claimRelayRequestAsync, reserveRelayActionVerificationAsync } = await import(process.argv[1]);
    const next = process.argv[2] === 'next';
    Date.now = () => next ? 2000000030001 : 2000000000000;
    await claimRelayRequestAsync('budget_expired', 'lease', Date.now() + 5000);
    console.log(JSON.stringify(await reserveRelayActionVerificationAsync('budget_expired', 'lease', 'saved_call', next ? 2000000060000 : 2000000030000, next, next ? 2000000030001 : 2000000000000)));
  `;
  const first = Bun.spawnSync([process.execPath, "-e", code, path.join(import.meta.dir, "store.ts"), "first"], { env: { ...process.env } });
  expect(first.exitCode).toBe(0);
  const next = Bun.spawnSync([process.execPath, "-e", code, path.join(import.meta.dir, "store.ts"), "next"], { env: { ...process.env } });
  expect(next.exitCode).toBe(0);
  expect(JSON.parse(next.stdout.toString())).toEqual({ deadlineAt: 2_000_000_030_000, reads: 0, allowed: false });
});

test("verification bounds refuse missing authority, invalid saved proof and extra action keys", () => {
  const code = `
    const fs = await import('node:fs');
    const { claimRelayRequestAsync, reserveRelayActionVerificationAsync, externalRelayFile } = await import(process.argv[1]);
    const mode = process.argv[2];
    const request = 'guard_' + mode;
    const until = Date.now() + 30000;
    if (mode !== 'missing') {
      await claimRelayRequestAsync(request, 'lease', until);
      await reserveRelayActionVerificationAsync(request, 'lease', 'saved_call', until, false);
      const file = externalRelayFile('requests'), record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.actionVerifications[request] = mode === 'invalid' ? { saved_call: null }
        : Object.fromEntries(Array.from({length:16}, (_, i) => ['call_' + i, {deadlineAt:until,reads:0}]));
      fs.writeFileSync(file, JSON.stringify(record));
    }
    try { await reserveRelayActionVerificationAsync(request, 'lease', 'saved_call', until, true); }
    catch (error) { console.log(JSON.stringify({code:error.code,lock:fs.existsSync(externalRelayFile('requests')+'.lock')})); }
  `;
  for (const [mode, reason] of [["missing", "verification_claim_unavailable"], ["invalid", "invalid_verification_bound"], ["full", "verification_bound_exhausted"]]) {
    const child = Bun.spawnSync([process.execPath, "-e", code, path.join(import.meta.dir, "store.ts"), mode!], { env: { ...process.env } });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ code: reason, lock: false });
  }
});
