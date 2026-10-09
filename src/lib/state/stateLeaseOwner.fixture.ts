import "@/lib/testing/fixtureLifetime";
import fs from "node:fs";
import path from "node:path";
import { initializeStateCollections, injectStateWriteFaultForTests, SqliteStateCollection } from "./sqliteStateStore";
const dir = process.argv[2]!;
type Row = { key: string; value: number };
const options = { collection: "probe", schemaVersion: 1, busyMessage: "probe busy", key: (row: Row) => row.key,
  decode: (raw: unknown) => raw as Row, clone: (row: Row) => ({ ...row }) };
const filename = path.join(dir, "state.sqlite");
initializeStateCollections(filename, [{ ...options, migrationId: "probe", loadRecords: () => [] }]);
const c = new SqliteStateCollection(filename, options);
injectStateWriteFaultForTests({ site: "release", collection: "probe",
  error: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL", errno: 13 }) });
c.boundedPatch(1, (tx) => tx.put({ key: "child", value: 1 }));
fs.writeFileSync(path.join(dir, "ready"), "");
while (!fs.existsSync(path.join(dir, "stop"))) {
  if (fs.existsSync(path.join(dir, "lift"))) injectStateWriteFaultForTests(null);
  await Bun.sleep(20);
}
