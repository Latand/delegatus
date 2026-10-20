import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2]!;
fs.writeFileSync(path.join(directory, "helper-pid"), String(process.pid));
if (["malformed", "invalid-report"].includes(process.argv[3]!)) {
  process.stdin.once("data", () => process.stdout.write(process.argv[3] === "malformed" ? "invalid\n"
    : JSON.stringify({ kind: "report", report: { kept: [], errors: [] } }) + "\n"));
  await new Promise(() => {});
}
const proc = path.join(directory, "proc");
fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true });
if (!fs.lstatSync(path.join(proc, "self/ns/mnt"), { throwIfNoEntry: false })) fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
const { serveRetentionPass } = await import("./retentionPass");
const { retentionBytes, retentionProcessScan } = await import("./retentionInspection");
await serveRetentionPass({
  scan: async root => retentionProcessScan(root, proc),
  bytes: async root => retentionBytes(root),
  close: async () => {},
});
process.exit(0);
