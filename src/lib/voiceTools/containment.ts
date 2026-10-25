import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ContainmentReason } from "./contracts";

type Availability = { executable: string; reason?: never } | { executable?: never; reason: ContainmentReason };
async function systemBubblewrap(): Promise<string | null> {
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return await fs.realpath(candidate);
    } catch { /* Try the next system installation. */ }
  }
  return null;
}
/** Only trusted system code runs here, before package resolution or proposed code. */
async function usable(executable: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(executable, ["--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("error", () => { /* close follows error, including failed spawn. */ });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** No environment switch or proposal input can choose containment availability. */
export async function stdioContainment(platform: NodeJS.Platform = process.platform,
  find = systemBubblewrap, check = usable): Promise<Availability> {
  if (platform !== "linux") return { reason: platform === "darwin" ? "MACOS" : platform === "win32" ? "WINDOWS" : "PLATFORM_UNSUPPORTED" };
  const executable = await find();
  if (!executable) return { reason: "BWRAP_MISSING" };
  return await check(executable) ? { executable } : { reason: "BWRAP_UNAVAILABLE" };
}
