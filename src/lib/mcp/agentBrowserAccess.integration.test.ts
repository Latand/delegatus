import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { Database } from "bun:sqlite";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { isolatedEnvironment } from "../../../scripts/local-gate";

const original = { ...process.env };
const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "agent-browser-access-"));
Object.assign(process.env, isolatedEnvironment(root, checkEnvironment(process.env)));
const { POST } = await import("@/app/api/mcp/route");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { agentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
const { spawnCapabilityDigest } = await import("@/lib/agent/callerClaims");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { createMcpToolService, SqliteMcpReceiptStore } = await import("./server");
const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { McpTaskExecutor, taskExecutorLaunch } = await import("./taskExecutor");
const { statePath } = await import("@/lib/configDir");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { claimInstall, createInvite, redeemJoin, revokeMember } = await import("@/lib/team/members");
const { createWorkspace, placeProject } = await import("@/lib/team/workspaces");
const { workspaceScope } = await import("@/lib/team/workspaceAccess");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const { persistProjectAliases } = await import("@/lib/projects/aliases");

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const PROJECT = "browser-access-project";
const WORKSPACE = `w_${"1".repeat(32)}`;
const OTHER_WORKSPACE = `w_${"2".repeat(32)}`;
const SEAT = "conversation_browser_seat";
const WORKER = "conversation_browser_worker";
const DEVICE = { surface: "desktop" as const, browser: "chrome" as const };
let cleanups: Array<() => void | Promise<void>> = [];
let sequence = 0;

beforeEach(() => { sequence = 0; });
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
  setMcpHttpDependenciesForTests(null);
  resetTeamStoreForTests();
  closeAgentRegistryForTests();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(inExecutor = false) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  Object.assign(process.env, isolatedEnvironment(directory, checkEnvironment(original)));
  // The login lives in the server's home, alongside the sandboxed team store.
  const savedLogin = path.join(process.env.HOME!, ".local/share/delegatus-agent-login/state.json");
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  cleanups.push(() => clock.mockRestore());
  const store = teamStore();
  const owner = claimInstall(store, "Owner", DEVICE, NOW);
  const invite = createInvite(store, owner.member, "Browser", NOW);
  const browser = redeemJoin(store, invite.code, "Browser", DEVICE, NOW);
  const otherInvite = createInvite(store, owner.member, "Other member", NOW);
  const other = redeemJoin(store, otherInvite.code, "Other member", DEVICE, NOW);
  fs.mkdirSync(path.dirname(savedLogin), { recursive: true });
  const saveLogin = (cookie = browser.cookie) => fs.writeFileSync(savedLogin, JSON.stringify({
    cookies: [{ name: "llv_member", value: cookie, domain: "127.0.0.1", path: "/", httpOnly: true }], origins: [],
  }), { mode: 0o600 });
  saveLogin();
  createWorkspace(store, owner.member, { id: WORKSPACE, name: "Seat workspace", projects: [PROJECT] });
  createWorkspace(store, owner.member, { id: OTHER_WORKSPACE, name: "Other workspace", projects: ["other-project"] });
  const registry = agentRegistry();
  function launch(conversationId: `conversation_${string}`) {
    const started = registry.beginSpawnRequest({
      engine: "codex", cwd: directory, transport: "structured", conversationId, role: "builder",
      clientAttemptId: conversationId,
      launchProfile: emptyLaunchProfile({ cwd: directory, project: PROJECT, title: "Browser access fixture", role: "worker" }),
    });
    if (started.kind !== "created") throw new Error("fixture spawn not created");
    registry.settleSpawn(started.receipt.launchId, {
      key: { engine: "codex", sessionId: conversationId }, artifactPath: path.join(directory, `${conversationId}.jsonl`),
      cwd: directory, accountId: "default", status: "unhosted", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    return registry.rotateSpawnCapabilityForReceipt(started.receipt.launchId);
  }
  const seatCapability = launch(SEAT);
  const workerCapability = launch(WORKER);
  beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Own the fixture project", clientRequestId: "browser-seat", mode: "existing", conversationId: SEAT });
  completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "browser-seat", conversationId: SEAT, path: null });
  let receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  const executor = inExecutor ? (() => {
    const launch = taskExecutorLaunch();
    const worker = path.join(directory, "clocked-worker.ts");
    fs.writeFileSync(worker, `Date.now = () => ${NOW}; await import(${JSON.stringify(launch.workerPath)});`);
    return new McpTaskExecutor({ launch: { ...launch, workerPath: worker } });
  })() : null;
  if (executor) {
    cleanups.push(() => executor.close());
    // The production worker opens the receipt database prepared by its Viewer.
    new SqliteMcpReceiptStore(statePath("mcp-receipts.sqlite")).close();
  }
  const build = () => createMcpToolService(viewerMcpBindings(), receipts, viewerMcpToolPolicy());
  let service = build();
  setMcpHttpDependenciesForTests({
    service: async () => executor ? { callTool: (name, args, context) => executor.callTool(name, args, context) } : service,
    conversationForCapability: capability => registry.conversationIdForSpawnCapabilityDigest(spawnCapabilityDigest(capability)),
  });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => POST(new NextRequest(req)) });
  cleanups.push(() => { listener.stop(true); receipts.close(); });
  const clients: Client[] = [];
  async function client(capability: string) {
    const result = new Client({ name: "browser-access-fixture", version: "1" });
    clients.push(result);
    await result.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
      requestInit: { headers: { "x-llv-spawn-capability": capability } },
    }));
    return result;
  }
  cleanups.push(async () => { for (const client of clients) await client.close(); });
  const seatClient = await client(seatCapability);
  const workerClient = await client(workerCapability);
  const call = async (input: Record<string, unknown> = {}, caller = seatClient) =>
    (await caller.callTool({ name: "grant_agent_browser_access", arguments: { clientRequestId: `browser-access-${++sequence}`, ...input } })).structuredContent as Record<string, unknown>;
  const events = () => store.events({ limit: 200 }).filter(event => event.detail?.source === "agent-browser-access");
  const assertUnchanged = () => {
    expect(store.workspaceMemberships(browser.member.id)).toEqual([]);
    expect(store.workspaceMemberships(other.member.id)).toEqual([]);
    expect(events()).toEqual([]);
  };
  return { store, owner, browser, other, call, seatClient, workerClient, saveLogin, savedLogin, events, assertUnchanged,
    rotateToWorker: () => {
      beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Own the fixture project", clientRequestId: "browser-successor", mode: "existing", conversationId: WORKER });
      completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "browser-successor", conversationId: WORKER, path: null });
    },
    restartService: () => { receipts.close(); receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite")); service = build(); } };
}

