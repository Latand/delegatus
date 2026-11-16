import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContainmentFailed, UnconfirmedStepExit, createRuntimeCheckTree, isolatedEnvironment, runSteps } from "./local-gate";
import { recordGateSandbox, releaseGateSandbox } from "./gateSandboxRecords";

/** One source export per check, released after the owned command and all its
 * descendants settle. Repeated builds must not accumulate full source trees
 * in a stage's retained scratch. The source checkout is read-only here. */
export async function checkSource(source: string, command: string[]) {
  if (!command.length) throw new Error("check-source needs a command after --");
  const sandbox = recordGateSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-source-check-")));
  const identity = fs.lstatSync(sandbox);
  let settled = true;
  try {
    const tree = createRuntimeCheckTree(source, sandbox);
    const environment = isolatedEnvironment(path.join(sandbox, "environment"), process.env);
    await runSteps("pre-commit", [{ name: "source check", command }], {
      root: tree, deadline: null, logDir: sandbox,
      prepare: () => ({ command: [process.execPath, path.join(import.meta.dir, "owned-runner.ts"), ...command], env: environment, root: tree }),
    });
  } catch (error) {
    if (error instanceof ContainmentFailed || error instanceof UnconfirmedStepExit) settled = false;
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
  const [separator, ...command] = process.argv.slice(2);
  if (separator !== "--") throw new Error("usage: bun scripts/check-source.ts -- <command> [args...]");
  try { await checkSource(process.cwd(), command); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
