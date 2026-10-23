import { describe, expect, test } from "bun:test";

import type { AttentionItem, ConversationReason } from "@/components/attention";
import { buildNeedsYouQueue, type MobileAttentionEntry } from "@/components/attention/attentionQueue";
import type { MobileBoardPipelineRow } from "@/components/mobile/mobileBoardModel";
import type { DoneItemV1 } from "@/lib/done/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { FileEntry } from "@/lib/types";

import type { CueRequest } from "./cues";
import { createCuePlayer, type CueTransport, type EventStartRequest } from "./cuePlayer";
import { createFakeTimers } from "./fakeTimers.fixture";
import { createHeardKeys, planDoneCues, planNeedsYouCues, planPipelineCues, type HeardStorage } from "./workCues";

/*
 * The sources of the sound map (docs/design/sound-redesign.md §4.1–§4.3):
 * which entry, lane change or done item earns which sound, with which
 * identity, obligation and clock — and when nothing sounds at all.
 */

const NOW = Date.parse("2026-10-22T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function conversation(id: string, kind: ConversationReason["kind"], raisedSecondsAgo = 5, sinceSecondsAgo = raisedSecondsAgo): MobileAttentionEntry {
  const item = {
    id,
    project: "p",
    reason: { kind, id: `${id}:reason`, since: NOW / 1000 - sinceSecondsAgo, raisedAt: NOW / 1000 - raisedSecondsAgo, clocked: true, header: null, dismissal: null },
  } as unknown as AttentionItem;
  return { kind: "conversation", id, item };
}

function pipelineRow(id: string, seconds: number | null, taskIds: string[] = [], attempts = 1): MobileAttentionEntry {
  const pipeline = { id, taskIds, runs: [{ stageId: "review", attempts: Array.from({ length: attempts }, () => ({})) }] } as unknown as Pipeline;
  return { kind: "pipeline", id, row: { id, seconds, stageRef: { id: "review" }, pipeline } as unknown as MobileBoardPipelineRow };
}

function prototype(id: string, taskId: string | null, createdMsAgo = 5000): MobileAttentionEntry {
  return { kind: "prototype", id, notice: { id, taskId, createdAt: iso(createdMsAgo), project: "p" } as unknown as PrototypeReviewNotice };
}

function update(id: string, atMsAgo = 5000): MobileAttentionEntry {
  return { kind: "update", id: `auto-update:${id}`, decision: { id, at: iso(atMsAgo), project: "p", blockers: null } };
}

/* These cases pin each request's identity, clock and obligation. What each one
   says in its toast has its own cases at the end of the file. */
const bare = (requests: CueRequest[]) => requests.map((request) => { const { caption, ...rest } = request; void caption; return rest; });

