/* `delegatus stop --all`, and the app menu's «Stop Delegatus», which starts
   this file detached (src/lib/stopAll.ts).

   Agent hosts start detached so that they outlive a Viewer restart, which
   left a stopped launcher with agent hosts running under PPID 1 and nothing
   that would stop them. This stops what Delegatus recorded starting, from the
   records alone:

   1. The launcher named by each launcher record written in this boot, while
      its start identity still matches. It stops its Viewer and runtime host
      the way Ctrl-C does. A recorded Viewer or runtime host still running
      after that, or left by a launcher that is gone, is stopped when its
      start identity matches and its own environment carries this install's
      runtime-host socket, the proof launcher-adoption.mjs takes over by.
   2. Every agent host the agent registry records (structured hosts, their
      signal sandbox, survivors of an earlier partial stop, tmux-pane agents)
      whose boot epoch, pid and start identity all still match, with the
      processes under it.

   Linux start identities count clock ticks from boot, and a record left by a
   crash or a power loss outlives the boot that wrote it, so the boot is
   checked before any pid is read: a record from an earlier boot names
   nothing, and one from another pid namespace (an agent's signal sandbox
   running this command) cannot be checked from here. Nothing is chosen by
   name, pattern or port. A recorded pid whose identity no longer matches is
   gone; a live pid recorded without an identity, or whose identity cannot be
   read, is reported as not proven and left alone.
   The registry is only read: after a stop it describes processes that are
   gone, which is what a reboot leaves, and the next start settles it the same
   way. Linux and macOS; elsewhere the command says what it could not do. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { darwinKernelIdentity } from "./darwin-process-identity.mjs";
import { matchingProcess } from "./launcher-adoption.mjs";
import { currentBootEpoch, readStartIdentity } from "./self-update-supervisor.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {{ pid: number, startIdentity: string | null, bootEpoch: string | null, kind: string, session: string | null }} RecordedProcess
 * @typedef {{ pid: number, kind: string, session: string | null, under: number }} HostOutcome
 * @typedef {{ platform: string, supported: boolean,
 *   launchers: Array<{ state: "stopped" | "killed" | "survived" | "unreadable" | "earlier-boot" | "not-proven", pid?: number, detail?: string,
 *     reason?: "other-pid-namespace" | "unverifiable" }>,
 *   services: Array<{ role: "web" | "runtimeHost", pid: number, state: "stopped" | "survived" | "not-proven" }>,
 *   registry: { state: "read" | "missing" | "unreadable", detail?: string },
 *   stopped: HostOutcome[], gone: number,
 *   notProven: Array<RecordedProcess & { reason: "no-recorded-identity" | "unverifiable" | "other-pid-namespace" | "own-process-chain" | "unsupported-platform" }>,
 *   survived: HostOutcome[] }} StopReport
 */

function linuxStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}
const running = (fields) => fields !== null && fields[0] !== "Z" && fields[0] !== "X";

/* Identities in the formats their writers record: `identity` as the agent
   registry does (src/lib/proc), `launcherIdentity` as the launcher record does
   (readStartIdentity), `bootEpoch` as src/lib/processIdentity.ts does.
   `bootTimeMs` dates a launcher record written before records carried a boot
   epoch; `ownsInstall` is launcher-adoption.mjs's proof that a recorded
   Viewer or runtime host serves this install. */
const linuxProbe = {
  identity(pid) {
    const fields = linuxStat(pid);
    return running(fields) ? `${pid}:${fields[19]}` : null;
  },
  launcherIdentity(pid) {
    const fields = linuxStat(pid);
    return running(fields) ? fields[19] : null;
  },
  bootEpoch: () => currentBootEpoch("linux"),
  bootTimeMs() {
    try {
      const match = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
      return match ? Number(match[1]) * 1_000 : null;
    } catch {
      return null;
    }
  },
  ownsInstall: (pid, startIdentity, socket) => matchingProcess({ pid, startIdentity }, socket),
  /** pid → { ppid, pgid } of every running process. */
  table() {
    const rows = new Map();
    let entries = [];
    try { entries = readdirSync("/proc"); } catch { return rows; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const fields = linuxStat(Number(entry));
      if (running(fields)) rows.set(Number(entry), { ppid: Number(fields[1]), pgid: Number(fields[2]) });
    }
    return rows;
  },
};

