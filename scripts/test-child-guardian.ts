import fs from "node:fs";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { procBackend } from "../src/lib/proc";

const [ledger, ownerJson] = process.argv.slice(2);
const owner = JSON.parse(ownerJson!) as ProcessIdentity;
const owned = new Map<string, ProcessIdentity>();
const remember = (identity: ProcessIdentity) => {
  if (identity.startIdentity && identity.bootEpoch) owned.set(JSON.stringify(identity), identity);
};
const read = () => {
  for (const line of fs.readFileSync(ledger!, "utf8").split("\n").filter(Boolean)) remember(JSON.parse(line));
  if (![...owned.values()].some(identity => processIdentityStatus(identity) === "alive")) return;
  const parents = procBackend.ppidMap();
  // Only an identity already recorded from spawn can start a tree walk.
  // Verify every edge while both processes are still present.
  for (const identity of owned.values()) {
    if (processIdentityStatus(identity) !== "alive") continue;
    for (const [pid, parent] of parents) if (parent === identity.pid) {
      const child = captureProcessIdentity(pid);
      if (procBackend.readPpid(pid) === identity.pid && processIdentityStatus(identity) === "alive") remember(child);
    }
  }
};
let expired = false;
const bound = setTimeout(() => { expired = true; }, 15 * 60 * 1000);
try {
  while (!expired && processIdentityStatus(owner) === "alive" && !procBackend.processExited(owner.pid) && !fs.existsSync(`${ledger}.done`)) {
    read(); await Bun.sleep(100);
  }
  read();
  const survivors = [...owned.values()].filter(identity => processIdentityStatus(identity) === "alive");
  if (survivors.length) console.error(`owned test child guardian: surviving owned processes: ${survivors.map(identity => identity.pid).join(", ")}`);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const identity of owned.values()) if (processIdentityStatus(identity) === "alive") {
      try { process.kill(identity.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && [...owned.values()].some(identity => processIdentityStatus(identity) === "alive")) await Bun.sleep(20);
    read();
  }
  if ([...owned.values()].some(identity => processIdentityStatus(identity) === "alive")) throw new Error("owned test child guardian could not end an owned process");
  process.exitCode = survivors.length || expired ? 1 : 0;
} finally { clearTimeout(bound); }