describe("S6 and S7 read the needs-you queue (§4.1)", () => {
  const baseline = (entries: MobileAttentionEntry[] = []) => planNeedsYouCues(entries, null, "p", NOW)!;

  test("the first certified read is the baseline: nothing already waiting sounds", () => {
    const plan = baseline([conversation("c1", "question"), pipelineRow("lane-1", 3)]);
    expect(plan.requests).toEqual([]);
  });

  test("structured asks are «your move», with the entry's own clock of asking", () => {
    const plan = planNeedsYouCues([
      conversation("c-decision", "decision", 4),
      conversation("c-question", "question", 4),
      conversation("c-plan", "plan", 4),
      conversation("c-permission", "permission", 4),
    ], baseline(), "p", NOW)!;
    expect(plan.requests.map((r) => [r.cue, r.eventId, r.occurredAt, r.obligation])).toEqual([
      ["your-move", "needs-you:c-decision", NOW - 4000, "c-decision"],
      ["your-move", "needs-you:c-question", NOW - 4000, "c-question"],
      ["your-move", "needs-you:c-plan", NOW - 4000, "c-plan"],
      ["your-move", "needs-you:c-permission", NOW - 4000, "c-permission"],
    ]);
  });

  test("a stuck delivery, a failed launch and a memory kill are a fault", () => {
    const plan = planNeedsYouCues([
      conversation("c-delivery", "delivery"),
      conversation("c-launch", "launch"),
      conversation("c-memory", "memory"),
    ], baseline(), "p", NOW)!;
    expect(plan.requests.map((r) => [r.cue, r.eventId])).toEqual([
      ["fault", "needs-you:c-delivery"],
      ["fault", "needs-you:c-launch"],
      ["fault", "needs-you:c-memory"],
    ]);
  });

  test("an inferred «asks you» plays nothing, though the badge still counts it", () => {
    const plan = planNeedsYouCues([conversation("c-ask", "ask")], baseline(), "p", NOW)!;
    expect(plan.requests).toEqual([]);
    expect(plan.seen.has("c-ask")).toBe(true);
  });

  test("a stuck delivery admitted 30 minutes ago sounds from the moment it raised, never from its admission", () => {
    const plan = planNeedsYouCues([conversation("c-delivery", "delivery", 3, 30 * 60)], baseline(), "p", NOW)!;
    expect(plan.requests[0]!.occurredAt).toBe(NOW - 3000);
  });

  test("a parked lane asks from `now − seconds`, and is keyed by its task", () => {
    const plan = planNeedsYouCues([pipelineRow("lane-1", 7, ["task-9"])], baseline(), "p", NOW)!;
    expect(bare(plan.requests)).toEqual([{ cue: "your-move", eventId: "needs-you:lane-1:review:1", occurredAt: NOW - 7000, obligation: "task-9" }]);
  });

  test("a lane that parks a second time earns a new identity, and S6 sounds again after the obligation memory", () => {
    const events: EventStartRequest[] = [];
    const transport: CueTransport = { startTyping: () => null, startEvent: (request) => (events.push(request), { cut: () => undefined }) };
    const timers = createFakeTimers(NOW);
    const cues = createCuePlayer({
      transport,
      prefs: () => ({ cuesEnabled: true, cueVolume: 1, typingEnabled: true }),
      context: () => ({ hidden: false, phone: false, voiceCall: false, ownsEvents: () => true }),
      timers,
      pick: () => 0,
    });
    const park = (previous: ReturnType<typeof planNeedsYouCues>, attempts: number) => {
      const plan = planNeedsYouCues([pipelineRow("lane-1", 0, ["task-1"], attempts)], previous, "p", timers.now())!;
      for (const request of plan.requests) cues.play(request);
      timers.advance(5000);
      return plan;
    };
    const first = park(baseline(), 1);
    const left = planNeedsYouCues([], first, "p", timers.now())!;
    expect(events).toHaveLength(1);

    /* Parked again within ten minutes for the same task: silent, the obligation was heard. */
    timers.advance(2 * 60_000);
    const quick = park(left, 2);
    expect(events).toHaveLength(1);

    /* Left the queue and parks a third time more than ten minutes later: sounds. */
    const gone = planNeedsYouCues([], quick, "p", timers.now())!;
    timers.advance(60 * 60_000);
    park(gone, 3);
    expect(events).toHaveLength(2);
  });

  test("a parked lane with no clock asks from its first sighting", () => {
    const plan = planNeedsYouCues([pipelineRow("lane-2", null)], baseline(), "p", NOW)!;
    expect(plan.requests[0]).toMatchObject({ occurredAt: NOW, obligation: "lane-2" });
  });

  test("a lane and the form for the same task share one obligation key", () => {
    const plan = planNeedsYouCues([pipelineRow("lane-1", 2, ["task-9"]), prototype("review-1", "task-9")], baseline(), "p", NOW)!;
    expect(plan.requests.map((r) => r.obligation)).toEqual(["task-9", "task-9"]);
  });

  test("a seat's decision form with no task, and the update decision, are their own obligations", () => {
    const plan = planNeedsYouCues([prototype("seat-decision-1", null, 9000), update("u1", 1000)], baseline(), "p", NOW)!;
    expect(bare(plan.requests)).toEqual([
      { cue: "your-move", eventId: "needs-you:seat-decision-1", occurredAt: NOW - 9000, obligation: "seat-decision-1" },
      { cue: "your-move", eventId: "needs-you:auto-update:u1", occurredAt: NOW - 1000, obligation: "auto-update:u1" },
    ]);
  });

  test("an entry seen before stays silent on the next read", () => {
    const first = planNeedsYouCues([conversation("c1", "question")], baseline(), "p", NOW)!;
    const second = planNeedsYouCues([conversation("c1", "question")], first, "p", NOW + 4000)!;
    expect(second.requests).toEqual([]);
  });

  test("switching scope absorbs the new scope's entries silently", () => {
    const other = planNeedsYouCues([conversation("c-other", "question")], baseline(), "q", NOW)!;
    expect(other.requests).toEqual([]);
    expect(other.scope).toBe("q");
    /* …and a genuinely new entry in the new scope sounds on the next read. */
    const next = planNeedsYouCues([conversation("c-other", "question"), conversation("c-new", "permission")], other, "q", NOW)!;
    expect(next.requests.map((r) => r.eventId)).toEqual(["needs-you:c-new"]);
  });

  test("the operator's own failed launch reaches the queue and sounds once, as a fault", () => {
    /* The new-agent card plays S9 for an accepted launch only; a failed one is
       heard here, through the real queue (critique row 7). */
    const nowSeconds = NOW / 1000;
    const failed = {
      root: "claude-projects", name: "spawn:launch-1", path: "spawn:launch-1", project: "p", title: "launch", engine: "claude", kind: "session", fmt: "claude",
      parent: null, mtime: nowSeconds - 5, size: 0, activity: "idle", proc: null, pid: null, model: "opus", pendingQuestion: null,
      conversationId: "conversation_1",
      spawn: { launchId: "launch-1", clientAttemptId: "attempt-1", accountId: "default", state: "failed", initialMessage: "failed", retrySafe: true, error: "signed out", admittedAt: NOW - 3000 },
    } as unknown as FileEntry;
    const before = planNeedsYouCues(buildNeedsYouQueue([], [], nowSeconds, []), null, "p", NOW)!;
    const queue = buildNeedsYouQueue([failed], [], nowSeconds, []);
    expect(queue.map((entry) => entry.id)).toEqual(["spawn:launch-1:launch-failed"]);
    const after = planNeedsYouCues(queue, before, "p", NOW)!;
    expect(bare(after.requests)).toEqual([{ cue: "fault", eventId: "needs-you:spawn:launch-1:launch-failed", occurredAt: NOW - 3000, obligation: "spawn:launch-1:launch-failed" }]);
  });

  test("a stand-in read for a scope still loading changes nothing", () => {
    const first = baseline([conversation("c1", "question")]);
    expect(planNeedsYouCues([conversation("c2", "question")], first, "q", NOW, false)).toBe(first);
    expect(planNeedsYouCues([conversation("c2", "question")], null, "q", NOW, false)).toBeNull();
  });
});

