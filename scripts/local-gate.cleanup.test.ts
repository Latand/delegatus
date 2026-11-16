import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { runSteps } from "./local-gate";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test.each([0, 1])("a prepared step releases its owned export before advancing after exit %s", async code => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "step-export-")); roots.push(root);
  const tree = path.join(root, "export"); fs.mkdirSync(tree);
  const calls: string[] = [];
  const steps = [{ name: "build", command: [] }, { name: "next", command: [] }];
  const run = runSteps("pre-push", steps, { root, deadline: null, logDir: root, say: () => {},
    prepare: step => {
      calls.push(step.name);
      if (step.name === "next") expect(fs.existsSync(tree)).toBeFalse();
      return { command: [process.execPath, "-e", `process.exitCode = ${step.name === "build" ? code : 0}`], env: process.env,
        ...(step.name === "build" ? { cleanup: () => { calls.push("release"); fs.rmSync(tree, { recursive: true }); } } : {}) };
    } });
  if (code) await expect(run).rejects.toThrow("failed (1)"); else await run;
  expect(calls).toEqual(code ? ["build", "release"] : ["build", "release", "next"]);
  expect(fs.existsSync(tree)).toBeFalse();
});

test("an export cleanup refusal fails the step and stops the next consumer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "step-refusal-")); roots.push(root);
  const calls: string[] = [];
  await expect(runSteps("pre-push", [{ name: "build", command: [] }, { name: "next", command: [] }], {
    root, deadline: null, logDir: root, say: () => {}, prepare: step => {
      calls.push(step.name);
      return { command: [process.execPath, "-e", "process.exitCode = 0"], env: process.env,
        cleanup: () => { throw new Error("fixture cleanup refusal"); } };
    },
  })).rejects.toThrow("fixture cleanup refusal");
  expect(calls).toEqual(["build"]);
});
