import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { resetDoneProjectionThrottleForTests, type DoneWorld } from "@/lib/done/project";
import { readDoneRows, resetDoneCollectionsForTests, writeDoneProjection } from "@/lib/done/store";
import type { BoardTask } from "@/lib/tasks/types";

import { doneAcknowledgeHandler, doneReadHandler } from "./handler";

/* The «Готово» route (docs/design/done-section.md §3) over a private state
   directory and an invented world: GET projects and answers what waits, POST
   is the operator's acknowledgement and its undo. */

const T0 = Date.parse("2026-10-11T08:00:00Z");
let now = T0;
let tasks: BoardTask[] = [];
let sandbox = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-done-route-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetDoneCollectionsForTests();
  resetDoneProjectionThrottleForTests();
  now = T0;
  tasks = [];
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  resetDoneCollectionsForTests();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const world = (): DoneWorld => ({
  now: () => now,
  forge: () => ({ schemaVersion: 1, repositories: {} }),
  pipelines: () => [],
  tasks: () => tasks,
  deployments: () => [],
  reports: () => [],
  limits: () => ({}),
  pipelineRepository: () => null,
  repositoryProject: () => null,
  accountLabel: () => null,
  rounds: () => [],
  album: async () => ({ frame: null, settled: true }),
});

const read = doneReadHandler({ world, now: () => now });
const acknowledge = doneAcknowledgeHandler({ now: () => now });

const post = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/attention/done", {
  method: "POST", headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const done = (id: string, at: number) => ({ id, project: "repo-a", status: "done", doneAt: new Date(at).toISOString(), text: `Задача ${id}`, assignments: [], createdAt: new Date(T0 - 3_600_000).toISOString(), updatedAt: new Date(at).toISOString() }) as unknown as BoardTask;

test("the production read answers its persisted bootstrap while a frame copy is held",async () => {
  await read(); now+=60_000; tasks=[done("old",T0+10_000)];await read();
  const item=readDoneRows()[0]!;
  writeDoneProjection({upserts:[{...item,look:"visible",frame:{src:"/api/artifact?path=old.png",caption:"Old frame"}}]},now);
  resetDoneProjectionThrottleForTests();
  let release!:()=>void, started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{started=resolve;});
  const current=world(); current.preserveFrame=async(_key,frame)=>{started();await held;return {frame:{...frame,src:"/api/image?done=task%3Aold&media=saved"},settled:true};};
  const fast=doneReadHandler({world:()=>current,now:()=>now,deferProjection:true});
  const response=await fast();await ready;
  expect((await response.json()).items[0].frame.src).toBe("/api/artifact?path=old.png");
  release();await new Promise<void>(resolve=>setImmediate(resolve));
  expect((await (await fast()).json()).items[0].frame.src).toBe("/api/image?done=task%3Aold&media=saved");
});

test("GET projects the sources and answers the items still waiting, newest first", async () => {
  expect(await (await read()).json()).toMatchObject({ ok: true, items: [] });
  now = T0 + 60_000;
  tasks = [done("one", T0 + 10_000), done("two", T0 + 20_000)];
  const response = await read();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json() as { items: Array<{ key: string; title: string }>; revision: number };
  expect(body.items.map((item) => item.key)).toEqual(["task:two", "task:one"]);
  expect(body.items[0]!.title).toBe("Задача two");
  expect(body.revision).toBeGreaterThan(0);
});

test("POST acknowledges and undoes, durably, and answers the rows it changed", async () => {
  await read();
  now = T0 + 60_000;
  tasks = [done("one", T0 + 10_000)];
  await read();
  const first = await acknowledge(post({ keys: ["task:one", "task:unknown"], surface: "phone" }));
  expect(first.status).toBe(200);
  const answer = await first.json() as { changed: Array<{ key: string; acknowledgedBy: unknown }> };
  expect(answer.changed.map((row) => [row.key, row.acknowledgedBy])).toEqual([["task:one", { kind: "operator", surface: "phone" }]]);
  expect((await (await read()).json() as { items: unknown[] }).items).toEqual([]);
  /* A second acknowledgement changes nothing; undo brings it back. */
  expect((await (await acknowledge(post({ keys: ["task:one"] }))).json() as { changed: unknown[] }).changed).toEqual([]);
  expect((await (await acknowledge(post({ keys: ["task:one"], undo: true }))).json() as { changed: unknown[] }).changed).toHaveLength(1);
  expect(readDoneRows()[0]).toMatchObject({ acknowledgedAt: null, acknowledgedBy: null });
});

test("POST refuses a cross-origin page, an agent, a malformed body and more than 200 keys before writing", async () => {
  await read();
  now = T0 + 60_000;
  tasks = [done("one", T0 + 10_000)];
  await read();
  const refusals: Array<[NextRequest, number]> = [
    [post({ keys: ["task:one"] }, { Origin: "http://foreign.example" }), 403],
    [post({ keys: ["task:one"] }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "capability" }), 403],
    [post("{"), 400],
    [post({ keys: [] }), 400],
    [post({ keys: [7] }), 400],
    [post({ keys: ["task:one"], undo: "yes" }), 400],
    [post({ keys: Array.from({ length: 201 }, (_, index) => `task:${index}`) }), 400],
  ];
  for (const [request, status] of refusals) {
    const response = await acknowledge(request);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(readDoneRows()[0]!.acknowledgedAt).toBeNull();
});
