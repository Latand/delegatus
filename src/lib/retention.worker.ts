import { createInterface } from "node:readline";
import { retentionBytes, retentionProcessScan } from "./selfUpdate/retentionInspection";

for await (const line of createInterface({ input: process.stdin })) {
  try {
    if (line.length > 16_384) throw new Error("retention request exceeded its bound");
    const request = JSON.parse(line);
    if (typeof request.directory !== "string" || !request.directory.startsWith("/")) throw new Error("invalid retention directory");
    if (request.kind !== "scan" && request.kind !== "bytes") throw new Error("invalid retention request");
    const result = request.kind === "scan" ? retentionProcessScan(request.directory) : retentionBytes(request.directory);
    process.stdout.write(JSON.stringify({ kind: request.kind, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
}
