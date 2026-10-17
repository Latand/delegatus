import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("task export privacy, byte identity, cache and worker failure contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-export-suite-"));
  try {
    for (const name of ["home", "config", "tmp", "state"]) fs.mkdirSync(path.join(root, name));
    const result = spawnSync(process.execPath, ["test", "./src/lib/links/fixtures/taskExport.cases.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
        TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: path.join(root, "state"),
        LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_CONTROL_URL: "http://127.0.0.1:1" },
    });
    if (result.stderr) process.stderr.write(result.stderr);
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 100_000);
