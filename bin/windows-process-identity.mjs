/* PowerShell's Process.StartTime reads GetProcessTimes, retaining the kernel
   FILETIME used by the runtime-host fence (not WMI's rounded CreationDate).
   https://learn.microsoft.com/dotnet/api/system.diagnostics.process.starttime */
import { spawnSync } from "node:child_process";

export function windowsStartIdentity(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) return null;
  const script = `$ErrorActionPreference='Stop'; $identityProcess=$null; try { $identityProcess=[System.Diagnostics.Process]::GetProcessById(${pid}); if($identityProcess.HasExited){exit 1}; $identityTime=$identityProcess.StartTime.ToFileTimeUtc(); if($identityProcess.HasExited){exit 1}; [Console]::Out.Write($identityTime.ToString()) } catch { exit 1 } finally { if($identityProcess){$identityProcess.Dispose()} }`;
  try {
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 2_000, windowsHide: true });
    const value = result.stdout?.trim();
    if (result.status !== 0 || !/^[0-9]{18,19}$/.test(value ?? "")) return null;
    const filetime = BigInt(value);
    if (filetime < 125911584000000000n || filetime > 2650467743999999999n) return null;
    return `${pid}:${filetime}`;
  } catch { return null; }
}
