import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* The job in `bun-runtime.yml` is the answer to "nobody here can reproduce
   that": it runs the runtime verification at the pull request's own commit so
   the evidence has a SHA on it. A job that runs those checks and then does not
   care what they said would be worse than no job, because it produces the
   artefact a reviewer asked for without the substance. That property is what
   this file holds. */

const repositoryRoot = path.join(import.meta.dir, "..");
const workflowSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "bun-runtime.yml"),
  "utf8",
);
const dockerfile = fs.readFileSync(path.join(repositoryRoot, "Dockerfile"), "utf8");

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: unknown;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

const workflow = Bun.YAML.parse(workflowSource) as {
  jobs: Record<string, { if?: string; strategy?: { matrix: { repetition?: number[]; codex?: string[] } }; steps: WorkflowStep[] }>;
};
const steps = workflow.jobs["bun-runtime"].steps;
const scripts = steps.map((step) => step.run ?? "");

test("dispatch preserves both runtime verification processes", () => {
  // The Viewer half: the compiled server runtimes load, and the served build
  // answers 200. The host half: a completed succession, endpoints held.
  expect(scripts).toContain("bun scripts/verify-viewer-runtime.ts");
  // The Codex socket transport writes a masked frame from the built Viewer.
  expect(scripts).toContain("bun scripts/verify-viewer-runtime.ts --codex-socket");
  expect(steps.findIndex(step => step.name === "Build the Viewer"))
    .toBeLessThan(scripts.indexOf("bun scripts/verify-viewer-runtime.ts --codex-socket"));
  expect(scripts).toContain("bun scripts/verify-runtime-host.ts");
  expect(scripts.some((script) => script.includes("bun run build"))).toBe(true);
});

test("no step can fail without failing the job", () => {
  for (const step of steps) {
    expect(step["continue-on-error"]).toBeUndefined();
    // A conditional step is a step that can decline to run, and a check that
    // did not run reports nothing while the job still reports success.
    expect(step.if).toBeUndefined();
  }
  for (const script of scripts) {
    for (const swallow of ["|| true", "|| echo", "set +e", "continue-on-error"]) {
      expect(script).not.toContain(swallow);
    }
    // The pinned-interpreter and pin-resolution steps are pipelines, where a
    // failure in any but the last command is invisible without `pipefail`.
    if (script.includes("|")) expect(script).toContain("set -euo pipefail");
  }
});

test("the interpreter under test is the pin the image ships, not a version written here", () => {
  const setupBun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(setupBun?.with?.["bun-version"]).toBe("${{ steps.pin.outputs.version }}");
  // The Dockerfile's three pins agree — `dockerfile-permissions.test.ts` holds
  // that — so resolving them here is what makes a future move self-verifying.
  expect(workflowSource).toContain("npm install -g bun@[0-9]+\\.[0-9]+\\.[0-9]+");
  expect(dockerfile).toContain("npm install -g bun@");
});

test("the job proves its own checks can go red, and does not only report that they went green", () => {
  // The tests that hold both verdicts — an empty target list is a failure, and
  // every way the rehearsal can be let down produces `ok: false` — run in this
  // job, at the same commit, rather than in a suite no workflow invokes.
  const held = scripts.find((script) => script.includes("bun test")) ?? "";
  for (const file of [
    "scripts/bun-runtime-workflow.test.ts",
    "scripts/verify-viewer-runtime.test.ts",
    "src/runtime-host/hostRehearsal.test.ts",
  ]) {
    expect(held).toContain(file);
  }

  // And end to end on the runner: each half is handed a subject that does not
  // hold. What makes these controls rather than ceremony is that a check which
  // stays green against one of them fails the job, so the refusals are named.
  expect(scripts.some(script => script.includes("bun scripts/verify-bun-runtime-controls.ts"))).toBeTrue();
  const control = fs.readFileSync(path.join(repositoryRoot, "scripts/verify-bun-runtime-controls.ts"), "utf8");
  expect(control).toContain("app-page.runtime.prod.js");
  expect(control).toContain("LLV_RUNTIME_HOST_REHEARSAL_ROOT");
  for (const refusal of [
    "Viewer check passed with no build present",
    "Viewer check did not reject and name the unloadable",
    "runtime-host rehearsal did not report a failed verdict",
  ]) {
    expect(control).toContain(refusal);
  }
});

