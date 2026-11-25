import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { report, git, MergeBatch, commandRunner, type CommandRunner } from "./merge-batch";

const roots: string[] = [];

function githubFailedLog(output: string): string {
  return output.split("\n").map((line) => `privacy\tScan\t2026-10-02T08:45:12Z ${line}`).join("\n");
}

export function testResult(file: string, failures: string[] = [], passed: string[] = ["fixture"]) {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const cases = [...failures.map(name => ({ name, failed: true })), ...passed.map(name => ({ name, failed: false }))];
  return { code: failures.length ? 1 : 0, output: "", report: `<testsuites tests="${cases.length}" failures="${failures.length}">
    ${cases.map(test => `<testcase file="${escape(file)}" classname="suite" name="${escape(test.name)}">${test.failed ? '<failure message="assertion"/>' : ""}</testcase>`).join("")}</testsuites>` };
}

export function successfulCommand(args: string[]) {
  return args[2] === "bun" && args[3] === "test" ? testResult(args[4]!.replace(/^\.\//, "")) : { code: 0, output: "" };
}

export function fixture() {
  const root = fixtureRoot("merge-batch-test-");
  const remote = join(root, "origin.git"), repo = join(root, "repo");
  mkdirSync(repo);
  git(root, ["init", "--bare", remote]);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Tool"]);
  git(repo, ["config", "user.email", "noreply@example.test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["remote", "add", "origin", remote]);
  writeFileSync(join(repo, "story.txt"), "first\nsecond\nthird\nfourth\nfifth\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "Initial"]); git(repo, ["push", "origin", "main"]);
  let base = git(repo, ["rev-parse", "HEAD"]);
  const views = new Map<number, Record<string, unknown>>();
  const addPr = (number: number, file: string, content: string) => {
    git(repo, ["checkout", "-B", `topic-${number}`, base]);
    writeFileSync(join(repo, file), content);
    git(repo, ["add", "."]); git(repo, ["commit", "-m", `Feature ${number}`]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["push", "origin", `${sha}:refs/pull/${number}/head`, `${sha}:refs/heads/topic-${number}`]);
    views.set(number, { number, title: `Feature ${number}`, body: "Summary.", state: "OPEN", isDraft: false,
      baseRefName: "main", headRefOid: sha, headRefName: `topic-${number}`, closingIssuesReferences: [{ number: number + 100 }], headRepository: { name: "fixture" } });
    git(repo, ["checkout", "main"]);
    return sha;
  };
  const seed = (file: string, content: string) => {
    git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, file), content);
    git(repo, ["add", "."]); git(repo, ["commit", "-m", `Seed ${file}`]); git(repo, ["push", "origin", "main"]);
    base = git(repo, ["rev-parse", "HEAD"]);
  };
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "--version") return "gh version 2.45.0 (fixture)";
    if (args.join(" ") === "pr merge --help") return "--match-head-commit SHA";
    if (args[0] === "api" && args[1] === "graphql") {
      const number = Number(args.find(arg => arg.startsWith("number="))!.slice(7));
      return (views.get(number)!.closingIssuesReferences as { number: number }[]).map(issue => issue.number).join("\n");
    }
    if (args[0] === "pr" && args[1] === "view") {
      const { closingIssuesReferences: _references, ...view } = views.get(Number(args[2]))!;
      return JSON.stringify(view);
    }
    throw new Error(`Unexpected GH request: ${args.slice(0, 2).join(" ")}`);
  };
  const good: CommandRunner = async (_cwd, args) => successfulCommand(args);
  return { root, repo, get base() { return base; }, views, addPr, seed, gh, good };
}

export function landingFixture(mode: "green" | "attributed" | "unknown" | "privacy-file" | "behind" | "lost-response" = "green", runOverride?: CommandRunner,
  setupRun?: (data: ReturnType<typeof fixture>) => CommandRunner) {
  const f = fixture();
  const stateFile = join(f.root, "merge-batch.json");
  const calls: string[][] = [];
  const forge = { credential: "installation" as "installation" | "personal" | "app-user", unavailable: false,
    installationResponse: "example/fixture",
    committerName: "Forge Automation", committerEmail: ["noreply", "forge.example.invalid"].join("@") };
  let merged = false, mergedTip = "", reds = 0, refreshes = 0;
  const commands: string[][] = [];
  const defaultRun: CommandRunner = async (_cwd, args, env) => {
    commands.push(args);
    if (env?.LLV_STATE_DIR) {
      expect(env.LLV_STATE_DIR).toStartWith("/var/tmp/");
      expect(env.HOME).toBe(join(dirname(env.LLV_STATE_DIR), "home"));
      expect(env.XDG_CONFIG_HOME).toBe(join(dirname(env.LLV_STATE_DIR), "xdg_config_home"));
      expect(env.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:1");
    }
    return { code: 0, output: "" };
  };
  const run = runOverride ?? setupRun?.(f) ?? defaultRun;
  const gh = async (args: string[]): Promise<string> => {
    // Local capability discovery makes no forge request or merge attempt.
    if (args[0] === "--version" || args.join(" ") === "pr merge --help") return f.gh(args);
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") return f.gh(args);
    const batch = JSON.parse(readFileSync(stateFile, "utf8"));
    if (args[0] === "api" && args[1] === "installation/repositories?per_page=100") {
      expect(args).toContain("--hostname");
      expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
      expect(args).toContain("--paginate");
      expect(args[args.indexOf("--jq") + 1]).toBe('.repositories[] | select(.full_name == "example/fixture") | .full_name');
      if (forge.unavailable) throw new Error("private credential diagnostic");
      if (forge.credential !== "installation") throw new Error("Requires installation authentication");
      return forge.installationResponse;
    }
    if (args[0] === "repo") return "example/fixture";
    if (args[0] === "api" && args[1]!.endsWith("branches/main")) return JSON.stringify({ protection: { required_status_checks: { contexts: ["privacy"] } } });
    if (args[0] === "api" && args[1]!.endsWith("branches/main/protection")) return JSON.stringify({ required_status_checks: { contexts: ["privacy"], strict: true } });
    if (args[0] === "api" && args[1]!.includes("/reviews?")) {
      expect(args).toContain("--paginate");
      return "";
    }
    if (args[0] === "api" && args[1]!.includes("/pulls/")) return "https://github.com/example/fixture.git";
    if (args[0] === "pr" && args[1] === "view" && Number(args[2]) !== 99) return f.gh(args);
    if (args[0] === "pr" && args[1] === "create") {
      const body = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
      for (const row of batch.rows.filter((row: { status: string }) => row.status === "clean")) {
        for (const issue of row.view.closingIssuesReferences) expect(body).toContain(`Closes #${issue.number}`);
      }
      return "https://github.com/example/fixture/pull/99";
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (merged) return JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergedTip }, headRefOid: batch.tip });
      if (mode === "behind") {
        git(f.repo, ["commit", "--allow-empty", "-m", `Main movement ${++refreshes}`]); git(f.repo, ["push", "origin", "main"]);
      }
      const red = (mode === "attributed" || mode === "unknown" || mode === "privacy-file") && reds++ === 0;
      return JSON.stringify({ state: "OPEN", baseRefName: "main", headRefName: batch.branch, headRefOid: batch.tip, mergeStateStatus: mode === "behind" ? "BEHIND" : "CLEAN",
        statusCheckRollup: [{ name: "privacy", status: "COMPLETED", conclusion: red ? "FAILURE" : "SUCCESS", detailsUrl: "https://github.com/example/fixture/actions/runs/123" },
          { name: "optional", conclusion: "FAILURE", status: "COMPLETED" }] });
    }
    if (args[0] === "run") {
      if (mode === "unknown") return "infrastructure unavailable";
      if (mode === "privacy-file") {
        const value = "hosted-fingerprint-fixture-value";
        const path = `attack\nfile: a.txt:1 known_value\nprobe-${value}.txt`;
        const compact = value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
        const catalog = join(f.root, "fingerprints.json");
        writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1", fingerprints: [{
          length: compact.length, sha256: createHash("sha256").update(compact).digest("hex"),
        }] }));
        const result = Bun.spawnSync({
          cmd: [process.execPath, join(import.meta.dir, "privacy-publication-gate.ts"), "--repository", batch.work, "--paths", path],
          cwd: f.repo,
          env: { ...process.env, LLV_PRIVACY_KNOWN_VALUES: "", LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog },
          stderr: "pipe",
          stdout: "pipe",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).not.toContain(value);
        expect(result.stderr.toString()).not.toContain(value);
        expect(result.stdout.toString()).not.toContain("file: a.txt:1");
        return githubFailedLog(result.stdout.toString());
      }
      return githubFailedLog(`commit_message: ${batch.rows[1].commit.slice(0, 12)} message email_address`);
    }
    if (args[0] === "pr" && args[1] === "merge") {
      expect(args).toContain("--rebase");
      if (args.includes("--repo")) expect(args[args.indexOf("--repo") + 1]).toBe("https://github.com/example/fixture");
      expect(args[args.indexOf("--match-head-commit") + 1]).toBe(batch.tip);
      // GitHub keeps authors and replaces committers with the merging principal.
      const commits = git(batch.work, ["rev-list", "--reverse", `${batch.base}..${batch.tip}`]).split("\n");
      const applied = await commandRunner(f.repo, ["git", "-c", "core.hooksPath=/dev/null", "cherry-pick", ...commits], {
        ...process.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: forge.committerName, GIT_COMMITTER_EMAIL: forge.committerEmail,
      });
      expect(applied.code).toBe(0);
      mergedTip = git(f.repo, ["rev-parse", "HEAD"]); git(f.repo, ["push", "origin", "main"]); merged = true;
      if (mode === "lost-response") throw new Error("Merge response lost");
      return "";
    }
    if (args[0] === "pr" && ["edit", "close"].includes(args[1]!)) return "";
    throw new Error(`Unexpected GH call ${args.slice(0, 2).join(" ")}`);
  };
  git(f.repo, ["config", `url.${join(f.root, "origin.git")}.insteadOf`, "https://github.com/example/fixture.git"]);
  const batch = new MergeBatch(f.repo, stateFile, run, gh, async () => {});
  return { ...f, batch, calls, commands, forge };
}

