import { NextResponse, type NextRequest } from "next/server";

import { catalogProjectNames } from "@/lib/activity/report";
import { crossOrigin, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { memberSummary } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 60;
/* The work people did, which is what "who did what" is asked for; the
   account housekeeping (sign-ins, invites, passkeys) is one choice away. */
const WORK_ACTIONS = ["message.sent", "question.answered", "agent.started", "task.created", "task.changed"] as const;

/** Who did what (§6.8), newest first: `?member=&project=&before=&scope=work|all`
    (work by default). The
    answer names each actor once in `actors`, so a rename reads everywhere. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const params = req.nextUrl.searchParams;
    const events = authed.store.events({
      before: params.get("before"),
      memberId: params.get("member"),
      project: params.get("project"),
      actions: params.get("scope") === "all" ? null : WORK_ACTIONS,
      limit: PAGE + 1,
    });
    const page = events.slice(0, PAGE);
    const members = authed.store.members().map(memberSummary);
    const projects = authed.store.eventProjects();
    /* Projects are named the way the Activity dashboard names them. */
    const names = await catalogProjectNames().catch(() => new Map<string, string>());
    return teamJson({
      events: page,
      members,
      projects,
      projectNames: Object.fromEntries(projects.flatMap((project) => (names.get(project) ? [[project, names.get(project)!]] : []))),
      nextBefore: events.length > PAGE ? page.at(-1)?.id ?? null : null,
    });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
