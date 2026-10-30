import fs from "node:fs";
import path from "node:path";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { stateDir } from "@/lib/configDir";
import type { AccountArchiveRemovalReport, ManagedAccountEngine } from "./removal";

type ActiveRemoval = { id: string; promise: Promise<AccountArchiveRemovalReport> };
const shared = globalThis as typeof globalThis & { __llvAccountRemovalWorkers?: Map<string, ActiveRemoval> };
const active = shared.__llvAccountRemovalWorkers ??= new Map();

/** The existing synchronous, journaled transaction runs in a leased process.
 * Registry retirement can traverse retained history and must not stop HTTP. */
export function runAccountRemoval(engine: ManagedAccountEngine, id: string): Promise<AccountArchiveRemovalReport> {
  const prior = active.get(engine);
  if (prior?.id === id) return prior.promise;
  if (prior) return Promise.reject(Object.assign(new Error("account removal is already running"), { name: "AccountMutationBusyError" }));
  const promise = new Promise<AccountArchiveRemovalReport>((resolve, reject) => {
    const cwd = process.cwd();
    const source = path.join(cwd, "src/lib/accountRemoval.worker.ts");
    const bundled = path.join(cwd, ".next/server/account-removal-worker.js");
    const container = fs.existsSync("/usr/local/bin/bun-container");
    const command = container ? "/usr/local/bin/bun-container" : process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawnLeasedHelper("account-removal", {
      command, args: [fs.existsSync(bundled) ? bundled : source], cwd,
      env: { ...process.env, LLV_STATE_DIR: stateDir(), DELEGATUS_STATE_DIR: stateDir(), LLV_STATE_OWNER: "tool", DELEGATUS_STATE_OWNER: "tool" },
    }, stateDir(), { input: true, stdout: "pipe", followRelease: false });
    let output = "";
    let settled = false;
    const finish = (error?: Error, result?: AccountArchiveRemovalReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => {
      endLeasedHelper(child);
      finish(new Error("account removal completion could not be confirmed; refresh its state"));
    }, 60_000);
    child.once("error", () => finish(new Error("account removal worker could not start")));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1_048_576) { endLeasedHelper(child); finish(new Error("account removal worker response is too large")); }
    });
    child.once("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error("account removal completion could not be confirmed; refresh its state");
        const frame = JSON.parse(output);
        if (frame.error && typeof frame.error.message === "string") {
          finish(Object.assign(new Error(frame.error.message), frame.error));
        } else if (frame.ok === true && frame.result && typeof frame.result.cleanupPending === "boolean") {
          finish(undefined, frame.result);
        } else throw new Error("account removal worker returned an invalid result");
      } catch (error) { finish(error instanceof Error ? error : new Error("account removal worker failed")); }
    });
    const input = leasedHelperInput(child);
    input.on("error", () => { endLeasedHelper(child); finish(new Error("account removal worker request failed")); });
    input.end(JSON.stringify({ engine, id }) + "\n");
  }).finally(() => { if (active.get(engine)?.promise === promise) active.delete(engine); });
  active.set(engine, { id, promise });
  return promise;
}
