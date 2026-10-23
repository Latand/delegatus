import { NextRequest, NextResponse } from "next/server";

import { tokensMatch } from "@/lib/authToken";
import { agentCapabilityClaim, internalServiceClaim } from "@/lib/agent/callerClaims";
import { MEMBER_COOKIE, verifySessionValue } from "./sessions";
import { existingTeamStore } from "./store";
import { workspaceScope } from "./workspaceAccess";

type Scope = ReturnType<typeof workspaceScope>;
type Context = { params?: Promise<Record<string, string>> };

export function workspaceDenied(): NextResponse<never> {
  return NextResponse.json({ error: "workspace access denied", code: "workspace_forbidden" }, { status: 403 }) as NextResponse<never>;
}

/** Read the cookie directly: a member's bearer header never upgrades their role. */
export function requestWorkspaceScope(request: Request): Scope | null {
  const store = existingTeamStore();
  if (!store?.hasActiveOwner()) return null;
  if (agentCapabilityClaim(request) === "valid" || internalServiceClaim(request, { readOnly: true }).claim === "valid") return null;
  const req = request instanceof NextRequest ? request : new NextRequest(request.url, { headers: request.headers });
  const live = verifySessionValue(store, req.cookies.get(MEMBER_COOKIE)?.value);
  if (live) return workspaceScope(store, live.member.id);
  // A verified operator bearer is the existing read-only automation entry.
  const token = process.env.LLV_TOKEN;
  if (token && ["GET", "HEAD"].includes(request.method)) {
    if (tokensMatch(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "", token)) return null;
  }
  return workspaceScope(store, "");
}

/** Resolve authority from persisted ownership before accepting a caller's hint. */
export async function workspaceConversationResolver(): Promise<(identity: string) => string | null> {
  const [{ agentRegistry }, { conversationProjectKey }, { conversationCatalogEntry }] = await Promise.all([
    import("@/lib/agent/registry"), import("@/lib/accounts/conversationProject"), import("@/lib/scanner/conversationCatalog"),
  ]);
  return identity => {
    const registry = agentRegistry();
    if (identity.startsWith("spawn:")) {
      const receipt = registry.spawnReceipt(identity.slice(6));
      const owner = receipt ? registry.conversation(receipt.conversationId) : null;
      return receipt ? conversationProjectKey(owner?.projectOwnership, receipt.launchProfile) : null;
    }
    const conversation = identity.startsWith("conversation_")
      ? registry.conversation(identity as `conversation_${string}`)
      : registry.conversationForPath(identity);
    const profile = conversation?.generations.at(-1)?.launchProfile ?? registry.launchProfileForPath(identity);
    const entry = conversationCatalogEntry(identity);
    return conversationProjectKey(conversation?.projectOwnership, profile, entry ? { project: entry.project } : {});
  };
}

export async function workspaceConversationProject(identity: string): Promise<string | null> {
  return (await workspaceConversationResolver())(identity);
}

async function taskProject(id: string): Promise<string | null> {
  const { loadTasksForList } = await import("@/lib/tasks/store");
  return loadTasksForList().find(task => task.id === id)?.project ?? null;
}

async function pipelineProject(id: string): Promise<string | null> {
  const { loadPipelinesForList } = await import("@/lib/pipelines/store");
  return loadPipelinesForList().find(pipeline => pipeline.id === id)?.project ?? null;
}

