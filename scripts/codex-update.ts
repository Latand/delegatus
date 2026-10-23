import "@/lib/state/owner/tool";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateCodex } from "@/lib/codexUpdate/update";
import { productionUpdatePorts } from "@/lib/codexUpdate/production";
import { reportCodexUpdate } from "@/lib/codexUpdate/controller";
import { updateDirectory } from "@/lib/codexUpdate/installation";

if (process.argv[2] !== "rollback" || !path.isAbsolute(process.argv[3] ?? "")) throw new Error("Usage: codex-update.ts rollback <absolute CLI link>");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollback-"));
try {
  await updateCodex(process.argv[3]!, productionUpdatePorts({
    bun: process.execPath, probeFile: path.join(import.meta.dir, "codex-probe.test.ts"), scratch,
    current: () => true, report: async notice => { await reportCodexUpdate(notice); if (notice.failed) process.exitCode = 1; },
    versionsDirectory: path.join(updateDirectory(process.argv[3]!), "versions"),
  }), true);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
