import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/* The rules window's × and Undo reach the store through this route with the
   ids the store itself draws. The state directory is private to this file. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-route-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { POST } = await import("./route");
const { leaveLessons, projectView, recordLessonRequest } = await import("@/lib/memory/roleStore");

const PROJECT = "route-trial";
const post = (body: Record<string, unknown>) => POST(new NextRequest("http://127.0.0.1/api/role-memory", {
  method: "POST",
  headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json" },
  body: JSON.stringify(body),
}));

test("a rule the store drew is removed and put back through the route", async () => {
  const request = { pipelineId: "p-route", stageId: "fix", attempt: 1 };
  recordLessonRequest({ ...request, project: PROJECT, roleId: "builder", conversationId: "conversation_route", at: "2026-10-07T12:00:00.000Z" });
  const [left] = leaveLessons({ request, source: { ...request, project: PROJECT, roleId: "builder", fixRound: true, conversationId: "conversation_route" }, none: null,
    lessons: [{ scope: "role", rule: "When a change adds a branch for empty input, write its test in the same commit.", why: "Review failed on an untested empty-input path." }] }).left;
  const builder = () => projectView(PROJECT).scopes.find((scope) => scope.roleId === "builder")!;

  const removed = await post({ project: PROJECT, ruleId: left!.id, action: "delete" });
  expect(removed.status).toBe(200);
  expect(builder().active).toEqual([]);
  expect(builder().left).toEqual([expect.objectContaining({ id: left!.id, reason: "deleted" })]);

  const restored = await post({ project: PROJECT, ruleId: left!.id, action: "restore" });
  expect(restored.status).toBe(200);
  expect(builder().active.map((rule) => rule.id)).toEqual([left!.id]);

  /* A legacy short id is still a well-formed request; an unknown one is a conflict, not a malformed request. */
  expect((await post({ project: PROJECT, ruleId: "r_00000000", action: "delete" })).status).toBe(409);
  for (const ruleId of ["r_xyz", `${left!.id}0`, "rule"]) expect((await post({ project: PROJECT, ruleId, action: "delete" })).status).toBe(400);
});

test("the operator reverts a version through the existing route and versions stay out of Left", async () => {
  const source = { project: "route-versions", pipelineId: "route-versions", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_route_versions" };
  const why = "An earlier write used a receipt belonging to another owner.";
  const original = "Check every stored receipt against its owner before replaying its acknowledgement.";
  recordLessonRequest({ ...source, at: "2026-10-11T00:00:00.000Z" });
  const first = leaveLessons({ request: source, source, none: null, lessons: [{ scope: "role", rule: original, why }] }).left[0]!;
  const next = { ...source, attempt: 2 };
  recordLessonRequest({ ...next, at: "2026-10-11T00:01:00.000Z" });
  const revised = leaveLessons({ request: next, source: next, lessons: [], none: null, rewrite: { id: first.id, rule: "Check stored receipts against both their owner and operation before replaying acknowledgements.", why } }).left[0]!;
  const response = await post({ project: source.project, ruleId: revised.version, action: "revert" });
  expect(response.status).toBe(200);
  const scope = projectView(source.project).scopes.find(scope => scope.scope === first.scope)!;
  expect(scope.active[0]!.rule).toBe(original);
  // The text now in force is not listed as an earlier text; the rewrite it replaced is.
  expect(scope.active[0]!.versions).toEqual([expect.objectContaining({ rule: "Check stored receipts against both their owner and operation before replaying acknowledgements." })]);
  expect(scope.left).toEqual([]);
});
