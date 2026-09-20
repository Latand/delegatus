import fs from "node:fs";
import path from "node:path";

import {
  accountsCollectionRevision,
  CLAUDE_ACCOUNTS_SOURCE,
  importLegacyAccounts,
  mutateAccountSource,
  readAccountSource,
} from "./accountsStore";

/* The other process in the #1870 slice-7 crash tests. Each mode is driven by
   `accountsStore.sqlite.test.ts`, which SIGKILLs it at a named seam. */

const [mode, directory, arg, gate] = process.argv.slice(2);
if (!mode || !directory) throw new Error("account store child arguments are required");

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(2);
}

function stall(ready: string): never {
  fs.writeFileSync(ready, "ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  throw new Error("the child was not killed at its seam");
}

function registry(active: string): unknown {
  return { version: 1, active, accounts: [{ id: active, label: active, kind: "managed", createdAt: 1 }], retired: [], removals: [] };
}

if (mode === "import") {
  if (gate) waitFor(gate);
  const outcome = importLegacyAccounts(directory, { reconcile: true });
  console.log(JSON.stringify({ state: outcome.state, digest: outcome.record.rowDigest, rows: outcome.record.rowCount }));
} else if (mode === "write") {
  if (gate) waitFor(gate);
  mutateAccountSource(CLAUDE_ACCOUNTS_SOURCE, () => registry(arg!), directory);
  console.log(JSON.stringify({ revision: accountsCollectionRevision(directory) }));
} else if (mode === "read") {
  console.log(JSON.stringify({
    body: (readAccountSource(CLAUDE_ACCOUNTS_SOURCE, directory) as { body?: unknown }).body ?? null,
    revision: accountsCollectionRevision(directory),
  }));
} else if (mode === "hold-write") {
  // Killed with SIGKILL while holding the collection lease mid-write.
  mutateAccountSource(CLAUDE_ACCOUNTS_SOURCE, () => {
    stall(arg!);
  }, directory);
} else if (mode === "hold-import") {
  // Killed with SIGKILL inside the import's BEGIN IMMEDIATE transaction.
  importLegacyAccounts(directory, { reconcile: true, hooks: { beforeVerify: () => stall(arg!) } });
} else if (mode === "kill-after-commit") {
  // Killed with SIGKILL after COMMIT and before any legacy file is retired.
  importLegacyAccounts(directory, { reconcile: true, hooks: { afterCommit: () => stall(arg!) } });
} else if (mode === "kill-after-rename") {
  /* Killed with SIGKILL after the primary was renamed aside and before its
     tombstone, the window in which the path holds nothing at all. */
  importLegacyAccounts(directory, { reconcile: true, hooks: { afterRename: () => stall(arg!) } });
} else if (mode === "legacy-write") {
  /* What a release that predates the move does: read the file, then rename a
     temp file over it. Both steps must fail once the store has moved. */
  const file = path.join(directory, CLAUDE_ACCOUNTS_SOURCE);
  const read = (() => {
    try { fs.readFileSync(file, "utf8"); return "read"; }
    catch (error) { return (error as NodeJS.ErrnoException).code ?? "error"; }
  })();
  const temp = path.join(directory, `.${CLAUDE_ACCOUNTS_SOURCE}.old-writer.tmp`);
  fs.writeFileSync(temp, JSON.stringify(registry("clobbered")));
  const write = (() => {
    try { fs.renameSync(temp, file); return "wrote"; }
    catch (error) { return (error as NodeJS.ErrnoException).code ?? "error"; }
  })();
  console.log(JSON.stringify({ read, write }));
} else {
  throw new Error(`unknown account store child mode: ${mode}`);
}
