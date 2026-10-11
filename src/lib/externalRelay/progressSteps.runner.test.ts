import { afterAll, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { requestSchema, type ExternalRelayProgress } from "./protocol";
import { sampleRequest, contextRequest } from "./request.fixture";
import { runClaimedRequest } from "./runner";
import { updateRelayStore, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";
import { observeOwnerTurn, type OwnerTurnObservation } from "./ownerRun";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { AgentRegistry } from "@/lib/agent/registry";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-steps-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const home = path.join(root, "account");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "auth.json"), "{}");
fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }));
const account: AccountContext = { engine: "codex", accountId: "progress", kind: "managed", home, transcriptRoot: home, env: { ...process.env } };
const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account });
afterAll(() => { selection.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); });

function relay(origin: string, features?: string[]): PairedRelay {
  return {
    id: "relay_progress", origin, api_base: `${origin}/v1`, name: "Fixture", description: "Fixture",
    credential: randomBytes(32).toString("base64url"), features,
    owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null },
    pairedAt: new Date().toISOString(), paused: false,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true,
      engine: "codex", model: "gpt-6-sol", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1 }],
  };
}
type Beat = { lease_id: string; seq: number; progress: ExternalRelayProgress | null };
const captureFile = path.join(import.meta.dir, "fixtures/relay_v1/owner-progress-heartbeats.json");
function checkSteps(beats: Beat[]) {
  const allowed = ["accepted", "thinking", "reading_board", "working", "writing_answer"];
  for (const [i, beat] of beats.entries()) {
    expect(Object.keys(beat)).toEqual(["lease_id", "seq", "progress"]);
    expect(beat.seq).toBe(i + 1);
    if (!beat.progress) continue;
    expect(allowed).toContain(beat.progress.label);
    expect(beat.progress).toMatchObject({ kind: "step", tool: null, status: null });
    expect(Object.keys(beat.progress)).toEqual(["kind", "label", "tool", "status", "at"]);
    if (i) {
      const previous = beats.slice(0, i).findLast(b => b.progress)?.progress;
      if (previous) expect(beat.progress.label).not.toBe(previous.label);
    }
  }
}

test("owner observation reads current tools and final boundaries only with steps enabled", async () => {
  const file = path.join(root, "owner.jsonl");
  const conversation = spyOn({ read: () => null as ReturnType<AgentRegistry["conversation"]> }, "read");
  conversation.mockReturnValue({ engine: "codex", generations: [{ path: file }] } as ReturnType<AgentRegistry["conversation"]>);
  const sources = {
    registry: () => ({ spawnReceiptForClientAttempt: () => ({ state: "completed", conversationId: "conversation_progress", launchId: "launch_progress", artifactPath: file }),
      readOnlySnapshot: () => ({ heldDeliveries: {} }), conversation }),
    now: Date.now,
    liveness: async () => [{ reason: "host_alive_turn_active", lastRecordAt: new Date().toISOString() }],
  } as unknown as Pick<SeatTickSources, "registry" | "liveness" | "now">;
  const turn = { clientAttemptId: "relay-owner-progress", claimedAt: new Date(0).toISOString() };
  fs.writeFileSync(file, JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "board", name: "mcp__viewer__get_task", arguments: "private content" } }) + "\n");
  const off = await observeOwnerTurn(turn, sources);
  expect(off.currentTool).toBeUndefined(); expect(conversation).not.toHaveBeenCalled();
  expect(await observeOwnerTurn(turn, sources, true)).toMatchObject({ state: "running", currentTool: "mcp__viewer__get_task", writingAnswer: false });
  fs.appendFileSync(file, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "board", output: "private content" } }) + "\n");
  expect(await observeOwnerTurn(turn, sources, true)).toMatchObject({ currentTool: null });
  fs.appendFileSync(file, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "private content" }] } }) + "\n");
  const final = await observeOwnerTurn(turn, sources, true);
  expect(final.writingAnswer).toBe(true); expect(JSON.stringify(final)).not.toContain("private content");
});

