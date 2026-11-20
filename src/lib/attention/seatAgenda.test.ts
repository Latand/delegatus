import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { patchTask } from "@/lib/tasks/commands";
import type { FileEntry } from "@/lib/types";

import { seatAgendaAsks } from "./seatAgenda";
import { laneRouteKey } from "@/lib/attention/routeTypes";

/*
 * docs/design/attention-auto-resolve.md, acceptance 3: the seat is told what
 * each routed wait asks, in the asker's words, and the tool that answers it
 * where it asked, so the answer goes back to the asking conversation or lane.
 */

const now = Date.parse("2026-10-11T12:00:00Z") / 1000;
const at = new Date((now - 600) * 1000).toISOString();

const worker = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  root: "claude-projects", name, path: `/t/${name}.jsonl`, project: "project-a", title: `${name} work`, kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 600, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  conversationId: `conversation_${name}`,
  durableLineage: { kind: "spawn", role: "deployer", depth: 1, parentConversationId: "conversation_seat", reviewsConversationId: null, memberships: [] },
  ...extra,
}) as FileEntry;

test("a routed prose ask names the question, the conversation to answer and how to escalate", () => {
  const asking = worker("deployer", {
    operatorAsk: { id: "ask-1", messageAt: (now - 600) * 1000, gist: "Roll out to production now?", state: "open" } as FileEntry["operatorAsk"],
    attentionRoute: { key: "reason:ask-1", owner: "seat", seat: "conversation_seat" },
  });
  const unrouted = worker("other", { operatorAsk: { id: "ask-2", messageAt: (now - 600) * 1000, gist: "Anything?", state: "open" } as FileEntry["operatorAsk"] });
  const elsewhere = worker("elsewhere", { project: "project-b", operatorAsk: { id: "ask-3", messageAt: (now - 600) * 1000, gist: "Else?", state: "open" } as FileEntry["operatorAsk"],
    attentionRoute: { key: "reason:ask-3", owner: "seat", seat: "conversation_other_seat" } });
  const [line, ...rest] = seatAgendaAsks({ files: [asking, unrouted, elsewhere], pipelines: [] }, now, "project-a");
  expect(rest).toEqual([]);
  expect(line).toMatchObject({ key: "reason:ask-1", id: "conversation_deployer" });
  expect(line!.label).toContain("deployer asks: «Roll out to production now?»");
  expect(line!.label).toContain("send_message to conversation_deployer");
  expect(line!.label).toContain('dismiss_attention escalate {reviewId} with target {kind:"conversation", conversationId:"conversation_deployer", reasonId:"ask-1"}');
});

test("a routed lane names the stage's own question, the decision answer path and the form to escalate through", () => {
  const lane = {
    id: "lane", task: "Fix the panel", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: "stage verdict: needs_decision",
    stages: [{ id: "diagnose", kind: "run" }], cursor: { stageId: "diagnose" },
    runs: [{ stageId: "diagnose", attempts: [{ n: 1, state: "needs_decision", verdict: { status: "needs_decision" },
      report: { verdict: { status: "needs_decision" }, summary: "Keep the current behaviour or switch? I recommend switching." } }] }],
    attentionRoute: { key: "lane:lane:lane-decision:none", owner: "seat", seat: "conversation_seat" },
  } as unknown as Pipeline;
  const [line] = seatAgendaAsks({ files: [], pipelines: [lane] }, now, "project-a");
  expect(line).toMatchObject({ key: "lane:lane:lane-decision:none", id: "lane" });
  expect(line!.label).toContain("stage diagnose asks «Keep the current behaviour or switch? I recommend switching.»");
  expect(line!.label).toContain("pipeline_action resolve-decision");
});

