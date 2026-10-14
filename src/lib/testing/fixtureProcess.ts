import type { ChildProcess } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";

const trees = new WeakMap<ChildProcess, ProcessIdentity>();
const treeStops = new WeakMap<ChildProcess, Promise<void>>();
const processStops = new WeakMap<ChildProcess, Promise<void>>();

/** Record the original root before the caller can await readiness. */
export function ownFixtureTree<T extends ChildProcess>(child: T): T {
  if (child.pid !== undefined) trees.set(child, captureProcessIdentity(child.pid));
  return child;
}

/** A recorded identity is the only authority for a PID signal. */
export function signalFixtureIdentity(identity: ProcessIdentity, signal: NodeJS.Signals, send = process.kill): boolean {
  if (processIdentityStatus(identity) !== "alive" || procBackend.processExited(identity.pid)) return false;
  try { send(identity.pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return false; }
}

/** Stop a process whose original handle is held by a fixture parent (for
 * example a private tmux server). Capture its identity while it is alive.
 */
export async function stopFixtureIdentity(identity: ProcessIdentity, timeoutMs = 2_000): Promise<void> {
  const pending = () => processIdentityStatus(identity) !== "dead" && !procBackend.processExited(identity.pid);
  const deadline = Date.now() + timeoutMs;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    signalFixtureIdentity(identity, signal);
    const until = signal === "SIGTERM" ? Math.min(deadline, Date.now() + 500) : deadline;
    while (pending() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (pending()) throw new Error("owned fixture identity survived bounded cleanup");
}

/** Snapshot descendants only while the recorded root is still alive. Recheck
 * every recorded member before each signal, including escalation after exit.
 * The runner's cgroup owns forks missed by this bounded local cleanup.
 */
export function stopFixtureTree(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  const existing = treeStops.get(child);
  if (existing) return existing;
  const stopping = Promise.resolve().then(() => stopFixtureTreeOnce(child, timeoutMs));
  const tracked = stopping.finally(() => { if (treeStops.get(child) === tracked) treeStops.delete(child); });
  treeStops.set(child, tracked);
  return tracked;
}

async function stopFixtureTreeOnce(child: ChildProcess, timeoutMs: number): Promise<void> {
  const root = trees.get(child);
  // Some fixtures retain only the ChildProcess handle. They still need the
  // readiness-deadline cleanup, while registered trees capture descendants
  // before stopping the root through the shared signal owner below.
  if (!root) return stopFixtureProcess(child);
  if (child.exitCode !== null || child.signalCode !== null || processIdentityStatus(root) !== "alive") return;
  const parents = procBackend.ppidMap();
  // descendantPids includes the root. Keep it in the identity map for ancestry
  // checks, then leave it out of the descendant signal set below.
  const members = descendantPids(root.pid, parents).reverse().map(pid => captureProcessIdentity(pid));
  if (processIdentityStatus(root) !== "alive") return;
  // Revalidate each ancestry edge after the snapshot. A recycled intermediate
  // must not enroll unrelated descendants under an earlier parent map.
  const byPid = new Map(members.map(identity => [identity.pid, identity]));
  const owned = members.filter(identity => {
    let pid = identity.pid;
    while (pid !== root.pid) {
      const parent = parents.get(pid);
      if (parent === undefined || procBackend.readPpid(pid) !== parent) return false;
      const expected = byPid.get(parent);
      if (!expected || processIdentityStatus(expected) !== "alive") return false;
      pid = parent;
    }
    return processIdentityStatus(root) === "alive";
  });
  // Stop the wrapper before ending its children. A live wrapper can replace a
  // child when that child exits, leaving the replacement outside our snapshot.
  // The captured descendants retain their own signal authority after the
  // root exits; direct cleanup still shares this one root-stop operation.
  await stopFixtureProcess(child);
  // Exit evidence is terminal for a recorded identity. Separate kernel reads
  // can see its zombie start token, then no stat record after reaping; the
  // latter makes processExited return false and must not revive that member.
  let remaining = owned.filter(identity => identity.pid !== root.pid);
  const alive = () => {
    const running: ProcessIdentity[] = [];
    remaining = remaining.filter(identity => {
      const status = processIdentityStatus(identity);
      if (status === "dead" || procBackend.processExited(identity.pid)) return false;
      if (status === "alive") running.push(identity);
      // Missing identity evidence cannot permanently remove a member.
      return true;
    });
    return running;
  };
  const deadline = Date.now() + timeoutMs;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const identity of remaining) signalFixtureIdentity(identity, signal);
    const until = signal === "SIGTERM" ? Math.min(deadline, Date.now() + 500) : deadline;
    while (alive().length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (alive().length) throw new Error("owned fixture tree survived bounded cleanup");
}

/** Report readiness only within a deadline. Callers register the child in the
 * same tick as spawn, then use this wait. Startup errors reap the real handle.
 */
export async function fixtureReport<Report>(child: ChildProcess, name: string, reports: Report[], timeoutMs = 10_000): Promise<Report> {
  const errors: string[] = [];
  child.stderr?.on("data", chunk => errors.push(String(chunk)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Report>((resolve, reject) => {
      let buffered = "";
      child.stdout?.on("data", chunk => {
        buffered += String(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const report = JSON.parse(line) as Report;
            reports.push(report);
            resolve(report);
          } catch (error) { reject(new Error(`${name} reported invalid JSON: ${String(error)}`)); }
        }
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`${name} exited with ${code} before reporting:\n${errors.join("")}`)));
      timer = setTimeout(() => reject(new Error(`${name} did not report within ${timeoutMs}ms:\n${errors.join("")}`)), timeoutMs);
    });
  } catch (error) {
    await stopFixtureTree(child);
    throw error;
  } finally { clearTimeout(timer); }
}

/** Coalesce a tree stop and any direct handle cleanup into one root owner. */
export function stopFixtureProcess(child: ChildProcess, termMs = 500, timeoutMs = 2_000): Promise<void> {
  const existing = processStops.get(child);
  if (existing) return existing;
  const stopping = Promise.resolve().then(() => stopFixtureProcessOnce(child, termMs, timeoutMs));
  const tracked = stopping.finally(() => { if (processStops.get(child) === tracked) processStops.delete(child); });
  processStops.set(child, tracked);
  return tracked;
}

/** Stop only the recorded process identity. A zombie or vanished original
 * process is terminal even while Node has not delivered its ChildProcess exit
 * event; that event can lag behind tree cleanup under CPU contention.
 */
async function stopFixtureProcessOnce(child: ChildProcess, termMs: number, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  const identity = trees.get(child) ?? captureProcessIdentity(child.pid);
  let terminalObserved = false;
  const kernelTerminal = () => {
    if (terminalObserved) return true;
    const status = processIdentityStatus(identity);
    terminalObserved = status === "dead" || (status === "alive" && procBackend.processExited(identity.pid));
    return terminalObserved;
  };
  const handleExited = () => child.exitCode !== null || child.signalCode !== null;
  const waitForHandle = async (durationMs: number): Promise<boolean> => {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      if (handleExited() || processIdentityStatus(identity) === "dead") return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return handleExited() || processIdentityStatus(identity) === "dead";
  };
  const waitAfterKernelExit = async () => {
    if (!await waitForHandle(timeoutMs)) throw new Error(`owned fixture ${child.pid} exited without a handle notification`);
  };
  if (handleExited()) return;
  if (kernelTerminal()) return waitAfterKernelExit();
  signalFixtureProcess(identity, "SIGTERM");
  if (handleExited()) return;
  if (kernelTerminal()) return waitAfterKernelExit();
  if (await waitForHandle(termMs)) return;
  if (kernelTerminal()) return waitAfterKernelExit();
  signalFixtureProcess(identity, "SIGKILL");
  if (await waitForHandle(timeoutMs)) return;
  if (kernelTerminal()) return waitAfterKernelExit();
  throw new Error(`owned fixture ${child.pid} survived TERM and KILL`);
}

/** The process handle owns the root; matching its recorded identity is the
 * signal guard. A separate zombie read here would race the terminal check.
 */
function signalFixtureProcess(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
  if (processIdentityStatus(identity) !== "alive") return false;
  try { process.kill(identity.pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return false; }
}