test("the owned executor grants access while a team-store lock leaves the MCP listener responsive", async () => {
  const f = await fixture(true);
  const lock = new Database(statePath("team", "team.sqlite"));
  let pending: Promise<Record<string, unknown>> | undefined;
  let settled = false;
  cleanups.push(async () => { await pending?.catch(() => undefined); });
  try {
    lock.exec("BEGIN IMMEDIATE");
    pending = f.call().finally(() => { settled = true; });
    // Discovery needs no team store. It must still answer while the grant is
    // waiting, without releasing the lock or occupying the Viewer's loop.
    const listed = await f.seatClient.listTools();
    expect(listed.tools.some(tool => tool.name === "grant_agent_browser_access")).toBe(true);
    expect(settled).toBe(false);
    expect(f.events()).toEqual([]);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  expect(await pending).toMatchObject({ ok: true, changed: true, role: "member", memberId: f.browser.member.id });
  expect(f.events()).toHaveLength(1);
  expect(await f.call({}, f.workerClient)).toMatchObject({ ok: false, code: "agent_browser_seat_required" });
});

test("the seat places its saved browser member and records an atomic, durable, idempotent grant", async () => {
  const f = await fixture();
  expect(await f.call({ clientRequestId: "first-grant" })).toMatchObject({ ok: true, memberId: f.browser.member.id, project: PROJECT, workspaceId: WORKSPACE, role: "member", changed: true });
  expect(workspaceScope(f.store, f.browser.member.id).role(WORKSPACE)).toBe("member");
  expect(f.store.workspaceMemberships(f.other.member.id)).toEqual([]);
  expect(f.events()).toHaveLength(1);
  const [event] = f.events();
  expect(event).toMatchObject({ at: new Date(NOW).toISOString(), actor: { kind: "agent", conversationId: SEAT }, action: "member.joined", project: PROJECT,
    subject: { kind: "member", id: f.browser.member.id }, detail: { workspaceId: WORKSPACE, role: "member", authority: "operator" } });
  f.restartService();
  expect(await f.call({ clientRequestId: "first-grant" })).toMatchObject({ ok: true, replayed: true });
  expect(await f.call({ workspaceId: WORKSPACE })).toMatchObject({ ok: true, changed: false });
  expect(f.events()).toEqual([event!]);
  // Reopen in a fresh interpreter: both production readers must accept the
  // writer's persisted records without any process-local state.
  const child = Bun.spawn([process.execPath, "--eval", `const {existingTeamStore}=await import('./src/lib/team/store.ts');const s=existingTeamStore();console.log(JSON.stringify({memberships:s.workspaceMemberships(${JSON.stringify(f.browser.member.id)}),events:s.events({limit:200}).filter(e=>e.detail?.source==='agent-browser-access')}));`], {
    cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ memberships: [{ workspaceId: WORKSPACE, role: "member" }], events: [event!] });
  // Existing manager controls can reverse it; a new request can then restore it.
  f.store.removeWorkspaceMember(WORKSPACE, f.browser.member.id);
  expect(await f.call()).toMatchObject({ ok: true, changed: true });
  expect(f.events()).toHaveLength(2);
});

for (const [name, input, code] of [
  ["another workspace", { workspaceId: OTHER_WORKSPACE }, "agent_browser_workspace_refused"],
  ["manager role", { role: "manager" }, "agent_browser_role_refused"],
  ["owner role", { role: "owner" }, "agent_browser_role_refused"],
] as const) {
  test(`refuses ${name} before any membership or audit write`, async () => {
    const f = await fixture();
    expect(await f.call(input)).toMatchObject({ ok: false, code });
    f.assertUnchanged();
    expect(await f.call()).toMatchObject({ ok: true, changed: true });
  });
}

test("refuses another member id even in the seat's own workspace", async () => {
  const f = await fixture();
  expect(await f.call({ memberId: f.other.member.id })).toMatchObject({ ok: false, code: "agent_browser_member_refused" });
  f.assertUnchanged();
  expect(await f.call()).toMatchObject({ ok: true, memberId: f.browser.member.id });
});

test("refuses an authenticated non-seat caller, including replay of a seat receipt", async () => {
  const f = await fixture();
  expect(await f.call({ conversationId: SEAT, project: PROJECT }, f.workerClient)).toMatchObject({ ok: false, code: "agent_browser_seat_required" });
  f.assertUnchanged();
  expect(await f.call({ clientRequestId: "seat-receipt" })).toMatchObject({ ok: true });
  expect(await f.call({ clientRequestId: "seat-receipt" }, f.workerClient)).toMatchObject({ ok: false, code: "agent_browser_seat_required" });
  expect(f.events()).toHaveLength(1);
});

test("rotation revokes the old seat's grant and receipt access immediately", async () => {
  const f = await fixture();
  expect(await f.call({ clientRequestId: "before-rotation" })).toMatchObject({ ok: true });
  f.rotateToWorker();
  expect(await f.call({ clientRequestId: "before-rotation" })).toMatchObject({ ok: false, code: "agent_browser_seat_required" });
  expect(await f.call()).toMatchObject({ ok: false, code: "agent_browser_seat_required" });
  expect(await f.call({}, f.workerClient)).toMatchObject({ ok: true, changed: false });
  expect(f.events()).toHaveLength(1);
});

test("session revocation during the asynchronous login read is checked before writing", async () => {
  const f = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  const reading = spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (args[0] === f.savedLogin) f.store.revokeSession(f.browser.session.id, new Date(NOW).toISOString());
    return handle;
  });
  try { expect(await f.call()).toMatchObject({ ok: false, code: "agent_browser_login_unavailable" }); }
  finally { reading.mockRestore(); }
  f.assertUnchanged();
});

