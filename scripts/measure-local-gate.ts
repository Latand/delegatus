import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { Prepared, Step } from "./local-gate";

// Run either gate implementation over the same immutable product checkout.
// Ref discovery/fetch and admission are outside this measurement. Each arm
// uses its own checkout and this same environment, with isolated check roots.
const [toolRoot, root, base, scratch, reuse] = process.argv.slice(2);
if (!toolRoot || !root || !base || !scratch || !["yes", "no"].includes(reuse ?? ""))
  throw new Error("usage: measure-local-gate.ts <gate-source> <checkout> <base> <scratch> <reuse: yes|no>");
const gate = await import(path.join(toolRoot, "scripts/local-gate.ts")) as typeof import("./local-gate");
const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { cwd: root, encoding: "utf8" });
if (diff.status !== 0) throw new Error("cannot read measurement diff");
const files = diff.stdout.trimEnd().split("\n").filter(Boolean);
const steps = gate.plan("pre-push", files, gate.discover(root, base, files));
if (steps.some(step => step.pinned)) throw new Error("measure runtime changes with the complete hook; this runner measures unpinned checks");
const sandbox = mkdtempSync(path.join(scratch, "gate-measure-run-"));
try {
  const env = gate.isolatedEnvironment(sandbox, process.env);
  const prepare = (step: Step): Prepared => {
    const command = [...step.command];
    if (command[1]?.startsWith("scripts/")) command[1] = path.join(toolRoot, command[1]);
    const childEnv = { ...env };
    if (step.name === "privacy") Object.assign(childEnv, {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(root, "scripts/privacy-known-value-fingerprints.json"),
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
    });
    return { command: step.capped ? ["bash", path.join(toolRoot, "scripts/gate-slot.sh"), ...command] : command, env: childEnv };
  };
  const passes = reuse === "yes" && steps.some(step => step.name !== "privacy") ? gate.stepPasses(root, base, steps, console.error) : undefined;
  console.error(`measurement: ${files.length} changed files; ${steps.map(step => step.name).join(", ")}`);
  await gate.runSteps("pre-push", steps, { root, deadline: null, logDir: sandbox, prepare, passes });
} finally { rmSync(sandbox, { recursive: true, force: true }); }
