import { admitWorker } from "./check-worker-client.mjs";

// Older checkouts have no test preload. The inherited runtime preload still
// sees the final Bun test invocation before any test module is evaluated.
if (process.versions.bun) {
  const { isBunTestProcess } = await import("./check-runtime-args.ts");
  // A raw nested test may have deliberately cleared its inherited owner.
  // Its checkout preload establishes a runner before entering admission.
  if (isBunTestProcess() && (process.env.LLV_CHECK_BROKER ?? process.env.DELEGATUS_CHECK_BROKER)) {
    await admitWorker("test");
    // Package scripts create a new test PID beneath the owned command. The
    // broker has verified that process and holds its permit through exit;
    // older preloads can now recognize it without starting a second runner.
    process.env.LLV_PORTABLE_TEST_RUNNER_PID = String(process.pid);
  }
}
