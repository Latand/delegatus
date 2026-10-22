import { afterAll, expect, jest, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import * as client from "./client";
import { advertisedSlots, runClaimedRequest } from "./runner";
import { sweepExternalRelayOrphans } from "./poller";
import type { OwnerRunPorts } from "./ownerRun";
import * as relayStore from "./store";
import { contextRequest } from "./request.fixture";
import { updateRelayStore, readRunLedger, reserveRun, dropRun, type PairedRelay } from "./store";
import { setRelaySwitch } from "./switches";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-request-window-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const epoch = Date.parse("2026-10-22T12:00:00Z");
const poll = () => fs.promises.stat(root).then(() => {});

async function waitFor(check: () => boolean) {
  for (let pass = 0; pass < 2000 && !check(); pass++) {
    jest.advanceTimersByTime(1);
    await poll();
  }
  expect(check()).toBe(true);
}

function fixture(id: string, deadlineMs?: number, hardCapMinutes = 1, holdStop = false, refuseCompletion = false, fallback: "service" | "none" = "service", holdCompletion = false) {
  let now = epoch;
  jest.useFakeTimers();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const quiet = spyOn(console, "info").mockImplementation(() => {});
  const paired: PairedRelay = {
    id: "window_fixture", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1",
    name: "Fixture", description: "", credential: "x".repeat(43),
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: new Date(epoch).toISOString(), paused: false,
    limits: { max_response_bytes: 1_048_576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback, enabled: true,
      engine: "codex", model: "gpt-6-sol", effort: "low", project: null, concurrency: 1, hardCapMinutes, ownerTier: true }],
  };
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  setRelaySwitch("chain_conversations", false);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env },
  } });
  const request = { ...contextRequest, request_id: id, deadline_at: deadlineMs === undefined ? undefined : new Date(epoch + deadlineMs).toISOString(),
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } };
  const heartbeats: number[] = [], completions: { at: number; body: unknown }[] = [], stops: string[] = [];
  let accepted = 0, releaseCompletion!: () => void;
  const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
  const completionExecutionAuthority: boolean[] = [];
  let launchAuthorize: (() => void) | undefined;
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, endpoint, _method, body) => {
    if (endpoint.endsWith("/heartbeat")) heartbeats.push(now - epoch);
    else if (endpoint.endsWith("/complete")) {
      completions.push({ at: now - epoch, body });
      try { launchAuthorize?.(); completionExecutionAuthority.push(true); }
      catch { completionExecutionAuthority.push(false); }
      if (holdCompletion) await completionGate;
      if (refuseCompletion) throw new client.ExternalRelayError("lease_lost", 409);
      accepted++;
    }
    else throw Error("unexpected fixture endpoint");
    return { status: 200, body: { status: "ok" } } as never;
  });
  let release!: () => void, releaseStop!: () => void, observing = false, settled = false;
  const answer = new Promise<void>(resolve => { release = resolve; });
  const stop = new Promise<void>(resolve => { releaseStop = resolve; });
  let pending: ReturnType<typeof runClaimedRequest> | undefined;
  const ports: OwnerRunPorts = {
    launch: async (_body, authorize) => {
      launchAuthorize = authorize;
      return { status: 202, body: { conversationId: `conversation_${id}`, initialMessage: "delivered" } };
    },
    observe: async () => { observing = true; await answer; return { state: "ended", finalText: "Work finished" }; },
    stop: async (_id, action) => { stops.push(action); if (holdStop) await stop; },
  };
  return { paired, request, heartbeats, completions, stops, completionExecutionAuthority, ports, releaseStop: () => releaseStop(), releaseCompletion: () => releaseCompletion(),
    get settled() { return settled; },
    get accepted() { return accepted; },
    async start() {
      pending = runClaimedRequest(paired, request, undefined, { leaseWorker: false, ownerPorts: ports });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => observing || settled);
    },
    async advance(ms: number) {
      // Settle each heartbeat acknowledgement before advancing to the next
      // cadence; moving one wall clock by five minutes would simulate a stall.
      for (let left = ms; left > 0;) {
        const step = Math.min(1000, left); left -= step; now += step;
        jest.advanceTimersByTime(step);
        await poll();
      }
      await poll();
    },
    async answer() { release(); await waitFor(() => settled); return pending!; },
    async result() { await waitFor(() => settled); return pending!; },
    async close() {
      release(); releaseStop(); releaseCompletion();
      if (pending) await waitFor(() => settled);
      await pending;
      if (holdStop) {
        // Recovery may already have removed a delivered row after its stop.
        await waitFor(() => { const row = readRunLedger().runs.find(item => item.requestId === id); return !row || row.ownerTurn?.confirmed === true; });
        dropRun(id);
      }
      wire.mockRestore(); selection.mockRestore(); quiet.mockRestore(); clock.mockRestore(); jest.useRealTimers();
      updateRelayStore(store => ({ ...store, relays: [] }));
    },
  };
}

