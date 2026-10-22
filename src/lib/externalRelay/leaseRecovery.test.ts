import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { contextRequest } from "./request.fixture";
import { runClaimedRequest, advertisedSlots, runningCount } from "./runner";
import { sweepExternalRelayOrphans } from "./poller";
import { readRunLedger, updateRelayStore } from "./store";
import * as relayStore from "./store";
import { setRelaySwitch } from "./switches";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lease-recovery-test-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
fs.mkdirSync(path.join(root, "account"), { recursive: true });
const account: AccountContext = { engine: "codex", accountId: "fixture", kind: "managed", home: path.join(root, "account"),
  transcriptRoot: path.join(root, "account"), env: { ...process.env } };
const originalSelection = accountManager.resolveHeadlessSpawn;
accountManager.resolveHeadlessSpawn = (() => ({ kind: "available", account })) as typeof originalSelection;
afterAll(() => { accountManager.resolveHeadlessSpawn = originalSelection; fs.rmSync(root, { recursive: true, force: true }); });

function relay(apiBase: string): PairedRelay {
  return { id: "relay_recovery", origin: apiBase.replace(/\/v1$/, ""), api_base: apiBase, name: "Fixture", description: "",
    credential: "x".repeat(43), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: "2026-01-01T00:00:00.000Z", paused: false,
    limits: { max_response_bytes: 1_048_576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true,
      engine: "codex", model: "gpt-6-sol", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1, ownerTier: true }] };
}

test("lease heartbeat advances while the runner event loop is synchronously blocked", async () => {
  const serverCode = `
    const http=require("node:http");let beats=0;
    const server=http.createServer((req,res)=>{req.resume();req.on("end",()=>{
      res.setHeader("content-type","application/json");
      if(req.url.endsWith("/heartbeat")){console.log(JSON.stringify({beat:++beats,at:Date.now()}));res.end(JSON.stringify({status:"ok"}));return;}
      if(req.url.endsWith("/complete")){res.end(JSON.stringify({status:"accepted",duplicate:false}));return;}
      res.statusCode=404;res.end("{}");
    });});
    server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({ready:server.address().port})));
  `;
  const service = Bun.spawn([process.execPath, "-e", serverCode], { stdout: "pipe", stderr: "pipe" });
  const reader = service.stdout.getReader();
  const lanes: ReturnType<typeof Bun.spawn>[] = [];
  let buffered = "";
  const nextFrame = async () => {
    while (true) {
      const end = buffered.indexOf("\n");
      if (end >= 0) { const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); return JSON.parse(line) as { ready?: number; beat?: number; at?: number }; }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("relay fixture process exited before its next frame");
      buffered += new TextDecoder().decode(chunk.value);
    }
  };
  let ownerDone = false;
  let releaseOwner!: () => void;
  const heldOwner = new Promise<void>(resolve => { releaseOwner = resolve; });
  let done: Promise<unknown> | undefined;
  try {
    const listening = await nextFrame();
    const laneCode = `console.log("ready");setInterval(()=>{const until=Date.now()+5;while(Date.now()<until){}},50);`;
    for (let lane = 0; lane < 15; lane++) {
      const process = Bun.spawn([globalThis.process.execPath, "-e", laneCode], { stdout: "pipe", stderr: "pipe" });
      lanes.push(process);
      const laneReader = process.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const chunk = await laneReader.read();
        if (chunk.done) throw new Error("load lane exited before ready");
        line += new TextDecoder().decode(chunk.value);
      }
      expect(line.trim()).toBe("ready");
      laneReader.releaseLock();
    }
    const paired = relay(`http://127.0.0.1:${listening.ready}/v1`);
    updateRelayStore(store => ({ ...store, relays: [paired] }));
    const request = { ...contextRequest, request_id: "lease_stall_probe",
      liveness: { ...contextRequest.liveness, heartbeat_interval_s: 2, stall_window_s: 10 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } };
    done = runClaimedRequest(paired, request, undefined, { timeoutMs: 15_000, ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_lease_stall" } }),
      observe: async () => { if (!ownerDone) await heldOwner; return { state: "ended", finalText: "Ready" }; },
      stop: async () => { throw new Error("settled owner work must not be stopped"); }, pollMs: 5,
    } });
    const first = await nextFrame();
    expect(first.beat).toBe(1);
    const stalledAt = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
    expect(Date.now() - stalledAt).toBeGreaterThanOrEqual(3400);
    const second = await nextFrame();
    expect(second.beat).toBe(2);
    expect(second.at! - first.at!).toBeLessThan(3200);
    ownerDone = true;
    releaseOwner();
    await expect(done).resolves.toMatchObject({ outcome: "answered", answer: { text: "Ready" } });
  } finally {
    ownerDone = true; releaseOwner();
    await done?.catch(() => undefined);
    for (const lane of lanes) lane.kill("SIGTERM");
    await Promise.all(lanes.map(lane => lane.exited));
    service.kill("SIGTERM"); await service.exited; reader.releaseLock();
  }
});

