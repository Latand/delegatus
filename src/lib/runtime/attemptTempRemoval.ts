import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { attemptTempRemaining, checkAttemptTempDeadline } from "./attemptTempDeadline";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";

const execFileAsync = promisify(execFile);
type RemovalRunner = typeof execFileAsync;

/** Run recursive deletion in an owned process so an expired tick can stop it.
 * The caller keeps its durable trash journal when this process is interrupted. */
export async function removeTreeWithinAttemptBudget(directory: string, mutationStarted: () => void, run: RemovalRunner = execFileAsync,
  expectedIdentity?: string, accountCpuSeconds?: (seconds: number) => void) {
  checkAttemptTempDeadline();
  const timeout = Math.floor(attemptTempRemaining(30_000));
  if (timeout <= 0) throw new AttemptTempBudgetDeferred("tick deadline exhausted before recursive removal");
  const initial = fs.lstatSync(directory);
  const identity = `${initial.dev}:${initial.ino}`;
  if (!initial.isDirectory() || initial.isSymbolicLink() || expectedIdentity && identity !== expectedIdentity)
    throw new Error("attempt removal identity changed before atomic claim");
  const parent = path.dirname(directory);
  const tombstone = path.join(parent, `.delegatus-trash-claim-${identity.replace(":", "-")}-${randomUUID()}`);
  fs.renameSync(directory, tombstone);
  const restoreChangedClaim = () => {
    try {
      fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fs.renameSync(tombstone, directory);
    }
  };
  const claimed = fs.lstatSync(tombstone, { throwIfNoEntry: false });
  if (!claimed?.isDirectory() || claimed.isSymbolicLink() || `${claimed.dev}:${claimed.ino}` !== identity
    || expectedIdentity && identity !== expectedIdentity) {
    restoreChangedClaim();
    throw new Error("attempt removal inode changed during atomic claim; payload retained");
  }
  // The journal reader can recover this same-parent claim by its admitted
  // device/inode if the process exits between rename and journal cleanup.
  mutationStarted();
  // The callback can read accounting state and yield to an injected race.
  // Recheck the claimed name after it returns so a replacement at that exact
  // handoff is returned to its original quarantine path, never passed to rm.
  const finalClaim = fs.lstatSync(tombstone, { throwIfNoEntry: false });
  if (!finalClaim?.isDirectory() || finalClaim.isSymbolicLink() || `${finalClaim.dev}:${finalClaim.ino}` !== identity) {
    restoreChangedClaim();
    throw new Error("attempt removal inode changed at final handoff; payload retained");
  }
  try {
    const result = await run(process.execPath, ["-e", "const fs=require('node:fs'), start=process.cpuUsage(); try { fs.rmSync(process.argv[1], { recursive: true, force: true }); } catch (error) { console.error('DELEGATUS_RM_CODE:' + (error.code || 'unknown')); process.exitCode=1 } finally { const c=process.cpuUsage(start); console.log('DELEGATUS_RM_CPU:' + ((c.user+c.system)/1e6)); }", tombstone], {
      timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    const cpu = /DELEGATUS_RM_CPU:([0-9.]+)/.exec(result.stdout)?.[1];
    if (cpu) accountCpuSeconds?.(Number(cpu));
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
