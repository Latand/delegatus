// Instrumentation and the route can load in separate Next bundle realms.
const viewer = process as typeof process & { __llvReadyRevision?: string };
declare const __DELEGATUS_BUILD_REVISION__: string;

export function markViewerHttpReady(buildRevision: string | null =
  typeof __DELEGATUS_BUILD_REVISION__ === "string" ? __DELEGATUS_BUILD_REVISION__ : null): void {
  const revision = buildRevision;
  if (revision && /^[a-f0-9]{40}$/.test(revision)) viewer.__llvReadyRevision = revision;
}

type StartupPhase = "http-ingress" | "access" | "release-authority" | "state-compatibility" | "registry" | "activation";

/** These receipts are read from this Viewer's stderr by its own launcher. */
export function viewerStartupPhases() {
  let phase: StartupPhase | undefined;
  let started = 0;
  let highWater = 0;
  let lastEmittedAt = -Infinity;
  const record = (value: string) => {
    if (phase && process.env.LLV_VIEWER_STARTUP_PHASES === "1") {
      console.error(`[viewer startup phase] ${phase} ${value}`);
    }
  };
  const finish = () => {
    record(`ready ${Math.round(performance.now() - started)}`);
    phase = undefined;
  };
  return {
    begin(next: StartupPhase) {
      finish();
      phase = next;
      started = performance.now();
      highWater = 0;
      lastEmittedAt = -Infinity;
      record("running 0");
    },
    progress(done: number, total: number) {
      // Zero total describes work whose number of slices is discovered as it runs.
      if (!phase || !Number.isSafeInteger(done) || done <= highWater || done > 9_999_999_999
        || !Number.isSafeInteger(total) || total < 0 || total > 9_999_999_999 || (total !== 0 && done > total)) return;
      highWater = done;
      if (process.env.LLV_VIEWER_STARTUP_PHASES !== "1") return;
      const now = performance.now();
      if (now - lastEmittedAt < 1_000) return;
      lastEmittedAt = now;
      record(`progress ${done} ${total}`);
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
