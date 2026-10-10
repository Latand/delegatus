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
  headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json" },
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
