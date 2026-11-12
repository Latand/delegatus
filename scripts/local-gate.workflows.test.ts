import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isImageInput } from "./docker-image-scope.cjs";
import { workflowEntries } from "./ci-platform-scope";
const root = path.resolve(import.meta.dir, "..");
function read(name: string) {
  return Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows", name), "utf8")) as {
    on: { pull_request?: { paths?: string[] }; push?: { branches?: string[]; tags?: string[] }; schedule?: { cron: string }[]; workflow_dispatch?: unknown };
    jobs: Record<string, { if?: string; needs?: string; "timeout-minutes"?: number | string; steps?: { name?: string; run?: string; with?: Record<string, unknown> }[] }>;
    concurrency: { "cancel-in-progress": boolean | string };
  };
}
test("Docker publishing stays on main and tags; PR scope admits image inputs and rejects unrelated paths", () => {
  const docker = read("docker-image.yml");
  expect(docker.on.push).toEqual({ branches: ["main"], tags: ["v*"] });
  // Admission moved from GitHub's truncated paths filter to the complete diff.
  expect(docker.on).toHaveProperty("pull_request");
  expect(docker.on.pull_request?.paths).toBeUndefined();
  expect(docker.jobs.scope?.if).toBe("github.event_name == 'pull_request'");
  expect(docker.jobs.scope?.steps?.[1]?.run).toBe('node scripts/docker-image-scope.cjs "$BASE_SHA" "$HEAD_SHA" >> "$GITHUB_OUTPUT"');
  expect(docker.jobs.build?.needs).toBe("scope");
  expect(docker.jobs.build?.if).toBe("${{ !cancelled() && (github.event_name != 'pull_request' || needs.scope.outputs.build == 'true') }}");
  for (const file of ["Dockerfile", ".dockerignore", "package.json", "bun.lock", "patches/dependency.patch", "src/runtime-host/main.ts", "src/app/page.tsx", "public/icon.svg", "bin/cli.mjs", "scripts/published-image-entrypoint.sh", "scripts/build-mcp.ts", "vendor/connector/index.js", "landing/site/demo/taskIcons.json", "scripts/demo-capture-browser.cjs", ".env.production", ".postcssrc.json", ".github/workflows/docker-image.yml", "scripts/local-gate.ts"]) expect(isImageInput(file), file).toBeTrue();
  for (const file of ["CONTRIBUTING.md", "docs/guide.md", ".githooks/pre-commit", "scripts/audit-with-retry.sh"]) expect(isImageInput(file), file).toBeFalse();
  expect(docker.jobs.build!["timeout-minutes"]).toBe("${{ github.event_name == 'pull_request' && 45 || 360 }}");
  expect(docker.concurrency["cancel-in-progress"]).toBe("${{ github.ref_type != 'tag' }}");
  const build = docker.jobs.build!.steps!.find(step => step.name === "Publish both architectures")!;
  expect(build.with!.push).toBe(true);
  expect(build.with!.platforms).toBe("linux/amd64,linux/arm64");
});
test("OS-specific CI jobs are bounded and keep cancellation", () => {
  for (const [file, limits] of [
    ["platform-tests.yml", { scope: 3, "windows-platform": 10 }],
    ["macos-identity.yml", { scope: 3, "darwin-identity": 20 }],
    ["macos-newcomer.yml", { newcomer: 30 }],
  ] as const) {
    const workflow = read(file);
    for (const [job, timeout] of Object.entries(limits)) expect(workflow.jobs[job]!["timeout-minutes"]).toBe(timeout);
    expect(workflow.concurrency["cancel-in-progress"]).toBeTrue();
  }
});
test("supply-chain CI audits weekly and by dispatch using the shared script", () => {
  const workflow = read("supply-chain.yml");
  expect(workflow.on.pull_request).toBeUndefined();
  expect(workflow.on.schedule).toEqual([{ cron: "17 4 * * 1" }]);
  expect(workflow.on).toHaveProperty("workflow_dispatch");
  const runs = workflow.jobs.audit!.steps!.map(step => step.run ?? "").join("\n");
  expect(runs).toContain('bun scripts/supply-chain-check.ts --base "$BASE_SHA" --lockfile-only');
  expect(runs).toContain("bun scripts/supply-chain-check.ts --audit-only");
});

test("Windows caches Bun downloads by the candidate lockfile before install", () => {
  const job = read("platform-tests.yml").jobs["windows-platform"]!;
  const cache = job.steps!.find(step => step.name === "Cache Bun install downloads")!;
  expect(cache.with?.path).toBe("~/.bun/install/cache");
  expect(cache.with?.key).toContain("hashFiles('bun.lock')");
  expect(job.steps!.indexOf(cache)).toBeLessThan(job.steps!.findIndex(step => step.name === "Install dependencies"));
});

for (const stepName of ["Platform tests", "Terminal bootstrap custody with native Windows paths"]) {
  for (const failure of [false, true]) test(`${stepName} dispatches one owned file at a time and preserves ${failure ? "failure" : "success"}`, () => {
    const run = read("platform-tests.yml").jobs["windows-platform"]!.steps!.find(step => step.name === stepName)!.run!;
    const files = workflowEntries(run).filter(file => file.endsWith(".test.ts"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "windows-workflow-"));
    try {
      for (const file of [...files, "scripts/gate-slot.sh"]) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), "");
      }
      writeFileSync(path.join(dir, "scripts/gate-slot.sh"), `#!/bin/bash
set -eu
[[ $# == 3 && $1 == bun && $2 == test && -f $3 ]] || exit 91
printf '%s\\n' "$3" >> "$CALLS"
[[ $3 != "$FAIL_FILE" ]] || exit 17
`);
      const calls = path.join(dir, "calls");
      const result = spawnSync("bash", ["-c", run], { cwd: dir, encoding: "utf8",
        env: { ...process.env, CALLS: calls, FAIL_FILE: failure ? files[1] : "" } });
      expect(files.length).toBeGreaterThan(2);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: failure ? 17 : 0, stderr: "" });
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(failure ? files.slice(0, 2) : files);
      expect(result.stdout).toContain(`exit=${failure ? 17 : 0}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
