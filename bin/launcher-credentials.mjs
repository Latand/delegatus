/* delegatus-launcher-credential-custody-v1. Only first-party launchers read
   this durable gate. Displayed commands carry a requirement, never a key.
   Custody serves one handoff: it is written for the command or the recovery an
   operator is about to take, imposed only on the launcher that takes it or
   resumes it, and dropped when the handoff settles or an ordinary start finds
   it left over. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appDirIn } from "./appDir.mjs";

const HANDOFF = "LLV_LAUNCHER_CREDENTIAL_HANDOFF";
const STORAGE = "its storage is missing, unreadable or not private to the current user";
/** A refusal names its cause and the custody directory. No credential appears in it. */
class Refusal extends Error {}
const fail = (reason = STORAGE) => { throw new Refusal(reason); };
function refusal(error, directory) {
  const reason = error instanceof Refusal ? error.message : STORAGE;
  return new Error(`Protected launcher handoff is unavailable: ${reason}.${directory ? ` Custody directory: ${directory}.` : ""} Keep the current launcher running; `
    + (reason === STORAGE ? "restore private, current-user-owned handoff storage for this installation before retrying."
      : "start the launcher with the settings it holds, or let the update in progress settle before changing them."));
}
const SETTINGS = ["LLV_TOKEN", "LLV_PUBLIC_HOST", "LLV_TS_HOST", "LLV_TS_URL"];

