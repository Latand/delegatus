import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { parsePrototypeInput, PrototypeError } from "./input";
import { publishPrototype } from "./store";
import { operatorDecisionRound, operatorDecisions, readPrototypeReviews, readSeatRounds } from "./read";
import { findSeatRound } from "./seatRounds";
import { loadTasks } from "@/lib/tasks/store";
import { decidePrototype, refreshPrototypeDelivery, prototypeDelivery, type PrototypeDelivery } from "./decision";
import { prototypeWorld, taskForPrototype, type PrototypeCaller, type PrototypeWorld } from "./world";
import type { DecidePrototypeInput } from "./types";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { runsElsewhere } from "@/lib/links/linked";
import { canonicalProject } from "@/lib/projects/aliases";

export function prototypeFailure(error: unknown): NextResponse {
  return NextResponse.json({ error: error instanceof PrototypeError ? error.message : "prototype review is unavailable" }, { status: error instanceof PrototypeError ? error.status : 503 });
}
/** The project whose designated orchestrator is calling, or null. Only that
    seat may ask without a task (docs/design/operator-decision-forms.md §2.1). */
function seatProject(caller: PrototypeCaller,world: PrototypeWorld): string | null {
  return caller.conversationId && caller.project && world.orchestrator(caller.project) === caller.conversationId ? caller.project : null;
}
/** The task a review read is about: the one named, or the caller's pipeline's
    own. A seat that names none reads its own questions (`taskId: null`). */
function readTarget(request: NextRequest,named: unknown,world: PrototypeWorld): { caller: PrototypeCaller; taskId: string | null; seat?: string } {
  const caller = world.caller(request);
  const stage = caller.conversationId ? world.stage(caller.conversationId) : null;
  const taskId = named ?? (stage?.taskIds.length === 1 ? stage.taskIds[0] : null);
  const seat = !stage && named === undefined ? seatProject(caller,world) : null;
  if (seat) return { caller, taskId: null, seat };
  if (typeof taskId !== "string" || !taskId) throw new PrototypeError("taskId is required outside a pipeline bound to one task; a project's orchestrator may omit it to read its own questions");
  taskForPrototype(taskId,caller);
  return { caller, taskId };
}
/** The task a publication lands on, with every fence a publication passes.
    The project's orchestrator naming no task asks in its own conversation. */
function publicationTarget(request: NextRequest,named: string | undefined,world: PrototypeWorld): { caller: PrototypeCaller; stage: ReturnType<PrototypeWorld["stage"]>; taskId: string | null; seat?: string } {
  const caller = world.caller(request);
  const stage = caller.conversationId ? world.stage(caller.conversationId) : null;
  const seat = !stage && !named ? seatProject(caller,world) : null;
  if (seat) return { caller, stage, taskId: null, seat };
  const taskId = stage ? stage.taskIds[0] : named;
  if (!taskId || (stage && stage.taskIds.length !== 1)) throw new PrototypeError("publication needs exactly one task; a pipeline caller inherits its pipeline's task, and only a project's orchestrator may ask without one");
  if (stage && named && named !== taskId) throw new PrototypeError("pipeline publication is bound to its own task",403);
  const task = taskForPrototype(taskId,caller,true);
  if (stage && canonicalProject(stage.project) !== canonicalProject(task.project)) throw new PrototypeError("pipeline and task projects differ",403);
  return { caller, stage, taskId };
}
/** Who is asking and about which task, decided exactly as the publication or
    the read itself decides it. The MCP service keys a receipt by this answer
    and asks again before every replay, so a receipt is only ever answered to
    the caller and the task it was made for. */
