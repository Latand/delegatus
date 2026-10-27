import { AgentRegistry, setAgentRegistryForTests, fs, os, path, realProvisioningRepo, harness, savePipelines, saveTasks, boardTask, loadPipelines } from "@/lib/pipelines/engine.fixture";
import { afterEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { OPERATOR_COOKIE, soloBrowserSession } from "@/lib/agent/operatorSession";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { projectForCwd } from "@/lib/scanner/describe";
import * as engine from "@/lib/pipelines/engine";
import * as store from "@/lib/pipelines/store";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import { GET, POST } from "./route";
import { teamStore, resetTeamStoreForTests } from "@/lib/team/store";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { createWorkspace, placeProject } from "@/lib/team/workspaces";
import type { Member } from "@/lib/team/contract";
import { teamGate } from "@/lib/team/gate";
import { workspaceScope } from "@/lib/team/workspaceAccess";
import { conversationCatalogSnapshot, replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";

const owned: string[] = [];
afterEach(() => { setAgentRegistryForTests(null); savePipelines([]); saveTasks([]); for (const file of owned.splice(0)) fs.rmSync(file, { recursive: true, force: true }); });

const cookie = () => `${OPERATOR_COOKIE}=${soloBrowserSession()}`;
const request = (method: string, input: unknown, headers: Record<string, string> = { cookie: cookie() }) => new NextRequest(
  `http://localhost/api/pipelines/from-conversation${method === "GET" ? "?" + new URLSearchParams(input as Record<string, string>) : ""}`,
  { method, headers: { host: "localhost", "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}) },
);

async function source() {
  const native = await realProvisioningRepo("draft-route"); owned.push(native.root);
  fs.writeFileSync(path.join(native.repo, "tracked.txt"), "fixture\n");
  await native.git(native.repo, "add", ".");
  await native.git(native.repo, "commit", "-m", "Route fixture");
  const transcriptDir = path.join(process.env.LLV_CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, "route-source.jsonl"); owned.push(transcript);
  fs.writeFileSync(transcript, [JSON.stringify({ type: "session_meta", payload: { cwd: native.repo } }), JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fix exporter retries" } })].join("\n") + "\n");
  const registry = new AgentRegistry(path.join(native.root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const capability = "q".repeat(43);
  const reviewed = registry.ensureConversation("codex", path.join(native.root, "reviewed.jsonl"), null).id;
  const begun = registry.beginSpawnRequest({ spawnCapabilityDigest: createHash("sha256").update(capability).digest("hex"), reviewsConversationId: reviewed, parentConversationId: reviewed, engine: "codex", cwd: native.repo, role: "reviewer", origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: native.repo, title: "Review exporter" }) });
  if (begun.kind !== "created") throw new Error("source reservation failed");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: "route-source" }, artifactPath: transcript, cwd: native.repo,
    accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("source settlement failed");
  setAgentRegistryForTests(registry);
  const project = projectForCwd(native.repo)!;
  const task = { ...boardTask("route-task", project), assignments: [{ conversationId: settled.conversation.id, path: transcript,
    panePid: null, state: "linked" as const, error: null, at: "2026-10-27T00:00:00.000Z" }] };
  saveTasks([task]);
  const h = harness();
  h.ports.projectForCwd = projectForCwd;
  const defaults = spyOn(engine, "defaultPipelinePorts").mockReturnValue(h.ports);
  const input = { conversationId: settled.conversation.id, taskId: task.id };
  return { ...native, ...h, input, defaults, registry, transcript, capability };
}

test("the real endpoint previews, persists an unstarted draft, and replays a lost response without launch", async () => {
  const f = await source();
  try {
    const preview = await GET(request("GET", f.input));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    const body = await preview.json();
    expect(body.source.canCreate).toBe(true);
    expect(JSON.stringify(body)).not.toContain("Fix exporter retries");
    const input = { ...f.input, sourceRevision: body.source.sourceRevision, clientRequestId: "route-create" };
    const created = await POST(request("POST", input));
    expect(created.status).toBe(201);
    const pipeline = (await created.json()).pipeline;
    expect(pipeline).toMatchObject({ state: "draft", srcConversationId: null, taskIds: [f.input.taskId], conversationSource: { conversationId: f.input.conversationId } });
    expect((await POST(request("POST", input))).status).toBe(200);
    expect(loadPipelines()).toHaveLength(1);
    expect(f.spawnInputs).toHaveLength(0);
    expect(fs.existsSync(pipeline.worktreeDir)).toBe(false);
  } finally { f.defaults.mockRestore(); }
});

test("anonymous, foreign-origin, agent and service credentials refuse preview and creation before content reads", async () => {
  const f = await source();
  const capability = f.capability;
  const headers: Record<string, string>[] = [{}, { cookie: cookie(), origin: "https://foreign.invalid" },
    { cookie: cookie(), [VIEWER_SPAWN_CAPABILITY_HEADER]: capability }, { cookie: cookie(), ...internalServiceHeaders("mcp") }];
  const content = spyOn(fs, "openSync");
  try {
    for (const candidate of headers) for (const method of ["GET", "POST"]) {
      const response = await (method === "GET" ? GET : POST)(request(method, { ...f.input, ...(method === "POST" ? { sourceRevision: "a".repeat(64), clientRequestId: "refused" } : {}) }, candidate));
      expect(response.status).toBe(403);
    }
    expect(content.mock.calls.some(([pathname]) => pathname === f.transcript)).toBe(false);
    expect(loadPipelines()).toEqual([]);
  } finally { content.mockRestore(); f.defaults.mockRestore(); }
});

test("strict body bounds and errors expose stable refusal codes with no retained draft", async () => {
  const f = await source();
  try {
    const preview = await (await GET(request("GET", f.input))).json();
    const input = { ...f.input, sourceRevision: preview.source.sourceRevision, clientRequestId: "route-refusal" };
    for (const extra of [{ autoStart: true }, { repoDir: f.repo }, { path: f.transcript }, { stages: [] }]) expect((await POST(request("POST", { ...input, ...extra }))).status).toBe(400);
    expect((await POST(request("POST", { ...input, clientRequestId: "x".repeat(129) }))).status).toBe(400);
    expect((await POST(request("POST", { ...input, padding: "x".repeat(5000) }))).status).toBe(413);
    fs.appendFileSync(path.join(f.repo, "tracked.txt"), "pending\n");
    const dirty = await POST(request("POST", input));
    expect(dirty.status).toBe(409);
    expect(await dirty.json()).toMatchObject({ code: "SOURCE_HAS_CHANGES" });
    const dirtyPreview = await (await GET(request("GET", f.input))).json();
    expect(dirtyPreview.source).toMatchObject({ canCreate: false, refusal: { code: "SOURCE_HAS_CHANGES" } });
    expect(loadPipelines()).toEqual([]);
  } finally { f.defaults.mockRestore(); }
});

test("pre-admission contention returns retryable 503 and the identical retry succeeds", async () => {
  const f = await source();
  try {
    const preview = await (await GET(request("GET", f.input))).json();
    const input = { ...f.input, sourceRevision: preview.source.sourceRevision, clientRequestId: "route-busy" };
    const busy = spyOn(store, "createPipelineWithDelivery").mockRejectedValueOnce(new StoreBusyBeforeAdmissionError("fixture lock busy"));
    try {
      const refused = await POST(request("POST", input));
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: "store_busy", retryable: true });
      expect(loadPipelines()).toEqual([]);
    } finally { busy.mockRestore(); }
    expect((await POST(request("POST", input))).status).toBe(201);
  } finally { f.defaults.mockRestore(); }
});

test("a signed-in workspace member can preview/create; an unassigned member cannot read the source", async () => {
  const f = await source();
  const previousState = process.env.LLV_STATE_DIR;
  const teamRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draft-route-team-")); owned.push(teamRoot);
  process.env.LLV_STATE_DIR = teamRoot;
  resetTeamStoreForTests();
  const priorCatalog = conversationCatalogSnapshot();
  const team = teamStore();
  const now = new Date().toISOString();
  const person = (id: string, role: Member["role"] = "member"): Member => {
    const member: Member = { id, name: "Fixture member", role, status: "active", color: "teal", telegram: null, createdAt: now, createdBy: "claim", revokedAt: null };
    team.insertMember(member);
    return member;
  };
  try {
    const owner = person("m_owner", "owner"), member = person("m_member"), outsider = person("m_outsider");
    const project = projectForCwd(f.repo)!;
    const workspace = "w_" + "a".repeat(32);
    createWorkspace(team, owner, { id: workspace, name: "Fixture workspace", projects: [project] });
    team.putWorkspaceMember(workspace, member.id, "member", owner.id, now);
    const session = (actor: Member) => ({ cookie: `${MEMBER_COOKIE}=${mintSession(team, actor.id, "claim", { surface: "desktop", browser: "chrome" }).value}` });
    const memberHeaders = session(member), outsiderHeaders = session(outsider);
    expect(teamGate(request("GET", f.input, memberHeaders), { bearerAuthenticated: false })).toBeNull();
    const rejected = await GET(request("GET", f.input, outsiderHeaders));
    expect(rejected.status).toBe(403);
    const preview = await GET(request("GET", f.input, memberHeaders));
    expect(preview.status).toBe(200);
    const input = { ...f.input, sourceRevision: (await preview.json()).source.sourceRevision, clientRequestId: "member-create" };
    expect(teamGate(request("POST", input, memberHeaders), { bearerAuthenticated: false })).toBeNull();
    expect((await POST(request("POST", input, memberHeaders))).status).toBe(201);
    team.removeWorkspaceMember(workspace, member.id);
    expect((await GET(request("GET", f.input, memberHeaders))).status).toBe(403);
    expect((await POST(request("POST", input, memberHeaders))).status).toBe(403);
    // Managers may read known unassigned projects; this preview still needs action permission.
    const manager = person("m_manager"), other = "w_" + "b".repeat(32);
    createWorkspace(team, owner, { id: other, name: "Other workspace" });
    team.putWorkspaceMember(other, manager.id, "manager", owner.id, now);
    placeProject(team, owner, project, null);
    replaceConversationCatalog([...priorCatalog, { path: f.transcript, root: "codex-sessions", name: "route-source", project,
      title: "Source conversation", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 0, size: fs.statSync(f.transcript).size }]);
    expect(workspaceScope(team, manager.id).access(project)).toBe("manager");
    expect(workspaceScope(team, manager.id).canAct(project)).toBe(false);
    const content = spyOn(fs, "openSync");
    try {
      expect((await GET(request("GET", f.input, session(manager)))).status).toBe(403);
      expect(content.mock.calls.some(([pathname]) => pathname === f.transcript)).toBe(false);
    } finally { content.mockRestore(); }
  } finally {
    replaceConversationCatalog([...priorCatalog]);
    resetTeamStoreForTests();
    process.env.LLV_STATE_DIR = previousState;
    f.defaults.mockRestore();
  }
});
