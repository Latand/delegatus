import { TemporaryDataStore } from "./temporaryDataStore";
import { sweepTemporaryData } from "./temporaryDataRetention";
import fs from "node:fs";
import { attemptTempJournalPath } from "@/lib/tempSweep";

const [filename, mode, time] = process.argv.slice(2);
const store = new TemporaryDataStore(filename!);
if (mode === "crash-before-rename" || mode === "crash-after-restore") {
  const directory = store.due(Number(time))[0]!.directory, rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (mode === "crash-before-rename" && String(from) === directory) {
      process.stdout.write("intent-written\n"); process.exit(0);
    }
    rename(from, to);
    if (mode === "crash-after-restore" && String(to) === directory) {
      process.stdout.write("restored\n"); process.exit(0);
    }
  };
}
if (mode === "crash-after-remove") {
  const journal = attemptTempJournalPath(store.due(Number(time))[0]!.directory), unlink = fs.unlinkSync;
  fs.unlinkSync = file => { if (String(file) === journal) { process.stdout.write("removed\n"); process.exit(0); } return unlink(file); };
}
try {
  const report = await sweepTemporaryData(store, {
    now: () => Number(time), mounts: () => [], claim: async () => () => {},
    authority: async () => {
      if (mode === "authority-error") throw new Error("authority-unavailable");
      return { expiresAt: mode === "recover-held" || mode === "crash-after-restore" ? null : Number(time) - 1, reason: "open-lane", revision: "fixture", current: () => true };
    },
    references: async (row, current) => {
      if (mode === "crash" && current !== row.directory) { process.stdout.write("quarantined\n"); process.exit(0); }
      if (mode === "references-error") throw new Error("references-unavailable");
      return mode !== "references-held";
    },
  });
  process.stdout.write(JSON.stringify(report));
} finally { store.close(); }
