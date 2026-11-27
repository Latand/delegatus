import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureProcessIdentity } from "@/lib/processIdentity";

export type ProvisionFixtureReply = "check-ignore" | "cache-permit";

async function controlDirectory(): Promise<string | undefined> {
  const directory = process.env.LLV_PROVISION_FIXTURE_SUPERVISOR;
  if (!directory) return;
  if (!path.isAbsolute(directory)) throw new Error("provisioning fixture supervisor path must be absolute");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("provisioning fixture supervisor directory is not private");
  }
  return directory;
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Private file barrier for release fixtures; the Viewer exposes no request route for it. */
export async function waitForProvisionFixtureReply(
  reply: ProvisionFixtureReply,
  signal: AbortSignal,
  details: Record<string, unknown>,
): Promise<void> {
  const directory = await controlDirectory();
  if (!directory) return;
  const hold = path.join(directory, `hold-${reply}`);
  const release = path.join(directory, `release-${reply}`);
  const interrupt = path.join(directory, `interrupt-${reply}`);
  if (!await exists(hold) || await exists(release)) return;
  const worker = typeof details.workerPid === "number" ? captureProcessIdentity(details.workerPid) : undefined;
  await writeFile(path.join(directory, `entered-${reply}.json`), JSON.stringify({ reply, pid: process.pid, worker, ...details }), { mode: 0o600 });
  while (true) {
    signal.throwIfAborted();
    if (await exists(interrupt)) throw new Error("provisioning fixture supervisor interrupted the held reply");
    if (await exists(release)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Append bounded fixture evidence only when an isolated release harness opted in. */
export async function recordProvisionFixtureEvent(type: string, details: Record<string, unknown> = {}): Promise<void> {
  const directory = await controlDirectory();
  if (!directory) return;
  await writeFile(path.join(directory, "events.ndjson"), `${JSON.stringify({ type, pid: process.pid, ...details })}\n`,
    { flag: "a", mode: 0o600 });
}
