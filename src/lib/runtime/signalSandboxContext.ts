import fs from "node:fs";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus, systemBootEpoch, type ProcessIdentity, type ProcessIdentityStatus } from "@/lib/processIdentity";

export interface SignalSandboxContext {
  policyVersion: 1;
  hostProc: string;
  hostPidNamespace: string;
  hostEpoch: string;
  monitor: ProcessIdentity;
  init: ProcessIdentity;
  native: ProcessIdentity;
  scope: string;
  cgroupRoot: string;
  pidNamespace: string;
  userNamespace: string;
  /** Set by a gate service that moved its command into this namespace
   * (`sandboxGateEntry.ts`): the service's cgroup and the host process that
   * entered the namespace for it. */
  gate?: { cgroup: string; entry: string };
}

/** Markers select the path; kernel proc mounts, namespace membership and the
 * current delegated leaf prove it. Never change the normal proc backend. */
export function signalSandboxContext(env = process.env): SignalSandboxContext | null {
  if (!env.LLV_SIGNAL_SANDBOX) return null;
  try {
    const value = JSON.parse(env.LLV_SIGNAL_SANDBOX) as SignalSandboxContext;
    const link = (file: string) => fs.readlinkSync(file);
    const mount = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").find(line => {
      const fields = line.split(" ");
      return fields[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) === value.hostProc
        && fields[5]?.split(",").includes("ro") && line.includes(" - proc ");
    });
    if (value.policyVersion !== 1 || !path.isAbsolute(value.hostProc) || !mount
      || value.scope.includes("..") || !value.scope.startsWith("/") || !value.scope.endsWith(".scope")
      || !path.isAbsolute(value.cgroupRoot)
      || fs.statSync(value.cgroupRoot, { bigint: true }).ino !== fs.statSync(`/sys/fs/cgroup${value.scope}`, { bigint: true }).ino
      || fs.statSync(value.cgroupRoot, { bigint: true }).dev !== fs.statSync(`/sys/fs/cgroup${value.scope}`, { bigint: true }).dev
      || link("/proc/self/ns/pid") === value.hostPidNamespace
      || !fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").some(line => line.startsWith(`0::${value.scope}/`) || inGate(value.gate, line))) throw new Error("kernel proof mismatch");
    const hostPid = Number(link(path.join(value.hostProc, "self")));
    const outerStatus = fs.readFileSync(path.join(value.hostProc, "self/status"), "utf8");
    const pids = /^NSpid:\s+(.+)$/m.exec(outerStatus)?.[1]?.trim().split(/\s+/).map(Number);
    if (!pids || pids.length < 2 || pids[0] !== hostPid || pids.at(-1) !== process.pid
      || `${value.init.pid}:${fields(value.hostProc, value.init.pid)[19]}` !== value.init.startIdentity) throw new Error("ancestor proc proof mismatch");
    // Native tool sandboxes may add a further PID/user namespace. The kernel
    // parent chain must still terminate at this invocation's recorded init,
    // or, for a gate service's command, at the process that entered for it.
    const gated = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").some(line => inGate(value.gate, line));
    let ancestor = hostPid, found = false;
    for (let depth = 0; depth < 256 && ancestor > 1; depth++) {
      const stat = fields(value.hostProc, ancestor);
      if (ancestor === value.init.pid || (gated && `${ancestor}:${stat[19]}` === value.gate!.entry)) { found = true; break; }
      ancestor = Number(stat[1]);
    }
    if (!found) throw new Error("process is outside the invocation's namespace init");
    return { ...value, pidNamespace: link("/proc/self/ns/pid"), userNamespace: link("/proc/self/ns/user") };
  } catch {
    throw new Error("agent signal sandbox unavailable: namespace or delegated-cgroup proof is missing");
  }
}

/** A gate service's own cgroup, never a path inside the delegated scope. */
function inGate(gate: SignalSandboxContext["gate"], line: string): boolean {
  if (!gate || typeof gate.cgroup !== "string" || typeof gate.entry !== "string" || gate.cgroup.includes("..")
    || !/^\/.+\/delegatus-gate-[0-9a-f-]+\.service$/.test(gate.cgroup)) return false;
  return line === `0::${gate.cgroup}` || line.startsWith(`0::${gate.cgroup}/`);
}

function fields(root: string, pid: number): string[] {
  const text = fs.readFileSync(path.join(root, String(pid), "stat"), "utf8");
  return text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
}

