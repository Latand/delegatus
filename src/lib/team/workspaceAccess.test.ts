import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";

import { type Member } from "./contract";
import { createInvite, redeemJoin, TeamError } from "./members";
import { MEMBER_COOKIE, mintSession } from "./sessions";
import { resetTeamStoreForTests, teamStore, type TeamStore } from "./store";
import { workspaceScope } from "./workspaceAccess";
import { projectForCwd } from "@/lib/scanner/describe";
import { beginDeputy, readDeputies } from "@/lib/orchestrator/deputies";
import { GET as artifactGET } from "@/app/api/artifact/route";
import { GET as imageGET } from "@/app/api/image/route";
import { GET as ghostGET, POST as ghostPOST } from "@/app/api/orchestrator/ghost/route";
import { workspaceRoute } from "./workspaceRoute";
import { teamGate } from "./gate";
import { createWorkspace, placeProject } from "./workspaces";
import { GET as tasksGET, POST as tasksPOST } from "@/app/api/tasks/route";
import { PATCH as taskPATCH, DELETE as taskDELETE } from "@/app/api/tasks/[id]/route";
import { loadTasksForList, saveTasks } from "@/lib/tasks/store";
import { agentRegistry, AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { runtimeScope, type RuntimeEvent, type RuntimeSnapshot } from "@/lib/runtime/contracts";
import { workspaceRuntime, workspaceRuntimeEvent, workspaceFiles } from "./workspaceProjection";
import { conversationCatalogSnapshot, replaceConversationCatalog, catalogEntryToFileEntry } from "@/lib/scanner/conversationCatalog";
import type { FilesResponse } from "@/lib/types";
import { WORKSPACE_ROUTES } from "./workspaceRoutes";
import { GET as inviteGET, POST as invitePOST } from "@/app/api/team/invites/route";
import { DELETE as inviteDELETE } from "@/app/api/team/invites/[id]/route";
import { POST as joinPOST } from "@/app/api/team/join/[code]/route";
import { DELETE as memberDELETE, PUT as memberPUT } from "@/app/api/team/workspaces/[id]/members/route";
import { PUT as placementPUT } from "@/app/api/team/workspace-projects/route";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { GET as pipelinesGET } from "@/app/api/pipelines/route";
import { PATCH as pipelinePATCH } from "@/app/api/pipelines/[id]/route";
import { setConversationHostDependenciesForTests } from "@/app/api/conversation-host/dependencies";
import { allowedKillTarget, lastResourceTargetRefs, noteSessionTargets } from "@/lib/resources";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/projects/settings/route";
import { setBridgeReports, setMergeOnReview, setReportTelegram } from "@/lib/projects/settings";
import { registerPipelineTick } from "@/lib/pipelines/controllerSignal";

const W1 = `w_${"a".repeat(32)}`;
const W2 = `w_${"b".repeat(32)}`;
const fixtureSessionId = (suffix: number) => ["00000000", "0000", "4000", "8000", String(suffix).padStart(12, "0")].join("-");
const device = { surface: "desktop" as const, browser: "chrome" as const };
let store: TeamStore;
let root: string;
let priorCatalog: ReturnType<typeof conversationCatalogSnapshot>;
let now: number;
let owner: Member;
let manager: Member;
let member: Member;
let outsider: Member;
const previous = process.env.LLV_STATE_DIR;
const cookies = new Map<string, string>();

function person(id: string, role: Member["role"] = "member"): Member {
  const row: Member = { id, name: id, role, status: "active", color: "teal", telegram: null, createdAt: new Date(now).toISOString(), createdBy: "claim", revokedAt: null };
  store.insertMember(row);
  cookies.set(id, mintSession(store, id, "claim", device, now).value);
  return row;
}

function request(url: string, actor: Member, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method, headers: { host: "localhost", cookie: `${MEMBER_COOKIE}=${cookies.get(actor.id)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-access-"));
  process.env.LLV_STATE_DIR = root;
  resetTeamStoreForTests();
  priorCatalog = conversationCatalogSnapshot();
  replaceConversationCatalog([{ path: "catalog-new.jsonl", root: "codex-sessions", name: "new", project: "repo-new", title: "new", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 0, size: 0 }]);
  cookies.clear();
  now = Date.now();
  store = teamStore();
  setAgentRegistryForTests(new AgentRegistry(path.join(root, "registry.json")));
  owner = person("m_owner", "owner");
  manager = person("m_manager");
  member = person("m_member");
  outsider = person("m_unplaced");
  createWorkspace(store, owner, { id: W1, name: "Alpha", projects: ["repo-alpha"] });
  createWorkspace(store, owner, { id: W2, name: "Beta", projects: ["repo-beta"] });
  store.putWorkspaceMember(W1, manager.id, "manager", owner.id, new Date(now).toISOString());
  store.putWorkspaceMember(W1, member.id, "member", owner.id, new Date(now).toISOString());
  saveTasks(["alpha", "beta"].map(name => ({ id: `task-${name}`, project: `repo-${name}`, text: name, status: "inbox", placement: "unplaced", assignments: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() })));
});

afterEach(() => {
  replaceConversationCatalog([...priorCatalog]);
  setAgentRegistryForTests(null);
  resetTeamStoreForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace authority", () => {
  test("resource pane targets stay owner-only beside an authorized conversation on both mounts", async () => {
    const registry = agentRegistry();
    const receipt = registry.beginSpawn("codex", root, { project: "repo-alpha", title: "Own conversation" });
    const artifactPath = path.join(root, "own.jsonl");
    registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: fixtureSessionId(3) }, artifactPath, cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
    const target = "beta-agent:1.0";
    const ref = { paneId: "%42", panePid: 4242, tmuxServerPid: 4200, tmuxServerStartIdentity: null, paneStartIdentity: null };
    const endpoint = { kind: "tmux-tmpdir" as const, tmuxTmpdir: root, socketName: "default" as const, socketPath: path.join(root, "tmux.sock") };
    const identities: Record<string, string>[] = [{ path: artifactPath }, { conversationId: receipt.conversationId }];
    const previousTargets = lastResourceTargetRefs();
    const killed: string[] = [];
    let attaches = 0;
    setConversationHostDependenciesForTests({
      panePidOf: async () => ref.panePid,
      killPane: async pane => { killed.push(pane); },
      tmuxEndpointDescriptor: () => endpoint,
      resolveTmuxAttach: async (reference, requestedEndpoint = endpoint) => {
        expect(reference).toEqual(ref);
        attaches++;
        return { ok: true, target, endpoint: requestedEndpoint, command: "fixture attach", readOnlyCommand: "fixture read only" };
      },
    });
    try {
      for (const route of ["conversation-host", "tmux"]) {
        const { GET, POST } = await import(`../../app/api/${route}/route.ts`);
        noteSessionTargets([{ target, ref }]);
        for (const actor of [member, manager, outsider]) {
          for (const identity of identities) {
            const calls = [
              () => POST(request(`/api/${route}`, actor, "POST", { action: "kill-target", target, ...identity })),
              () => GET(request(`/api/${route}?attach=1&target=${encodeURIComponent(target)}&${new URLSearchParams(identity)}`, actor)),
              () => POST(request(`/api/${route}?target=${encodeURIComponent(target)}`, actor, "POST", { action: "interrupt", ...identity })),
              () => POST(request(`/api/${route}`, actor, "POST", { action: "kill-target", ...identity })),
            ];
            for (const call of calls) {
              const denied = await call();
              expect(denied.status).toBe(403);
              expect(await denied.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
              expect(allowedKillTarget(target)).toEqual(ref);
              expect(killed).toEqual([]);
              expect(attaches).toBe(0);
            }
          }
        }
        const attached = await GET(request(`/api/${route}?attach=1&target=${encodeURIComponent(target)}&conversationId=${receipt.conversationId}`, owner));
        expect(attached.status).toBe(200);
        expect((await attached.json()).attach.target).toBe(target);
        expect(attaches).toBe(1);
        expect(allowedKillTarget(target)).toEqual(ref);
        const killedResponse = await POST(request(`/api/${route}`, owner, "POST", { action: "kill-target", target, path: artifactPath }));
        expect(killedResponse.status).toBe(200);
        expect(killed).toEqual([ref.paneId]);
        expect(allowedKillTarget(target)).toBeNull();
        killed.length = 0;
        attaches = 0;
      }
    } finally {
      setConversationHostDependenciesForTests(null);
      noteSessionTargets(previousTargets);
    }
  });

  test("project settings reads allow members; writes require that workspace's manager or owner", async () => {
    const restoreTick = registerPipelineTick(async () => {});
    const settings = async (actor: Member, project = "repo-alpha") => {
      const response = await settingsGET(request(`/api/projects/settings?project=${project}`, actor));
      expect(response.status).toBe(200);
      return response.json();
    };
    const seed = () => {
      const stamp = new Date(now).toISOString();
      setMergeOnReview("repo-alpha", false, "fixture", stamp);
      setBridgeReports("repo-alpha", true, "fixture", stamp);
      setReportTelegram("repo-alpha", { chat: "fixture-reports", name: "Alpha" }, "fixture", stamp);
    };
    try {
      seed();
      const before = await settings(owner);
      expect(await settings(member)).toEqual(before);
      for (const actor of [member, outsider]) {
        for (const change of [{ mergeOnReview: true }, { bridgeReports: false }, { reportTelegram: null }, { mergeOnReview: true, bridgeReports: false, reportTelegram: null }]) {
          const denied = await settingsPUT(request("/api/projects/settings", actor, "PUT", { project: "repo-alpha", ...change }));
          expect(denied.status).toBe(403);
          expect(await denied.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
          expect(await settings(owner)).toEqual(before);
        }
      }
      for (const actor of [manager, owner]) {
        seed();
        const response = await settingsPUT(request("/api/projects/settings", actor, "PUT", { project: "repo-alpha", mergeOnReview: true, bridgeReports: false, reportTelegram: null }));
        expect(response.status).toBe(200);
        expect(await settings(member)).toMatchObject({ mergeOnReview: { enabled: true }, bridgeReports: { enabled: false }, reportTelegram: { chat: null } });
      }
      for (const project of ["repo-beta", "repo-new"]) {
        const before = await settings(owner, project);
        const denied = await settingsPUT(request("/api/projects/settings", manager, "PUT", { project, mergeOnReview: true }));
        expect(denied.status).toBe(403);
        expect(await settings(owner, project)).toEqual(before);
      }
    } finally {
      restoreTick();
    }
  });

  test("a manager reads only catalog files and cannot place an undiscovered key", async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const privateDir = path.join(root, ".codex");
      const projectDir = path.join(root, "project");
      fs.mkdirSync(privateDir);
      fs.mkdirSync(projectDir);
      fs.writeFileSync(path.join(privateDir, "auth.json"), JSON.stringify({ fixture: true }));
      fs.writeFileSync(path.join(projectDir, "README.md"), "catalog project");
      fs.symlinkSync(path.join(privateDir, "auth.json"), path.join(projectDir, "linked.json"));
      const project = projectForCwd(projectDir)!;
      replaceConversationCatalog([{ ...conversationCatalogSnapshot()[0]!, project }]);
      const undiscovered = projectForCwd(privateDir);
      for (const actor of [manager, member, outsider]) {
        for (const [route, handler] of [["artifact", artifactGET], ["image", imageGET]] as const) {
          for (const file of ["~/.codex/auth.json", path.join(projectDir, "linked.json")]) {
            const response = await handler(request(`/api/${route}?path=${encodeURIComponent(file)}`, actor));
            if (response.status !== 403) await response.body?.cancel();
            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
          }
        }
      }
      const placement = await placementPUT(request("/api/team/workspace-projects", manager, "PUT", { project: undiscovered, workspaceId: W1 }));
      expect(placement.status).toBe(403);
      expect(store.workspaceProjectRows().some(row => row.project === undiscovered)).toBe(false);
      // Older arbitrary placements confer no file authority either.
      placeProject(store, owner, undiscovered, W1);
      for (const actor of [manager, member]) expect((await artifactGET(request("/api/artifact?path=~/.codex/auth.json", actor))).status).toBe(403);
      const file = `/api/artifact?path=${encodeURIComponent(path.join(projectDir, "README.md"))}`;
      const real = await artifactGET(request(file, manager));
      expect(real.status).toBe(200);
      expect(await real.text()).toBe("catalog project");
      expect((await artifactGET(request(file, member))).status).toBe(403);
      const privateRead = await artifactGET(request("/api/artifact?path=~/.codex/auth.json", owner));
      expect(privateRead.status).toBe(200);
      await privateRead.body?.cancel();
      expect((await placementPUT(request("/api/team/workspace-projects", manager, "PUT", { project, workspaceId: W1 }))).status).toBe(200);
      const placed = await artifactGET(request(file, member));
      expect(placed.status).toBe(200);
      await placed.body?.cancel();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("deputy reads, retries and request replays resolve stored projects before a forged hint", async () => {
    const askId = "deputy-foreign";
    beginDeputy({ project: "repo-beta", seatConversationId: "conversation_foreign", seatEpoch: 1, seatPath: null, askId, clientRequestId: "foreign-request", ask: { text: "foreign question", images: 0, sender: null }, now: new Date(now) });
    const before = readDeputies();
    for (const actor of [member, manager]) {
      for (const body of [
        { retryAskId: askId, clientRequestId: "retry" },
        { retryAskId: "missing", clientRequestId: "retry" },
        { clientRequestId: "foreign-request", text: "forged" },
        { seatConversationId: "conversation_foreign", clientRequestId: "new-request", text: "forged" },
      ]) {
        const denied = await ghostPOST(request("/api/orchestrator/ghost", actor, "POST", { project: "repo-alpha", ...body }));
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
      }
      const read = await ghostGET(request(`/api/orchestrator/ghost?project=repo-alpha&askId=${askId}`, actor));
      expect(read.status).toBe(403);
    }
    expect(readDeputies()).toEqual(before);
    let ran = false;
    const allowed = workspaceRoute("/api/orchestrator/ghost", (received: Request) => { ran = true; return Response.json({ ok: true, url: received.url }); });
    expect((await allowed(request(`/api/orchestrator/ghost?askId=${askId}`, owner))).status).toBe(200);
    beginDeputy({ project: "repo-alpha", seatConversationId: "conversation_own", seatEpoch: 1, seatPath: null, askId: "deputy-own", clientRequestId: "own-request", ask: { text: "own question", images: 0, sender: null }, now: new Date(now) });
    ran = false;
    expect((await allowed(request("/api/orchestrator/ghost?askId=deputy-own", member))).status).toBe(200);
    expect(ran).toBe(true);
    ran = false;
    expect((await allowed(request("/api/orchestrator/ghost", member, "POST", { retryAskId: "deputy-own", clientRequestId: "own-retry" }))).status).toBe(200);
    expect(ran).toBe(true);
    const ownRead = await ghostGET(request("/api/orchestrator/ghost?askId=deputy-own", member));
    expect(ownRead.status).toBe(200);
    expect(await ownRead.json()).toEqual({ askId: "deputy-own", lines: [], missing: true });
  });

  test("pipeline ids are resolved independently of a forged project hint", async () => {
    const rows = ["alpha", "beta"].map(name => buildPipeline({ id: `pipeline-${name}`, project: `repo-${name}`, task: name, repoDir: root, taskIds: [], srcPath: null, srcConversationId: null, now: new Date(now).toISOString(), stages: [{ id: "run", kind: "run", prompt: "work", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }] }));
    savePipelines(rows);
    const response = await pipelinesGET(request("/api/pipelines", member));
    expect((await response.json()).pipelines.map((row: { id: string }) => row.id)).toEqual(["pipeline-alpha"]);
    const denied = await pipelinePATCH(request("/api/pipelines/pipeline-beta", member, "PATCH", { action: "hide", project: "repo-alpha" }), { params: Promise.resolve({ id: "pipeline-beta" }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
  });

  test("conversation ids and transcript paths cannot be authorized by a different project's hint", async () => {
    const registry = agentRegistry();
    const receipt = registry.beginSpawn("codex", root, { project: "repo-beta", title: "Workspace foreign conversation" });
    const artifactPath = `${root}/foreign.jsonl`;
    registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: fixtureSessionId(2) }, artifactPath, cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
    for (const route of ["runtime/send", "runtime/inject", "runtime/interrupt", "runtime/steer", "runtime/answer", "runtime/queue", "conversation-host", "tmux", "answer"]) {
      const routes = await import(`../../app/api/${route}/route.ts`) as { POST(req: NextRequest): Promise<Response> };
      const denied = await routes.POST(request(`/api/${route}`, member, "POST", { project: "repo-alpha", conversationId: receipt.conversationId, path: artifactPath, transcriptPath: artifactPath, action: "interrupt", text: "message", idempotencyKey: "workspace-message" }));
      expect(denied.status, route).toBe(403);
      expect(await denied.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
    }
  });

  test("runtime events resolve durable conversation ownership and recheck revocation after lookup", async () => {
    const registry = agentRegistry();
    const receipt = registry.beginSpawn("codex", root, { project: "repo-alpha", title: "Workspace conversation" });
    registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: fixtureSessionId(1) }, artifactPath: `${root}/session.jsonl`, cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
    const event: RuntimeEvent = { schemaVersion: 1, seq: 1, eventId: "evt-workspace", scope: runtimeScope("session", receipt.conversationId), revision: 1, kind: "turn-started", occurredAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), producer: { kind: "test" }, causationId: null, correlationId: null, payload: {} };
    const scope = workspaceScope(store, member.id);
    expect(await workspaceRuntimeEvent(scope, event)).toBe(true);
    expect(await workspaceRuntimeEvent(workspaceScope(store, outsider.id), event)).toBe(false);
    expect(await workspaceRuntimeEvent(scope, event, () => {
      store.removeWorkspaceMember(W1, member.id);
      return workspaceScope(store, member.id);
    })).toBe(false);
  });

  test("runtime snapshot ownership is filtered in one batch and rechecks membership after resolving", async () => {
    const registry = agentRegistry();
    const ids = ["alpha", "beta"].map((project, index) => {
      const receipt = registry.beginSpawn("codex", root, { project: `repo-${project}`, title: project });
      registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId: fixtureSessionId(index + 10) }, artifactPath: `${root}/${project}.jsonl`, cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
      return receipt.conversationId;
    });
    const source: RuntimeSnapshot = { schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, serverTime: new Date(now).toISOString(), runtime: { hostEpoch: 1, health: "healthy" }, filesRevision: 1, sessions: ids.map(conversationId => ({ conversationId })) as RuntimeSnapshot["sessions"], attentions: [], recentOperations: [], edges: [], tasks: [], flows: [], workflows: [], deployments: [] };
    const scope = workspaceScope(store, member.id);
    expect((await workspaceRuntime(scope, source)).sessions.map(row => row.conversationId)).toEqual([ids[0]!]);
    const revoked = await workspaceRuntime(scope, source, () => { store.removeWorkspaceMember(W1, member.id); return workspaceScope(store, member.id); });
    expect(revoked.sessions).toEqual([]);
    expect(await workspaceRuntime(workspaceScope(store, owner.id), source)).toBe(source);
  });

  test("the board projection removes foreign rows, aliases, names and navigation maps", () => {
    const files = ["alpha", "beta"].map(name => ({ ...catalogEntryToFileEntry({ path: `${root}/${name}.jsonl`, root: "codex-sessions", name, project: `repo-${name}`, title: name, firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: now / 1000, size: 10 }, now), conversationId: `conversation_${name}` as const }));
    const source: FilesResponse = { files, tasks: [...loadTasksForList()], flows: [], pipelines: [], workflows: [], systemHealth: { tmux: { status: "healthy" } }, projectCatalog: [], projectAliases: { "repo-alpha": "repo-beta" }, projectDisplayNames: { "repo-alpha": "alpha", "repo-beta": "beta" }, conversationAliases: { hidden: "conversation_beta" }, launchRoutes: { hidden: "conversation_beta" }, projectCwds: { "repo-alpha": "alpha", "repo-beta": "beta" }, crownedProjects: ["repo-alpha", "repo-beta"] };
    const result = workspaceFiles(workspaceScope(store, member.id), source);
    expect(result.files).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("beta");
    expect(workspaceFiles(workspaceScope(store, owner.id), source)).toBe(source);
  });

  test("every project route and method refuses a foreign project before its handler", async () => {
    let checked = 0;
    for (const [route, decision] of Object.entries(WORKSPACE_ROUTES)) {
      if (decision !== "project" && decision !== "collection") continue;
      const routes = await import(`../../app${route}/route.ts`) as Record<string, unknown>;
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
        const handler = routes[method];
        if (typeof handler !== "function") continue;
        const invoke = handler as (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;
        const call = request(`${route}?project=repo-beta`, member, method, ["GET", "HEAD"].includes(method) ? undefined : { project: "repo-beta", taskId: "task-beta" });
        const response = await invoke(call, { params: Promise.resolve({ id: "task-beta", conversationId: "conversation_foreign", reviewId: "review", mediaId: "media" }) });
        expect(response.status, `${method} ${route}`).toBe(403);
        if (method !== "HEAD") expect(await response.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(70);
    expect(loadTasksForList().map(task => task.text)).toEqual(["alpha", "beta"]);
  });
  test("owner, manager, member and unplaced member; Unassigned is manager/owner only", () => {
    for (const [actor, expected] of [[owner, ["owner", "owner", "owner"]], [manager, ["manager", "none", "manager"]], [member, ["member", "none", "none"]], [outsider, ["none", "none", "none"]]] as const) {
      const scope = workspaceScope(store, actor.id);
      expect([scope.access("repo-alpha"), scope.access("repo-beta"), scope.access("repo-new")]).toEqual([...expected]);
    }
  });

  test("the real task routes filter reads and refuse cross-workspace reads and writes", async () => {
    for (const actor of [owner, manager, member, outsider]) {
      const list = await tasksGET(request("/api/tasks", actor));
      expect((await list.json()).tasks.map((task: { id: string }) => task.id)).toEqual(actor === owner ? ["task-alpha", "task-beta"] : actor === outsider ? [] : ["task-alpha"]);
      const read = await tasksGET(request("/api/tasks?project=repo-beta", actor));
      expect(read.status).toBe(actor === owner ? 200 : 403);
      const write = await tasksPOST(request("/api/tasks", actor, "POST", { project: "repo-beta", text: "new task", placement: "unplaced", clientRequestId: `create-${actor.id}` }));
      expect(write.status).toBe(actor === owner ? 200 : 403);
      if (actor !== owner) expect(await write.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
    }
  });

  test("a forged project beside a foreign task id never authorizes the task", async () => {
    for (const actor of [member, manager, outsider]) {
      for (const [method, call] of [["PATCH", taskPATCH], ["DELETE", taskDELETE]] as const) {
        const response = await call(request("/api/tasks/task-beta", actor, method, { project: "repo-alpha", text: "changed" }), { params: Promise.resolve({ id: "task-beta" }) });
        expect(response.status).toBe(403);
      }
    }
    const unassigned = await tasksPOST(request("/api/tasks", manager, "POST", { project: "repo-new", text: "new" }));
    expect(unassigned.status).toBe(403);
    expect(loadTasksForList().find(task => task.id === "task-beta")?.text).toBe("beta");
    const response = await taskPATCH(request("/api/tasks/task-alpha", member, "PATCH", { text: "edited" }), { params: Promise.resolve({ id: "task-alpha" }) });
    expect(response.status).toBe(200);
  });

  test("target resolution rechecks membership after an awaited parameter", async () => {
    let ran = false;
    const route = workspaceRoute("/api/tasks/[id]", async (received: Request, ctx: { params: Promise<{ id: string }> }) => { ran = true; return Response.json({ url: received.url, target: await ctx.params }); });
    const response = await route(request("/api/tasks/task-alpha", member), { params: Promise.resolve().then(() => {
      store.removeWorkspaceMember(W1, member.id);
      return { id: "task-alpha" };
    }) });
    expect(response.status).toBe(403);
    expect(ran).toBe(false);
  });

  test("settings writes recheck the manager role after target resolution", async () => {
    let ran = false;
    const route = workspaceRoute("/api/projects/settings", async (received: Request, ctx: { params: Promise<Record<string, string>> }) => {
      ran = true;
      return Response.json({ url: received.url, target: await ctx.params });
    });
    const response = await route(request("/api/projects/settings", manager, "PUT", { project: "repo-alpha", mergeOnReview: true }), { params: Promise.resolve().then(() => {
      store.putWorkspaceMember(W1, manager.id, "member", owner.id, new Date(now).toISOString());
      return {};
    }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
    expect(ran).toBe(false);
  });

  test("every installation endpoint is owner-only; unplaced navigation opens Team", () => {
    for (const actor of [member, manager, outsider]) {
      expect(teamGate(request("/api/accounts", actor), { bearerAuthenticated: false })?.status).toBe(403);
    }
    expect(teamGate(request("/api/accounts", owner), { bearerAuthenticated: false })).toBeNull();
    expect(teamGate(request("/", outsider), { bearerAuthenticated: false })?.headers.get("location")).toBe("http://localhost/team");
    expect(teamGate(request("/api/team", outsider), { bearerAuthenticated: false })).toBeNull();
    expect(teamGate(request("/api/files", outsider), { bearerAuthenticated: false })?.status).toBe(403);
  });

  test("placement changes apply on the next request and after reopening the store", async () => {
    placeProject(store, owner, "repo-alpha", W2);
    resetTeamStoreForTests();
    store = teamStore();
    const response = await tasksGET(request("/api/tasks?project=repo-alpha", member));
    expect(response.status).toBe(403);
  });

  test("without workspaces the owner retains every project", () => {
    store.deleteWorkspace(W1);
    store.deleteWorkspace(W2);
    expect(workspaceScope(store, owner.id).access("repo-beta")).toBe("owner");
    expect(teamGate(request("/api/files", owner), { bearerAuthenticated: false })).toBeNull();
  });
});

describe("workspace invitations", () => {
  test("the real invite and membership routes enforce manager, owner and workspace boundaries", async () => {
    for (const actor of [member, outsider]) {
      expect((await invitePOST(request("/api/team/invites", actor, "POST", { workspaceId: W1 }))).status).toBe(403);
    }
    expect((await invitePOST(request("/api/team/invites", manager, "POST", { workspaceId: W2 }))).status).toBe(403);
    expect((await invitePOST(request("/api/team/invites", manager, "POST", {}))).status).toBe(403);
    const created = await invitePOST(request("/api/team/invites", manager, "POST", { workspaceId: W1, name: "Joiner" }));
    expect(created.status).toBe(200);
    const invite = await created.json();
    const code = new URL(invite.url).pathname.split("/").at(-1)!;
    const joined = await joinPOST(request(`/api/team/join/${code}`, outsider, "POST", { name: "Joiner" }), { params: Promise.resolve({ code }) });
    expect(joined.status).toBe(200);
    const joinedId = (await joined.json()).me.id;
    expect(store.workspaceMemberships(joinedId)).toEqual([{ workspaceId: W1, role: "member" }]);
    const ctx = { params: Promise.resolve({ id: W2 }) };
    expect((await memberPUT(request(`/api/team/workspaces/${W2}/members`, manager, "PUT", { memberId: outsider.id, role: "manager" }), ctx)).status).toBe(403);
    expect((await memberPUT(request(`/api/team/workspaces/${W2}/members`, owner, "PUT", { memberId: outsider.id, role: "manager" }), ctx)).status).toBe(200);
    const foreign = await invitePOST(request("/api/team/invites", outsider, "POST", { workspaceId: W2 }));
    expect(foreign.status).toBe(200);
    const foreignId = (await foreign.json()).id;
    const shown = await (await inviteGET(request("/api/team/invites", manager))).json();
    expect(shown.invites.some((row: { id: string }) => row.id === foreignId)).toBe(false);
    expect(shown.requests).toEqual([]);
    expect((await memberPUT(request(`/api/team/workspaces/${W2}/members`, owner, "PUT", { memberId: outsider.id, role: "owner" }), ctx)).status).toBe(400);
    expect((await inviteDELETE(request(`/api/team/invites/${foreignId}`, manager, "DELETE"), { params: Promise.resolve({ id: foreignId }) })).status).toBe(403);
    expect((await inviteDELETE(request(`/api/team/invites/${foreignId}`, outsider, "DELETE"), { params: Promise.resolve({ id: foreignId }) })).status).toBe(200);
    const membersCtx = { params: Promise.resolve({ id: W1 }) };
    expect((await memberDELETE(request(`/api/team/workspaces/${W1}/members`, member, "DELETE", { memberId: joinedId }), membersCtx)).status).toBe(403);
    expect((await memberDELETE(request(`/api/team/workspaces/${W1}/members`, manager, "DELETE", { memberId: joinedId }), membersCtx)).status).toBe(200);
    expect(store.workspaceMemberships(joinedId)).toEqual([]);
  });

  test("a manager places Unassigned projects in their workspace and cannot move a foreign project", async () => {
    const put = (project: string, workspaceId: string) => placementPUT(request("/api/team/workspace-projects", manager, "PUT", { project, workspaceId }));
    expect((await put("repo-new", W1)).status).toBe(200);
    expect((await put("repo-beta", W1)).status).toBe(403);
    expect((await put("repo-alpha", W2)).status).toBe(403);
    expect(workspaceScope(store, member.id).access("repo-new")).toBe("member");
  });
  test("a manager enrolls a person only into their workspace, atomically and once", () => {
    const invite = createInvite(store, manager, "Joiner", now, W1);
    const joined = redeemJoin(store, invite.code, "Joiner", device, now);
    expect(store.workspaceMemberships(joined.member.id)).toEqual([{ workspaceId: W1, role: "member" }]);
    expect(() => redeemJoin(store, invite.code, "Another", device, now)).toThrow(TeamError);
    expect(store.members()).toHaveLength(5);
    resetTeamStoreForTests();
    store = teamStore();
    expect(workspaceScope(store, joined.member.id).access("repo-alpha")).toBe("member");
  });

  test("member, foreign manager and manager without a workspace cannot invite", () => {
    for (const [actor, workspace] of [[member, W1], [manager, W2], [manager, undefined], [outsider, W1]] as const) {
      expect(() => createInvite(store, actor, "Joiner", now, workspace)).toThrow(TeamError);
    }
    expect(store.openChallenges("invite", new Date(now).toISOString())).toEqual([]);
  });

  test("an owner's plain invite gives Team only; failed redemption consumes nothing", () => {
    const invite = createInvite(store, owner, "Joiner", now);
    const joined = redeemJoin(store, invite.code, "Joiner", device, now);
    expect(store.workspaceMemberships(joined.member.id)).toEqual([]);
    const scoped = createInvite(store, manager, "Second", now, W1);
    store.removeWorkspaceMember(W1, manager.id);
    expect(() => redeemJoin(store, scoped.code, "Second", device, now)).toThrow(TeamError);
    expect(store.challenge(scoped.challenge.id)?.consumedAt).toBeNull();
    expect(store.members()).toHaveLength(5);
  });

  test("a deleted workspace cannot be redeemed or revived by an outstanding invite", () => {
    const invite = createInvite(store, manager, "Joiner", now, W1);
    store.deleteWorkspace(W1);
    expect(() => redeemJoin(store, invite.code, "Joiner", device, now)).toThrow(TeamError);
    expect(store.challenge(invite.challenge.id)?.consumedAt).toBeNull();
    expect(store.workspaceMemberships(manager.id)).toEqual([]);
  });
});
