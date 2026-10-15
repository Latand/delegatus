import { answerBackupWorkerRequest, type BackupWorkerRequest } from "./state/durability";

/* One state database backup or activation pass off the Viewer's thread:
   reads a request on stdin, answers one JSON line on stdout. */

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
  const response = request.operation === "checkpoint" ? await (async () => {
    const { checkpointHotStateRollbackMirrorsForDemotion } = await import("./state/checkpointRollbackMirrors");
    const { withStateMutationActivation } = await import("./state/stateMutationBarrier");
    return { outcomes: [], checkpoint: await withStateMutationActivation(checkpointHotStateRollbackMirrorsForDemotion) };
  })() : answerBackupWorkerRequest(request);
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
