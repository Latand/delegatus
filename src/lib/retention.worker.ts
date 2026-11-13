import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { retentionBytes, retentionProcessScan, retentionScanWithObserver } from "./selfUpdate/retentionInspection";

// This mode only reads procfs. It never accepts byte walks or retention work.
if (process.argv[2] === "--observe-retention") {
  process.stdout.write(JSON.stringify(retentionProcessScan(process.argv[3]!)));
  process.exit(0);
}
if (process.argv[2] === "--retention-pass") {
  const { serveRetentionPass } = await import("./selfUpdate/retentionPass");
  await serveRetentionPass();
  process.exit(0);
}

for await (const line of createInterface({ input: process.stdin })) {
  try {
    if (line.length > 16_384) throw new Error("retention request exceeded its bound");
    const request = JSON.parse(line);
    if (typeof request.directory !== "string" || !request.directory.startsWith("/")) throw new Error("invalid retention directory");
    if (request.kind !== "scan" && request.kind !== "bytes") throw new Error("invalid retention request");
    const result = request.kind === "scan" ? retentionScanWithObserver(request.directory, () => {
      // Some installations restrict procfs even for nondumpable processes of
      // the same UID. Never prompt, change policy, or run deletion as root.
      const observed = spawnSync("sudo", ["-n", "--", process.execPath, process.argv[1]!, "--observe-retention", request.directory], {
        encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (observed.error || observed.status !== 0) throw new Error("proc observer unavailable");
      return JSON.parse(observed.stdout);
    }) : retentionBytes(request.directory);
    process.stdout.write(JSON.stringify({ kind: request.kind, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"); }
}
