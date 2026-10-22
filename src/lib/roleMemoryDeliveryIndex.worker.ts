import fs from "node:fs";
import path from "node:path";
import { declaredIndexes } from "./state/declaredIndexes";
import { assertStateStartupMutation } from "./stateOwnership";

const directory = process.env.LLV_ROLE_MEMORY_DELIVERY_DIRECTORY;
if (!directory || !path.isAbsolute(directory)) throw Error("memory delivery index directory is unavailable");
const filename = path.join(directory, "delivery.sqlite");
assertStateStartupMutation(directory, "memory delivery index preparation");
try {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw Error("memory delivery archive must be an unlinked regular file");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const { Database } = await import("bun:sqlite");
const testBarrier = process.env.LLV_ROLE_MEMORY_INDEX_TEST_BARRIER;
if (testBarrier) {
  fs.writeFileSync(path.join(testBarrier, "worker-ready"), "ready");
  await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(testBarrier, () => {
      if (fs.existsSync(path.join(testBarrier, "continue"))) { watcher.close(); resolve(); }
    });
    watcher.once("error", reject);
    if (fs.existsSync(path.join(testBarrier, "continue"))) { watcher.close(); resolve(); }
  });
}
const db = new Database(filename, { create: true });
try {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec("CREATE TABLE IF NOT EXISTS deliveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS versions (hash TEXT PRIMARY KEY, content BLOB NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS files (sequence INTEGER REFERENCES deliveries(sequence) ON DELETE CASCADE, hash TEXT REFERENCES versions(hash), PRIMARY KEY(sequence, hash));");
  declaredIndexes([
    "CREATE INDEX IF NOT EXISTS files_hash ON files(hash)",
    "CREATE INDEX IF NOT EXISTS deliveries_attempt ON deliveries(json_extract(body,'$.attempt.pipelineId'), json_extract(body,'$.attempt.stageId'), json_extract(body,'$.attempt.attempt'), json_extract(body,'$.conversationId'))",
  ]).install(db, directory);
} finally {
  db.close();
}