const darwinProbe = {
  identity: (pid) => darwinKernelIdentity(pid),
  launcherIdentity: (pid) => readStartIdentity(pid, "darwin"),
  bootEpoch: () => currentBootEpoch("darwin"),
  bootTimeMs() {
    const match = /^darwin:(\d+):(\d+)$/.exec(currentBootEpoch("darwin") ?? "");
    return match ? Number(match[1]) * 1_000 + Math.floor(Number(match[2]) / 1_000) : null;
  },
  ownsInstall: (pid, startIdentity, socket) => matchingProcess({ pid, startIdentity }, socket),
  table() {
    const rows = new Map();
    const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    for (const line of String(result.stdout ?? "").split("\n")) {
      const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
      if (!pid || stat?.startsWith("Z")) continue;
      rows.set(Number(pid), { ppid: Number(ppid), pgid: Number(pgid) });
    }
    return rows;
  },
};

/** The process probe for a platform, or null where none exists. */
export function processProbe(platform = process.platform) {
  return platform === "linux" ? linuxProbe : platform === "darwin" ? darwinProbe : null;
}

/** A record file this user wrote, with the time it was last written. */
function readOwnJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("the record is not a regular file of this user");
  }
  return { record: JSON.parse(readFileSync(file, "utf8")), writtenMs: stat.mtimeMs };
}

/* The boot part of an epoch: Linux epochs also name the pid namespace. */
const bootOf = (epoch) => epoch.replace(/:pidns:.*$/, "");

/** Whether a recorded epoch names this boot and pid namespace.
    @returns {"this" | "earlier-boot" | "other-pid-namespace" | "unverifiable"} */
function epochVerdict(recorded, current) {
  if (!current) return "unverifiable";
  if (bootOf(recorded) !== bootOf(current)) return "earlier-boot";
  return recorded === current ? "this" : "other-pid-namespace";
}

/**
 * The entries collection of the agent registry, read-only.
 * @returns {Promise<{ state: "read" | "missing" | "unreadable", entries: any[], detail?: string }>}
 */
