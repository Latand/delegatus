import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { prepareLockedDependencies, usesLockedDependencies, worktreeDependencyExec } from "../src/lib/pipelines/lockedDependencies";

const failure = "stage environment: dependency preparation failed";

function findPinnedBun(version: string): string | undefined {
  // Use the image runtime and the same installed cache layout as local-gate.
  const cache = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
  const candidates = new Set([
    ...(process.env.LLV_DOCKER_NSENTER_SHIMS === "1" ? ["/usr/local/bin/bun-container"] : []),
    path.resolve(cache, "delegatus-gate", `bun-${version}`, "node_modules/.bin/bun"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
      .map(dir => Bun.which("bun", { PATH: path.resolve(dir) })),
  ]);
  candidates.delete(process.execPath);
  for (const binary of candidates) {
    if (!binary || !existsSync(binary)) continue;
    const probe = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" });
    if (probe.status === 0 && probe.stdout.trim() === version) return binary;
  }
}

async function prepare(cwd: string): Promise<void> {
  if (!await usesLockedDependencies(cwd) || !statSync(path.join(cwd, ".git"), { throwIfNoEntry: false })?.isFile()) return;

  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const pins = new Set([...dockerfile.matchAll(/npm install -g bun@(\d+\.\d+\.\d+)/g)].map(match => match[1]!));
  const [required] = pins;
  if (!required || pins.size !== 1) throw new Error("Dockerfile must carry exactly one Bun pin");
  const found = process.versions.bun;
  const versionError = `found Bun ${found}. Dependency preparation requires Dockerfile-pinned Bun ${required}`;
  if (found !== required) {
    const binary = process.argv[2] === "--pinned" ? undefined : findPinnedBun(required);
    if (!binary) throw new Error(versionError);
    const child = Bun.spawn([binary, "--no-env-file", import.meta.path, "--pinned"], {
      cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.exitCode = await child.exited;
    return;
  }
  if (typeof Reflect.get(Bun.TOML, "stringify") !== "function") {
    throw new Error(`${versionError} with Bun.TOML.stringify`);
  }

  // A selected bun-container or cached binary may have no matching bun on PATH.
  await prepareLockedDependencies(cwd, {
    exec: (command, args, directory, env, options) =>
      worktreeDependencyExec(command === "bun" ? process.execPath : command, args, directory, env, options),
  });
}

// Also runs after a merge, before the stage can interpret compiler diagnostics.
try {
  await prepare(process.cwd());
} catch (error) {
  const reason = error instanceof Error ? error.message : "";
  console.error(!reason ? failure : reason.startsWith(failure) ? reason : `${failure}: ${reason}`);
  process.exitCode = 1;
}
