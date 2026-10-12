import { spawnSync } from "node:child_process";

/* Establish containment before the helper can run. A job retains descendants
   after their parent exits, including children with inherited output. The
   non-inheritable job handle is duplicated into this guardian and closed by
   the kernel if it exits abruptly. No descendant discovery depends on a
   surviving helper or on a rounded CIM creation timestamp.
   https://learn.microsoft.com/windows/win32/procthread/job-objects */
export const windowsJobNative = `
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

/** @param {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => import("node:child_process").SpawnSyncReturns<string>} [run] */
export function windowsJobSetup(run = spawnSync) {
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
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    // Cold PowerShell, Add-Type and CIM initialization exceeded the former
    // five-second cut on native Windows. Keep containment ahead of launch,
    // allowing 15 seconds within the query lane's 30-second request deadline.
    { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const match = /^([1-9][0-9]*):([0-9]{18,19})$/.exec(result.stdout?.trim() ?? "");
  if (result.status !== 0 || !match) {
    throw new Error("helper lease could not establish Windows job ownership");
  }
  return { handle: match[1], start: match[2] };
}
