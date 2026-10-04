/* delegatus-launcher-credential-custody-v1. Only first-party launchers read
   this durable gate. Displayed commands carry a requirement, never a key. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appDirIn } from "./appDir.mjs";

const REFUSAL = "Protected launcher handoff is unavailable. Keep the current launcher running; restore private, current-user-owned handoff storage for this installation before retrying.";
const fail = () => { throw new Error(REFUSAL); };
const SETTINGS = ["LLV_TOKEN", "LLV_PUBLIC_HOST", "LLV_TS_HOST", "LLV_TS_URL"];

// Windows mode bits do not express access. A protected NTFS DACL grants only
// the current Windows identity FullControl. Existing ACLs are verified, never
// repaired; links and every reparse point are refused before an open/read.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = $env:DELEGATUS_CUSTODY_PATH
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  if ($env:DELEGATUS_CUSTODY_CREATE -eq '1') {
    if ($item.PSIsContainer) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    if ($item.PSIsContainer) {
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $p -AclObject $acl
  }
  $acl = Get-Acl -LiteralPath $p
  if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'unsafe' }
  exit 0
} catch { exit 1 }
`;
function windowsAcl(file, create = false) {
  // pwsh's module paths survive intermediate processes such as Bun. Windows
  // PowerShell must construct its own paths to load its built-in ACL cmdlets.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")], {
    env: { ...env, DELEGATUS_CUSTODY_PATH: file, DELEGATUS_CUSTODY_CREATE: create ? "1" : "0" }, stdio: "ignore", timeout: 10000,
  });
  if (result.status !== 0) fail();
}
function privateEntry(file, directory = false) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail();
  if (process.platform === "win32") windowsAcl(file);
  else if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || (stat.mode & (directory ? 0o700 : 0o600)) !== (directory ? 0o700 : 0o600)) fail();
  return stat;
}
function syncDirectory(directory) {
  // fsync files flushes NTFS metadata too; POSIX also needs the directory entry.
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sameEntry(before, after) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid) fail();
}
function identity(root, env) {
  const installRoot = resolve(root);
  const rootStat = statSync(installRoot);
  const config = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  const state = env.LLV_STATE_DIR?.trim() || join(appDirIn(config), "state");
  const stateRoot = realpathSync(state);
  const installId = createHash("sha256").update(installRoot).digest("hex").slice(0, 16);
  const directory = join(stateRoot, `launcher-custody-${installId}`);
  const expectedKeyDigest = env.LLV_TOKEN ? createHash("sha256").update(env.LLV_TOKEN).digest("hex") : null;
  return { expectedKeyDigest, installRoot, realRoot: realpathSync(installRoot), rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), stateRoot,
    directory, identityFile: join(directory, "identity.json"), file: join(directory, "environment.json") };
}
function metadata(id) {
  return { schema: 1, installRoot: id.installRoot, realRoot: id.realRoot, rootDevice: id.rootDevice, rootInode: id.rootInode, stateRoot: id.stateRoot };
}
function verifyIdentity(id) {
  const dir = privateEntry(id.directory, true);
  const entry = privateEntry(id.identityFile);
  const fd = openSync(id.identityFile, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    sameEntry(entry, fstatSync(fd)); sameEntry(dir, privateEntry(id.directory, true));
    const record = JSON.parse(readFileSync(fd, "utf8"));
    for (const [name, value] of Object.entries(metadata(id))) if (record[name] !== value) fail();
    if (!/^[a-f0-9]{64}$/.test(record.keyDigest ?? "") || id.expectedKeyDigest && record.keyDigest !== id.expectedKeyDigest) fail();
    sameEntry(entry, privateEntry(id.identityFile));
    return record.keyDigest;
  } finally { closeSync(fd); }
}
function readVerified(id) {
  const keyDigest = verifyIdentity(id);
  const dir = privateEntry(id.directory, true);
  const file = privateEntry(id.file);
  const fd = openSync(id.file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    sameEntry(file, fstatSync(fd)); sameEntry(dir, privateEntry(id.directory, true));
    const record = JSON.parse(readFileSync(fd, "utf8"));
    for (const [name, value] of Object.entries(metadata(id))) if (record[name] !== value) fail();
    if (!record.environment || Object.keys(record.environment).some(name => !SETTINGS.includes(name))
      || Object.values(record.environment).some(value => typeof value !== "string") || !record.environment.LLV_TOKEN) fail();
    if (createHash("sha256").update(record.environment.LLV_TOKEN).digest("hex") !== keyDigest) fail();
    sameEntry(file, privateEntry(id.file)); sameEntry(dir, privateEntry(id.directory, true));
    return record.environment;
  } finally { closeSync(fd); }
}
function present(file) {
  try { lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
/** Persist the exact effective gate. A conflicting existing record is stale;
    refuse it instead of overwriting, rotating, or weakening its credential. */
