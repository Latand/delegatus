import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { stampPackageRevision } from "./package-revision.mjs";
import {
  discardUnsupportedApiCredentials,
  viewerChildProcessOptions,
  withoutUnsupportedApiCredentials,
} from "../bin/server-runtime.mjs";

discardUnsupportedApiCredentials();


const root = process.cwd();
const nextBin = join(root, "node_modules", ".bin", "next");
const standaloneDir = join(root, ".next", "standalone");
const staticDir = join(root, ".next", "static");
const distDir = join(root, "dist");
const distStandaloneDir = join(distDir, "standalone");
const runtimeHostBundle = join(distDir, "runtime-host.mjs");

const standaloneServerBootstrap = `const { spawn } = require("node:child_process");

if (process.versions.bun) {
  require("./server.bun.js");
} else {
  import("./bin/server-runtime.mjs").then(({ withoutUnsupportedApiCredentials }) => {
    const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawn(bun, ["--bun", __filename, ...process.argv.slice(2)], {
      env: withoutUnsupportedApiCredentials(process.env),
      stdio: "inherit",
    });
    const signals = ["SIGINT", "SIGTERM"];
    const forward = signal => child.kill(signal);
    for (const signal of signals) process.on(signal, forward);
    child.once("error", (error) => {
      console.error(\`Failed to start the Bun server runtime: \${error.message}\`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      for (const signal of signals) process.removeListener(signal, forward);
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  }).catch(error => {
    console.error(\`Failed to load the Bun server runtime: \${error.message}\`);
    process.exitCode = 1;
  });
}
`;

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const env = { ...withoutUnsupportedApiCredentials(process.env), LLV_STANDALONE: "1" };
    for (const key of Object.keys(env)) {
      if (key.startsWith("__NEXT_PRIVATE_")) delete env[key];
    }
    const child = spawn(nextBin, ["build", "--webpack"], viewerChildProcessOptions({
      cwd: root,
      env,
      stdio: "inherit",
    }));

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${nextBin}: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Standalone build failed after signal ${signal}.`
            : `Standalone build failed with exit code ${code}.`,
        ),
      );
    });
  });
}

function runMcpBuild() {
  return new Promise((resolve, reject) => {
    const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawn(bun, ["run", "build:mcp"], viewerChildProcessOptions({
      cwd: root,
      env: withoutUnsupportedApiCredentials(process.env),
      stdio: "inherit",
    }));
    child.on("error", (error) => reject(new Error(`Failed to start ${bun}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `MCP build stopped after signal ${signal}.` : `MCP build failed with exit code ${code}.`));
    });
  });
}

function runRuntimeHostBuild() {
  return new Promise((resolve, reject) => {
    const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawn(bun, [
      "build",
      "src/runtime-host/main.ts",
      "--target=bun",
      "--format=esm",
      `--outfile=${runtimeHostBundle}`,
    ], viewerChildProcessOptions({
      cwd: root,
      env: withoutUnsupportedApiCredentials(process.env),
      stdio: "inherit",
    }));
    child.on("error", (error) => reject(new Error(`Failed to start ${bun}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `Runtime host build stopped after signal ${signal}.` : `Runtime host build failed with exit code ${code}.`));
    });
  });
}

async function runGateBuild() {
  await new Promise((resolve, reject) => {
    const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawn(bun, ["scripts/build-gate.ts"], viewerChildProcessOptions({ cwd: root, env: withoutUnsupportedApiCredentials(process.env), stdio: "inherit" }));
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Gate bundle failed")));
  });
}

async function findStandaloneServer(dir) {
  const directServer = join(dir, "server.js");
  if (existsSync(directServer)) {
    return dir;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".next") {
      continue;
    }

    const found = await findStandaloneServer(join(dir, entry.name));
    if (found) {
      return found;
    }
  }

  return null;
}

async function main() {
  await runNextBuild();

  const appStandaloneDir = await findStandaloneServer(standaloneDir);
  if (!appStandaloneDir) {
    throw new Error("Standalone build did not produce .next/standalone/server.js.");
  }

  await rm(distDir, { recursive: true, force: true });
  await cp(standaloneDir, distStandaloneDir, { recursive: true });
  if (appStandaloneDir !== standaloneDir) {
    await cp(appStandaloneDir, distStandaloneDir, { recursive: true });
    await rm(join(distStandaloneDir, ".claude"), { recursive: true, force: true });
  }
  await cp(staticDir, join(distStandaloneDir, ".next", "static"), { recursive: true });
  await rename(join(distStandaloneDir, "server.js"), join(distStandaloneDir, "server.bun.js"));
  await writeFile(join(distStandaloneDir, "server.js"), standaloneServerBootstrap);
  await runRuntimeHostBuild();
  await runMcpBuild();
  await runGateBuild();

  // Next traces route imports, so it misses file-based launcher dependencies
  // and public URLs. Assemble these complete runtime inputs explicitly. The
  // MCP launcher resolves dist/mcp-server.mjs relative to its own bin directory.
  for (const directory of ["bin", "public", "vendor"]) {
    await cp(join(root, directory), join(distStandaloneDir, directory), { recursive: true });
  }
  const standaloneBundles = join(distStandaloneDir, "dist");
  await mkdir(standaloneBundles, { recursive: true });
  for (const bundle of ["mcp-server.mjs", "runtime-host.mjs", "gate"]) {
    await cp(join(distDir, bundle), join(standaloneBundles, bundle), { recursive: true });
  }

  if (!existsSync(join(distStandaloneDir, "server.js")) || !existsSync(runtimeHostBundle)) {
    throw new Error("Prepack did not produce the standalone server and runtime host bundles.");
  }
  /* Last, so a failed build leaves package.json as it was. A pack outside a
     git checkout names no revision; the release gate is what requires one. */
  if (!stampPackageRevision(root)) console.warn("Prepack found no git revision; the packed manifest names none.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
