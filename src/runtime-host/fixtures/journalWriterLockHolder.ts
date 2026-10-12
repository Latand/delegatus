import { Database } from "bun:sqlite";

/* Holds, from its own process, an ordinary write transaction on an existing
   runtime journal: the lock a peer generation holds while it commits. Held
   for `holdMs`, or until the test stops this process. */
const [filename, holdMs] = [process.argv[2]!, Number(process.argv[3] ?? 0)];
const db = new Database(filename);
db.exec("BEGIN IMMEDIATE");
db.exec("UPDATE journal_meta SET value = value WHERE key = 'seq'");
console.log("held");
// The timers keep the connection referenced: a collected handle would close
// and release the lock early. Exiting drops it without committing.
if (holdMs > 0) setTimeout(() => { db.close(); process.exit(0); }, holdMs);
else setInterval(() => db.query("SELECT 1").get(), 1000);
