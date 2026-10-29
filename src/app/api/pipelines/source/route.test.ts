import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { EMPTY_FORGE_CACHE } from "@/lib/forge/workLinks";
import * as forgeCache from "@/lib/forge/cache";
import * as githubEvidence from "@/lib/monitor/githubEvidence";
import * as repository from "@/lib/pipelines/initializeRepository";
import type { PipelineLinkPorts } from "@/lib/pipelines/linkSource";
import type { PipelineRepoPreflight } from "@/lib/pipelines/types";
import * as pipelineStore from "@/lib/pipelines/store";
import { projectForCwd } from "@/lib/scanner/describe";
import * as taskStore from "@/lib/tasks/store";
import type { Member } from "@/lib/team/contract";
import { teamGate } from "@/lib/team/gate";
import { MEMBER_COOKIE, sha256Hex } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { workspaceScope } from "@/lib/team/workspaceAccess";
import { createWorkspace } from "@/lib/team/workspaces";
import * as provision from "@/lib/workflows/provision";

const { POST } = await import("./route");

const SAME_ORIGIN = "http://127.0.0.1:8898";

function request(body: string, origin?: string): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/pipelines/source", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json", ...(origin ? { origin } : {}) },
    body,
  });
}

function dependencies(answers: Record<string, unknown>, preflight?: PipelineRepoPreflight) {
  const seen = { preflight: [] as string[], gh: 0 };
  const ports: PipelineLinkPorts = {
    gh: async (args) => {
      seen.gh += 1;
      const answer = answers[args.at(-1)!];
      if (answer === undefined) throw Object.assign(new Error("gh failed"), { stderr: "HTTP 404: Not Found" });
      return JSON.stringify(answer);
    },
    /* `git remote` lists origin; each `git remote get-url` answers its URL. */
    exec: (_command, args) => ({ code: 0, stdout: args.length === 1 ? "origin\n" : "https://github.com/owner/project.git\n", stderr: "" }),
    tasks: () => [],
    pipelines: () => [],
    projectForCwd: () => "repo-project",
    taskLinks: () => [],
    cache: EMPTY_FORGE_CACHE,
  };
  return {
    seen,
    preflight: (repoDir: string) => {
      seen.preflight.push(repoDir);
      return preflight ?? { ok: true as const, repoDir: "/srv/project", gitCommonDir: "/srv/project/.git", worktreeParent: "/srv" };
    },
    ports: () => ports,
  };
}

const PR = {
  number: 5, title: "Fix", state: "open", draft: false, merged_at: null, html_url: "https://github.com/owner/project/pull/5",
  base: { ref: "main", repo: { full_name: "owner/project" } }, head: { ref: "fix", sha: "c".repeat(40), repo: { full_name: "owner/project" } },
};

test("a same-origin request answers the resolved source against the admitted checkout", async () => {
  const deps = dependencies({ "repos/owner/project/pulls/5": PR });
  const response = await POST.withDependencies(request(JSON.stringify({ link: " https://github.com/owner/project/pull/5 ", repoDir: "~/project" }), SAME_ORIGIN), deps);
  expect(response.status).toBe(200);
  const json = await response.json();
  expect(json).toMatchObject({ ok: true, repoDir: "/srv/project", source: { kind: "pr", number: 5, request: { delivery: { branch: "refs/heads/fix", remote: "origin", pr: 5 } } } });
  expect(deps.seen.preflight).toEqual(["~/project"]);
});

test("refusals keep their code and a status that says whose problem it is", async () => {
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ["https://github.com/owner/project/pull/9", {}, 404, "not_found"],
    ["https://github.com/owner/project/pull/5", { "repos/owner/project/pulls/5": { ...PR, state: "closed" } }, 409, "closed"],
    ["https://github.com/else/project/pull/5", {}, 409, "repository_mismatch"],
    ["not a link", {}, 400, "invalid"],
  ];
  for (const [link, answers, status, code] of cases) {
    const response = await POST.withDependencies(request(JSON.stringify({ link, repoDir: "/srv/project" }), SAME_ORIGIN), dependencies(answers));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code });
  }
});

test("a checkout the preflight refuses is never read for the link", async () => {
  const deps = dependencies({}, { ok: false, code: "not_git", path: "/srv/plain" });
  const response = await POST.withDependencies(request(JSON.stringify({ link: "#5", repoDir: "/srv/plain" }), SAME_ORIGIN), deps);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ ok: false, code: "repository", repositoryCode: "not_git", path: "/srv/plain" });
  expect(deps.seen.gh).toBe(0);
});

test("cross-origin and malformed requests are refused before the checkout or the forge is read", async () => {
  const deps = dependencies({ "repos/owner/project/pulls/5": PR });
  expect((await POST.withDependencies(request(JSON.stringify({ link: "#5", repoDir: "/srv/project" }), "https://example.com"), deps)).status).toBe(403);
  expect((await POST.withDependencies(request("{", SAME_ORIGIN), deps)).status).toBe(400);
  expect((await POST.withDependencies(request("[]", SAME_ORIGIN), deps)).status).toBe(400);
  expect((await POST.withDependencies(request(JSON.stringify({ link: "#5" }), SAME_ORIGIN), deps)).status).toBe(400);
  expect((await POST.withDependencies(request(JSON.stringify({ link: "", repoDir: "/srv/project" }), SAME_ORIGIN), deps)).status).toBe(400);
  expect(deps.seen).toEqual({ preflight: [], gh: 0 });
});

