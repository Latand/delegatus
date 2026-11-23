// Instrumentation and the route can load in separate Next bundle realms.
const viewer = process as typeof process & { __llvReadyRevision?: string };

export function markViewerHttpReady(): void {
  const revision = process.env.LLV_DIAGNOSTIC_REVISION;
  if (revision && /^[a-f0-9]{40}$/.test(revision)) viewer.__llvReadyRevision = revision;
}

/** These receipts are read from this Viewer's stderr by its own launcher. */
export function viewerStartupPhases() {
  let phase: string | undefined;
  let started = 0;
  const record = (status: "running" | "ready", elapsedMs: number) => {
    if (phase && process.env.LLV_VIEWER_STARTUP_PHASES === "1") {
      console.error(`[viewer startup phase] ${phase} ${status} ${elapsedMs}`);
    }
  };
  const finish = () => record("ready", Math.round(performance.now() - started));
  return {
    begin(next: string) {
      finish();
      phase = next;
      started = performance.now();
      record("running", 0);
    },
    finish,
  };
}

export function viewerReadinessResponse(request: Request): Response {
  const expected = new URL(request.url).searchParams.getAll("revision");
  const headers = new Headers({ "cache-control": "no-store" });
  if (expected.length !== 1 || !/^[a-f0-9]{40}$/.test(expected[0])) {
    return new Response(null, { status: 400, headers });
  }
  const revision = viewer.__llvReadyRevision;
  if (!revision) return new Response(null, { status: 503, headers });
  if (expected[0] !== revision) return new Response(null, { status: 409, headers });
  headers.set("x-delegatus-viewer-revision", revision);
  return new Response(null, { status: 200, headers });
}
