import fs from "node:fs";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { procBackend } from "../src/lib/proc";
import { recordedSupervisorObligation, recordedSupervisorRefusal, supervisorCancellation, writeEnvelope } from "../src/lib/recordedChecks/wire";

const [ledger, ownerJson] = process.argv.slice(2);
const owner = JSON.parse(ownerJson!) as ProcessIdentity;
const recorded = recordedSupervisorObligation();
const input = fs.openSync(ledger!, "r");
const owned = new Map<string, ProcessIdentity>();
const remember = (identity: ProcessIdentity) => {
  if (identity.startIdentity && identity.bootEpoch) owned.set(JSON.stringify(identity), identity);
};
const children = (pid: number): number[] => {
  const result = new Set<number>();
  const gone = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
  try {
    // A fork belongs to the calling thread's kernel child list. Walk every
    // thread of this recorded parent, without opening unrelated processes.
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      try {
        for (const child of fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/)) {
          if (child) result.add(Number(child));
        }
      } catch (error) { if (!gone(error)) throw error; }
    }
  } catch (error) { if (!gone(error)) throw error; }
  return [...result];
};
const read = () => {
  // The writer appends each captured identity once. Retain the file position
  // so completed history cannot repopulate the live ownership set each tick.
  for (const line of fs.readFileSync(input, "utf8").split("\n").filter(Boolean)) remember(JSON.parse(line));
  if (!owned.size) return;
  const parents = process.platform === "linux" ? null : procBackend.ppidMap();
  // Only an identity already recorded from spawn can start a tree walk.
  // Verify every edge while both processes are still present.
  for (const [key, identity] of owned) {
    const status = processIdentityStatus(identity);
    if (status === "dead") { owned.delete(key); continue; }
    if (status !== "alive") continue;
    const descendants = parents ? [...parents].filter(([, parent]) => parent === identity.pid).map(([pid]) => pid) : children(identity.pid);
    for (const pid of descendants) {
      const child = captureProcessIdentity(pid);
      if (procBackend.readPpid(pid) === identity.pid && processIdentityStatus(identity) === "alive") remember(child);
    }
  }
};
// An enclosing portable guardian may stop this guardian after the test dies.
// Finish its recorded ledger before exiting; a default TERM would strand the
// children whose short-lived parent the enclosing poll never observed.
let interrupted = false;
process.on("SIGTERM", () => { interrupted = true; });
process.on("SIGINT", () => { interrupted = true; });
let expired = false;
const bound = setTimeout(() => { expired = true; }, 15 * 60 * 1000);
try {
  while (!interrupted && !expired && !recordedSupervisorRefusal(recorded) && processIdentityStatus(owner) === "alive" && !procBackend.processExited(owner.pid) && !fs.existsSync(`${ledger}.done`)) {
    read(); await Bun.sleep(100);
  }
  read();
  const survivors = [...owned.values()].filter(identity => processIdentityStatus(identity) === "alive");
  const cause = survivors.length ? recordedSupervisorRefusal(recorded) : null;
  const cancellation = cause ? supervisorCancellation(cause) : null;
  if (survivors.length) console.error(`owned test child guardian: surviving owned processes: ${survivors.map(identity => identity.pid).join(", ")}`);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const identity of owned.values()) if (processIdentityStatus(identity) === "alive") {
      try { process.kill(identity.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const deadline = Date.now() + 1_000;
    while (!(interrupted && signal === "SIGTERM") && Date.now() < deadline && [...owned.values()].some(identity => processIdentityStatus(identity) === "alive")) await Bun.sleep(20);
    read();
  }
  if ([...owned.values()].some(identity => processIdentityStatus(identity) === "alive")) throw new Error("owned test child guardian could not end an owned process");
  if (recorded) {
    if ([...owned.values()].some(identity => processIdentityStatus(identity) !== "dead" && !procBackend.processExited(identity.pid)))
      throw new Error("recorded child cleanup has an unverified identity");
    writeEnvelope(`${ledger}.cleanup.json`, { owner, complete: true, cancellation });
  }
  process.exitCode = survivors.length || expired ? 1 : 0;
} finally { clearTimeout(bound); fs.closeSync(input); }
