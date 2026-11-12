import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeClaudeCloud } from "@/lib/pipelines/claudeCloud.fixture";
import { createClaudeCloudTaskProvider } from "@/lib/pipelines/cloudClaudeClient";
import { CLAUDE_CLOUD_TASK_PROMPT } from "@/lib/pipelines/claudeCloudTaskPrompt";
import { prepareClaudeCloudTask, readClaudeCloudReadiness, claudeTaskStep } from "./claudeCloudTasks";
import { updateOperatorSettings } from "@/lib/operator/settings";
import { claudeCloudTasks, setClaudeCloudTasks, setClaudeCloudTaskFor } from "./settings";
import { persistProjectAliases, recordProjectRemote } from "./aliases";

const previous = process.env.LLV_STATE_DIR;
const roots: string[] = [], stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); process.env.LLV_STATE_DIR = previous; });
const task = (extra: Record<string, unknown> = {}) => ({ id: "task-existing", name: "Delegatus pipeline stages", enabled: true, created_at: "2026-01-01T00:00:00Z",
  job_config: { ccr: { session_context: { sources: [{ git_repository: { url: "https://github.com/sample/project.git" } }] } } }, ...extra });
function fixture(options: Parameters<typeof fakeClaudeCloud>[0] = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-preparation-")); roots.push(root); process.env.LLV_STATE_DIR = root;
  const fake = fakeClaudeCloud(options); stops.push(fake.stop);
  recordProjectRemote({ project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", canonicalRemote: "https://github.com/sample/project" });
  let clock = Date.UTC(2026, 10, 1);
  const input = { project: "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", account: { engine: "claude" as const, accountId: "default", home: root, transcriptRoot: root, kind: "managed" as const, env: { NODE_ENV: "test" as const } },
    repository: "sample/project", ref: "main", signal: new AbortController().signal, assertCurrent: () => {}, now: () => clock };
  const provider = createClaudeCloudTaskProvider({ ...fake.dependencies, now: input.now });
  return { fake, input, provider, advance: (ms: number) => { clock += ms; fake.advance(ms); },
    prepare: (force = false) => prepareClaudeCloudTask({ ...input, force }, provider),
    restart: async (force = false) => {
      const child = Bun.spawn([process.execPath, "src/lib/projects/fixtures/claudeCloudTaskRestart.ts"], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ project: input.project, account: input.account, origin: fake.origin, now: clock, force })); child.stdin.end();
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, err).toBe(0); return JSON.parse(out);
    }, posts: () => fake.calls.filter(c => c.method === "POST" && c.path === "/v1/code/triggers") };
}

test("creation uses the shipped prompt, removes default connectors, binds once and survives restart", async () => {
  const f = fixture();
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "task-created-1" });
  expect(f.posts()).toHaveLength(1);
  const body = f.posts()[0]!.body!;
  expect(body).toMatchObject({ enabled: true, clear_mcp_connections: true, run_once_at: "2027-11-01T12:00:00.000Z", job_config: { ccr: {
    environment_id: "env-fixture", session_context: { allowed_tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] },
    events: [{ data: { type: "user", message: { content: CLAUDE_CLOUD_TASK_PROMPT.replace(/\s+/g, " ") } } }] } } });
  expect(f.fake.calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/v1/code/triggers", "/v1/code/triggers/task-created-1"]);
  expect(await f.restart()).toMatchObject({ state: "ready", environmentId: "task-created-1" });
  expect(f.posts()).toHaveLength(1);
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state: "ready", taskId: "task-created-1" });
});

test("discovery adopts and repairs an existing task; chooses enabled then oldest deterministically", async () => {
  const f = fixture({ tasks: [task({ id: "paused", enabled: false }), task({ id: "new", created_at: "2026-10-01" }), task({ mcp_connections: [{ name: "connector" }] })] });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "task-existing" });
  expect(f.posts()).toHaveLength(0);
  expect(f.fake.calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/v1/code/triggers/task-existing"]);
});

