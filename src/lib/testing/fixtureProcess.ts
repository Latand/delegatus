import type { ChildProcess } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";

const trees = new WeakMap<ChildProcess, ProcessIdentity>();

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
export async function stopFixtureTree(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  const root = trees.get(child);
  if (!root || child.exitCode !== null || child.signalCode !== null || processIdentityStatus(root) !== "alive") return;
  const parents = procBackend.ppidMap();
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
  const alive = () => owned.filter(identity => processIdentityStatus(identity) === "alive" && !procBackend.processExited(identity.pid));
  const deadline = Date.now() + timeoutMs;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const identity of owned) signalFixtureIdentity(identity, signal);
    const until = signal === "SIGTERM" ? Math.min(deadline, Date.now() + 500) : deadline;
    while (alive().length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (alive().length) throw new Error("owned fixture tree survived bounded cleanup");
  await stopFixtureProcess(child);
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
    await stopFixtureProcess(child);
    throw error;
  } finally { clearTimeout(timer); }
}

/** ChildProcess.kill targets its original handle, and refuses after exit. */
export async function stopFixtureProcess(child: ChildProcess, termMs = 500, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), termMs);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`owned fixture ${child.pid} survived TERM and KILL`)), timeoutMs);
    })]);
  } finally { clearTimeout(forced); clearTimeout(deadline); }
}
