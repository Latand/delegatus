import fs from "node:fs";
import path from "node:path";

import { captureProcessIdentity, processIdentityStatus, sameRecordedProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { readHotStateAuthority, type HotStateAuthority } from "./hotStateAuthority";
import { withFileTransactionSync } from "./fileTransaction";
import { preserveManagedNativeProcesses, resumeRetirementOwner } from "@/runtime-host/managedNativePreservation";

function parentPid(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

function containerId(pid: number): string | null {
  try {
    return /(?:^|\/)(?:docker-)?([a-f0-9]{64})(?:\.scope)?(?:\/|$)/m.exec(
      fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
    )?.[1] ?? null;
  } catch { return null; }
}

function cgroup(pid: number): string | null {
  try { return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() || null; }
  catch { return null; }
}

/** This helper can signal only its own Viewer grandparent, in the same Docker
 * container. A legacy adapter has no containment owner; a newer one owns the
 * Docker stop itself. In either case the adapter still proves death before
 * it checkpoints or grants the prior release authority. */
export async function runManagedRetirementGuard(directory: string, revision: string, owner: ProcessIdentity): Promise<void> {
  const id = containerId(owner.pid);
  const group = cgroup(owner.pid);
  // Docker's private cgroup namespace can expose only "/". Ancestry and
  // equal kernel membership still prove this helper's own Viewer.
  if ((!id && !fs.existsSync("/.dockerenv")) || !group || group !== cgroup(process.pid) || parentPid(process.ppid) !== owner.pid
    || processIdentityStatus(owner) !== "alive") throw new Error("retirement guard cannot prove its Viewer ancestry");
  const sameFence = (request: HotStateAuthority, current: HotStateAuthority | null) =>
    current?.mode === "fencing" && current.epoch === request.epoch && current.releaseRevision === revision
    && !current.checkpoint && !current.retirementOwner && current.activationOwner !== undefined
    && sameRecordedProcessIdentity(current.activationOwner, owner);
  process.stdout.write("ready\n");
  let fence: HotStateAuthority | null = null;
  let observedAt = 0;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (processIdentityStatus(owner) !== "alive") return;
    const current = readHotStateAuthority(directory);
    if (!current || !sameFence(current, current)) { fence = null; continue; }
    if (!fence || !sameFence(fence, current)) { fence = current; observedAt = Date.now(); continue; }
    if (Date.now() - observedAt < 8_000) continue;
    try {
      await preserveManagedNativeProcesses(owner);
      const [{ SqliteAgentRegistryStore }, { normalizeRegistry }] = await Promise.all([
        import("@/lib/agent/sqliteRegistryStore"), import("@/lib/agent/registry"),
      ]);
      const registry = new SqliteAgentRegistryStore(path.join(directory, "agent-registry.sqlite"), {
        readOnly: true, normalize: normalizeRegistry, initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
      });
      let evidence;
      try { evidence = registry.retirementEvidence(`structured-host:${JSON.stringify(owner)}`); }
      finally { registry.close(); }
      const boundaryDirectory = path.join(directory, "deployments");
      fs.mkdirSync(boundaryDirectory, { recursive: true });
      const filename = path.join(boundaryDirectory, `retirement-${current.epoch}.json`);
      const temporary = `${filename}.${process.pid}.tmp`;
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ version: 1, at: new Date().toISOString(), epoch: current.epoch,
          revision, activationOwner: owner, container: { id, cgroup: group }, ...evidence }));
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, filename);
      const directoryDescriptor = fs.openSync(boundaryDirectory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      const stopped = withFileTransactionSync(path.join(directory, "hot-state-authority.json"), "retirement guard fence is busy", () => {
        if (!sameFence(current, readHotStateAuthority(directory)) || processIdentityStatus(owner) !== "alive"
          || cgroup(owner.pid) !== group || parentPid(process.ppid) !== owner.pid) return false;
        process.kill(owner.pid, "SIGKILL");
        return true;
      });
      if (stopped) return;
      fence = null;
    } finally { resumeRetirementOwner(owner); }
  }
}

/** A managed Viewer arms this before activation can spend time on history. */
export async function startManagedRetirementGuard(directory: string, revision: string | null): Promise<void> {
  if (!revision || (!containerId(process.pid) && !fs.existsSync("/.dockerenv"))) return;
  const shared = globalThis as typeof globalThis & { __delegatusManagedRetirementGuard?: Promise<void> };
  shared.__delegatusManagedRetirementGuard ??= launchManagedRetirementGuard(directory, revision);
  return shared.__delegatusManagedRetirementGuard;
}

async function launchManagedRetirementGuard(directory: string, revision: string): Promise<void> {
  const [{ stateBackupWorkerLaunch }, { spawnLeasedHelper, leasedHelperInput, endLeasedHelper, unrefLeasedHelper }] = await Promise.all([
    import("./durability"), import("@/lib/helperLease"),
  ]);
  const launch = stateBackupWorkerLaunch();
  const child = spawnLeasedHelper("managed-retirement-guard", { command: launch.executable, args: [launch.workerPath],
    cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: directory } }, directory,
  { input: true, stdout: "pipe", stderr: "inherit", followRelease: false });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => { endLeasedHelper(child); }, 5_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", () => {
      clearTimeout(timeout);
      if (!ready) reject(new Error("managed retirement guard failed before readiness"));
      else console.error("[managed retirement guard] stopped; adapter containment remains required");
    });
    child.stdout!.once("data", chunk => {
      if (String(chunk) !== "ready\n") { endLeasedHelper(child); return; }
      ready = true; clearTimeout(timeout); unrefLeasedHelper(child); resolve();
    });
    leasedHelperInput(child).end(JSON.stringify({ operation: "retirement-guard", stateDirectory: directory,
      revision, owner: captureProcessIdentity(process.pid) }));
  });
}
