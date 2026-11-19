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
type Job = { if?: string; steps: Step[] };
const names = ["privacy-publication", "privacy-tracker-audit"];
const workflows = names.map((name) => {
  const source = readFileSync(join(import.meta.dir, "..", ".github/workflows", `${name}.yml`), "utf8");
  return Bun.YAML.parse(source) as {
    // Bun 1.3's YAML 1.1 parser resolves unquoted `on` to `true`; Bun 1.4 keeps it as a string.
    on?: { schedule?: { cron: string }[]; push?: { branches: string[] } };
    true?: { schedule?: { cron: string }[]; push?: { branches: string[] } };
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
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_EVENT_NAME: "pull_request", CALL_LOG: log, BASELINE_EXIT: "1", SCAN_EXIT: "0", CANDIDATE_EXIT: "0", STALL_DIRECTORY: "", ...extra },
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
  const result = runPublication({ STALL_DIRECTORY: "trusted" }, "1s");
  expect(result.code).toBe(0);
  expect(result.text).toContain("::warning title=Trusted privacy self-tests::");
  expect(result.baselineCode).toBe(124);
  expect(result.calls).toEqual(["trusted:test", "trusted:scripts/privacy-publication-gate.ts", "candidate:test"]);
});

test("a stalled candidate still refuses publication after a red baseline", () => {
  const result = runPublication({ STALL_DIRECTORY: "candidate" }, "1s");
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

test("nightly runs the complete default-branch suite and propagates its exit status", () => {
  const publication = workflows[0]!;
  const trigger = publication.on ?? publication.true;
  expect(trigger?.schedule?.[0]?.cron).toBe("31 2 * * *");
  const nightly = publication.jobs["nightly-privacy-self-tests"]!;
  expect(nightly.if).toBe("github.event_name == 'schedule'");
  expect(nightly.steps.at(-1)?.run).toBe("bun test scripts/privacy-*.test.ts");
  expect(nightly.steps.at(-1)?.["continue-on-error"]).toBeUndefined();
  const tracker = workflows[1]!;
  expect((tracker.on ?? tracker.true)?.push?.branches).toEqual(["main"]);
  expect(step(jobs[1]!, "Audit public tracker surfaces").if).toBe("github.event_name != 'push'");
  expect(step(jobs[0]!, "Check out candidate as inspection input").with?.ref)
    .toBe("${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}");
});

test("PR self-tests use the trusted import closure and workflow changes while inspection always runs", () => {
  const job = jobs[0]!;
  expect(step(job, "Verify privacy gate behavior").if).toBe("steps.privacy-scope.outputs.run == 'true'");
  const scope = step(job, "Scope candidate privacy self-tests with trusted code");
  expect(scope.if).toBe("github.event_name != 'push'");
  expect(scope["working-directory"]).toBe("trusted");
  expect(job.steps.indexOf(scope)).toBeLessThan(job.steps.indexOf(step(job, "Verify privacy gate behavior")));
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
    // A release sees the result on the main push. Its scan covers the commit
    // that just landed even when the protected ref already points at that tip.
    git("commit", "--allow-empty", "-m", "landed change");
    const landed = git("rev-parse", "HEAD");
    const resolveBase = step(job, "Resolve current protected base");
    for (const [event, expected] of [["push", base], ["pull_request", landed]] as const) {
      const environmentFile = join(root, "resolved-" + event);
      const resolved = Bun.spawnSync(["bash", "-e", "-c", resolveBase.run!], {
        cwd: join(root, "trusted"), env: { ...env, PRIVACY_BASE_REF: "main", PUSH_BEFORE: base, GITHUB_EVENT_NAME: event, GITHUB_ENV: environmentFile },
      });
      expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
      expect(readFileSync(environmentFile, "utf8")).toBe("PRIVACY_BASE_SHA=" + expected + "\n");
    }
    for (const [file, expected] of [["src/components/fixture.ts", false], ["scripts/fixture-rule.ts", true], ["scripts/privacy-new.test.ts", true], ["scripts/privacy-fixture.json", true], ["scripts/generate-privacy-sample.ts", true], [".github/workflows/privacy-tracker-audit.yml", true], [".github/workflows/privacy-publication.yml", true], ["test-preload.ts", true], ["scripts/preload-helper.ts", true], ["bunfig.toml", true], ["tsconfig.json", true], ["package.json", true], ["bun.lock", true]]) {
      git("checkout", "--detach", base);
      mkdirSync(join(root, "candidate", file as string, ".."), { recursive: true });
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


// Run the actual guard against committed fixtures; candidate files are data.
for (const [index, job] of jobs.entries()) {
  test(`${names[index]} refuses mixed privacy changes and allows isolated repairs`, () => {
    const root = mkdtempSync(join(tmpdir(), "privacy-change-isolation-"));
    try {
      const env = isolatedEnvironment(join(root, "env"), process.env);
      const trusted = index === 0 ? join(root, "trusted") : root;
      const candidate = join(root, "candidate");
      mkdirSync(trusted, { recursive: true });
      mkdirSync(candidate, { recursive: true });
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: candidate, env: {
          ...env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test",
          GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
        }, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return result.stdout.toString().trim();
      };
      git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null");
      writeFileSync(join(candidate, "README.md"), "fixture\n");
      git("add", "."); git("commit", "-m", "baseline");
      const base = git("rev-parse", "HEAD");
      const cases: [string[], number][] = [
        [[".github/workflows/privacy-publication.yml"], 0],
        [[".github/workflows/privacy-tracker-audit.yml", ".github/workflows/dependabot-lockfile.yml", "scripts/privacy-fixture.test.ts"], 0],
        [["scripts/privacy-publication-gate.ts", "src/lib/privacy/mailbox.ts"], 0],
        [["scripts/generate-privacy-known-value-fingerprints.ts"], 0],
        [["src/product.ts"], 0],
        [[".github/workflows/privacy-publication.yml", "src/product.ts"], 1],
        [[".github/workflows/privacy-tracker-audit.yml", "README.md"], 1],
        [["scripts/privacy-publication-gate.ts", "src/product.ts"], 1],
        [["src/lib/privacy/mailbox.ts", "src/product.ts"], 1],
        [["src/lib/environmentIsolation.ts", "src/product.ts"], 1],
      ];
      const guard = step(job, "Refuse mixed privacy repairs");
      // Review and review-comment events also carry a PR and must run the guard.
      expect(guard.if).toBe("github.event.pull_request != null");
      if (index === 1) expect(step(job, "Check out candidate as inspection input").if).toBe(guard.if);
      for (const [files, expected] of cases) {
        git("checkout", "--detach", base);
        for (const file of files) {
          mkdirSync(join(candidate, file, ".."), { recursive: true });
          // Executing a candidate file would fail even an allowed repair.
          writeFileSync(join(candidate, file), 'throw new Error("candidate must not execute");\n');
        }
        git("add", "."); git("commit", "-m", "change fixture");
        const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", guard.run!], {
          cwd: trusted, env: { ...env, PRIVACY_GUARD_BASE: base }, stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode, `${files.join(", ")}: ${result.stderr}`).toBe(expected);
        if (expected === 1) expect(result.stderr.toString()).toContain("separate PR");
      }
      const unavailable = Bun.spawnSync(["bash", "-e", "-c", guard.run!], {
        cwd: trusted, env: { ...env, PRIVACY_GUARD_BASE: "missing-base" }, stdout: "pipe", stderr: "pipe",
      });
      expect(unavailable.exitCode).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const dependabot = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../.github/workflows/dependabot-lockfile.yml"), "utf8")) as {
  on?: Record<string, unknown>; true?: Record<string, unknown>; jobs: Record<string, Job>;
  concurrency: { group: string; "cancel-in-progress": boolean };
};
const refresh = dependabot.jobs["refresh-lockfile"]!;

function followupFixture() {
  const repo = "fixture/project";
  const sha = "a".repeat(40);
  const pr = { state: "open", user: { login: "dependabot[bot]", type: "Bot" },
    base: { repo: { full_name: repo }, ref: "main" }, head: { repo: { full_name: repo }, ref: "dependabot/npm/package", sha } };
  const event = { repository: { default_branch: "main" }, workflow_run: {
    path: ".github/workflows/privacy-publication.yml", event: "pull_request", conclusion: "success",
    actor: { login: "dependabot[bot]" }, head_repository: { full_name: repo },
    head_sha: sha, head_branch: pr.head.ref, pull_requests: [{ number: 7 }],
  } };
  const branch = { protected: false, commit: { sha } };
  return { repo, sha, pr, event, branch };
}
type FollowupFixture = ReturnType<typeof followupFixture>;

function dependabotProbe(mutate: (event: FollowupFixture["event"], pr: FollowupFixture["pr"], branch: FollowupFixture["branch"]) => void = () => {}, final = false, apiFailure = false) {
  const root = mkdtempSync(join(tmpdir(), "privacy-dependabot-followup-"));
  try {
    const { repo, sha, pr, event, branch } = followupFixture();
    mutate(event, pr, branch);
    for (const [name, value] of [["event", event], ["pr", pr], ["branch", branch]]) writeFileSync(join(root, `${name}.json`), JSON.stringify(value));
    writeFileSync(join(root, "gh"), `#!/bin/bash
if [[ "$API_FAILURE" == 1 ]]; then exit 1; fi
case "$2" in
  repos/*/pulls/*) cat "$FIXTURE_ROOT/pr.json" ;;
  repos/*/branches/*) cat "$FIXTURE_ROOT/branch.json" ;;
  users/*) echo 42 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, "git"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FIXTURE_ROOT/git-calls"\n', { mode: 0o755 });
    const output = join(root, "output"); writeFileSync(output, "");
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", step(refresh,
      final ? "Commit the refreshed lockfile" : "Validate the triggering run and current pull request").run!], {
      cwd: root, env: { ...isolatedEnvironment(join(root, "env"), process.env), PATH: `${root}:${process.env.PATH}`,
        FIXTURE_ROOT: root, GITHUB_EVENT_PATH: join(root, "event.json"), GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL: "https://github.com", HEAD_SHA: sha,
        HEAD_REF: "dependabot/npm/package", BASE_REF: "main", PR_NUMBER: "7", API_FAILURE: apiFailure ? "1" : "0" },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, output: readFileSync(output, "utf8"),
      calls: Bun.file(join(root, "git-calls")).size ? readFileSync(join(root, "git-calls"), "utf8") : "" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Dependabot follow-up admits only a successful same-repository privacy run and its current bot PR", () => {
  expect(dependabot.concurrency.group).toBe("dependabot-lockfile-${{ github.event.workflow_run.head_sha }}");
  expect(dependabot.concurrency["cancel-in-progress"]).toBe(false);
  expect(dependabotProbe().output).toContain("ready=true");
  // A maintainer can reopen a bot-authored PR; the fresh PR author is authority.
  expect(dependabotProbe(e => { e.workflow_run.actor.login = "fixture"; }).output).toContain("ready=true");
  const refusals = [
    (e: FollowupFixture["event"]) => { e.workflow_run.event = "workflow_dispatch"; },
    (e: FollowupFixture["event"]) => { e.workflow_run.conclusion = "failure"; },
    (e: FollowupFixture["event"]) => { e.workflow_run.path = ".github/workflows/other.yml"; },
    (e: FollowupFixture["event"]) => { e.workflow_run.head_repository.full_name = "fixture/fork"; },
    (e: FollowupFixture["event"]) => { e.workflow_run.pull_requests = []; },
    (e: FollowupFixture["event"]) => { e.workflow_run.pull_requests.push({ number: 8 }); },
    (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.state = "closed"; },
    (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.user.login = "fixture"; },
    (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.head.repo.full_name = "fixture/fork"; },
    (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.head.ref = "other"; },
    (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.head.sha = "b".repeat(40); },
    (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.base.ref = "other"; },
  ];
  for (const mutate of refusals) {
    const result = dependabotProbe(mutate);
    expect(result.code).toBe(0); expect(result.output).toBe(""); expect(result.calls).toBe("");
  }
  for (const mutate of [(_e: FollowupFixture["event"], _p: FollowupFixture["pr"], b: FollowupFixture["branch"]) => { b.protected = true; }, (_e: FollowupFixture["event"], _p: FollowupFixture["pr"], b: FollowupFixture["branch"]) => { b.commit.sha = "b".repeat(40); }]) {
    expect(dependabotProbe(mutate).code).toBe(1);
  }
  expect(dependabotProbe(undefined, false, true).code).not.toBe(0);
});

test("Dependabot rechecks head and protection after resolution before committing or pushing", () => {
  const allowed = dependabotProbe(undefined, true);
  expect(allowed.code).toBe(0); expect(allowed.output).toBe("published=true\n");
  expect(allowed.calls).toContain("commit -m chore(deps): refresh bun.lock --only -- bun.lock");
  expect(allowed.calls).toContain("push origin HEAD:refs/heads/dependabot/npm/package");
  for (const mutate of [(_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.head.sha = "b".repeat(40); }, (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.state = "closed"; }, (_e: FollowupFixture["event"], p: FollowupFixture["pr"]) => { p.base.ref = "other"; }]) {
    const refused = dependabotProbe(mutate, true);
    expect(refused.code).toBe(0); expect(refused.calls).toBe(""); expect(refused.output).toBe("");
  }
  for (const mutate of [(_e: FollowupFixture["event"], _p: FollowupFixture["pr"], b: FollowupFixture["branch"]) => { b.protected = true; }, (_e: FollowupFixture["event"], _p: FollowupFixture["pr"], b: FollowupFixture["branch"]) => { b.commit.sha = "b".repeat(40); }]) {
    const refused = dependabotProbe(mutate, true);
    expect(refused.code).toBe(1); expect(refused.calls).toBe("");
  }
  const failed = dependabotProbe(undefined, true, true);
  expect(failed.code).not.toBe(0); expect(failed.calls).toBe("");
});
