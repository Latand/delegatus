import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { GET, PUT } from "./route";
import { GET as seatStatus } from "@/app/api/orchestrator/seat/status/route";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-route-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = directory;
beforeEach(() => fs.rmSync(path.join(directory, "worker-limit.json"), { force: true }));
afterAll(() => {
  setCallerConversationResolverForTests(null);
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const request = (body: unknown, headers = {}) => new NextRequest("http://localhost/api/operator/worker-limit", { method: "PUT", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("operator settings and seat header write both levels through the same route", async () => {
  expect((await (await GET(new NextRequest("http://localhost/api/operator/worker-limit"))).json()).machine.value).toBe(3);
  expect((await PUT(request({ value: 8 }))).status).toBe(200);
  const project = await (await PUT(request({ project: "one", value: 10 }))).json();
  expect(project.project).toMatchObject({ value: 10, effective: 10, source: "project" });
  expect((await (await seatStatus(new NextRequest("http://localhost/api/orchestrator/seat/status?project=one"))).json()).workers).toMatchObject({ limit: 10, source: "project", machine: 8, running: 0, runningMachine: 0 });
  await PUT(request({ project: "one", value: null }));
  const history = JSON.parse(fs.readFileSync(path.join(directory, "worker-limit.json"), "utf8")).history;
  expect(history).toMatchObject([{ by: { kind: "operator", via: "settings" }, reason: null }, { by: { via: "seat-header" }, reason: null }, { to: null }]);
});

test("invalid values, cross origin and agent capabilities are refused without writes", async () => {
  for (const value of [0, 65, 2.5, "8"]) expect((await PUT(request({ value }))).status).toBe(400);
  expect((await PUT(request({ value: 8 }, { origin: "https://remote.example" }))).status).toBe(403);
  setCallerConversationResolverForTests(() => "conversation_one");
  expect((await PUT(request({ value: 8 }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) }))).status).toBe(403);
  expect(fs.existsSync(path.join(directory, "worker-limit.json"))).toBe(false);
});
