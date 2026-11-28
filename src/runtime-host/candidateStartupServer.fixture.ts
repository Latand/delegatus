export {};

const mode = process.argv[2];
const startupRetry = mode === "retry-ready" || mode === "retry-cancelled" || mode === "retry-interrupted";
const terminal = mode === "terminal" || mode === "terminal-interrupted";
if (!startupRetry && !terminal && mode !== "hanging-body") throw new Error("unknown startup fixture");
let probes = 0;
let boardReads = 0;
const retry = startupRetry ? await startViewerRetry() : null;

async function startViewerRetry() {
  const { GET } = await import("@/app/api/runtime/deployments/capabilities/v1/route");
  const { markStructuredHostStartupProgress } = await import("@/lib/runtime/startupStatus");
  const { runStructuredHostStartup } = await import("@/lib/viewerInstrumentation");
  const authority = new AbortController();
  const finish = Promise.withResolvers<void>();
  let scheduled: (() => void) | undefined;
  let attempts = 0;
  await runStructuredHostStartup(async () => {
    if (++attempts === 1) {
      markStructuredHostStartupProgress({ phase: "reading structured startup registry", completedHosts: 0, totalHosts: null });
      throw new Error("runtime host is unavailable");
    }
    await finish.promise;
  }, () => {}, {
    signal: authority.signal,
    jitterRatio: 0,
    schedule: callback => { scheduled = callback; return { unref() {} }; },
  });
  return () => {
    const response = GET();
    if (probes === 1) {
      if (mode === "retry-cancelled") authority.abort();
      scheduled?.();
    }
    if (probes === 2) {
      if (mode === "retry-interrupted") authority.abort();
      finish.resolve();
    }
    return response;
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (terminal && new URL(request.url).pathname === "/api/files") {
      // The first response lets the parent finish draining the startup stderr.
      return Response.json({ files: ++boardReads > 1 ? [{}] : [] });
    }
    probes++;
    if (retry) return retry();
    if (mode === "hanging-body" && probes > 1) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      }));
    }
    const retrying = mode === "hanging-body";
    return Response.json({ capability: "viewer-deployments", version: 1, structuredHostStartup: {
      state: "failed",
      phase: "reading structured startup registry",
      completedHosts: 0,
      totalHosts: null,
      failurePhase: "reading structured startup registry",
      failureCategory: retrying ? "registry-contention" : "configuration",
      nextRetryAt: retrying ? "2026-11-28T08:14:05.000Z" : null,
    } });
  },
});
if (terminal) {
  const diagnostic = "Authorization: Bearer fixture marker value\n"
    + "-----BEGIN \u001b[31mPRIVATE KEY-----\nfixture-private-key-payload\n"
    + (mode === "terminal" ? "-----END PRIVATE KEY-----\n" : "");
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(`${JSON.stringify("startup exception")}\n${JSON.stringify(diagnostic)}\n` + "fixture tail\n".repeat(2_000),
      error => error ? reject(error) : resolve());
  });
}
console.log(server.url.origin);
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