test("seat rotation during the asynchronous login read refuses the former seat", async () => {
  const f = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  let rotated = false;
  const reading = spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (args[0] === f.savedLogin && !rotated) { rotated = true; f.rotateToWorker(); }
    return handle;
  });
  try { expect(await f.call()).toMatchObject({ ok: false, code: "agent_browser_seat_required" }); }
  finally { reading.mockRestore(); }
  expect(rotated).toBe(true);
  f.assertUnchanged();
  expect(await f.call({}, f.workerClient)).toMatchObject({ ok: true });
});

test("workspace movement during the asynchronous login read refuses the old target", async () => {
  const f = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  const reading = spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (args[0] === f.savedLogin) placeProject(f.store, f.owner.member, PROJECT, OTHER_WORKSPACE);
    return handle;
  });
  try { expect(await f.call({ workspaceId: WORKSPACE })).toMatchObject({ ok: false, code: "agent_browser_workspace_refused" }); }
  finally { reading.mockRestore(); }
  f.assertUnchanged();
  expect(await f.call()).toMatchObject({ ok: true, workspaceId: OTHER_WORKSPACE });
});

test("session revocation refuses a stored grant receipt after service restart", async () => {
  const f = await fixture();
  expect(await f.call({ clientRequestId: "before-revocation" })).toMatchObject({ ok: true });
  f.store.revokeSession(f.browser.session.id, new Date(NOW).toISOString());
  f.restartService();
  expect(await f.call({ clientRequestId: "before-revocation" })).toMatchObject({ ok: false, code: "agent_browser_login_unavailable" });
  expect(f.events()).toHaveLength(1);
});

