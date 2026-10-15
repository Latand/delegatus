import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { MigrationTargetUnavailableError } from "./safeHistoryCopy";

function safeDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
}

/** Admission only reads. The provider creates a missing root, then repeats
    these checks before copying history; admission cannot guarantee later safety. */
export function validateMigrationTargetRoot(account: AccountContext, create = false): Promise<void> {
  return withViewerOperation("accounts.migration-target", async () => {
    try {
      if (!safeDirectory(await fs.lstat(account.home))) {
        throw new MigrationTargetUnavailableError("unsafe-home", "target account home failed safety checks");
      }
      if (path.dirname(path.resolve(account.transcriptRoot)) !== path.resolve(account.home)) {
        // Cut-over Claude accounts report the canonical shared store outside
        // their config homes (the CLI keeps its projects symlink).
        let shared = false;
        if (account.engine === "claude") {
          try { shared = await fs.realpath(account.transcriptRoot) === await fs.realpath(sharedClaudeProjectsRoot()); }
          catch { /* An absent shared store cannot establish the exception. */ }
        }
        if (!shared) throw new MigrationTargetUnavailableError("unsafe-transcript-root", "target transcript root is outside its account home");
      }
      if (create) {
        try { await fs.mkdir(account.transcriptRoot, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      let root: Stats;
      try { root = await fs.lstat(account.transcriptRoot); }
      catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (!safeDirectory(root)) {
        throw new MigrationTargetUnavailableError("unsafe-transcript-root", "target transcript root failed safety checks");
      }
    } catch (error) {
      if (error instanceof MigrationTargetUnavailableError) throw error;
      throw new MigrationTargetUnavailableError("unsafe-transcript-root", "target migration directories could not be checked");
    }
  });
}
