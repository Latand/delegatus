import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("packaged Telegram read admission and restart regressions (offline Python)", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./telegram_mcp_server_test.py", import.meta.url))], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).toContain("OK");
  expect(result.status).toBe(0);
}, 15_000);
