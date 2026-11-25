import { dirname, relative, resolve as absolutePath, sep } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { rmSync, watch, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
if (first[0] !== second[0] || first[1] !== second[1])
  throw new Error("Release output changed during inventory");
process.stdout.write(first[0] + "\n");
`;

export const OUTPUT_INVENTORY_TIMEOUT_MS = 120_000;

/** Watch the complete output set while its digest is being proved and consumed.
 * Recursive native watches keep mutation observation off the server's walk
 * path; any event or watcher failure revokes the proof. */
export async function withOutputMutationGuard<T>(dir: string, outputs: string[], signal: AbortSignal | undefined,
  consume: (assertStable: () => Promise<void>) => Promise<T>, verifyAfterConsume = true): Promise<T> {
  signal?.throwIfAborted();
  let changed = false;
  let watcherFailure: Error | undefined;
  const roots = outputs.map(output => relative(dir, absolutePath(dir, output)));
  // A sibling of the outputs supplies an event on the SAME recursive watch.
  // Seeing its create and remove acknowledges consumption of the native event
  // stream after the preceding work. A timer alone cannot supply that proof.
  const marker = `.delegatus-inventory-${randomUUID()}`;
  const markerPath = absolutePath(dir, marker);
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    const entry = filename?.toString();
    if (entry === marker) { pending?.resolve(); return; }
    if (!entry || roots.some(root => entry === root || entry.startsWith(root + sep) || root.startsWith(entry + sep))) changed = true;
  });
  const failed = (error: Error) => { watcherFailure ??= error; pending?.reject(error); };
  watcher.on("error", failed);
  watcher.on("close", () => failed(new Error("Release output mutation watch closed")));
  const acknowledge = async (effect: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => pending?.reject(new Error("Release output mutation guard cancelled"));
    try {
      await new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(() => reject(new Error("Release output mutation acknowledgement timed out")), OUTPUT_INVENTORY_TIMEOUT_MS);
        signal?.addEventListener("abort", abort, { once: true });
        signal?.throwIfAborted();
        if (watcherFailure) throw watcherFailure;
        effect();
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      pending = undefined;
    }
  };
  let markerOwned = false;
  try {
    const check = () => {
      signal?.throwIfAborted();
      if (watcherFailure) throw new Error("Release output mutation guard failed", { cause: watcherFailure });
      if (changed) throw new Error("Release output changed while its proof was being consumed");
    };
    const assertStable = async () => {
      check();
      await acknowledge(() => { writeFileSync(markerPath, "", { flag: "wx", mode: 0o600 }); markerOwned = true; });
      await acknowledge(() => { rmSync(markerPath); markerOwned = false; });
      check();
    };
    const value = await consume(assertStable);
    if (verifyAfterConsume) await assertStable();
    return value;
  } finally {
    watcher.close();
    if (markerOwned) rmSync(markerPath, { force: true });
  }
}

/** Metadata work belongs to a bounded child of the pinned Bun running this
 * server. No dependency bytes or symlink destinations are traversed. Reject
 * only after close, including cancellation, so a retry owns no old worker. */
function runOutputFingerprint(dir: string, output: string, signal: AbortSignal | undefined,
  start: (command: string, args: string[], options: SpawnOptions) => ChildProcess, timeoutMs: number): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = start(process.execPath, ["--no-env-file", "--no-install", "--eval", OUTPUT_INVENTORY_SOURCE, absolutePath(dir), output], {
      // Next's ProcessEnv augmentation requires NODE_ENV for its own process;
      // this isolated Bun worker intentionally inherits no environment entries.
      cwd: dirname(process.execPath), env: {} as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
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

/** Require matching inventories from separate workers while a native watcher
 * observes mutations through the final worker's close and digest consumption. */
export async function outputFingerprint(dir: string, output: string, signal?: AbortSignal,
  start: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
  timeoutMs = OUTPUT_INVENTORY_TIMEOUT_MS): Promise<string> {
  return withOutputMutationGuard(dir, [output], signal, async () => {
    const first = await runOutputFingerprint(dir, output, signal, start, timeoutMs);
    signal?.throwIfAborted();
    const second = await runOutputFingerprint(dir, output, signal, start, timeoutMs);
    if (first !== second) throw new Error("Release output changed after inventory");
    signal?.throwIfAborted();
    return second;
  });
}
