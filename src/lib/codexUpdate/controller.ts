import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexAccountBinary } from "@/lib/accounts/codexAppServer";
import { stateDir, statePath } from "@/lib/configDir";
import { readHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { appendLifecycleEventsAsync } from "@/lib/lifecycle/journal";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { hasPendingCodexUpdate, updateCodex, type UpdateNotice } from "./update";
import { productionUpdatePorts } from "./production";
import { updateDirectory } from "./installation";

import { createCodexUpdateTicker } from "./scheduler";

let ticker: ((requested?: boolean) => Promise<void>) | undefined;

function current(): boolean {
  const authority = readHotStateAuthority(stateDir());
  return authority?.mode === "sqlite" && authority.activationOwner?.pid === process.pid;
}

export async function reportCodexUpdate(notice: UpdateNotice): Promise<void> {
  await appendLifecycleEventsAsync(activeOrchestratorSeats().map(seat => ({
    key: `codex-cli:${notice.id}:${seat.project}`,
    at: new Date(notice.at).toISOString(), project: seat.project,
    type: notice.failed ? "codex_cli_update_failed" as const : "codex_cli_updated" as const, summary: notice.line,
  })));
  console.error(`[codex update] ${notice.line}`);
}

/** Called by the existing minute update scheduler, independently of app updates. */
export async function codexUpdateTick(requested = false): Promise<void> {
  ticker ??= createCodexUpdateTicker({
    clockFile: statePath("codex-update-clock.json"), now: Date.now, current, report: reportCodexUpdate,
    hasPending: () => {
      const binary = codexAccountBinary();
      return process.env.LLV_DOCKER_NSENTER_SHIMS !== "1" && process.platform !== "win32"
        && path.isAbsolute(binary) && hasPendingCodexUpdate(binary);
    },
    update: async request => {
      const binary = codexAccountBinary();
      if (process.env.LLV_DOCKER_NSENTER_SHIMS === "1" || process.platform === "win32" || !path.isAbsolute(binary)) {
        throw new Error("install location unsupported");
      }
      const probeFile = path.join(process.cwd(), "dist/gate/codex-probe.test.ts");
      if (!fs.existsSync(probeFile)) throw new Error("bundled compatibility probe unavailable");
      const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-update-"));
      try {
        const bun = process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun";
        await updateCodex(binary, productionUpdatePorts({ bun, probeFile, scratch, current, report: reportCodexUpdate,
          versionsDirectory: path.join(updateDirectory(binary), "versions") }), false, request);
      } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
    },
  });
  await withViewerOperation("codex.cli-update", () => ticker!(requested));
}

/** An authenticated host request enters the same coalesced serving job. It
 * bypasses the daily wait; all compatibility, custody and idle gates remain. */
export function requestCodexUpdate(): boolean {
  if (!current()) return false;
  void codexUpdateTick(true).catch(() => console.error("[codex update] requested check could not complete; retained state will retry"));
  return true;
}
