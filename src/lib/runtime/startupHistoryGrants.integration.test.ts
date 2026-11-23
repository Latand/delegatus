// This history installation gets a separate owned test runner.
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect, test } from "bun:test";

const { fixture, isolated } = await (await import("./startupFinalization.fixture")).startupFinalizationFixture();
const { RuntimeHost } = await import("@/runtime-host/host");
const { serveRuntimeHost } = await import("@/runtime-host/socket");
const { UnixRuntimeHostClient } = await import("./client");
const { runStructuredHostStartup } = await import("@/lib/viewerInstrumentation");
const { adoptStructuredHostsAtStartup } = await import("./startup");
const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
const { structuredStartupStatus } = await import("./startupStatus");

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
