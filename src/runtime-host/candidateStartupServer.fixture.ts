import fs from "node:fs";

const mode = process.argv[2];
const stderrGateFile = process.argv[3];
const stderrWrittenFile = process.argv[4];
if ((mode !== "terminal" && mode !== "terminal-interrupted" && mode !== "hanging-body" && mode !== "retry-ready") || !stderrGateFile || !stderrWrittenFile) throw new Error("unknown startup fixture");
let probes = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    probes++;
    if (mode === "retry-ready" && probes >= 3) {
      return Response.json({ capability: "viewer-deployments", version: 1, structuredHostStartup: {
        state: "ready", phase: "startup complete", completedHosts: 1, totalHosts: 1,
        failurePhase: null, failureCategory: null, nextRetryAt: null,
      } });
    }
    if (mode === "hanging-body" && probes > 1) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      }));
    }
    const retrying = mode === "hanging-body" || mode === "retry-ready";
    return Response.json({ capability: "viewer-deployments", version: 1, structuredHostStartup: {
      state: "failed",
      phase: "reading structured startup registry",
      completedHosts: 0,
      totalHosts: null,
      failurePhase: "reading structured startup registry",
      failureCategory: retrying ? "registry-contention" : "configuration",
      nextRetryAt: retrying && (mode === "hanging-body" || probes === 1) ? "2026-11-28T08:14:05.000Z" : null,
    } });
  },
});
console.log(server.url.origin);
if (mode === "terminal" || mode === "terminal-interrupted") {
  while (!fs.existsSync(stderrGateFile)) await Bun.sleep(5);
  const diagnostic = "Authorization: Bearer fixture marker value\n"
    + "-----BEGIN \u001b[31mPRIVATE KEY-----\nfixture-private-key-payload\n"
    + (mode === "terminal" ? "-----END PRIVATE KEY-----\n" : "");
  process.stderr.write(`${JSON.stringify("startup exception")}\n${JSON.stringify(diagnostic)}\n` + "fixture tail\n".repeat(2_000));
  fs.writeFileSync(stderrWrittenFile, "1");
}
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
