/* The launcher's last step for each Viewer it started, run when that Viewer
   exits however it exits (stopped, replaced, crashed): every non-agent
   process the Viewer started must be gone before the launcher starts its
   successor or exits and the service manager starts the next one. With
   KillMode=process systemd signals only the launcher, and a helper left in
   the service's cgroup makes the next start reuse that old cgroup path
   instead of the configured slice (2026-10-10).

   A Viewer is started leading a process group of its own
   (viewerGenerationSpawnOptions), so that group is its generation: every
   non-agent child it starts, and every process those fork later, stays in
   it, while every agent, structured host, workflow setup command and sign-in
   is started detached, leading a group of its own, so that it outlives the
   Viewer. retireViewerGroup reads the group's members afresh on every poll,
   so a child forked after the Viewer stopped is found as well, and signals
   each member by its start identity, never the group as a whole.

   Helpers started under bin/helper-lease.mjs, and detached helpers recorded
   by recordHelperGroup, run in groups of their own. Each records itself under
   `<state>/helpers` with its owner's start identity and the process group it
   was started from; retireViewerHelpers finishes only what the exited
   generation owned. A successor sharing the state directory records helpers
   under its own identity and group, which never match. */
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

/** The start ticks of a `<pid>:<start ticks>` identity, or NaN. */
const startOf = (identity) => Number(String(identity).split(":")[1]);

/**
 * Spawn options for a Viewer: it leads a process group of its own, which
 * holds that Viewer generation's non-agent processes. Windows has no process
 * groups, and a detached child there gets a console of its own.
 * @param {import("node:child_process").SpawnOptions} options
 * @returns {import("node:child_process").SpawnOptions}
 */
export function viewerGenerationSpawnOptions(options) {
  return process.platform === "win32" ? options : { ...options, detached: true };
}

/**
 * The generation of a Viewer just started with viewerGenerationSpawnOptions:
 * its start identity and the process group it leads, read before it can be
 * reaped. Null where there is no /proc to read it from, or when it is gone.
 * @param {number | undefined} pid
 * @returns {{ pid: number, identity: string, group: number } | null}
 */
export function viewerGeneration(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 1) return null;
  const identity = liveIdentity(pid);
  return identity ? { pid, identity, group: pid } : null;
}

/** Whether a record names one of `owners` by pid and start identity, or was
    written from inside the process group an owner leads after that owner
    started, as every helper a Viewer generation starts is. */
