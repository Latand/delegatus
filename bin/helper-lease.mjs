/* The guardian a Viewer starts each non-agent helper under, so no helper
   outlives the Viewer process that owns it (2026-10-10: helpers left in the
   service's cgroup make systemd start every replacement in that old cgroup
   path instead of the configured slice).

     helper-lease.mjs <name> -- <command> [args...]

   The Viewer holds this process's stdin and never writes to it; the kernel
   closes it when the Viewer exits, however it exits. The helper runs in a
   POSIX process group or a Windows job, so its descendants share its end: at end of file,
   when the Viewer stops owning release traffic, or when the Viewer process is
   gone, the owned tree is ended and this process exits.
   Otherwise this process exits with the helper's status.

   A helper that reads a request on its standard input (the file scanner, the
   backup pass) gets the guardian's fd 3 as that input when
   LLV_HELPER_LEASE_INPUT=3: the Viewer writes the request there, and the
   lease on fd 0 is never shared with the helper.

   The owner's start identity is read from /proc, so it is checked on Linux
   only. Elsewhere the owner is gone when this process is re-parented, which
   `process.ppid` reports live.

   Each guardian records itself in `<state>/helpers/<pid>.json` with its
   owner's start identity and the process group it was started in, so the
   launcher can wait for it once that Viewer exits and finish what it could
   not (bin/viewer-helpers-retire.mjs). Nothing
   from the application graph is imported here. */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TERM_MS = 1_500;
const KILL_MS = 1_000;
const POLL_MS = 25;
const OWNER_POLL_MS = 1_000;
const RELEASE_POLL_MS = 2_000;

const separator = process.argv.indexOf("--", 3);
const name = process.argv[2];
const [command, ...args] = separator > 0 ? process.argv.slice(separator + 1) : [];
if (!name || !command) {
  console.error("usage: helper-lease.mjs <name> -- <command> [args...]");
  process.exit(2);
}

const stateDirectory = process.env.LLV_HELPER_LEASE_STATE || "";
const releasePort = process.env.LLV_HELPER_LEASE_PORT?.trim() || "";
const releaseTarget = process.env.LLV_HELPER_LEASE_TARGET || (stateDirectory ? join(stateDirectory, "viewer-release.json") : "");
const input = process.env.LLV_HELPER_LEASE_INPUT === "3" ? 3 : "ignore";
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("LLV_HELPER_LEASE_")) delete env[key];

/* `<pid>:<start ticks>`, as src/lib/proc/linux.ts reads it; null where the
   platform has no /proc or the process is gone or a zombie. */
function identity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? null : `${pid}:${fields[19]}`;
  } catch {
    return null;
  }
}

/* The process group this guardian was started in: its Viewer's generation
   (bin/viewer-helpers-retire.mjs), however deep in that Viewer's tree. */
function processGroup(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    return Number.isInteger(group) && group > 1 ? group : undefined;
  } catch {
    return undefined;
  }
}

const ownerPid = process.ppid;
const ownerIdentity = identity(ownerPid);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Establish containment before the helper can run. A job retains descendants
   after their parent exits, including children with inherited output. The
   non-inheritable job handle is duplicated into this guardian and closed by
   the kernel if it exits abruptly. No descendant discovery depends on a
   surviving helper or on a rounded CIM creation timestamp.
   https://learn.microsoft.com/windows/win32/procthread/job-objects */
