import type { FilesResponse } from "@/lib/types";
import type { RuntimeEvent, RuntimeSnapshot } from "@/lib/runtime/contracts";
import { workspaceConversationProject, workspaceConversationResolver } from "./workspaceRoute";
import type { workspaceScope } from "./workspaceAccess";

type Scope = ReturnType<typeof workspaceScope>;

/** Explicit fields keep incidental installation metadata out of a member's board. */
export function workspaceFiles(scope: Scope, source: FilesResponse): FilesResponse {
  if (scope.owner) return source;
  const allowed = (project: string | null | undefined) => scope.access(project) !== "none";
  const files = source.files.filter(row => allowed(row.project));
  const paths = new Set(files.map(row => row.path));
  const ids = new Set(files.flatMap(row => row.conversationId ? [row.conversationId] : []));
  const keyed = <T>(rows: Record<string, T> | undefined) => Object.fromEntries(Object.entries(rows ?? {}).filter(([project]) => allowed(project)));
  const tasks = source.tasks.filter(row => allowed(row.project));
  const taskIds = new Set(tasks.map(row => row.id));
  return {
    files,
    tasks,
    flows: source.flows.filter(row => allowed(row.project)),
    pipelines: source.pipelines.filter(row => allowed(row.project)),
    workflows: source.workflows.filter(row => allowed(row.project)),
    projectCatalog: source.projectCatalog?.filter(row => allowed(row.project)),
    projectCwds: keyed(source.projectCwds),
    projectDisplayNames: keyed(source.projectDisplayNames),
    projectAliases: Object.fromEntries(Object.entries(source.projectAliases ?? {}).filter(([from, to]) => allowed(from) && allowed(to))),
    crownedProjects: source.crownedProjects?.filter(allowed),
    pinOverlayPaths: source.pinOverlayPaths?.filter(path => paths.has(path)),
    conversationAliases: Object.fromEntries(Object.entries(source.conversationAliases ?? {}).filter(([, to]) => ids.has(to))),
    launchRoutes: Object.fromEntries(Object.entries(source.launchRoutes ?? {}).filter(([, to]) => ids.has(to))),
    prototypeReviewNotices: source.prototypeReviewNotices?.filter(row => row.taskId !== null && taskIds.has(row.taskId)),
    seatDecisions: source.seatDecisions?.filter(row => allowed(row.project)),
    systemHealth: { tmux: source.systemHealth.tmux },
    ...(source.readProjection ? { readProjection: source.readProjection } : {}),
  };
}

export async function workspaceRuntime(scope: Scope, snapshot: RuntimeSnapshot, refresh?: () => Scope | null): Promise<RuntimeSnapshot> {
  if (scope.owner) return snapshot;
  const projects = new Map<string, string | null>();
  const admitted = new Set<string>();
  const resolve = await workspaceConversationResolver();
  for (const session of snapshot.sessions) projects.set(session.conversationId, resolve(session.conversationId));
  const latest = refresh ? refresh() : scope;
  for (const [id, project] of projects) if (latest?.access(project) !== "none" && latest) admitted.add(id);
  scope = latest ?? { ...scope, access: () => "none" };
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter(row => admitted.has(row.conversationId)),
    attentions: snapshot.attentions.filter(row => admitted.has(row.conversationId)),
    recentOperations: snapshot.recentOperations.filter(row => admitted.has(row.conversationId)),
    edges: [],
    tasks: snapshot.tasks.filter(row => scope.access(row.value.project) !== "none"),
    flows: snapshot.flows.filter(row => scope.access(row.value.project) !== "none"),
    workflows: snapshot.workflows.filter(row => scope.access(row.value.project) !== "none"),
    deployments: [],
  };
}

export async function workspaceRuntimeEvent(scope: Scope, event: RuntimeEvent, refresh?: () => Scope | null): Promise<boolean> {
  // Events about system, accounts and deploys have installation-wide payloads.
  if (scope.owner) return true;
  if (event.scope.type !== "session") return false;
  const project = await workspaceConversationProject(event.scope.id);
  const latest = refresh ? refresh() : scope;
  return Boolean(latest && latest.access(project) !== "none");
}
