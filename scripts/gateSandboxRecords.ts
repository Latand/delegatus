import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The creating process records the exact allocation before using it. The
 * outer owned runner consumes this journal only after its children stop. */
export function recordGateSandbox(directory: string): string {
  const record = process.env.LLV_GATE_SANDBOX_RECORD;
  if (record) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid gate sandbox allocation");
    fs.appendFileSync(record, JSON.stringify({ directory: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino }) + "\n");
  }
  return directory;
}

export function ownGateSandboxes() {
  if (process.env.LLV_GATE_SANDBOX_RECORD) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-gate-record-"));
  const record = path.join(root, "sandboxes.ndjson");
  fs.writeFileSync(record, "", { mode: 0o600, flag: "wx" });
  process.env.LLV_GATE_SANDBOX_RECORD = record;
  process.once("exit", () => {
    try {
      for (const line of fs.readFileSync(record, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        const stat = fs.lstatSync(row.directory, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== row.dev || stat.ino !== row.ino
          || fs.realpathSync(row.directory) !== row.directory) throw new Error("recorded gate sandbox changed identity");
        fs.rmSync(row.directory, { recursive: true, force: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error("owned runner: sandbox cleanup failed", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}
