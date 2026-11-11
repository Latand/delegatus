import { spawn } from "node:child_process";

export const SERVICE_NAME = "delegatus.service";
export const AGENT_NAME = "org.delegatus.server";

/** A bounded subprocess with no shell. Abort waits for the owned child to close.
 * @param {string} command @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function serviceCommand(command, args, { env = process.env, signal, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    // Bun's execFile abort can leave a SIGTERM-resistant child alive. Kill
    // this handle explicitly and retain custody until its close event.
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", bytes = 0, failure;
    const stop = error => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(Object.assign(new Error("Service manager deadline exceeded"), { killed: true })), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (chunk, output) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) { stop(new Error("Service manager output exceeds the diagnostic bound")); return; }
      if (output) stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.stdout.on("error", stop); child.stderr.on("error", stop);
    child.once("error", error => { failure ??= error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
