import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workAggregateCpuQuota as productQuota } from "../src/lib/runtime/cpuPlacement";
import { cpuPlacementFiles, installCpuPlacement, workAggregateCpuQuota } from "./install-cpu-placement.mjs";

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