export async function readRegistryEntries(stateDirectory) {
  const file = join(stateDirectory, "agent-registry.sqlite");
  if (!existsSync(file)) return { state: "missing", entries: [] };
  let Database;
  try { ({ Database } = await import(`bun:${"sqlite"}`)); }
  catch { return { state: "unreadable", entries: [], detail: "reading the agent registry needs Bun" }; }
  let db;
  try {
    db = new Database(file, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db.query("SELECT value_json FROM registry_rows WHERE collection = 'entries' ORDER BY row_order").all();
    const entries = [];
    for (const row of rows) {
      try { entries.push(JSON.parse(row.value_json)); } catch { /* a row this reader cannot parse names no process */ }
    }
    return { state: "read", entries };
  } catch (error) {
    return { state: "unreadable", entries: [], detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try { db?.close(); } catch { /* read-only */ }
  }
}

/** Every process identity a registry entry records as started by Delegatus.
    @param {any[]} entries @returns {RecordedProcess[]} */
export function registryTargets(entries) {
  /** @type {RecordedProcess[]} */
  const targets = [];
  const seen = new Set();
  const add = (identity, kind, entry) => {
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 1) return;
    const key = `${identity.pid}/${identity.startIdentity ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const session = entry?.key && typeof entry.key.engine === "string" && typeof entry.key.sessionId === "string"
      ? `${entry.key.engine} ${entry.key.sessionId}` : null;
    targets.push({ pid: identity.pid, startIdentity: typeof identity.startIdentity === "string" ? identity.startIdentity : null,
      bootEpoch: typeof identity.bootEpoch === "string" ? identity.bootEpoch : null, kind, session });
  };
  for (const entry of entries) {
    const host = entry?.structuredHost;
    if (host?.process) add(host.process, typeof host.kind === "string" ? host.kind : "structured-host", entry);
    const domain = host?.signalDomain;
    if (domain && domain.retired !== true) {
      for (const role of ["monitor", "bubblewrap", "init", "native"]) add(domain[role], "signal-sandbox", entry);
    }
    for (const survivor of Array.isArray(entry?.structuredTerminationSurvivors) ? entry.structuredTerminationSurvivors : []) {
      add(survivor, "survivor", entry);
    }
    if (entry?.host?.kind === "tmux" && entry.host.agent) add(entry.host.agent, "tmux-agent", entry);
  }
  return targets;
}

/* The pids above this process: a stop never reaches its own chain. */
function ownChain(table) {
  const chain = new Set([process.pid]);
  let pid = process.pid;
  for (let depth = 0; depth < 64; depth++) {
    pid = table.get(pid)?.ppid;
    if (!Number.isInteger(pid) || pid <= 1 || chain.has(pid)) break;
    chain.add(pid);
  }
  return chain;
}

/* A verified root and what runs under it: its descendants, and members of
   the process group it leads (most MCP children start groups of their own,
   and a reparented grandchild is no descendant). Captured before any signal,
   each with the identity it has now. */
function captureTree(root, table, probe, chain) {
  const children = new Map();
  for (const [pid, row] of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
  }
  const pids = new Set([root.pid]);
  const queue = [root.pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!pids.has(child)) { pids.add(child); queue.push(child); }
    }
  }
  if (table.get(root.pid)?.pgid === root.pid) {
    for (const [pid, row] of table) if (row.pgid === root.pid) pids.add(pid);
  }
  const members = [root];
  for (const pid of pids) {
    if (pid === root.pid || chain.has(pid)) continue;
    const identity = probe.identity(pid);
    if (identity) members.push({ pid, identity });
  }
  return members;
}

async function until(done, ms, pollMs, sleep) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/* SIGTERM, then SIGKILL after the grace, each sent only to a member whose
   identity still matches one step before the signal. A refused signal
   (EPERM) leaves its member among the survivors. */
async function terminate(members, probe, options) {
  const live = () => members.filter((member) => probe.identity(member.pid) === member.identity);
  const send = (value) => {
    for (const member of live()) {
      try { options.signal(member.pid, value); } catch { /* gone, or refused: the next reading says which */ }
    }
  };
  send("SIGTERM");
  if (await until(() => live().length === 0, options.graceMs, options.pollMs, options.sleep)) return { survivors: [] };
  send("SIGKILL");
  await until(() => live().length === 0, options.killMs, options.pollMs, options.sleep);
  return { survivors: live() };
}

/* Every launcher record in the state directory: each install sharing it
   (a global install and a `bunx` cache are two) keeps its own. */
function launcherRecords(stateDirectory) {
  const directory = join(stateDirectory, "self-update");
  let names = [];
  try { names = readdirSync(directory).filter((name) => /^launcher-[^/\\]+\.json$/.test(name)).sort(); }
  catch { return []; }
  return names.map((name) => {
    try { return { file: name, ...readOwnJson(join(directory, name)) }; }
    catch (error) { return { file: name, error: error instanceof Error ? error.message : String(error) }; }
  });
}

/* The boot a launcher record was written in: its recorded epoch, or for a
   record from a launcher that predates the field, whether the file was last
   written after this boot began. Every launcher rewrites its record at each
   state change, so a record a live launcher of this boot owns is younger
   than the boot. */
function recordVerdict(record, writtenMs, probe, bootEpoch) {
  const recorded = record?.launcher?.bootEpoch;
  if (typeof recorded === "string" && recorded) return epochVerdict(recorded, bootEpoch);
  const bootTime = probe.bootTimeMs();
  if (bootTime === null || !Number.isFinite(writtenMs)) return "unverifiable";
  return writtenMs < bootTime ? "earlier-boot" : "this";
}

const recordedProcess = (entry) => entry && Number.isSafeInteger(entry.pid) && entry.pid > 1 && typeof entry.startIdentity === "string" && entry.startIdentity
  ? { pid: entry.pid, startIdentity: entry.startIdentity } : null;

/**
 * @param {{ stateDirectory: string, platform?: NodeJS.Platform,
 *   probe?: ReturnType<typeof processProbe>, signal?: (pid: number, signal: NodeJS.Signals) => void,
 *   sleep?: (ms: number) => Promise<void>, launcherWaitMs?: number, graceMs?: number, killMs?: number, pollMs?: number }} input
 * @returns {Promise<StopReport>}
 */
export async function stopEverything(input) {
  const platform = input.platform ?? process.platform;
  const probe = input.probe === undefined ? processProbe(platform) : input.probe;
  const options = {
    signal: input.signal ?? ((pid, value) => { process.kill(pid, value); }),
    sleep: input.sleep ?? wait,
    graceMs: input.graceMs ?? 3_000,
    killMs: input.killMs ?? 2_000,
    pollMs: input.pollMs ?? 50,
  };
  const launcherWaitMs = input.launcherWaitMs ?? 30_000;
  /** @type {StopReport} */
  const report = { platform, supported: probe !== null, launchers: [], services: [],
    registry: { state: "missing" }, stopped: [], gone: 0, notProven: [], survived: [] };
  if (!probe) {
    /* No identity probe: nothing can be proven, so nothing is signalled. */
    const registry = await readRegistryEntries(input.stateDirectory);
    report.registry = registry.detail ? { state: registry.state, detail: registry.detail } : { state: registry.state };
    report.notProven = registryTargets(registry.entries).map((target) => ({ ...target, reason: "unsupported-platform" }));
    return report;
  }

  const bootEpoch = probe.bootEpoch();

  /* 1. Each running launcher, then whatever it recorded and left running. */
  for (const { file, record, writtenMs, error } of launcherRecords(input.stateDirectory)) {
    if (error) { report.launchers.push({ state: "unreadable", detail: `${file}: ${error}` }); continue; }
    const verdict = recordVerdict(record, writtenMs, probe, bootEpoch);
    if (verdict === "earlier-boot") { report.launchers.push({ state: "earlier-boot", detail: file }); continue; }
    if (verdict !== "this") {
      const pid = Number.isSafeInteger(record?.launcher?.pid) ? record.launcher.pid : undefined;
      report.launchers.push({ state: "not-proven", ...(pid ? { pid } : {}), detail: file, reason: verdict });
      continue;
    }
    const launcher = recordedProcess(record?.launcher);
    if (launcher) {
      const matches = () => probe.launcherIdentity(launcher.pid) === launcher.startIdentity;
      if (matches()) {
        /** @type {StopReport["launchers"][number]} */
        const result = { pid: launcher.pid, state: "stopped" };
        try { options.signal(launcher.pid, "SIGTERM"); } catch { /* exited meanwhile */ }
        if (!await until(() => !matches(), launcherWaitMs, options.pollMs, options.sleep)) {
          /* Its own shutdown is bounded well under the wait; past it, end it
             and stop what it recorded by those records below. */
          if (matches()) { try { options.signal(launcher.pid, "SIGKILL"); } catch { /* exited meanwhile */ } }
          result.state = await until(() => !matches(), options.killMs, options.pollMs, options.sleep) ? "killed" : "survived";
        }
        report.launchers.push(result);
      }
    }
    for (const role of /** @type {const} */ (["web", "runtimeHost"])) {
      const entry = recordedProcess(record?.[role]);
      if (!entry || probe.launcherIdentity(entry.pid) !== entry.startIdentity) continue;
      /* The pid and start identity match; the install socket in its own
         environment says it is this install's, which a pid alone never does. */
      if (typeof record.socket !== "string" || !record.socket || !probe.ownsInstall(entry.pid, entry.startIdentity, record.socket)) {
        report.services.push({ role, pid: entry.pid, state: "not-proven" });
        continue;
      }
      const identity = probe.identity(entry.pid);
      if (!identity) continue;
      const table = probe.table();
      const outcome = await terminate(captureTree({ pid: entry.pid, identity }, table, probe, ownChain(table)), probe, options);
      report.services.push({ role, pid: entry.pid, state: outcome.survivors.length ? "survived" : "stopped" });
    }
  }

  /* Read only now: a Viewer stopped above can no longer start a host this
     reading would miss. */
  const registry = await readRegistryEntries(input.stateDirectory);
  report.registry = registry.detail ? { state: registry.state, detail: registry.detail } : { state: registry.state };
  const targets = registryTargets(registry.entries);

  /* 2. Agent hosts, each proven by boot epoch, pid and start identity. The
     epoch comes first: from another pid namespace, every recorded pid reads
     as missing, which would count a running host as gone. */
  const table = probe.table();
  const chain = ownChain(table);
  const roots = [];
  for (const target of targets) {
    if (!target.startIdentity || !target.bootEpoch) {
      if (probe.identity(target.pid) === null) report.gone++;
      else report.notProven.push({ ...target, reason: "no-recorded-identity" });
      continue;
    }
    const verdict = epochVerdict(target.bootEpoch, bootEpoch);
    if (verdict === "earlier-boot") { report.gone++; continue; }
    if (verdict !== "this") { report.notProven.push({ ...target, reason: verdict }); continue; }
    /* Exited, or the kernel gave the pid to another process. */
    if (probe.identity(target.pid) !== target.startIdentity) { report.gone++; continue; }
    if (chain.has(target.pid)) { report.notProven.push({ ...target, reason: "own-process-chain" }); continue; }
    roots.push(target);
  }
  const claimed = new Set();
  const trees = roots.map((target) => {
    const members = captureTree({ pid: target.pid, identity: target.startIdentity }, table, probe, chain)
      .filter((member) => member.pid === target.pid || !claimed.has(member.pid));
    for (const member of members) claimed.add(member.pid);
    return { target, members };
  });
  const outcome = await terminate(trees.flatMap(({ members }) => members), probe, options);
  const survivors = new Set(outcome.survivors.map((member) => member.pid));
  for (const { target, members } of trees) {
    const entry = { pid: target.pid, kind: target.kind, session: target.session, under: members.length - 1 };
    if (members.some((member) => survivors.has(member.pid))) report.survived.push(entry);
    else report.stopped.push(entry);
  }
  return report;
}

/** Whether everything proven to be Delegatus's is gone and every record was
    read and checked. A host recorded without an identity (a tmux agent) or
    running this command fails nothing; a record this command could not check
    from where it runs does.
    @param {StopReport} report */
export function stopSucceeded(report) {
  return report.supported
    && report.launchers.every((launcher) => ["stopped", "killed", "earlier-boot"].includes(launcher.state))
    && report.services.every((service) => service.state === "stopped")
    && report.registry.state !== "unreadable"
    && report.notProven.every((entry) => entry.reason !== "unverifiable" && entry.reason !== "other-pid-namespace")
    && report.survived.length === 0;
}

const TEXT = {
  en: {
    title: "Delegatus stop --all",
    unsupported: (platform) => `Stopping agent hosts is not supported on ${platform}: there is no way here to prove a process is the one Delegatus recorded, so nothing was stopped. Stop Delegatus with Ctrl-C in its terminal; the recorded agent hosts are listed below.`,
    launcher: { stopped: (pid) => `Stopped the launcher (pid ${pid}), and with it the Viewer and the runtime host it started.`,
      killed: (pid) => `The launcher (pid ${pid}) did not stop in time and was killed.`,
      survived: (pid) => `The launcher (pid ${pid}) is still running after SIGKILL.`,
      unreadable: (_pid, detail) => `A launcher record could not be read (${detail}); no Viewer or runtime host was stopped by it.`,
      "earlier-boot": (_pid, detail) => `The launcher record ${detail} was written before this computer last started; nothing was stopped by it.`,
      "not-proven": (pid, detail, reason) => `Left the launcher${pid ? ` (pid ${pid})` : ""} of ${detail} and what it started alone: ${reason === "other-pid-namespace"
        ? "it was recorded in another process namespace, so its pids cannot be checked from here" : "the boot it was recorded in cannot be read here"}.` },
    noLauncher: "No running launcher is recorded.",
    service: { web: "Viewer", runtimeHost: "runtime host" },
    serviceStopped: (name, pid) => `Stopped the ${name} (pid ${pid}) that the launcher left running.`,
    serviceSurvived: (name, pid) => `The ${name} (pid ${pid}) is still running.`,
    serviceNotProven: (name, pid) => `Left the ${name} (pid ${pid}) running: it does not carry this install's runtime-host socket, so it is not proven to be Delegatus's.`,
    registryMissing: "No agent registry: no agent host is recorded.",
    registryUnreadable: (detail) => `The agent registry could not be read (${detail}); no agent host was stopped.`,
    stopped: "Stopped agent hosts:",
    none: "No recorded agent host was running.",
    host: (entry) => `  ${entry.kind} pid ${entry.pid}${entry.session ? ` (${entry.session})` : ""}${entry.under ? `, and ${entry.under} process${entry.under === 1 ? "" : "es"} under it` : ""}`,
    survived: "Still running after SIGKILL:",
    gone: (count) => `${count} recorded process${count === 1 ? " was" : "es were"} already gone.`,
    notProven: "Left running, not proven to be Delegatus's:",
    reason: { "no-recorded-identity": "recorded without a start identity", unverifiable: "its identity cannot be read here",
      "other-pid-namespace": "recorded in another process namespace, so it cannot be checked from here",
      "own-process-chain": "it runs this command", "unsupported-platform": "not checked on this platform" },
  },
  uk: {
    title: "Delegatus stop --all",
    unsupported: (platform) => `На ${platform} зупинка хостів агентів не підтримується: тут не можна довести, що процес той самий, який записав Delegatus, тож нічого не зупинено. Зупиніть Delegatus через Ctrl-C у його терміналі; записані хости агентів перелічено нижче.`,
    launcher: { stopped: (pid) => `Зупинено лаунчер (pid ${pid}), а з ним Viewer і runtime host, які він запустив.`,
      killed: (pid) => `Лаунчер (pid ${pid}) не зупинився вчасно, його вбито.`,
      survived: (pid) => `Лаунчер (pid ${pid}) працює навіть після SIGKILL.`,
      unreadable: (_pid, detail) => `Не вдалося прочитати запис лаунчера (${detail}); Viewer і runtime host за ним не зупинено.`,
      "earlier-boot": (_pid, detail) => `Запис лаунчера ${detail} зроблено до останнього запуску комп'ютера; за ним нічого не зупинено.`,
      "not-proven": (pid, detail, reason) => `Лаунчер${pid ? ` (pid ${pid})` : ""} із ${detail} і те, що він запустив, не зупинено: ${reason === "other-pid-namespace"
        ? "його записано в іншому просторі імен процесів, тож звідси його pid не перевірити" : "тут не можна прочитати, в якому запуску системи його записано"}.` },
    noLauncher: "Запущеного лаунчера не записано.",
    service: { web: "Viewer", runtimeHost: "runtime host" },
    serviceStopped: (name, pid) => `Зупинено ${name} (pid ${pid}), який лишив лаунчер.`,
    serviceSurvived: (name, pid) => `${name} (pid ${pid}) досі працює.`,
    serviceNotProven: (name, pid) => `${name} (pid ${pid}) не зупинено: у ньому немає сокета runtime host цієї інсталяції, тож не доведено, що це Delegatus.`,
    registryMissing: "Реєстру агентів немає: жодного хоста агента не записано.",
    registryUnreadable: (detail) => `Не вдалося прочитати реєстр агентів (${detail}); жодного хоста агента не зупинено.`,
    stopped: "Зупинено хости агентів:",
    none: "Жоден записаний хост агента не працював.",
    host: (entry) => `  ${entry.kind} pid ${entry.pid}${entry.session ? ` (${entry.session})` : ""}${entry.under ? `, і процесів під ним: ${entry.under}` : ""}`,
    survived: "Досі працюють після SIGKILL:",
    gone: (count) => `Уже не працювали записаних процесів: ${count}.`,
    notProven: "Лишилися працювати, бо не доведено, що вони Delegatus:",
    reason: { "no-recorded-identity": "записаний без ідентичності запуску", unverifiable: "тут не можна прочитати його ідентичність",
      "other-pid-namespace": "записаний в іншому просторі імен процесів, тож звідси його не перевірити",
      "own-process-chain": "він виконує цю команду", "unsupported-platform": "на цій платформі не перевірявся" },
  },
};

