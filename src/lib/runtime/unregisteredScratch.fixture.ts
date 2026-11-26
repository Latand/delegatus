import { AttemptTempStore } from "./attemptTempRetention";
import { removeTreeWithinAttemptBudget } from "./attemptTempRemoval";
import { sweepUnregisteredScratch } from "./unregisteredScratch";

/** A pass whose recursive delete dies with the process: the original name is
 * already a tombstone when the process exits, and no outcome row is written. */
if (process.argv[2] === "--crash-mid-delete") {
  const store = new AttemptTempStore();
  await sweepUnregisteredScratch(store, {
    mode: "on", now: () => Number(process.argv[3]), scan: () => ({ ownNamespace: null, processes: [] }),
    references: async () => true, availableBytes: () => 400e9, lanes: () => () => false, attributable: () => false,
    remove: (directory, started, _run, identity, cpu, prefix) => removeTreeWithinAttemptBudget(directory, started,
      (async () => { process.exit(137); }) as never, identity, cpu, prefix),
  });
  process.exit(1);
}
