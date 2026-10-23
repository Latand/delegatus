/* One install-transfer step off the Viewer's thread
   (docs/design/install-memory-transfer.md §4.1): reads one JSON request on
   stdin, answers one JSON line on stdout. The bundle travels as a file the
   caller names, never through the pipe. */

import { runTransferWorkerRequest, type TransferWorkerRequest } from "./workerProtocol";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; });
process.stdin.on("end", async () => {
  const response = await runTransferWorkerRequest(JSON.parse(input) as TransferWorkerRequest);
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
