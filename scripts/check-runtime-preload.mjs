import { admitWorker } from "./check-worker-client.mjs";

// Older checkouts have no test preload. The inherited runtime preload still
// sees the final Bun test invocation before any test module is evaluated.
if (process.versions.bun) {
  const { isBunTestProcess } = await import("./check-runtime-args.ts");
  if (isBunTestProcess()) await admitWorker("test");
}