/** The report as the person who asked reads it.
    @param {StopReport} report @param {string} [lang] */
export function formatStopReport(report, lang = "en") {
  const text = TEXT[lang] ?? TEXT.en;
  const lines = [text.title];
  if (!report.supported) lines.push(text.unsupported(report.platform));
  else if (!report.launchers.length) lines.push(text.noLauncher);
  for (const launcher of report.launchers) lines.push(text.launcher[launcher.state](launcher.pid, launcher.detail, launcher.reason));
  for (const service of report.services) {
    const name = text.service[service.role];
    lines.push(service.state === "stopped" ? text.serviceStopped(name, service.pid)
      : service.state === "not-proven" ? text.serviceNotProven(name, service.pid) : text.serviceSurvived(name, service.pid));
  }
  if (report.registry.state === "missing") lines.push(text.registryMissing);
  else if (report.registry.state === "unreadable") lines.push(text.registryUnreadable(report.registry.detail));
  else if (report.supported) {
    if (report.stopped.length) lines.push(text.stopped, ...report.stopped.map(text.host));
    else if (!report.survived.length) lines.push(text.none);
  }
  if (report.survived.length) lines.push(text.survived, ...report.survived.map(text.host));
  if (report.gone) lines.push(text.gone(report.gone));
  if (report.notProven.length) {
    lines.push(text.notProven, ...report.notProven.map((entry) => `${text.host({ ...entry, under: 0 })}: ${text.reason[entry.reason]}`));
  }
  return lines.join("\n");
}