test("record owner heartbeats through the real runner, with every step and a regular null beat", async () => {
  const beats: Beat[] = [], arrival: number[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) { beats.push(body as Beat); arrival.push(Date.now()); }
    return { body: { status: "ok" } };
  });
  const paired = relay(server.origin, ["progress_steps"]); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  const request = requestSchema.parse({ ...contextRequest, request_id: "progress_owner", lease_id: "leaseprogressownerfixture",
    answer: { ...contextRequest.answer, progress: "none" },
    liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 4 },
    input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } });
  try {
    const completion = await runClaimedRequest(paired, request, undefined, { timeoutMs: 25000, ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_progress" } }),
      observe: async (_turn, enabled): Promise<OwnerTurnObservation> => {
        expect(enabled).toBe(true);
        const last = beats.findLast(b => b.progress)?.progress?.label;
        if (beats.at(-1)?.seq === 6) return { state: "ended", finalText: "Done" };
        if (last === "thinking") return { state: "running", currentTool: "mcp__viewer__get_task" };
        if (last === "reading_board") return { state: "running", currentTool: "exec_command" };
        if (last === "working" || last === "writing_answer") return { state: "running", writingAnswer: true };
        return { state: "running", currentTool: null };
      }, stop: async () => { throw new Error("fixture should settle"); }, pollMs: 20,
    } });
    expect(completion).toMatchObject({ outcome: "answered", answer: { text: "Done" } });
    checkSteps(beats);
    expect(beats.map(b => b.progress?.label ?? null)).toEqual(["accepted", "thinking", "reading_board", "working", "writing_answer", null]);
    for (let i = 1; i < arrival.length; i++) expect(arrival[i]! - arrival[i - 1]!).toBeGreaterThanOrEqual(3000);
    if (process.env.LLV_RELAY_STEPS_CAPTURE) fs.writeFileSync(process.env.LLV_RELAY_STEPS_CAPTURE, JSON.stringify(beats, null, 2) + "\n");
    else {
      const recorded = JSON.parse(fs.readFileSync(captureFile, "utf8")) as Beat[];
      checkSteps(recorded);
      expect(recorded.map(({ progress, ...body }) => ({ ...body, progress: progress && { ...progress, at: "time" } })))
        .toEqual(beats.map(({ progress, ...body }) => ({ ...body, progress: progress && { ...progress, at: "time" } })));
    }
  } finally { await server.close(); }
}, 30000);

test("owner without progress_steps keeps null heartbeats and does not request tool observations", async () => {
  const beats: Beat[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) beats.push(body as Beat);
    return { body: { status: "ok" } };
  });
  const paired = relay(server.origin); paired.targets[0]!.ownerTier = true;
  updateRelayStore(s => ({ ...s, relays: [paired] }));
  try {
    const outcome = await runClaimedRequest(paired, { ...contextRequest, request_id: "progress_owner_off", lease_id: "leaseprogressownerdisabled",
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 2 },
      input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } } }, undefined, { timeoutMs: 5000, ownerPorts: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_progress_off" } }),
      observe: async (_turn, enabled) => {
        expect(enabled).toBe(false);
        return beats.length >= 2 ? { state: "ended", finalText: "Done" } : { state: "running", currentTool: "mcp__viewer__get_task" };
      }, stop: async () => {}, pollMs: 20,
    } });
    expect(outcome?.outcome).toBe("answered");
    expect(beats).toEqual([{ lease_id: "leaseprogressownerdisabled", seq: 1, progress: null }, { lease_id: "leaseprogressownerdisabled", seq: 2, progress: null }]);
  } finally { await server.close(); }
});

