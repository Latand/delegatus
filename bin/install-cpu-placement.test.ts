import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workAggregateCpuQuota as productQuota } from "../src/lib/runtime/cpuPlacement";
import { activationSteps, cpuPlacementFiles, installCpuPlacement, validMemoryHigh, workAggregateCpuQuota } from "./install-cpu-placement.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const sandbox = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cpu-install-")); roots.push(root); return root; };

test("the files put production and the agents branch under one parent and cap the work slice", () => {
  for (const cpus of [1, 6, 24, 64]) expect(workAggregateCpuQuota(cpus)).toBe(productQuota(cpus));
  expect(cpuPlacementFiles({ cpus: 24 })).toEqual([
    { path: "delegatus.service.d/cpu.conf", text: "[Service]\nSlice=delegatus.slice\nCPUAccounting=yes\nCPUWeight=1000\n" },
    { path: "delegatus-agents.slice.d/cpu.conf", text: "[Slice]\nCPUAccounting=yes\nCPUWeight=100\n" },
    { path: "delegatus-agents-work.slice", text: "[Unit]\nDescription=Delegatus test and pipeline workloads\n\n[Slice]\nCPUAccounting=yes\nCPUWeight=100\nCPUQuota=1800%\nCPUQuotaPeriodSec=20ms\n" },
  ]);
});

test("installing writes into the given directory, keeps a different file unless forced, and is idempotent", () => {
  const dir = sandbox();
  expect(installCpuPlacement({ dir, unit: "viewer.service", cpus: 8 }).map((result) => result.outcome)).toEqual(["written", "written", "written"]);
  expect(fs.readFileSync(path.join(dir, "viewer.service.d/cpu.conf"), "utf8")).toContain("Slice=delegatus.slice");
  expect(installCpuPlacement({ dir, unit: "viewer.service", cpus: 8 }).map((result) => result.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
  fs.writeFileSync(path.join(dir, "delegatus-agents-work.slice"), "[Slice]\nCPUQuota=400%\n");
  expect(installCpuPlacement({ dir, unit: "viewer.service", cpus: 8 })[2]!.outcome).toBe("kept");
  expect(fs.readFileSync(path.join(dir, "delegatus-agents-work.slice"), "utf8")).toBe("[Slice]\nCPUQuota=400%\n");
  expect(installCpuPlacement({ dir, unit: "viewer.service", cpus: 8, force: true })[2]!.outcome).toBe("replaced");
  expect(fs.readFileSync(path.join(dir, "delegatus-agents-work.slice"), "utf8")).toContain("CPUQuota=600%");
});

test.skipIf(process.platform !== "linux")("the command writes under XDG_CONFIG_HOME and only prints the activation steps", () => {
  const config = sandbox();
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, "install-cpu-placement.mjs")], { encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: sandbox(), XDG_CONFIG_HOME: config } });
  expect(result.status).toBe(0);
  expect(fs.existsSync(path.join(config, "systemd/user/delegatus.service.d/cpu.conf"))).toBe(true);
  expect(result.stdout).toContain("Nothing is active yet. To apply:\nsystemctl --user daemon-reload");
  const refused = spawnSync(process.execPath, [path.join(import.meta.dir, "install-cpu-placement.mjs"), "--unit", "x; rm -rf /"], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, XDG_CONFIG_HOME: config } });
  expect(refused.status).toBe(2);
});

// The service cgroup holds agent pipe relays, so a memory ceiling is written
// only when the operator names one, and only the soft limit.
test.skipIf(process.platform !== "linux")("a memory ceiling is written only when asked for, replaces its own file alone, and is never hard", () => {
  const dir = sandbox();
  const command = (...args: string[]) => spawnSync(process.execPath, [path.join(import.meta.dir, "install-cpu-placement.mjs"), "--dir", dir, ...args],
    { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: sandbox() } });
  const file = path.join(dir, "delegatus.service.d/memory.conf");
  const plain = command();
  expect(plain.status).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
  expect(plain.stdout).not.toContain("Memory");
  expect(command("--memory-high", "48G").status).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe("[Service]\nMemoryAccounting=yes\nMemoryHigh=48G\n");
  // A CPU file the operator edited survives a change of the ceiling.
  const edited = path.join(dir, "delegatus-agents-work.slice");
  fs.writeFileSync(edited, "[Slice]\nCPUQuota=400%\n");
  const changed = command("--memory-high", "infinity");
  expect(changed.status).toBe(0);
  expect(changed.stdout).toContain(`replaced  ${file}`);
  expect(fs.readFileSync(file, "utf8")).toBe("[Service]\nMemoryAccounting=yes\nMemoryHigh=infinity\n");
  expect(fs.readFileSync(edited, "utf8")).toBe("[Slice]\nCPUQuota=400%\n");
  // A later run for the CPU files alone leaves the ceiling as it is.
  expect(command().status).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe("[Service]\nMemoryAccounting=yes\nMemoryHigh=infinity\n");
  for (const written of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (written.isFile()) expect(fs.readFileSync(path.join(written.parentPath, written.name), "utf8")).not.toContain("MemoryMax");
  }
  for (const refused of ["0", "150%", "0%", "512M", "lots\nMemoryMax=1G"]) {
    expect(command("--memory-high", refused).status).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe("[Service]\nMemoryAccounting=yes\nMemoryHigh=infinity\n");
  }
  expect(command("--memory-high").status).toBe(2);
});