test.each(["fail-edge budget exhausted after 2 round(s)", "round limit reached"])("a failed visual gate with %s gets review advice", (detail) => {
  const lane = {
    id: "visual", task: "Check the panel", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: detail,
    stages: [{ id: "visual-critic", kind: "run" }], cursor: { stageId: "visual-critic" },
    runs: [{ stageId: "visual-critic", attempts: [{ n: 1, state: "failed", verdict: { status: "fail" },
      report: { verdict: { status: "fail" }, summary: "The panel clips its controls." } }] }],
    attentionRoute: { key: "lane:visual:lane-decision:none", owner: "seat", seat: "conversation_seat" },
  } as unknown as Pipeline;
  const [line] = seatAgendaAsks({ files: [], pipelines: [lane] }, now, "project-a");
  expect(line!.label).toStartWith("[review]");
  expect(line!.label).toContain("retained review");
  expect(line!.label).toContain("pipeline_action close");
  expect(line!.label).not.toContain("resolve-decision");
  expect(line!.label).not.toContain("retry-stage");
  expect(line!.label).not.toContain("asks");
});

/* docs/design/calm-task-cards-build.md §7.2: a stopped merge's step follows
   its class, since a retry of a closed or missing PR stops again at once. */
const mergeLane = (id: string, reason: string): Pipeline => ({
  id, task: `Merge ${id}`, project: "project-a", state: "completed", createdAt: at, stateDetail: null, stages: [], cursor: null, runs: [],
  merge: { state: "blocked", reason, blockedAt: at, updatedAt: at },
  attentionRoute: { key: `lane:${id}:merge:${at}`, owner: "seat", seat: "conversation_seat" },
}) as unknown as Pipeline;

test("each stopped merge's class gets its own step, and the line names the class first", () => {
  const lanes = [
    mergeLane("closed", "the PR was closed"),
    mergeLane("nopr", "no pull request is linked to this lane; open or attach its PR, then try the merge again"),
    mergeLane("off", "the project's merge setting was turned off"),
    mergeLane("conflict", "conflict with the base branch"),
    mergeLane("moving", "main keeps moving"),
    mergeLane("red", 'check "build" failed'),
    mergeLane("slow", "checks did not finish in 90 min"),
    mergeLane("draft", "the PR is a draft"),
  ];
  const labels = new Map(seatAgendaAsks({ files: [], pipelines: lanes }, now, "project-a").map((item) => [item.id, item.label] as const));
  for (const id of ["closed", "nopr", "off"]) {
    expect(labels.get(id)).toStartWith("[merge] ");
    expect(labels.get(id)).toContain(`dismiss_attention target {kind:"pipeline", pipelineId:"${id}"} and a one-line reason`);
    expect(labels.get(id)).not.toContain("retry-merge");
  }
  for (const id of ["conflict", "moving"]) expect(labels.get(id)).toContain("merges current main into this branch, resolves the conflict and has one review of the resolution, then pipeline_action retry-merge");
  for (const id of ["red", "slow"]) expect(labels.get(id)).toContain("pipeline_action retry-merge to re-read required checks");
  expect(labels.get("draft")).toContain("repair it and pipeline_action retry-merge");
});

test("a parked lane's line names its stop class before the stage's words", () => {
  const lane = {
    id: "commit", task: "Ship the panel", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: "stage failed",
    stages: [{ id: "build", kind: "run" }], cursor: { stageId: "build" },
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", error: "committing the passed stage: fatal: unable to write new index file" }] }],
    attentionRoute: { key: "lane:commit:lane-decision:none", owner: "seat", seat: "conversation_seat" },
  } as unknown as Pipeline;
  const [line] = seatAgendaAsks({ files: [], pipelines: [lane] }, now, "project-a");
  expect(line!.label).toStartWith("[commit] Ship the panel — stage build pipeline_action retry-stage;");
  expect(line!.label).toContain("pipeline_action retry-stage");
  expect(line!.label).not.toContain("resolve-decision");
});