test("an unassigned project cannot grant access to a named workspace", async () => {
  const f = await fixture();
  placeProject(f.store, f.owner.member, PROJECT, null);
  expect(await f.call({ workspaceId: WORKSPACE })).toMatchObject({ ok: false, code: "agent_browser_workspace_refused" });
  expect(await f.call()).toMatchObject({ ok: false, code: "agent_browser_workspace_refused" });
  f.assertUnchanged();
});

for (const state of ["missing", "malformed", "expired", "revoked-session", "revoked-member", "owner"] as const) {
  test(`refuses a ${state} browser login without substituting another member`, async () => {
    const f = await fixture();
    if (state === "missing") fs.unlinkSync(f.savedLogin);
    if (state === "malformed") fs.writeFileSync(f.savedLogin, "invalid json");
    if (state === "expired") f.store.touchSession(f.browser.session.id, "2020-01-01T00:00:00.000Z");
    if (state === "revoked-session") f.store.revokeSession(f.browser.session.id, new Date(NOW).toISOString());
    if (state === "revoked-member") revokeMember(f.store, f.owner.member, f.browser.member, NOW);
    if (state === "owner") f.saveLogin(f.owner.cookie);
    expect(await f.call()).toMatchObject({ ok: false, code: "agent_browser_login_unavailable" });
    f.assertUnchanged();
  });
}

test("audit failure rolls back the membership write", async () => {
  const f = await fixture();
  const fail = spyOn(f.store, "insertEvent").mockImplementation(() => { throw new Error("fixture audit refused"); });
  try { expect(await f.call()).toMatchObject({ ok: false }); }
  finally { fail.mockRestore(); }
  f.assertUnchanged();
  expect(await f.call()).toMatchObject({ ok: true, changed: true });
});

test("project aliases resolve, and a moved workspace is checked again before replay", async () => {
  const f = await fixture();
  expect(persistProjectAliases([{ source: "browser-access-old", target: PROJECT, displayName: "Browser project" }])).toBe(true);
  placeProject(f.store, f.owner.member, "browser-access-old", WORKSPACE);
  expect(await f.call({ workspaceId: WORKSPACE, clientRequestId: "before-move" })).toMatchObject({ ok: true });
  placeProject(f.store, f.owner.member, PROJECT, OTHER_WORKSPACE);
  expect(await f.call({ workspaceId: WORKSPACE, clientRequestId: "before-move" })).toMatchObject({ ok: false, code: "agent_browser_workspace_refused" });
  expect(await f.call()).toMatchObject({ ok: true, workspaceId: OTHER_WORKSPACE });
});
