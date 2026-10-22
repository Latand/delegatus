import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";

if (process.argv[2] === "--hold") {
  process.stdout.write("ready\n");
  for await (const _chunk of process.stdin) { /* The parent owns this hold. */ }
  process.exit(0);
}

const store = new AttemptTempStore(process.argv[2]!);
try {
  const report = await sweepAttemptTemps(store, {
    now: () => Number(process.argv[3]), maxRoots: 1,
    state: async () => process.argv[4] === "live" ? "live" : "settled", scan: () => ({ ownNamespace: null, processes: [] }),
  });
  process.stdout.write(JSON.stringify(report));
} finally { store.close(); }
