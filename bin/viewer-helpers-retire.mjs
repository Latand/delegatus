/* The launcher's last step for the Viewer it has just stopped: every non-agent
   helper that Viewer started under bin/helper-lease.mjs must be gone before
   the launcher exits and the service manager starts the next one. With
   KillMode=process systemd signals only the launcher, and a helper left in
   the service's cgroup makes the next start reuse that old cgroup path
   instead of the configured slice (2026-10-10).

   Each guardian ends its helper's process group when its lease closes; this
   waits for that, and finishes only what the stopped Viewer owned: a record is
   acted on when its owner's start identity is one the launcher read from that
   Viewer's own process tree before stopping it. A successor sharing the state
   directory records helpers under its own identity, which never matches.

   The Viewer's other non-agent children (a git or gh command, a worker that
   is not leased) stay in its process group, while every agent, structured
   host, workflow setup command and sign-in is started detached, leading a
   group of its own, so that it outlives the Viewer. The launcher therefore
   also waits for, then ends, each process it read in the stopped Viewer's
   tree that is still in the Viewer's own group (retireViewerDescendants). */
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fields after the command name in /proc/<pid>/stat, or null. */
export function statFields(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** `<pid>:<start ticks>` (src/lib/proc/linux.ts) of a live, unexited process. */
export function liveIdentity(pid) {
  const fields = statFields(pid);
  return fields && fields[0] !== "Z" && fields[0] !== "X" ? `${pid}:${fields[19]}` : null;
}

/**
 * The identities of `pid` and its descendants, read while they run, with the
 * process group of each. Called before the Viewer is stopped: these are the
 * owners whose records the launcher may finish afterwards.
 * @param {number | undefined} pid
 * @returns {Array<{ pid: number, identity: string, group: number }>}
 */
export function viewerProcessTree(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 1) return [];
  const children = new Map();
  let entries = [];
  try { entries = readdirSync("/proc"); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const parent = Number(statFields(Number(entry))?.[1]);
    if (!Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(Number(entry));
  }
  const owners = [];
  const pending = [pid];
  const seen = new Set();
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    const fields = statFields(next);
    if (!fields || fields[0] === "Z" || fields[0] === "X") continue;
    owners.push({ pid: next, identity: `${next}:${fields[19]}`, group: Number(fields[2]) });
    pending.push(...(children.get(next) ?? []));
  }
  return owners;
}

/** Whether a record names one of `owners` by pid and start identity. */
export function ownedBy(record, owners) {
  return owners.some((owner) => owner.pid === record.ownerPid && owner.identity === record.ownerIdentity);
}

/** A record file only this user can have written. */
export function readPrivateJson(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function validRecord(record) {
  return record?.version === 1
    && Number.isInteger(record.pid) && record.pid > 1 && typeof record.identity === "string"
    && Number.isInteger(record.ownerPid) && record.ownerPid > 1 && typeof record.ownerIdentity === "string"
    && Number.isInteger(record.group) && record.group > 1 && typeof record.groupIdentity === "string";
}

/* The live members of the helper's process group. The kernel hands out a
   group's id again only once the group is empty, and then to a process with
   that pid: a live leader of another start identity means the group is gone. */
function groupMembers(record) {
  const leader = liveIdentity(record.group);
  if (leader !== null && leader !== record.groupIdentity) return [];
  const leaderStart = Number(record.groupIdentity.split(":")[1]);
  const members = [];
  let entries = [];
  try { entries = readdirSync("/proc"); } catch { return members; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const fields = statFields(pid);
    if (!fields || fields[0] === "Z" || fields[0] === "X" || Number(fields[2]) !== record.group) continue;
    if (Number(fields[19]) < leaderStart) continue;
    members.push({ pid, identity: `${pid}:${fields[19]}` });
  }
  return members;
}

function signalVerified(members, signal) {
  for (const member of members) {
    if (liveIdentity(member.pid) !== member.identity) continue;
    try { process.kill(member.pid, signal); } catch { /* already gone */ }
  }
}

async function until(done, ms, pollMs) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await wait(pollMs);
  }
  return true;
}

function guardianIsRunning(record) {
  if (liveIdentity(record.pid) !== record.identity) return false;
  try {
    return readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split("\0").some((arg) => arg.endsWith("helper-lease.mjs"));
  } catch {
    return false;
  }
}

/**
 * Bounded: at most `leaseMs + termMs + killMs`. Never throws.
 * @param {string} stateDirectory
 * @param {Array<{ pid: number, identity: string }>} owners the stopped Viewer's process tree
 * @param {{ leaseMs?: number, termMs?: number, killMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ exited: number, terminated: number, killed: number, survived: string[] }>}
 */
