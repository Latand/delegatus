import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
function read(name: string) {
  return Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows", name), "utf8")) as {
    on: { pull_request?: { paths?: string[] }; push?: { branches?: string[]; tags?: string[] }; schedule?: { cron: string }[]; workflow_dispatch?: unknown };
    jobs: Record<string, { "timeout-minutes"?: number; steps?: { name?: string; run?: string; with?: Record<string, unknown> }[] }>;
    concurrency: { "cancel-in-progress": boolean | string };
  };
}
test("Docker publishing stays on main and tags; PRs match image inputs and reject unrelated paths", () => {
  const docker = read("docker-image.yml");
  expect(docker.on.push).toEqual({ branches: ["main"], tags: ["v*"] });
  const patterns = docker.on.pull_request!.paths!;
  const matches = (file: string) => patterns.some(pattern => new Bun.Glob(pattern).match(file));
  for (const file of ["Dockerfile", ".dockerignore", "package.json", "bun.lock", "patches/dependency.patch", "src/runtime-host/main.ts", "src/app/page.tsx", "public/icon.svg", "bin/cli.mjs", "scripts/published-image-entrypoint.sh", "scripts/build-mcp.ts", "vendor/connector/index.js"]) expect(matches(file)).toBeTrue();
  for (const file of ["CONTRIBUTING.md", "docs/guide.md", ".githooks/pre-commit", "scripts/local-gate.ts", "scripts/audit-with-retry.sh", ".github/workflows/docker-image.yml"]) expect(matches(file)).toBeFalse();
  expect(docker.jobs.build!["timeout-minutes"]).toBe(45);
  expect(docker.concurrency["cancel-in-progress"]).toBe("${{ github.ref_type != 'tag' }}");
  const build = docker.jobs.build!.steps!.find(step => step.name === "Build both architectures")!;
  expect(build.with!.push).toBe("${{ github.event_name != 'pull_request' }}");
  expect(build.with!.platforms).toBe("linux/amd64,linux/arm64");
});
test("OS-specific CI jobs are bounded and keep cancellation", () => {
  for (const [file, limits] of [
    ["platform-tests.yml", { scope: 3, "windows-platform": 10 }],
    ["macos-identity.yml", { scope: 3, "darwin-identity": 10 }],
    ["macos-newcomer.yml", { newcomer: 15 }],
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
