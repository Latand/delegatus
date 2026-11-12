import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statePath } from "./configDir";
import { withFileTransactionAsync } from "./state/fileTransaction";
import { writeJsonDurably } from "./state/durableJson";

const exec = promisify(execFile);
export const DOCKER_CACHE_PRUNE_COMMANDS = [
  ["builder", "prune", "-f", "--filter", "until=336h"],
  ["image", "prune", "-a", "-f", "--filter", "until=336h"],
] as const;

/** The attempt is durable before either command: a restart or missing Docker
 * cannot turn minute polling into repeated prune attempts. No other Docker
 * operation is accepted by this module. The daemon enforces unused ownership. */
export function pruneDockerCache(options: {
  file?: string; now?: () => number; mode?: "on" | "dry-run"; deadline?: number;
  run?: (args: readonly string[], timeout: number) => Promise<void>;
} = {}) {
  const file = options.file ?? statePath("docker-cache-retention.json"), now = options.now ?? Date.now;
  return withFileTransactionAsync(file, "daily Docker cache retention", async () => {
    const testContext = process.env.NODE_ENV === "test" || !!process.env.LLV_FIXTURE_PARENT_IDENTITY || !!process.env.LLV_TEST_STARTUP_HOME;
    if (options.mode === "dry-run" || testContext && !options.run)
      return { state: "dry-run", commands: 0, errors: 0 };
    let prior: { attemptedAt: number } | undefined;
    try {
      prior = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isFinite(prior?.attemptedAt)) throw new Error("invalid Docker retention checkpoint");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior && now() < prior.attemptedAt + 86400000) return { state: "waiting", commands: 0, errors: 0 };
    const deadline = options.deadline ?? now() + 22000;
    if (deadline - now() < 1000) return { state: "deferred", commands: 0, errors: 0 };
    const report = { attemptedAt: now(), state: "running", commands: 0, errors: 0 };
    writeJsonDurably(file, report);
    for (const args of DOCKER_CACHE_PRUNE_COMMANDS) {
      try {
        const timeout = Math.min(10000, deadline - now());
        if (timeout <= 0) throw new Error("Docker retention deadline");
        report.commands++;
        if (options.run) await options.run(args, timeout);
        else await exec("docker", [...args], { timeout, maxBuffer: 65536, encoding: "utf8" });
      } catch { report.errors++; }
    }
    report.state = report.errors ? "docker-prune-unavailable" : "complete";
    writeJsonDurably(file, report);
    return report;
  });
}
