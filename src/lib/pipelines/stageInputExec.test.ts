import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStageInputExec } from "./stageInputExec";
import { protectExistingControllerArtifacts } from "./controllerArtifacts";
import { realExec } from "@/lib/workflows/provision";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-input-exec-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function repository(name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", repo], { encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr || initialized.stdout);
  return repo;
}

test("stage input cancellation stops owned children and the shared deadline prevents index-write replay", async () => {
  const runOwnedGitChild = async (cancelBy: "deadline" | "activation") => {
    const repo = repository(`owned-child-${cancelBy}`);
    const readyFile = path.join(repo, "child-ready");
    const program = `
      import fs from "node:fs";
      import { createStageInputExec } from "./src/lib/pipelines/stageInputExec.ts";
      import { realExec } from "./src/lib/workflows/provision.ts";
      const deadline = new AbortController();
      const activation = new AbortController();
      const wrapped = createStageInputExec(realExec, activation.signal, () => {}, new Error("activation superseded"));
      const result = wrapped("git", ["-c", ${JSON.stringify(`alias.wait=!touch ${readyFile}; exec sleep 30`)}, "wait"], ${JSON.stringify(repo)}, undefined, {
        timeoutMs: 3_000,
        signal: deadline.signal,
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        const watcher = fs.watch(${JSON.stringify(repo)}, () => {
          if (!settled && fs.existsSync(${JSON.stringify(readyFile)})) {
            settled = true;
            watcher.close();
            resolve(undefined);
          }
        });
        watcher.on("error", reject);
        if (fs.existsSync(${JSON.stringify(readyFile)})) {
          settled = true;
          watcher.close();
          resolve(undefined);
        }
      });
      ( ${JSON.stringify(cancelBy)} === "deadline" ? deadline : activation).abort();
      const cancelled = await result;
      process.stdout.write(JSON.stringify({ code: cancelled.code, stderr: cancelled.stderr }));
    `;
    const child = spawnSync(process.execPath, ["--eval", program], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ code: null, stderr: "command cancelled" });
  };

  await runOwnedGitChild("deadline");
  await runOwnedGitChild("activation");

  const repo = repository("deadline-index");
  const activation = new AbortController();
  let elapsed = 0;
  const calls: string[][] = [];
  const executor = createStageInputExec(async (_command, args, _cwd, _env, options) => {
    calls.push(args);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    elapsed = 30_000;
    return { code: null, signal: "SIGTERM", stdout: "", stderr: "command cancelled" };
  }, activation.signal, () => {}, new Error("activation superseded"));
  await expect(protectExistingControllerArtifacts(repo, executor, {
    now: () => elapsed,
    sleep: async () => { throw new Error("deadline must prevent a retry"); },
  })).rejects.toThrow("30000ms inspection deadline exceeded");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("rev-parse");
  expect(calls.some(args => args[0] === "reset" || args[0] === "rm")).toBe(false);
});

test("activation cancellation still refuses stage input work before dispatch", async () => {
  const activation = new AbortController();
  activation.abort();
  let dispatched = false;
  const wrapped = createStageInputExec(async () => {
    dispatched = true;
    return { code: 0, stdout: "", stderr: "" };
  }, activation.signal, () => {}, new Error("activation superseded"));

  await expect(wrapped("git", ["status"], root)).rejects.toThrow("activation superseded");
  expect(dispatched).toBe(false);
});