test("a paused task is enabled and its connector is cleared in one update", async () => {
  const f = fixture({ tasks: [task({ enabled: false, mcp_connections: [{}] })] });
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(f.fake.calls.find(c => c.method === "POST")?.body).toEqual({ enabled: true, clear_mcp_connections: true });
  expect(f.posts()).toHaveLength(0);
});

test("prompt marker adopts a renamed task, and an unrelated routine is left untouched", async () => {
  const matching = task({ id: "renamed", name: "Renamed", job_config: { ccr: { session_context: { sources: [{ git_repository: { url: "https://github.com/sample/project" } }] }, events: [{ data: { message: { content: CLAUDE_CLOUD_TASK_PROMPT } } }] } } });
  const f = fixture({ tasks: [task({ id: "personal", name: "Personal" }), matching] });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "renamed" });
  expect(f.fake.calls.some(c => c.path.includes("personal"))).toBe(false);
  expect(f.posts()).toHaveLength(0);
});

test.each([
  ["incomplete list", { hasMore: true }, "task_list_incomplete"],
  ["GitHub disconnected", { githubConnected: false }, "github_not_connected"],
  ["no environment", { environments: [] }, "no_environment"],
])("%s stops before creation and persists its precise readiness", async (_name, options, code) => {
  const f = fixture(options);
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state: "unavailable", code });
  expect(f.posts()).toHaveLength(0);
  const calls = f.fake.calls.length;
  expect(await f.restart()).toMatchObject({ state: "unavailable" });
  expect(f.fake.calls).toHaveLength(calls);
  expect(await f.prepare(true)).toMatchObject({ state: "unavailable" });
  expect(f.fake.calls.length).toBeGreaterThan(calls);
});

test.each([400, 401])("definitive creation refusal %s releases only its claim and keeps provider text private", async status => {
  let refuse = true;
  const f = fixture({ preparationAnswer: (method, target) => method === "POST" && target === "/v1/code/triggers" && refuse
    ? Response.json({ error: { reason: status === 401 ? "github_token_missing" : "bad_request", message: "private-provider-detail" } }, { status }) : null });
  const result = await f.prepare();
  expect(result).toMatchObject({ state: "unavailable", reason: expect.stringContaining(status === 401 ? "GitHub is not connected" : "creation (400)") });
  expect(JSON.stringify(result)).not.toContain("private-provider-detail");
  refuse = false;
  expect(await f.restart(true)).toMatchObject({ state: "ready" });
  expect(f.posts()).toHaveLength(2);
});

test("uncertain creation is adopted after process restart without a second POST", async () => {
  const f = fixture({ preparationAnswer: (method, target) => {
    if (method !== "POST" || target !== "/v1/code/triggers") return null;
    f.fake.tasks.set("task-existing", task());
    return Response.json({ error: "lost answer" }, { status: 503 });
  } });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("may have succeeded") });
  f.advance(900_001);
  expect(await f.restart()).toMatchObject({ state: "ready", environmentId: "task-existing" });
  expect(f.posts()).toHaveLength(1);
});

test("unanswered claim is released only after two complete lists ten minutes later, across restarts", async () => {
  let uncertain = true;
  const f = fixture({ preparationAnswer: (method, target) => uncertain && method === "POST" && target === "/v1/code/triggers" ? new Response("unreadable", { status: 200 }) : null });
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  f.advance(60_001);
  expect(await f.restart(true)).toMatchObject({ state: "unavailable" });
  expect(f.posts()).toHaveLength(1);
  f.advance(540_001);
  expect(await f.restart(true)).toMatchObject({ state: "unavailable" });
  expect(f.posts()).toHaveLength(1);
  uncertain = false;
  expect(await f.restart(true)).toMatchObject({ state: "ready" });
  expect(f.posts()).toHaveLength(2);
});

test("concurrent slices make one creation claim and only one POST", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  const f = fixture({ preparationAnswer: (method, target, body) => {
    if (method !== "POST" || target !== "/v1/code/triggers") return null;
    dispatched();
    return barrier.then(() => { const created = task({ ...body, id: "task-created" }); f.fake.tasks.set("task-created", created); return Response.json({ trigger: created }); });
  } });
  const first = f.prepare();
  await started;
  const second = await f.prepare();
  expect(second).toMatchObject({ state: "pending" });
  release();
  await first;
  f.advance(2001);
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(f.posts()).toHaveLength(1);
});