test("the job runs at the pull request's own commit", () => {
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.ref).toContain("github.event.pull_request.head.sha");
});

test("the native queue campaign is manual-only and exercises twenty cases per supported CLI", () => {
  const campaign = workflow.jobs["native-queue-campaign"];
  expect(campaign.if).toBe("github.event_name == 'workflow_dispatch' && inputs.native_queue_campaign");
  expect(campaign.strategy?.matrix.repetition).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(campaign.strategy?.matrix.codex).toEqual(workflow.jobs["native-codex-runtime"].strategy?.matrix.codex);
  const run = campaign.steps.find(step => step.name === "Exercise cold resume and native queue dispatch")!.run!;
  expect(run).toContain("bun test src/lib/runtime/nativeQueueHost.integration.test.ts");
  expect(run).toContain("NATIVE_CODEX_QUEUE_TEST_BINARY=");
  expect(run).toContain("grep -q '1 pass'");
  expect(run).toContain("set -euo pipefail");
  expect(workflow.jobs["bun-runtime"].if).toBe("github.event_name != 'workflow_dispatch' || !inputs.native_queue_campaign");
});

test("the native Codex matrix covers the documented installed CLI and every pinned host version", () => {
  const document = fs.readFileSync(path.join(repositoryRoot, "docs/design/codex-pinned-protocol.md"), "utf8");
  const installed = [...document.matchAll(/^Installed CLI pin: `(\d+\.\d+\.\d+)`\.$/gm)];
  expect(installed).toHaveLength(1);
  const versions = workflow.jobs["native-codex-runtime"].strategy?.matrix.codex;
  expect(versions).toContain(installed[0]![1]);
  const protocolRoot = path.join(repositoryRoot, "src/lib/accounts/protocol");
  const supported = fs.readdirSync(protocolRoot).filter(version => /^\d+\.\d+\.\d+$/.test(version));
  expect(supported.length).toBeGreaterThan(0);
  expect(versions?.toSorted()).toEqual(supported.toSorted());
  // Keeping the declaration and alias wired prevents a second list drifting.
  expect(workflowSource.match(/&native-codex-versions/g)).toHaveLength(1);
  expect(workflowSource.match(/\*native-codex-versions/g)).toHaveLength(1);
});

test("supported Codex CLIs run the full native contracts at the proposed commit", () => {
  const job = workflow.jobs["native-codex-runtime"];
  expect(job.if).toBe(workflow.jobs["bun-runtime"].if);
  expect(job.strategy?.matrix.codex?.length).toBeGreaterThan(0);
  expect(job.steps.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.ref)
    .toContain("github.event.pull_request.head.sha");
  expect(job.steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"))?.with?.["bun-version"])
    .toBe("${{ steps.pin.outputs.version }}");
  expect(job.steps.some(step => step.run?.includes("@openai/codex@${{ matrix.codex }}"))).toBeTrue();
  const interpreter = job.steps.find(step => step.name === "Require the pinned interpreter");
  expect(interpreter?.env?.EXPECTED_BUN).toBe("${{ steps.pin.outputs.version }}");
  expect(interpreter?.run).toContain('actual="$(bun --version)"');
  expect(interpreter?.run).toContain('if [[ "$actual" != "$EXPECTED_BUN" ]]');
  expect(interpreter?.run).toContain("exit 1");
  expect(job.steps.some(step => step.run?.includes("bun scripts/verify-native-codex-runtime.ts") && !step.run.includes("--steering-only"))).toBeTrue();
  for (const step of job.steps) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    for (const swallow of ["|| true", "set +e"]) expect(step.run ?? "").not.toContain(swallow);
  }
});

