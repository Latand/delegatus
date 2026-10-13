import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerLimits } from "@/lib/operator/workerLimit";

interface WorkerPresetRead { workerLimit: { machine: { value: number }; bounds: number[]; history: WorkerLimits["history"]; here: unknown } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-tool-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = root;
const { viewerMcpBindings } = await import("./bindings");
const { TOOL_INPUT_SCHEMAS } = await import("./server");
afterAll(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(root, "worker-limit.json"), { force: true });
});
function tools(kind: "manager" | "agent" = "manager") {
  return viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind, conversationId: "conversation_one", role: kind === "manager" ? "orchestrator" : "builder" }),
    callerProject: () => "one", authorizedSeats: () => [{ project: "one", conversationId: "conversation_one" }, { project: "two", conversationId: "conversation_two" }],
  } as never);
}

test("role presets reads the default and a seat writes the machine limit with an audit reason", async () => {
  const initial = await tools().role_presets({ clientRequestId: "read" }) as unknown as WorkerPresetRead;
  expect(initial.workerLimit.machine.value).toBe(3);
  expect(initial.workerLimit.bounds).toEqual([1, 64]);
  const answer = await tools().role_presets({ clientRequestId: "write", workerLimit: { value: 12, reason: "Work is ready" } });
  expect(answer).toMatchObject({ changed: true, scope: "machine", from: 3, to: 12, effective: 12 });
  const read = await tools().role_presets({ clientRequestId: "detail", detail: true }) as unknown as WorkerPresetRead;
  expect(read.workerLimit.history).toMatchObject([{ by: { kind: "manager", conversationId: "conversation_one", via: "tool" }, reason: "Work is ready" }]);
});

test("worker writes require seat authority and cannot mix two stores", async () => {
  await expect(tools("agent").role_presets({ clientRequestId: "worker", workerLimit: { value: 12, reason: "Work" } })).rejects.toMatchObject({ details: { code: "role_presets_write_refused" } });
  await expect(tools().role_presets({ clientRequestId: "mixed", overrides: {}, workerLimit: { value: 12, reason: "Work" } })).rejects.toMatchObject({ details: { code: "worker_limit_with_overrides" } });
  expect(fs.existsSync(path.join(root, "worker-limit.json"))).toBe(false);
});

test("the tool schema refuses missing reasons and values outside the bounds", () => {
  for (const workerLimit of [{ value: 12 }, { value: 0, reason: "Work" }, { value: 65, reason: "Work" }, { value: 2.5, reason: "Work" }]) {
    expect(TOOL_INPUT_SCHEMAS.role_presets.safeParse({ clientRequestId: "invalid", workerLimit }).success).toBe(false);
  }
});

test("a seat sets its own and another project's limits, clears them, and reads the same limit from get_orchestrator", async () => {
  await tools().role_presets({ clientRequestId: "machine", workerLimit: { value: 12, reason: "Work ready" } });
  expect(await tools().role_presets({ clientRequestId: "own", workerLimit: { project: "one", value: 5, reason: "Project capacity" } })).toMatchObject({ scope: "project", effective: 5 });
  expect(await tools().role_presets({ clientRequestId: "other", workerLimit: { project: "two", value: 6, reason: "Operator asked" } })).toMatchObject({ scope: "other-project", effective: 6 });
  expect(await tools().role_presets({ clientRequestId: "clear", workerLimit: { project: "two", value: null, reason: "Return to default" } })).toMatchObject({ to: null, effective: 12 });
  for (const full of [false, true]) expect(await tools().get_orchestrator({ clientRequestId: `seat-${full}`, project: "one", full })).toMatchObject({ workerLimit: { value: 5, source: "project", machine: 12, running: 0 } });
  const read = await tools().role_presets({ clientRequestId: "project-read", detail: true }) as unknown as WorkerPresetRead;
  expect(read.workerLimit.here).toMatchObject({ project: "one", value: 5, effective: 5, source: "project" });
  expect(read.workerLimit.history.at(-1)).toMatchObject({ project: "two", from: 6, to: null, by: { project: "one" } });
});
