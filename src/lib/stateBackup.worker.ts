import { answerBackupWorkerRequest, type BackupWorkerRequest } from "./state/durability";

/* One state database backup pass off the Viewer's thread (#1870 slice 10):
   reads a request on stdin, answers one JSON line on stdout. */

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; });
process.stdin.on("end", () => {
  const response = answerBackupWorkerRequest(JSON.parse(input) as BackupWorkerRequest);
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
