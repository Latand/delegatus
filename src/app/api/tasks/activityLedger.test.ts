/**
 * The activity ledger at the task routes: creating a task and editing what it
 * says or where it stands are operator requests; a move, a colour or an agent
 * naming itself are not; and a ledger that cannot be written never refuses the
 * edit.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Establish every state root before importing production modules.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-activity-ledger-"));
const previous = new Map<string, string | undefined>();
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  previous.set(key, process.env[key]);
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
const { NextRequest } = await import("next/server");
const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");
const { readRequests } = await import("@/lib/activity/requestLedger");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
const { statePath } = await import("@/lib/configDir");

const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const headers = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", host: "localhost", "user-agent": DESKTOP, ...extra });
const ledgerDir = () => statePath("activity");
const rows = () => readRequests(0, Date.now() + 60_000, { dir: ledgerDir }).anchors;

async function createTask(text: string): Promise<{ id: string; project: string }> {
  const response = await POST(new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ project: "harbor", text, placement: "unplaced", clientRequestId: `create-${text.replace(/\W/g, "")}` }),
  }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { task: { id: string; project: string } }).task;
}

const patch = (id: string, body: Record<string, unknown>, extra: Record<string, string> = {}) => PATCH(
  new NextRequest("http://localhost/api/tasks", { method: "PATCH", headers: headers(extra), body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

afterEach(() => {
  setCallerConversationResolverForTests(null);
  fs.rmSync(ledgerDir(), { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("creating a task is one request, and editing its text or status is another", async () => {
  const task = await createTask("Draft the release notes");
  expect(rows()).toEqual([{ at: expect.any(Number), project: "harbor", surface: "desktop", kind: "task" }]);
  expect((await patch(task.id, { text: "Draft the release notes for Friday" })).status).toBe(200);
  expect((await patch(task.id, { status: "done" })).status).toBe(200);
  expect(rows().map((row) => row.kind)).toEqual(["task", "task", "task"]);
  const text = fs.readdirSync(ledgerDir()).map((name) => fs.readFileSync(path.join(ledgerDir(), name), "utf8")).join("");
  expect(text).not.toContain("release notes");
  expect(text).not.toContain(task.id);
});

test("a colour or a hide instructs no agent and is not recorded", async () => {
  const task = await createTask("Tidy the board");
  fs.rmSync(ledgerDir(), { recursive: true, force: true });
  expect((await patch(task.id, { color: "teal" })).status).toBe(200);
  expect(rows()).toEqual([]);
});

test("an agent naming itself edits the task and writes no row", async () => {
  const task = await createTask("Agent edited task");
  fs.rmSync(ledgerDir(), { recursive: true, force: true });
  setCallerConversationResolverForTests(() => "conversation_agent");
  const response = await patch(task.id, { details: "agent notes" }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "d".repeat(43) });
  expect(response.status).toBe(200);
  expect(rows()).toEqual([]);
});

test("a ledger that cannot be written still admits the edit", async () => {
  const task = await createTask("Edit through an outage");
  fs.rmSync(ledgerDir(), { recursive: true, force: true });
  fs.writeFileSync(ledgerDir(), "not a directory");
  const response = await patch(task.id, { text: "Edited through an outage" });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { task: { text: string } }).task.text).toBe("Edited through an outage");
});
