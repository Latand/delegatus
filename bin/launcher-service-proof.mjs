/* The one rule that says a user unit is this install's service. The Viewer
   asks it before it offers a restart and again before it hands the unit to the
   service manager (src/lib/selfUpdate/actions.ts), and the recovery helper asks
   it before it restarts a unit from a plan (launcher-relaunch.mjs).

   A cgroup names the unit a launcher runs inside, and that unit can be a
   terminal multiplexer, a terminal emulator or a desktop session's autostart
   scope. Restarting it would end everything else in it and bring no launcher
   back. So the proof comes from what the service manager really runs:

   - the command it starts the unit with names this install's `bin/cli.mjs`.
     `systemctl show` prints that command with every specifier expanded, so a
     unit written with `%h` reads the same as one written with a full path; an
     argument relative to the unit's working directory is resolved against it;
   - or the unit's main process is the recorded launcher, or the bootstrap that
     started it: after the first self-update the entry the unit starts hands
     off to the selected release and stays as its parent. A parent counts only
     when the script it runs is this install's `bin/cli.mjs`, because a
     terminal emulator is the main process of its unit and the parent of
     whatever was typed into it. */
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const SERVICE_UNIT = /^[A-Za-z0-9_.@\\x-]+\.service$/;

/** What the service manager shows for a unit, or null when it does not answer. */
export function shownUnit(unit) {
  const shown = spawnSync("systemctl", ["--user", "show", "--property=ExecStart", "--property=WorkingDirectory", "--property=MainPID", unit],
    { encoding: "utf8", timeout: 5_000 });
  return shown.status === 0 ? shown.stdout : null;
}
function read(file) { try { return readFileSync(file, "utf8"); } catch { return ""; } }
const processPorts = {
  show: shownUnit,
  parent: pid => { const parent = Number(/^PPid:\s*(\d+)/m.exec(read(`/proc/${pid}/status`))?.[1]); return parent > 0 ? parent : null; },
  argv: pid => read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean),
  cwd: pid => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } },
};

/** `launcherPid` is the recorded launcher of a running install. A start has
    none, and then only the command the unit starts proves it. */
export function unitRunsLauncher(unit, root, launcherPid, ports = {}) {
  if (typeof unit !== "string" || !SERVICE_UNIT.test(unit) || typeof root !== "string") return false;
  const { show, parent, argv, cwd } = { ...processPorts, ...ports };
  const shown = show(unit);
  if (typeof shown !== "string") return false;
  const entry = join(root, "bin", "cli.mjs");
  const lines = shown.split("\n");
  const directory = lines.find(line => line.startsWith("WorkingDirectory="))?.slice("WorkingDirectory=".length).replace(/^[-!]+/, "") ?? "";
  for (const line of lines) {
    const command = line.startsWith("ExecStart=") ? /argv\[\]=(.*?) ; ignore_errors=/.exec(line)?.[1] : undefined;
    if (command === undefined) continue;
    // Arguments are printed joined by spaces: a root with a space in it is
    // found as a whole, a relative argument word by word.
    if (` ${command} `.includes(` ${entry} `)) return true;
    if (directory.startsWith("/") && command.split(" ").some(word => word && resolve(directory, word) === entry)) return true;
  }
  const main = Number(lines.find(line => line.startsWith("MainPID="))?.slice("MainPID=".length));
  if (!Number.isInteger(launcherPid) || launcherPid <= 0 || !Number.isInteger(main) || main <= 0) return false;
  if (main === launcherPid) return true;
  if (main !== parent(launcherPid)) return false;
  const script = argv(main).slice(1).find(word => !word.startsWith("-"));
  return script !== undefined && resolve(cwd(main) ?? "/", script) === entry;
}
