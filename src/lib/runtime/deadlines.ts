/* Every deadline a web-side caller puts on a runtime-host RPC lives here.
   A route, a controller or a client constructor that writes its own number
   drifts from the others, and on 2026-10-07 a deployment had to be patched in
   its compiled output (45 files) because the numbers were scattered. A test
   (`deadlines.test.ts`) fails on a literal anywhere else under `src/`. */

/** An ordinary RPC: one keyed read or one write the host answers from memory
    or one SQLite statement. */
export const RUNTIME_RPC_DEADLINE_MS = 10_000;

/** A snapshot frame is megabytes at production size and its host-side rebuild
    is O(state), so it gets the long bound. */
export const RUNTIME_SNAPSHOT_DEADLINE_MS = 30_000;

/** Admission of a Viewer deployment waits on the host's own build probe. */
export const VIEWER_DEPLOYMENT_DEADLINE_MS = 120_000;

/** Startup adoption can wait for a host that is still replaying its journal
    without changing what an interactive caller waits. */
export const RUNTIME_STARTUP_READ_DEADLINE_MS = 30_000;