export async function retireViewerHelpers(stateDirectory, owners, options = {}) {
  const { leaseMs = 3_000, termMs = 1_500, killMs = 1_500, pollMs = 25 } = options;
  const outcome = { exited: 0, terminated: 0, killed: 0, survived: [] };
  if (process.platform !== "linux" || owners.length === 0) return outcome;
  const directory = join(stateDirectory, "helpers");
  let files = [];
  try { files = readdirSync(directory).filter((file) => /^\d+\.json$/.test(file)); } catch { return outcome; }
  const owned = [];
  for (const file of files) {
    const record = readPrivateJson(join(directory, file));
    if (validRecord(record) && ownedBy(record, owners)) owned.push({ file: join(directory, file), record });
  }
  if (owned.length === 0) return outcome;
  /* Each guardian ends its group on its own once its lease closes. */
  const settled = () => owned.every(({ record }) => !guardianIsRunning(record) && groupMembers(record).length === 0);
  if (await until(settled, leaseMs, pollMs)) {
    outcome.exited = owned.length;
  } else {
    const remaining = owned.filter(({ record }) => guardianIsRunning(record) || groupMembers(record).length > 0);
    outcome.exited = owned.length - remaining.length;
    const targets = () => remaining.flatMap(({ record }) => [
      ...(guardianIsRunning(record) ? [{ pid: record.pid, identity: record.identity }] : []),
      ...groupMembers(record),
    ]);
    signalVerified(targets(), "SIGTERM");
    if (await until(() => targets().length === 0, termMs, pollMs)) {
      outcome.terminated = remaining.length;
    } else {
      signalVerified(targets(), "SIGKILL");
      if (await until(() => targets().length === 0, killMs, pollMs)) outcome.killed = remaining.length;
      else outcome.survived = remaining.map(({ record }) => String(record.name ?? record.pid));
    }
  }
  for (const { file, record } of owned) {
    if (!guardianIsRunning(record) && groupMembers(record).length === 0) rmSync(file, { force: true });
  }
  return outcome;
}

/**
 * After the Viewer `viewerPid` has stopped: the processes of its tree, as read
 * before the stop, that are still running in the Viewer's own process group.
 * Each is matched by its start identity, so a recycled pid is never one.
 * @param {number | undefined} viewerPid
 * @param {Array<{ pid: number, identity: string, group?: number }>} owners
 */
export function viewerGroupLeftovers(viewerPid, owners) {
  const viewer = owners.find((owner) => owner.pid === viewerPid);
  if (!viewer || !Number.isInteger(viewer.group)) return [];
  return owners.filter((owner) => owner.pid !== viewerPid && owner.group === viewer.group
    && liveIdentity(owner.pid) === owner.identity && Number(statFields(owner.pid)?.[2]) === viewer.group);
}

/**
 * Waits for the stopped Viewer's non-agent descendants (its process-group
 * members read before the stop) to exit, then terminates and kills what
 * remains. Bounded: at most `waitMs + termMs + killMs`. Never throws.
 * @param {number | undefined} viewerPid
 * @param {Array<{ pid: number, identity: string, group?: number }>} owners the Viewer's tree read before the stop
 * @param {{ waitMs?: number, termMs?: number, killMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ exited: number, terminated: number, killed: number, survived: string[] }>}
 */
export async function retireViewerDescendants(viewerPid, owners, options = {}) {
  const { waitMs = 3_000, termMs = 1_500, killMs = 1_500, pollMs = 25 } = options;
  const outcome = { exited: 0, terminated: 0, killed: 0, survived: [] };
  if (process.platform !== "linux") return outcome;
  const initial = viewerGroupLeftovers(viewerPid, owners);
  if (initial.length === 0) return outcome;
  const remaining = () => viewerGroupLeftovers(viewerPid, initial.concat(owners.filter((owner) => owner.pid === viewerPid)));
  if (await until(() => remaining().length === 0, waitMs, pollMs)) {
    outcome.exited = initial.length;
    return outcome;
  }
  const signalled = remaining();
  outcome.exited = initial.length - signalled.length;
  signalVerified(signalled, "SIGTERM");
  if (await until(() => remaining().length === 0, termMs, pollMs)) {
    outcome.terminated = signalled.length;
    return outcome;
  }
  const killed = remaining();
  outcome.terminated = signalled.length - killed.length;
  signalVerified(killed, "SIGKILL");
  await until(() => remaining().length === 0, killMs, pollMs);
  const survivors = remaining();
  outcome.killed = killed.length - survivors.length;
  outcome.survived = survivors.map((owner) => String(owner.pid));
  return outcome;
}
