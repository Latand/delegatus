import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

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
  expect(scripts).toContain("bun scripts/verify-bun-runtime-controls.ts");
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
  expect(campaign.strategy?.matrix.codex).toEqual(["0.154.0", "0.159.0"]);
  const run = campaign.steps.find(step => step.name === "Exercise cold resume and native queue dispatch")!.run!;
  expect(run).toContain("bun test src/lib/runtime/nativeQueueHost.integration.test.ts");
  expect(run).toContain("NATIVE_CODEX_QUEUE_TEST_BINARY=");
  expect(run).toContain("grep -q '1 pass'");
  expect(run).toContain("set -euo pipefail");
  expect(workflow.jobs["bun-runtime"].if).toBe("github.event_name != 'workflow_dispatch' || !inputs.native_queue_campaign");
});

test("both supported Codex CLIs run the full native contracts at the proposed commit", () => {
  const job = workflow.jobs["native-codex-runtime"];
  expect(job.if).toBe(workflow.jobs["bun-runtime"].if);
  expect(job.strategy?.matrix.codex).toEqual(["0.154.0", "0.159.0"]);
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

test("runtime CI is dispatch-only; pre-push owns the scoped local runs", () => {
  const triggers = Bun.YAML.parse(workflowSource) as { on: Record<string, unknown> };
  expect(Object.keys(triggers.on)).toEqual(["workflow_dispatch"]);
});
