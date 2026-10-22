import { attemptReferencesClear } from "./attemptTempFilesystem";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";

if (process.argv[2] === "--hold") {
  process.stdout.write("ready\n");
  for await (const _chunk of process.stdin) { /* The parent owns this hold. */ }
  process.exit(0);
}

const store = new AttemptTempStore(process.argv[2]!);
try {
  const report = await sweepAttemptTemps(store, {
    now: () => Number(process.argv[3]), maxRoots: process.argv.includes("--default-budget") ? undefined : 1,
    state: async () => {
      if (process.argv[4] === "hold-state") {
        process.stdout.write("ready\n");
        for await (const _chunk of process.stdin) { /* The parent releases this observation. */ }
      }
      return process.argv[4] === "live" ? "live" : process.argv[4] === "orphan" ? "orphan" : "settled";
    }, scan: () => ({ ownNamespace: null, processes: [] }),
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true),
  });
  process.stdout.write(JSON.stringify(report));
} finally { store.close(); }