export function cpuOwnerIdentity(localPid: number, env = process.env): ProcessIdentity {
  const context = signalSandboxContext(env);
  if (!context) return captureProcessIdentity(localPid);
  const status = fs.readFileSync(path.join(context.hostProc, "self/status"), "utf8");
  const hostPid = localPid === process.pid ? Number(fs.readlinkSync(path.join(context.hostProc, "self")))
    : localPid === process.ppid ? Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]) : NaN;
  if (!Number.isSafeInteger(hostPid) || hostPid <= 1) throw new Error("CPU admission cannot translate its local owner PID");
  return { pid: hostPid, startIdentity: `${hostPid}:${fields(context.hostProc, hostPid)[19]}`, bootEpoch: context.hostEpoch };
}

/** The host identity of a process recorded in this namespace, such as a
 * supervisor identity a gate inherits. One already recorded on the host is
 * returned as it is; a local one is found by its PID in this namespace and its
 * kernel start time, which no namespace changes. */
export function hostProcessIdentity(local: ProcessIdentity, env = process.env): ProcessIdentity {
  const context = signalSandboxContext(env);
  if (!context || local.bootEpoch === context.hostEpoch) return local;
  if (local.pid === process.pid || local.pid === process.ppid) {
    if (captureProcessIdentity(local.pid).startIdentity !== local.startIdentity) throw new Error("the recorded process has ended");
    return cpuOwnerIdentity(local.pid, env);
  }
  const start = /^\d+:(\d+)$/.exec(local.startIdentity ?? "")?.[1];
  if (local.bootEpoch !== systemBootEpoch() || !start || captureProcessIdentity(local.pid).startIdentity !== local.startIdentity) {
    throw new Error("the recorded process has ended or belongs to another PID namespace");
  }
  for (const name of fs.readdirSync(context.hostProc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.readlinkSync(path.join(context.hostProc, name, "ns/pid")) !== context.pidNamespace
        || fields(context.hostProc, Number(name))[19] !== start) continue;
      const nspid = /^NSpid:\s+(.+)$/m.exec(fs.readFileSync(path.join(context.hostProc, name, "status"), "utf8"))?.[1]?.trim().split(/\s+/);
      if (Number(nspid?.at(-1)) === local.pid) return { pid: Number(name), startIdentity: `${name}:${start}`, bootEpoch: context.hostEpoch };
    } catch { /* Processes of other users and exited ones cannot be the recorded one. */ }
  }
  throw new Error("the recorded process is not visible on the host");
}

export function cpuOwnerStatus(identity: ProcessIdentity, env = process.env): ProcessIdentityStatus {
  const context = signalSandboxContext(env);
  if (differentPidNamespace(identity, context?.hostEpoch ?? systemBootEpoch())) return "unverified";
  if (!context) return processIdentityStatus(identity);
  try {
    const observed = fields(context.hostProc, identity.pid);
    if (["Z", "X", "x"].includes(observed[0]!)) return "dead";
    if (!identity.startIdentity || !identity.bootEpoch || !observed[19]) return "unverified";
    if (identity.startIdentity !== `${identity.pid}:${observed[19]}`) return "dead";
    // A readable living PID with a different namespace epoch is unknown;
    // it must never lose its machine-wide queue ticket on that observation.
    return identity.bootEpoch === context.hostEpoch ? "alive" : "unverified";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unverified";
  }
}

export function cpuOwnerExited(identity: ProcessIdentity, env = process.env): boolean {
  if (differentPidNamespace(identity, signalSandboxContext(env)?.hostEpoch ?? systemBootEpoch())) return false;
  if (!signalSandboxContext(env)) {
    try { return ["Z", "X", "x"].includes(fields("/proc", identity.pid)[0]!); } catch { return false; }
  }
  return cpuOwnerStatus(identity, env) === "dead";
}

/** Losing a launch marker cannot turn a private PID lookup into evidence
 * that another namespace's machine-wide queue owner has died. */
function differentPidNamespace(identity: ProcessIdentity, epoch: string | null): boolean {
  const parse = (value: string | null | undefined) => /^linux:([^:]+):pidns:(pid:\[\d+\])$/.exec(value ?? "");
  const recorded = parse(identity.bootEpoch), current = parse(epoch);
  return Boolean(recorded && current && recorded[1] === current[1] && recorded[2] !== current[2]);
}
