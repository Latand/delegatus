import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attemptTempRemaining, checkAttemptTempDeadline } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

const exec = promisify(execFile);

/** Await an owned copy process, including its exit on expiry, before the
 * caller removes its partial file. The source is never changed here. */
export async function copyAttemptEvidenceWithinBudget(source: string, destination: string) {
  checkAttemptTempDeadline();
  const timeout = Math.floor(attemptTempRemaining(30_000));
  if (timeout <= 0) throw new AttemptTempBudgetDeferred("tick deadline exhausted before evidence copy");
  try {
    await exec(process.execPath, ["-e",
      "const fs = require('node:fs'); try { fs.copyFileSync(process.argv[1], process.argv[2], fs.constants.COPYFILE_EXCL) } catch (error) { console.error('DELEGATUS_COPY_CODE:' + (error.code || 'unknown')); process.exitCode = 1 }",
      source, destination], { timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    checkAttemptTempDeadline();
  } catch (error) {
    const stopped = error as { killed?: boolean; signal?: string; stderr?: unknown };
    if (error instanceof AttemptTempBudgetDeferred || attemptTempRemaining() <= 0 && stopped.killed) {
      throw Object.assign(new AttemptTempBudgetDeferred("tick deadline exhausted during evidence copy"), { cause: error });
    }
    const code = /DELEGATUS_COPY_CODE:([A-Z0-9_]+)/.exec(String(stopped.stderr ?? ""))?.[1];
    if (code) Object.assign(error as object, { code });
    throw error;
  }
}