export function prepareLauncherCredentials(root, environment) {
  try {
    const env = { ...environment };
    // Alias precedence is identical to the public entrypoints, without output.
    for (const name of SETTINGS) if (env[`DELEGATUS_${name.slice(4)}`] !== undefined) env[name] = env[`DELEGATUS_${name.slice(4)}`];
    if (!env.LLV_TOKEN) return false;
    const id = identity(root, env);
    const existingDirectory = present(id.directory);
    if (existingDirectory) privateEntry(id.directory, true);
    else {
      mkdirSync(id.directory, { mode: 0o700 });
      if (process.platform === "win32") windowsAcl(id.directory, true);
      privateEntry(id.directory, true); syncDirectory(id.stateRoot);
    }
    if (!present(id.identityFile)) {
      // A preexisting credential with missing identity is never adopted.
      if (existingDirectory || present(id.file)) fail();
      const fd = openSync(id.identityFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        if (process.platform === "win32") windowsAcl(id.identityFile, true);
        sameEntry(fstatSync(fd), privateEntry(id.identityFile)); privateEntry(id.directory, true);
        writeFileSync(fd, JSON.stringify({ ...metadata(id), keyDigest: id.expectedKeyDigest }) + "\n"); fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    syncDirectory(id.directory);
    verifyIdentity(id);
    const selected = Object.fromEntries(SETTINGS.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
    if (present(id.file)) {
      const held = readVerified(id);
      if (JSON.stringify(held) !== JSON.stringify(selected)) fail();
      return true;
    }
    const dir = privateEntry(id.directory, true);
    const fd = openSync(id.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    try {
      // The file is still empty until the Windows DACL is restricted.
      if (process.platform === "win32") windowsAcl(id.file, true);
      sameEntry(fstatSync(fd), privateEntry(id.file)); sameEntry(dir, privateEntry(id.directory, true));
      writeFileSync(fd, JSON.stringify({ ...metadata(id), environment: selected }) + "\n"); fsyncSync(fd);
      sameEntry(dir, privateEntry(id.directory, true)); sameEntry(fstatSync(fd), privateEntry(id.file));
    } finally { closeSync(fd); }
    syncDirectory(id.directory);
    // Verify durable bytes before admitting a terminal replacement.
    const held = readVerified(id);
    if (JSON.stringify(held) !== JSON.stringify(selected)) fail();
    return true;
  } catch { fail(); }
}
/** Read before pointer selection, probes, trials or children. Retain custody
    across rollback and cold startup; its install inode rejects reused roots. */
export function restoreLauncherCredentials(root, env = process.env) {
  try {
    const required = env.LLV_LAUNCHER_CREDENTIAL_HANDOFF === "1";
    const config = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
    const state = env.LLV_STATE_DIR?.trim() || join(appDirIn(config), "state");
    if (!present(state)) { if (required) fail(); return; }
    const id = identity(root, env);
    if (!present(id.directory)) { if (required) fail(); return; }
    const held = readVerified(id);
    for (const name of SETTINGS) {
      if (env[name] !== undefined && env[name] !== held[name]) fail();
      if (held[name] !== undefined) env[name] = held[name];
    }
  } catch { fail(); }
}
