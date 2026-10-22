import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

/* DELEGATUS_STANDALONE and DELEGATUS_DEV_ORIGINS fold into the LLV_ names
   read below (docs/design/rename-delegatus.md §5). */
import "./bin/envAlias.mjs";

const nextConfig: NextConfig = {
  // Conditional standalone output keeps `bun run build && bun start` warning-free while packaging can still opt in.
  output: process.env.LLV_STANDALONE === "1" ? "standalone" : undefined,
  // Dev-only: hosts allowed to reach dev resources cross-origin (Tailscale/LAN preview).
  allowedDevOrigins: process.env.LLV_DEV_ORIGINS ? process.env.LLV_DEV_ORIGINS.split(",") : undefined,
  images: { unoptimized: true },
  experimental: {
    // A send can carry 24 MiB of encoded images plus 40 MiB of files
    // (about 54 MiB after base64). Keep room for its JSON envelope so the
    // proxy forwards complete bodies to the existing attachment validators.
    proxyClientMaxBodySize: 80 * 1024 * 1024,
  },
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**"],
  },
  outputFileTracingIncludes: {
    "/*": [
      ".next/server/file-scanner-worker.js",
      ".next/server/files-response-worker.js",
      ".next/server/task-page-worker.js",
      ".next/server/resource-collector-worker.js",
      ".next/server/account-migration-controller-worker.js",
      ".next/server/state-backup-worker.js",
      ".next/server/role-memory-delivery-index-worker.js",
      ".next/server/worktree-sweep-worker.js",
      ".next/server/retention-worker.js",
      ".next/server/self-update-work-worker.js",
      ".next/server/transcript-search-index-worker.js",
      ".next/server/transcript-search-query-worker.js",
      ".next/server/relay-attachment-stage-worker.js",
      ".next/server/relay-pdf-validation-worker.js",
      ".next/server/mcp-task-worker.js",
      ".next/server/memory-import-worker.js",
      ".next/server/voice-tools-probe-worker.js",
      ".next/server/chunks/**",
    ],
  },
  webpack(config, { isServer, nextRuntime }) {
    if (isServer && nextRuntime === "nodejs") {
      // Bundled, ws's optional `bufferutil` peer resolves to an empty module,
      // so every client frame of 48 bytes or more threw `b.mask is not a
      // function` and the Codex socket transport could not write. Required at
      // runtime, Bun serves its own `ws` and Node the installed package, which
      // masks in JavaScript when `bufferutil` is absent. A CommonJS external
      // keeps the importing modules synchronous; `serverExternalPackages`
      // emits `import("ws")` and turns every importer into an async module.
      config.externals = [...[config.externals ?? []].flat(), { ws: "commonjs ws" }];
      const originalEntry = config.entry;
      config.entry = async () => ({
        ...(typeof originalEntry === "function" ? await originalEntry() : originalEntry),
        "file-scanner-worker": "./src/lib/fileScanner.worker.ts",
        "files-response-worker": "./src/lib/filesResponse.worker.ts",
        "task-page-worker": "./src/lib/taskPage.worker.ts",
        "resource-collector-worker": "./src/lib/resourceCollector.worker.ts",
        "account-migration-controller-worker": "./src/lib/accountMigrationController.worker.ts",
        "state-backup-worker": "./src/lib/stateBackup.worker.ts",
        "role-memory-delivery-index-worker": "./src/lib/roleMemoryDeliveryIndex.worker.ts",
        "worktree-sweep-worker": "./src/lib/worktreeSweep.worker.ts",
        "retention-worker": "./src/lib/retention.worker.ts",
        "memory-import-worker": "./src/lib/memoryImport.worker.ts",
        "voice-tools-probe-worker": "./src/lib/voiceTools/probe.worker.ts",
        "self-update-work-worker": "./src/lib/selfUpdateWork.worker.ts",
        "transcript-search-index-worker": "./src/lib/transcriptSearchIndex.worker.ts",
        "transcript-search-query-worker": "./src/lib/transcriptSearchQuery.worker.ts",
        "relay-attachment-stage-worker": "./src/lib/externalRelay/attachmentStage.worker.ts",
        "relay-pdf-validation-worker": "./src/lib/externalRelay/pdfValidation.worker.ts",
        // The shared MCP graph imports App Router APIs, including after().
        "mcp-task-worker": { import: "./src/lib/mcpTask.worker.ts", layer: "rsc" },
      });
    }
    return config;
  },
};

export default function configureNext(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    // Every build entry point loads this config before Next launches TypeScript.
    // Preserve unrelated Node options and any larger caller-supplied heap.
    const options = process.env.NODE_OPTIONS ?? "";
    const limits = [...options.matchAll(/(?:^|\s)["']?--max[-_]old[-_]space[-_]size(?:=|\s+)["']?(\d+)/g)];
    const heap = Math.max(6144, ...limits.map(match => Number(match[1])));
    process.env.NODE_OPTIONS = `${options} --max-old-space-size=${heap}`.trim();
    // Keep the full repository check in tsconfig.json for development and gates.
    return { ...nextConfig,
      // Heavy gates have a three-CPU quota. Next otherwise sees the host's
      // online CPUs and starts 23 page-data workers in each lane. Leave one
      // CPU for their coordinator and bound their aggregate memory demand.
      experimental: { ...nextConfig.experimental, cpus: 2 },
      typescript: { tsconfigPath: "tsconfig.production.json" },
    };
  }
  return nextConfig;
}
