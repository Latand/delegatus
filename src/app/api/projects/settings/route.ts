import { workspaceRoute, requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { validAgentMemoryMax } from "@/lib/runtime/agentMemoryConfig";
import { projectAgentMemoryMax, setProjectAgentMemoryMax } from "@/lib/projects/settings";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { canonicalProject, recordedProjectRemote } from "@/lib/projects/aliases";
import { viewerPostableReportChats, viewerReportChatTitle } from "@/lib/projects/reportDestination";
import {
  pipelineStageRuntime,
  setPipelineStageRuntime,
  validPipelineStageRuntime,
  codexCloudEnvironmentId,
  setCodexCloudEnvironmentId,
  validCodexCloudEnvironmentId,
  bridgeReportsSetting,
  mergeOnReviewSetting,
  effectiveReportTelegram,
  REPORT_NAME_MAX_CHARS,
  reportTelegramChoice,
  repositoryReportName,
  setBridgeReports,
  setMergeOnReview,
  setReportTelegram,
  type BridgeReportsSetting,
  type EffectiveReportTelegram,
  type MergeOnReviewSetting,
  type ReportTelegramChoice,
} from "@/lib/projects/settings";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { TelegramBotError, telegramBotService } from "@/lib/telegram/bot/service";
import { parseTelegramChatReference } from "@/lib/telegram/chatReference";
import path from "node:path";
import { listFiles } from "@/lib/scanner";
import { lastScannedProjectCatalog } from "@/lib/scanner/scanCache";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { projectPresentation, setProjectPresentation, validProjectName } from "@/lib/projects/presentation";
import { recordTeamEvent, teamActor } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** What the board's setting rows draw (#2187 §6, #2146): the settings, and
    whether the project has a GitHub repository to merge in at all. */
export interface ProjectSettingsResponse {
  /** Null uses the folder-derived name; an explicit name is display-only. */
  name: string | null;
  archived: boolean;
  agentMemoryMaxBytes?: number | null;
  ok: true;
  project: string;
  codexCloudEnvironmentId: string;
  pipelineStageRuntime?: "local" | "codex-cloud";
  mergeOnReview: MergeOnReviewSetting;
  bridgeReports: BridgeReportsSetting;
  /** What the operator chose for reports besides the bridge log
      (docs/design/orchestrator-reports.md §5.6): a chat, "Log only"
      (`chat: null`), or null when they never chose. */
  reportTelegram: ReportTelegramChoice | null;
  /** Where reports actually go besides the log: the chat the operator chose.
      Null while they chose none or "Log only": nothing is posted to Telegram
      until a chat is chosen. */
  reportDestination: EffectiveReportTelegram | null;
  /** The chosen chat's title as Telegram names it, null with no chat chosen
      or none known; the seat's Reports chip shows it. */
  reportChatTitle: string | null;
  /** How many chats the bot may post in, so the step can offer a pick while
      nothing was chosen. */
  postableChats: number;
  /** The name the setup step prefills: the GitHub repository's, capitalised. */
  reportNameSuggestion: string | null;
  /** `<owner>/<repo>` of the project's recorded remote, null without one. */
  github: string | null;
}

function answer(project: string): ProjectSettingsResponse {
  const key = canonicalProject(project);
  const presentation = projectPresentation(key);
  const postable = viewerPostableReportChats();
  const choice = reportTelegramChoice(key);
  return {
    ok: true,
    project: key,
    name: presentation.name?.value ?? null,
    archived: presentation.archived?.value ?? false,
    codexCloudEnvironmentId: codexCloudEnvironmentId(key),
    pipelineStageRuntime: pipelineStageRuntime(key),
    agentMemoryMaxBytes: projectAgentMemoryMax(key),
    mergeOnReview: mergeOnReviewSetting(key),
    bridgeReports: bridgeReportsSetting(key),
    reportTelegram: choice,
    reportDestination: effectiveReportTelegram(key),
    reportChatTitle: viewerReportChatTitle(choice?.chat ?? null),
    postableChats: postable.length,
    reportNameSuggestion: repositoryReportName(key),
    github: githubRepositoryOfRemote(recordedProjectRemote(key)),
  };
}

function projectParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function workspaceGET(request: NextRequest): Promise<NextResponse> {
  const project = projectParam(request.nextUrl.searchParams.get("project"));
  if (!project || project.length > 256) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project is required" }, { status: 400, headers });
  }
  return NextResponse.json(answer(project), { headers });
}

