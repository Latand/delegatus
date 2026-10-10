/* The launcher's last step before the service stops: the Telegram connector
   runner the stopped Viewer started must be gone first. With KillMode=process
   systemd signals only the launcher, and a runner left behind keeps the
   service's cgroup populated, so the next start reuses that old cgroup path
   instead of the configured slice (2026-10-10). The runner ends on its own when
   its Viewer's stdin lease closes; this waits for that, and only then signals
   the recorded process, by its kernel start identity and exact command line. */
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ENTRY = "telegram-mcp-server.py";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readRecord(stateDirectory) {
  const file = join(stateDirectory, "telegram", "connector.json");
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (record?.version !== 1 || !Number.isInteger(record.pid) || record.pid <= 1 || typeof record.identity !== "string"
      || typeof record.command !== "string" || typeof record.entrypoint !== "string" || basename(record.entrypoint) !== ENTRY) return null;
    return record;
  } catch {
    return null;
  }
}

/* The same identity the Viewer recorded (src/lib/proc/linux.ts): pid and the
   kernel start ticks; a zombie has already ended. */
function running(record) {
  try {
    const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X" && `${record.pid}:${fields[19]}` === record.identity;
  } catch {
    return false;
  }
}

/* Signalled only while its command line still proves the packaged runner. An
   exiting process reads an empty command line, so waiting asks `running`. */
function isRecordedRunner(record) {
  try {
    const argv = readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split("\0");
    return running(record) && argv[0] === record.command && argv[1] === record.entrypoint;
  } catch {
    return false;
  }
}

async function exited(record, ms, pollMs) {
  const deadline = Date.now() + ms;
  while (running(record)) {
    if (Date.now() >= deadline) return false;
    await wait(pollMs);
  }
  return true;
}

function signal(record, name) {
  if (!isRecordedRunner(record)) return;
  try { process.kill(record.pid, name); } catch { /* already gone */ }
}

/**
 * Bounded: at most `leaseMs + termMs + killMs`. Answers what happened, so
 * the launcher can say so; it never throws.
 * @param {string} stateDirectory
 * @param {{ leaseMs?: number, termMs?: number, killMs?: number, pollMs?: number }} [options]
 * @returns {Promise<"none" | "exited" | "terminated" | "killed" | "survived">}
 */
export async function retireTelegramConnector(stateDirectory, options = {}) {
  const { leaseMs = 3_000, termMs = 2_000, killMs = 2_000, pollMs = 25 } = options;
  if (process.platform !== "linux") return "none";
  const record = readRecord(stateDirectory);
  if (!record || !isRecordedRunner(record)) return "none";
  if (await exited(record, leaseMs, pollMs)) return "exited";
  signal(record, "SIGTERM");
  if (await exited(record, termMs, pollMs)) return "terminated";
  signal(record, "SIGKILL");
  return await exited(record, killMs, pollMs) ? "killed" : "survived";
}