test("only the successor delivery owner asks for a shared PR merge", () => {
  const old = mergeLane("old", "conflict with the base branch");
  const olderWithoutMerge = mergeLane("older-without-merge", "conflict with the base branch");
  const owner = mergeLane("owner", "conflict with the base branch");
  const target = { repository: "repo-fixture", remote: "", branch: "review", pr: 7 };
  old.delivery = { target, disposition: "owner", active: false, publish: "disabled", ownerId: old.id, epoch: 1, journal: [] };
  olderWithoutMerge.merge = undefined;
  olderWithoutMerge.delivery = { target, disposition: "owner", active: false, publish: "disabled", ownerId: olderWithoutMerge.id, epoch: 0, journal: [] };
  owner.delivery = { target, disposition: "owner", active: false, publish: "disabled", ownerId: owner.id, epoch: 2, journal: [] };
  expect(seatAgendaAsks({ files: [], pipelines: [old, olderWithoutMerge, owner] }, now, "project-a").map(ask => ask.id)).toEqual([owner.id]);
  owner.dismissedAt = new Date(now * 1000).toISOString();
  expect(seatAgendaAsks({ files: [], pipelines: [old, olderWithoutMerge, owner] }, now + 60, "project-a")).toEqual([]);
  const later = new Date((now + 120) * 1000).toISOString();
  owner.merge!.blockedAt = later;
  owner.attentionRoute!.key = `lane:owner:merge:${later}`;
  expect(seatAgendaAsks({ files: [], pipelines: [old, olderWithoutMerge, owner] }, now + 180, "project-a").map(ask => ask.id)).toEqual([owner.id]);
});

test("Waiting tasks travel by their task ask, lane ask or pause reminder", () => {
  const held = (id: string, kind: "external" | "operator" | "postponed", project = "project-a"): BoardTask => ({
    id, project, status: "blocked", text: `Check ${id}`, placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    hold: { kind, since: at, by: "agent", note: "Fixture wait" },
  });
  const includes = [
    held("unowned", "external"), held("operator", "operator"), held("dated", "postponed"),
    held("with-merge", "external"), held("with-pause", "external"), held("elsewhere", "external", "project-b"),
  ];
  const merge = { ...mergeLane("merge", "checks did not finish in 90 min"), taskIds: ["with-merge"], closedAt: at };
  const pause = { ...mergeLane("pause", ""), taskIds: ["with-pause"], attentionRoute: undefined, merge: undefined,
    state: "paused" as const, pausedAt: new Date(now * 1000 - 86_400_000).toISOString() };
  const waits = new Map<string, string[]>();
  const asks = seatAgendaAsks({ files: [], pipelines: [merge, pause], tasks: includes }, now, "project-a", waits);
  expect(asks.map(ask => ask.id).sort()).toEqual(["merge", "unowned"]);
  expect(asks.find(ask => ask.id === "unowned")).toMatchObject({
    key: expect.stringMatching(/^task:unowned:unowned:/), waitingTaskIds: ["unowned"],
    label: expect.stringContaining("«Check unowned» (task unowned)"),
  });
  const mergeAsk = asks.find(ask => ask.id === "merge")!;
  expect(mergeAsk.label).toContain("with-merge");
  expect(mergeAsk.label).toContain("pipeline_action retry-merge");
  expect(mergeAsk.key).not.toBe(seatAgendaAsks({ files: [], pipelines: [merge] }, now, "project-a")[0]!.key);
  expect([...waits]).toEqual([["pause", ["with-pause"]]]);
});

test("lane handoffs page every linked task and retain a task moved to Inbox", () => {
  const tasks: BoardTask[] = Array.from({ length: 5 }, (_, i) => ({
    id: `waiting-${i + 1}`, project: "project-a", text: `Resume ${i + 1}`,
    status: i === 4 ? "inbox" : "blocked", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    hold: { kind: "external", by: "agent", since: at, note: "Parked publication" },
  }));
  const lane = { ...mergeLane("publication", "a publication reason"), taskIds: tasks.map(task => task.id) };
  const asks = seatAgendaAsks({ files: [], pipelines: [lane], tasks }, now, "project-a");
  expect(asks).toHaveLength(2);
  expect(asks.map(ask => ask.waitingTaskIds).flat()).toEqual(tasks.map(task => task.id));
  expect(asks.map(ask => ask.label).join(" ")).toContain("waiting-5");
  expect(asks.every(ask => ask.label.includes("pipeline_action retry-merge"))).toBe(true);
});

