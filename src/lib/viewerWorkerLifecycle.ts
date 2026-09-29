import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A resident Viewer worker owns no stdin protocol. The open pipe is its
 * lifetime lease: the kernel closes it even when the Viewer is SIGKILLed. */
export function spawnViewerResidentWorker(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "inherit", "inherit"] });
  child.stdin?.on("error", () => { /* exit/error on the child reports the failure */ });
  return child;
}

/** The release target is the same durable appointment the Viewer checks. A
 * demoted Viewer can keep running in an old container, leaving stdin open. */
export function viewerWorkerOwnsRelease(env: NodeJS.ProcessEnv = process.env): boolean {
  const port = env.PORT?.trim();
  const targetFile = env.LLV_VIEWER_DEPLOY_TARGET?.trim()
    || (env.LLV_STATE_DIR ? path.join(env.LLV_STATE_DIR, "viewer-release.json") : "");
  if (!port || !targetFile) return true;
  let raw: string;
  try {
    raw = fs.readFileSync(targetFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const target = JSON.parse(raw) as { endpoint?: unknown };
    return typeof target.endpoint === "string" && new URL(target.endpoint).port === port;
  } catch {
    return false;
  }
}

/** Call before importing the worker's application graph. */
export function exitWhenViewerOwnershipEnds(options: { releasePollMs?: number } = {}): void {
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
  process.stdin.resume();
  const checkRelease = () => { if (!viewerWorkerOwnsRelease()) process.exit(0); };
  checkRelease();
  const timer = setInterval(checkRelease, options.releasePollMs ?? 2_000);
  timer.unref?.();
}
