import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attemptTempRemaining, checkAttemptTempDeadline } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

const execFileAsync = promisify(execFile);
type RemovalRunner = typeof execFileAsync;

/** Run recursive deletion in an owned process so an expired tick can stop it.
 * The caller keeps its durable trash journal when this process is interrupted. */
export async function removeTreeWithinAttemptBudget(directory: string, mutationStarted: () => void, run: RemovalRunner = execFileAsync) {
  checkAttemptTempDeadline();
  const timeout = Math.floor(attemptTempRemaining(30_000));
  if (timeout <= 0) throw new AttemptTempBudgetDeferred("tick deadline exhausted before recursive removal");
  mutationStarted();
  try {
    await run(process.execPath, ["-e", "try { require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }) } catch (error) { console.error('DELEGATUS_RM_CODE:' + (error.code || 'unknown')); process.exitCode = 1 }", directory], {
      timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    checkAttemptTempDeadline();
  } catch (error) {
    const stopped = error as { killed?: boolean; signal?: string };
    if (error instanceof AttemptTempBudgetDeferred || attemptTempRemaining() <= 0 && (stopped.killed || stopped.signal === "SIGKILL")) {
      throw new AttemptTempBudgetDeferred("tick deadline exhausted during recursive removal");
    }
    const code = /DELEGATUS_RM_CODE:([A-Z0-9_]+)/.exec(String((error as { stderr?: unknown }).stderr ?? ""))?.[1];
    if (code) Object.assign(error as object, { code });
    throw error;
  }
}