test("runtime CI runs on every PR and supports dispatch", () => {
  const triggers = Bun.YAML.parse(workflowSource) as { on: Record<string, unknown> };
  expect(Object.keys(triggers.on)).toEqual(["pull_request", "workflow_dispatch"]);
});

test("one stable runtime context refuses every incomplete upstream verdict", () => {
  const gate = workflow.jobs["runtime-gate"] as typeof workflow.jobs[string] & { needs: string[] };
  expect(gate.needs).toEqual(["bun-runtime", "native-codex-runtime"]);
  expect(gate.if).toBe(`always() && (${workflow.jobs["bun-runtime"]!.if})`);
  const check = gate.steps[0]!.run!;
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const side of ["BUN_RESULT", "CODEX_RESULT"]) {
      const run = Bun.spawnSync(["bash", "-c", check], { env: { ...process.env, BUN_RESULT: "success", CODEX_RESULT: "success", [side]: result } });
      expect(run.exitCode === 0).toBe(result === "success");
    }
  }
  expect(scripts.join("\n").match(/bun scripts\/build-mcp\.ts/g)).toBeNull();
  expect(steps.findIndex(step => step.name === "Build the Viewer")).toBeLessThan(steps.findIndex(step => step.name?.startsWith("Enforce MCP")));
});

test("parallel runtime controls require both processes to finish successfully", () => {
  const script = scripts.find(script => script.includes("controls_pid="))!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-pair-"));
  try {
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "bun"), `#!/bin/bash
set -eu
if [[ "$1" == test ]]; then
  touch "$RUNNER_TEMP/held-ready"
  for attempt in {1..100}; do [[ -f "$RUNNER_TEMP/controls-ready" ]] && break; sleep 0.01; done
  test -f "$RUNNER_TEMP/controls-ready"
  echo "Ran checks across 6 files"
  exit "$HELD_EXIT"
fi
touch "$RUNNER_TEMP/controls-ready"
for attempt in {1..100}; do [[ -f "$RUNNER_TEMP/held-ready" ]] && break; sleep 0.01; done
test -f "$RUNNER_TEMP/held-ready"
exit "$CONTROL_EXIT"
`, { mode: 0o755 });
    for (const file of script.match(/(?:scripts|src)\/[\w/.-]+\.test\.ts/g)!) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "");
    }
    for (const [held, control] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const scratch = fs.mkdtempSync(path.join(root, "sample-"));
      const result = Bun.spawnSync(["bash", "-c", script], {
        cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: scratch,
          HELD_EXIT: String(held), CONTROL_EXIT: String(control) }, timeout: 5000,
      });
      expect(result.exitCode === 0).toBe(held === 0 && control === 0);
      expect(fs.existsSync(path.join(scratch, "held-ready"))).toBeTrue();
      expect(fs.existsSync(path.join(scratch, "controls-ready"))).toBeTrue();
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("README seed and all frame layouts run against the PR build with isolated state", () => {
  const index = steps.findIndex(step => step.name === "Check README seed and frame layout");
  expect(index).toBeGreaterThan(steps.findIndex(step => step.name === "Build the Viewer"));
  const step = steps[index]!;
  expect(step.if).toBeUndefined();
  for (const name of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR"]) expect(step.env?.[name]).toContain("${{ runner.temp }}/readme-");
  expect(step.env?.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:1");
  expect(step.run).toContain("install --with-deps chromium");
  expect(step.run).toContain("bash scripts/gate-slot.sh bun test scripts/capture-readme-media.test.ts");
  expect(step.run).toContain("bash scripts/gate-slot.sh bun scripts/capture-readme-media.ts --check-layout");
});
