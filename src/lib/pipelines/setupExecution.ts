import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { AgentMemoryCell, planAgentMemory } from "@/lib/runtime/agentMemory";
import { planAgentCpu } from "@/lib/runtime/cpuPlacement";
import type { ReviewedSetupRecipe } from "@/lib/projects/setupRecipe";
import type { ExecResult } from "@/lib/workflows/provision";
import type { PipelineSandbox } from "./types";

export type SetupExecution = (root: string, recipe: ReviewedSetupRecipe, sandbox: PipelineSandbox,
  signal?: AbortSignal, authorize?: () => void) => Promise<ExecResult>;

// The scope launcher must die with the Viewer too. Bubblewrap then ends its
// PID namespace, including detached work, even if the Viewer cannot run finally.
const parentDeath = "import ctypes,os,signal,sys\np=int(sys.argv[1])\nif os.getppid()!=p: sys.exit(69)\nif ctypes.CDLL(None).prctl(1,signal.SIGKILL,0,0,0)!=0: sys.exit('setup parent-death isolation is unavailable')\nif os.getppid()!=p: sys.exit(69)\nos.execvp(sys.argv[2],sys.argv[2:])";

/** Setup gets no account credentials. Only its checkout and scratch are
 * writable. PID isolation reaps detached children when the command ends.
 * Unsupported hosts refuse before executing repository code. */
export const executeSetupRecipe: SetupExecution = async (root, recipe, sandbox, signal, authorize) => {
  if (signal?.aborted) return { code: null, stdout: "", stderr: "setup cancelled" };
  if (process.platform !== "linux") throw new Error("project setup requires Linux filesystem isolation; no command was run");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "delegatus-setup-"));
  let memory: AgentMemoryCell | null = null;
  try {
    const privateHome = path.join(scratch, "home");
    await fs.mkdir(privateHome);
    await fs.mkdir(path.join(scratch, "bin"));
    const args = ["--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session",
      ...(sandbox === "restricted" ? ["--unshare-net"] : []),
      "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev"];
    for (const directory of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) {
      try { await fs.stat(directory); args.push("--ro-bind", directory, directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    args.push("--bind", root, root, "--bind", scratch, scratch);
    for (const [index, [name, bytes]] of Object.entries(recipe.files).entries()) {
      const snapshot = path.join(scratch, `file-${index}`);
      await fs.writeFile(snapshot, bytes, { mode: 0o400 });
      args.push("--ro-bind", snapshot, path.join(root, name));
    }
    const interpreter = recipe.command[0] === "bun" ? process.execPath : `/usr/bin/${recipe.command[0]}`;
    args.push("--ro-bind", interpreter, path.join(scratch, "interpreter"));
    args.push("--ro-bind", process.execPath, path.join(scratch, "bin/bun"));
    const env = { PATH: `${scratch}/bin:/usr/bin:/bin`, HOME: privateHome, XDG_CONFIG_HOME: path.join(privateHome, "config"),
      LLV_STATE_DIR: path.join(privateHome, "state"), TMPDIR: scratch, LANG: "C.UTF-8" };
    args.push("--clearenv", ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
      "--chdir", path.resolve(root, recipe.cwd), "--", path.join(scratch, "interpreter"), ...recipe.command.slice(1));
    const { agentRegistry } = await import("@/lib/agent/registry");
    const liveAgents = Object.values(agentRegistry().readOnlySnapshot().entries)
      .filter(entry => entry.structuredHost && entry.status !== "dead" && entry.status !== "unhosted").length + 1;
    const plan = planAgentMemory({ engine: "setup", sessionKey: root, liveAgents, cpu: planAgentCpu("work") });
    memory = plan ? new AgentMemoryCell(plan) : null;
    authorize?.();
    if (signal?.aborted) return { code: null, stdout: "", stderr: "setup cancelled" };
    return await new Promise<ExecResult>((resolve) => {
      let stdout = "", stderr = "", bytes = 0, stopped = "";
      const base = (command: string, argv: string[], options: SpawnOptionsWithoutStdio) =>
        spawn("python3", ["-I", "-S", "-c", parentDeath, String(process.pid), command, ...argv], { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const start = memory?.wrapSpawn(base) ?? base;
      const child = start("bwrap", args, { cwd: root, env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
      child.stdin?.end();
      const stop = (reason: string) => { stopped ||= reason; child.kill("SIGKILL"); };
      const cancel = () => stop("setup cancelled");
      const timer = setTimeout(() => stop("setup timed out after 180 seconds"), 180_000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const append = (chunk: string, stream: "stdout" | "stderr") => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 64 * 1024) { stop("setup output exceeded 64 KiB"); return; }
        if (stream === "stdout") stdout += chunk; else stderr += chunk;
      };
      child.stdout?.setEncoding("utf8").on("data", chunk => append(chunk, "stdout"));
      child.stderr?.setEncoding("utf8").on("data", chunk => append(chunk, "stderr"));
      child.on("error", () => { stopped ||= "setup isolation could not start; no command was run"; });
      child.on("close", (code, exitSignal) => {
        clearTimeout(timer); signal?.removeEventListener("abort", cancel);
        memory?.settleExit({ expected: false });
        resolve({ code: stopped ? null : code, stdout, stderr: stopped || memory?.launchFailure() || stderr, signal: exitSignal });
      });
    });
  } finally { memory?.close(); await fs.rm(scratch, { recursive: true, force: true }); }
};
