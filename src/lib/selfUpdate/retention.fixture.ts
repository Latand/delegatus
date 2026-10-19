import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { retentionBytes, retentionProcessScan } from "./retentionInspection";

const [root, failure] = process.argv.slice(2);
fs.writeFileSync(path.join(root!, "helper-pid"), String(process.pid));
let requests = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (++requests === 1) { process.stdout.write(JSON.stringify({ kind: request.kind, result: 0 }) + "\n"); continue; }
  if (failure === "inspect") {
    fs.appendFileSync(path.join(root!, "requests"), request.kind + "\n");
    const result = request.kind === "scan" ? retentionProcessScan(request.directory, path.join(root!, "proc")) : retentionBytes(request.directory);
    process.stdout.write(JSON.stringify({ kind: request.kind, result }) + "\n");
    continue;
  }
  if (failure === "exit") process.exit(1);
  if (failure === "hang") { for (;;) { Math.sqrt(2); } }
  if (failure === "malformed") process.stdout.write("invalid\n");
  if (failure === "truncated") { process.stdout.write('{"kind":'); process.exit(0); }
  if (failure === "oversize") process.stdout.write("x".repeat(1024 * 1024 + 1));
  if (failure === "partial") process.stdout.write(JSON.stringify({ kind: "scan", result: { ownNamespace: "mnt:[fixture]", complete: false, processes: [] } }) + "\n");
  if (failure === "wrong-kind") process.stdout.write('{"kind":"other","result":0}\n');
}
