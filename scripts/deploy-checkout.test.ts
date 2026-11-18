import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("checkout switch, sample deadline, census and isolated ownership contracts", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./deploy_checkout_test.py", import.meta.url))], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", CENSUS_TEST_BUN: process.execPath },
    encoding: "utf8",
    timeout: 90_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain("OK");
  console.log(result.stderr.trim());
}, 95_000);
