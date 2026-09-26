import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { canonicalProject, recordedProjectRemote } from "@/lib/projects/aliases";
import { viewerPostableReportChats, viewerReportChatTitle } from "@/lib/projects/reportDestination";
import {
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
import { telegramBotService } from "@/lib/telegram/bot/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** What the board's setting rows draw (#2187 §6, #2146): the settings, and
    whether the project has a GitHub repository to merge in at all. */
export interface ProjectSettingsResponse {
  ok: true;
  project: string;
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
  const postable = viewerPostableReportChats();
  const choice = reportTelegramChoice(key);
  return {
    ok: true,
    project: key,
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const project = projectParam(request.nextUrl.searchParams.get("project"));
  if (!project || project.length > 256) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project is required" }, { status: 400, headers });
  }
  return NextResponse.json(answer(project), { headers });
}

/** The operator's switches, either or both in one write, and the Telegram
    report destination. Agents read the
    settings (get_orchestrator, list_pipelines) and have no write path (§9). */
export async function PUT(request: NextRequest): Promise<NextResponse> {
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
  const telegram = record?.reportTelegram;
  const telegramShape = telegram === undefined || telegram === null || (
    typeof telegram === "object" && !Array.isArray(telegram)
    && typeof (telegram as Record<string, unknown>).chat === "string" && !!((telegram as Record<string, unknown>).chat as string).trim()
    && typeof (telegram as Record<string, unknown>).name === "string" && !!((telegram as Record<string, unknown>).name as string).trim()
    && ((telegram as Record<string, unknown>).name as string).trim().length <= REPORT_NAME_MAX_CHARS
  );
  const shapeOk = (merge === undefined || typeof merge === "boolean")
    && (bridge === undefined || typeof bridge === "boolean")
    && telegramShape
    && (merge !== undefined || bridge !== undefined || telegram !== undefined);
  if (!project || project.length > 256 || !shapeOk) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project and mergeOnReview or bridgeReports (boolean), or reportTelegram ({ chat, name } or null), are required" }, { status: 400, headers });
  }
  /* The Telegram destination decides where a public post goes, so only the
     operator sets it, and only to a chat the bot may post in (§5.6). */
  if (telegram !== undefined) {
    const authority = requireOperatorAuthority(request);
    if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
    if (telegram !== null) {
      const chat = ((telegram as Record<string, unknown>).chat as string).trim();
      let allowed = false;
      try {
        allowed = telegramBotService().listChats().chats.some((entry) => entry.postAllowed && (entry.chat === chat || entry.alias === chat));
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return NextResponse.json({ error: "CHAT_NOT_ALLOWED", message: "the bot may not post in that chat; allow it in the bot panel first" }, { status: 409, headers });
      }
    }
    const written = setReportTelegram(project, telegram === null ? null : {
      chat: ((telegram as Record<string, unknown>).chat as string).trim(),
      name: ((telegram as Record<string, unknown>).name as string).trim(),
    }, "operator");
    if (written === false) {
      return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
    }
  }
  if ((typeof merge === "boolean" && !setMergeOnReview(project, merge, "operator"))
    || (typeof bridge === "boolean" && !setBridgeReports(project, bridge, "operator"))) {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
  }
  /* The runner reads the merge setting on the controller's cycle, so a cycle
     now cancels at once any merge that only waits when the switch went off. */
  if (typeof merge === "boolean") requestPipelineTick();
  return NextResponse.json(answer(project), { headers });
}