/** Every supplied resource is checked, including copied parents and nested targets. */
async function targetProjects(route: string, request: Request, ctx?: Context): Promise<(string | null)[]> {
  const url = new URL(request.url);
  if (route === "/api/files" && url.searchParams.get("view") === "storage-health") return [null];
  const projects: (string | null)[] = [];
  let input: Record<string, unknown> = {};
  const check = async (key: string, value: unknown): Promise<void> => {
    if (Array.isArray(value)) {
      for (const item of value) await check(key, item);
      return;
    }
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      // Report acknowledgement addresses the installation's bridge queue.
      if (object.kind === "report") projects.push(null);
      for (const [nested, item] of Object.entries(value)) await check(nested, item);
      return;
    }
    if (typeof value !== "string" || !value) return;
    if (["project", "projectId"].includes(key)) projects.push(value);
    if (["cwd", "repoDir"].includes(key)) {
      const { projectForCwd } = await import("@/lib/scanner/describe");
      projects.push(projectForCwd(value));
    }
    if (["taskId", "parentTaskId", "sourceTaskId"].includes(key)) projects.push(await taskProject(value));
    if (["pipelineId", "sourcePipelineId"].includes(key)) projects.push(await pipelineProject(value));
    if (["launchId", "retryOfLaunchId", "sourceLaunchId"].includes(key)) {
      const { agentRegistry } = await import("@/lib/agent/registry");
      const { conversationProjectKey } = await import("@/lib/accounts/conversationProject");
      const registry = agentRegistry();
      const receipt = registry.spawnReceipt(value);
      const conversation = receipt ? registry.conversation(receipt.conversationId) : null;
      projects.push(receipt ? conversationProjectKey(conversation?.projectOwnership, receipt.launchProfile) : null);
    }
    if (key === "operationId" && route === "/api/runtime/delivery-progress") {
      const { readDeliveryProgress } = await import("@/lib/runtime/deliveryProgress");
      const record = readDeliveryProgress([value]).get(value);
      if (record) projects.push(await workspaceConversationProject(record.conversationId));
      else projects.push(null);
    }
    if ((key === "keys" && route === "/api/attention/done") || (key === "done" && route === "/api/image")) {
      const { readDoneRows } = await import("@/lib/done/store");
      projects.push(readDoneRows().find(row => row.key === value)?.project ?? null);
    }
    if (key === "path" && ["/api/artifact", "/api/image"].includes(route)) {
      const { realpath } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const { resolveLocal } = await import("@/lib/artifact/localFile");
      const { projectForCwd } = await import("@/lib/scanner/describe");
      try { projects.push(projectForCwd(dirname(await realpath(resolveLocal(value))))); } catch { projects.push(null); }
      return;
    }
    if (["conversationId", "sourceConversationId", "parentConversationId", "parent", "supersedes", "reviews", "launcherConversationId", "path", "paths", "src", "srcPath", "transcriptPath", "voiceFor"].includes(key)) projects.push(await workspaceConversationProject(value));
  };
  for (const [key, value] of url.searchParams) await check(key, value);
  if (!["GET", "HEAD"].includes(request.method)) {
    // Clone keeps the exact body and headers for the production parser.
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) return [null];
    let body: unknown;
    try {
      const { readBoundedJson } = await import("@/lib/attention/validation");
      body = await readBoundedJson(request.clone());
    } catch { return [null]; }
    if (body && typeof body === "object" && !Array.isArray(body)) input = body as Record<string, unknown>;
    await check("body", body);
  }
  if (route === "/api/logs/stream") {
    const { parseLogStreamSubs } = await import("@/lib/logTailStream");
    for (const sub of parseLogStreamSubs(url.searchParams.get("subs"))) projects.push(await workspaceConversationProject(sub.path));
  }
  if (["/api/task-album", "/api/task-spend", "/api/task-icons"].includes(route)) {
    for (const id of (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)) projects.push(await taskProject(id));
  }
  const supplied = (key: string) => typeof input[key] === "string" && Boolean((input[key] as string).trim()) || Boolean(url.searchParams.get(key)?.trim());
  if ((route.startsWith("/api/projects/") || route.startsWith("/api/orchestrator/") || route === "/api/board" || route === "/api/timeline" || (route === "/api/tasks/curator" && request.method === "GET") || route === "/api/log/project-delete") && !supplied("project")) return [null];
  if ((route === "/api/spawn" || route === "/api/spawn/validate") && request.method === "POST" && !supplied("cwd")) return [null];
  if (route === "/api/pipelines" && request.method === "POST" && (!supplied("project") || !supplied("repoDir"))) return [null];
  if (route === "/api/pipelines/preflight" && !supplied("repoDir")) return [null];
  if ((route.startsWith("/api/runtime/") && !["/api/runtime/snapshot", "/api/runtime/stream", "/api/runtime/delivery-progress"].includes(route)) && !supplied("conversationId")) return [null];
  if ((route === "/api/conversation-host" || route === "/api/tmux" || route.startsWith("/api/session")) && !supplied("path") && !supplied("conversationId")) return [null];
  if (["/api/conversation-host/targets", "/api/tmux/targets"].includes(route)) {
    if (!Array.isArray(input.reqs) || input.reqs.some(item => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).path !== "string" || !(item as Record<string, unknown>).path)) return [null];
  }
  const params = await ctx?.params;
  if (params?.id && route.startsWith("/api/tasks/")) projects.push(await taskProject(params.id));
  if (params?.id && route.startsWith("/api/pipelines/")) projects.push(await pipelineProject(params.id));
  if (params?.conversationId) projects.push(await workspaceConversationProject(params.conversationId));
  return projects;
}

