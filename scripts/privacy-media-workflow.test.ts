import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment } from "./local-gate";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  "working-directory"?: string;
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean;
  with?: Record<string, string>;
};
type Job = { env: Record<string, string>; steps: Step[] };
const names = ["privacy-publication", "privacy-tracker-audit"];
const workflows = names.map((name) => {
  const source = readFileSync(join(import.meta.dir, "..", ".github/workflows", `${name}.yml`), "utf8");
  return Bun.YAML.parse(source) as {
    // Bun 1.3's YAML 1.1 parser resolves unquoted `on` to `true`; Bun 1.4 keeps it as a string.
    on?: { push?: { branches: string[] } };
    true?: { push?: { branches: string[] } };
    jobs: Record<string, Job>;
  };
});
const jobs = workflows.map((workflow, index) => workflow.jobs[names[index]!]!);
const step = (job: Job, name: string) => job.steps.find((entry) => entry.name === name)!;

// Execute the publication suffix with GitHub's step timeout, continue-on-error
// and original-outcome warning semantics. The CLI double supplies independent
// baseline, scanner and candidate verdicts without repository or network calls.
function runPublication(extra: Record<string, string> = {}, budget = "130s") {
  const root = mkdtempSync(join(tmpdir(), "privacy-repair-workflow-"));
  try {
    const log = join(root, "calls");
    for (const directory of ["trusted", "candidate"]) {
      mkdirSync(join(root, directory, "scripts"), { recursive: true });
      writeFileSync(join(root, directory, "scripts/privacy-fixture.test.ts"), "");
    }
    mkdirSync(join(root, "trusted/node_modules"));
    writeFileSync(join(root, "bun"), `#!/bin/bash
directory="$(basename "$PWD")"
printf '%s:%s\\n' "$directory" "$1" >> "$CALL_LOG"
if [[ "$1" == test && "$STALL_DIRECTORY" == "$directory" ]]; then exec sleep 30; fi
case "$directory:$1" in
  trusted:test) exit "$BASELINE_EXIT" ;;
  trusted:scripts/privacy-publication-gate.ts) exit "$SCAN_EXIT" ;;
  candidate:test) exit "$CANDIDATE_EXIT" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const job = jobs[0]!;
    const baseline = step(job, "Verify privacy gate behavior");
    const warning = step(job, "Report trusted privacy self-test failure");
    expect(baseline.id).toBe("trusted-tests");
    expect(baseline["continue-on-error"]).toBe(true);
    expect(warning.if).toBe("steps.trusted-tests.outcome == 'failure'");
    const first = job.steps.indexOf(baseline);
    let baselineCode = 0;
    let code = 0;
    let text = "";
    for (const entry of job.steps.slice(first)) {
      if (entry.id === "privacy-scope") continue;
      if (entry === warning && baselineCode === 0) continue;
      // Only the wall-clock duration changes in timeout controls.
      const command = ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", entry.run!.replace("130s", budget)];
      // A local timeout supplies the runner's step deadline. The candidate's
      // shell still enforces its own timeout exactly as the workflow declares.
      if (entry === baseline) command.unshift("timeout", "--kill-after=5s", budget === "130s" ? `${entry["timeout-minutes"]}m` : budget);
      const result = Bun.spawnSync(command, {
        cwd: join(root, entry["working-directory"]!),
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log, BASELINE_EXIT: "1", SCAN_EXIT: "0", CANDIDATE_EXIT: "0", STALL_DIRECTORY: "", ...extra },
        stdout: "pipe", stderr: "pipe",
      });
      text += result.stdout.toString() + result.stderr.toString();
      code = result.exitCode;
      if (entry === baseline) baselineCode = code;
      if (code !== 0 && entry["continue-on-error"]) { code = 0; continue; }
      if (code !== 0) break;
    }
    return { code, baselineCode, text, calls: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a repair candidate reaches trusted inspection and passes despite red main self-tests", () => {
  const result = runPublication();
  expect(result.code).toBe(0);
  expect(result.baselineCode).toBe(1);
  expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts", "candidate:test"]);
  expect(result.text).toContain("::warning title=Trusted privacy self-tests::");
});

test("a green baseline completes publication without a baseline warning", () => {
  const result = runPublication({ BASELINE_EXIT: "0" });
  expect(result.code).toBe(0);
  expect(result.baselineCode).toBe(0);
  expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts", "candidate:test"]);
  expect(result.text).not.toContain("::warning");
});

test("trusted inspection refusal blocks publication and candidate execution despite red baseline", () => {
  const scan = step(jobs[0]!, "Scan changed publication surfaces, commit messages and the merge boundary");
  expect(scan["working-directory"]).toBe("trusted");
  expect(scan["continue-on-error"]).toBeUndefined();
  expect(scan.if).toBeUndefined();
  expect(scan.run).toContain("--repository ../candidate --require-known-values --check-commits");
  for (const exit of ["1", "78"]) {
    const result = runPublication({ SCAN_EXIT: exit });
    expect(result.code).toBe(Number(exit));
    expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts"]);
  }
});

test("candidate self-test failure still blocks publication after a red baseline", () => {
  const candidate = step(jobs[0]!, "Verify candidate privacy gate behavior within budget");
  expect(candidate["continue-on-error"]).toBeUndefined();
  expect(candidate.if).toBe("steps.privacy-scope.outputs.run == 'true'");
  const result = runPublication({ CANDIDATE_EXIT: "1" });
  expect(result.code).toBe(1);
  expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts", "candidate:test"]);
});

test("a stalled baseline is diagnosed before inspection and candidate tests proceed", () => {
  const result = runPublication({ STALL_DIRECTORY: "trusted" }, "0.1s");
  expect(result.code).toBe(0);
  expect(result.text).toContain("::warning title=Trusted privacy self-tests::");
  expect(result.baselineCode).toBe(124);
  expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts", "candidate:test"]);
});

test("a stalled candidate still refuses publication after a red baseline", () => {
  const result = runPublication({ STALL_DIRECTORY: "candidate" }, "0.1s");
  expect(result.code).toBe(124);
  expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts", "candidate:test"]);
});

test("candidate privacy tests run last with a failing time budget", () => {
  const job = jobs[0]!;
  const trusted = step(job, "Verify privacy gate behavior");
  expect(trusted["working-directory"]).toBe("trusted");
  expect(trusted["timeout-minutes"]).toBe(3);
  expect(trusted.run).toBe("bun test scripts/privacy-*.test.ts");
  const candidate = step(job, "Verify candidate privacy gate behavior within budget");
  expect(job.steps.at(-1)).toBe(candidate);
  expect(candidate["working-directory"]).toBe("candidate");
  expect(candidate["timeout-minutes"]).toBe(3);
  expect(candidate.run).toContain("timeout --kill-after=5s 130s bun test scripts/privacy-*.test.ts");
  const root = mkdtempSync(join(tmpdir(), "privacy-candidate-budget-"));
  try {
    // Drive the actual shell with a short budget and a stalled test process.
    mkdirSync(join(root, "trusted/node_modules"), { recursive: true });
    mkdirSync(join(root, "candidate"));
    writeFileSync(join(root, "bun"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const result = Bun.spawnSync(["bash", "-e", "-c", candidate.run!.replace("130s", "0.1s")], {
      cwd: join(root, "candidate"),
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(124);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  for (const workflow of workflows) expect((workflow.on ?? workflow.true)?.push?.branches).toEqual(["main"]);
  expect(step(jobs[1]!, "Audit public tracker surfaces").if).toBe("github.event_name != 'push'");
  expect(step(jobs[0]!, "Check out candidate as inspection input").with?.ref)
    .toBe("${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.sha }}");
});

test("PR self-tests use the trusted import closure and workflow changes while inspection always runs", () => {
  const job = jobs[0]!;
  expect(step(job, "Verify privacy gate behavior").if).toBe("github.event_name == 'push'");
  const scope = step(job, "Scope candidate privacy self-tests with trusted code");
  expect(scope["working-directory"]).toBe("trusted");
  expect(job.steps.indexOf(scope)).toBeGreaterThan(job.steps.findIndex(entry => entry.name === "Scan changed publication surfaces, commit messages and the merge boundary"));
  expect(step(job, "Scan changed publication surfaces, commit messages and the merge boundary").if).toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), "privacy-scope-workflow-"));
  try {
    const env = isolatedEnvironment(join(root, "env"), process.env);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: join(root, "candidate"), env: { ...env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid" } });
      expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0); return result.stdout.toString().trim();
    };
    mkdirSync(join(root, "candidate/scripts"), { recursive: true });
    mkdirSync(join(root, "candidate/src/components"), { recursive: true });
    mkdirSync(join(root, "candidate/.github/workflows"), { recursive: true });
    writeFileSync(join(root, "candidate/scripts/privacy-fixture.test.ts"), 'import "./fixture-rule";');
    writeFileSync(join(root, "candidate/scripts/fixture-rule.ts"), "export const value = true;");
    writeFileSync(join(root, "candidate/test-preload.ts"), "// trusted test preload\n");
    writeFileSync(join(root, "candidate/scripts/preload-helper.ts"), "export const value = true;\n");
    writeFileSync(join(root, "candidate/bunfig.toml"), '[test]\npreload = ["./test-preload.ts"]\n');
    writeFileSync(join(root, "candidate/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "candidate/package.json"), "{}\n");
    writeFileSync(join(root, "candidate/bun.lock"), "{}\n");
    git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null"); git("add", "."); git("commit", "-m", "scope baseline");
    const base = git("rev-parse", "HEAD");
    const clone = Bun.spawnSync(["git", "clone", "--quiet", join(root, "candidate"), join(root, "trusted")], { env });
    expect(clone.exitCode).toBe(0);
    mkdirSync(join(root, "trusted/scripts"), { recursive: true });
    mkdirSync(join(root, "trusted/src"), { recursive: true });
    writeFileSync(join(root, "trusted/scripts/ci-platform-scope.ts"), readFileSync(join(import.meta.dir, "ci-platform-scope.ts")));
    mkdirSync(join(root, "trusted/node_modules"));
    writeFileSync(join(root, "trusted/test-preload.ts"), 'import "./scripts/preload-helper";\n');
    writeFileSync(join(root, "trusted/scripts/preload-helper.ts"), "export const value = true;\n");
    for (const [file, expected] of [["src/components/fixture.ts", false], ["scripts/fixture-rule.ts", true], ["scripts/privacy-new.test.ts", true], [".github/workflows/privacy-publication.yml", true], ["test-preload.ts", true], ["scripts/preload-helper.ts", true], ["bunfig.toml", true], ["tsconfig.json", true], ["package.json", true], ["bun.lock", true]]) {
      git("checkout", "--detach", base);
      writeFileSync(join(root, "candidate", file as string), "// changed fixture\n"); git("add", "."); git("commit", "-m", "scope change");
      const output = join(root, "output"); writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", scope.run!], { cwd: join(root, "trusted"), env: { ...env, PRIVACY_BASE_SHA: base, GITHUB_OUTPUT: output } });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`run=${expected}\n`);

      if (file === "test-preload.ts") {
        writeFileSync(join(root, "candidate/test-preload.ts"), 'throw new Error("broken privacy preload");\n');
        git("add", "."); git("commit", "--amend", "--no-edit");
        writeFileSync(output, "");
        const preloadScope = Bun.spawnSync(["bash", "-e", "-c", scope.run!], { cwd: join(root, "trusted"), env: { ...env, PRIVACY_BASE_SHA: base, GITHUB_OUTPUT: output } });
        expect(preloadScope.exitCode, preloadScope.stderr.toString()).toBe(0);
        expect(readFileSync(output, "utf8")).toBe("run=true\n");
        const candidate = step(jobs[0]!, "Verify candidate privacy gate behavior within budget");
        const candidateRun = Bun.spawnSync(["bash", "-e", "-c", candidate.run!], { cwd: join(root, "candidate"), env, stdout: "pipe", stderr: "pipe" });
        expect(candidateRun.exitCode).not.toBe(0);
        expect(candidateRun.stderr.toString()).toContain("broken privacy preload");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
