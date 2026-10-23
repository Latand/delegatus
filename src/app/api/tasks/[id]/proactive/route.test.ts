import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { PipelinePorts } from "@/lib/pipelines/engine";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-decisions-"));
const keys = ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR", "LLV_RUNTIME_HOST_SOCKET", "LLV_VIEWER_CONTROL_URL"] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.TMPDIR = path.join(sandbox, "tmp");
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
delete process.env.LLV_RUNTIME_HOST_SOCKET;
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { GET, POST } = await import("./route");
const { POST: createPipelineHttp } = await import("@/app/api/pipelines/route");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
const { admitProactiveTask, proactiveCandidateDecision, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
const { candidate, context, authority } = await import("@/lib/tasks/proactive.fixture");
const { loadTasks } = await import("@/lib/tasks/store");
const { launchAdmission } = await import("@/lib/tasks/launchMembership");
const { createPipelineFromRequest } = await import("@/lib/pipelines/engine");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");

const base = new URL("http://localhost");
const browser = { host: base.host, origin: base.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
const request = (decision: unknown, headers = browser, expected?: unknown) => new NextRequest(new URL("api/tasks/task/proactive", base), {
  method: "POST", headers, body: JSON.stringify({ decision, expected, actor: "operator" }),
});
afterEach(() => setCallerConversationResolverForTests(null));
afterAll(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("operator decisions require same-origin authority; a body cannot impersonate the operator", async () => {
  const { task } = await admitProactiveTask(candidate("http-decisions"), context(), undefined, authority());
  const ctx = { params: Promise.resolve({ id: task.id }) };
  const before = loadTasks();
  const initial = proactiveDecisionToken(task);
  const send = (decision: unknown, headers = browser, expected = proactiveDecisionToken(task)) => POST(request(decision, headers, expected), ctx);
  setCallerConversationResolverForTests(() => "conversation_agent");
  const agentHeaders = { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) };
  for (const decision of ["adopt", "reject"]) expect((await send(decision, agentHeaders)).status).toBe(403);
  expect((await GET(new NextRequest(new URL("api/tasks/task/proactive", base), { headers: agentHeaders }), ctx)).status).toBe(403);
  expect((await send("adopt", { ...browser, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect(proactiveCandidateDecision(task)).toEqual({ rejected: false, adopted: false });
  setCallerConversationResolverForTests(() => null);
  const read = await GET(new NextRequest(new URL("api/tasks/task/proactive", base), { headers: browser }), ctx);
  expect(read.headers.get("Cache-Control")).toBe("no-store");
  expect(await read.json()).toMatchObject({ expected: initial, decision: { adopted: false, rejected: false } });
  expect((await send("unknown")).status).toBe(400);
  expect((await POST(request("adopt"), ctx)).status).toBe(400);
  for (const expected of [{ ...initial, taskId: "another-task" }, { ...initial, scopeRevision: 1 }, { ...initial, scopeHash: "f".repeat(64) }]) {
    expect((await send("adopt", browser, expected)).status).toBe(409);
  }
  expect((await send("adopt")).status).toBe(200);
  expect(launchAdmission(loadTasks())).toBeNull();
  expect((await send("reject")).status).toBe(200);
  expect((await send("adopt", browser, initial)).status).toBe(409);
  expect(launchAdmission(loadTasks())).toMatchObject({ code: "PROACTIVE_EXECUTION_FENCED", status: 403 });
  expect(loadTasks()).toEqual(before);
});

test("pipeline HTTP, MCP and shared creation refuse prepared invented work before any stage or provisioning", async () => {
  const { task } = await admitProactiveTask(candidate("transport-fence"), context(), undefined, authority());
  const input = { task: task.text, taskIds: [task.id], repoDir: sandbox, stages: [], autoStart: false };
  const unusedPorts = {} as PipelinePorts;
  expect(await createPipelineFromRequest(input, unusedPorts)).toMatchObject({ status: 403, error: expect.stringContaining("disabled") });
  const response = await createPipelineHttp(new NextRequest(new URL("api/pipelines", base), {
    method: "POST", headers: browser, body: JSON.stringify(input),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("disabled") });
  // The real MCP binding reaches the same creation command. Supplying src
  // avoids the unrelated authenticated-source inference preflight.
  await expect(viewerMcpBindings().create_pipeline({ ...input, src: "transcript.jsonl", clientRequestId: "proactive_transport_fence" }))
    .rejects.toThrow("disabled");
});