function stage(stageId: string, attempts: Array<{ n: number; state: string; completedAt?: string; historical?: boolean }>): Pipeline["runs"][number] {
  return { stageId, attempts: attempts.map((a) => ({ completedAt: null, ...a })) } as unknown as Pipeline["runs"][number];
}

function lane(id: string, over: Partial<Pipeline> & { runs?: unknown[] } = {}): Pipeline {
  return { id, state: "running", closedAt: null, runs: [], ...over } as unknown as Pipeline;
}

describe("S3, S4 and S7 read the board's pipelines (§4.2)", () => {
  const seed = (pipelines: Pipeline[]) => planPipelineCues(pipelines, null, "p")!;

  test("the first read is the baseline", () => {
    const plan = seed([lane("a", { runs: [stage("build", [{ n: 1, state: "passed", completedAt: iso(1000) }])] })]);
    expect(plan.requests).toEqual([]);
  });

  test("an attempt entering `passed` is a step, keyed by lane, stage and attempt, on its own clock", () => {
    const before = seed([lane("a", { runs: [stage("build", [{ n: 1, state: "running" }])] })]);
    const after = planPipelineCues([lane("a", { runs: [stage("build", [{ n: 1, state: "passed", completedAt: iso(2000) }])] })], before, "p")!;
    expect(bare(after.requests)).toEqual([{ cue: "step", eventId: "step:a:build:1", occurredAt: NOW - 2000, pipeline: "a" }]);
  });

  test("a failed attempt is silent: the review loop is working", () => {
    const before = seed([lane("a", { runs: [stage("review", [{ n: 1, state: "running" }])] })]);
    const after = planPipelineCues([lane("a", { runs: [stage("review", [{ n: 1, state: "failed", completedAt: iso(1) }])] })], before, "p")!;
    expect(after.requests).toEqual([]);
  });

  test("lineage-adopted history never steps", () => {
    const before = seed([lane("a")]);
    const after = planPipelineCues([lane("a", { runs: [stage("build", [{ n: 1, state: "passed", completedAt: iso(1), historical: true }])] })], before, "p")!;
    expect(after.requests).toEqual([]);
  });

  test("a merge reaching `merged` is a landing, on `mergedAt`", () => {
    const before = seed([lane("a", { merge: { state: "queued" } as Pipeline["merge"] })]);
    const after = planPipelineCues([lane("a", { merge: { state: "merged", mergedAt: iso(3000) } as Pipeline["merge"] })], before, "p")!;
    expect(bare(after.requests)).toEqual([{ cue: "landed", eventId: "landed:a", occurredAt: NOW - 3000, pipeline: "a" }]);
  });

  test("a merged lane that then completes lands once", () => {
    const merged = planPipelineCues([lane("a", { merge: { state: "merged", mergedAt: iso(3000) } as Pipeline["merge"] })], seed([lane("a")]), "p")!;
    const completed = planPipelineCues([lane("a", { state: "completed", closedAt: iso(1000), merge: { state: "merged", mergedAt: iso(3000) } as Pipeline["merge"] })], merged, "p")!;
    expect(merged.requests.map((r) => r.eventId)).toEqual(["landed:a"]);
    expect(completed.requests).toEqual([]);
  });

  test("a lane completing with no merge to make is a landing, on `closedAt`", () => {
    const after = planPipelineCues([lane("a", { state: "completed", closedAt: iso(1500) })], seed([lane("a")]), "p")!;
    expect(bare(after.requests)).toEqual([{ cue: "landed", eventId: "landed:a", occurredAt: NOW - 1500, pipeline: "a" }]);
  });

  test("a lane completing with its merge blocked or cancelled never lands", () => {
    for (const state of ["blocked", "cancelled"] as const) {
      const before = seed([lane("a", { merge: { state: "queued" } as Pipeline["merge"] })]);
      const after = planPipelineCues([lane("a", { state: "completed", closedAt: iso(1), merge: { state, blockedAt: iso(1) } as Pipeline["merge"] })], before, "p")!;
      expect(after.requests.filter((r) => r.cue === "landed")).toEqual([]);
    }
  });

  test("a merge reaching `blocked` is a fault; `cancelled` is silent", () => {
    const before = seed([lane("a", { merge: { state: "queued" } as Pipeline["merge"] }), lane("b", { merge: { state: "queued" } as Pipeline["merge"] })]);
    const after = planPipelineCues([
      lane("a", { merge: { state: "blocked", blockedAt: iso(4000) } as Pipeline["merge"] }),
      lane("b", { merge: { state: "cancelled", blockedAt: iso(4000) } as Pipeline["merge"] }),
    ], before, "p")!;
    expect(bare(after.requests)).toEqual([{ cue: "fault", eventId: "merge-blocked:a", occurredAt: NOW - 4000 }]);
  });

  test("a lane new to this scope is compared with nothing; the staleness rule absorbs old history", () => {
    const after = planPipelineCues([lane("new", { runs: [stage("build", [{ n: 1, state: "passed", completedAt: iso(5000) }])] })], seed([]), "p")!;
    expect(after.requests.map((r) => r.eventId)).toEqual(["step:new:build:1"]);
  });

  test("switching scope absorbs every lane the new scope shows", () => {
    const after = planPipelineCues([lane("x", { state: "completed", closedAt: iso(1) })], seed([lane("a")]), "q")!;
    expect(after.requests).toEqual([]);
  });

  test("a stand-in read changes nothing", () => {
    const first = seed([lane("a")]);
    expect(planPipelineCues([lane("a", { state: "completed", closedAt: iso(1) })], first, "q", false)).toBe(first);
  });
});