test("a completed closed merge keeps the task and retry action together on its wake", () => {
  const task: BoardTask = { id: "task-merge", project: "project-a", text: "Publish the change", status: "blocked",
    placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    hold: { kind: "external", by: "agent", since: at, note: "Waiting for merge" } };
  const lane = { ...mergeLane("engine-completed", "checks did not finish"), taskIds: [task.id], closedAt: at };
  const [ask] = seatAgendaAsks({ files: [], pipelines: [lane], tasks: [task] }, now, "project-a");
  expect(ask).toMatchObject({ id: lane.id, waitingTaskIds: [task.id] });
  expect(ask!.label).toContain(task.id);
  expect(ask!.label).toContain("pipeline_action retry-merge");
});

test("a long returned-round lane wake keeps retry-stage and every task id before explanatory text", () => {
  const ids = [1, 2, 3, 4].map(number => `waiting-task-fixture-with-long-id-0${number}`);
  const tasks = ids.map(id => ({ id, project: "project-a", text: "Retry publication", status: "blocked" as const, placement: "unplaced" as const,
    assignments: [], createdAt: at, updatedAt: at, hold: { kind: "external" as const, note: "Publication parked", since: at, by: "agent" as const } }));
  const effectiveRole = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const attentionRoute = { key: "", owner: "seat" as const, seat: "conversation_seat", returnedFrom: "round-returned-12345678901234567890" };
  const long: Pipeline = { ...mergeLane("publication", "stage failed"), state: "needs_decision", taskIds: ids,
    stages: [{ id: "publish", kind: "run", prompt: "Publish", next: null, effectiveRole }],
    cursor: { stageId: "publish", state: "running", input: null, activatedBy: null },
    runs: [{ stageId: "publish", attempts: [{ n: 1, state: "failed", error: "stage failed", effectiveRole,
      launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: at, completedAt: at, input: null, activatedBy: null, output: null, verdict: null }] }],
    attentionRoute };
  attentionRoute.key = laneRouteKey(long, "lane-decision");
  const ask = seatAgendaAsks({ files: [], pipelines: [long], tasks }, now, "project-a").find(item => item.id === "publication")!;
  expect(ask.waitingTaskIds).toEqual(ids);
  expect(ask.label).toContain("pipeline_action retry-stage");
  for (const id of ids) expect(ask.label).toContain(id);
});

test("the maintenance hold resend write leaves a named task action on the next seat agenda", () => {
  const task: BoardTask = { id: "moved-task", project: "project-a", text: "Resume publication", status: "blocked",
    placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    hold: { kind: "external", by: "agent", since: at, note: "Parked publication" } };
  const moved = patchTask([task], task.id, { hold: task.hold }, at, { actor: "agent" });
  if (!moved.ok) throw new Error(moved.error);
  const lane = { ...mergeLane("publication", "checks did not finish"), taskIds: [task.id] };
  const [ask] = seatAgendaAsks({ files: [], pipelines: [lane], tasks: [moved.task] }, now, "project-a");
  expect(moved.task.status).toBe("inbox");
  expect(ask).toMatchObject({ id: lane.id, waitingTaskIds: [task.id] });
  expect(ask!.label).toContain(`Waiting task(s) ${task.id}`);
  expect(ask!.label).toContain("pipeline_action retry-merge");
});

test("an archived merged lane still routes its task to build acceptance", () => {
  const task: BoardTask = { id: "archived-task", project: "project-a", text: "Verify deployment", status: "blocked",
    placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    hold: { kind: "external", by: "agent", since: at, note: "Check the build" } };
  const lane = { ...mergeLane("archived-lane", ""), state: "completed" as const,
    merge: { state: "merged", updatedAt: at } as Pipeline["merge"], hiddenAt: at, taskIds: [task.id] };
  const [ask] = seatAgendaAsks({ files: [], pipelines: [lane], tasks: [task] }, now, "project-a");
  expect(ask).toMatchObject({ id: task.id, waitingTaskIds: [task.id] });
  expect(ask!.label).toContain("deployment_status");
  expect(ask!.label).toContain(task.id);
});
