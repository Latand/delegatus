import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { CheckAdmission, checkCapacity, openCheckAdmission } from "./check-admission";
import { admissionLockWait } from "./cpu-admission-lock";
import { procBackend } from "../src/lib/proc";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { hostProcessIdentity, cpuOwnerStatus, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import type { ProcessIdentity } from "../src/lib/processIdentity";
import { inheritedCpuSlot, type CpuSlotLease } from "../src/lib/runtime/cpuAdmission";

/** The owning runner supervises admission without creating an extra child
 * in the test's cgroup. The inherited capability follows shell/package forks. */
const ps = promisify(execFile);

export async function startCheckBroker(caller?: ProcessIdentity) {
  const nonce = randomUUID();
  const pending = new Set<Promise<void>>();
  const workers = new Set<number>();
  const sockets = new Set<net.Socket>();
  const failures: Error[] = [];
  let providedSlot: { lease: string; env: NodeJS.ProcessEnv } | undefined;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.unref();
    socket.setEncoding("utf8");
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", function receive(data) {
      input += data;
      if (input.length > 64_000) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      socket.off("data", receive);
      const task = (async () => {
        const request = JSON.parse(input);
        if (request.nonce !== nonce || !Number.isSafeInteger(request.pid)) throw new Error("invalid worker admission capability");
        const target = signalSandboxContext() ? request.pid : request.hostPid ?? request.pid;
        if (request.kind === "slot") {
          const worker = verifyWorker(request.pid, request.hostPid);
          if (typeof request.directory !== "string" || !path.isAbsolute(request.directory)
            || typeof request.slots !== "string" || !/^[1-9]\d*$/.test(request.slots)) throw new Error("invalid slot reuse policy");
          const reused = !!providedSlot && request.lease === providedSlot.lease && !!inheritedCpuSlot({ ...providedSlot.env,
            LLV_GATE_LOCK_DIR: request.directory, LLV_GATE_SLOTS: request.slots });
          const current = verifyWorker(request.pid, request.hostPid);
          if (current.localOwner.startIdentity !== worker.localOwner.startIdentity || current.localOwner.bootEpoch !== worker.localOwner.bootEpoch) throw new Error("slot requester changed during verification");
          socket.end(JSON.stringify({ reused }) + "\n");
          return;
        }
        if (workers.has(target)) throw new Error("worker already has an admission controller");
        workers.add(target);
        try { await supervise(socket, request.pid, request.hostPid, request.kind, request.env, caller); }
        finally { workers.delete(target); }
      })().catch(error => {
        failures.push(error);
        socket.end(JSON.stringify({ error: error.message }) + "\n");
      });
      pending.add(task); void task.finally(() => { pending.delete(task); sockets.delete(socket); });
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.unref();
  const port = (server.address() as net.AddressInfo).port;
  const address = JSON.stringify({ port, nonce });
  let closing: Promise<void> | undefined;
  return { address, provideCpuSlot: (lease: CpuSlotLease, env: NodeJS.ProcessEnv) => {
    providedSlot = { lease: JSON.stringify(lease), env: { ...env, LLV_GATE_SLOT_LEASE: JSON.stringify(lease) } };
  }, close: () => closing ??= (async () => {
    server.close(); for (const socket of sockets) socket.destroy();
    await Promise.all(pending);
    if (failures.length) throw new AggregateError(failures, "check admission failed");
  })() };
}

function verifyWorker(workerPid: number, hostPid: number | undefined) {
  const context = signalSandboxContext();
  const pid = context ? workerPid : hostPid ?? workerPid;
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("invalid worker process identity");
  // The capability alone cannot enroll a peer process: validate ancestry from
  // the runner to the worker before recording any signal authority.
  const localOwner = captureProcessIdentity(pid);
  let parent = pid;
  const seen = new Set<number>();
  while (parent !== process.pid && parent > 1 && !seen.has(parent)) {
    seen.add(parent);
    parent = procBackend.readPpid(parent) ?? 0;
  }
  if (pid === process.pid || parent !== process.pid) throw new Error("admission worker is outside this runner's process tree");
  if (processIdentityStatus(localOwner) !== "alive" || procBackend.processExited(pid)) throw new Error("admission worker exited during ancestry verification");
  const owner = hostProcessIdentity(localOwner);
  if (hostPid !== undefined && owner.pid !== hostPid) throw new Error("worker namespace identity disagrees with the kernel");
  return { context, pid, localOwner, owner };
}

async function supervise(socket: net.Socket, workerPid: number, hostPid: number | undefined, kind: string, env: NodeJS.ProcessEnv, caller?: ProcessIdentity) {
  if (kind !== "test" && kind !== "compiler") throw new Error("invalid admitted worker kind");
  const { context, pid, localOwner, owner } = verifyWorker(workerPid, hostPid);
  const capacity = checkCapacity(env), retry = admissionLockWait();
  const root = context?.hostProc ?? "/proc";
  // The service's authenticated launch owner retains the causal ancestry
  // that reparenting to systemd removed from the worker's kernel PPid chain.
  const lineage: ProcessIdentity[] = [];
  if (caller && cpuOwnerStatus(caller) === "alive") {
    lineage.push(caller);
    let previous = caller.pid;
    const seen = new Set<number>();
    while (previous > 1 && !seen.has(previous)) {
      seen.add(previous);
      const next = procBackend.readPpid(previous);
      if (!next || next <= 1) break;
      const identity = captureProcessIdentity(next);
      if (processIdentityStatus(identity) !== "alive") break;
      lineage.push(identity); previous = next;
    }
  }
  const alive = () => !socket.destroyed && cpuOwnerStatus(owner) === "alive";
  const signal = (value: NodeJS.Signals) => {
    if (processIdentityStatus(localOwner) !== "alive") return;
    try { process.kill(pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  function ancestor(parent: number, child: number): boolean {
    const seen = new Set<number>();
    while (child > 1 && !seen.has(child)) {
      if (child === parent) return true;
      seen.add(child);
      try {
        if (process.platform !== "linux") child = procBackend.readPpid(child) ?? 0;
        else {
          const stat = fs.readFileSync(`${root}/${child}/stat`, "utf8");
          child = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        }
      } catch { return false; }
    }
    return false;
  }

  function nestedWaiter(queue: CheckAdmission): boolean {
    const rows = queue.db.query<{ owner: string; held: number; lineage: string }, []>("SELECT owner, held, lineage FROM checks").all();
    const links = new Map(rows.map(row => [JSON.stringify(JSON.parse(row.owner)), JSON.parse(row.lineage) as ProcessIdentity[]]));
    const causalAncestor = (parent: ProcessIdentity, child: ProcessIdentity, seen = new Set<string>()): boolean => {
      if (ancestor(parent.pid, child.pid)) return true;
      const key = JSON.stringify(child);
      if (seen.has(key)) return false;
      seen.add(key);
      return (links.get(key) ?? []).some(previous => cpuOwnerStatus(previous) === "alive"
        && (JSON.stringify(parent) === JSON.stringify(previous) || causalAncestor(parent, previous, seen)));
    };
    return rows.filter(row => row.held === 0).some(row => {
      const other = JSON.parse(row.owner) as ProcessIdentity;
      return other.pid !== owner.pid && cpuOwnerStatus(other) === "alive"
        && (causalAncestor(owner, other) || causalAncestor(other, owner));
    });
  }

  async function suspend(): Promise<void> {
    signal("SIGSTOP");
    // Delivery of SIGSTOP is asynchronous. Never release a permit until the
    // kernel confirms the whole worker is stopped (all its threads included).
    const deadline = performance.now() + 2_000;
    while (alive()) {
      let stopped = false;
      try {
        stopped = process.platform === "linux"
          ? fs.readdirSync(`/proc/${pid}/task`).every(tid => /^State:\s+T/m.test(fs.readFileSync(`/proc/${pid}/task/${tid}/status`, "utf8")))
          : /^T/.test((await ps("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 })).stdout.trim());
      } catch (error) {
        // A worker or one of its native threads can exit during the sample.
        if (!alive()) return;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stopped) return;
      if (performance.now() >= deadline) throw new Error("check worker did not stop before lending its permit");
      await Bun.sleep(1);
    }
  }

  const queue = await openCheckAdmission(env);
  let waiting = reportCpuWait(env), held = false, started = false;
  try {
    while (alive()) {
      if (!held) {
        held = await retry(() => alive() && queue.claim(owner, capacity, lineage));
        if (!alive()) break;
        if (!held) { await Bun.sleep(100); continue; }
        waiting(); waiting = () => {};
        if (!started) { socket.write(JSON.stringify({ admitted: true }) + "\n"); started = true; }
        else signal("SIGCONT");
      }
      await Bun.sleep(100);
      if (!alive()) break;
      // Only nested dependency cycles lend. Independent FIFO waiters cannot
      // preempt a running worker. Nested workers take bounded turns so a
      // parent's own progress can release barriers awaited by its children.
      if (process.platform !== "win32" && await retry(() => nestedWaiter(queue))) {
        // A worker can itself inspect this database. Own the writer lock
        // before stopping it, so it cannot be frozen holding the lock needed
        // to lend its permit. Contention remains asynchronous and bounded.
        await retry(() => queue.db.exec("BEGIN IMMEDIATE"));
        try {
          await suspend();
          queue.cancel(owner);
          queue.db.exec("COMMIT");
        } catch (error) {
          queue.db.exec("ROLLBACK");
          throw error;
        }
        held = false;
        // Once started, a nested tree is executing during lending; retain
        // its execution deadline while descendants make progress.
        // Rejoin the FIFO tail before another nesting poll.
      }
    }
  } catch (error) {
    signal("SIGKILL");
    throw error;
  } finally {
    waiting();
    // Host proof can become unavailable while our captured local identity
    // remains valid. Terminate through that authority and require positive
    // local exit evidence before retiring its machine ticket.
    try {
      signal("SIGKILL");
      const cleanupDeadline = performance.now() + 2_000;
      while (processIdentityStatus(localOwner) !== "dead" && !procBackend.processExited(pid)) {
        if (performance.now() >= cleanupDeadline) throw new Error("admission worker survived bounded cleanup; its permit remains held");
        await Bun.sleep(10);
      }
      await retry(() => queue.cancel(owner));
    } finally { queue.close(); }
  }

}