test("accepted completion retries a refused capacity marker and sweep finishes cleanup locally", async () => {
  const conversations = await import("./conversations");
  let completionPosts = 0;
  const service = await startTestRelay(req => {
    if (req.url?.endsWith("/complete")) { completionPosts++; return { body: { status: "accepted", duplicate: false } }; }
    return { body: { status: "ok" } };
  });
  const paired = relay(`${service.origin}/v1`);
  paired.targets[0]!.concurrency = 2;
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  setRelaySwitch("chain_conversations", true);
  let refuseMarker = true, releaseCleanup!: () => void;
  const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const originalWrite = relayStore.changeRunAsync;
  const markerWrite = spyOn(relayStore, "changeRunAsync").mockImplementation(async (id, change, until) => {
    const current = readRunLedger().runs.find(row => row.requestId === id);
    if (refuseMarker && id === "accepted_marker_retry" && current && change(current).capacityReleased) {
      refuseMarker = false;
      throw new relayStore.RelayStoreBusy();
    }
    return originalWrite(id, change, until);
  });
  const originalCleanup = conversations.releaseConversationAsync;
  const cleanup = spyOn(conversations, "releaseConversationAsync").mockImplementation(async (id, patch, until) => {
    if (patch.state === "idle") { await cleanupHeld; throw new Error("fixture cleanup contention"); }
    return originalCleanup(id, patch, until);
  });
  const request = { ...contextRequest, request_id: "accepted_marker_retry", chat: { key: "marker-retry-chat" },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } };
  const completion = runClaimedRequest(paired, request, undefined, { ownerPorts: {
    launch: async () => ({ status: 202, body: { conversationId: "conversation_marker_retry" } }),
    observe: async () => ({ state: "ended", finalText: "Accepted" }),
    stop: async () => { throw new Error("settled owner work must not be stopped"); }, pollMs: 1,
  } }).then(value => ({ value }), error => ({ error }));
  try {
    for (let attempt = 0; attempt < 300 && !readRunLedger().runs.find(row => row.requestId === request.request_id)?.capacityReleased; attempt++) await Bun.sleep(10);
    const row = readRunLedger().runs.find(item => item.requestId === request.request_id);
    expect(refuseMarker).toBe(false);
    expect(row?.capacityReleased).toBe(true);
    expect(runningCount(paired.id, "target_1")).toBe(0);
    expect(advertisedSlots(paired)).toEqual([{ target_id: "target_1", free: 2 }]);
    releaseCleanup();
    expect(await completion).toHaveProperty("error");
    expect(completionPosts).toBe(1);
    expect(conversations.readConversations().some(row => row.state === "running")).toBe(true);
    cleanup.mockRestore(); markerWrite.mockRestore();
    await sweepExternalRelayOrphans();
    expect(conversations.readConversations().every(row => row.state !== "running")).toBe(true);
    expect(readRunLedger().runs.some(row => row.requestId === request.request_id)).toBe(false);
    expect(completionPosts).toBe(1);
  } finally {
    releaseCleanup(); cleanup.mockRestore(); markerWrite.mockRestore();
    await completion;
    await service.close();
    updateRelayStore(store => ({ ...store, relays: [] }));
  }
});