/**
 * `delegatus stop --all`. Returns the exit status.
 * @param {string[]} args
 * @param {{ stateDirectory: string, lang?: "en" | "uk", write?: (text: string) => void }} context
 */
export async function runStopCommand(args, context) {
  const write = context.write ?? ((text) => process.stdout.write(`${text}\n`));
  if (args.length !== 1 || args[0] !== "--all") {
    write(context.lang === "uk"
      ? "Використання: delegatus stop --all\n  Зупиняє Viewer, runtime host і кожен хост агента, який записав Delegatus."
      : "Usage: delegatus stop --all\n  Stops the Viewer, the runtime host and every agent host Delegatus recorded starting.");
    return 2;
  }
  const report = await stopEverything({ stateDirectory: context.stateDirectory });
  write(formatStopReport(report, context.lang));
  return stopSucceeded(report) ? 0 : 1;
}

/* Started by the app menu (src/lib/stopAll.ts), which names the state
   directory the Viewer runs on. */
if (import.meta.main) {
  const value = (flag) => { const index = process.argv.indexOf(flag); return index > 0 ? process.argv[index + 1] ?? null : null; };
  const stateDirectory = value("--state-dir");
  if (!stateDirectory) {
    console.error("stop-all: --state-dir is required");
    process.exit(2);
  }
  const lang = value("--lang") === "uk" ? "uk" : "en";
  process.exitCode = await runStopCommand(["--all"], { stateDirectory, lang });
}
