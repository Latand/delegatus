import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const restore = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-shared-forge-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.HOME = path.join(root, "home");
process.env.TMPDIR = root;
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
const { canonicalProject, recordProjectRemote, recordedProjectRemote, resetProjectAliasesForTests } = await import("./aliases");
const { projectIdentityFromRemote } = await import("./identity");
const { setShared, sharedProjects, knownProjects, patchShared } = await import("../links/state");
const { githubRepositoryLookup, setForgeLookupForTests, forgeRenamesSettledForTests, resetForgeRenameDecisionsForTests } = await import("./forgeRename");
const old = projectIdentityFromRemote("https://github.com/example/old-repo.git", "/")!;
const current = projectIdentityFromRemote("https://github.com/example/current-repo.git", "/")!;
let sequence = 0;
beforeEach(async () => {
  await forgeRenamesSettledForTests();
  process.env.LLV_STATE_DIR = path.join(root, `state-${++sequence}`);
  resetProjectAliasesForTests(); resetForgeRenameDecisionsForTests();
  recordProjectRemote(old);
  setForgeLookupForTests(async () => ({ status: "unreachable" }));
});
afterAll(async () => { await forgeRenamesSettledForTests(); setForgeLookupForTests(null); fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(restore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test("unchanged recorded clone remote discovers canonical full name and deduplicates source lists", async () => {
  const calls: string[] = [];
  setForgeLookupForTests(async name => { calls.push(name); return { status: "found", id: 42, fullName: "example/current-repo" }; });
  recordProjectRemote(current);
  setShared({ v: 1, all: false, projects: [old.project, current.project] });
  sharedProjects(); sharedProjects();
  await forgeRenamesSettledForTests();
  expect(canonicalProject(old.project)).toBe(current.project);
  expect(recordedProjectRemote(old.project)).toBe(old.canonicalRemote);
  expect(recordedProjectRemote(current.project)).toBe(current.canonicalRemote);
  expect(calls.length).toBeLessThanOrEqual(4);
  expect(sharedProjects()).toEqual([{ key: current.project, name: "current-repo" }]);
  expect(knownProjects()).toEqual([{ key: current.project, name: "current-repo" }]);
  const count = calls.length; sharedProjects(); await forgeRenamesSettledForTests(); expect(calls.length).toBe(count);
});
for (const failure of ["different ids", "no name", "unreachable", "missing", "invalid name"] as const) {
  test(`shared discovery safely refuses ${failure} and holds its 24h TTL`, async () => {
    let calls = 0;
    setForgeLookupForTests(async name => {
      calls++;
      if (failure === "unreachable") return { status: "unreachable" };
      if (failure === "missing") return { status: "missing" };
      return { status: "found", id: name === "example/old-repo" ? 42 : 99,
        ...(failure === "no name" ? {} : { fullName: failure === "invalid name" ? "../outside" : "example/current-repo" }) };
    });
    setShared({ v: 1, all: false, projects: [old.project] });
    await forgeRenamesSettledForTests();
    expect(canonicalProject(old.project)).toBe(old.project);
    const count = calls;
    sharedProjects(); await forgeRenamesSettledForTests(); expect(calls).toBe(count);
    const realNow = Date.now; Date.now = () => realNow() + 86_400_001;
    try { sharedProjects(); await forgeRenamesSettledForTests(); expect(calls).toBeGreaterThan(count); }
    finally { Date.now = realNow; }
  });
}

test("known but unshared repositories never trigger forge discovery", async () => {
  let calls = 0;
  setForgeLookupForTests(async () => { calls++; return { status: "found", id: 42, fullName: "example/current-repo" }; });
  knownProjects(); sharedProjects();
  await forgeRenamesSettledForTests();
  expect(calls).toBe(0);
  expect(canonicalProject(old.project)).toBe(old.project);
});

test("a private repository can recover after unsigned REST returns 404", async () => {
  const logs: string[] = [];
  const run = async () => { throw Object.assign(new Error("Command failed: gh"), { code: 4 }); };
  const request = async () => new Response(null, { status: 404 });
  const log = (message: string) => { logs.push(message); };
  const lookup = () => githubRepositoryLookup("example/old-repo", { run, request, log });
  expect(await lookup()).toEqual({ status: "unreachable" });
  expect(await lookup()).toEqual({ status: "unreachable" });
  expect(logs).toEqual([expect.stringContaining("gh auth login")]);
  expect(await githubRepositoryLookup("example/old-repo", { log, request, run: async () => {
    throw Object.assign(new Error("Command failed: gh"), { stderr: "gh: Not Found (HTTP 404)" });
  } })).toEqual({ status: "missing" });
  expect(await githubRepositoryLookup("example/old-repo", {
    log, run: async () => JSON.stringify({ id: 42, full_name: "example/current-repo" }),
  })).toEqual({ status: "found", id: 42, fullName: "example/current-repo" });
  expect(logs).toHaveLength(1);
});

test("a failed CLI read can still resolve a public repository through REST", async () => {
  const logs: string[] = [];
  const answer = await githubRepositoryLookup("example/old-repo", {
    run: async () => { throw Object.assign(new Error("spawn gh"), { code: "ENOENT" }); },
    request: async (url) => {
      expect(url).toBe("https://api.github.com/repos/example/old-repo");
      return Response.json({ id: 42, full_name: "example/current-repo" });
    },
    log: message => { logs.push(message); },
  });
  expect(answer).toEqual({ status: "found", id: 42, fullName: "example/current-repo" });
  expect(logs).toEqual([]);
});


test("disabling a renamed shared project removes its old stored alias as well", async () => {
  setForgeLookupForTests(async () => ({ status: "found", id: 7, fullName: "example/current-repo" }));
  setShared({ v: 1, all: false, projects: [old.project] });
  await forgeRenamesSettledForTests();
  expect(sharedProjects()).toEqual([{ key: current.project, name: "current-repo" }]);
  patchShared({ project: current.project, enabled: false });
  expect(sharedProjects()).toEqual([]);
});
