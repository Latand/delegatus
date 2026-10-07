import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("checkout switch regressions and isolated adapter contracts", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./deploy_checkout_test.py", import.meta.url))], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).toContain("OK");
  expect(result.status).toBe(0);
});
