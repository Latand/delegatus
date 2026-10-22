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
