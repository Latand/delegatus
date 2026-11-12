import { expect, test, fs, path, SANDBOX, harness, OVERDUE, FINISHED_LANE, PROJECT, DEFAULT_SEAT_TICK_POLICY } from "./seatTickController.fixture";
import { gatherSeatTickInput, refreshSeatTickEvidence } from "./seatTickSources";
import { emptyRepositoryEntry, resetForgeCacheForTests, updateForgeCache } from "@/lib/forge/cache";
import type { Pipeline } from "@/lib/pipelines/types";

function repository(name: string) {
  const cwd = path.join(SANDBOX, name);
  fs.mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => {
    const nativeGit = process.platform === "win32" ? Bun.which("git")! : Bun.which("git", { PATH: "/usr/bin:/bin" })!;
    const result = Bun.spawnSync([nativeGit, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: {
      ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    } });
    if (result.exitCode !== 0) throw Error(`fixture git ${args[0]}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const write = (file: string, text: string) => fs.writeFileSync(path.join(cwd, file), text);
  git("init", "-b", "main");
  write("work.txt", "base\n");
  write("removed.txt", "remove this\n");
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-c", "finished-lane");
  write("work.txt", "delivered\n");
  git("commit", "-am", "first change");
  write(process.platform === "win32" ? "added file.txt" : ":(exclude)added file\nwith newline.txt", "new file\n");
  git("rm", "removed.txt");
  git("add", "."); git("commit", "-m", "second change");
  const tip = git("rev-parse", "HEAD");
  git("switch", "main");
  git("update-ref", "refs/remotes/origin/main", base);
  return { cwd, git, write, base, tip };
}

const scenarios = ["unlanded", "ancestor", "squash", "batch", "later-edit", "partial", "merged-record", "cached-merged",
  "cached-open", "cached-closed", "unrelated-merged", "reused-branch", "internal-research", "internal-prototype", "comparison",
  "local-base", "missing-base", "no-common-base", "refresh-merged", "refresh-internal", "internal-with-pr", "readonly-no-pr",
  "remote-readonly", "wrong-path", "empty-diff", "cached-fork", "refresh-cache", "cached-branch", "archived-merged",
  "unlanded-no-pr", "internal-open-pr"] as const;

test.each([...scenarios])("finished lane delivery: %s", async scenario => {
  const repo = repository(scenario);
  const { git, write, base, tip } = repo;
  if (["squash", "batch", "later-edit"].includes(scenario)) {
    if (scenario === "batch") { write("other.txt", "another lane\n"); git("add", "."); git("commit", "-m", "other lane"); }
    git("merge", "--squash", "finished-lane"); git("commit", "-m", "squashed delivery");
    if (scenario === "later-edit") { write("work.txt", "delivered and extended\n"); git("commit", "-am", "later improvement"); }
  } else if (scenario === "ancestor") git("merge", "--ff-only", "finished-lane");
  else if (scenario === "partial") { write("work.txt", "delivered\n"); git("commit", "-am", "partial delivery"); }
  else if (scenario === "wrong-path") { write("other.txt", "delivered\n"); git("add", "."); git("commit", "-m", "same blob at another path"); }
  else if (scenario === "no-common-base") {
    git("switch", "--orphan", "unrelated");
    write("other.txt", "unrelated root\n"); git("add", "."); git("commit", "-m", "other root");
  }
  if (scenario === "empty-diff") {
    git("switch", "finished-lane"); git("read-tree", "--reset", "-u", base); git("commit", "-m", "revert lane work"); git("switch", "main");
  }
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  if (scenario === "local-base") git("update-ref", "-d", "refs/remotes/origin/main");
  // The preferred remote must win over a stale local main.
  if (["squash", "batch", "later-edit"].includes(scenario)) git("update-ref", "refs/heads/main", base);
  const rig = harness({ pipelines: [...FINISHED_LANE], state: OVERDUE });
  const template = rig.deps.sources!.pipelines()[0]!;
  let lane = { ...template, repoDir: repo.cwd, baseBranch: scenario === "missing-base" ? "absent" : "main",
    baseRef: base, branch: "finished-lane", lastPassedCommit: scenario === "empty-diff" ? git("rev-parse", "finished-lane") : tip,
    delivery: { target: { repository: PROJECT, remote: "https://github.com/acme/widgets.git", branch: "refs/heads/finished-lane", pr: 17 },
      disposition: "owner", publish: "disabled", ownerId: template.id, epoch: 1, active: false, journal: [] },
  } as Pipeline;
  if (scenario === "internal-research" || scenario === "internal-prototype") {
    lane = { ...lane, publication: "internal", delivery: undefined, stages: scenario === "internal-prototype"
      ? [{ id: "prototype", kind: "run", next: null, onFail: null, prompt: "", effectiveRole: { access: "read-write" } } as never]
      : [{ id: "research", kind: "run", next: null, onFail: null, prompt: "", effectiveRole: { access: "read-only" } } as never] };
  }
  if (scenario === "internal-with-pr") lane.publication = "internal";
  if (scenario === "internal-open-pr") { lane.publication = "internal"; lane.delivery = undefined; }
  if (scenario === "unlanded-no-pr") lane.delivery = undefined;
  if (scenario === "cached-branch") delete lane.delivery!.target.pr;
  if (scenario === "readonly-no-pr" || scenario === "remote-readonly") {
    lane.delivery = undefined;
    lane.stages = [{ id: "research", kind: "run", next: null, onFail: null, prompt: "", effectiveRole: { access: "read-only" } } as never];
    if (scenario === "remote-readonly") lane.publication = "remote-branch";
  }
  if (scenario === "cached-fork") lane.delivery!.target.prRepository = "acme/upstream";
  if (scenario === "comparison") lane.delivery!.disposition = "comparison";
  if (scenario === "merged-record" || scenario === "archived-merged") lane.merge = { state: "merged", reviewedHead: base, mergedHead: base, chain: [base] } as never;
  updateForgeCache(data => {
    data.repositories = {};
    if (["cached-merged", "cached-open", "cached-closed", "unrelated-merged", "reused-branch", "cached-fork", "cached-branch"].includes(scenario)) {
      const entry = data.repositories[scenario === "cached-fork" ? "acme/upstream" : "acme/widgets"] = emptyRepositoryEntry();
      const number = scenario === "unrelated-merged" || scenario === "reused-branch" ? 99 : 17;
      entry.prs[String(number)] = { url: `https://github.com/acme/widgets/pull/${number}`, headRefName: scenario === "unrelated-merged" ? "other-lane" : "finished-lane",
        state: scenario === "cached-open" ? "open" : scenario === "cached-closed" ? "closed" : "merged",
        createdAt: scenario === "reused-branch" ? "2020-01-01T00:00:00Z" : "2026-08-27T10:00:00Z", closes: [], checkedAt: "2026-08-28T12:00:00Z" };
    }
  });
  resetForgeCacheForTests();
  rig.deps.sources!.pipelines = () => scenario === "archived-merged" ? [] : [lane];
  rig.deps.sources!.archivedPipelines = () => scenario === "archived-merged" ? [lane] : [];
  rig.deps.sources!.openPullRequests = scenario === "internal-open-pr"
    ? async () => ({ ok: true, pullRequests: [{ number: 17, headRefName: lane.branch, title: "Delivery", createdAt: "2026-08-27T10:00:00Z", updatedAt: "2026-08-27T10:00:00Z" }] })
    : async () => ({ ok: false, unavailable: "command-failed" });
  // No remote is configured; Git-only delivery evidence must remain sufficient.
  expect(git("remote")).toBe("");
  let observation = await gatherSeatTickInput(PROJECT, rig.deps.readState!(PROJECT), DEFAULT_SEAT_TICK_POLICY, rig.deps.sources!);
  if (scenario === "internal-open-pr") {
    observation = await refreshSeatTickEvidence(observation!, rig.deps.sources!);
    expect(observation.pullRequests.map(pr => pr.number)).toEqual([17]);
  }
  if (scenario === "refresh-merged" || scenario === "refresh-internal" || scenario === "refresh-cache") {
    if (scenario === "refresh-merged") lane = { ...lane, merge: { state: "merged", reviewedHead: base, mergedHead: base, chain: [base] } as never };
    else if (scenario === "refresh-internal") lane = { ...lane, publication: "internal", delivery: undefined };
    else {
      updateForgeCache(data => {
        const entry = data.repositories["acme/widgets"] = emptyRepositoryEntry();
        entry.prs["17"] = { url: "https://github.com/acme/widgets/pull/17", headRefName: "finished-lane", state: "merged",
          createdAt: "2026-08-27T10:00:00Z", closes: [], checkedAt: "2026-08-28T12:00:00Z" };
      });
      resetForgeCacheForTests();
    }
    observation = await refreshSeatTickEvidence(observation!, rig.deps.sources!);
  }
  const pending = observation!.signals.filter(signal => signal.id.startsWith("local-unmerged-lane:"));
  const expected = ["unlanded", "partial", "cached-open", "cached-closed", "unrelated-merged", "reused-branch", "local-base",
    "internal-with-pr", "remote-readonly", "wrong-path", "unlanded-no-pr"].includes(scenario);
  expect(pending.map(signal => signal.id)).toEqual(expected ? [`local-unmerged-lane:${lane.id}`] : []);
});
