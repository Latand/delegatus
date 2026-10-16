// Standalone SQLite peers only: importing application controllers here would
// start background queues in a contention fixture.
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { SqliteStateCollection } from "./sqliteStateStore";

export type LockRow = { key: string; value: number; trace: [number, number][] };
export const lockRowOptions = {
  collection: "lock_probe", schemaVersion: 1, busyMessage: "probe busy",
  key: (row: LockRow) => row.key, decode: (raw: unknown) => raw as LockRow,
  clone: (row: LockRow) => structuredClone(row),
};

if (import.meta.main) {
  const [mode, filename, ready, go, argument] = process.argv.slice(2);
  if (mode === "hold" || mode === "exclusive" || mode === "hold-until-release") {
    const db = new Database(filename!);
    db.exec("PRAGMA busy_timeout = 0");
    if (mode === "exclusive") db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    fs.writeFileSync(ready!, "ready");
    try {
      if (mode === "hold-until-release") {
        const deadline = performance.now() + Number(argument);
        while (!fs.existsSync(go!)) {
          if (performance.now() >= deadline) throw new Error("lock holder release watchdog expired");
          await Bun.sleep(5);
        }
      } else await Bun.sleep(Number(argument));
    }
    finally { db.exec("ROLLBACK"); db.close(); }
  } else if (mode === "writer") {
    const store = new SqliteStateCollection(filename!, lockRowOptions);
    fs.writeFileSync(ready!, "ready");
    while (!fs.existsSync(go!)) await Bun.sleep(1);
    let last = performance.now(), maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    try {
      for (let sequence = 0; sequence < 100; sequence++) {
        await store.boundedPatchAsync(2, tx => {
          const row = tx.get("counter")!;
          row.value++; row.trace.push([Number(argument), sequence]); tx.put(row);
        });
        await Bun.sleep(1);
      }
      await Bun.sleep(10);
      console.log(JSON.stringify({ writer: Number(argument), maxGap }));
    } finally { clearInterval(timer); }
  } else throw new Error("unknown contention fixture mode");
}
