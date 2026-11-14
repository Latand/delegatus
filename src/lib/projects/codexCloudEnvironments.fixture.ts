import { expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stubCloudBackend } from "@/lib/pipelines/cloudEnvironment.fixture";
import { prepareCloudEnvironment } from "./codexCloudEnvironments";

/** Each test file owns its provider listeners, state roots and restoration. */
export function cloudEnvironmentTestContext() {
  const roots: string[] = [], stops: (() => void)[] = [];
  const previous = process.env.LLV_STATE_DIR;
  function fixture(options: Parameters<typeof stubCloudBackend>[0] = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-binding-")); roots.push(root); process.env.LLV_STATE_DIR = root;
    const backend = stubCloudBackend(options); stops.push(backend.stop);
    let clock = Date.UTC(2026, 9, 28);
    const input = { project: "repo-fixture", account: { engine: "codex" as const, accountId: "account-a", kind: "managed" as const, home: root, transcriptRoot: root, env: { NODE_ENV: "test" as const } },
      repository: "sample/project", ref: "main", signal: new AbortController().signal, assertCurrent: () => {}, now: () => clock };
    return { backend, input, advance: (ms: number) => { clock += ms; }, prepare: () => prepareCloudEnvironment(input, backend.dependencies) };
  }

  async function restart(f: ReturnType<typeof fixture>, action = "no-crash", project = f.input.project, revision = 0) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "cloudEnvironmentRestart.fixture.ts"), f.backend.url, action,
      String(f.input.now()), project, String(revision)], { env: { ...process.env, HOME: f.input.account.home, LLV_STATE_DIR: process.env.LLV_STATE_DIR!,
        LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout);
  }

  function cleanup() {
    for (const stop of stops.splice(0)) stop();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    process.env.LLV_STATE_DIR = previous;
  }
  return { fixture, restart, cleanup };
}
