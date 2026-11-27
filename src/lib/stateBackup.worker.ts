import { answerBackupWorkerRequest, type BackupWorkerRequest } from "./state/durability";

/* One state database backup or activation pass off the Viewer's thread:
   reads a request on stdin and writes a final JSON verdict on stdout.
   Activation can stream completed database checks before the verdict. */

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; });
process.stdin.on("end", async () => {
  const request = JSON.parse(input) as BackupWorkerRequest;
  if (request.operation === "retirement-guard") {
    const { runManagedRetirementGuard } = await import("./state/managedRetirementGuard");
    await runManagedRetirementGuard(request.stateDirectory, request.revision!, request.owner!);
    return;
  }
  if (request.operation === "worktree-recovery") {
    const { withStateMutationActivation } = await import("./state/stateMutationBarrier");
    const { runWorktreeRecoveryAtStartup } = await import("./projects/worktreeBackfill");
    const recovery = await withStateMutationActivation(() => runWorktreeRecoveryAtStartup());
    process.stdout.write(`${JSON.stringify({ outcomes: [], worktreeRecoveryFinished: true, worktreeRecovery: recovery })}\n`);
    return;
  }
  const response = request.operation === "checkpoint" ? await (async () => {
    const { checkpointHotStateRollbackMirrorsForDemotion } = await import("./state/checkpointRollbackMirrors");
    const { withStateMutationActivation } = await import("./state/stateMutationBarrier");
    try {
      return { outcomes: [], checkpoint: await withStateMutationActivation(checkpointHotStateRollbackMirrorsForDemotion) };
    } catch (error) {
      // The caller's record has to name the refusal; stderr only holds the trace.
      console.error(error);
      return { outcomes: [], checkpointFailure: error instanceof Error ? error.message : String(error) };
    }
  })() : answerBackupWorkerRequest(request, (done, total) => {
    process.stdout.write(`${JSON.stringify({ activationProgress: [done, total] })}\n`);
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
