import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { EMPTY_FORGE_CACHE } from "@/lib/forge/workLinks";
import type { PipelineLinkPorts } from "@/lib/pipelines/linkSource";
import type { PipelineRepoPreflight } from "@/lib/pipelines/types";

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