for (const deadline of [undefined, 600_000, 525_000]) test(`five-minute owner work answers immediately within ${deadline ?? "fallback"} window`, async () => {
  const f = fixture(`five_minute_${deadline ?? "fallback"}`, deadline);
  try {
    await f.start();
    await f.advance(300_000);
    expect(f.settled).toBe(false);
    expect(f.stops).toEqual([]);
    expect(await f.answer()).toMatchObject({ outcome: "answered", answer: { text: "Work finished" } });
    expect(f.completions).toHaveLength(1);
    expect(f.completions[0]!.at).toBe(300_000);
    expect(f.heartbeats.at(-1)).toBeGreaterThanOrEqual(290_000);
  } finally { await f.close(); }
});

for (const deadline of [undefined, 600_000, 525_000]) test(`lease renews until the ${deadline ?? "fallback"} deadline, then completes a readable timeout`, async () => {
  const f = fixture(`timeout_${deadline ?? "fallback"}`, deadline, 30);
  const window = deadline ?? 600_000;
  try {
    await f.start();
    await f.advance(window - 1000);
    expect(f.settled).toBe(false);
    expect(f.completions).toEqual([]);
    expect(f.heartbeats.length).toBeGreaterThanOrEqual(Math.floor(window / 10_000));
    expect(f.heartbeats.at(-1)).toBeGreaterThanOrEqual(window - 10_000);
    expect(Math.max(...f.heartbeats.slice(1).map((at, i) => at - f.heartbeats[i]!))).toBeLessThanOrEqual(10_000);
    await f.advance(1000);
    expect(await f.result()).toMatchObject({ outcome: "answered", answer: {
      action: "reply", text: expect.stringMatching(/ran out of time/i) } });
    expect(f.completions).toHaveLength(1);
    expect(f.completions[0]!.at).toBe(window);
    expect(f.stops).toEqual(["interrupt"]);
  } finally { await f.close(); }
});

test("timeout completion does not wait for an unresponsive owner stop", async () => {
  const f = fixture("timeout_pending_stop", 600_000, 30, true);
  try {
    await f.start();
    await f.advance(600_000);
    await waitFor(() => f.completions.length === 1);
    expect(f.completions[0]).toMatchObject({ at: 600_000, body: { outcome: "answered", answer: { action: "reply", text: expect.stringMatching(/ran out of time/i) } } });
    expect(readRunLedger().runs.find(row => row.requestId === f.request.request_id)?.ownerTurn).toMatchObject({ cancel: "interrupt" });
    expect(readRunLedger().runs.find(row => row.requestId === f.request.request_id)?.ownerTurn?.confirmed).not.toBe(true);
    // A late final answer must never complete this request a second time.
    await f.answer();
    expect(f.completions).toHaveLength(1);
  } finally { await f.close(); }
});

test("deadline expiry sends a requester reply when the target disables service fallback", async () => {
  const f = fixture("timeout_no_fallback", 600_000, 30, false, false, "none");
  try {
    await f.start();
    await f.advance(600_000);
    expect(await f.result()).toMatchObject({ outcome: "answered", answer: {
      action: "reply", text: "Ran out of time.", reply_to: "m1",
    } });
    expect(f.completions).toHaveLength(1);
    expect(f.completions[0]!.at).toBe(600_000);
    expect(f.completionExecutionAuthority).toEqual([false]);
  } finally { await f.close(); }
});

