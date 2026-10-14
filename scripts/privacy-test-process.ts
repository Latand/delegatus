import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Keep real CLI coverage while overlapping process startup and I/O on runners.
// A small cap also bounds memory and leaves capacity for the parent test runner.
const capacity = Math.min(4, availableParallelism());
let active = 0;
const waiting: Array<() => void> = [];

let ticksPerSecond: number | undefined;
function childCpu(pid: number) {
  if (ticksPerSecond === undefined) {
    const output = execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] });
    const ticks = Number(output.trim());
    if (!Number.isSafeInteger(ticks) || ticks <= 0) {
      throw new Error("privacy child CPU accounting requires CLK_TCK");
    }
    ticksPerSecond = ticks;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    // proc_pid_stat fields 14/15 are process user/system ticks; field 22
    // binds this observation to the child that was captured before any await.
    const ticks = Number(fields[11]) + Number(fields[12]);
    if (!fields[19] || !Number.isFinite(ticks)) throw new Error("invalid privacy child CPU counters");
    return { identity: fields[19], milliseconds: ticks * 1000 / ticksPerSecond };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runPrivacyTestProcess(options: {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array;
  stderr: "pipe";
  stdout: "pipe";
}, { timeoutMs = 20_000, cpuBudgetMs }: { timeoutMs?: number; cpuBudgetMs?: number } = {}) {
  if (active >= capacity) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cpuTimer: ReturnType<typeof setInterval> | undefined;
  let guardError: unknown;
  let stoppedBy: "cpu" | "wall" | undefined;
  try {
    const spawned = Bun.spawn(options);
    child = spawned;
    // A stuck child fails independently of the workflow's outer suite cap.
    timer = setTimeout(() => { stoppedBy = "wall"; spawned.kill("SIGKILL"); }, timeoutMs);
    if (cpuBudgetMs !== undefined && process.platform === "linux") {
      if (!Number.isFinite(cpuBudgetMs) || cpuBudgetMs <= 0) throw new Error("privacy child CPU budget must be positive");
      const captured = childCpu(spawned.pid);
      cpuTimer = setInterval(() => {
        if (spawned.exitCode !== null) return;
        try {
          const current = childCpu(spawned.pid);
          if (current && current.identity === captured?.identity && current.milliseconds >= cpuBudgetMs) {
            stoppedBy = "cpu"; spawned.kill("SIGKILL");
          }
        } catch (error) { guardError = error; spawned.kill("SIGKILL"); }
      }, 50);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(spawned.stdout).arrayBuffer(),
      new Response(spawned.stderr).arrayBuffer(),
      spawned.exited,
    ]);
    if (guardError) throw guardError;
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode, stoppedBy };
  } finally {
    clearTimeout(timer);
    clearInterval(cpuTimer);
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  }
}
