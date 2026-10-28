import "@/lib/state/owner/tool";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateCodex } from "@/lib/codexUpdate/update";
import { productionUpdatePorts } from "@/lib/codexUpdate/production";
import { reportCodexUpdate } from "@/lib/codexUpdate/controller";
import { updateDirectory } from "@/lib/codexUpdate/installation";
import { requestInstalledCodexUpdate } from "@/lib/codexUpdate/request";

if (process.argv[2] === "check" && process.argv[3] && process.argv.length === 4) {
  try {
    await requestInstalledCodexUpdate(process.argv[3]);
    console.log("Codex update check accepted; installation waits for compatibility and idle admission");
  } catch {
    console.error("Codex update check refused; verify the serving controller and its local control credential");
    process.exitCode = 1;
  }
} else {
  if (process.argv[2] !== "rollback" || !path.isAbsolute(process.argv[3] ?? "") || process.argv.length !== 4) throw new Error("Usage: codex-update.ts check <loopback check URL> | rollback <absolute CLI link>");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollback-"));
  try {
    await updateCodex(process.argv[3]!, productionUpdatePorts({
      bun: process.execPath, probeFile: path.join(import.meta.dir, "codex-probe.test.ts"), scratch,
      current: () => true, report: async notice => { await reportCodexUpdate(notice); if (notice.failed) process.exitCode = 1; },
      versionsDirectory: path.join(updateDirectory(process.argv[3]!), "versions"),
    }), true);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
