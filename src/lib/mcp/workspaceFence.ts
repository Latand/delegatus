import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithNativeCallProof } from "@/lib/attention/nativeCallProof";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { canonicalProject } from "@/lib/projects/aliases";
import { resolveShortId } from "@/lib/shortIds";
import { projectForCwd } from "@/lib/scanner/describe";
import { conversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { readDeliveryProgress } from "@/lib/runtime/deliveryProgress";
import { existingTeamStore } from "@/lib/team/store";
import { conversationWorkspacePrincipal, workspacePrincipalAccess } from "@/lib/team/workspacePrincipal";
import { workspaceDirectory } from "@/lib/team/workspaces";
import { assertWorkspaceExecution, runWithWorkspaceExecution } from "@/lib/team/workspaceExecution";
import { selectedContextArg } from "./selectedContextTarget";
import { McpToolRefusal, type McpToolBindings, type McpToolService } from "./server";
import type { ViewerMcpDomainDependencies } from "./bindings";

export const assertWorkspaceMcpCall = assertWorkspaceExecution;

function denied(): never {
  throw new McpToolRefusal("workspace access denied", { code: "workspace_forbidden", retryable: false });
}

// Closed vocabulary: new installation-wide tools cannot accidentally widen a
// member's reach. Project tools resolve every supplied identity before receipts.
const PROJECT_TOOLS = new Set([
  "spawn_agent", "send_message", "message_receipt", "create_task", "update_task", "create_pipeline", "pipeline_action", "pipeline_checks",
  "stage_report", "leave_lesson", "link_task_to_pipeline", "list_conversations", "search_transcripts", "search_memory", "get_conversation", "conversation_deliverability",
  "conversation_messages", "get_pipeline", "board_snapshot", "list_flows", "get_flow", "flow_action", "list_pipelines", "list_tasks", "get_task",
  "conversation_action", "conversation_migration", "agent_fleet", "agent_activity", "lifecycle_events", "bridge_report", "bridge_directive",
  "get_orchestrator", "create_orchestrator", "send_message_to_orchestrator", "ask_orchestrator_in_parallel", "rotate_orchestrator", "seat_tick_settings",
]);
const COLLECTIONS = new Set(["list_conversations", "search_transcripts", "search_memory", "board_snapshot", "list_flows", "list_pipelines", "list_tasks", "agent_fleet", "agent_activity", "lifecycle_events"]);
const CONVERSATIONS = new Set(["conversationId", "expectedConversationId", "sourceConversationId", "srcConversationId", "seatConversationId", "parentConversationId", "launcherConversationId", "parent", "supersedes", "reviews", "src", "srcPath", "transcriptPath", "path", "paths", "voiceFor"]);
const TASKS = new Set(["taskId", "taskIds", "parentTaskId", "sourceTaskId", "finishesTask"]);
const PIPELINES = new Set(["pipelineId", "sourcePipelineId"]);

/** Checks also surround bindings, including their HTTP dispatch after preparation. */
export function workspaceGuardedBindings(bindings: McpToolBindings): McpToolBindings {
  return Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, Object.assign((...args: Parameters<typeof binding>) => {
    assertWorkspaceMcpCall();
    return binding(...args);
  }, binding)])) as McpToolBindings;
}

