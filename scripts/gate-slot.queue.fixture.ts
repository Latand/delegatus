import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuAdmissionFile, CPU_QUEUE_MAX_WAIT_MS, CpuAdmissionQueue } from "../src/lib/runtime/cpuAdmission";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

// This release predates bounded gate waits and cap locks. Use its actual
// shell, helper and queue, including the legacy SQL used on final claim.
const legacyRevision = "2c7e437a553f56d81afa39e71878f60a1e6d73a3";

export function legacyGateTree(directory: string, revision = legacyRevision) {
  const tree = path.join(directory, "legacy");
  fs.mkdirSync(tree);
  let source = process.cwd();
  if (Bun.spawnSync(["git", "cat-file", "-e", revision], { stderr: "ignore" }).exitCode !== 0) {
    // A shallow checkout may omit the historical producer. Fetch only its
    // pinned object into a private fixture repository.
    source = path.join(directory, "history.git");
    const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--bare", source]);
    execFileSync("git", ["-C", source, "fetch", "--no-tags", "--depth=1", origin, revision], { timeout: 30_000 });
  }
  execFileSync("bash", ["-o", "pipefail", "-c", 'git archive "$1" | tar -xf - -C "$2"', "archive-legacy-gate", revision, tree], { cwd: source });
  fs.symlinkSync(path.resolve("node_modules"), path.join(tree, "node_modules"), "dir");
  return tree;
}

export async function until(check: () => boolean, timeoutMs = 5_000, failure = () => new Error("queue fixture did not reach its barrier")) {
  const ends = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > ends) throw failure(); await Bun.sleep(10); }
}
export const queuedTickets = "FROM tickets WHERE key NOT GLOB 'command:gate-active:*'";
export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-queue-"));
  const env = { ...process.env, LLV_GATE_LOCK_DIR: dir, LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_POLL_SECONDS: "0.02", DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "on", LLV_GATE_PSI_RELEASE_SECONDS: "0" };
  // The fixture's gates queue for slots of their own, never the run's gate. A
  // signal-sandboxed stage keeps its marker: these gates use the real user
  // manager and really start in the stage's namespaces.
  withoutInheritedGate(env, { keepSandbox: true });
  fs.writeFileSync(env.LLV_GATE_PSI_FILE, "some avg10=90.00 avg60=90.00 avg300=90.00 total=1\n");
  const file = path.join(dir, path.basename(cpuAdmissionFile()));
  new CpuAdmissionQueue(file).close();
  const db = new Database(file);
  db.exec("PRAGMA busy_timeout=5000");
  const command = (word: string) => ["bash", "scripts/gate-slot.sh", "bash", "-c", `echo ${word} >> "$CPU_QUEUE_OUTPUT"`];
  return { dir, env: { ...env, CPU_QUEUE_OUTPUT: path.join(dir, "output") }, db, command,
    count: () => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n ${queuedTickets}`).get()!.n,
    age: () => db.query("UPDATE tickets SET since = ? WHERE key NOT GLOB 'command:gate-active:*'").run(Date.now() - CPU_QUEUE_MAX_WAIT_MS),
    close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export function pathWithoutFlock(directory: string) {
  const bin = path.join(directory, "portable-bin");
  fs.mkdirSync(bin);
  for (const command of ["bash", "date", "dirname", "getconf", "mkdir", "mktemp", "realpath", "rm", "sleep", "systemctl", "systemd-notify", "systemd-run", "touch", "uname", "which"]) {
    const executable = Bun.which(command);
    if (executable) fs.symlinkSync(executable, path.join(bin, command));
  }
  fs.symlinkSync(process.execPath, path.join(bin, "bun"));
  return bin;
}
