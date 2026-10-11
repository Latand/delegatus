import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workAggregateCpuQuota as productQuota } from "../src/lib/runtime/cpuPlacement";
import { activationSteps, cpuPlacementFiles, installCpuPlacement, workAggregateCpuQuota } from "./install-cpu-placement.mjs";

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
