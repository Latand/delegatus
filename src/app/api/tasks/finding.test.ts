import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { BoardTask } from "@/lib/tasks/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "http-task-finding-"));
process.env.LLV_STATE_DIR = sandbox;
const { POST, GET } = await import("./route");
const { PATCH } = await import("./[id]/route");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const json = (body: unknown, method: string) => new NextRequest("http://localhost/api/tasks", {
  method, headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body),
});
const read = async (response: Response) => {
  expect(response.status).toBe(200);
  return await response.json() as { task: BoardTask; matched?: boolean };
};
const patch = (id: string, body: unknown) => PATCH(json(body, "PATCH"), { params: Promise.resolve({ id }) });

test("HTTP POST matches an open finding, preserves text, retries once, and links after Done", async () => {
  const input = { project: "http-findings", text: "Operator title", placement: "unplaced", findingKey: "failure", note: "First report" };
  const initial = await read(await POST(json(input, "POST")));
  const repeatArgs = { ...input, text: "New title", note: "Seen again", clientRequestId: "http-repeat" };
  const repeat = await read(await POST(json(repeatArgs, "POST")));
  expect(repeat).toMatchObject({ matched: true, task: { id: initial.task.id, text: input.text, finding: { count: 2 }, note: { text: "Seen again", author: { kind: "operator" } } } });
  expect(repeat.task.finding!.lastSeenAt >= initial.task.finding!.lastSeenAt).toBe(true);
  expect(await read(await POST(json(repeatArgs, "POST")))).toEqual(repeat);
  await read(await patch(initial.task.id, { status: "done" }));
  const next = await read(await POST(json(input, "POST")));
  expect(next.task.id).not.toBe(initial.task.id);
  expect(next.task.finding).toMatchObject({ count: 1, previousTaskId: initial.task.id });
  expect((await patch(initial.task.id, { status: "inbox" })).status).toBe(409);
  const clear = await read(await patch(next.task.id, { findingKey: null }));
  expect(clear.task.finding).toBeUndefined();
  const keyed = await read(await patch(next.task.id, { findingKey: "replacement" }));
  expect(keyed.task).toMatchObject({ findingKey: "replacement", finding: { count: 1 } });
  const listed = await (await GET(new NextRequest("http://localhost/api/tasks"))).json();
  expect(listed.tasks.find((task: BoardTask) => task.id === keyed.task.id).finding).toEqual(keyed.task.finding);
});

test("HTTP validates keys on POST and PATCH; keyless creation remains independent", async () => {
  const input = { project: "http-validation", text: "Same title", placement: "unplaced" };
  const plain = await read(await POST(json(input, "POST")));
  const another = await read(await POST(json(input, "POST")));
  expect(another.task.id).not.toBe(plain.task.id);
  expect(Object.hasOwn(plain, "matched")).toBe(false);
  for (const findingKey of ["x".repeat(201), 17]) {
    expect((await POST(json({ ...input, findingKey }, "POST"))).status).toBe(400);
    expect((await patch(plain.task.id, { findingKey })).status).toBe(400);
  }
  const keyed = await read(await POST(json({ ...input, findingKey: "🙂".repeat(200) }, "POST")));
  const conflict = await patch(plain.task.id, { findingKey: keyed.task.findingKey });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "TASK_FINDING_KEY_CONFLICT", field: "findingKey" });
});
