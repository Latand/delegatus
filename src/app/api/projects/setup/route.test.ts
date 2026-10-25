import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { GET, POST, PUT } from "./route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-route-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
fs.mkdirSync(path.join(root, ".git"));
fs.writeFileSync(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(root, ".git/config"), "[core]\nrepositoryformatversion = 0\n");
fs.writeFileSync(path.join(root, "setup.sh"), "echo reviewed\n");
const project = projectIdentityFromRepositoryRoot(root)!.project;
const origin = "http://localhost";
const recipe = { command: ["sh", "setup.sh"], cwd: "." };
const request = (body: unknown, extras: Record<string, string> = {}) => new NextRequest(`${origin}/api/projects/setup`, {
  method: "PUT", headers: { cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json", host: "localhost", origin, ...extras }, body: JSON.stringify(body),
});
afterAll(() => {
  setCallerConversationResolverForTests(null);
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test("preview shows reviewed content, approval requires that exact digest, and null disables", async () => {
  expect((await (await GET(new NextRequest(`${origin}/api/projects/setup?project=${project}`))).json()).setup).toBeNull();
  const input = { project, repoDir: root, recipe };
  const preview = await POST(request(input));
  expect(preview.status).toBe(200);
  const review = (await preview.json()).review;
  expect(review.files).toEqual({ "setup.sh": "echo reviewed\n" });
  expect((await PUT(request(input))).status).toBe(409);
  expect((await PUT(request({ ...input, recipe: { command: ["bash", "setup.sh"], cwd: "." }, reviewedHash: review.hash }))).status).toBe(409);
  fs.writeFileSync(path.join(root, "setup.sh"), "echo changed\n");
  expect(await (await PUT(request({ ...input, reviewedHash: review.hash }))).json()).toEqual({ error: "SETUP_REVIEW_REQUIRED" });
  const latest = (await (await POST(request(input))).json()).review;
  const accepted = await PUT(request({ ...input, reviewedHash: latest.hash }));
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).setup.hash).toBe(latest.hash);
  expect((await (await GET(new NextRequest(`${origin}/api/projects/setup?project=${project}`))).json()).setup.hash).toBe(latest.hash);
  expect(await (await PUT(request({ project, recipe: null }))).json()).toEqual({ ok: true, setup: null });
});

test("each mutation denies a named agent exactly; an authenticated operator control reaches validation", async () => {
  setCallerConversationResolverForTests(() => "conversation_fixture");
  const capability = Buffer.alloc(32, 7).toString("base64url");
  try {
    for (const action of [POST, PUT]) {
      expect((await action(request({ project, repoDir: root, recipe }, { cookie: "" }))).status).toBe(403);
      for (const body of [{ project, repoDir: root, recipe }, { project, recipe: null }, { project, repoDir: root, recipe, reviewedHash: "0".repeat(64) }]) {
        const denied = await action(request(body, { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability }));
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({ code: "operator_only", error: "this is an operator-only action; an agent may not perform it, whatever role it holds" });
      }
      const operator = await action(request({ project, repoDir: root, recipe }));
      expect(operator.status).toBe(action === POST ? 200 : 409);
      expect((await action(request({ project, recipe: null }, { origin: "https://example.invalid" }))).status).toBe(403);
    }
  } finally { setCallerConversationResolverForTests(null); }
});

test("another repository, traversal and malformed requests cannot be approved", async () => {
  expect((await PUT(request({ project: "unrelated", repoDir: root, recipe }))).status).toBe(400);
  expect((await POST(request({ project, repoDir: root, recipe: { ...recipe, cwd: "../outside" } }))).status).toBe(409);
  expect((await PUT(request({ project }))).status).toBe(400);
});
