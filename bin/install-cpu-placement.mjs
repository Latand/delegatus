#!/usr/bin/env node
/*
 * Writes the systemd user-manager files that give production CPU priority over
 * agent work (docs/design/cpu-placement.md). It writes files only: it never
 * reloads the manager, restarts the service or moves a running process. The
 * printed steps apply them when the operator chooses a quiet moment.
 *
 *   node bin/install-cpu-placement.mjs [--unit delegatus.service] [--dir DIR] [--force]
 *
 * DIR defaults to ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user. An existing
 * file with other content is left alone unless --force is given.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Matches workAggregateCpuQuota in src/lib/runtime/cpuPlacement.ts. */
export function workAggregateCpuQuota(cpus) {
  return Math.max(100, Math.floor(Math.max(1, cpus) * 0.75) * 100);
}

/** Matches onlineCpuCount: the machine's online CPUs, whatever this process's affinity. */
export function onlineCpuCount() {
  return os.cpus().length || os.availableParallelism();
}

export function cpuPlacementFiles({ unit = "delegatus.service", cpus = onlineCpuCount() } = {}) {
  return [
    { path: `${unit}.d/cpu.conf`, text: "[Service]\nSlice=delegatus.slice\nCPUAccounting=yes\nCPUWeight=1000\n" },
    { path: "delegatus-agents.slice.d/cpu.conf", text: "[Slice]\nCPUAccounting=yes\nCPUWeight=100\n" },
    { path: "delegatus-agents-work.slice", text: `[Unit]\nDescription=Delegatus test and pipeline workloads\n\n[Slice]\nCPUAccounting=yes\nCPUWeight=100\nCPUQuota=${workAggregateCpuQuota(cpus)}%\nCPUQuotaPeriodSec=20ms\n` },
  ];
}

export function activationSteps(unit = "delegatus.service") {
  return [
    "systemctl --user daemon-reload",
    "# Moving the service into delegatus.slice takes a restart; run it at a quiet moment, after hosted agents finish:",
    `systemctl --user restart '${unit}'`,
    `systemctl --user show '${unit}' -p Slice -p CPUWeight`,
    "systemctl --user show delegatus-agents-work.slice -p CPUWeight -p CPUQuotaPerSecUSec -p CPUQuotaPeriodUSec",
  ];
}

export function installCpuPlacement({ dir, unit = "delegatus.service", cpus, force = false }) {
  const results = [];
  for (const file of cpuPlacementFiles({ unit, cpus })) {
    const target = path.join(dir, file.path);
    let existing = null;
    try { existing = fs.readFileSync(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing === file.text) { results.push({ path: target, outcome: "unchanged" }); continue; }
    if (existing !== null && !force) { results.push({ path: target, outcome: "kept" }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, file.text, { mode: 0o644 });
    fs.renameSync(`${target}.tmp`, target);
    results.push({ path: target, outcome: existing === null ? "written" : "replaced" });
  }
  return results;
}

function main(argv) {
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write("usage: install-cpu-placement.mjs [--unit delegatus.service] [--dir DIR] [--force]\n");
    return 0;
  }
  if (process.platform !== "linux") { process.stderr.write("CPU placement files are for a Linux systemd user manager.\n"); return 2; }
  const unit = option("--unit") ?? "delegatus.service";
  if (!/^[\w:@.-]+\.service$/.test(unit)) { process.stderr.write(`not a service unit name: ${unit}\n`); return 2; }
  const dir = option("--dir") ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
  const results = installCpuPlacement({ dir, unit, force: argv.includes("--force") });
  for (const result of results) process.stdout.write(`${result.outcome.padEnd(9)} ${result.path}\n`);
  if (results.some((result) => result.outcome === "kept")) process.stdout.write("A kept file differs from this release's; compare it, then rerun with --force to replace it.\n");
  process.stdout.write(`\nNothing is active yet. To apply:\n${activationSteps(unit).join("\n")}\n`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
