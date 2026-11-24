import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export type LegacyInstallerObservation =
  | { kind: "clear"; observedAt: number }
  | { kind: "possible-writer"; pid: number; start: string }
  | { kind: "incomplete"; reason: "enumeration" | "process-identity" | "working-directory" | "expired" | "unsupported" };

const vanished = (error: NodeJS.ErrnoException) => error.code === "ENOENT" || error.code === "ESRCH";
const exec = promisify(execFile);
const CENSUS_MS = 5_000;

async function observeMacInstaller(checkout: string): Promise<LegacyInstallerObservation> {
  const end = performance.now() + CENSUS_MS;
  const command = (executable: string, args: string[]) => exec(executable, args, {
    env: { ...process.env, LC_ALL: "C" }, timeout: Math.max(1, Math.floor(end - performance.now())), maxBuffer: 4 * 1024 * 1024,
  });
  let root: string, output: string;
  try {
    root = await fs.realpath(checkout);
    output = (await command("/bin/ps", ["-ax", "-ww", "-o", "pid=,uid=,lstart=,command="])).stdout;
  } catch { return { kind: "incomplete", reason: "enumeration" }; }
  if (!output.trim() || !output.endsWith("\n")) return { kind: "incomplete", reason: "enumeration" };
  for (const line of output.trimEnd().split("\n")) {
    if (performance.now() >= end) return { kind: "incomplete", reason: "expired" };
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) return { kind: "incomplete", reason: "enumeration" };
    const pid = match[1]!, uid = match[2]!, start = match[3]!, args = match[4]!;
    if (Number(uid) !== process.geteuid?.() && Number(uid) !== process.getuid?.()) continue;
    if (!/(?:^|[\s/])bun(?:-container)?\s+install(?:\s|$)/.test(args)) continue;
    let cwd: string | undefined;
    try {
      const listed = await command("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
      cwd = listed.stdout.split("\n").find(row => row.startsWith("n"))?.slice(1);
    } catch { /* Confirm the identity below before treating a missing cwd as exit. */ }
    let identity: string;
    try { identity = (await command("/bin/ps", ["-p", pid, "-o", "lstart="])).stdout.trim(); }
    catch { return { kind: "incomplete", reason: "process-identity" }; }
    if (identity !== start.trim()) return { kind: "incomplete", reason: "process-identity" };
    if (!cwd) return { kind: "incomplete", reason: "working-directory" };
    if (cwd === root || cwd.startsWith(root + path.sep)) {
      return { kind: "possible-writer", pid: Number(pid), start: String(new Date(`${start} UTC`).getTime()) };
    }
  }
  return performance.now() >= end ? { kind: "incomplete", reason: "expired" } : { kind: "clear", observedAt: Date.now() };
}

/** Read a fresh Linux snapshot. Failure to observe a possible same-credential
 * installer (including one held before it creates its directory) stays open. */
async function inspectLegacyInstallers(checkout: string): Promise<LegacyInstallerObservation> {
  if (process.platform === "darwin") return observeMacInstaller(checkout);
  if (process.platform !== "linux" || process.getuid === undefined || process.geteuid === undefined) {
    return { kind: "incomplete", reason: "unsupported" };
  }
  const started = performance.now();
  const currentUid = new Set([process.getuid(), process.geteuid()]);
  let names: string[], root: string;
  try {
    [names, root] = await Promise.all([fs.readdir("/proc"), fs.realpath(checkout)]);
  } catch { return { kind: "incomplete", reason: "enumeration" }; }
  const inspect = async (name: string, reread = false): Promise<LegacyInstallerObservation | undefined> => {
    const pid = Number(name), proc = `/proc/${pid}`;
    if (pid === process.pid) return;
    let status: string, cmdline: string, stat: string;
    try { status = await fs.readFile(path.join(proc, "status"), "utf8"); }
    catch (error) { return vanished(error as NodeJS.ErrnoException) ? undefined : { kind: "incomplete", reason: "process-identity" }; }
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
    if (!uid) return { kind: "incomplete", reason: "process-identity" };
    if (!uid.slice(1).some(value => currentUid.has(Number(value)))) return;
    try {
      [cmdline, stat] = await Promise.all([fs.readFile(path.join(proc, "cmdline"), "utf8"), fs.readFile(path.join(proc, "stat"), "utf8")]);
    } catch (error) { return vanished(error as NodeJS.ErrnoException) ? undefined : { kind: "incomplete", reason: "process-identity" }; }
    const identity = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
    if (!identity[19]) return { kind: "incomplete", reason: "process-identity" };
    if (["Z", "X", "x"].includes(identity[0]!)) return;
    const args = cmdline.split("\0").slice(0, -1);
    if (!args.length) {
      if (status.includes("Kthread:\t1")) return;
      // cmdline can become empty during exit between the status and stat
      // reads. A fresh stat distinguishes that cut from a live unknown writer.
      if (!reread && performance.now() - started < CENSUS_MS) return inspect(name, true);
      return { kind: "incomplete", reason: "process-identity" };
    }
    const commands = args.slice(0, 3).map(argument => path.basename(argument));
    if (!args.includes("install") || !commands.some(command => command === "bun" || command === "bun-container")) return;
    try {
      const cwd = await fs.readlink(path.join(proc, "cwd"));
      const after = await fs.readFile(path.join(proc, "stat"), "utf8");
      if (after.slice(after.lastIndexOf(")") + 2).trim().split(" ")[19] !== identity[19]) {
        return { kind: "incomplete", reason: "process-identity" };
      }
      if (cwd === root || cwd.startsWith(root + path.sep) || cwd === root + " (deleted)") {
        return { kind: "possible-writer", pid, start: identity[19] };
      }
    } catch {
      try { await fs.stat(proc); }
      catch (error) { if (vanished(error as NodeJS.ErrnoException)) return; }
      return { kind: "incomplete", reason: "working-directory" };
    }
  };
  const pids = names.filter(name => /^[1-9][0-9]*$/.test(name));
  for (let at = 0; at < pids.length; at += 32) {
    if (performance.now() - started >= CENSUS_MS) return { kind: "incomplete", reason: "expired" };
    const results = await Promise.all(pids.slice(at, at + 32).map(inspect));
    const issue = results.find(result => result !== undefined);
    if (issue) return issue;
  }
  return performance.now() - started >= CENSUS_MS ? { kind: "incomplete", reason: "expired" } : { kind: "clear", observedAt: Date.now() };
}

export async function observeLegacyInstaller(checkout: string): Promise<LegacyInstallerObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<LegacyInstallerObservation>(resolve => {
    timer = setTimeout(() => resolve({ kind: "incomplete", reason: "expired" }), CENSUS_MS);
  });
  try { return await Promise.race([inspectLegacyInstallers(checkout), expired]); }
  finally { clearTimeout(timer); }
}
