import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const key = Symbol.for("delegatus.checkAdmission.worker");

/** The broker remains outside private compiler namespaces and verifies its
 * own kernel-held lease for this exact descendant. No new admission is taken. */
export function reuseGateSlot(env = process.env) {
  if (!env.LLV_GATE_SLOT_BROKER || !env.LLV_GATE_SLOT_LEASE) return Promise.resolve(false);
  // A child can select another gate pool before entering a service. Its old
  // issuer is no authority for that pool and may be outside the new tree.
  // Leave that pool's ordinary admission path to acquire its own real slot.
  try {
    const lease = JSON.parse(env.LLV_GATE_SLOT_LEASE);
    const slot = typeof lease?.slot === "string" && /^llv-heavy-gate\.slot([1-9]\d*)\.lock$/.exec(path.basename(lease.slot));
    if (!slot || !path.isAbsolute(lease.slot) || Number(slot[1]) > Number(env.LLV_GATE_SLOTS ?? 6)
      || fs.realpathSync(path.dirname(lease.slot)) !== fs.realpathSync(env.LLV_GATE_LOCK_DIR ?? "/var/tmp")) return Promise.resolve(false);
  } catch { return Promise.resolve(false); }
  const broker = JSON.parse(env.LLV_GATE_SLOT_BROKER);
  return new Promise((resolve, reject) => {
    const socket = net.connect(broker.port, "127.0.0.1");
    let settled = false, response = "";
    const timer = setTimeout(() => socket.destroy(new Error("slot lease broker did not answer")), 5000);
    socket.once("error", reject);
    socket.once("close", () => { clearTimeout(timer); if (!settled) reject(new Error("slot lease broker closed without a verdict")); });
    socket.once("connect", () => {
      const boundary = env.LLV_SIGNAL_SANDBOX ? JSON.parse(env.LLV_SIGNAL_SANDBOX) : null;
      const hostPid = boundary ? Number(fs.readlinkSync(`${boundary.hostProc}/self`)) : undefined;
      socket.write(JSON.stringify({ nonce: broker.nonce, pid: process.pid, hostPid, kind: "slot", lease: env.LLV_GATE_SLOT_LEASE,
        directory: path.resolve(env.LLV_GATE_LOCK_DIR ?? "/var/tmp"), slots: env.LLV_GATE_SLOTS ?? "6" }) + "\n");
    });
    socket.on("data", data => {
      response += String(data);
      if (response.length > 64000) { socket.destroy(new Error("invalid slot lease verdict")); return; }
      if (!response.includes("\n")) return;
      try {
        const message = JSON.parse(response);
        if (typeof message.reused !== "boolean") throw new Error(message.error ?? "invalid slot lease verdict");
        settled = true; clearTimeout(timer); socket.end(); resolve(message.reused);
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}

/** The owning runner keeps this exact process counted until its socket closes. */
export function admitWorker(kind) {
  return globalThis[key] ??= new Promise((resolve, reject) => {
    const broker = JSON.parse(process.env.LLV_CHECK_BROKER ?? process.env.DELEGATUS_CHECK_BROKER ?? "null");
    if (!broker) { reject(new Error("test/compiler admission requires an owned runner")); return; }
    const socket = net.connect(broker.port, "127.0.0.1");
    let admitted = false;
    socket.once("error", reject);
    socket.once("close", () => {
      if (!admitted) reject(new Error("check admission broker closed before admission"));
      else process.exit(70);
    });
    socket.once("connect", () => {
      const env = {};
      for (const key of ["LLV_CHECK_ADMISSION_FILE", "DELEGATUS_GATE_CPU_HEADROOM", "LLV_GATE_CPU_HEADROOM", "LLV_CPU_WAIT_ROOTS", "LLV_RECORDED_CHECK_WAIT_ROOT"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      // A service broker lives outside the worker's PID namespace. Its
      // verified read-only host proc mount names the same worker there.
      const boundary = process.env.LLV_SIGNAL_SANDBOX ? JSON.parse(process.env.LLV_SIGNAL_SANDBOX) : null;
      const hostPid = boundary ? Number(fs.readlinkSync(`${boundary.hostProc}/self`)) : undefined;
      socket.write(JSON.stringify({ nonce: broker.nonce, pid: process.pid, hostPid, kind, env }) + "\n");
    });
    let response = "";
    socket.on("data", function receive(data) {
      response += String(data);
      if (!response.includes("\n")) return;
      socket.off("data", receive);
      try {
        const message = JSON.parse(response);
        if (message.admitted !== true) throw new Error(message.error ?? "worker admission refused");
        admitted = true; socket.unref(); resolve();
      } catch (error) { reject(error); socket.destroy(); }
    });
  });
}