// Windows mode bits do not express access. A protected NTFS DACL grants only
// the current Windows identity FullControl. Existing ACLs are verified, never
// repaired; links and every reparse point are refused before an open/read.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach ($p in $env:DELEGATUS_CUSTODY_PATH.Split('|')) {
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
  }
  exit 0
} catch { exit 1 }
`;
function powershellAcl(files, create) {
  // pwsh's module paths survive intermediate processes such as Bun. Windows
  // PowerShell must construct its own paths to load its built-in ACL cmdlets.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  // One process reads every entry: '|' cannot occur in a Windows path.
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")], {
    env: { ...env, DELEGATUS_CUSTODY_PATH: files.join("|"), DELEGATUS_CUSTODY_CREATE: create ? "1" : "0" }, stdio: "ignore", timeout: 20000,
  }).status === 0;
}
let aclRunner = powershellAcl;
/** Tests only: replace the PowerShell call, or pass nothing to restore it. */
export function setCustodyAclRunnerForTests(run) { aclRunner = run ?? powershellAcl; aclVerified.clear(); prepared.clear(); }

/* An entry whose ACL this process verified, by what a later change must move.
   NTFS advances an entry's change time when its security descriptor is
   replaced, so an unchanged signature is an unchanged DACL and needs no second
   PowerShell process. */
const aclVerified = new Map();
function signature(file) {
  try {
    const stat = lstatSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function windowsAcl(files, create = false) {
  const pending = create ? files : files.filter(file => { const current = signature(file); return current === null || aclVerified.get(file) !== current; });
  if (!pending.length) return;
  if (pending.some(file => file.includes("|")) || !aclRunner(pending, create)) { for (const file of pending) aclVerified.delete(file); fail(); }
  for (const file of pending) aclVerified.set(file, signature(file));
}
function privateEntry(file, directory = false) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail();
  if (process.platform === "win32") windowsAcl([file]);
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
    for (const [name, value] of Object.entries(metadata(id))) if (record[name] !== value) fail("its record was written for another installation or state directory");
    if (!/^[a-f0-9]{64}$/.test(record.keyDigest ?? "")) fail();
    if (id.expectedKeyDigest && record.keyDigest !== id.expectedKeyDigest) fail("it holds a different access key than this launcher was given");
    sameEntry(entry, privateEntry(id.identityFile));
    return record.keyDigest;
  } finally { closeSync(fd); }
}
function readVerified(id) {
  // One PowerShell process covers the directory and both records.
  if (process.platform === "win32") windowsAcl([id.directory, id.identityFile, id.file].filter(present));
  const keyDigest = verifyIdentity(id);
  const dir = privateEntry(id.directory, true);
  const file = privateEntry(id.file);
  const fd = openSync(id.file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    sameEntry(file, fstatSync(fd)); sameEntry(dir, privateEntry(id.directory, true));
    const record = JSON.parse(readFileSync(fd, "utf8"));
    for (const [name, value] of Object.entries(metadata(id))) if (record[name] !== value) fail("its record was written for another installation or state directory");
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
  let id;
  try {
    const env = { ...environment };
    // Alias precedence is identical to the public entrypoints, without output.
    for (const name of SETTINGS) if (env[`DELEGATUS_${name.slice(4)}`] !== undefined) env[name] = env[`DELEGATUS_${name.slice(4)}`];
    if (!env.LLV_TOKEN) return false;
    id = identity(root, env);
    const selected = Object.fromEntries(SETTINGS.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
    // A snapshot asks again every second. Custody this process verified, and
    // that nothing has touched since, is not read or checked a second time.
    const proof = () => JSON.stringify([createHash("sha256").update(JSON.stringify([metadata(id), selected])).digest("hex"),
      signature(id.directory), signature(id.identityFile), signature(id.file)]);
    if (prepared.get(id.directory) === proof()) return true;
    prepared.delete(id.directory);
    const admit = () => { prepared.set(id.directory, proof()); return true; };
    const existingDirectory = present(id.directory);
    if (existingDirectory) privateEntry(id.directory, true);
    else {
      mkdirSync(id.directory, { mode: 0o700 });
      if (process.platform === "win32") windowsAcl([id.directory], true);
      privateEntry(id.directory, true); syncDirectory(id.stateRoot);
    }
    if (!present(id.identityFile)) {
      // A preexisting credential with missing identity is never adopted.
      if (existingDirectory || present(id.file)) fail();
      const fd = openSync(id.identityFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        if (process.platform === "win32") windowsAcl([id.identityFile], true);
        sameEntry(fstatSync(fd), privateEntry(id.identityFile)); privateEntry(id.directory, true);
        writeFileSync(fd, JSON.stringify({ ...metadata(id), keyDigest: id.expectedKeyDigest }) + "\n"); fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    syncDirectory(id.directory);
    verifyIdentity(id);
    if (present(id.file)) {
      const held = readVerified(id);
      if (JSON.stringify(held) !== JSON.stringify(selected)) fail(conflict(held, selected));
      return admit();
    }
    const dir = privateEntry(id.directory, true);
    const fd = openSync(id.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    try {
      // The file is still empty until the Windows DACL is restricted.
      if (process.platform === "win32") windowsAcl([id.file], true);
      sameEntry(fstatSync(fd), privateEntry(id.file)); sameEntry(dir, privateEntry(id.directory, true));
      writeFileSync(fd, JSON.stringify({ ...metadata(id), environment: selected }) + "\n"); fsyncSync(fd);
      sameEntry(dir, privateEntry(id.directory, true)); sameEntry(fstatSync(fd), privateEntry(id.file));
    } finally { closeSync(fd); }
    syncDirectory(id.directory);
    // Verify durable bytes before admitting a terminal replacement.
    const held = readVerified(id);
    if (JSON.stringify(held) !== JSON.stringify(selected)) fail();
    return admit();
  } catch (error) { throw refusal(error, id?.directory); }
}
/* Custody one process prepared and verified, by install: see `prepare`. */
const prepared = new Map();
function conflict(held, selected) {
  if (held.LLV_TOKEN !== selected.LLV_TOKEN) return "it holds a different access key than this launcher was given";
  const name = SETTINGS.find(name => held[name] !== selected[name]);
  return `it holds a different ${name} than this launcher was given`;
}
/** An update or a terminal trial that has not settled still owns its custody.
    An apply record that cannot be read is treated as open. */
function handoffOpen(id, env) {
  if (env.LLV_LAUNCHER_TRIAL) return true;
  const directory = join(id.stateRoot, "self-update");
  const installId = createHash("sha256").update(id.installRoot).digest("hex").slice(0, 16);
  if (present(join(directory, `trial-${installId}.json`))) return true;
  try { return ["building", "ready", "switching"].includes(JSON.parse(readFileSync(join(directory, "apply.json"), "utf8")).state); }
  catch (error) { return error.code !== "ENOENT"; }
}
function discard(id) {
  prepared.delete(id.directory);
  for (const file of [id.directory, id.identityFile, id.file]) aclVerified.delete(file);
  rmSync(id.directory, { recursive: true, force: true });
}
/** Read before pointer selection, probes, trials or children. The held gate is
    imposed only on the launcher that takes a handoff (its command carries the
    requirement) or resumes one that is still open, so custody survives
    rollback and a cold start in between; its install inode rejects reused
    roots. Any other launcher start (`launch`) keeps the settings it was given
    and drops custody left over from an earlier handoff. */
export function restoreLauncherCredentials(root, env = process.env, { launch = false } = {}) {
  // A launcher this handoff already reached hands the settings on by
  // inheritance. Its own start settles the handoff; nothing is read twice.
  if (env[HANDOFF] === "held") return;
  let id;
  try {
    const required = env[HANDOFF] === "1";
    const config = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
    const state = env.LLV_STATE_DIR?.trim() || join(appDirIn(config), "state");
    if (!present(state)) { if (required) fail("no handoff record exists for this installation"); return; }
    id = identity(root, env);
    if (!present(id.directory)) { if (required) fail("no handoff record exists for this installation"); return; }
    // A command that starts no launcher takes no handoff and settles none.
    if (!required && !launch) return;
    if (!required && !handoffOpen(id, env)) { discard(id); return; }
    // The command's own launcher is refused a conflicting key before the
    // record is read; a resumed handoff compares after reading it.
    const held = readVerified(required ? id : { ...id, expectedKeyDigest: null });
    const changed = SETTINGS.find(name => env[name] !== undefined && env[name] !== held[name]);
    // A setting the operator gave this start wins over a resumed handoff and
    // supersedes its custody. The displayed command promised the held gate.
    if (changed && !required) { discard(id); return; }
    if (changed) fail(changed === "LLV_TOKEN" ? "it holds a different access key than this launcher was given" : `it holds a different ${changed} than this launcher was given`);
    for (const name of SETTINGS) if (held[name] !== undefined) env[name] = held[name];
    if (required) env[HANDOFF] = "held";
  } catch (error) { throw refusal(error, id?.directory); }
}
/** The handoff settled: its update was verified or rolled back. Nothing keeps
    the key on disk after that. */
export function releaseLauncherCredentials(root, env = process.env) {
  try {
    const config = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
    const state = env.LLV_STATE_DIR?.trim() || join(appDirIn(config), "state");
    if (!present(state)) return;
    const id = identity(root, env);
    if (present(id.directory)) discard(id);
  } catch { /* Custody that cannot be located stays for an ordinary start to drop. */ }
}
