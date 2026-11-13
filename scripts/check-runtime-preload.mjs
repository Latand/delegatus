import path from "node:path";
import { admitWorker } from "./check-worker-client.mjs";

// Classify the interpreter's actual entry point, never a package-script name
// or shell's source text. Both TypeScript CLI entry points run in this PID.
const entry = path.basename(process.argv[1] ?? "").replace(/\.(?:js|cjs|mjs|cmd|exe)$/, "");
if (entry === "tsc" || entry === "_tsc") await admitWorker("compiler");

// Older checkouts have no test preload. The inherited runtime preload still
// sees the final Bun test invocation before any test module is evaluated.
if (process.versions.bun) {
  const { isBunTestProcess } = await import("./check-runtime-args.ts");
  if (isBunTestProcess()) await admitWorker("test");
}