const windowsJobNative = `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class HelperJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, byte[] info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, [Out] byte[] info, uint length, out uint returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  static void Require(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static long Install(Process guardian) {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on supported 64-bit Windows.
    if (IntPtr.Size != 8) throw new PlatformNotSupportedException();
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Require(job != IntPtr.Zero);
    try {
      byte[] limits = new byte[144];
      BitConverter.GetBytes((uint)0x2000).CopyTo(limits, 16); // KILL_ON_JOB_CLOSE
      Require(SetInformationJobObject(job, 9, limits, (uint)limits.Length));
      IntPtr remote;
      Require(DuplicateHandle(GetCurrentProcess(), job, guardian.Handle, out remote, 0, false, 2));
      Require(AssignProcessToJobObject(job, guardian.Handle));
      return remote.ToInt64();
    } finally { CloseHandle(job); }
  }
  static int[] Members(IntPtr job) {
    for (int capacity = 16; capacity <= 65536; capacity *= 2) {
      byte[] info = new byte[8 + capacity * IntPtr.Size]; uint returned;
      bool success = QueryInformationJobObject(job, 3, info, (uint)info.Length, out returned);
      if (!success) {
        if (Marshal.GetLastWin32Error() == 234) continue; // ERROR_MORE_DATA
        Require(false);
      }
      uint count = BitConverter.ToUInt32(info, 4);
      if (count > capacity || count < BitConverter.ToUInt32(info, 0)) continue;
      int[] members = new int[count];
      for (int i = 0; i < count; i++) members[i] = checked((int)BitConverter.ToInt64(info, 8 + i * IntPtr.Size));
      return members;
    }
    throw new InvalidOperationException("Job membership could not be read");
  }
  public static bool Reap(Process guardian, long remote) {
    IntPtr job;
    Require(DuplicateHandle(guardian.Handle, new IntPtr(remote), GetCurrentProcess(), out job, 0, false, 2));
    try {
      int self = Process.GetCurrentProcess().Id;
      DateTime deadline = DateTime.UtcNow.AddSeconds(2);
      while (DateTime.UtcNow < deadline) {
        bool empty = true;
        foreach (int pid in Members(job)) {
          if (pid == guardian.Id || pid == self) continue;
          empty = false;
          Process member;
          try { member = Process.GetProcessById(pid); } catch (ArgumentException) { continue; }
          using (member) {
            // Retain a handle before checking kernel job membership. A recycled
            // PID outside this job must never redirect termination.
            IntPtr handle = member.Handle;
            if (member.HasExited) continue;
            bool owned; Require(IsProcessInJob(handle, job, out owned));
            if (!owned) continue;
            member.Kill();
            if (!member.WaitForExit(1000)) return false;
          }
        }
        if (empty) return true;
        System.Threading.Thread.Sleep(25);
      }
      return false;
    } finally { CloseHandle(job); }
  }
}
'@
`;

function windowsJobSetup() {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${windowsJobNative}
    $guardian=$null;
    try {
      $guardian=[System.Diagnostics.Process]::GetProcessById(${process.pid}); $null=$guardian.Handle;
      $caller=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID) -Property ParentProcessId;
      if ($guardian.HasExited -or $caller.ParentProcessId -ne $guardian.Id) { exit 1 }
      $start=$guardian.StartTime.ToFileTimeUtc();
      $handle=[HelperJob]::Install($guardian);
      [Console]::Out.Write($handle.ToString() + ':' + $start.ToString()); exit 0
    } catch { exit 1 } finally { if ($guardian) { $guardian.Dispose() } }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  const match = /^([1-9][0-9]*):([0-9]{18,19})$/.exec(result.stdout?.trim() ?? "");
  if (result.status !== 0 || !match) {
    console.error("helper lease could not establish Windows job ownership");
    process.exit(127); // Never launch a helper without containment.
  }
  return { handle: match[1], start: match[2] };
}
const windowsJob = process.platform === "win32" ? windowsJobSetup() : null;

const child = spawn(command, args, { cwd: process.cwd(), env, stdio: [input, "inherit", "inherit"], detached: true });
const group = child.pid;
let childExit = null;
const childDone = new Promise((resolve) => {
  child.once("exit", (code, signal) => { childExit = { code, signal }; resolve(); });
  child.once("error", () => { childExit ??= { code: 127, signal: null }; resolve(); });
});

