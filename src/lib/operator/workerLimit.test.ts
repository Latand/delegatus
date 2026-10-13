import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { effectiveWorkerLimit, readWorkerLimits, setMachineWorkerLimit, setProjectWorkerLimit } from "./workerLimit";

let directory: string;
let previous: string | undefined;
const actor = { kind: "operator", via: "settings" } as const;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-limit-"));
  process.env.LLV_STATE_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test("the machine default applies to every project and records the operator's change", () => {
  expect(effectiveWorkerLimit("one")).toEqual({ value: 3, source: "default", machine: 3 });
  setMachineWorkerLimit(8, actor, null);
  expect(effectiveWorkerLimit("one")).toEqual({ value: 8, source: "machine", machine: 8 });
  expect(effectiveWorkerLimit("two").value).toBe(8);
  expect(readWorkerLimits().history).toMatchObject([{ scope: "machine", from: 3, to: 8, by: actor, reason: null }]);
  expect(fs.statSync(path.join(directory, "worker-limit.json")).mode & 0o777).toBe(0o600);
});

test("an explicit project choice stays explicit until reset and other projects inherit", () => {
  setMachineWorkerLimit(8, actor, null);
  setProjectWorkerLimit("one", 8, actor, null);
  setMachineWorkerLimit(10, actor, null);
  expect(effectiveWorkerLimit("one")).toEqual({ value: 8, source: "project", machine: 10 });
  expect(effectiveWorkerLimit("two").value).toBe(10);
  setProjectWorkerLimit("one", null, actor, null);
  expect(effectiveWorkerLimit("one").value).toBe(10);
  expect(readWorkerLimits().history.at(-1)).toMatchObject({ scope: "project", from: 8, to: null });
});

test("invalid values and a missing agent reason never write, and no-ops add no history", () => {
  for (const value of [0, 65, 2.5, NaN]) expect(() => setMachineWorkerLimit(value, actor, null)).toThrow("1 to 64");
  expect(() => setMachineWorkerLimit(10, { kind: "manager", via: "tool" }, null)).toThrow("reason");
  expect(fs.existsSync(path.join(directory, "worker-limit.json"))).toBe(false);
  setMachineWorkerLimit(10, actor, null);
  expect(setMachineWorkerLimit(10, actor, null).changed).toBe(false);
  expect(readWorkerLimits().history).toHaveLength(1);
});

test("malformed files and invalid entries fall back to the next level", () => {
  fs.writeFileSync(path.join(directory, "worker-limit.json"), "{");
  expect(readWorkerLimits().unreadable).toBe(true);
  expect(effectiveWorkerLimit("one").value).toBe(3);
  fs.writeFileSync(path.join(directory, "worker-limit.json"), JSON.stringify({ schemaVersion: 1, machine: { value: 8, changedAt: "today", changedBy: actor }, projects: { one: { value: 65, changedAt: "today", changedBy: actor } }, history: [] }));
  expect(effectiveWorkerLimit("one").value).toBe(8);
});

test("tool replay records once and resets the machine to the shipped value", () => {
  const agent = { kind: "manager", conversationId: "conversation_one", project: "one", via: "tool" } as const;
  setMachineWorkerLimit(12, agent, "More work ready", "request-one");
  setMachineWorkerLimit(12, agent, "More work ready", "request-one");
  expect(readWorkerLimits().history).toHaveLength(1);
  expect(() => setMachineWorkerLimit(13, agent, "More work ready", "request-one")).toThrow("request id");
  setMachineWorkerLimit(null, actor, null);
  expect(effectiveWorkerLimit("one").value).toBe(3);
});

test("a project's stored limit survives its key moving", () => {
  setProjectWorkerLimit("old", 10, actor, null);
  expect(persistProjectAliases([{ source: "old", target: "new", displayName: "Example" }])).toBe(true);
  expect(effectiveWorkerLimit("old").value).toBe(10);
  expect(effectiveWorkerLimit("new").value).toBe(10);
  setProjectWorkerLimit("old", 12, actor, null);
  expect(effectiveWorkerLimit("new").value).toBe(12);
  expect(readWorkerLimits().projects.old).toBeUndefined();
  setProjectWorkerLimit("new", null, actor, null);
  expect(effectiveWorkerLimit("old").value).toBe(3);
});

test("concurrent processes keep a truthful audit predecessor", async () => {
  const script = path.join(directory, "writer.ts");
  fs.writeFileSync(script, `import { setMachineWorkerLimit } from ${JSON.stringify(path.join(import.meta.dir, "workerLimit.ts"))}; setMachineWorkerLimit(Number(process.argv[2]), {kind: "operator", via: "settings"}, null);`);
  const write = (value: number) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, String(value)], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
  await Promise.all([write(8), write(10)]);
  const history = readWorkerLimits().history;
  expect(history).toHaveLength(2);
  expect(history[0]!.from).toBe(3);
  expect(history[1]!.from).toBe(history[0]!.to);
  expect(effectiveWorkerLimit("one").value).toBe(history[1]!.to!);
}, 15_000);

test("the audit retains the newest 500 changes", () => {
  for (let index = 0; index < 502; index++) setMachineWorkerLimit(index % 2 ? 8 : 10, actor, null);
  const history = readWorkerLimits().history;
  expect(history).toHaveLength(500);
  expect(history[0]!.from).toBe(8);
  expect(history.at(-1)!.to).toBe(8);
}, 15_000);
