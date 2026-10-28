// Run by cloud.test.ts in a fresh process; the parent owns the fake Cloud peer.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { spyOn } from "bun:test";
import { createCloudTransport } from "./cloud";
import { runClaimedRequest } from "./runner";
import { contextRequest } from "./request.fixture";
import { updateRelayStore, type PairedRelay } from "./store";
import { setRelaySwitch } from "./switches";
import * as client from "./client";
import { cloneReceipt } from "./clone.fixture";
import { accountManager } from "@/lib/accounts/manager";
import { stateDir } from "@/lib/configDir";
import { projectForCwd } from "@/lib/scanner/describe";

const outcome = process.argv[2];
const owner = outcome !== "member-window";
const budget = 4000;
const events = new EventEmitter();
const send = (value: unknown) => process.send?.(value);
process.on("message", message => events.emit("message", JSON.stringify(message)));
process.env.LLV_CODEX_CLOUD_URL = "wss://example.invalid/app-server";
const directory = path.join(process.env.TMPDIR!, "repository");
fs.mkdirSync(directory);
const cwd = fs.realpathSync(directory);
if (spawnSync("git", ["init", "-q", cwd]).status !== 0) throw new Error("fixture git init failed");
fs.writeFileSync(path.join(stateDir(), "project-catalog.json"), JSON.stringify({ files: { fixture: { cwd } } }));
const relay: PairedRelay = { id: "cloud_deadline", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1", name: "Relay", description: "", credential: "fixture",
  owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: new Date().toISOString(), paused: false,
  limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
  targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true,
    engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: projectForCwd(cwd)!, cloudEnvironmentId: "repo-env", concurrency: 1, hardCapMinutes: budget / 60_000 }] };
updateRelayStore(store => ({ ...store, relays: [relay] }));
setRelaySwitch("chain_conversations", false);
let toolAborted = false, stops = 0;
const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route, _method, body, _credential, options) => {
  send({ type: "post", route, body });
  if (route.endsWith("/tool-calls")) {
    if (outcome === "tool-cap") await new Promise<void>((_resolve, reject) => {
      const abort = () => { toolAborted = true; reject(new Error("tool aborted")); };
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
    });
    const call = body as { call_id: string; tool: string };
    return { status: 200, body: { ...call, status: "ok", output: "Found", truncated: false, effect: "read", delivered: false, replayed: false, calls_remaining: 15 } } as never;
  }
  return { status: 200, body: route.endsWith("/send") ? cloneReceipt() : { status: "ok" } } as never;
});
const select = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
  engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { ...process.env },
} });
const transport = createCloudTransport(() => {
  queueMicrotask(() => events.emit("open"));
  return { on: events.on.bind(events), close() { send({ type: "closed" }); },
    send(data) { send({ type: "rpc", call: JSON.parse(data) }); } };
}, async () => "/workspace/fixture");
const transports: Promise<string>[] = [];
const started = performance.now();
try {
  const result = await runClaimedRequest(relay, { ...contextRequest, request_id: `budget_${outcome}`,
    deadline_at: new Date(Date.now() + (outcome === "owner-answer" || !owner ? 1000 : 20000)).toISOString(),
    owner_delivery: { chat_id: -1000000000101, reply_to_message_id: 51, message_thread_id: 12 },
    input: { ...contextRequest.input, tools: outcome === "tool-rounds" || outcome === "tool-cap" ? [
      { name: "lookup_notes", summary: "Find notes", mode: "direct", effect: "read", parameters: { type: "object", properties: {} } },
    ] : [], requester: { ...contextRequest.input.requester, is_owner: owner } },
  }, undefined, { leaseWorker: false,
    cloudTransport: input => {
      send({ type: "budget", timeoutMs: input.timeoutMs });
      const pending = transport(input); transports.push(pending); return pending;
    },
    ownerPorts: {
      launch: async input => {
        if (input.cwd !== cwd) throw new Error("local cwd mismatch");
        send({ type: "local" });
        return { status: 202, body: { conversationId: "conversation_budget", initialMessage: "delivered" } };
      },
      observe: async () => ({ state: "running" }),
      stop: async () => { stops++; }, pollMs: 10,
    },
  });
  await Promise.allSettled(transports);
  send({ type: "done", result, elapsedMs: performance.now() - started, toolAborted, stops, accountCalls: select.mock.calls.length });
} catch (error) { send({ type: "error", error: String(error) }); process.exitCode = 1; }
finally { wire.mockRestore(); select.mockRestore(); process.disconnect?.(); }
