import { attemptReferencesClear } from "./attemptTempFilesystem";
import fs from "node:fs";
import path from "node:path";
import { discoverAttemptCopies } from "./attemptCopyDiscovery";
import { claimAttemptRetirement } from "@/lib/pipelines/store";

if (process.argv[2] === "--crash-quarantined") {
  const { removeTreeViaTrash, attemptTempJournalPath } = await import("@/lib/tempSweep");
  const directory = process.argv[3]!;
  await removeTreeViaTrash(directory, { journal: attemptTempJournalPath(directory), disposable: true,
    held: () => { process.stdout.write("quarantined\n"); process.exit(0); } });
  process.exit(1);
}

if (process.argv[2] === "--claim-hold") {
  await claimAttemptRetirement(process.argv[3]!, process.argv[4]!);
  process.stdout.write("ready\n");
  for await (const chunk of process.stdin) { void chunk; }
  // Model a process that exits without releasing its durable retirement claim.
  process.exit(0);
}

if (process.argv[2] === "--copy-page") {
  const result = discoverAttemptCopies(process.argv[3]!, process.argv[4]!, Date.now, Date.now() + 10000);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[2] === "--load") {
  process.stdout.write("ready\n");
  const buffer = Buffer.alloc(1024 ** 2);
  if (process.argv[3] === "io") {
    const fd = fs.openSync(process.argv[4]!, "w+");
    while (true) { fs.writeSync(fd, buffer, 0, buffer.length, 0); fs.fdatasyncSync(fd); }
  } else {
    let sum = 0;
    while (true) { for (let n = 0; n < 1_000_000; n++) sum += Math.sqrt(n); if (!Number.isFinite(sum)) sum = 0; }
  }
}
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
import { sweepEvidenceCopies } from "./attemptEvidenceCopies";
import { attemptTempAuthority, runAttemptTempSweep } from "./attemptTempProduction";

if (process.argv[2] === "--production-report") {
  Date.now = () => Number(process.argv[3]);
  const report = await runAttemptTempSweep({ scan: () => ({ ownNamespace: null, processes: [] }) },
    { ...process.env, LLV_TEMP_SWEEP: "on" });
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(0);
}

if (process.argv[2] === "--hold") {
  process.stdout.write("ready\n");
  for await (const chunk of process.stdin) { void chunk; /* The parent owns this hold. */ }
  process.exit(0);
}

const store = new AttemptTempStore(process.argv[2]!);
if (process.argv[4] === "reporting") {
  try {
    const now = Number(process.argv[3]);
    store.refreshReporting(() => now, now + 1000);
    process.stdout.write(JSON.stringify({ retention: store.retention(now), unattributed: store.unattributedCopies() }));
  } finally { store.close(); }
  process.exit(0);
}
if (process.argv[4] === "scheduled-copies") {
  try {
    const now = Number(process.argv[3]), expiresAt = Number(process.argv[5]);
    const report = await sweepEvidenceCopies(store, { now: () => now, state: async () => "closed",
      authority: async () => ({ state: "closed", expiresAt, revision: "fixture", isCurrent: () => true }),
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    process.stdout.write(JSON.stringify({ report, retention: store.retention(now) }));
  } finally { store.close(); }
  process.exit(0);
}
if (process.argv[4] === "copies") {
  try {
    const report = await sweepEvidenceCopies(store, { now: () => Number(process.argv[3]), state: async () => "expired",
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    process.stdout.write(JSON.stringify(report));
  } finally { store.close(); }
  process.exit(0);
}
try {
  const budgetMode = process.argv[4] === "budget-run" || process.argv[4] === "budget-inventory" || process.argv[4] === "budget-read";
  if (process.argv[4] === "budget-read") {
    let monotonic = 0;
    Object.defineProperty(performance, "now", { value: () => monotonic });
    const directoryReads = fs.promises as unknown as {
      readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
    };
    const readdir = directoryReads.readdir.bind(directoryReads);
    directoryReads.readdir = async (target, options) => {
      const entries = await readdir(target, options);
      monotonic += 15_000;
      return entries;
    };
  }
  let now = Number(process.argv[3]);
  const retired = () => {
    if (!budgetMode) return;
    now += process.argv[4] === "budget-run" ? 40_001 : 30_001;
  };
  const repository = path.join(path.dirname(process.argv[2]!), "budget-repository");
  const report = await sweepAttemptTemps(store, {
    now: () => now, runBudgetMs: budgetMode && process.argv[4] === "budget-run" ? 40_000 : undefined,
    ...(process.argv[4] === "production" ? { authority: (owner, inventory) => attemptTempAuthority(owner, inventory, () => now) } : {}),
    maxRoots: process.argv[4] === "expired-pressure" ? 32 : process.argv[4] === "pressure" ? 4 : budgetMode ? 2 : process.argv.includes("--default-budget") ? undefined : 1,
    capBytes: process.argv[4] === "expired-pressure" || process.argv[4] === "pressure" || budgetMode ? 0 : undefined,
    state: async (owner, inventory) => {
      if (process.argv[4] === "production") return (await attemptTempAuthority(owner, inventory, () => now)).state;
      if (process.argv[4] === "budget-inventory" || process.argv[4] === "budget-read") {
        await inventory.targets(repository);
      }
      if (process.argv[4] === "pressure") {
        if (owner.launchId.startsWith("blocked-error")) throw new Error("fixture authority failure");
        return owner.launchId.startsWith("blocked") ? "live" : "closed";
      }
      if (process.argv[4] === "hold-state") {
        process.stdout.write("ready\n");
        for await (const chunk of process.stdin) { void chunk; /* The parent releases this observation. */ }
      }
      return process.argv[4]?.startsWith("expired") ? "expired" : process.argv[4] === "closed" ? "closed" : process.argv[4] === "live" ? "live" : process.argv[4] === "orphan" ? "orphan" : "settled";
    }, scan: () => ({ ownNamespace: null, processes: [] }),
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true),
    onRetired: retired,
  });
  process.stdout.write(JSON.stringify(report));
} finally { store.close(); }
