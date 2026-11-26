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

test("a runtime consumer export survives an unconfirmed exit 1 without a receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-export-unconfirmed-")); roots.push(root);
  const tree = path.join(root, "runtime-tree"); fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "input.txt"), "consumer input");
  await expect(runSteps("pre-push", [{ name: "runtime negative controls", command: [] }], {
    root, deadline: null, logDir: root, say: () => {}, prepare: () => ({
      command: [process.execPath, "-e", "process.exitCode = 1"], env: process.env, root: tree,
      cleanup: () => fs.rmSync(tree, { recursive: true }), completionReceipt: { path: path.join(root, "missing-receipt"), token: "expected" }, requireCompletionReceipt: true,
    }),
  })).rejects.toThrow("completion is unconfirmed");
  expect(fs.readFileSync(path.join(tree, "input.txt"), "utf8")).toBe("consumer input");
});

test.each([0, 1])("a runtime consumer export is released after receipt-confirmed exit %s", async code => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-export-confirmed-")); roots.push(root);
  const tree = path.join(root, "runtime-tree"), receipt = path.join(root, "complete"); fs.mkdirSync(tree);
  const token = "confirmed completion";
  const source = `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(token)}); process.exitCode = ${code}`;
  const result = runSteps("pre-push", [{ name: "runtime negative controls", command: [] }], {
    root, deadline: null, logDir: root, say: () => {}, prepare: () => ({
      command: [process.execPath, "-e", source], env: process.env, root: tree,
      cleanup: () => fs.rmSync(tree, { recursive: true }), completionReceipt: { path: receipt, token }, requireCompletionReceipt: true,
    }),
  });
  if (code) await expect(result).rejects.toThrow("failed (1)"); else await result;
  expect(fs.existsSync(tree)).toBeFalse();
});