function startSweep(ports: OwnerRunPorts) {
  let done = false;
  const pending = sweepExternalRelayOrphans(ports).finally(() => { done = true; });
  return { pending, get done() { return done; } };
}
const timeoutReply = { outcome: "answered", answer: { action: "reply", text: "Ran out of time." } };

test("timeout reply accepted before the owner stop: recovery cleans up without a second completion", async () => {
  const f = fixture("timeout_accept_then_stop", 600_000, 30, true, false, "none", true);
  try {
    await f.start();
    await f.advance(600_000);
    await waitFor(() => f.completions.length === 1);
    const row = () => readRunLedger().runs.find(item => item.requestId === f.request.request_id);
    const runDir = row()!.runDir;
    // The production sweep fires every minute, including while the reply is on the wire.
    const during = startSweep(f.ports);
    await poll();
    f.releaseCompletion();
    expect(await f.result()).toMatchObject(timeoutReply);
    const after = startSweep(f.ports);
    await f.advance(5);
    expect(fs.existsSync(runDir)).toBe(true);
    expect(advertisedSlots(f.paired)).toEqual([{ target_id: "target_1", free: 0 }]);
    f.releaseStop();
    await waitFor(() => during.done && after.done);
    await Promise.all([during.pending, after.pending]);
    expect(f.completions.map(item => (item.body as { outcome: string; reason?: string }).reason ?? "answered")).toEqual(["answered"]);
    expect(f.completions[0]!.body).toMatchObject(timeoutReply);
    expect(f.accepted).toBe(1);
    expect(row()).toBeUndefined();
    expect(fs.existsSync(runDir)).toBe(false);
    expect(advertisedSlots(f.paired)).toEqual([{ target_id: "target_1", free: 1 }]);
  } finally { await f.close(); }
});

test("timeout reply accepted after the owner stop: recovery leaves delivery to the runner", async () => {
  const f = fixture("timeout_stop_then_accept", 600_000, 30, true, false, "none", true);
  try {
    await f.start();
    await f.advance(600_000);
    await waitFor(() => f.completions.length === 1);
    const row = () => readRunLedger().runs.find(item => item.requestId === f.request.request_id);
    const runDir = row()!.runDir;
    const sweep = startSweep(f.ports);
    await poll();
    expect(fs.existsSync(runDir)).toBe(true);
    expect(advertisedSlots(f.paired)).toEqual([{ target_id: "target_1", free: 0 }]);
    f.releaseStop();
    await waitFor(() => sweep.done);
    await sweep.pending;
    expect(f.completions.map(item => (item.body as { reason?: string }).reason ?? "answered")).toEqual(["answered"]);
    await waitFor(() => row()?.ownerTurn?.confirmed === true);
    const confirmed = startSweep(f.ports);
    await waitFor(() => confirmed.done);
    await confirmed.pending;
    expect(f.completions).toHaveLength(1);
    f.releaseCompletion();
    expect(await f.result()).toMatchObject(timeoutReply);
    const last = startSweep(f.ports);
    await waitFor(() => last.done);
    await last.pending;
    expect(f.completions.map(item => (item.body as { outcome: string; reason?: string }).reason ?? "answered")).toEqual(["answered"]);
    expect(f.completions[0]!.body).toMatchObject(timeoutReply);
    expect(f.accepted).toBe(1);
    expect(row()).toBeUndefined();
    expect(fs.existsSync(runDir)).toBe(false);
  } finally { await f.close(); }
});

