import { attemptReferencesClear } from "./attemptTempFilesystem";
import fs from "node:fs";

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
  const report = await sweepAttemptTemps(store, {
    now: () => Number(process.argv[3]), maxRoots: process.argv[4] === "pressure" ? 4 : process.argv.includes("--default-budget") ? undefined : 1,
    capBytes: process.argv[4] === "pressure" ? 0 : undefined,
    state: async owner => {
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
  });
  process.stdout.write(JSON.stringify(report));
} finally { store.close(); }
