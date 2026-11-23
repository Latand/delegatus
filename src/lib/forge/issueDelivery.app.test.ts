import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPipeline } from "@/lib/pipelines/store";
import { statePath } from "@/lib/configDir";
import { scheduleAutoMerge, resetAutoMergeForTests } from "./autoMerge";
import { emptyRepositoryEntry, forgeViewOf, type ForgeCacheFile } from "./cache";
import { caseSensitiveAppFixture } from "./appWrite.fixture";
import { FORGE_DIR_ENV, HELPER_FILE } from "../../../bin/forge-app-token.mjs";
import { agentForgeDir } from "@/lib/git/agentForgeCredentials";
import { batchLandingFixture } from "./batchLanding.fixture";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-delivery-app-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const REPO = "acme/widgets";
const AT = "2026-11-01T12:00:00.000Z";
const NOW = Date.parse(AT) + 1000;
const required = { issues: "write", pull_requests: "read", metadata: "read" };
const landingPermissions = { contents: "read", metadata: "read" };

function nativeGitPath(): string | undefined {
  const directories = (process.env.PATH ?? "").split(path.delimiter)
    .filter(directory => !/\/delegatus\/agent-(?:git-hooks|forge)\//.test(directory));
  return directories.map(directory => path.join(directory, "git"))
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

test.skipIf(process.platform === "win32").each([
  "close", "part", "missing-pr", "missing-issues", "manual-batch", "missing-landing", "cold-batch",
  "associated-batch", "associated-reverted-before", "associated-restored-later", "associated-reverted-after",
  "associated-merge", "associated-merge-reverted-before",
] as const)("private App issue settlement handles %s through the production scheduler", async mode => {
  const directory = path.join(root, mode);
  const granted: Record<string, string> = { ...required };
  if (mode === "missing-pr") delete granted.pull_requests;
  if (mode === "missing-issues") delete granted.issues;
  const associated = mode.startsWith("associated-");
  const cold = mode === "cold-batch" || mode === "missing-landing";
  const carried = associated || cold || mode === "manual-batch";
  if (carried && mode !== "missing-landing") granted.contents = "read";
  const app = caseSensitiveAppFixture(directory, granted);
  const kind = associated ? mode.replace("associated-", "carrier-") : "rebased";
  const graph = carried ? batchLandingFixture(directory, kind) : null;
  const dataFile = path.join(directory, "issue.json");
  const callsFile = path.join(directory, "gh-calls.jsonl");
  const gitCallsFile = path.join(directory, "git-calls.jsonl");
  const clone = path.join(directory, "lane-clone");
  const nativeGit = nativeGitPath();
  if (!nativeGit) throw new Error("Git is required for the landing fixture");
  if (graph && cold) {
    graph.git("clone", "--no-local", "--single-branch", "--branch", "lane", graph.directory, clone);
    for (const sha of [graph.landing, graph.tip, graph.base]) {
      expect(Bun.spawnSync(["git", "cat-file", "-e", sha], { cwd: clone, stderr: "ignore" }).exitCode).toBe(1);
    }
    fs.writeFileSync(path.join(directory, "git"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "fetch") {
  const env = process.env;
  const expected = Buffer.from(["x-access-token", "fixture-landing"].join(":")).toString("base64");
  const header = ["AUTH", "ORIZATION"].join("") + ": " + ["ba", "sic"].join("") + " " + expected;
  const scoped = env.GIT_CONFIG_COUNT === "2"
    && env.GIT_CONFIG_KEY_0 === "http.https://github.com/acme/widgets.git.extraheader"
    && env.GIT_CONFIG_VALUE_0 === header
    && env.GIT_CONFIG_KEY_1 === "credential.helper" && env.GIT_CONFIG_VALUE_1 === ""
    && env.GIT_CONFIG_GLOBAL === "/dev/null" && env.GIT_CONFIG_NOSYSTEM === "1"
    && env.GIT_TERMINAL_PROMPT === "0";
  const noPersonal = env.GIT_ASKPASS === "" && env.GIT_CONFIG_PARAMETERS === undefined;
  const fs = await import("node:fs");
  fs.appendFileSync(${JSON.stringify(gitCallsFile)}, JSON.stringify({ scoped, noPersonal, objects: args.slice(args.indexOf("origin") + 1) }) + "\\n");
  if (!scoped) process.exit(1);
}
process.exit(Bun.spawnSync([${JSON.stringify(nativeGit)}, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exitCode);
`, { mode: 0o700 });
  }
  const oldDirectory = path.join(directory, "old-helper");
  fs.mkdirSync(oldDirectory);
  const stale = "process.exit(88);\n";
  fs.writeFileSync(path.join(oldDirectory, "forge-app-token.mjs"), stale);
  const source = { ...app.source, GH_TOKEN: "inherited", FIXTURE_ISSUE_DATA: dataFile, FIXTURE_GH_CALLS: callsFile, [FORGE_DIR_ENV]: oldDirectory,
    ...(cold ? { GIT_ASKPASS: "fixture-personal", GIT_CONFIG_PARAMETERS: "'credential.helper=fixture-personal'" } : {}) };
  const previous = Object.fromEntries(Object.keys(source).map(key => [key, process.env[key]]));
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  const host = globalThis as typeof globalThis & { __llvIssueDeliveryRunning?: Promise<unknown> | null; __llvAutoMergeRunning?: Promise<unknown> | null; __llvPostMergeRunning?: Promise<unknown> | null };
  resetAutoMergeForTests();
  try {
    Object.assign(process.env, source);
    const declaration = statePath("forge-app-repositories.json");
    fs.mkdirSync(path.dirname(declaration), { recursive: true });
    fs.writeFileSync(declaration, JSON.stringify([app.repository]));
    const lane = buildPipeline({ id: "delivery", task: "Issue #7: Widgets", taskIds: [], project: "fixture", repoDir: "fixture", stages: [], srcPath: null, srcConversationId: null, now: AT });
    lane.delivery = { target: { repository: "repo-fixture-identity", remote: `https://github.com/${REPO}.git`, branch: "refs/heads/pipeline/widgets", pr: 9 }, disposition: "owner", publish: "disabled", ownerId: "delivery", epoch: 1, active: false, journal: [] };
    lane.state = "completed"; lane.closedAt = AT;
    lane.merge = { state: "merged", by: "outside", repository: REPO, prNumber: 9, mergedAt: AT,
      policyChangedAt: AT, reviewedHead: "a".repeat(40), chain: ["a".repeat(40)], updates: [], seenChecks: [],
      head: null, headSeenAt: null, lastChecks: null, readAt: null, nextReadAt: null, requestedAt: AT,
      mergedHead: null, mergeCommit: null, method: null, attempts: 0, reason: null, blockedAt: null, updatedAt: AT };
    lane.workLinks = [{ repository: REPO, number: 7, kind: "issue", addedAt: AT, addedBy: "agent", ...(mode === "part" ? { part: true as const } : {}) }];
    const data: ForgeCacheFile = { schemaVersion: 1, repositories: {} };
    if (graph) {
      lane.merge = undefined; lane.lastPassedCommit = graph.head;
      lane.repoDir = cold ? clone : graph.directory;
      data.repositories[REPO] = emptyRepositoryEntry();
      data.repositories[REPO]!.prs["9"] = { url: `https://github.com/${REPO}/pull/9`, state: "closed", headRefName: "pipeline/widgets", createdAt: AT, checkedAt: AT, closes: [] };
    }
    const legacyBatch = mode === "associated-restored-later";
    if (legacyBatch) lane.issueDelivery = [{ repository: REPO, number: 7, pr: 9, batch: 10, mode: "close", at: AT, state: "pending" }];
    fs.writeFileSync(dataFile, JSON.stringify({
      issue: { state: mode === "part" ? "closed" : "open", state_reason: mode === "part" ? "completed" : null }, comments: [],
      primary: { number: 9, state: "closed", merged_at: carried && !associated ? null : AT, title: "Widget controls",
        ...(associated ? { merge_commit_sha: graph?.landing } : {}),
        head: { ref: "pipeline/widgets", sha: graph?.head ?? "a".repeat(40) },
        base: { ref: carried ? "integration/widgets" : "main", repo: { default_branch: "main" } } },
      ...(graph ? { landing: graph.landing, baseTip: graph.base, graphDir: graph.directory,
        carrier: { number: 10, state: "closed", merged_at: AT, merge_commit_sha: graph.tip,
          title: legacyBatch ? "Merge batch: #9" : "Widget batch",
          head: { ref: legacyBatch ? "merge-batch/widgets" : "integration/widgets" }, base: { ref: "main", repo: { default_branch: "main" } } } } : {}),
    }));
    fs.writeFileSync(path.join(directory, "gh"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2), route = args[1];
const identity = ["fixture", "fixture-landing"].includes(process.env.GH_TOKEN) ? "app" : "personal";
fs.appendFileSync(process.env.FIXTURE_GH_CALLS, JSON.stringify({ identity, args }) + "\\n");
if (identity !== "app") { console.error("HTTP 403: unexpected identity"); process.exit(1); }
const permissions = JSON.parse(fs.readFileSync(process.env.FIXTURE_ISSUED_PERMISSIONS + (process.env.GH_TOKEN === "fixture-landing" ? ".landing" : ""), "utf8"));
const need = name => { if (!["read", "write"].includes(permissions[name])) { console.error("HTTP 403: permission unavailable"); process.exit(1); } };
const value = JSON.parse(fs.readFileSync(process.env.FIXTURE_ISSUE_DATA, "utf8"));
let result;
if (route.includes("/pulls/")) { need("pull_requests"); result = route.endsWith("/10") ? value.carrier : value.primary; }
else if (route.includes("/commits/")) { need("pull_requests"); result = [value.carrier]; }
else if (route.includes("/branches/")) { need("contents"); result = value.baseTip; }
else if (route.includes("/compare/")) {
  need("contents");
  const [sha, target] = route.split("/compare/")[1].split("?")[0].split("...");
  const ancestor = Bun.spawnSync([${JSON.stringify(nativeGit)}, "merge-base", "--is-ancestor", sha, target], { cwd: value.graphDir, stderr: "inherit" });
  result = { status: ancestor.exitCode === 0 ? "ahead" : "diverged", merge_base_commit: { sha } };
}
else if (route.includes("/issues/9/comments")) {
  need("issues");
  result = value.primary.merged_at ? undefined : { body: "Включено комітом " + value.landing + ".", author_association: "NONE" };
}
else if (route === "graphql") { need("issues"); need("pull_requests"); result = { data: { repository: { issue: { timelineItems: { nodes: [{ closer: { number: 9, repository: { nameWithOwner: "acme/widgets" } } }] } } } } }; }
else {
  need("issues");
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  if (method !== "GET" && permissions.issues !== "write") { console.error("HTTP 403: write unavailable"); process.exit(1); }
  const fields = args.filter((_, i) => args[i - 1] === "-f");
  if (fields.includes("state=open")) { value.issue.state = "open"; value.issue.state_reason = null; }
  if (fields.includes("state=closed")) { value.issue.state = "closed"; value.issue.state_reason = fields.includes("state_reason=completed") ? "completed" : null; }
  const body = fields.find(field => field.startsWith("body="));
  if (body) value.comments.push({ body: body.slice(5), created_at: value.carrier?.merged_at ?? value.primary.merged_at });
  result = route.includes("/comments") ? value.comments : value.issue;
  fs.writeFileSync(process.env.FIXTURE_ISSUE_DATA, JSON.stringify(value));
}
process.stdout.write(route.includes("/branches/") ? String(result) : JSON.stringify(result));
`, { mode: 0o700 });
    scheduleAutoMerge({ loadPipelines: () => [], now: () => NOW, log: () => {}, issueDelivery: {
      loadPipelines: () => [lane], since: () => AT, loadTasks: () => [], repositoryOf: () => REPO,
      pullRequestOf: () => ({ repository: REPO, number: 9 }), cache: () => ({ data, view: forgeViewOf(data) }),
      inspectTitle: async () => true, mutate: async (_id, change) => change(lane),
    } });
    await Promise.all([host.__llvIssueDeliveryRunning, host.__llvAutoMergeRunning, host.__llvPostMergeRunning]);
    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const calls: Array<{ identity: string; args: string[] }> = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    expect(calls.every(call => call.identity === "app")).toBe(true);
    if (associated) expect(calls.some(call => call.args[1]?.includes("/issues/9/comments"))).toBe(false);
    if (cold) {
      const gitCalls: Array<{ scoped: boolean; noPersonal: boolean; objects: string[] }> = fs.existsSync(gitCallsFile)
        ? fs.readFileSync(gitCallsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      if (mode === "missing-landing") expect(gitCalls).toEqual([]);
      else {
        if (!graph) throw new Error("Cold batch fixture is missing");
        expect(gitCalls).toEqual([
          { scoped: true, noPersonal: true, objects: [graph.landing] },
          { scoped: true, noPersonal: true, objects: [graph.tip, graph.base] },
        ]);
      }
    }
    if (mode.startsWith("missing-")) {
      expect(saved.issue.state).toBe("open");
      expect(saved.comments).toEqual([]);
      expect(lane.issueDelivery).toMatchObject([{ state: "refused", reason: "app-permission" }]);
      if (mode === "missing-landing") {
        expect(app.tokens().map(token => token.permissions)).toEqual([required]);
      } else {
        expect(app.tokens()).toEqual([]);
        expect(calls).toEqual([]);
      }
    } else if (associated && (mode.includes("reverted") || mode === "associated-restored-later")) {
      expect(calls.some(call => call.args.includes("--method"))).toBe(false);
      expect(saved.issue.state).toBe("open");
      expect(saved.comments).toEqual([]);
      expect(lane.issueDelivery).toMatchObject([{ state: "pending", failures: 1 }]);
      expect(app.tokens().map(token => token.permissions)).toEqual([required, landingPermissions]);
    } else {
      expect(lane.issueDelivery).toMatchObject([{ state: mode === "part" ? "reopened" : "closed" }]);
      expect(saved.issue.state).toBe(mode === "part" ? "open" : "closed");
      expect(saved.comments).toHaveLength(1);
      expect(app.tokens().map(token => token.permissions)).toEqual(carried ? [required, landingPermissions] : [required]);
    }
    expect(fs.readFileSync(path.join(oldDirectory, "forge-app-token.mjs"), "utf8")).toBe(stale);
  } finally {
    await Promise.allSettled([host.__llvIssueDeliveryRunning, host.__llvAutoMergeRunning, host.__llvPostMergeRunning]);
    resetAutoMergeForTests(); clock.mockRestore();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test.skipIf(process.platform === "win32")("the copied helper refuses conflicting issue purposes before issuing a token", async () => {
  const directory = path.join(root, "conflicting-purposes");
  const app = caseSensitiveAppFixture(directory, required);
  const helper = path.join(agentForgeDir(app.source), HELPER_FILE);
  const child = Bun.spawn([path.join(directory, "bun"), helper, "token", "--repository", app.repository, "--json", "--issues", "--issue-delivery"], {
    env: app.source, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toContain("conflicting token permission purposes");
  expect(app.requests()).toEqual([]);
});