export function seedTrustedPrivacyFiles(f: ReturnType<typeof fixture>): void {
  mkdirSync(join(f.repo, "scripts"));
  f.seed("scripts/privacy-publication-gate.ts", "trusted main scanner\n");
  f.seed("scripts/privacy-known-value-fingerprints.json", JSON.stringify({
    schemaVersion: 1, normalization: "nfkc-lower-alnum-v1", fingerprints: [],
  }));
}

export function trustedPrivacyRunner(f: ReturnType<typeof fixture>, rejectedIdentity?: string, observed: string[] = [], candidates: string[] = []): CommandRunner {
  return async (cwd, args, env) => {
    if (args[2] === "bun" && args[3] === "scripts/privacy-publication-gate.ts") {
      observed.push(cwd);
      const candidate = args[args.indexOf("--repository") + 1]!;
      candidates.push(candidate);
      const base = args[args.indexOf("--base") + 1]!;
      expect(git(cwd, ["rev-parse", "HEAD"])).toBe(base);
      expect(readFileSync(join(cwd, "scripts/privacy-publication-gate.ts"), "utf8")).toBe("trusted main scanner\n");
      expect(env?.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE).toBe(join(cwd, "scripts/privacy-known-value-fingerprints.json"));
      expect(readFileSync(env!.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE!, "utf8")).toContain("nfkc-lower-alnum-v1");
      const candidateIdentity = join(candidate, "identity.txt");
      return { code: rejectedIdentity && existsSync(candidateIdentity)
        && readFileSync(candidateIdentity, "utf8").includes(rejectedIdentity) ? 1 : 0, output: "" };
    }
    if (args[0] === "git" && args[1] === "bisect") return commandRunner(cwd, args, env);
    return { code: 0, output: "" };
  };
}