export async function reviewScopePOST(request: NextRequest,world: PrototypeWorld = prototypeWorld): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || (body.mode !== "publish" && body.mode !== "read")) throw new PrototypeError("invalid scope request");
    if (body.taskId !== undefined && (typeof body.taskId !== "string" || !body.taskId)) throw new PrototypeError("invalid taskId");
    const target = body.mode === "publish" ? publicationTarget(request,body.taskId,world) : readTarget(request,body.taskId,world);
    if (!target.caller.conversationId) throw new PrototypeError("caller could not be identified",403);
    return NextResponse.json({ conversationId: target.caller.conversationId, taskId: target.taskId },{ headers: { "cache-control": "private, no-store" } });
  } catch (error) { return prototypeFailure(error); }
}
export async function reviewReadPOST(request: NextRequest,world: PrototypeWorld = prototypeWorld): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  try {
    const body = await request.json();
    const target = readTarget(request,body?.taskId,world);
    if (target.taskId === null) return NextResponse.json(readSeatRounds(target.seat!),{ headers: { "cache-control": "private, no-store" } });
    return reviewGET(request,target.taskId,world);
  } catch (error) { return prototypeFailure(error); }
}
export async function publishPOST(request: NextRequest,world: PrototypeWorld = prototypeWorld): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    const input = parsePrototypeInput(await request.json());
    const { caller, stage, taskId, seat } = publicationTarget(request,input.taskId,world);
    if (taskId === null && !input.questions?.length) throw new PrototypeError("a decision asked without a task is a form: give it 1–7 questions");
    const round = await publishPrototype(input,taskId,stage?.source ?? { conversationId: caller.conversationId },seat);
    return NextResponse.json({ reviewId: round.id, taskId, project: round.project, title: round.title, variants: round.variants.length,
      ...(round.questions ? { questions: round.questions.length } : {}),
      frames: round.variants.reduce((n,v) => n + v.frames.length,0), videos: round.variants.reduce((n,v) => n + v.videos.length,0) });
  } catch (error) { return prototypeFailure(error); }
}
export async function reviewGET(request: NextRequest,taskId: string,world: PrototypeWorld = prototypeWorld,delivery: PrototypeDelivery = prototypeDelivery): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    const caller = world.caller(request);
    let task = taskForPrototype(taskId,caller);
    // Remote installations only read the replicated decision; they cannot drive its delivery.
    if (!runsElsewhere(task)) {
      for (const round of task.prototypeReviews ?? []) await refreshPrototypeDelivery(taskId,round.id,delivery);
      task = taskForPrototype(taskId,caller);
    }
    return NextResponse.json(readPrototypeReviews(task),{ headers: { "cache-control": "private, no-store" } });
  } catch (error) { return prototypeFailure(error); }
}
export async function reviewPOST(request: NextRequest,taskId: string,world: PrototypeWorld = prototypeWorld,delivery: PrototypeDelivery = prototypeDelivery): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const operator = directOperatorActivityAuthority(request);
  if (!operator.ok || request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) return NextResponse.json({ error: "only the operator may decide prototypes" },{ status: 403 });
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    const caller = world.caller(request);
    if (caller.conversationId) throw new PrototypeError("only the operator may decide prototypes",403);
    taskForPrototype(taskId,caller,true);
    const body = await request.json() as DecidePrototypeInput | { reviewId: string; retry: true };
    if (!body || typeof body !== "object" || typeof body.reviewId !== "string" || ("retry" in body && body.retry !== true)) throw new PrototypeError("invalid decision");
    await decidePrototype(request,taskId,body,world,delivery);
    return NextResponse.json(readPrototypeReviews(taskForPrototype(taskId,caller)),{ headers: { "cache-control": "private, no-store" } });
  } catch (error) { return prototypeFailure(error); }
}

/** The operator's own read of a project's open decisions: the «Рішення»
    column (docs/design/operator-decision-forms.md). An agent reads its
    project's rounds through read_prototype_review instead. */
export async function decisionsGET(request: NextRequest,project: string,world: PrototypeWorld = prototypeWorld,review: string | null = null): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    if (!project) throw new PrototypeError("project is required");
    const caller = world.caller(request);
    if (caller.conversationId && (!caller.project || canonicalProject(caller.project) !== canonicalProject(project))) throw new PrototypeError("prototype access is limited to the caller's project",403);
    return NextResponse.json({ ...operatorDecisions(project), ...(review ? { round: operatorDecisionRound(project,review) } : {}) },{ headers: { "cache-control": "private, no-store" } });
  } catch (error) { return prototypeFailure(error); }
}
/** One answer from the column: a seat's question or a task's waiting round,
    found by its id within the project, decided through the same decision path
    as the review window. The answer is the column's next read. */
export async function decisionsPOST(request: NextRequest,world: PrototypeWorld = prototypeWorld,delivery: PrototypeDelivery = prototypeDelivery): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request); if (rejected) return rejected;
  const operator = directOperatorActivityAuthority(request);
  if (!operator.ok || request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) return NextResponse.json({ error: "only the operator may decide prototypes" },{ status: 403 });
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    const caller = world.caller(request);
    if (caller.conversationId) throw new PrototypeError("only the operator may decide prototypes",403);
    const raw = await request.json() as (DecidePrototypeInput | { reviewId: string; retry: true }) & { project?: unknown };
    if (!raw || typeof raw !== "object" || typeof raw.project !== "string" || !raw.project || typeof raw.reviewId !== "string" || ("retry" in raw && raw.retry !== true)) throw new PrototypeError("invalid decision");
    const { project, ...body } = raw;
    const key = canonicalProject(project);
    const seat = findSeatRound(body.reviewId);
    let taskId: string | null = null;
    if (seat) {
      if (canonicalProject(seat.project) !== key) throw new PrototypeError("review not found",404);
    } else {
      const task = loadTasks().find(t => canonicalProject(t.project) === key && t.prototypeReviews?.some(r => r.id === body.reviewId));
      if (!task) throw new PrototypeError("review not found",404);
      taskId = taskForPrototype(task.id,caller,true).id;
    }
    await decidePrototype(request,taskId,body,world,delivery);
    return NextResponse.json(operatorDecisions(key),{ headers: { "cache-control": "private, no-store" } });
  } catch (error) { return prototypeFailure(error); }
}
