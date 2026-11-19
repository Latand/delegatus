import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

async function startupProcess(directory: string, engine: string, mode: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "idleHostStartup.ts"), directory, engine, mode], {
    env: { ...process.env, LLV_STATE_DIR: path.join(directory, "state") }, stdout: "pipe", stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`startup fixture failed (${code}): ${stderr}`);
    return JSON.parse(stdout);
  } finally { if (child.exitCode === null) child.kill(); }
}

for (const engine of ["codex", "claude", "copilot"] as const) test(`a new process leaves idle ${engine} hosts unadopted and selects owed work`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-idle-"));
  try {
    expect(await startupProcess(directory, engine, "seed")).toEqual({ seeded: true });
    expect(await startupProcess(directory, engine, "observe")).toEqual({
      idleSelected: false, owedSelected: true, pendingWork: true, retainedStart: "retained-native-start",
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
