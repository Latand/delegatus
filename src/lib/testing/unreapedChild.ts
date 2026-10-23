import fs from "node:fs";

import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";

/** A real zombie and the live parent that never reaps it (#2967). The shell
    starts a short child and execs into `sleep`, which installs no SIGCHLD
    handler and never waits, so the child stays in state Z under a running
    parent, as the stopped host's children did under the server. Only the
    parent is ever signalled, through the handle this fixture spawned. */
export type UnreapedChild = {
  parent: ReturnType<typeof Bun.spawn>;
  parentIdentity: ProcessIdentity;
  zombie: ProcessIdentity;
  stop(): Promise<void>;
};

export async function startUnreapedChild(timeoutMs = 5_000): Promise<UnreapedChild> {
  const parent = Bun.spawn(["sh", "-c", "sleep 0.2 & echo $!; exec sleep 300"], { stdout: "pipe", stderr: "ignore" });
  const stop = async () => {
    try { parent.kill("SIGKILL"); } catch { /* already gone */ }
    await parent.exited;
  };
  try {
    const parentIdentity = captureProcessIdentity(parent.pid);
    const reader = (parent.stdout as ReadableStream<Uint8Array>).getReader();
    let printed = "";
    while (!printed.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("unreaped child fixture printed no pid");
      printed += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const pid = Number(printed.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`unreaped child fixture printed ${JSON.stringify(printed)}`);
    const zombie = captureProcessIdentity(pid);
    const deadline = Date.now() + timeoutMs;
    while (!procBackend.processExited(pid)) {
      if (Date.now() >= deadline) throw new Error(`process ${pid} never became a zombie`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { parent, parentIdentity, zombie, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A live process whose main thread has exited (#2967). Its leader reads Z in
    /proc/<pid>/stat while a second thread keeps appending a line to `output`
    every 50 ms, so the process still writes. Only this handle is signalled. */
export type LeaderExitedChild = {
  process: ReturnType<typeof Bun.spawn>;
  identity: ProcessIdentity;
  stop(): Promise<void>;
};

const LEADER_EXITED_SCRIPT = `
import ctypes, sys, threading, time
def write():
    while True:
        with open(sys.argv[1], "a") as output:
            output.write("x\\n")
        time.sleep(0.05)
threading.Thread(target=write).start()
ctypes.CDLL(None).pthread_exit(None)
`;

function leaderState(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/, 1)[0] ?? null;
  } catch {
    return null;
  }
}

export async function startLeaderExitedChild(python: string, output: string, timeoutMs = 5_000): Promise<LeaderExitedChild> {
  const child = Bun.spawn([python, "-I", "-c", LEADER_EXITED_SCRIPT, output], { stdout: "ignore", stderr: "ignore" });
  const stop = async () => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await child.exited;
  };
  try {
    const identity = captureProcessIdentity(child.pid);
    const deadline = Date.now() + timeoutMs;
    while (leaderState(child.pid) !== "Z" || !fs.existsSync(output)) {
      if (child.exitCode !== null) throw new Error(`leader-exited fixture ended with ${child.exitCode}`);
      if (Date.now() >= deadline) throw new Error(`process ${child.pid} never ran with an exited leader`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { process: child, identity, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