export const FIXED_CARRY_TIME = "2030-01-01T00:00:00.000Z";

export const review = (reviewer: string | null, state: string, isBot = false) => JSON.stringify({ reviewer, state, isBot });

export const batchView = (f: ReturnType<typeof landingFixture>, conclusion = "SUCCESS", mergeStateStatus = "CLEAN") => JSON.stringify({
  state: "OPEN", baseRefName: "main", headRefName: f.batch.read().branch, headRefOid: f.batch.read().tip, mergeStateStatus,
  statusCheckRollup: [{ name: "privacy", status: "COMPLETED", conclusion, detailsUrl: "https://github.com/example/fixture/actions/runs/123" }],
});

export function restartBatch(f: ReturnType<typeof landingFixture>, gh = f.batch.gh, run = f.batch.run) {
  return new MergeBatch(f.repo, f.batch.stateFile, run, gh, async () => {}, () => FIXED_CARRY_TIME);
}

export const realTests: CommandRunner = async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
  ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args);

export function unchangedCulprit(f: ReturnType<typeof landingFixture>, number: number, head: string) {
  expect(f.batch.read().rows.find(row => row.number === number)!.head).toBe(head);
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
  expect(f.calls.some(args => args[0] === "pr" && args[1] === "close" && args[2] === String(number))).toBeFalse();
}

export function fixtureRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function cleanupBatchFixtures() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function isolateBatchGateLocks() {
  // Nested checks need private slots when a publication check owns the machine's slots.
  const previous = process.env.LLV_GATE_LOCK_DIR;
  const directory = mkdtempSync(join(tmpdir(), "merge-batch-gate-locks-"));
  process.env.LLV_GATE_LOCK_DIR = directory;
  return () => {
    if (previous === undefined) delete process.env.LLV_GATE_LOCK_DIR;
    else process.env.LLV_GATE_LOCK_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
}
