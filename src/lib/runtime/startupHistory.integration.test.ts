import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect, test } from "bun:test";

const { fixture, isolated } = await import("./startupFinalization.fixture");
const { RuntimeHost } = await import("@/runtime-host/host");
const { serveRuntimeHost } = await import("@/runtime-host/socket");
const { UnixRuntimeHostClient } = await import("./client");
const { runStructuredHostStartup } = await import("@/lib/viewerInstrumentation");
const { adoptStructuredHostsAtStartup } = await import("./startup");
const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
const { structuredStartupStatus } = await import("./startupStatus");

test("the full retained history completes within the promoted serving budget", async () => {
  const f = fixture(672, true);
  const initial = f.registry.readOnlySnapshot();
  expect(Object.keys(initial.receipts)).toHaveLength(6623);
  expect(Object.keys(initial.conversations)).toHaveLength(8078);
  expect(Object.keys(initial.entries)).toHaveLength(5188);
  const failed = Object.values(initial.receipts).filter((receipt) => receipt.state === "failed");
  // Seed only the runtime's retained session window. Startup must publish the
  // remaining historical registry rows through the real socket and journal.
  for (let i = 0; i < 862; i++) f.journal.append({
    scope: { type: "session", id: `conversation_history_${i}` }, kind: "session-status",
    producer: { kind: "structured-delivery-controller", eventKey: `history:${i}` },
    payload: {
      conversationId: `conversation_history_${i}`, sessionKey: { engine: "codex", sessionId: `history_${i}` },
      hostKind: "codex-app-server", host: "dead", turn: "unknown", provenance: "structured",
      accountId: null, parentConversationId: null, cwd: f.directory,
      artifactPath: path.join(f.directory, `history_${i}.jsonl`), activeTurnId: null,
    },
  });
  const counts: Record<string, number> = {};
  const host = new RuntimeHost(f.journal);
  // A short private endpoint also fits Unix sockaddr limits on CI.
  const socketPath = path.join(isolated, "sockets", "history.sock");
  const server = serveRuntimeHost(socketPath, { handle: async (request, options) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    // Three seconds exceeds the measured 2.6s full snapshot HTTP read. Other
    // calls pay 5ms before actual socket/journal work; live status reads were <1ms.
    await Bun.sleep(request.method === "snapshot" ? 3000 : 5);
    return host.handle(request, options);
  } });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  const started = performance.now();
  try {
    await runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
      registry: f.registry, client, refreshTranscriptState: async () => {},
      adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    }), () => {}, { waitUntilReady: true });
    const elapsedMs = performance.now() - started;
    console.log(JSON.stringify({ history: { receipts: 6623, conversations: 8078, entries: 5188 }, counts, elapsedMs }));
    /* The budget is held by what startup asks the host for, counted below: no
       full snapshot (three seconds each here), and a bounded number of every
       other call. The time is reported above, never asserted (#1761). */
    expect(counts.snapshot ?? 0).toBe(1); // One narrow activity projection, independent of receipt history.
    expect(counts["session-read"]).toBeGreaterThan(0);
    expect(counts.append).toBeGreaterThan(4300);
    expect(counts["operation-status"]).toBe(153); // 672 terminal and 21 live-owned pre-identity receipts need no reads.
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(Object.values(f.registry.readOnlySnapshot().receipts).filter((receipt) => receipt.state === "failed").slice(0, 672)).toEqual(failed);
    const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/startupPipelineContender.ts"), f.directory], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(contender.stdout).text();
    const errors = new Response(contender.stderr).text();
    expect(await contender.exited).toBe(0);
    expect(await errors).toBe("");
    expect(JSON.parse(await output)).toMatchObject({ created: true, error: null });
  } finally {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 130_000);


test("granted operator rows keep HTTP answering through a full retained-history startup", async () => {
  const f = fixture(672, true, 8078, 60);
  const granted = Object.values(f.registry.readOnlySnapshot().conversations)
    .filter((conversation) => conversation.generations.at(-1)!.launchProfile.mcpServers.includes("telegram"));
  expect(granted).toHaveLength(60);
  const counts: Record<string, number> = {};
  const host = new RuntimeHost(f.journal);
  const socketPath = path.join(isolated, "sockets", "granted.sock");
  const server = serveRuntimeHost(socketPath, { handle: async (request, options) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    return host.handle(request, options);
  } });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  // The Viewer's own HTTP answers from this event loop; probe it the whole way through.
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const latencies: number[] = [];
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const sent = performance.now();
      await (await fetch(`http://127.0.0.1:${http.port}/`)).text();
      latencies.push(performance.now() - sent);
      await Bun.sleep(50);
    }
  })();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now();
  try {
    await runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
      registry: f.registry, client, refreshTranscriptState: async () => {},
      adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    }), () => {}, { waitUntilReady: true });
    const elapsedMs = performance.now() - started;
    probing = false;
    await probe;
    delay.disable();
    const httpMaxMs = Math.max(...latencies);
    console.log(JSON.stringify({ granted: granted.length, counts, elapsedMs, httpProbes: latencies.length, httpMaxMs,
      eventLoopMaxMs: delay.max / 1e6 }));
    expect(structuredStartupStatus()?.state).toBe("ready");
    /* Each row a structured host can own is read for its signals and again for its fallback, and each failed
       launch twice by spawn recovery. The other 2890 historical conversations are not read at all. */
    expect(counts["session-read"]).toBeLessThanOrEqual(2 * 5188 + 2 * 672);
    /* Before the decision was reused, this history took over sixty seconds to
       reach ready here. The elapsed time, the slowest HTTP probe and the
       event-loop delay are reported above, never asserted: all three measure
       the runner as much as the startup (#1761). The call counts are what
       hold the repair. */
    // The decision is reused, never skipped: each granted root keeps exactly its grant.
    for (const conversation of granted) {
      expect(f.registry.conversation(conversation.id)!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    }
  } finally {
    probing = false;
    await probe;
    http.stop(true);
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 180_000);
