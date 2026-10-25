import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gateServiceProperties, OPERATOR_CPU_WEIGHT } from "../src/lib/runtime/cpuPlacement";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";

const manager = process.platform === "linux" && Bun.which("systemd-run") && Bun.which("systemctl")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status === 0;

for (const placement of [false, true]) {
  test.skipIf(!manager)(`user manager applies the produced gate weights with CPU placement ${placement ? "on" : "off"}`, () => {
    // Local PIDs can coincide across stage namespaces. The kernel-bound host
    // identity gives this run its own unit without a name-based cleanup stop.
    const owner = createHash("sha256").update(JSON.stringify(cpuOwnerIdentity(process.pid))).digest("hex").slice(0, 24);
    const unit = `delegatus-gate-properties-${owner}-${placement ? "quota" : "default"}.service`;
    const properties = gateServiceProperties(placement ? { LLV_OWNED_RUN_CPU_SLICE: "app.slice", LLV_OWNED_RUN_CPU_QUOTA: "300" } : {});
    const result = spawnSync("systemd-run", ["--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
      "-p", "RuntimeMaxSec=5s", "-p", "TimeoutStopSec=1s", ...properties, "--",
      "/bin/sh", "-c", 'systemctl --user show "$1" -p CPUWeight -p IOWeight -p CPUQuotaPerSecUSec; exit "$2"', "gate-properties", unit, placement ? "37" : "0"],
      { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(placement ? 37 : 0);
    expect(result.stdout).toContain("CPUWeight=10\n");
    expect(result.stdout).toContain("IOWeight=10\n");
    expect(OPERATOR_CPU_WEIGHT).toBeGreaterThan(10);
    if (placement) expect(result.stdout).toContain("CPUQuotaPerSecUSec=3s");
  });
}
