import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeClaudeCloud } from "@/lib/pipelines/claudeCloud.fixture";
import { createClaudeCloudTaskProvider } from "@/lib/pipelines/cloudClaudeClient";
import { CLAUDE_CLOUD_TASK_PROMPT } from "@/lib/pipelines/claudeCloudTaskPrompt";
import { prepareClaudeCloudTask, readClaudeCloudReadiness } from "./claudeCloudTasks";
import { queueClaudeCloudTasks, settleClaudeCloudTaskDemands } from "./claudeCloudTaskDemand";
import { updateOperatorSettings } from "@/lib/operator/settings";
import { claudeCloudTasks, setClaudeCloudTasks, setClaudeCloudTaskFor } from "./settings";
import { persistProjectAliases, recordProjectRemote } from "./aliases";
import { projectIdentityFromRemote } from "./identity";

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

test("readiness accepts the canonical remote emitted by the production identity writer", async () => {
  const f = fixture();
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  const identity = projectIdentityFromRemote("https://github.com/sample/project.git", "/")!;
  recordProjectRemote({ project: f.input.project, canonicalRemote: identity.canonicalRemote });
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

test.each([
  ["no task", []],
  ["existing task", [task()]],
])("GitHub disconnection is visible for %s without creating a replacement task", async (_name, tasks) => {
  const f = fixture({ tasks, githubConnected: false });
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("GitHub is not connected") });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state: "unavailable", code: "github_not_connected" });
  expect(f.posts()).toHaveLength(0);
  expect(f.fake.calls.some(call => call.method === "GET" && call.path.endsWith("/sync/github/auth"))).toBe(true);
});

test.each(["bound task", "saved receipt"])("a disconnected GitHub account cannot confirm a %s as ready", async path => {
  const f = fixture();
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  if (path === "saved receipt") setClaudeCloudTasks(f.input.project, []);
  const provider = { ...f.provider, request: async (...args: Parameters<typeof f.provider.request>) => {
    const [, , method, target] = args;
    if (method === "GET" && target.endsWith("/sync/github/auth")) return Response.json({ is_authenticated: false });
    return f.provider.request(...args);
  } };
  expect(await prepareClaudeCloudTask(f.input, provider)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("GitHub is not connected") });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state: "unavailable", code: "github_not_connected", step: { code: "connect_github", url: "https://claude.ai/connect-github" } });
  expect(f.posts()).toHaveLength(1);
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


test.each([false, true])("an operator binding change cannot pair an old task with a new fingerprint (bound: %s)", async prebound => {
  const f = fixture();
  if (prebound) setClaudeCloudTasks(f.input.project, [{ accountId: "default", taskId: "previous-choice" }]);
  let changed = false;
  const provider = { ...f.provider, identity: async (account: Parameters<typeof f.provider.identity>[0]) => {
    const identity = await f.provider.identity(account);
    if (!changed && claudeCloudTasks(f.input.project).length && (!prebound || f.fake.calls.some(call => call.path.endsWith("/previous-choice")))) {
      changed = true;
      setClaudeCloudTasks(f.input.project, [{ accountId: "default", taskId: "operator-choice" }]);
    }
    return identity;
  } };
  expect(await prepareClaudeCloudTask(f.input, provider)).toMatchObject({ state: "pending", reason: "Claude task binding changed; retrying" });
  expect(claudeCloudTasks(f.input.project)).toEqual([{ accountId: "default", taskId: "operator-choice" }]);
  expect(f.posts()).toHaveLength(prebound ? 0 : 1);
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "operator-choice", selection: JSON.stringify("operator-choice") });
  expect(f.posts()).toHaveLength(prebound ? 0 : 1);
});


test("a peer’s pending checkpoint cannot discard the successful creation receipt", async () => {
  let release!: () => void, entered!: () => void, hide = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ preparationAnswer: (method, target, body) => {
    if (method === "GET" && target === "/v1/code/triggers" && hide) return Response.json({ data: [], has_more: false });
    if (method !== "POST" || target !== "/v1/code/triggers") return null;
    entered();
    return barrier.then(() => {
      const created = task({ ...body, id: "task-created" });
      f.fake.tasks.set("task-created", created); hide = true;
      return Response.json({ trigger: created });
    });
  } });
  const first = f.prepare();
  await started;
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  release();
  expect(await first).toMatchObject({ state: "ready", environmentId: "task-created" });
  setClaudeCloudTasks(f.input.project, []);
  expect(await f.restart()).toMatchObject({ state: "ready", environmentId: "task-created" });
  expect(f.posts()).toHaveLength(1);
});


test("an authenticated GitHub connection needs no permission-change remedy", async () => {
  const f = fixture({ preparationAnswer: (_method, target) => target.endsWith("/sync/github/auth")
    ? Response.json({ is_authenticated: true, permissions: { contents: "write" } }) : null });
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state: "ready", code: null, step: null });
  expect(f.fake.runCalls()).toBe(0);
});


test.each(["environments", "data", "array"])("the observed environment response (%s) supplies the task environment", async shape => {
  const rows = [{ environment_id: "environment-observed", kind: "anthropic_cloud", state: "active", name: "Default" }];
  const f = fixture({ preparationAnswer: (_method, target) => target === "/v1/environment_providers"
    ? Response.json(shape === "array" ? rows : { [shape]: rows }) : null });
  expect(await f.prepare()).toMatchObject({ state: "ready" });
  expect(f.posts()[0]?.body).toMatchObject({ job_config: { ccr: { environment_id: "environment-observed" } } });
});

