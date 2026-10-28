import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { leaveLessons, projectView, recordLessonRequest } from "@/lib/memory/roleStore";
import { applyCuration } from "@/lib/memory/curation/apply";
import { claimPass, patchPass } from "@/lib/memory/curation/store";
import { POST } from "./route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curation-route-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = root;
afterAll(() => {
  setCallerConversationResolverForTests(null);
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test("Undo pass refuses live passes and agents, then restores the whole completed pass for the operator", async () => {
  const source = { project: "curation-route", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" };
  recordLessonRequest({ ...source, at: new Date().toISOString() });
  const original = "Inspect stored guidance before changing the readers of a scope.";
  const rule = leaveLessons({ request: source, source, none: null, lessons: [{ scope: "role", rule: original, why: "An earlier write selected guidance for the wrong readers." }] }).left[0];
  const pass = claimPass({ project: source.project, repoDir: root, now: Date.now() })!;
  const scope = projectView(source.project).scopes.find(s => s.scope === rule.scope)!;
  applyCuration(pass, { scopes: [{ scope: scope.scope, revision: scope.revision, order: [rule.id] }], rewrite: [{ id: rule.id, rule: original + " Inspect its revision.", note: "The revision binds the write to its reading." }] });
  const request = (ruleId: string, agent = false) => new NextRequest("http://127.0.0.1/api/role-memory", {
    method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json", ...(agent ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: Array(43).fill("x").join("") } : { cookie: `llv_operator=${soloBrowserSession()}` }) },
    body: JSON.stringify({ project: source.project, action: "revert-pass", ruleId }),
  });
  expect((await POST(request(pass.id))).status).toBe(409);
  patchPass(pass.id, { state: "succeeded", endedAt: new Date().toISOString() });
  setCallerConversationResolverForTests(() => source.conversationId);
  expect((await POST(request(pass.id, true))).status).toBe(403);
  const response = await POST(request(pass.id));
  expect(response.status).toBe(200);
  expect((await response.json()).scopes.find((s: { scope: string }) => s.scope === scope.scope).active[0].rule).toBe(original);
  expect((await POST(request(pass.id))).status).toBe(200);
  expect((await POST(request("not-a-pass"))).status).toBe(400);
});
