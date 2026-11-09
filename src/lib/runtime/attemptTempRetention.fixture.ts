import { attemptReferencesClear } from "./attemptTempFilesystem";
import fs from "node:fs";
import path from "node:path";

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

if (process.argv[2] === "--hold") {
  process.stdout.write("ready\n");
  for await (const _chunk of process.stdin) { /* The parent owns this hold. */ }
  process.exit(0);
}

const store = new AttemptTempStore(process.argv[2]!);
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
    maxRoots: process.argv[4] === "pressure" ? 4 : budgetMode ? 2 : process.argv.includes("--default-budget") ? undefined : 1,
    capBytes: process.argv[4] === "pressure" || budgetMode ? 0 : undefined,
    state: async (owner, inventory) => {
      if (process.argv[4] === "budget-inventory" || process.argv[4] === "budget-read") {
        await inventory.targets(repository);
      }
      if (process.argv[4] === "pressure") {
        if (owner.launchId.startsWith("blocked-error")) throw new Error("fixture authority failure");
        return owner.launchId.startsWith("blocked") ? "live" : "closed";
      }
      if (process.argv[4] === "hold-state") {
        process.stdout.write("ready\n");
        for await (const _chunk of process.stdin) { /* The parent releases this observation. */ }
      }
      return process.argv[4] === "live" ? "live" : process.argv[4] === "orphan" ? "orphan" : "settled";
    }, scan: () => ({ ownNamespace: null, processes: [] }),
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true),
    onRetired: retired,
  });
  process.stdout.write(JSON.stringify(report));
} finally { store.close(); }
