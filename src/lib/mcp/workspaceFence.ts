import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithNativeCallProof } from "@/lib/attention/nativeCallProof";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { resolveShortId } from "@/lib/shortIds";
import { projectForCwd } from "@/lib/scanner/describe";
import { conversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { readDeliveryProgress } from "@/lib/runtime/deliveryProgress";
import { existingTeamStore } from "@/lib/team/store";
import { conversationWorkspacePrincipal, workspacePrincipalAccess } from "@/lib/team/workspacePrincipal";
import { seatHoldsTelegramGrant } from "@/lib/team/seatTelegram";
import { workspaceDirectory } from "@/lib/team/workspaces";
import { assertWorkspaceExecution, runWithWorkspaceExecution } from "@/lib/team/workspaceExecution";
import { selectedContextArg } from "./selectedContextTarget";
import { McpToolRefusal, retainResponseAuthority, type McpToolBindings, type McpToolService } from "./server";
import { captureBoardAliasProof, captureBoardCaller, resolveBoardSelection, type ViewerMcpDomainDependencies } from "./bindings";
import type { NamedProjectDirectory } from "@/lib/projects/nameResolution";
import { currentMcpHttpCaller, runWithMcpCallerResolution } from "./callerContext";

export const assertWorkspaceMcpCall = assertWorkspaceExecution;

function denied(check: string): never {
  throw new McpToolRefusal(`workspace access denied (${check})`, { code: "workspace_forbidden", retryable: false, check });
}

// Closed vocabulary: new installation-wide tools cannot accidentally widen a
// member's reach. Project tools resolve every supplied identity before receipts.
const PROJECT_TOOLS = new Set([
  "grant_agent_browser_access",
  "spawn_agent", "send_message", "message_receipt", "create_task", "update_task", "create_pipeline", "pipeline_action", "pipeline_checks",
  "stage_report", "leave_lesson", "link_task_to_pipeline", "list_conversations", "search_transcripts", "search_memory", "get_conversation", "conversation_deliverability",
  "conversation_messages", "get_pipeline", "board_snapshot", "list_pipelines", "list_tasks", "get_task",
  "conversation_action", "conversation_migration", "agent_fleet", "agent_activity", "lifecycle_events", "bridge_report", "bridge_directive",
  "get_orchestrator", "create_orchestrator", "send_message_to_orchestrator", "ask_orchestrator_in_parallel", "rotate_orchestrator", "seat_tick_settings",
]);
// A project's seat keeps the Telegram grant on its record under member reach
// (`seatHoldsTelegramGrant`), with the chats the agent route serves any caller.
const SEAT_TELEGRAM_TOOLS = new Set(["telegram_bot_send", "telegram_bot_send_media", "telegram_bot_send_document", "telegram_bot_chats", "telegram_bot_messages"]);
// These reach a Viewer route that applies the workspace fence itself to the
// caller's forwarded capability, so the route judges their arguments.
const ROUTE_FENCED_TOOLS = new Set(["publish_prototype_review", "read_prototype_review"]);
const COLLECTIONS = new Set(["list_conversations", "search_transcripts", "search_memory", "board_snapshot", "list_pipelines", "list_tasks", "agent_fleet", "agent_activity", "lifecycle_events"]);
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

export function withWorkspaceMcpFence(
  service: McpToolService,
  dependencies: ViewerMcpDomainDependencies,
  prepareNativeCaller?: () => Promise<void>,
): McpToolService {
  return { async callTool(tool, input, context) {
    // The native proof must be in scope before resolving the caller, just as it
    // is in the core dispatcher. No caller-supplied identity hint is consulted.
    if (typeof input.nativeCallerProof === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.nativeCallerProof)) {
      const { nativeCallerProof, ...args } = input;
      const caller = currentMcpHttpCaller();
      if (prepareNativeCaller && (!caller || caller.nativePeer)) {
        try { await prepareNativeCaller(); }
        catch { /* The verifier will assess whether caller evidence is available. */ }
      }
      return runWithNativeCallProof(nativeCallerProof, tool, args, () => this.callTool(tool, args, context));
    }
    const refuse = (check: string) => ({ ok: false as const, toolName: tool, clientRequestId: typeof input.clientRequestId === "string" ? input.clientRequestId : null,
      replayed: false, code: "workspace_forbidden", error: `workspace access denied (${check})`, retryable: false, details: { check } });
    const boardRead = tool === "list_tasks" || tool === "list_pipelines";
    try {
      const replay = await service.replayTool?.(tool, input);
      if (replay) return replay;
      const store = existingTeamStore();
      const authority = dependencies.attentionAuthority();
      if (authority.kind === "unidentified" && ["capability-unresolved", "capability-conflict"].includes(authority.admission?.reason ?? "")) denied("caller");
      const callerId = authority.kind === "root" || authority.kind === "worker" ? authority.conversationId : null;
      const lookup = dependencies.workspaceConversation ?? ((id: string) => {
        const current = dependencies.registrySnapshot();
        return Object.hasOwn(current.conversations, id) ? current.conversations[id]!
          : Object.values(current.conversations).find(row => row.generations.some(generation => generation.path === id) || row.continuityPaths?.includes(id)) ?? null;
      });
      const principal = conversationWorkspacePrincipal(lookup, callerId, store);
      const principalIdentity = JSON.stringify(principal);
      const conversationProject = (id: string): string | null => {
        if (dependencies.workspaceProject) return dependencies.workspaceProject(id);
        const record = lookup(id);
        return conversationProjectKey(record?.projectOwnership, record?.generations.at(-1)?.launchProfile, { project: conversationCatalogEntry(id)?.project });
      };
      const project = principal || boardRead ? conversationProject(callerId ?? "") : null;
      const responseProjects: string[] = [];
      const boardCaller = boardRead ? captureBoardCaller(dependencies, { ...context, responseAuthority: undefined }) : undefined;
      const assertBoardCaller = () => runWithMcpCallerResolution(() => {
        context?.assertCaller?.();
        const current = dependencies.attentionAuthority();
        const currentId = current.kind === "worker" || current.kind === "root" ? current.conversationId : null;
        if (current.kind !== authority.kind || currentId !== callerId
          || conversationProject(callerId ?? "") !== project
          || JSON.stringify(conversationWorkspacePrincipal(lookup, callerId)) !== principalIdentity) denied("board-caller");
        if (principal) {
          const currentAccess = workspacePrincipalAccess(principal);
          if (!currentAccess(project) || !responseProjects.every(currentAccess)) denied("board-project");
        }
        boardCaller?.assert();
      });
      // Even an unrestricted caller and an early resolver refusal must retain
      // current workspace authority through the final service/SDK await.
      if (boardRead) {
        assertBoardCaller();
        retainResponseAuthority(context ?? {}, assertBoardCaller);
      }
      if (!principal) {
        if (!boardRead) return service.callTool(tool, input, context);
        const result = await service.callTool(tool, input, { ...context, assertCaller: assertBoardCaller });
        assertBoardCaller();
        return result;
      }
      if (!store) denied("team-store");
      const seatTelegram = SEAT_TELEGRAM_TOOLS.has(tool);
      if (!PROJECT_TOOLS.has(tool) && !seatTelegram && !ROUTE_FENCED_TOOLS.has(tool)) denied("tool");
      if (tool === "leave_lesson" && (input.rewrite || (input.lesson as { scope?: string } | undefined)?.scope === "machine")) denied("lesson-scope");
      let allowed = workspacePrincipalAccess(principal);
      // Arguments of these tools name chats and files, never project identities,
      // so the identity pass skips them. The result scan below still runs.
      const delegated = !PROJECT_TOOLS.has(tool);
      const granted = () => { if (seatTelegram && !seatHoldsTelegramGrant(callerId, store, lookup)) denied("telegram-grant"); };
      granted();
      const allowedProjects = workspaceDirectory(store).workspaces.find(workspace => workspace.id === principal.workspaceId)?.projects ?? [];
      const args = { ...input };
      const named = typeof input.project === "string" ? input.project.trim() : "";
      const aliasSnapshot = boardRead ? projectAliasSnapshot({ strict: true }) : { aliases: {}, displayNames: {} };
      const aliases = aliasSnapshot.aliases;
      const projectRefusal = (details: Record<string, unknown>) => {
        const permitted = (value: unknown): value is { project: string; name: string } => Boolean(value && typeof value === "object"
          && typeof (value as { project?: unknown }).project === "string" && typeof (value as { name?: unknown }).name === "string"
          && allowed((value as { project: string }).project));
        const candidates = Array.isArray(details.candidateNames) ? details.candidateNames : [];
        if (details.code === "ambiguous_project" && !candidates.every(permitted)) denied("board-project");
        const names = candidates.filter(permitted);
        const matches = (Array.isArray(details.closeMatches) ? details.closeMatches : []).filter(permitted);
        responseProjects.push(...names.map(row => row.project), ...matches.map(row => row.project));
        // Rebuild both channels, including refusals returned by the inner service.
        return { ...refuse("board-project"), code: String(details.code),
          error: details.code === "ambiguous_project" ? `ambiguous project: ${names.map(row => row.name).join(", ")}`
            : `no such project; ${matches.length ? `close matches: ${matches.map(row => row.name).join(", ")}` : "no close matches"}`,
          details: { code: details.code, retryable: false,
            ...(details.code === "ambiguous_project" ? { candidates: names.map(row => row.project), candidateNames: names } : { closeMatches: matches }) } };
      };
      let accepted: NamedProjectDirectory | undefined;
      if (boardRead && typeof args.project === "string" && args.project.trim()) {
        try { const selection = resolveBoardSelection(args.project.trim(), dependencies); args.project = selection.project; accepted = selection.directory; }
        catch (error) {
          if (!(error instanceof McpToolRefusal) || !["unknown_project", "ambiguous_project"].includes(String(error.details.code))) throw error;
          return projectRefusal(error.details);
        }
      } else if (!boardRead && typeof args.project === "string") {
        const matches = allowedProjects.filter(key => key === args.project || key.startsWith(args.project as string));
        if (matches.length === 1) args.project = matches[0];
      }
      if (boardRead && typeof args.project === "string" && !args.project.trim()) args.project = project;
      if (COLLECTIONS.has(tool) && !args.project) args.project = project;
      const aliasesUnchanged = boardRead ? captureBoardAliasProof(named, typeof args.project === "string" ? args.project : "", aliases, aliasSnapshot.displayNames, dependencies, accepted) : undefined;
      const checks: { name: string; project: () => string | null | undefined }[] = [{ name: "caller-project", project: () => project }];
      const add = (name: string, project: () => string | null | undefined) => checks.push({ name, project });
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
      if (tool === "stage_report" || tool === "leave_lesson") add("stage-assignment", () => {
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
          else denied("selected-context");
          return;
        }
        const identity = ["project", "expectedProject", "projectId", "cwd", "repoDir", "flowId"].includes(key)
          || CONVERSATIONS.has(key) || TASKS.has(key) || PIPELINES.has(key)
          || key === "ids" && ["list_tasks", "list_pipelines"].includes(tool);
        if (identity && value != null && typeof value !== "string") {
          const list = ["paths", "taskIds", "ids", "finishesTask"].includes(key) && Array.isArray(value);
          if (!list && !(key === "finishesTask" && typeof value === "boolean")) denied(`argument:${key}`);
        }
        if (Array.isArray(value)) { for (const item of value) check(key, item); return; }
        if (value && typeof value === "object") { for (const [field, item] of Object.entries(value)) check(field, item); return; }
        if (typeof value !== "string" || !value) return;
        if (key === "project" || key === "expectedProject" || key === "projectId") add(`argument:${key}`, () => canonicalProject(value));
        if (CONVERSATIONS.has(key)) add(`argument:${key}`, () => conversationProject(value));
        if (TASKS.has(key) || key === "ids" && tool === "list_tasks") add(`argument:${key}`, () => task(value));
        if (PIPELINES.has(key) || key === "ids" && tool === "list_pipelines") add(`argument:${key}`, () => pipeline(value));
        if (key === "flowId") add("argument:flowId", () => dependencies.getFlowsWithPresets().flows.find(row => row.id === value)?.project);
        if (["cwd", "repoDir"].includes(key)) {
          const lexical = path.resolve(value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);
          add(`path:${key}`, () => projectForCwd(lexical));
          add(`realpath:${key}`, () => { try { return projectForCwd(fs.realpathSync(lexical)); } catch { return null; } });
        }
      };
      if (!delegated) for (const [key, value] of Object.entries(args)) check(key, value);
      // Implicit selection, global operations and unkeyed receipt/report reads
      // cannot acquire project authority from a neighbouring permitted argument.
      if (["get_conversation", "conversation_messages", "conversation_deliverability", "send_message", "conversation_action", "conversation_migration"].includes(tool)
        && !(tool === "conversation_action" && Array.isArray(args.targets)) && !["conversationId", "transcriptPath", "path", "selectedContext"].some(key => args[key])) denied("conversation-target");
      if (tool === "message_receipt") {
        const operationId = typeof args.operationId === "string" ? args.operationId : "";
        const progress = () => readDeliveryProgress([operationId]).get(operationId);
        add("message-receipt-target", () => { const id = progress()?.conversationId; return id ? conversationProject(id) : null; });
      }
      if (args.machine || ["bridge_report", "bridge_directive"].includes(tool) && (args.seq !== undefined || args.ref !== undefined)) denied("installation-target");
      if (tool === "conversation_action" && ["kill-target", "compact-all"].includes(String(args.action))) denied("installation-action");
      const assert = () => {
        if (boardRead) {
          assertBoardCaller();
          if (!aliasesUnchanged?.()) denied("board-alias");
        }
        allowed = workspacePrincipalAccess(principal);
        for (const check of checks) if (!allowed(check.project())) denied(check.name);
        const targetEngine = typeof args.conversationId === "string" ? lookup(args.conversationId)?.engine : null;
        const engine = targetEngine ?? args.engine;
        for (const key of ["account", "accountId", "targetAccountId"]) if (typeof args[key] === "string" && (engine === "claude" || engine === "codex")) {
          const targetProject = typeof args.conversationId === "string" ? conversationProject(args.conversationId) : project;
          const pool = allowedAccountIdsForProject(typeof args.project === "string" ? args.project : targetProject, engine);
          if (!pool || !pool.includes(args[key] as string)) denied(`account:${key}`);
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
      let boardRefusal: ReturnType<typeof projectRefusal> | undefined;
      return await runWithWorkspaceExecution(project => { assert(); if (project !== undefined && !allowed(project)) denied("execution-project"); }, async () => {
        const result = await service.callTool(tool, args, { ...context,
          ...(boardRead ? { resolvedBoardProject: typeof args.project === "string" ? args.project : undefined,
            assertCaller() { context?.assertCaller?.(); assert(); } } : {}),
          assertResult(answer) {
          context?.assertResult?.(answer);
          assert();
          if (!answer.ok) {
            if (boardRead && ["unknown_project", "ambiguous_project"].includes(answer.code)) {
              // Judge full identities before the service compacts project keys.
              boardRefusal = projectRefusal({ ...answer.details, code: answer.code });
            }
            return;
          }
          if (tool === "search_transcripts") {
            const scope = answer.projectScope as { resolved?: string } | undefined;
            // The outer fence discards an unscoped search fallback wholesale.
            if (!scope?.resolved) return;
            if (!allowed(scope.resolved)) denied("response-scope");
          }
          // A shortened foreign key can collide with an allowed key, including
          // an Unassigned project absent from the workspace directory. Judge
          // every row while the core still holds its full identity.
          const seen = new WeakSet<object>();
          const visit = (value: unknown): void => {
            if (!value || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            if (typeof (value as { project?: unknown }).project === "string" && !allowed((value as { project: string }).project)) denied("response-project");
            // A record's agent author names the sender's project as a label. It
            // is no row of that project; the compact answer withholds it below.
            for (const [key, item] of Object.entries(value)) if (key !== "author") visit(item);
          };
          visit(answer);
        } });
        assert();
        granted();
        if (boardRead && !result.ok && ["unknown_project", "ambiguous_project"].includes(result.code)) {
          const safe = boardRefusal?.code === result.code ? boardRefusal : projectRefusal({ ...result.details, code: result.code });
          return { ...safe, replayed: result.replayed };
        }
        answerProjects = workspaceDirectory(store).workspaces.flatMap(workspace => workspace.projects);
        if (tool === "search_transcripts" && result.ok) {
          const scope = result.projectScope as { resolved?: string } | undefined;
          if (!scope?.resolved || !answerProject(scope.resolved)) return { ...result, items: [], total: 0, strongTotal: 0, nextCursor: null, stats: undefined };
          // Corpus counts and duplicate paths describe the whole installation.
          return { ...result, stats: undefined, items: (result.items as Record<string, unknown>[]).filter(row => answerProject(String(row.project))).map(row => ({ ...row, alsoIn: undefined, duplicateCount: undefined })) };
        }
        const answer = result.ok ? projectAnswer(result) : result;
        return answer === undefined ? refuse("response-project") : answer as typeof result;
      });
    } catch (error) {
      if (error instanceof McpToolRefusal && error.details.code === "workspace_forbidden") return refuse(String(error.details.check ?? "binding"));
      if (boardRead && error instanceof McpToolRefusal && ["orchestrator_seat_revoked", "orchestrator_seat_authority_unavailable",
        "caller_unidentified", "project_scope_refused", "cross_project_refused"].includes(String(error.details.code))) {
        const code = String(error.details.code), retryable = error.details.retryable === true;
        return { ...refuse("board-caller"), code, retryable, error: "board caller authority refused the read", details: { code, retryable } };
      }
      // A broken authority store cannot silently restore installation reach.
      return { ...refuse("authority-store"), code: "workspace_unavailable", error: "workspace authority is unavailable", retryable: true };
    }
  } };
}