function done(key: string, kind: DoneItemV1["kind"], atMsAgo: number, phase?: string): DoneItemV1 {
  return { key, kind, at: iso(atMsAgo), refs: phase ? { phase } : {} } as unknown as DoneItemV1;
}

function memoryStorage(): HeardStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

describe("S5 and the deploy and limit faults read the «Готово» feed (§4.3)", () => {
  test("a release is S5; a failed or rolled-back deploy and a limit episode are faults; the rest is silent", () => {
    const heard = createHeardKeys(memoryStorage());
    const first = planDoneCues([], null, NOW, heard);
    const plan = planDoneCues([
      done("deploy:1", "deploy", 1000, "succeeded"),
      done("deploy:2", "deploy", 1000, "failed"),
      done("deploy:3", "deploy", 1000, "rolled-back"),
      done("limit:1", "limit", 1000),
      done("pr:1", "pr", 1000),
      done("task:1", "task", 1000),
    ], first, NOW, heard);
    expect(bare(plan.requests)).toEqual([
      { cue: "released", eventId: "done:deploy:1", occurredAt: NOW - 1000, maxAgeMs: 5 * 60_000 },
      { cue: "fault", eventId: "done:deploy:2", occurredAt: NOW - 1000, maxAgeMs: 5 * 60_000 },
      { cue: "fault", eventId: "done:deploy:3", occurredAt: NOW - 1000, maxAgeMs: 5 * 60_000 },
      { cue: "fault", eventId: "done:limit:1", occurredAt: NOW - 1000 },
    ]);
  });

  test("a deploy restarts the Viewer: its fresh item sounds even on the baseline read after the reload", () => {
    const plan = planDoneCues([done("deploy:9", "deploy", 90_000, "succeeded"), done("deploy:8", "deploy", 6 * 60_000, "succeeded"), done("limit:2", "limit", 1000)], null, NOW, createHeardKeys(memoryStorage()));
    expect(plan.requests.map((r) => r.eventId)).toEqual(["done:deploy:9"]);
  });

  test("a second reload stays silent: heard keys outlive the page in sessionStorage", () => {
    const tab = memoryStorage();
    expect(planDoneCues([done("deploy:9", "deploy", 1000, "succeeded")], null, NOW, createHeardKeys(tab)).requests).toHaveLength(1);
    expect(planDoneCues([done("deploy:9", "deploy", 2000, "succeeded")], null, NOW, createHeardKeys(tab)).requests).toEqual([]);
  });

  test("the heard keys are bounded to 256, oldest out first", () => {
    const tab = memoryStorage();
    const heard = createHeardKeys(tab);
    for (let i = 0; i < 300; i++) heard.add(`k${i}`);
    const reloaded = createHeardKeys(tab);
    expect(reloaded.has("k299")).toBe(true);
    expect(reloaded.has("k44")).toBe(true);
    expect(reloaded.has("k43")).toBe(false);
  });

  test("an item seen on an earlier read stays silent", () => {
    const heard = createHeardKeys(memoryStorage());
    const first = planDoneCues([done("limit:1", "limit", 1000)], null, NOW, heard);
    expect(planDoneCues([done("limit:1", "limit", 1000)], first, NOW, heard).requests).toEqual([]);
  });

  test("unreadable session storage still plans, without memory across reloads", () => {
    const broken: HeardStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const plan = planDoneCues([done("deploy:9", "deploy", 1000, "succeeded")], null, NOW, createHeardKeys(broken));
    expect(plan.requests).toHaveLength(1);
  });
});