test("an unpersisted acceptance keeps delivery ownership until its receipt is written", async () => {
  const f = fixture("timeout_acceptance_receipt_retry", 600_000, 30, true, false, "none");
  const change = relayStore.changeRunAsync;
  let refused = 0, writable = false;
  const marksAcceptance = (update: Parameters<typeof change>[1]) => {
    try { return update({ requestId: f.request.request_id } as never).completionAccepted === true; }
    catch { return false; }
  };
  const write = spyOn(relayStore, "changeRunAsync").mockImplementation((id, update, until) => {
    if (id === f.request.request_id && !writable && marksAcceptance(update)) {
      refused++;
      return Promise.reject(new relayStore.RelayStoreBusy());
    }
    return change(id, update, until);
  });
  try {
    await f.start();
    await f.advance(600_000);
    expect(await f.result()).toMatchObject(timeoutReply);
    expect(refused).toBeGreaterThan(0);
    const row = () => readRunLedger().runs.find(item => item.requestId === f.request.request_id);
    expect(row()?.completionAccepted).not.toBe(true);
    f.releaseStop();
    await waitFor(() => row()?.ownerTurn?.confirmed === true);
    // Every receipt write so far was refused; this process still owns delivery.
    const early = startSweep(f.ports);
    await waitFor(() => early.done);
    await early.pending;
    expect(f.completions).toHaveLength(1);
    expect(row()).toBeDefined();
    writable = true;
    // The retry backs off to at most five seconds between attempts.
    await f.advance(6000);
    expect(row()?.completionAccepted).toBe(true);
    const late = startSweep(f.ports);
    await waitFor(() => late.done);
    await late.pending;
    expect(f.completions).toHaveLength(1);
    expect(row()).toBeUndefined();
  } finally { write.mockRestore(); await f.close(); }
});

for (const refuseCompletion of [false, true]) test(`timeout retains execution custody when cancellation persistence fails (completion refused: ${refuseCompletion})`, async () => {
  const f = fixture(`timeout_refused_cutoff_${refuseCompletion}`, 600_000, 30, true, refuseCompletion);
  const change = relayStore.changeRun;
  let saved: ReturnType<typeof readRunLedger>["runs"][number] | undefined;
  let refused = 0;
  const write = spyOn(relayStore, "changeRun").mockImplementation((id, update) => {
    if (id === f.request.request_id) { refused++; throw new relayStore.RelayStoreBusy(); }
    return change(id, update);
  });
  try {
    await f.start();
    saved = readRunLedger().runs.find(row => row.requestId === f.request.request_id);
    await f.advance(600_000);
    await f.result();
    expect(refused).toBeGreaterThan(0);
    expect(f.completions).toHaveLength(1);
    const retained = readRunLedger().runs.find(row => row.requestId === f.request.request_id);
    expect(retained).toBeDefined();
    expect(retained?.capacityReleased).not.toBe(true);
    expect(fs.existsSync(retained!.runDir)).toBe(true);
    expect(advertisedSlots(f.paired)).toEqual([{ target_id: "target_1", free: 0 }]);
    // A fresh reader has no in-memory pending-run guard. The durable row
    // alone must still withhold the execution slot after a Viewer restart.
    const reader = Bun.spawn([process.execPath, "-e", `
      import { advertisedSlots } from "./src/lib/externalRelay/runner";
      import { readRelayStore } from "./src/lib/externalRelay/store";
      console.log("slots=" + JSON.stringify(advertisedSlots(readRelayStore().relays[0]!)));
    `], { cwd: process.cwd(), env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
    expect({ error, code }).toEqual({ error: "", code: 0 });
    expect(output.split("\n").find(line => line.startsWith("slots="))).toBe('slots=[{"target_id":"target_1","free":0}]');
  } finally {
    write.mockRestore();
    // Keep cleanup effective on the red implementation, which drops custody.
    if (saved && !readRunLedger().runs.some(row => row.requestId === saved!.requestId)) reserveRun(saved, 1);
    await f.close();
  }
});

test("capacity can become available after five minutes without spending the execution slot while held", async () => {
  const f = fixture("capacity_five_minutes");
  const blocker = { requestId: "window_blocker", relayId: f.paired.id, targetId: "target_1", leaseId: "fixture",
    ownerPid: process.pid, ownerIdentity: null, childPid: null, childIdentity: null, runDir: "", startedAt: new Date(epoch).toISOString() };
  reserveRun(blocker, 1);
  try {
    // start() waits for admission, so advance the hold while it is pending.
    const admitted = f.start();
    await waitFor(() => f.heartbeats.length > 0);
    await f.advance(300_000);
    expect(f.settled).toBe(false);
    expect(readRunLedger().runs.some(row => row.requestId === f.request.request_id)).toBe(false);
    dropRun(blocker.requestId);
    await f.advance(1000);
    await admitted;
    expect(await f.answer()).toMatchObject({ outcome: "answered", answer: { text: "Work finished" } });
  } finally { dropRun(blocker.requestId); await f.close(); }
});