describe("the exported source route's workspace authorization", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const workspaceId = `w_${"a".repeat(32)}`;
  const cookie = "m".repeat(43);
  const previousState = process.env.LLV_STATE_DIR;
  let root: string;
  let permitted: string;
  let forbidden: string;
  const restore: Array<() => void> = [];
  let deps: ReturnType<typeof dependencies>;
  let reads: { cache: number; tasks: number; pipelines: number };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-source-workspace-"));
    process.env.LLV_STATE_DIR = root;
    resetTeamStoreForTests();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    restore.push(() => clock.mockRestore());
    permitted = path.join(root, "permitted");
    forbidden = path.join(root, "forbidden");
    fs.mkdirSync(permitted);
    fs.mkdirSync(forbidden);
    const store = teamStore();
    const person = (id: string, role: Member["role"]): Member => ({
      id, name: role, role, status: "active", color: "teal", telegram: null,
      createdAt: new Date(now).toISOString(), createdBy: "claim", revokedAt: null,
    });
    const owner = person("m_owner", "owner");
    store.insertMember(owner);
    store.insertMember(person("m_member", "member"));
    store.insertSession({
      id: sha256Hex(cookie), memberId: "m_member", createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
      surface: "desktop", browser: "chrome", method: "invite", revokedAt: null,
    });
    createWorkspace(store, owner, { id: workspaceId, name: "Permitted", projects: [projectForCwd(permitted)] });
    store.putWorkspaceMember(workspaceId, "m_member", "member", owner.id, new Date(now).toISOString());
    expect(workspaceScope(store, "m_member").access(projectForCwd(forbidden))).toBe("none");
    deps = dependencies({ "repos/owner/project/pulls/5": PR });
    reads = { cache: 0, tasks: 0, pipelines: 0 };
    const preflight = spyOn(repository, "preparePipelineRepository").mockImplementation(async repoDir => {
      deps.seen.preflight.push(repoDir);
      return { ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: root };
    });
    restore.push(() => preflight.mockRestore());
    const gh = spyOn(githubEvidence, "githubRunner").mockImplementation(() => deps.ports().gh);
    restore.push(() => gh.mockRestore());
    const exec = spyOn(provision, "realExec").mockImplementation(deps.ports().exec);
    restore.push(() => exec.mockRestore());
    const cache = spyOn(forgeCache, "forgeCacheView").mockImplementation(() => { reads.cache++; return EMPTY_FORGE_CACHE; });
    restore.push(() => cache.mockRestore());
    const tasks = spyOn(taskStore, "loadTasks").mockImplementation(() => { reads.tasks++; return []; });
    restore.push(() => tasks.mockRestore());
    const pipelines = spyOn(pipelineStore, "loadPipelinesForList").mockImplementation(() => { reads.pipelines++; return []; });
    restore.push(() => pipelines.mockRestore());
  });

  afterEach(() => {
    for (const undo of restore.splice(0).reverse()) undo();
    resetTeamStoreForTests();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function memberRequest(repoDir: string, extra: Record<string, unknown> = {}): NextRequest {
    const req = request(JSON.stringify({ link: PR.html_url, repoDir, ...extra }), SAME_ORIGIN);
    req.cookies.set(MEMBER_COOKIE, cookie);
    return req;
  }

  test("a permitted member resolves a source through the exported POST", async () => {
    const req = memberRequest(permitted);
    expect(teamGate(req, { bearerAuthenticated: false })).toBeNull();
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, repoDir: permitted, source: { number: 5, tasks: [] } });
    expect(deps.seen).toEqual({ preflight: [permitted], gh: 1 });
    expect(reads).toEqual({ cache: 1, tasks: 1, pipelines: 0 });
  });

  test("a foreign checkout is refused before repository, forge or task reads", async () => {
    const link = path.join(permitted, "foreign-link");
    fs.symlinkSync(forbidden, link);
    for (const repoDir of [forbidden, `  ${forbidden}  `, `${permitted}/worktrees/../../forbidden`, link]) {
      const req = memberRequest(repoDir, { project: projectForCwd(permitted) });
      expect(teamGate(req, { bearerAuthenticated: false })).toBeNull();
      const response = await POST(req);
      expect(response.status, repoDir).toBe(403);
      expect(await response.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
    }
    expect(deps.seen).toEqual({ preflight: [], gh: 0 });
    expect(reads).toEqual({ cache: 0, tasks: 0, pipelines: 0 });
  });

  test("revoked and missing sessions cannot resolve a source", async () => {
    const req = memberRequest(permitted);
    teamStore().revokeSession(sha256Hex(cookie), new Date(now).toISOString());
    for (const input of [req, request(JSON.stringify({ link: PR.html_url, repoDir: permitted }), SAME_ORIGIN)]) {
      expect((await POST(input)).status).toBe(401);
    }
    expect(deps.seen).toEqual({ preflight: [], gh: 0 });
    expect(reads).toEqual({ cache: 0, tasks: 0, pipelines: 0 });
  });
});