test("a failed repair retains its status; no creation follows", async () => {
  const f = fixture({ tasks: [task({ enabled: false })], preparationAnswer: method => method === "POST" ? Response.json({ error: {} }, { status: 403 }) : null });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("(403)") });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ code: "update_refused", taskId: "task-existing" });
  expect(f.posts()).toHaveLength(0);
});

test("transient failures keep a persisted bounded retry window across real process restart", async () => {
  const f = fixture({ preparationAnswer: () => new Response("", { status: 503 }) });
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  f.advance(2001); expect(await f.restart()).toMatchObject({ state: "pending" });
  f.advance(4001); expect(await f.restart()).toMatchObject({ state: "unavailable" });
  const count = f.fake.calls.length;
  expect(await f.restart()).toMatchObject({ state: "unavailable" });
  expect(f.fake.calls).toHaveLength(count);
});

test("atomic binding upsert preserves other accounts, predecessor entries and a concurrent manual choice", async () => {
  const f = fixture();
  setClaudeCloudTasks("old-fixture", [{ accountId: "account-b", taskId: "task-b" }]);
  persistProjectAliases([{ source: "old-fixture", target: f.input.project, displayName: "Fixture" }]);
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(claudeCloudTasks("old-fixture")).toEqual([{ accountId: "account-b", taskId: "task-b" }, { accountId: "default", taskId: "task-created-1" }]);
  expect(setClaudeCloudTaskFor(f.input.project, "default", "replacement", null)).toBe("task-created-1");
  expect(setClaudeCloudTaskFor(f.input.project, "default", "replacement", "task-created-1")).toBe("replacement");
});

test.each(["missing", "foreign"])("a %s manual task is rebound without modifying the foreign task", async kind => {
  const f = fixture({ task: kind === "missing" ? null : task({ job_config: { ccr: { session_context: { sources: [{ git_repository: { url: "https://github.com/other/project" } }] } } } }) });
  setClaudeCloudTasks(f.input.project, [{ accountId: "default", taskId: "foreign" }]);
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "task-created-1" });
  expect(f.fake.calls.some(c => c.method === "POST" && c.path.endsWith("/foreign"))).toBe(false);
});

test.each([
  ["GET", "/v1/code/triggers"],
  ["GET", "/api/oauth/organizations/org-fixture/sync/github/auth"],
  ["GET", "/v1/environment_providers"],
  ["POST", "/v1/code/triggers"],
  ["POST", "/v1/code/triggers/task-created-1"],
])("organization changes after %s %s fence off further effects and binding", async (method, target) => {
  const f = fixture();
  let identity = "a".repeat(64);
  const provider = { identity: async () => identity, request: async (...args: Parameters<typeof f.provider.request>) => {
    // This fake exposes the race after the selected provider effect.
    const [account, signal, verb, path_, body] = args;
    const answer = await f.provider.request(account, signal, verb, path_, body);
    const path = args[3].replace("/organizations/current/", "/organizations/org-fixture/");
    if (args[2] === method && path === target) identity = "b".repeat(64);
    return answer;
  } };
  expect(await prepareClaudeCloudTask(f.input, provider)).toMatchObject({ state: "pending" });
  expect(f.posts().length).toBe(method === "POST" ? 1 : 0);
  expect(claudeCloudTasks(f.input.project)).toEqual([]);
});

test("a principal changed inside the login await cannot send a creation on the replacement login", async () => {
  const f = fixture();
  let reads = 0;
  const provider = createClaudeCloudTaskProvider({ ...f.fake.dependencies, readLogin: async () => ({ accessToken: "fixture", organization: ++reads >= 4 ? "replacement" : "org-fixture", expiresAt: 0 }) });
  expect(await prepareClaudeCloudTask(f.input, provider)).toMatchObject({ state: "pending" });
  expect(f.fake.calls).toHaveLength(0);
});

