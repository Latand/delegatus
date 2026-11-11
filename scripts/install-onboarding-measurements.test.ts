import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const document = readFileSync(new URL("../docs/design/install-and-onboarding-measurements.md", import.meta.url), "utf8");

test("documented lifecycle-backed measurement commands provide unique run ids", () => {
  const commands = [...document.matchAll(/^.*python3 "\$MEASURE\/(?:lifecycle|update|codex-start)\.py".*$/gm)]
    .map(([command]) => command);
  const runIds = commands.map((command) => command.match(/MEASUREMENT_RUN_ID=([a-z0-9-]+)/)?.[1]);
  const driverCounts = Object.fromEntries(
    ["lifecycle.py", "update.py", "codex-start.py"].map((driver) => [
      driver,
      commands.filter((command) => command.includes(`$MEASURE/${driver}`)).length,
    ]),
  );

  expect(commands).toHaveLength(6);
  expect(runIds.every(Boolean)).toBe(true);
  expect(new Set(runIds).size).toBe(commands.length);
  expect(driverCounts).toEqual({ "lifecycle.py": 4, "update.py": 1, "codex-start.py": 1 });
});