const recordFile = stateDirectory ? join(stateDirectory, "helpers", `${process.pid}.json`) : "";
function removeRecord() {
  if (recordFile) rmSync(recordFile, { force: true });
}
function writeRecord() {
  const self = identity(process.pid);
  const groupIdentity = group ? identity(group) : null;
  if (!recordFile || !self || !ownerIdentity || !groupIdentity) return;
  try {
    mkdirSync(join(stateDirectory, "helpers"), { recursive: true, mode: 0o700 });
    const tmp = `${recordFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      version: 1, name, pid: process.pid, identity: self, ownerPid, ownerIdentity, group, groupIdentity,
      leaseGroup: processGroup(process.pid),
    }), { mode: 0o600 });
    renameSync(tmp, recordFile);
  } catch {
    /* Unrecorded, the lease still ends the helper with its Viewer. */
  }
}

function groupAlive() {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

async function groupGone(ms) {
  const deadline = Date.now() + ms;
  while (groupAlive()) {
    if (Date.now() >= deadline) return false;
    await wait(POLL_MS);
  }
  return true;
}

function signalGroup(signal) {
  try { process.kill(-group, signal); } catch { /* already gone */ }
}

/* The job's live membership remains provable after the helper's exit. Keep
   the guardian resident until every other member except this reaper exits;
   inherited pipes and the guardian's close event then fence replacement. */
async function endWindowsTree() {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${windowsJobNative}
    $guardian=$null;
    try {
      $guardian=[System.Diagnostics.Process]::GetProcessById(${process.pid}); $null=$guardian.Handle;
      if ($guardian.HasExited -or $guardian.StartTime.ToFileTimeUtc().ToString() -ne '${windowsJob.start}') { exit 1 }
      if ([HelperJob]::Reap($guardian, [long]${windowsJob.handle})) { exit 0 }; exit 1
    } catch { exit 1 } finally { if ($guardian) { $guardian.Dispose() } }`;
  return new Promise((resolve) => {
    const reaper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { stdio: "ignore", windowsHide: true, timeout: 4_000 });
    reaper.once("error", () => resolve(false));
    reaper.once("close", (code) => resolve(code === 0));
  });
}

let ending = false;
async function end() {
  if (ending) return;
  ending = true;
  if (group) {
    if (process.platform === "win32") {
      // Failed ownership/exit proof keeps the lease resident; never announce
      // closure and let a successor overlap a helper we could not end.
      while (!await endWindowsTree()) await wait(POLL_MS);
      await childDone;
    } else {
      signalGroup("SIGTERM");
      if (!await groupGone(TERM_MS)) {
        signalGroup("SIGKILL");
        await groupGone(KILL_MS);
      }
    }
  }
  removeRecord();
  process.exit(143);
}

function ownsRelease() {
  if (!releasePort || !releaseTarget) return true;
  let raw;
  try {
    raw = readFileSync(releaseTarget, "utf8");
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    const target = JSON.parse(raw);
    return typeof target.endpoint === "string" && new URL(target.endpoint).port === releasePort;
  } catch {
    return false;
  }
}

if (!group) {
  await childDone;
  process.exit(childExit?.code ?? 127);
}
writeRecord();
/* A terminal's Ctrl-C reaches this process with the launcher's group, never
   the helper's own: end the helper with it. */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void end());
process.stdin.once("end", end);
process.stdin.once("close", end);
process.stdin.on("error", end);
process.stdin.resume();
/* A Viewer already gone before the lease was read, or one that left its
   stdin open somewhere, is caught by its identity on Linux and by the
   re-parenting of this process everywhere. */
const procIdentity = process.platform === "linux";
const ownerGone = () => process.ppid !== ownerPid || (procIdentity && (!ownerIdentity || identity(ownerPid) !== ownerIdentity));
const ownerTimer = setInterval(() => { if (ownerGone()) void end(); }, OWNER_POLL_MS);
const releaseTimer = setInterval(() => { if (!ownsRelease()) void end(); }, RELEASE_POLL_MS);
if (ownerGone()) void end();
if (!ownsRelease()) void end();

await childDone;
if (!ending) {
  clearInterval(ownerTimer);
  clearInterval(releaseTimer);
  /* Descendants end on natural/crash exit as well as requested retirement. */
  if (process.platform === "win32") {
    ending = true;
    while (!await endWindowsTree()) await wait(POLL_MS);
  } else if (groupAlive()) {
    signalGroup("SIGTERM");
    if (!await groupGone(TERM_MS)) signalGroup("SIGKILL");
  }
  removeRecord();
  const { code, signal } = childExit ?? { code: 1, signal: null };
  process.exit(code ?? (signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 0) : 1));
}
