import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ContainmentFailed, UnconfirmedStepExit, createRuntimeCheckTree, isolatedEnvironment, runSteps } from "./local-gate";
import { recordGateSandbox, releaseGateSandbox, retainGateSandbox } from "./gateSandboxRecords";

/** One source export per check, released after the owned command and all its
 * descendants settle. Repeated builds must not accumulate full source trees
 * in a stage's retained scratch. The source checkout is read-only here. */
export async function checkSource(source: string, command: string[]) {
  if (!command.length) throw new Error("check-source needs a command after --");
  const sandbox = recordGateSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-source-check-")));
  const identity = fs.lstatSync(sandbox);
  const completionReceipt = path.join(sandbox, "command-complete");
  const completionToken = crypto.randomUUID();
  let settled = true;
  try {
    const tree = createRuntimeCheckTree(source, sandbox);
    const environment = isolatedEnvironment(path.join(sandbox, "environment"), process.env);
    environment.LLV_OWNED_RUN_COMPLETION_RECEIPT = completionReceipt;
    environment.LLV_OWNED_RUN_COMPLETION_TOKEN = completionToken;
    await runSteps("pre-commit", [{ name: "source check", command }], {
      root: tree, deadline: null, logDir: sandbox,
      prepare: () => ({ command: [process.execPath, path.join(import.meta.dir, "owned-runner.ts"), ...command], env: environment, root: tree,
        completionReceipt: { path: completionReceipt, token: completionToken } }),
    });
  } catch (error) {
    if (error instanceof ContainmentFailed || error instanceof UnconfirmedStepExit) {
      settled = false;
      // The inherited journal reaches every external cleanup owner. A local
      // finally alone cannot protect an unconfirmed command after we exit.
      if (process.env.LLV_GATE_SANDBOX_RECORD) retainGateSandbox(sandbox);
    }
    throw error;
  } finally {
    if (settled) {
      const current = fs.lstatSync(sandbox, { throwIfNoEntry: false });
      if (current && (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino))
        throw new Error("source check sandbox changed identity");
      releaseGateSandbox(sandbox);
    }
  }
}

if (import.meta.main) {
  // Bun removes the first -- separator before exposing the script's argv.
  const args = process.argv.slice(2);
  const command = args[0] === "--" ? args.slice(1) : args;
  try { await checkSource(process.cwd(), command); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
