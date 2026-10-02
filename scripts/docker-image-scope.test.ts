import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { isImageInput } from "./docker-image-scope.cjs";

const root = path.resolve(import.meta.dir, "..");
interface Job {
  if?: string;
  needs?: string;
  "timeout-minutes": string | number;
  concurrency?: { group: string; "cancel-in-progress": boolean; queue: string };
  outputs?: Record<string, string>;
  steps: { name?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }[];
}
const workflow = Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows/docker-image.yml"), "utf8")) as {
  jobs: Record<string, Job>;
  concurrency: { group: string; "cancel-in-progress": string };
  on: { push: { branches: string[]; tags: string[] } };
};

test("image inputs build, while prose, unrelated CI and shell tooling skip", () => {
  for (const file of [
    "Dockerfile", ".dockerignore", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json",
    "next.config.ts", "postcss.config.mjs", "patches/framework.patch", "src/app/page.tsx",
    "src/app/globals.css", "src/template.md", "public/icon.svg", "bin/cli.mjs", "vendor/tool/data.txt",
    "scripts/build-mcp.ts", "scripts/whisper_transcribe.py", "scripts/runtime-host-viewer-adapter.ts",
    "scripts/runtime-host-healthcheck.ts", "scripts/published-image-entrypoint.sh",
    "landing/site/demo/taskIcons.json", "evals/probe.ts", "spikes/probe.mts", "test-preload.ts",
    "external/imported.cjs", ".gitignore", "src/components/.gitignore", ".github/workflows/docker-image.yml",
  ]) expect(isImageInput(file), file).toBe(true);
  for (const file of [
    "README.md", "CONTRIBUTING.md", "docs/docker.md", "docs/guide.md", "evidence/report.txt",
    ".github/workflows/privacy-publication.yml", ".githooks/pre-push", "scripts/audit-with-retry.sh",
    "landing/site/index.html", "docker-compose.yml",
  ]) expect(isImageInput(file), file).toBe(false);
});

test("workflow gates Docker steps and reserves capacity across different refs", () => {
  const { scope, build } = workflow.jobs;
  expect(scope.if).toBe("github.event_name == 'pull_request'");
  expect(scope["timeout-minutes"]).toBe(3);
  expect(scope.steps[0].with?.["fetch-depth"]).toBe(0);
  expect(scope.outputs?.build).toBe("${{ steps.inputs.outputs.build }}");
  expect(scope.steps[1].env).toEqual({
    BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
  });
  expect(scope.steps[1].run).toBe('node scripts/docker-image-scope.cjs "$BASE_SHA" "$HEAD_SHA" >> "$GITHUB_OUTPUT"');
  expect(build.needs).toBe("scope");
  expect(build.if).toBe("${{ !cancelled() && (github.event_name != 'pull_request' || needs.scope.outputs.build == 'true') }}");
  expect(build.concurrency).toEqual({ group: "docker-image-build", "cancel-in-progress": false, queue: "max" });
  expect(workflow.concurrency.group).toBe("docker-image-${{ github.ref }}");
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' || github.ref_type != 'tag' }}");
  expect(workflow.on.push).toEqual({ branches: ["main"], tags: ["v*"] });
  expect(build["timeout-minutes"]).toBe("${{ github.event_name == 'pull_request' && 45 || 360 }}");
  const image = build.steps.find((step: { name?: string }) => step.name === "Build both architectures");
  expect(image?.with?.platforms).toBe("linux/amd64,linux/arm64");
  expect(image?.with?.push).toBe("${{ github.event_name != 'pull_request' }}");
});

test("real Git diff excludes main merges and retains deletions, renames and files beyond 300", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "docker-scope-git-"));
  // Hooks can supply repository selectors; the fixture must own its own Git.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    NODE_ENV: "test",
  };
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (file: string, content = "fixture") => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "Fixture"); return git("rev-parse", "HEAD"); };
  const run = (base: string, head: string) => spawnSync("node", [path.join(root, "scripts/docker-image-scope.cjs"), base, head], { cwd, env, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "core.hooksPath", "/dev/null");
    write("README.md"); write("src/old.ts");
    commit(); git("branch", "topic");
    write("src/main-only.ts"); const main = commit();
    git("checkout", "-q", "topic");
    write("docs/guide.md"); commit();
    // Before and after merging main, only the PR's prose is a changed input.
    expect(run(main, git("rev-parse", "HEAD")).stdout).toBe("build=false\n");
    git("merge", "-qm", "Merge fixture main", "main");
    expect(run(main, git("rev-parse", "HEAD")).stdout).toBe("build=false\n");
    git("mv", "src/old.ts", "docs/old.txt"); const moved = commit();
    expect(run(main, moved).stdout).toBe("build=true\n");
    expect(git("diff", "--name-only", "--no-renames", main, moved)).toContain("src/old.ts");
    for (let i = 0; i < 305; i++) write(`docs/${i}.md`);
    write("src/late\ninput.ts"); const large = commit();
    expect(run(moved, large).stdout).toBe("build=true\n");
    expect(git("diff", "--name-only", "-z", moved, large).split("\0").filter(Boolean)).toHaveLength(306);
    expect(run("missing", large).status).not.toBe(0);
    expect(run("0".repeat(40), large).status).not.toBe(0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("real Tailwind compilation uses app sources and ignores prose outside src", async () => {
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  const directive = css.match(/@import "tailwindcss"[^;]*;/)![0];
  const compile = async (prose: string) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "docker-scope-css-"));
    try {
      mkdirSync(path.join(cwd, "src/app"), { recursive: true });
      symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "dir");
      writeFileSync(path.join(cwd, "src/component.tsx"), '<div className="w-[13451px]" />');
      writeFileSync(path.join(cwd, "README.md"), prose);
      const from = path.join(cwd, "src/app/globals.css");
      writeFileSync(from, directive);
      return (await postcss([tailwind({ base: cwd, optimize: false })]).process(directive, { from })).css;
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  };
  const before = await compile("Documentation");
  const after = await compile('<div class="w-[24562px]" />');
  expect(after).toContain("13451px");
  expect(after).not.toContain("24562px");
  expect(after).toBe(before);
});
