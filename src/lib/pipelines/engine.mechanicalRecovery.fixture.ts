import path from "node:path";
import { expect, spawn } from "./engine.fixture";
import type { Pipeline } from "./types";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";

// Every observation starts a new interpreter against the writer's real store.
export async function restartedTick(now: string, mode = "spawn", repo?: string, pipelineId?: string) {
  const child = ownFixtureTree(spawn(process.execPath, ["test", "--timeout=60000", path.join(import.meta.dir, "engine.mechanicalRecovery.test.ts"), "-t", "restart observation"], { cwd: process.cwd(),
    env: { ...process.env, MECHANICAL_STATE: process.env.LLV_STATE_DIR, MECHANICAL_NOW: now,
      MECHANICAL_MODE: mode, MECHANICAL_REPO: repo, MECHANICAL_PIPELINE_ID: pipelineId },
    stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`restart did not finish: ${stderr}`)), 30_000); }),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as { lane: Pipeline; spawns: unknown[]; publicationOrder?: string[] };
  } finally { clearTimeout(timer); await stopFixtureTree(child); }
}
