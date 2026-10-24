import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { gateServiceProperties, OPERATOR_CPU_WEIGHT } from "../src/lib/runtime/cpuPlacement";

const manager = process.platform === "linux" && Bun.which("systemd-run") && Bun.which("systemctl")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status === 0;

for (const placement of [false, true]) {
  test.skipIf(!manager)(`user manager applies the produced gate weights with CPU placement ${placement ? "on" : "off"}`, () => {
    const unit = `delegatus-gate-properties-${process.pid}-${placement ? "quota" : "default"}.service`;
    const properties = gateServiceProperties(placement ? { LLV_OWNED_RUN_CPU_SLICE: "app.slice", LLV_OWNED_RUN_CPU_QUOTA: "300" } : {});
    try {
      const result = spawnSync("systemd-run", ["--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`, ...properties, "--",
        "/bin/sh", "-c", 'systemctl --user show "$1" -p CPUWeight -p IOWeight -p CPUQuotaPerSecUSec; exit "$2"', "gate-properties", unit, placement ? "37" : "0"],
      { encoding: "utf8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(placement ? 37 : 0);
      expect(result.stdout).toContain("CPUWeight=10\n");
      expect(result.stdout).toContain("IOWeight=10\n");
      expect(OPERATOR_CPU_WEIGHT).toBeGreaterThan(10);
      if (placement) expect(result.stdout).toContain("CPUQuotaPerSecUSec=3s");
    } finally {
      spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 5_000 });
    }
  });
}
