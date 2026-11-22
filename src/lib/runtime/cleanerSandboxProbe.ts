import { spawn } from "node:child_process";
import { signalDetachedProcessGroup } from "@/lib/processGroup";

export const CLEANER_SANDBOX_READY = "cleaner-sandbox-ready";

/** Run a command through the exact filesystem profile before starting a model.
 * No cached verdict: a recovered host must prove its new workspace too. */
export function assertCleanerSandboxAvailable(options: Parameters<typeof assertCodexSandboxAvailable>[0]): Promise<void> {
  return assertCodexSandboxAvailable(options, "disk cleaner sandbox");
}

export async function assertCodexSandboxAvailable(options: {
  binary?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  permissionProfile?: string;
  permissionProfileConfig?: string;
}, label: string): Promise<void> {
  const { permissionProfile, permissionProfileConfig } = options;
  if (!permissionProfile || !permissionProfileConfig) {
    throw new Error(`${label} unavailable: missing permission profile`);
  }
  await new Promise<void>((resolve, reject) => {
    const command = process.platform === "win32"
      ? ["cmd.exe", "/d", "/c", `echo ${CLEANER_SANDBOX_READY}`]
      : ["/bin/sh", "-c", `printf ${CLEANER_SANDBOX_READY}`];
    const child = spawn(options.binary ?? process.env.LLV_CODEX_BINARY ?? "codex", [
      "sandbox", "-C", options.cwd, "-P", permissionProfile,
      "-c", permissionProfileConfig, "--", ...command,
    ], { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-4096); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const deadline = setTimeout(() => {
      timedOut = true;
      signalDetachedProcessGroup(child, "SIGKILL");
    }, 10_000);
    child.once("error", error => {
      clearTimeout(deadline);
      reject(new Error(`${label} unavailable: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (!timedOut && code === 0 && stdout.trim() === CLEANER_SANDBOX_READY) resolve();
      else reject(new Error(`${label} unavailable: ${timedOut ? "probe timed out" : stderr.trim() || `probe exited ${code ?? signal} without completion`}`));
    });
  });
}
