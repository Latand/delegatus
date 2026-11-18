import { dirname, resolve as absolutePath } from "node:path";
import { spawn } from "node:child_process";
import { recordHelperGroup } from "@/lib/helperLease";

/** Embedded so checkout and bundled servers execute exactly the same worker,
 * without loading code or configuration from the release being inspected. */
export const OUTPUT_INVENTORY_SOURCE = String.raw`
const fs = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const [directory, output] = process.argv.slice(1);
function walk() {
  const hash = createHash("sha256"), changes = createHash("sha256");
  const pending = [output.replace(/\/$/, "")];
  let visited = 0;
  while (pending.length) {
    if (++visited > 250_000) throw new Error("Release output inventory exceeds its limit");
    const entry = pending.pop();
    const file = join(directory, entry);
    const stat = fs.lstatSync(file, { bigint: true });
    hash.update(JSON.stringify([entry, String(stat.dev), String(stat.ino), String(stat.mode)]));
    // Directory times detect edits during the walk, but stay out of the
    // compatible receipt digest: the ready marker changes those times.
    changes.update(JSON.stringify([entry, String(stat.mtimeNs), String(stat.ctimeNs)]));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort().reverse()) pending.push(entry + "/" + name);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      hash.update(JSON.stringify([String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
        stat.isSymbolicLink() ? fs.readlinkSync(file) : null]));
    } else throw new Error("Release output has an unsupported file type");
  }
  return [hash.digest("hex"), changes.digest("hex")];
}
const first = walk(), second = walk();
if (first[0] !== second[0] || first[1] !== second[1]) throw new Error("Release output changed during inventory");
process.stdout.write(first[0] + "\n");
`;

export const OUTPUT_INVENTORY_TIMEOUT_MS = 120_000;

/** Metadata work belongs to a bounded child of the pinned Bun running this
 * server. No dependency bytes or symlink destinations are traversed. Reject
 * only after close, including cancellation, so a retry owns no old worker. */
export function outputFingerprint(dir: string, output: string, signal?: AbortSignal, start = spawn, timeoutMs = OUTPUT_INVENTORY_TIMEOUT_MS): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = start(process.execPath, ["--no-env-file", "--no-install", "--eval", OUTPUT_INVENTORY_SOURCE, absolutePath(dir), output], {
      cwd: dirname(process.execPath), env: {}, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let stdout = "";
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(new Error("Release output inventory cancelled"));
    const timer = setTimeout(() => stop(new Error("Release output inventory timed out")), timeoutMs);
    child.on("error", error => { failure ??= error; });
    child.stdout!.on("data", (bytes: Buffer) => {
      if (stdout.length + bytes.length > 65) stop(new Error("Invalid release output inventory response"));
      else stdout += bytes.toString("utf8");
    });
    // Drain diagnostics without retaining paths or an unbounded error body.
    child.stderr!.resume();
    child.stdout!.on("error", stop);
    child.stderr!.on("error", stop);
    child.once("close", (code, killed) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) failure ??= new Error("Release output inventory cancelled");
      if (failure) reject(failure);
      else if (code !== 0 || killed || !/^[a-f0-9]{64}\n$/.test(stdout)) reject(new Error("Release output inventory failed"));
      else resolve(stdout.trim());
    });
    recordHelperGroup("self-update-output-inventory", child);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