test("a memory ceiling is a value the service can run under", () => {
  const total = 128 * 1024 ** 3;
  for (const value of ["infinity", "48G", "1G", "1024M", "1073741824", "1%", "50%", "100%", "37.5%"]) expect(validMemoryHigh(value, total)).toBe(true);
  for (const value of ["0", "0G", "1%0", "0%", "0.5%", "101%", "150%", "512M", "1073741823", "1.5G", "max", "", "48 G", "-1G"]) expect(validMemoryHigh(value, total)).toBe(false);
  // One percent of a small machine is below the floor.
  expect(validMemoryHigh("1%", 8 * 1024 ** 3)).toBe(false);
  expect(validMemoryHigh("50%", 8 * 1024 ** 3)).toBe(true);
});

// A restart left the service in its old cgroup while a spared process held it
// (2026-10-11); the printed steps stop, wait for the path to be released and
// start through exit cleanup, against a stand-in systemctl.
test.skipIf(process.platform !== "linux")("the printed move stops, waits for the old cgroup and always starts", () => {
  const steps = activationSteps("viewer.service");
  expect(steps.some((step) => /systemctl --user restart/.test(step))).toBe(false);
  const move = steps.find((step) => step.startsWith("( trap"))!;
  for (const releasedAfter of [2, 1000]) {
    const bin = sandbox();
    const calls = path.join(bin, "calls");
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$2" = show ]; then
  shows=$(grep -c show "${calls}")
  [ "$shows" -lt ${releasedAfter} ] && echo /app.slice/viewer.service
fi
exit 0
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync("sh", ["-e", "-c", move], { encoding: "utf8", env: { NODE_ENV: "test", PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status).toBe(0);
    const lines = fs.readFileSync(calls, "utf8").trim().split("\n");
    expect(lines[0]).toBe("--user stop viewer.service");
    expect(lines.at(-1)).toBe("--user start viewer.service");
    expect(lines.filter((line) => line.includes(" show ")).length).toBe(releasedAfter === 2 ? 2 : 60);
  }
});

test.skipIf(process.platform !== "linux")("activation cleanup starts after stop or wait errors and termination under errexit", () => {
  const move = activationSteps("viewer.service").find((step) => step.startsWith("( trap"))!;
  for (const shell of ["sh", "bash"]) {
    for (const failure of ["stop", "show", "sleep", "HUP", "INT", "TERM"]) {
      const bin = sandbox();
      const calls = path.join(bin, "calls");
      fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$2" = "${failure}" ]; then exit 1; fi
if [ "$2" = show ]; then echo /app.slice/viewer.service; fi
exit 0
`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "sleep"), `#!/bin/sh
${failure === "sleep" ? "exit 1" : `kill -${failure} "$PPID"`}
`, { mode: 0o755 });
      const result = spawnSync(shell, ["-e", "-c", move], { encoding: "utf8",
        env: { NODE_ENV: "test", PATH: `${bin}:${process.env.PATH}` } });
      expect(result.status).toBe(failure === "HUP" ? 129 : failure === "INT" ? 130 : failure === "TERM" ? 143 : 1);
      const lines = fs.readFileSync(calls, "utf8").trim().split("\n");
      expect(lines[0]).toBe("--user stop viewer.service");
      expect(lines.at(-1)).toBe("--user start viewer.service");
      expect(lines.filter((line) => line.includes(" start ")).length).toBe(1);
    }
  }
});
