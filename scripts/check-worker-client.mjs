import net from "node:net";
import fs from "node:fs";
const key = Symbol.for("delegatus.checkAdmission.worker");

/** The owning runner keeps this exact process counted until its socket closes. */
export function admitWorker(kind) {
  return globalThis[key] ??= new Promise((resolve, reject) => {
    const broker = JSON.parse(process.env.DELEGATUS_CHECK_BROKER ?? "null");
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