export function withWorkspaceMcpFence(service: McpToolService, dependencies: ViewerMcpDomainDependencies): McpToolService {
  return { async callTool(tool, input, context) {
    // The native proof must be in scope before resolving the caller, just as it
    // is in the core dispatcher. No caller-supplied identity hint is consulted.
    if (typeof input.nativeCallerProof === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.nativeCallerProof)) {
      const { nativeCallerProof, ...args } = input;
      return runWithNativeCallProof(nativeCallerProof, tool, args, () => this.callTool(tool, args, context));
    }
    const refuse = () => ({ ok: false as const, toolName: tool, clientRequestId: typeof input.clientRequestId === "string" ? input.clientRequestId : null,
      replayed: false, code: "workspace_forbidden", error: "workspace access denied", retryable: false });
    try {
      const store = existingTeamStore();
      const authority = dependencies.attentionAuthority();
      if (authority.kind === "unidentified" && ["capability-unresolved", "capability-conflict"].includes(authority.admission?.reason ?? "")) denied();
      const callerId = authority.kind === "root" || authority.kind === "worker" ? authority.conversationId : null;
      const lookup = dependencies.workspaceConversation ?? ((id: string) => {
        const current = dependencies.registrySnapshot();
        return Object.hasOwn(current.conversations, id) ? current.conversations[id]!
          : Object.values(current.conversations).find(row => row.generations.some(generation => generation.path === id) || row.continuityPaths?.includes(id)) ?? null;
      });
      const principal = conversationWorkspacePrincipal(lookup, callerId, store);
      if (!principal) return service.callTool(tool, input, context);
      if (!store) denied();
      if (!PROJECT_TOOLS.has(tool)) denied();
      if (tool === "leave_lesson" && (input.rewrite || (input.lesson as { scope?: string } | undefined)?.scope === "machine")) denied();
      const conversationProject = (id: string): string | null => {
        if (dependencies.workspaceProject) return dependencies.workspaceProject(id);
        const record = lookup(id);
        return conversationProjectKey(record?.projectOwnership, record?.generations.at(-1)?.launchProfile, { project: conversationCatalogEntry(id)?.project });
      };
      const project = conversationProject(callerId ?? "");
      let allowed = workspacePrincipalAccess(principal);
      const allowedProjects = workspaceDirectory(store).workspaces.find(workspace => workspace.id === principal.workspaceId)?.projects ?? [];
      const args = { ...input };
      if (typeof args.project === "string") {
        const matches = allowedProjects.filter(key => key === args.project || key.startsWith(args.project as string));
        if (matches.length === 1) args.project = matches[0];
      }
      if (COLLECTIONS.has(tool) && !args.project) args.project = project;
      const checks: (() => string | null | undefined)[] = [() => project];
      const task = (id: string) => {
        const source = dependencies.taskSelectionSource?.();
        return source ? source.read(id)?.project : (dependencies.listTaskRecords?.() ?? dependencies.loadTasks()).find(row => row.id === id)?.project;
      };
      const pipeline = (id: string) => {
        const source = dependencies.pipelineSelectionSource?.();
        if (source) return source.read(id)?.project;
        return dependencies.readPipelineRecord ? dependencies.readPipelineRecord(id)?.project
          : (dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines).find(row => row.id === id)?.project;
      };
      if (tool === "stage_report" || tool === "leave_lesson") checks.push(() => {
        const held = (dependencies.listPipelineRecords?.() ?? dependencies.getPipelines().pipelines)
          .filter(row => row.runs.some(run => run.attempts.some(attempt => attempt.conversationId === callerId)));
        return held.every(row => allowed(row.project)) ? project : null;
      });
      const check = (key: string, value: unknown): void => {
        if (key === "selectedContext") {
          const ref = selectedContextArg(value);
          if (ref?.state === "selected") {
            check("conversationId", ref.conversationId);
            for (const task of ref.tasks ?? []) check("taskId", task.id);
          }
          else denied();
          return;
        }
        const identity = ["project", "expectedProject", "projectId", "cwd", "repoDir", "flowId"].includes(key)
          || CONVERSATIONS.has(key) || TASKS.has(key) || PIPELINES.has(key)
          || key === "ids" && ["list_tasks", "list_pipelines", "list_flows"].includes(tool);
        if (identity && value != null && typeof value !== "string") {
          const list = ["paths", "taskIds", "ids", "finishesTask"].includes(key) && Array.isArray(value);
          if (!list && !(key === "finishesTask" && typeof value === "boolean")) denied();
        }
        if (Array.isArray(value)) { for (const item of value) check(key, item); return; }
        if (value && typeof value === "object") { for (const [field, item] of Object.entries(value)) check(field, item); return; }
        if (typeof value !== "string" || !value) return;
        if (key === "project" || key === "expectedProject" || key === "projectId") checks.push(() => canonicalProject(value));
        if (CONVERSATIONS.has(key)) checks.push(() => conversationProject(value));
        if (TASKS.has(key) || key === "ids" && tool === "list_tasks") checks.push(() => task(value));
        if (PIPELINES.has(key) || key === "ids" && tool === "list_pipelines") checks.push(() => pipeline(value));
        if (key === "flowId" || key === "ids" && tool === "list_flows") checks.push(() => dependencies.getFlowsWithPresets().flows.find(row => row.id === value)?.project);
        if (["cwd", "repoDir"].includes(key)) {
          const lexical = path.resolve(value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);
          checks.push(() => projectForCwd(lexical), () => { try { return projectForCwd(fs.realpathSync(lexical)); } catch { return null; } });
        }
      };
      for (const [key, value] of Object.entries(args)) check(key, value);
      // Implicit selection, global operations and unkeyed receipt/report reads
      // cannot acquire project authority from a neighbouring permitted argument.
      if (["get_conversation", "conversation_messages", "conversation_deliverability", "send_message", "conversation_action", "conversation_migration"].includes(tool)
        && !(tool === "conversation_action" && Array.isArray(args.targets)) && !["conversationId", "transcriptPath", "path", "selectedContext"].some(key => args[key])) denied();
      if (tool === "message_receipt") {
        const operationId = typeof args.operationId === "string" ? args.operationId : "";
        const progress = () => readDeliveryProgress([operationId]).get(operationId);
        checks.push(() => { const id = progress()?.conversationId; return id ? conversationProject(id) : null; });
      }
      if (args.machine || ["bridge_report", "bridge_directive"].includes(tool) && (args.seq !== undefined || args.ref !== undefined)) denied();
      if (tool === "conversation_action" && ["kill-target", "compact-all"].includes(String(args.action))) denied();
      const assert = () => {
        allowed = workspacePrincipalAccess(principal);
        if (!checks.every(check => allowed(check()))) denied();
        const targetEngine = typeof args.conversationId === "string" ? lookup(args.conversationId)?.engine : null;
        const engine = targetEngine ?? args.engine;
        for (const key of ["account", "accountId", "targetAccountId"]) if (typeof args[key] === "string" && (engine === "claude" || engine === "codex")) {
          const targetProject = typeof args.conversationId === "string" ? conversationProject(args.conversationId) : project;
          const pool = allowedAccountIdsForProject(typeof args.project === "string" ? args.project : targetProject, engine);
          if (pool && !pool.includes(args[key] as string)) denied();
        }
      };
      assert();
      let answerProjects: string[] = [];
      const answerProject = (value: string): boolean => {
        if (allowed(value)) return true;
        const resolution = resolveShortId(answerProjects, value);
        return resolution.kind === "match" && allowed(resolution.value);
      };
      const projectAnswer = (value: unknown, key = ""): unknown => {
        if (Array.isArray(value)) return value.map(item => projectAnswer(item, key)).filter(item => item !== undefined);
        if (value && typeof value === "object") {
          const row = value as Record<string, unknown>;
          if (typeof row.project === "string" && !answerProject(row.project)) return undefined;
          return Object.fromEntries(Object.entries(row).map(([field, item]) => [field, projectAnswer(item, field)]).filter(([, item]) => item !== undefined));
        }
        if (typeof value === "string" && value) {
          if (CONVERSATIONS.has(key) && !allowed(conversationProject(value))) return undefined;
          if ((TASKS.has(key) || key === "pipelineIds" || key === "linkedPipelineIds")
            && !allowed(key === "pipelineIds" || key === "linkedPipelineIds" ? pipeline(value) : task(value))) return undefined;
        }
        return value;
      };
      return await runWithWorkspaceExecution(project => { assert(); if (project !== undefined && !allowed(project)) denied(); }, async () => {
        const result = await service.callTool(tool, args, { ...context, assertResult(answer) {
          context?.assertResult?.(answer);
          assert();
          if (!answer.ok) return;
          if (tool === "search_transcripts") {
            const scope = answer.projectScope as { resolved?: string } | undefined;
            // The outer fence discards an unscoped search fallback wholesale.
            if (!scope?.resolved) return;
            if (!allowed(scope.resolved)) denied();
          }
          // A shortened foreign key can collide with an allowed key, including
          // an Unassigned project absent from the workspace directory. Judge
          // every row while the core still holds its full identity.
          const seen = new WeakSet<object>();
          const visit = (value: unknown): void => {
            if (!value || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            if (typeof (value as { project?: unknown }).project === "string" && !allowed((value as { project: string }).project)) denied();
            for (const item of Object.values(value)) visit(item);
          };
          visit(answer);
        } });
        assert();
        answerProjects = workspaceDirectory(store).workspaces.flatMap(workspace => workspace.projects);
        if (tool === "search_transcripts" && result.ok) {
          const scope = result.projectScope as { resolved?: string } | undefined;
          if (!scope?.resolved || !answerProject(scope.resolved)) return { ...result, items: [], total: 0, strongTotal: 0, nextCursor: null, stats: undefined };
          // Corpus counts and duplicate paths describe the whole installation.
          return { ...result, stats: undefined, items: (result.items as Record<string, unknown>[]).filter(row => answerProject(String(row.project))).map(row => ({ ...row, alsoIn: undefined, duplicateCount: undefined })) };
        }
        const answer = result.ok ? projectAnswer(result) : result;
        return answer === undefined ? refuse() : answer as typeof result;
      });
    } catch (error) {
      if (error instanceof McpToolRefusal && error.details.code === "workspace_forbidden") return refuse();
      // A broken authority store cannot silently restore installation reach.
      return { ...refuse(), code: "workspace_unavailable", error: "workspace authority is unavailable", retryable: true };
    }
  } };
}
