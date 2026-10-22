import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { changesSinceRelease, latestReleaseTag, supersedingReleaseTag } from "./production";
import { releaseState } from "./policy";
import { ready } from "./policy.fixture";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-tags-test-"));
  directories.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const remote = path.join(root, "origin.git");
  const env = { ...process.env, GIT_AUTHOR_NAME: "Release fixture", GIT_AUTHOR_EMAIL: "noreply@example.test",
    GIT_COMMITTER_NAME: "Release fixture", GIT_COMMITTER_EMAIL: "noreply@example.test",
    GIT_AUTHOR_DATE: "2026-10-17T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-17T00:00:00Z" };
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: repo, env })).stdout.trim();
  await git("init", "--bare", remote); await git("init", "-b", "main");
  await git("remote", "add", "origin", remote);
  let sequence = 0;
  const commit = async (subject: string) => {
    fs.writeFileSync(path.join(repo, "component.ts"), `export const value = ${sequence++};\n`);
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.15.0" }));
    await git("add", "."); await git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const cut = await commit("Initial product (#1)");
  // An older release annotated later must not displace the highest version.
  env.GIT_COMMITTER_DATE = "2026-10-22T00:00:00Z";
  await git("tag", "-a", "v1.13.0", "-m", "Release 1.13.0");
  env.GIT_COMMITTER_DATE = "2026-10-19T00:00:00Z";
  await commit("Released feature (#2)"); await git("tag", "v1.14.0");
  env.GIT_COMMITTER_DATE = "2026-10-20T00:00:00Z";
  const released = await commit("Release 1.15.0 (#3)");
  await git("tag", "-a", "v1.15.0", "-m", "Release 1.15.0");
  env.GIT_COMMITTER_DATE = "2026-10-21T00:00:00Z";
  await commit("Next feature (#4)");
  const next = await commit("Next fix (#5)");
  await git("tag", "v2.0.0-rc.1");
  await git("push", "origin", "main", "--tags");
  return { repo, git, cut, released, next };
}

test("the newest stable real tag supplies both lastTag and the visible change range", async () => {
  const h = await repository();
  const tag = await latestReleaseTag(h.repo);
  expect(tag).toEqual({ name: "v1.15.0", version: "1.15.0", at: Date.parse("2026-10-20T00:00:00Z") });
  const changes = await changesSinceRelease(h.repo, tag.name, h.next);
  expect(changes.map(change => change.subject)).toEqual(["Next fix (#5)", "Next feature (#4)"]);
  const policy = { ...ready(), now: Date.parse("2026-10-22T23:30:00Z"), mainVersion: tag.version,
    lastTag: tag, changes, minChanges: 2, deployments: [{ revision: h.next, at: Date.parse("2026-10-21T00:00:00Z") }] };
  expect(await releaseState(policy)).toMatchObject({ state: "due", count: 2 });
});

test("a manually pushed and published tag covers an older frozen cut", async () => {
  const h = await repository();
  expect(await supersedingReleaseTag(h.repo, { cut: h.cut, lastTag: "v1.13.0" }, undefined,
    async (name, version) => { expect(name).toBe("release-fixture"); expect(version).toBe("1.15.0"); return true; })).toBe("v1.15.0");
});

test("a tag before the cut and an unpublished tag cannot supersede a release", async () => {
  const h = await repository();
  expect(await supersedingReleaseTag(h.repo, { cut: h.next, lastTag: "v1.13.0" }, undefined,
    async () => { throw new Error("a newer cut must not query publication"); })).toBeNull();
  expect(await supersedingReleaseTag(h.repo, { cut: h.cut, lastTag: "v1.13.0" }, undefined, async () => false)).toBeNull();
  expect(await supersedingReleaseTag(h.repo, { cut: h.cut, lastTag: "v1.15.0" }, undefined,
    async () => { throw new Error("the same version must not supersede itself"); })).toBeNull();
});

test("an unrelated cut is retained and unreadable ancestry or publication is reported", async () => {
  const h = await repository();
  await h.git("checkout", "--orphan", "unrelated");
  await h.git("commit", "--allow-empty", "-m", "Unrelated root");
  const unrelated = await h.git("rev-parse", "HEAD");
  expect(await supersedingReleaseTag(h.repo, { cut: unrelated, lastTag: "v1.13.0" }, undefined, async () => true)).toBeNull();
  await expect(supersedingReleaseTag(h.repo, { cut: "missing-revision", lastTag: "v1.13.0" }, undefined, async () => true)).rejects.toThrow();
  await expect(supersedingReleaseTag(h.repo, { cut: h.cut, lastTag: "v1.13.0" }, undefined,
    async () => { throw new Error("registry unavailable"); })).rejects.toThrow("registry unavailable");
});

test.each(["fetch", "tags", "empty"])("%s tag evidence is never treated as a superseding release", async failure => {
  await expect(latestReleaseTag("repo", async (_file, args) => {
    if (args[0] === "fetch") { if (failure === "fetch") throw new Error("fetch unreadable"); return ""; }
    if (failure === "tags") throw new Error("tags unreadable");
    return "v2.0.0-rc.1 1\nv-invalid 2";
  })).rejects.toThrow(failure === "empty" ? "existing version tag" : `${failure} unreadable`);
});

test("the production adapter settles the actual stored done task without repository observation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-task-test-")); directories.push(root);
  for (const name of ["home", "config", "tmp", "state"]) fs.mkdirSync(path.join(root, name));
  const script = `
    const { createTask } = await import(${JSON.stringify(new URL("../tasks/commands.ts", import.meta.url).href)});
    const { mutateTasksFile } = await import(${JSON.stringify(new URL("../tasks/store.ts", import.meta.url).href)});
    const { mutateReleaseProject } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const { releaseStatus } = await import(${JSON.stringify(new URL("./answer.ts", import.meta.url).href)});
    const { releaseControllerForSources } = await import(${JSON.stringify(new URL("./production.ts", import.meta.url).href)});
    const project = "release-adapter";
    const at = "2026-10-19T00:00:00Z";
    mutateTasksFile(state => {
      const result = createTask(state.tasks, { project, text: "Finished release", placement: "unplaced" }, state.recentCreates,
        { id: () => "finished-release-task", now: () => at });
      if (!result.ok) throw new Error(result.error);
      return { state: { tasks: result.tasks.map(task => ({ ...task, status: "done" })), recentCreates: result.recentCreates }, result: null };
    });
    mutateReleaseProject(project, row => ({ ...row, live: { key: "stale-release", cut: "old-cut", lastTag: "v1.13.0",
      trigger: "requested", startedAt: Date.parse(at), taskId: "finished-release-task", pipelineId: null, request: null } }));
    const controller = releaseControllerForSources({ now: () => Date.parse("2026-10-22T23:30:00Z"),
      tasks: () => { throw new Error("a keyed read must not load the task list"); } });
    await controller.reconcile(project);
    console.log(JSON.stringify(releaseStatus(project)));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", script], { timeout: 15_000,
    env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
      TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: path.join(root, "state") } });
  expect(JSON.parse(stdout)).toMatchObject({ live: null, lastRun: { outcome: "completed", reason: "task-done" } });
});