/** The operator's switches, either or both in one write, and the Telegram
    report destination. Agents read the
    settings (get_orchestrator, list_pipelines) and have no write path (§9). */
async function workspacePUT(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const project = projectParam(record?.project);
  const merge = record?.mergeOnReview;
  const bridge = record?.bridgeReports;
  const cloud = record?.codexCloudEnvironmentId;
  const stageRuntime = record?.pipelineStageRuntime;
  const memory = record?.agentMemoryMaxBytes;
  const name = record?.name;
  const archived = record?.archived;
  if (!validAgentMemoryMax(memory)) return NextResponse.json({ error: "INVALID_REQUEST", message: "agentMemoryMaxBytes must be null or integer bytes from 1 GiB through 1 TiB" }, { status: 400, headers });
  const telegram = record?.reportTelegram;
  const telegramShape = telegram === undefined || telegram === null || (
    typeof telegram === "object" && !Array.isArray(telegram)
    && ((typeof (telegram as Record<string, unknown>).chat === "string" && !!((telegram as Record<string, unknown>).chat as string).trim())
      !== (typeof (telegram as Record<string, unknown>).link === "string" && !!((telegram as Record<string, unknown>).link as string).trim()))
    && typeof (telegram as Record<string, unknown>).name === "string" && !!((telegram as Record<string, unknown>).name as string).trim()
    && ((telegram as Record<string, unknown>).name as string).trim().length <= REPORT_NAME_MAX_CHARS
    && ((telegram as Record<string, unknown>).topicId === undefined || (Number.isSafeInteger((telegram as Record<string, unknown>).topicId) && ((telegram as Record<string, unknown>).topicId as number) > 0))
    && ((telegram as Record<string, unknown>).link === undefined || (telegram as Record<string, unknown>).topicId === undefined)
  );
  const shapeOk = (merge === undefined || typeof merge === "boolean")
    && (name === undefined || validProjectName(name))
    && (archived === undefined || typeof archived === "boolean")
    && (cloud === undefined || validCodexCloudEnvironmentId(cloud))
    && (stageRuntime === undefined || validPipelineStageRuntime(stageRuntime))
    && (bridge === undefined || typeof bridge === "boolean")
    && telegramShape
    && (name !== undefined || archived !== undefined || merge !== undefined || bridge !== undefined || telegram !== undefined || cloud !== undefined || stageRuntime !== undefined || memory !== undefined);
  if (!project || project.length > 256 || !shapeOk) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project and a valid setting are required; name must be 1-80 characters or null, archived must be boolean" }, { status: 400, headers });
  }
  if (name !== undefined || archived !== undefined) {
    const authority = requireOperatorAuthority(request);
    if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
    if (archived === true) {
      let files;
      try { files = await listFiles({ fresh: true }); }
      catch { return NextResponse.json({ error: "ACTIVITY_UNAVAILABLE", message: "could not verify project activity" }, { status: 503, headers }); }
      if (files.some(file => canonicalProject(file.project) === canonicalProject(project) && (file.proc === "running" || file.activity === "live"))) {
        return NextResponse.json({ error: "PROJECT_ACTIVE", message: "a running project cannot be archived" }, { status: 409, headers });
      }
    }
    const scope = requestWorkspaceScope(request);
    if (!requireOperatorAuthority(request).ok || (scope && (!scope.canAct(project) || !["owner", "manager"].includes(scope.access(project))))) {
      return NextResponse.json({ error: "project access changed", code: "workspace_denied" }, { status: 403, headers });
    }
  }
  if (cloud !== undefined || stageRuntime !== undefined) {
    const authority = requireOperatorAuthority(request);
    if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
  }
  /* The Telegram destination decides where a public post goes, so only the
     operator sets it, and only to a chat the bot may post in (§5.6). */
  if (memory !== undefined) {
    const authority = requireOperatorAuthority(request);
    if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
  }
  if (telegram !== undefined) {
    const authority = requireOperatorAuthority(request);
    if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
    if (telegram !== null) {
      const input = telegram as { chat?: string; link?: string; name: string; topicId?: number };
      const parsed = input.link ? parseTelegramChatReference(input.link) : null;
      if (input.link && !parsed) return NextResponse.json({ error: "INVALID_CHAT_REFERENCE", message: "enter a chat ID, @username or Telegram link" }, { status: 400, headers });
      const reference = parsed?.chat ?? input.chat!.trim();
      let match: { chat?: string; chatId: string; alias: string | null; username?: string | null; isForum?: boolean; postAllowed: boolean } | undefined;
      const service = telegramBotService();
      try {
        match = service.listChats().chats.find((entry) => (
          entry.chat === reference || entry.chatId === reference || entry.alias === reference
          || (reference.startsWith("@") && entry.username?.toLowerCase() === reference.slice(1).toLowerCase())
        ));
      } catch {
        // No connected bot or no known postable chat.
      }
      if (input.link || (!match && (/^-?\d+$/.test(reference) || reference.startsWith("@")))) {
        try {
          const added = await service.addChat(reference);
          match = added.status.chats.find((entry) => entry.chatId === added.chatId);
        } catch (error) {
          if (error instanceof TelegramBotError) {
            const statuses: Record<string, number> = { bot_not_in_chat: 409, chat_unknown: 404, rate_limited: 429, network_failed: 503 };
            return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status: statuses[error.code] ?? 409, headers });
          }
          return NextResponse.json({ error: "TELEGRAM_FAILED", message: "could not verify the chat with Telegram" }, { status: 503, headers });
        }
      }
      if (!match?.postAllowed) return NextResponse.json({ error: "CHAT_NOT_ALLOWED", message: "the bot is not in that chat or posting is not allowed" }, { status: 409, headers });
      const topicId = match.isForum ? (input.topicId ?? parsed?.topicId) : undefined;
      const written = setReportTelegram(project, { chat: match.alias ?? match.chat ?? match.chatId, name: input.name.trim(), ...(topicId ? { topicId } : {}) }, "operator");
      if (written === false) return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
    } else {
      if (setReportTelegram(project, null, "operator") === false) return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
    }
  }
  if ((typeof merge === "boolean" && !setMergeOnReview(project, merge, "operator"))
    || (typeof cloud === "string" && !setCodexCloudEnvironmentId(project, cloud))
    || (validPipelineStageRuntime(stageRuntime) && !setPipelineStageRuntime(project, stageRuntime))
    || (typeof bridge === "boolean" && !setBridgeReports(project, bridge, "operator"))
    || (memory !== undefined && !setProjectAgentMemoryMax(project, memory))) {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
  }
  if (name !== undefined || archived !== undefined) {
    const actor = teamActor(request);
    const key = canonicalProject(project);
    const root = name === null ? projectCurationSnapshot().manualProjects.find(row => canonicalProject(row.project) === key)?.root
      ?? lastScannedProjectCatalog()?.find(row => canonicalProject(row.project) === key)?.projectRoot : undefined;
    try {
      await setProjectPresentation(key, { ...(name !== undefined ? { name: name as string | null } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}), ...(root ? { folderName: path.basename(root) } : {}) },
      actor.kind === "member" ? actor.memberId : "operator", () => {
        const scope = requestWorkspaceScope(request);
        if (!requireOperatorAuthority(request).ok || (scope && (!scope.canAct(key) || !["owner", "manager"].includes(scope.access(key))))) throw new Error("PROJECT_ACCESS_CHANGED");
      });
    } catch (error) {
      if (error instanceof Error && error.message === "PROJECT_ACCESS_CHANGED") return NextResponse.json({ error: "project access changed", code: "workspace_denied" }, { status: 403, headers });
      return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the project presentation" }, { status: 500, headers });
    }
    if (name !== undefined) recordTeamEvent({ actor, action: "project.renamed", project: key });
    if (archived !== undefined) recordTeamEvent({ actor, action: archived ? "project.archived" : "project.unarchived", project: key });
  }
  /* The runner reads the merge setting on the controller's cycle, so a cycle
     now cancels at once any merge that only waits when the switch went off. */
  if (typeof merge === "boolean") requestPipelineTick();
  return NextResponse.json(answer(project), { headers });
}

export const GET = workspaceRoute("/api/projects/settings", workspaceGET);

export const PUT = workspaceRoute("/api/projects/settings", workspacePUT);