test("write access overlays readiness during its hold and keeps one linked remedy after expiry", async () => {
  const f = fixture({ tasks: [task()] });
  await f.prepare();
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR!, "cloud"), { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "cloud/claude-write-access.json"), JSON.stringify({ "default/task-existing": f.input.now() }));
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("https://github.com/settings/installations") });
  expect(readClaudeCloudReadiness(f.input.project, { now: f.input.now() })[0]).toMatchObject({ state: "unavailable", code: "github_write_access", step: { code: "github_read_only" } });
  f.advance(6 * 3_600_000 + 1);
  expect(await f.restart()).toMatchObject({ state: "ready" });
  expect(readClaudeCloudReadiness(f.input.project, { now: f.input.now() })[0]).toMatchObject({ state: "ready", step: { code: "github_read_only" } });
  expect(claudeTaskStep("github_not_connected")?.url).toBe("https://claude.ai/connect-github");
});


test("human-only readiness exposes one action in the operator’s current language without provider reads", async () => {
  const f = fixture({ githubConnected: false });
  await f.prepare();
  const count = f.fake.calls.length;
  updateOperatorSettings({ locale: "uk" }, "2026-11-01T00:00:00Z");
  expect(readClaudeCloudReadiness(f.input.project)[0]?.step).toMatchObject({ code: "connect_github", text: expect.stringContaining("Підключіть GitHub"), url: "https://claude.ai/connect-github" });
  updateOperatorSettings({ locale: "en" }, "2026-11-01T00:00:01Z");
  expect(readClaudeCloudReadiness(f.input.project)[0]?.step).toMatchObject({ code: "connect_github", text: expect.stringContaining("Connect GitHub"), url: "https://claude.ai/connect-github" });
  expect(f.fake.calls).toHaveLength(count);
});

test("a personal routine with the same repository is never modified when Delegatus creates its own", async () => {
  const personal = task({ id: "personal", name: "Personal routine", enabled: false, mcp_connections: [{}] });
  const f = fixture({ tasks: [personal] });
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(f.posts()).toHaveLength(1);
  expect(f.fake.calls.some(c => c.path.endsWith("/personal"))).toBe(false);
  expect(f.fake.tasks.get("personal")).toEqual(personal);
});


test("an unreadable task list cannot prove absence and creates nothing", async () => {
  const f = fixture({ preparationAnswer: (_method, target) => target === "/v1/code/triggers" ? Response.json({ data: [{ id: "incomplete" }], has_more: false }) : null });
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  expect(f.posts()).toHaveLength(0);
});


test("a sign-in that disappears during a read reports its cause without another remote effect", async () => {
  const f = fixture();
  let present = true;
  const provider = createClaudeCloudTaskProvider({ ...f.fake.dependencies,
    readLogin: async () => present ? { accessToken: "fixture", organization: "org-fixture", expiresAt: 0 } : null,
    fetch: (async (...args: Parameters<typeof fetch>) => { const answer = await f.fake.dependencies.fetch!(...args); present = false; return answer; }) as typeof fetch });
  expect(await prepareClaudeCloudTask(f.input, provider)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("sign-in is missing") });
  expect(f.posts()).toHaveLength(0);
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ code: "login_missing" });
});


test("a known creation id survives a failed repair and a restart even when the list hides the task", async () => {
  let refuseRepair = true;
  const f = fixture({ preparationAnswer: (method, target) => {
    if (method === "POST" && target === "/v1/code/triggers/task-created-1" && refuseRepair) return Response.json({ error: {} }, { status: 403 });
    if (method === "GET" && target === "/v1/code/triggers") return Response.json({ data: [], has_more: false });
    return null;
  } });
  expect(await f.prepare()).toMatchObject({ state: "unavailable" });
  refuseRepair = false;
  f.advance(900_001);
  expect(await f.restart()).toMatchObject({ state: "ready", environmentId: "task-created-1" });
  expect(f.posts()).toHaveLength(1);
});
