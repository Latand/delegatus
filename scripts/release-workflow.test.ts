import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const macWorkflow = readFileSync(
  new URL("../.github/workflows/macos-newcomer.yml", import.meta.url),
  "utf8",
);
const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

function workflowStepScript(stepName: string): string {
  const lines = macWorkflow.split("\n");
  const stepStart = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (stepStart === -1) throw new Error(`Workflow step is missing: ${stepName}`);
  const nextStep = lines.findIndex((line, index) => index > stepStart && /^ {6}- /.test(line));
  const stepEnd = nextStep === -1 ? lines.length : nextStep;
  const runStart = lines.findIndex((line, index) => index > stepStart && index < stepEnd && line.trim() === "run: |");
  if (runStart === -1) throw new Error(`Workflow step has no multiline script: ${stepName}`);
  const indent = (lines[runStart].match(/^ */)?.[0].length ?? 0) + 2;
  return lines.slice(runStart + 1, stepEnd).map((line) => line.startsWith(" ".repeat(indent)) ? line.slice(indent) : line).join("\n");
}

test("macOS follows npm job success for tag and dispatch runs when GitHub Release fails", () => {
  expect(macWorkflow).toContain('workflows: ["Publish to npm"]');
  expect(macWorkflow).not.toContain("github.event.workflow_run.conclusion");
  expect(macWorkflow).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  expect(macWorkflow).toContain("github.event.workflow_run.head_sha");
  expect(macWorkflow).toContain('ref: ${{ steps.release.outputs.revision || github.event.pull_request.head.sha || github.event.workflow_run.head_sha || github.sha }}');
  expect(macWorkflow).toContain('[[ "$revision" =~ ^[0-9a-f]{40}$ ]]');
  expect(publishWorkflow).toContain("  push:\n    tags:\n      - \"v*\"");
  expect(publishWorkflow).toContain("  workflow_dispatch:");

  const parsed = Bun.YAML.parse(macWorkflow) as {
    jobs: { newcomer: { steps: { id?: string; name?: string; if?: string }[] } };
  };
  const steps = parsed.jobs.newcomer.steps;
  const gateIndex = steps.findIndex((step) => step.id === "npm-publication");
  expect(gateIndex).toBeGreaterThanOrEqual(0);
  for (const step of steps.slice(gateIndex + 1).filter((step) => step.name !== "Record short report")) {
    expect(step.if ?? "", `${step.name ?? step.id ?? "unnamed step"} must require npm success`).toContain(
      "steps.npm-publication.outputs.npm_succeeded == 'true'",
    );
  }

  const gate = workflowStepScript("Determine whether npm publication succeeded");
  expect(gate).toContain('select(.name == "publish") | .conclusion');
  expect(gate).not.toContain("workflow_run.conclusion");
  const node = Bun.which("node");
  if (!node) throw new Error("The workflow test requires Node.js");
  const scenarios = [
    ["tag push", "success", "failure", "true"],
    ["tag push", "failure", "success", "false"],
    ["dispatch recovery", "success", "failure", "true"],
    ["dispatch recovery", "failure", "success", "false"],
  ] as const;
  for (const [trigger, npmConclusion, releaseConclusion, expected] of scenarios) {
    const directory = mkdtempSync(join(tmpdir(), "llv-macos-publish-gate-"));
    try {
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const gh = join(bin, "gh");
      writeFileSync(gh, `#!${node}
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "repos/owner/repo/actions/runs/12345/jobs") process.exit(91);
if (!args.some((arg) => arg.includes('select(.name == "publish") | .conclusion'))) process.exit(92);
process.stdout.write(process.env.GH_TEST_PUBLISH_CONCLUSION);
`);
      chmodSync(gh, 0o755);
      const output = join(directory, `${trigger}-${npmConclusion}-${releaseConclusion}.output`);
      const result = Bun.spawnSync(["bash", "-c", gate], {
        cwd: directory,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: join(directory, "home"),
          XDG_CONFIG_HOME: join(directory, "config"),
          LLV_STATE_DIR: join(directory, "state"),
          TMPDIR: join(directory, "tmp"),
          GH_TEST_PUBLISH_CONCLUSION: npmConclusion,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "owner/repo",
          RUN_ID: "12345",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, `${trigger}: npm=${npmConclusion}, release=${releaseConclusion}`).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`npm_succeeded=${expected}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});


test.each(["off-main", "main-ancestor"])("Docker tag publication: %s", scenario => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/docker-image.yml", import.meta.url), "utf8")) as {
    jobs: { build: { steps: { name?: string; if?: string; run?: string; uses?: string; with?: { push?: boolean } }[] } };
  };
  const steps = workflow.jobs.build.steps;
  const guard = steps.findIndex(step => step.name === "Require release tag on main");
  const push = steps.findIndex(step => step.with?.push === true);
  expect(push).toBeGreaterThan(0);
  const gate = steps[guard];
  if (gate) expect(guard).toBeLessThan(push);
  const root = mkdtempSync(join(tmpdir(), "docker-tag-"));
  try {
    const env = { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: join(root, "no-config"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", RELEASE_REF: "refs/tags/v1.2.0" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--bare", "--initial-branch=main", "origin.git");
    git("init", "--initial-branch=main");
    git("commit", "--allow-empty", "-m", "base");
    git("remote", "add", "origin", join(root, "origin.git"));
    git("push", "origin", "main");
    if (scenario === "off-main") git("checkout", "-b", "release");
    git("commit", "--allow-empty", "-m", "candidate");
    git("tag", "-a", "v1.2.0", "-m", "release");
    if (scenario === "main-ancestor") {
      git("commit", "--allow-empty", "-m", "newer main");
      git("push", "origin", "main");
    }
    // Execute the workflow's actual gate and record whether the later push
    // step is reachable under Actions' default success() semantics.
    const marker = join(root, "docker-push");
    const condition = gate?.if?.replaceAll("github.ref_type", "'tag'");
    const admitted = condition === undefined || Function(`return (${condition})`)() === true;
    const run = spawnSync("bash", ["-e", "-o", "pipefail", "-c", (admitted ? gate?.run ?? "" : "") + '\nprintf pushed > "$PUSH_MARKER"'],
      { cwd: root, env: { ...env, PUSH_MARKER: marker }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(scenario === "off-main" ? 1 : 0);
    expect(Bun.file(marker).size > 0).toBe(scenario !== "off-main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