/** Collections with a project field are filtered before encoding, never by client selection. */
export function filterWorkspaceRows<T extends { project?: string | null }>(scope: Scope | null, rows: readonly T[]): T[] {
  return scope && !scope.owner ? rows.filter(row => scope.access(row.project) !== "none") : [...rows];
}

/** Preserve the handler's signature and its existing test seams. The solo
 * fast path stays synchronous for synchronous handlers. */
export function workspaceRoute<F extends (...args: never[]) => unknown>(route: string, handler: F, collection = false): F {
  const invoke = handler as unknown as (...args: unknown[]) => Response | Promise<Response>;
  const wrapped = (request: Request, ...args: unknown[]): Response | Promise<Response> => {
    let scope: Scope | null;
    try { scope = requestWorkspaceScope(request); }
    catch { return unavailable(); }
    if (!scope || scope.owner) return invoke(request, ...args);
    return (async () => {
      let projects: (string | null)[];
      const read = ["GET", "HEAD"].includes(request.method) || ["/api/logs", "/api/conversation-host/targets", "/api/tmux/targets", "/api/attention/needs-you", "/api/prototype-reviews/read", "/api/spawn/validate"].includes(route);
      const permitted = (project: string | null) => read ? scope!.access(project) !== "none" : scope!.canAct(project);
      try {
        projects = await targetProjects(route, request, args[0] as Context | undefined);
        if (projects.some(project => !permitted(project)) || (!projects.length && !collection)) return workspaceDenied();
        scope = requestWorkspaceScope(request);
        if (!scope || projects.some(project => !permitted(project))) return workspaceDenied();
      } catch { return unavailable(); }
      try {
        const before = read ? scopeSignature(scope) : null;
        const response = await invoke(request, ...args);
        if (read && before !== scopeSignature(requestWorkspaceScope(request))) {
          await response.body?.cancel();
          return workspaceDenied();
        }
        return response;
      }
      catch (error) { if (error instanceof WorkspaceRefusal) return workspaceDenied(); throw error; }
    })();
  };
  return Object.assign(wrapped, handler) as unknown as F;
}

function scopeSignature(scope: Scope | null): string {
  return JSON.stringify(scope ? [scope.memberId, scope.owner, scope.workspaces.map(workspace => workspace.id), scope.projectFilter] : null);
}

function unavailable(): NextResponse {
  return NextResponse.json({ error: "workspace authorization unavailable", code: "team_store_unavailable" }, { status: 503 });
}

export class WorkspaceRefusal extends Error {}

export function assertWorkspaceProject(request: Request, project: string | null | undefined): void {
  const scope = requestWorkspaceScope(request);
  if (scope && !scope.canAct(project)) throw new WorkspaceRefusal("workspace access denied");
}