export function ownedBy(record, owners) {
  return owners.some((owner) => (owner.pid === record.ownerPid && owner.identity === record.ownerIdentity)
    || (owner.group === owner.pid && Number.isInteger(record.leaseGroup) && record.leaseGroup === owner.group
      && typeof record.identity === "string" && startOf(record.identity) >= startOf(owner.identity)));
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

/* The live members of the process group `group`, whose leader was
   `leaderIdentity`. The kernel hands out a group's id again only once the
   group is empty, and then to a process with that pid: a live leader of
   another start identity means the group is gone. */
function groupMembersOf(group, leaderIdentity) {
  const leader = liveIdentity(group);
  if (leader !== null && leader !== leaderIdentity) return [];
  const leaderStart = startOf(leaderIdentity);
  const members = [];
  let entries = [];
  try { entries = readdirSync("/proc"); } catch { return members; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const fields = statFields(pid);
    if (!fields || fields[0] === "Z" || fields[0] === "X" || Number(fields[2]) !== group) continue;
    if (Number(fields[19]) < leaderStart) continue;
    members.push({ pid, identity: `${pid}:${fields[19]}` });
  }
  return members;
}

const groupMembers = (record) => groupMembersOf(record.group, record.groupIdentity);

function signalVerified(members, signal) {
  for (const member of members) {
    if (liveIdentity(member.pid) !== member.identity) continue;
    try { process.kill(member.pid, signal); } catch { /* already gone */ }
  }
}

/* True once `done` has held on every poll for `settleMs`: one read of /proc
   that finds nothing can miss a process a member is starting at that moment. */
async function until(done, ms, pollMs, settleMs = Math.max(4 * pollMs, 100)) {
  const deadline = Date.now() + ms;
  let since = null;
  for (;;) {
    const now = Date.now();
    if (done()) {
      since ??= now;
      if (now - since >= settleMs) return true;
    } else {
      since = null;
    }
    if (now >= deadline) return false;
    await wait(pollMs);
  }
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
 * @param {Array<{ pid: number, identity: string, group?: number }>} owners the exited Viewer generation
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
    if (!validRecord(record)) continue;
    if (ownedBy(record, owners)) owned.push({ file: join(directory, file), record });
    /* Whoever owned it, the record of a helper that is gone proves nothing. */
    else if (!guardianIsRunning(record) && groupMembers(record).length === 0) rmSync(join(directory, file), { force: true });
  }
  if (owned.length === 0) return outcome;
  /* Each guardian ends its group on its own once its lease closes. */
  const settled = () => owned.every(({ record }) => !guardianIsRunning(record) && groupMembers(record).length === 0);
  if (await until(settled, leaseMs, pollMs)) {
    outcome.exited = owned.length;
  } else {
    const remaining = owned.filter(({ record }) => guardianIsRunning(record) || groupMembers(record).length > 0);
    outcome.exited = owned.length - remaining.length;
    /* Every owned group, not only those that read as running just now. */
    const targets = () => owned.flatMap(({ record }) => [
      ...(guardianIsRunning(record) ? [{ pid: record.pid, identity: record.identity }] : []),
      ...groupMembers(record),
    ]);
    /* Every poll signals what the last did not reach: a member a helper
       forked meanwhile is in its group and ends with it. */
    const termed = new Set();
    const term = () => {
      const live = targets();
      signalVerified(live.filter((target) => !termed.has(target.identity)), "SIGTERM");
      for (const target of live) termed.add(target.identity);
      return live.length === 0;
    };
    const kill = () => {
      const live = targets();
      signalVerified(live, "SIGKILL");
      return live.length === 0;
    };
    if (await until(term, termMs, pollMs)) outcome.terminated = remaining.length;
    else if (await until(kill, killMs, pollMs)) outcome.killed = remaining.length;
    else outcome.survived = remaining.map(({ record }) => String(record.name ?? record.pid));
  }
  for (const { file, record } of owned) {
    if (!guardianIsRunning(record) && groupMembers(record).length === 0) rmSync(file, { force: true });
  }
  return outcome;
}

/**
 * Waits for the members of an exited Viewer generation's process group to
 * exit, then terminates and kills what remains. The members are read afresh
 * on every poll, so a process forked after the Viewer stopped (by a helper
 * that then exited, or during the grace period) is found and signalled too;
 * each by its start identity, never the group as a whole. Agents lead groups
 * of their own and are never members. Bounded: at most
 * `waitMs + termMs + killMs`. Never throws.
 * @param {{ pid: number, identity: string, group: number } | null | undefined} generation
 * @param {{ waitMs?: number, termMs?: number, killMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ exited: number, terminated: number, killed: number, survived: string[] }>}
 */
export async function retireViewerGroup(generation, options = {}) {
  const { waitMs = 3_000, termMs = 1_500, killMs = 1_500, pollMs = 25 } = options;
  const outcome = { exited: 0, terminated: 0, killed: 0, survived: [] };
  if (process.platform !== "linux" || !generation) return outcome;
  const seen = new Set();
  const termed = new Set();
  const killed = new Set();
  const members = () => {
    const live = groupMembersOf(generation.group, generation.identity).filter((member) => member.pid !== generation.pid);
    for (const member of live) seen.add(member.identity);
    return live;
  };
  /* One loop over the whole bound: members first get `waitMs` to exit, then
     SIGTERM, then SIGKILL on every poll, and whatever appears meanwhile is
     signalled as the phase it appears in requires. It ends once the group
     has stayed empty (until) or the bound is spent. */
  const started = Date.now();
  await until(() => {
    const live = members();
    const elapsed = Date.now() - started;
    if (elapsed >= waitMs + termMs) {
      signalVerified(live, "SIGKILL");
      for (const member of live) killed.add(member.identity);
    } else if (elapsed >= waitMs) {
      signalVerified(live.filter((member) => !termed.has(member.identity)), "SIGTERM");
      for (const member of live) termed.add(member.identity);
    }
    return live.length === 0;
  }, waitMs + termMs + killMs, pollMs);
  const survivors = members();
  const alive = new Set(survivors.map((member) => member.identity));
  for (const identity of seen) {
    if (alive.has(identity)) continue;
    if (killed.has(identity)) outcome.killed += 1;
    else if (termed.has(identity)) outcome.terminated += 1;
    else outcome.exited += 1;
  }
  outcome.survived = survivors.map((member) => String(member.pid));
  return outcome;
}
