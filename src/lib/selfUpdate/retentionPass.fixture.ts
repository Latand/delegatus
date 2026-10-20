import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2]!;
fs.writeFileSync(path.join(directory, "helper-pid"), String(process.pid));
if (["malformed", "invalid-report"].includes(process.argv[3]!)) {
  process.stdin.once("data", () => process.stdout.write(process.argv[3] === "malformed" ? "invalid\n"
    : JSON.stringify({ kind: "report", report: { kept: [], errors: [] } }) + "\n"));
  await new Promise(() => {});
}
const entry = path.join(import.meta.dir, "../retention.worker.ts");
process.argv.splice(1, 2, entry);
await import("../retention.worker");