/*
 * What each sound's toast announces and about whom (docs/design/sound-captions.md §1):
 * the planners attach plain data, and the stack names it in the operator's language.
 */
describe("the caption each planner attaches", () => {
  const baseline = (entries: MobileAttentionEntry[] = []) => planNeedsYouCues(entries, null, "p", NOW)!;
  const captionOf = (requests: CueRequest[]) => requests.map((request) => request.caption);
  const withFile = (entry: MobileAttentionEntry, file: Partial<FileEntry>): MobileAttentionEntry => {
    if (entry.kind !== "conversation") throw new Error("a conversation entry");
    return { ...entry, item: { ...entry.item, file: file as FileEntry } };
  };
  const laneTarget = { kind: "lane", pipelineId: "a", project: "proj" } as const;

  test("each conversation reason names itself, its conversation's title, and the entry that a click jumps to", () => {
    const kinds = ["decision", "question", "plan", "permission", "delivery", "launch", "memory"] as const;
    const entries = kinds.map((kind) => withFile(conversation(`c-${kind}`, kind), { title: `Title of ${kind}`, path: `/p/${kind}.jsonl`, conversationId: `conv-${kind}` }));
    const plan = planNeedsYouCues(entries, baseline(), "p", NOW)!;
    expect(captionOf(plan.requests)).toEqual(kinds.map((kind) => ({
      what: kind,
      subject: `Title of ${kind}`,
      target: { kind: "needs-you", entryId: `c-${kind}`, then: { kind: "conversation", path: `/p/${kind}.jsonl`, conversationId: `conv-${kind}` } },
    })));
  });

  test("a parked lane, a prototype choice and the update decision each have their own line", () => {
    const row = pipelineRow("lane-1", 3, ["task-1"]);
    if (row.kind !== "pipeline") throw new Error("a pipeline entry");
    row.row.task = "Ship the thing";
    row.row.pipeline.project = "proj";
    const proto = prototype("proto-1", "task-1");
    if (proto.kind !== "prototype") throw new Error("a prototype entry");
    proto.notice.title = "Pick a variant";
    const plan = planNeedsYouCues([row, proto, update("u1")], baseline(), "p", NOW)!;
    expect(captionOf(plan.requests)).toEqual([
      { what: "lane-decision", subject: "Ship the thing", target: { kind: "needs-you", entryId: "lane-1", then: { kind: "lane", pipelineId: "lane-1", project: "proj" } } },
      { what: "prototype", subject: "Pick a variant", target: { kind: "needs-you", entryId: "proto-1", then: null } },
      { what: "update", subject: null, target: { kind: "needs-you", entryId: "auto-update:u1", then: null } },
    ]);
  });

  test("a subject is cut to 90 characters with the title cleaner, so a long task never makes a wide toast", () => {
    const row = pipelineRow("lane-1", 3);
    if (row.kind !== "pipeline") throw new Error("a pipeline entry");
    row.row.task = `**${"word ".repeat(40)}**`;
    const [request] = planNeedsYouCues([row], baseline(), "p", NOW)!.requests;
    expect(request!.caption!.subject).toHaveLength(90);
    expect(request!.caption!.subject!.endsWith("…")).toBe(true);
    expect(request!.caption!.subject).not.toContain("*");
  });

  test("a record missing its title still sounds, with a caption that has no subject", () => {
    const [request] = planNeedsYouCues([conversation("c1", "question")], baseline(), "p", NOW)!.requests;
    expect(request!.cue).toBe("your-move");
    expect(request!.caption).toMatchObject({ what: "question", subject: null });
  });

  test("a step names the stage that passed and the task, and leads to the lane's card", () => {
    const stages = [{ id: "visual-critic", kind: "run", role: { roleId: "visual-critic" } }, { id: "build", kind: "run" }];
    const before = planPipelineCues([lane("a", { task: "Sound captions", project: "proj", stages, runs: [stage("visual-critic", [{ n: 1, state: "running" }])] } as Partial<Pipeline>)], null, "p")!;
    const after = planPipelineCues([lane("a", { task: "Sound captions", project: "proj", stages, runs: [stage("visual-critic", [{ n: 1, state: "passed", completedAt: iso(1000) }])] } as Partial<Pipeline>)], before, "p")!;
    expect(captionOf(after.requests)).toEqual([
      { what: "step", subject: "Sound captions", stage: { id: "visual-critic", kind: "run", role: { roleId: "visual-critic" } }, target: laneTarget },
    ]);
  });

  test("a stage id that holds a colon still finds its stage", () => {
    const stages = [{ id: "review:2", kind: "run" }];
    const before = planPipelineCues([lane("a", { task: "t", project: "proj", stages, runs: [stage("review:2", [{ n: 1, state: "running" }])] } as Partial<Pipeline>)], null, "p")!;
    const after = planPipelineCues([lane("a", { task: "t", project: "proj", stages, runs: [stage("review:2", [{ n: 1, state: "passed", completedAt: iso(1000) }])] } as Partial<Pipeline>)], before, "p")!;
    expect(after.requests[0]!.caption!.stage).toEqual({ id: "review:2", kind: "run", role: undefined });
  });

  test("a landing says merged with its PR, or lane finished when there was no merge, and a blocked merge says so", () => {
    const base = { task: "Ship it", project: "proj" } as Partial<Pipeline>;
    const merged = planPipelineCues([lane("a", { ...base, merge: { state: "merged", mergedAt: iso(1000), prNumber: 3218 } as Pipeline["merge"] })], planPipelineCues([lane("a", base)], null, "p")!, "p")!;
    const finished = planPipelineCues([lane("a", { ...base, state: "completed", closedAt: iso(1000) })], planPipelineCues([lane("a", base)], null, "p")!, "p")!;
    const blocked = planPipelineCues([lane("a", { ...base, merge: { state: "blocked", blockedAt: iso(1000) } as Pipeline["merge"] })], planPipelineCues([lane("a", base)], null, "p")!, "p")!;
    expect(captionOf(merged.requests)).toEqual([{ what: "merged", subject: "Ship it", pr: 3218, target: laneTarget }]);
    expect(captionOf(finished.requests)).toEqual([{ what: "lane-done", subject: "Ship it", target: laneTarget }]);
    expect(captionOf(blocked.requests)).toEqual([{ what: "merge-blocked", subject: "Ship it", target: laneTarget }]);
  });

  test("a release, a failed or rolled-back deploy and a limit episode name themselves and lead nowhere", () => {
    const heard = createHeardKeys(memoryStorage());
    const first = planDoneCues([], null, NOW, heard);
    const item = (key: string, kind: DoneItemV1["kind"], extra: Partial<DoneItemV1>) => ({ ...done(key, kind, 1000, extra.refs?.phase), ...extra }) as DoneItemV1;
    const plan = planDoneCues([
      item("d1", "deploy", { title: "Release 1.2", refs: { phase: "succeeded" } }),
      item("d2", "deploy", { title: "", refs: { phase: "succeeded", sha: "0123456789abcdef" } }),
      item("d3", "deploy", { title: "x", refs: { phase: "failed" } }),
      item("d4", "deploy", { title: "x", refs: { phase: "rolled-back" } }),
      item("l1", "limit", { refs: { account: { engine: "codex", accountId: "acct-1", window: "5h", label: "Account A" } } }),
      item("l2", "limit", { refs: { account: { engine: "codex", accountId: "acct-2", window: "week" } } }),
    ], first, NOW, heard);
    expect(captionOf(plan.requests)).toEqual([
      { what: "released", subject: "Release 1.2", target: null },
      { what: "released", subject: "0123456", target: null },
      { what: "deploy-failed", subject: null, target: null },
      { what: "deploy-rolled-back", subject: null, target: null },
      { what: "limit", subject: "Account A · 5h", target: null },
      { what: "limit", subject: "acct-2 · week", target: null },
    ]);
  });
});