for (const enabled of [true, false]) test(`member descriptor gate ${enabled ? "on" : "off"} uses the plain CLI path`, async () => {
  const beats: Beat[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/heartbeat")) beats.push(body as Beat);
    return { body: { status: "ok" } };
  });
  const paired = relay(server.origin, enabled ? ["progress_steps"] : undefined);
  const script = path.join(root, `member-${enabled}.mjs`);
  fs.writeFileSync(script, `#!/usr/bin/env bun\nawait Bun.stdin.text();
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'private fixture content'}}));
    await Bun.sleep(3500);
    console.log(JSON.stringify({type:'item.started',item:{type:'web_search',id:'search',query:'private fixture content'}}));
    await Bun.sleep(3300);
    console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',id:'search'}}));
    console.log(JSON.stringify({type:'item.started',item:{type:'agent_message',text:'{"action":"reply"'}}));
    await Bun.sleep(3500);
    const args=process.argv.slice(2); await Bun.write(args[args.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));`);
  fs.chmodSync(script, 0o700);
  try {
    const outcome = await runClaimedRequest(paired, { ...contextRequest, request_id: `progress_member_${enabled}`, lease_id: "leaseprogressmemberfixture",
      input: { ...contextRequest.input, tools: [] }, liveness: { ...sampleRequest.liveness, heartbeat_interval_s: enabled ? 20 : 2 } }, undefined,
    { command: script, timeoutMs: 15000 });
    expect(outcome?.outcome).toBe("answered");
    if (enabled) {
      checkSteps(beats);
      expect(beats.map(b => b.progress?.label)).toEqual(["accepted", "thinking", "working", "writing_answer"]);
      expect(JSON.stringify(beats)).not.toContain("private fixture content");
    } else {
      expect(beats.some(b => b.progress?.kind === "note")).toBe(true);
      expect(beats.every(b => b.progress?.kind !== "step")).toBe(true);
    }
  } finally { await server.close(); }
}, 20000);

test("plain tool rounds report working for restricted reads without exposing names or arguments", async () => {
  const beats: Beat[] = [];
  const server = await startTestRelay(async (req, body) => {
    if (req.url?.endsWith("/heartbeat")) beats.push(body as Beat);
    if (req.url?.endsWith("/tool-calls")) {
      await Bun.sleep(4000);
      const call = body as { call_id: string; tool: string };
      return { body: { call_id: call.call_id, tool: call.tool, status: "ok", output: "private fixture result", truncated: false,
        effect: "read", delivered: false, replayed: false, calls_remaining: 15, audience: "admin" } };
    }
    return { body: { status: "ok" } };
  });
  const script = path.join(root, "member-rounds.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env bun\nawait Bun.stdin.text();
    const args=process.argv.slice(2), output=args[args.indexOf('--output-last-message')+1];
    const answer=output.includes('round-1')?{action:'call',text:'',reply_to:null,calls:[{tool:'restricted_read',arguments:'{}',cursor:null}]}:{action:'reply',text:'Done',reply_to:null};
    if(answer.action==='reply') { console.log(JSON.stringify({type:'item.started',item:{type:'agent_message',text:'{"action":"reply"'}})); await Bun.sleep(3500); }
    await Bun.write(output,JSON.stringify(answer));`);
  fs.chmodSync(script, 0o700);
  try {
    const outcome = await runClaimedRequest(relay(server.origin, ["progress_steps"]), { ...contextRequest,
      request_id: "progress_rounds", lease_id: "leaseprogressroundsfixture",
      input: { ...contextRequest.input, tools: [{ name: "restricted_read", summary: "Read fixture", mode: "direct", effect: "read", audience: "admin",
        parameters: { type: "object", properties: {}, additionalProperties: false } }] },
      liveness: { ...sampleRequest.liveness, heartbeat_interval_s: 20 } }, undefined, { command: script, timeoutMs: 10000 });
    expect(outcome?.outcome).toBe("answered");
    checkSteps(beats);
    expect(beats.map(b => b.progress?.label)).toEqual(["accepted", "working", "writing_answer"]);
    expect(JSON.stringify(beats)).not.toContain("restricted_read");
    expect(JSON.stringify(beats)).not.toContain("private fixture result");
  } finally { await server.close(); }
}, 15000);
