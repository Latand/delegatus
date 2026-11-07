import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The wrapped route as a member reaches it: the task's project is read by key,
   so authorizing one task never loads the task collection. State is private. */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-files-route-"));
const previous = new Map<string, string | undefined>();
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  previous.set(key, process.env[key]);
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}

let NextRequest: typeof import("next/server").NextRequest;
let GET: typeof import("./route").GET;
let CONTENT_GET: typeof import("./content/route").GET;
let tasks: typeof import("@/lib/tasks/store");
let resetTeamStoreForTests: typeof import("@/lib/team/store").resetTeamStoreForTests;
let cookie = "";
let cookieName = "";
/* Minting and verification both read the real clock (verifySessionValue uses
   Date.now()), so the 30-day idle limit never ages this fixture out. */
const now = Date.now();
const at = new Date(now).toISOString();

beforeAll(async () => {
  ({ NextRequest } = await import("next/server"));
  ({ GET } = await import("./route"));
  ({ GET: CONTENT_GET } = await import("./content/route"));
  tasks = await import("@/lib/tasks/store");
  const team = await import("@/lib/team/store");
  resetTeamStoreForTests = team.resetTeamStoreForTests;
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { mintSession, MEMBER_COOKIE } = await import("@/lib/team/sessions");
  cookieName = MEMBER_COOKIE;
  const store = team.teamStore();
  const person = (id: string, role: "owner" | "member") => ({ id, name: id, role, status: "active" as const, color: "teal" as const, telegram: null, createdAt: at, createdBy: "claim" as const, revokedAt: null });
  const owner = person("m_owner", "owner");
  const member = person("m_member", "member");
  store.insertMember(owner);
  store.insertMember(member);
  const workspace = `w_${"a".repeat(32)}`;
  createWorkspace(store, owner, { id: workspace, name: "Owned", projects: ["repo-owned"] });
  store.putWorkspaceMember(workspace, member.id, "member", owner.id, at);
  tasks.saveTasks(["owned", "foreign"].map((name) => ({ id: `task-${name}`, project: `repo-${name}`, text: name, status: "inbox" as const, placement: "unplaced" as const, assignments: [], createdAt: at, updatedAt: at })));
  cookie = mintSession(store, member.id, "claim", { surface: "desktop", browser: "chrome" }, now).value;
});

afterAll(() => {
  resetTeamStoreForTests();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const request = (path: string) => new NextRequest(`http://localhost${path}`, { headers: { host: "localhost", cookie: `${cookieName}=${cookie}` } });

test("a member's own task is authorized and a foreign one refused, cold and warm, without reading the task collection", async () => {
  const full = spyOn(tasks, "loadTasksForList");
  const keyed = spyOn(tasks, "loadTasksByIds");
  try {
    for (const round of [0, 1]) {
      const own = await GET(request("/api/tasks/task-owned/files?lanes=lane-absent"), { params: Promise.resolve({ id: "task-owned" }) });
      expect({ round, status: own.status }).toEqual({ round, status: 200 });
      const foreign = await GET(request("/api/tasks/task-foreign/files?lanes=lane-absent"), { params: Promise.resolve({ id: "task-foreign" }) });
      expect({ round, status: foreign.status, code: (await foreign.json()).code }).toEqual({ round, status: 403, code: "workspace_forbidden" });
      const head = "a".repeat(40);
      const content = await CONTENT_GET(request(`/api/tasks/task-foreign/files/content?lane=lane-absent&head=${head}&file=docs%2Fa.md`), { params: Promise.resolve({ id: "task-foreign" }) });
      expect(content.status).toBe(403);
    }
    expect(full.mock.calls.length).toBe(0);
    expect(keyed.mock.calls.length).toBeGreaterThan(0);
  } finally {
    full.mockRestore();
    keyed.mockRestore();
  }
});