test("an unreadable environment response asks for no human setup and creates nothing", async () => {
  const f = fixture({ preparationAnswer: (_method, target) => target === "/v1/environment_providers" ? Response.json({ unexpected: [] }) : null });
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ code: "provider_unavailable", step: null });
  expect(f.posts()).toHaveLength(0);
});


test("a renamed routine with the previously shipped prompt is adopted without a duplicate", async () => {
  const previousPrompt = "Your assignment arrives in follow-up messages whose first line carries a nonce\nand a token. Until one arrives, change nothing and end your turn.\n\nThe owner of this repository requires a GitHub write probe before any work, to\nprove a session cannot write. A follow-up headed \"GitHub write probe\" lists its\ncommands: run each exactly as written, once, in its own Bash call, report their\nresults and stop. Each is expected to be refused; a refusal from any layer is the\nuseful result, so do not retry it or try another way. The probe is the only\nexception to the next rule.\n\nOtherwise never push, and open and comment on nothing on GitHub. Send no\nnotifications. Other follow-ups name a head to work on; follow them exactly and end\nyour work with the final message the assignment describes.";
  const previous = task({ id: "previous-routine", name: "Renamed routine", job_config: { ccr: {
    session_context: { sources: [{ git_repository: { url: "https://github.com/sample/project" } }] },
    events: [{ data: { message: { content: previousPrompt } } }],
  } } });
  const f = fixture({ tasks: [previous] });
  expect(await f.prepare()).toMatchObject({ state: "ready", environmentId: "previous-routine" });
  expect(f.posts()).toHaveLength(0);
  expect(f.fake.runCalls()).toBe(0);
});


test.each([true, false])("stored readiness survives an empty remote catalog (connected: %s)", async connected => {
  const f = fixture({ githubConnected: connected });
  f.input.project = "repo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const state = connected ? "ready" : "unavailable";
  expect(await f.prepare()).toMatchObject({ state });
  const count = f.fake.calls.length;
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state,
    ...(connected ? { taskId: "task-created-1" } : { code: "github_not_connected", step: { code: "connect_github" } }) });
  if (!connected) {
    updateOperatorSettings({ locale: "uk" }, "2026-11-01T00:00:00Z");
    expect(readClaudeCloudReadiness(f.input.project)[0]?.step).toMatchObject({ text: expect.stringContaining("Підключіть GitHub"), url: "https://claude.ai/connect-github" });
    updateOperatorSettings({ locale: "en" }, "2026-11-01T00:00:01Z");
    expect(readClaudeCloudReadiness(f.input.project)[0]?.step?.text).toContain("Connect GitHub");
  }
  recordProjectRemote({ project: f.input.project, canonicalRemote: "https://github.com/sample/project" });
  expect(readClaudeCloudReadiness(f.input.project)[0]?.state).toBe(state);
  recordProjectRemote({ project: f.input.project, canonicalRemote: "https://github.com/sample/changed" });
  expect(readClaudeCloudReadiness(f.input.project)[0]).toMatchObject({ state: "not_prepared", code: null, step: null });
  expect(f.fake.calls).toHaveLength(count);
});

test("automatic demands preserve the persisted cooldown and explicit preparation renews it", async () => {
  const f = fixture({ preparationAnswer: () => new Response("", { status: 503 }) });
  expect(await f.prepare()).toMatchObject({ state: "pending" });
  f.advance(2001); expect(await f.restart()).toMatchObject({ state: "pending" });
  f.advance(4001); expect(await f.restart()).toMatchObject({ state: "unavailable" });
  expect(f.fake.calls).toHaveLength(3);
  const retryAt = readClaudeCloudReadiness(f.input.project)[0]!.retryAt;
  const account = { id: "default", label: "Fixture", home: f.input.account.home, projectsDir: f.input.account.home, kind: "managed" as const, authPresent: true, createdAt: 0 };
  const ports = {
    accounts: () => [account], allowed: () => true, remote: () => "https://github.com/sample/project",
    resolve: () => ({ kind: "available" as const, account: f.input.account }),
    prepare: async (input: Parameters<typeof prepareClaudeCloudTask>[0]) => {
      const result = await prepareClaudeCloudTask({ ...input, now: f.input.now }, f.provider);
      if (result.state === "pending") f.advance(result.retryAt - f.input.now());
      return result;
    },
  };
  for (let admission = 0; admission < 2; admission++) {
    queueClaudeCloudTasks(f.input.project, undefined, () => {}, ports);
    await settleClaudeCloudTaskDemands();
    expect(f.fake.calls).toHaveLength(3);
    expect(readClaudeCloudReadiness(f.input.project)[0]?.retryAt).toBe(retryAt);
  }
  // A new process also obeys the saved cooldown, even after the ten-minute window.
  f.advance(600_001);
  expect(await f.restart()).toMatchObject({ state: "unavailable" });
  expect(f.fake.calls).toHaveLength(3);
  queueClaudeCloudTasks(f.input.project, "default", () => {}, ports, undefined, { force: true });
  await settleClaudeCloudTaskDemands();
  expect(f.fake.calls).toHaveLength(6);
  expect(readClaudeCloudReadiness(f.input.project)[0]?.retryAt).toBeGreaterThan(retryAt);
  expect(f.fake.runCalls()).toBe(0);
});
