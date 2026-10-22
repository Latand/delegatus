import { afterAll, expect, jest, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import * as client from "./client";
import { runClaimedRequest } from "./runner";
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

function fixture(id: string, deadlineMs?: number, hardCapMinutes = 1, holdStop = false) {
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
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true,
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
  const wire = spyOn(client, "relayCall").mockImplementation(async (_base, endpoint, _method, body) => {
    if (endpoint.endsWith("/heartbeat")) heartbeats.push(now - epoch);
    else if (endpoint.endsWith("/complete")) completions.push({ at: now - epoch, body });
    else throw Error("unexpected fixture endpoint");
    return { status: 200, body: { status: "ok" } } as never;
  });
  let release!: () => void, releaseStop!: () => void, observing = false, settled = false;
  const answer = new Promise<void>(resolve => { release = resolve; });
  const stop = new Promise<void>(resolve => { releaseStop = resolve; });
  let pending: ReturnType<typeof runClaimedRequest> | undefined;
  return { paired, request, heartbeats, completions, stops,
    get settled() { return settled; },
    async start() {
      pending = runClaimedRequest(paired, request, undefined, { leaseWorker: false, ownerPorts: {
        launch: async () => ({ status: 202, body: { conversationId: `conversation_${id}`, initialMessage: "delivered" } }),
        observe: async () => { observing = true; await answer; return { state: "ended", finalText: "Work finished" }; },
        stop: async (_id, action) => { stops.push(action); if (holdStop) await stop; },
      } });
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
      release(); releaseStop();
      if (pending) await waitFor(() => settled);
      await pending;
      if (holdStop) {
        await waitFor(() => !readRunLedger().runs.some(row => row.requestId === id && row.ownerTurn?.cancel && !row.ownerTurn.confirmed));
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
    expect(await f.result()).toMatchObject({ outcome: "failed", reason: "hard_cap",
      detail: expect.stringMatching(/ran out of time/i) });
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
    expect(f.completions[0]).toMatchObject({ at: 600_000, body: { outcome: "failed", reason: "hard_cap", detail: expect.stringMatching(/ran out of time/i) } });
    expect(readRunLedger().runs.find(row => row.requestId === f.request.request_id)?.ownerTurn).toMatchObject({ cancel: "interrupt" });
    expect(readRunLedger().runs.find(row => row.requestId === f.request.request_id)?.ownerTurn?.confirmed).not.toBe(true);
    // A late final answer must never complete this request a second time.
    await f.answer();
    expect(f.completions).toHaveLength(1);
  } finally { await f.close(); }
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
