import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
};
type Job = { env: Record<string, string>; steps: Step[] };
const names = ["privacy-publication", "privacy-tracker-audit"];
const workflows = names.map((name) => {
  const source = readFileSync(join(import.meta.dir, "..", ".github/workflows", `${name}.yml`), "utf8");
  return Bun.YAML.parse(source) as {
    // Bun's YAML 1.1 parser resolves the unquoted `on` key to `true`.
    true: { push?: { branches: string[] } };
    jobs: Record<string, Job>;
  };
});
const jobs = workflows.map((workflow, index) => workflow.jobs[names[index]!]!);
const step = (job: Job, name: string) => job.steps.find((entry) => entry.name === name)!;

// Execute the actual inline workflow shell. The sudo double records apt
// invocations and refuses a warm install unless network use is disabled.
function run(job: Job, name: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "privacy-media-workflow-"));
  try {
    const log = join(root, "calls");
    const output = join(root, "output");
    writeFileSync(join(root, "sudo"), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$1" == timeout ]]; then
  [[ "$FAIL_DOWNLOAD" != 1 ]]
elif [[ "$1" == apt-get ]]; then
  [[ "$*" == *--no-download* && "$*" == *--no-install-recommends* && "$FAIL_INSTALL" != 1 ]]
else
  exit 0
fi
`, { mode: 0o755 });
    for (const tool of ["ffmpeg", "ffprobe", "tesseract"]) {
      writeFileSync(join(root, tool), "#!/bin/bash\nprintf 'eng\\nukr\\n'\n", { mode: 0o755 });
    }
    const result = Bun.spawnSync(["bash", "-c", step(job, name).run!], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        PRIVACY_MEDIA_PACKAGES: job.env.PRIVACY_MEDIA_PACKAGES!,
        MEDIA_CACHE_DIR: join(root, "cache"),
        ImageOS: "ubuntu24",
        ImageVersion: "20260930.1",
        RUNNER_ARCH: "X64",
        GITHUB_OUTPUT: output,
        GITHUB_ENV: join(root, "environment"),
        RUNNER_TEMP: root,
        CALL_LOG: log,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      text: result.stdout.toString() + result.stderr.toString(),
      calls: Bun.file(log).size ? readFileSync(log, "utf8") : "",
      output: Bun.file(output).size ? readFileSync(output, "utf8") : "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [index, job] of jobs.entries()) {
  test(`${names[index]} warm installation cannot contact apt sources`, () => {
    const result = run(job, "Install media inspection tools (offline)");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("--no-download");
    expect(result.calls).not.toContain(" update");
    expect(result.calls).not.toContain("timeout");
    const restore = step(job, "Restore media inspection tools");
    expect(restore.with?.["restore-keys"]).toBeUndefined();
    expect(restore.with?.path).toBe("${{ runner.temp }}/privacy-media");
    expect(step(job, "Download media inspection tools (cold cache)").if)
      .toBe("steps.media-cache.outputs.cache-hit != 'true'");
  });

  test(`${names[index]} cold download has a bounded retry and infrastructure verdict`, () => {
    const result = run(job, "Download media inspection tools (cold cache)", { FAIL_DOWNLOAD: "1" });
    expect(result.code).toBe(1);
    expect(result.calls.trim().split("\n")).toHaveLength(2);
    expect(result.calls).toContain("timeout --kill-after=5s 90s");
    expect(result.text).toContain("::error title=Privacy tools provisioning::");
    expect(result.text).toContain("infrastructure failure before privacy inspection");
    const success = run(job, "Download media inspection tools (cold cache)");
    expect(success.code).toBe(0);
    expect(success.calls).toContain("timeout --kill-after=5s 180s");
    expect(success.calls).toContain("--download-only --reinstall --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-ukr");
  });

  test(`${names[index]} offline failure fails closed without network fallback`, () => {
    const result = run(job, "Install media inspection tools (offline)", { FAIL_INSTALL: "1" });
    expect(result.code).toBe(1);
    expect(result.calls.trim().split("\n")).toHaveLength(1);
    expect(result.text).toContain("Offline cached-package installation failed");
  });

  test(`${names[index]} cache key follows tools and runner image, with no candidate input`, () => {
    const baseline = run(job, "Resolve media tools cache");
    expect(baseline.code).toBe(0);
    expect(baseline.output).toContain("key=privacy-media-v3-ubuntu24-20260930.1-X64-");
    expect(run(job, "Resolve media tools cache", { PRIVACY_MEDIA_PACKAGES: "ffmpeg" }).output).not.toBe(baseline.output);
    expect(run(job, "Resolve media tools cache", { ImageVersion: "20261001.1" }).output).not.toBe(baseline.output);
    const saveIndex = job.steps.findIndex((entry) => entry.uses?.startsWith("actions/cache/save@"));
    expect(saveIndex).toBeGreaterThan(0);
    expect(job.steps[saveIndex]!.if).toBe("steps.media-cache.outputs.cache-hit != 'true' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
    expect(job.steps.slice(0, saveIndex).filter((entry) => entry.uses?.startsWith("actions/checkout@"))[0]?.with?.ref)
      .toBe("${{ github.event.repository.default_branch }}");
    for (const entry of job.steps.slice(0, saveIndex + 1)) {
      expect(entry.run ?? "").not.toMatch(/candidate|hashFiles|github\.event\.pull_request\.head/);
    }
    expect(job.steps.slice(saveIndex + 1).some((entry) => entry.run?.includes("privacy-"))).toBeTrue();
  });
}

test("both required jobs use identical package lists and provisioning", () => {
  expect(jobs[0]!.env).toEqual(jobs[1]!.env);
  const media = (job: Job) => job.steps.filter((entry) => /media|inspection tools/.test(entry.name ?? ""));
  expect(media(jobs[0]!)).toEqual(media(jobs[1]!));
});

// Default-branch caches need a trusted push writer on hosts that give
// publication/issue events read-only cache tokens.
test("main pushes populate the same cache without requiring a tracker number", () => {
  for (const workflow of workflows) expect(workflow.true.push?.branches).toEqual(["main"]);
  expect(step(jobs[1]!, "Audit public tracker surfaces").if).toBe("github.event_name != 'push'");
  expect(step(jobs[0]!, "Check out candidate as inspection input").with?.ref)
    .toBe("${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.sha }}");
});
