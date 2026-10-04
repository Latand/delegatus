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

/* One PowerShell start answers for every PID a caller is about to compare.
   A PID that is gone, or whose start time cannot be read, is left out. The
   exit status says nothing here: PowerShell exits 1 whenever the last PID of
   the list was the one that is gone, with every other answer already written.
   Each line is checked on its own. */
export function windowsStartIdentities(pids, run = spawnSync) {
  const wanted = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff);
  const identities = new Map();
  if (!wanted.length) return identities;
  const script = `foreach($identityPid in @(${wanted.join(",")})){ $identityProcess=$null; try { $identityProcess=[System.Diagnostics.Process]::GetProcessById($identityPid); if(-not $identityProcess.HasExited){ $identityTime=$identityProcess.StartTime.ToFileTimeUtc(); if(-not $identityProcess.HasExited){ [Console]::Out.WriteLine($identityPid.ToString() + ':' + $identityTime.ToString()) } } } catch { } finally { if($identityProcess){$identityProcess.Dispose()} } }; exit 0`;
  try {
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 5_000, windowsHide: true });
    for (const line of (result.stdout ?? "").split(/\r?\n/)) {
      const match = /^([0-9]{1,10}):([0-9]{18,19})$/.exec(line.trim());
      if (!match || !wanted.includes(Number(match[1]))) continue;
      const filetime = BigInt(match[2]);
      if (filetime < 125911584000000000n || filetime > 2650467743999999999n) continue;
      identities.set(Number(match[1]), `${Number(match[1])}:${filetime}`);
    }
  } catch { /* Nothing was read. */ }
  return identities;
}
