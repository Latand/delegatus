/** Isolated transport/delivery benchmark; run through gate-slot.sh. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RuntimeJournal } from "../src/runtime-host/journal";
import { RuntimeHost } from "../src/runtime-host/host";
import { serveRuntimeHost } from "../src/runtime-host/socket";
import { UnixRuntimeHostClient } from "../src/lib/runtime/client";
async function effectPages(client: UnixRuntimeHostClient) {
  if (fs.existsSync(new URL("../src/lib/runtime/deliveryEffectPages.ts", import.meta.url))) {
    const { DeliveryEffectPages } = await import("../src/lib/runtime/deliveryEffectPages");
    return new DeliveryEffectPages(client, () => {});
  }
  return { read: (kinds?: readonly string[], after = 0) => client.effectBatch(kinds, after) };
}
import { FakeEngineHost, createFakeDeliveryLedger } from "../src/lib/runtime/fixtures/fakeEngineHost";
const root = process.env.LLV_STATE_DIR!;
if (!root) throw new Error("private LLV_STATE_DIR required");
fs.mkdirSync(root, { recursive: true });
const endpoint = path.join(root, "bench.sock");
process.env.LLV_RUNTIME_HOST_SOCKET = endpoint;
process.env.LLV_RUNTIME_JOURNAL = path.join(root, "journal.sqlite");
if (process.argv.includes("--host")) {
  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"));
  const host = new RuntimeHost(journal, undefined, undefined, true);
  let connections = 0, effectReads = 0, effectBytes = 0;
  const server = serveRuntimeHost(endpoint, { handle: async (request, options) => {
    const start = performance.now();
    const response = await host.handle(request, options);
    if (request.method === "effect-batch") { effectReads++; effectBytes += Buffer.byteLength(JSON.stringify(response.result)); }
    if (request.method === "append") response.result = { handlerMs: performance.now() - start, connections, effectReads, effectBytes };
    return response;
  } });
  server.on("connection", () => { connections++; });
  server.once("listening", () => process.stdout.write("ready\n"));
  process.on("SIGTERM", () => { server.close(); journal.close(); process.exit(0); });
} else {
  const child = Bun.spawn([process.execPath, import.meta.path, "--host"], { stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    await reader.read(); reader.releaseLock();
    const client = new UnixRuntimeHostClient(endpoint);
    const [{ AgentRegistry }, { emptyLaunchProfile }, { bindStructuredDeliveryQueue }, { kickStructuredDeliveryQueue }, { enqueueStructuredMessage }, { handleRuntimeCommand }, { NextRequest }, { captureProcessIdentity }] = await Promise.all([
      import("../src/lib/agent/registry"), import("../src/lib/accounts/migration/contracts"), import("../src/lib/runtime/structuredDeliveryController"), import("../src/lib/runtime/structuredDeliverySignal"), import("../src/lib/runtime/structuredMessageDelivery"), import("../src/lib/runtime/http"), import("next/server"), import("../src/lib/processIdentity"),
    ]);
    const quantile = (values: number[], p: number) => values.toSorted((a,b)=>a-b)[Math.ceil(values.length*p)-1]!;
    const trials = [];
    for (let trial = 0; trial < 3; trial++) {
      const observed: number[] = [], handler: number[] = [];
      let rpcConnections = 0;
      const connectionsAtStart = (await client.append({ scope: "system:benchmark", kind: "item", payload: {} }) as { connections: number }).connections;
      for (let index = 0; index < 100; index++) {
        const start = performance.now();
        const reply = await client.append({ scope: "session:benchmark", kind: "session-status", payload: { conversationId: "benchmark", sessionKey: { engine: "codex", sessionId: "benchmark-session" }, hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null } }) as { handlerMs: number; connections: number };
        observed.push(performance.now() - start); handler.push(reply.handlerMs); rpcConnections = reply.connections - connectionsAtStart;
      }
      const ledger = createFakeDeliveryLedger();
      const sessionId = ["00000000", "0000", "4000", "8000", String(trial + 1).padStart(12, "0")].join("-");
      const artifactPath = path.join(root, `${sessionId}.jsonl`);
      fs.writeFileSync(artifactPath, "");
      const registry = new AgentRegistry(path.join(root, `registry-${trial}.json`));
      const profile = emptyLaunchProfile({ cwd: root });
      registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: "default", launchProfile: profile, turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: "2026-10-16T00:00:00.000Z" }]);
      const conversation = registry.conversationForPath(artifactPath)!;
      if (conversation.generations.at(-1)?.id !== sessionId) throw new Error("fixture native identity was not preserved");
      const identity = captureProcessIdentity(process.pid);
      const key = { engine: "codex" as const, sessionId };
      const initial = await new FakeEngineHost().health();
      const engine = Object.assign(new FakeEngineHost(ledger, { ...initial, sessionKey: sessionId, pid: identity.pid, processStartIdentity: identity.startIdentity }), { onStateChange: () => () => {} });
      registry.upsert({ key, artifactPath, cwd: root, accountId: "default", launchProfile: profile, status: "idle", host: null,
        structuredHost: { kind: "codex-app-server", endpoint: initial.endpoint, process: identity, eventCursor: 0, protocolVersion: "fixture", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, claimEpoch: 1, claimOwner: "benchmark-owner", pendingAction: null });
      await bindStructuredDeliveryQueue([{ key, host: engine }], { registry, client, watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0, recover: async () => null });
      const deliveries: Record<string, number[]> = { idle: [], busy: [] };
      for (const mode of ["idle", "busy"] as const) {
        for (let index=0; index<20; index++) {
          const operationId = `benchmark-${trial}-${mode}-${index}`;
          const start = performance.now();
          const admission = handleRuntimeCommand(new NextRequest("http://localhost/api/runtime/send", { method: "POST", headers: { host: "localhost", "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ operationId, conversationId: conversation.id, text: "benchmark message", policy: "queue", idempotencyKey: operationId }) }), "send", { enabled: () => true, structuredEnabled: () => true, registry: () => registry, client: () => client, enqueue: (request, dependencies) => enqueueStructuredMessage(request, { ...dependencies, recover: async () => null }), kick: kickStructuredDeliveryQueue });
          // A send starts immediately before a two-second CPU slice. All time
          // from ingress, including admission, counts toward engine arrival.
          if (mode === "busy") {
            const until = performance.now()+2000;
            while (performance.now()<until) { /* intentional benchmark load */ }
          }
          const response = await admission;
          if (!response.ok) throw new Error(`operator admission refused: ${response.status} ${JSON.stringify(await response.json())}`);
          await kickStructuredDeliveryQueue();
          if (ledger.writes.at(-1)?.id !== operationId) throw new Error("engine did not receive original operation");
          deliveries[mode].push(performance.now()-start);
        }
      }
      await bindStructuredDeliveryQueue([], { registry, client: null });
      trials.push({ trial, rpc: { samples: observed.length, newConnections: rpcConnections, viewerP50Ms: quantile(observed,.5), handlerP50Ms: quantile(handler,.5), viewerP95Ms: quantile(observed,.95) }, delivery: Object.fromEntries(Object.entries(deliveries).map(([mode,values])=>[mode,{ samples: values.length, p50Ms: quantile(values,.5), p95Ms: quantile(values,.95), maxMs: Math.max(...values) }])) });
    }
    // Retained pending work: unchanged passes must transfer only page versions.
    await client.append({ scope: "session:pending", kind: "session-status", payload: { conversationId: "pending", sessionKey: { engine: "codex", sessionId: "pending-session" }, hostKind: "codex-app-server", host: "hosted", turn: "idle" } });
    for (let index=0; index<200; index++) await client.command({ operationId: `pending-${index}`, kind: "send", conversationId: "pending", text: "pending message ".repeat(32), policy: "queue", idempotencyKey: `pending-${index}` });
    const stats = async () => client.append({ scope: "system:benchmark", kind: "item", payload: {} }) as Promise<{ effectReads: number; effectBytes: number }>;
    const pages = await effectPages(client);
    const poll = async () => { let after = 0, count = 0; while (true) { const page = await pages.read(["runtime.send"], after); if (!page.length) break; count += page.length; after = Math.max(...page.map(effect=>effect.eventSeq)); } if (count !== 200) throw new Error(`expected 200 retained effects, got ${count}`); };
    const listing = [];
    for (let trial = 0; trial < 3; trial++) {
      await poll();
      const beforePoll = await stats();
      const pollStart = performance.now();
      for (let index=0; index<30; index++) await poll();
      const pollMs = performance.now()-pollStart;
      const afterPoll = await stats();
      listing.push({ trial, retainedPending: 200, passes: 30, rpcCalls: afterPoll.effectReads-beforePoll.effectReads, wireResultBytes: afterPoll.effectBytes-beforePoll.effectBytes, elapsedMs: pollMs });
    }
    const sourceFiles = ["scripts/runtime-delivery-benchmark.ts","src/lib/viewerLoopMonitor.ts", "src/lib/runtime/contracts.ts", "src/lib/runtime/http.ts", "src/lib/runtime/structuredMessageDelivery.ts", "src/lib/runtime/client.ts", "src/lib/runtime/connectionPool.ts", "src/lib/runtime/deliveryEffectPages.ts", "src/lib/runtime/deliveryWake.ts", "src/lib/runtime/structuredDeliveryController.ts", "src/lib/runtime/structuredDeliveryQueue.ts", "src/runtime-host/socket.ts", "src/runtime-host/journal.ts", "src/runtime-host/host.ts"];
    const digest = createHash("sha256");
    for (const file of sourceFiles) { digest.update(file); const location = path.join(import.meta.dir, "..", file); digest.update(fs.existsSync(location) ? fs.readFileSync(location) : "absent"); }
    process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), runtime: Bun.version, sourceSha256: digest.digest("hex"), listing, load: { trials: 3, rpcPerTrial: 100, sendsPerModePerTrial: 20, busySliceMs: 2000, engine: "recording EngineHost", ingress: "real runtime HTTP send handler, registry admission and bound delivery controller", journal: "real SQLite RuntimeJournal", transport: "separate runtime-host process" }, trials },null,2)+"\n");
  } finally { child.kill("SIGTERM"); await child.exited; }
}
