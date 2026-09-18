import fs from "node:fs";
import path from "node:path";

import { expect, test } from "bun:test";

import { FOCUS_TARGET_KINDS } from "@/lib/attention/targets";
import { BRIDGE_REPORT_CLASSES } from "@/lib/bridge/types";

import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SPAWN_CONFIG,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE,
  ORCHESTRATOR_TASK_OWNERSHIP_HEADING,
  ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE,
  ORCHESTRATOR_VIEWER_CLOCK_HEADING,
  orchestratorMandateForDelivery,
  orchestratorMandateStale,
} from "./prompt";

test("the manager draft defaults to Claude Opus 5 on low effort through the role preset", () => {
  /* OrchestratorPanel seeds its shared launch controls from this live preset. */
  expect(ORCHESTRATOR_SPAWN_CONFIG).toMatchObject({ engine: "claude", model: "opus", effort: "low", role: "orchestrator" });
});

test("system prompt carries the start-by-default pipeline contract", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Start-by-default pipeline contract");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("autoStart: true");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("put the work in motion without a confirmation step or draft");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("autoStart: false");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("explicitly asks for a draft or to review the plan first in that request");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("press Start on the board");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("NEVER auto-start");
});

/* #982 — pipeline requests used to carry different authority depending on whether
   they arrived in the manager's own conversation or through the gateway. Under PRD
   #976 decision 7 both channels are equal, including an explicit request for a draft. */
test("the explicit draft request treats direct chat and the gateway as equal channels", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("asked in your own conversation or relayed through the gateway");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("both channels carry the same authority");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("same request, relayed through the gateway");
});

test("system prompt encodes the conveyor loop and its bars", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("GitHub issue -> worktree lane -> implementer agent -> review flow -> merge bar");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("merge only on an APPROVE verdict");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("REVIEW_READY:");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("src = YOUR transcript path");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("title = a semantic task name");
});

test("the canonical direct-spawn example includes the mandatory semantic title", () => {
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/live-log-viewer-orchestration/SKILL.md"), "utf8");
  expect(skill).toContain('"title":"<semantic task title>"');
});

/* #982 / PRD #976 decision 7 — the operator talks to whoever they want, the manager
   included. Mandate v4 replaced #691's "You do not talk to the user" section with two
   channels: direct chat in the manager's own conversation, and bridge reports for the
   voice gateway. The tests below pin both halves of that contract so the prohibition
   cannot creep back in silently — in the replaced section or anywhere else. */

test("direct operator chat is sanctioned as a first-class channel", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Two channels to the operator");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("The operator talks to whoever they want, you included");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("answer them there");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("That channel is sanctioned and first-class");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("gateway");
});

test("no prohibition on addressing the operator survives anywhere in the mandate", () => {
  for (const prohibition of [
    "You do not talk to the user",
    "Never address the user",
    "never ask them a question directly",
    "you have no user-facing channel",
    "not as chat",
    "only through your reports",
  ]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain(prohibition);
  }
});

test("bridge reports survive as the second channel, for the operator away from the chat", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Bridge reports — the second channel (manager -> gateway)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("carries what must reach the operator while they are elsewhere");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Append one report per meaningful outcome, with a stable key");
});

/* Seats record the mandate version they were spawned on; `get_orchestrator` reports
   this constant as defaultPromptVersion, so an older seat reads as stale without a diff. */
test("the default mandate is at version 14, and a v13 seat reads as stale", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(14);
  /* #1720 — a seat already running keeps the mandate it was delivered, so the
     version bump is the only thing that surfaces the missing section until its
     next spawn, adoption or rotation. */
  expect(orchestratorMandateStale(13)).toBe(true);
  expect(orchestratorMandateStale(14)).toBe(false);
});

/* #1428 v13 — agents kept re-solving what an earlier conversation had already
   solved. The index over every message of every transcript existed, and no
   prompt told a seat to look. The mandate now says when to search, how many
   phrasings, in which scope order, how to read a hit, and what to do with an
   old answer. */
test("the mandate tells the seat to search prior conversations before deciding", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Search prior conversations before deciding");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("search_transcripts");
  /* Both triggers: the start of real work, and any problem that appears later. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("start of any non-trivial task");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("whenever a problem, failure or unknown appears");
  /* Several phrasings, and named ones — one query on the error text misses the
     conversation that called the same thing by its subsystem. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("3 to 5");
  for (const phrasing of ["the error text", "the subsystem", "the symptom", "the file or tool"]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(phrasing);
  }
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("scoped to the project first, then unscoped");
  /* A snippet is not a reading: the surrounding turns come through conversation_messages. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("conversation_messages");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("transcript path and byte offset");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("before choosing an approach");
  /* The result is written down either way, so a reader of the plan knows the
     search happened. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("title and date");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("nothing relevant existed");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("current main");
});

/* The acceptance shape in #1428: a seat handed a problem searches before it
   composes a pipeline. The mandate is read top to bottom, so the search section
   precedes the section that starts work by default. */
test("the search-first section precedes the start-by-default pipeline contract", () => {
  const search = ORCHESTRATOR_SYSTEM_PROMPT.indexOf("## Search prior conversations before deciding");
  const start = ORCHESTRATOR_SYSTEM_PROMPT.indexOf("## Start-by-default pipeline contract");
  expect(search).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(search);
  /* Searching changes what the seat looks at, never whether work starts. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("put the work in motion without a confirmation step or draft");
});

/* #1301 — the fences list the viewer surfaces a seat may use, and a seat that
   reads `tmux` there repeats it into reports the operator reads. No tmux runs
   in the delivery path; the endpoint is named for what it does. */
test("the fences name the delivery endpoint for what it does and no transport", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("agent/snapshot, conversation-host)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).not.toContain("tmux");
});

/* #1202 — every ask the manager makes should be answerable with a tap, so the
   rule that produces the drafts is part of the mandate, not a convention. */
test("the mandate tells the seat to offer reply drafts whenever it asks or proposes something", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Reply drafts (suggest_replies)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Call suggest_replies after EVERY message of yours that asks the operator something or proposes a course of action");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("2\u20134 short, distinct drafts");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("in the operator's own language");
  /* A draft is an offer: the mandate must never read as the viewer answering. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never a decision");
});

test("the mandate greets a fresh seat and preserves the exact rotation standby status", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Initial visible status");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Your first turn after receiving this mandate");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("FRESH seat with no missions");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Ready in {project}.\nTell me what to ship — I open lanes, spawn implementers and reviewers, and merge on APPROVE. Nothing starts until you ask.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("ROTATION");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("inventory the mandate missions and state your plan");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("all mandate missions are complete; standing by");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("generic continuation nudge");
});

/* #1245 v11 — the Viewer owns the clock. This paragraph is not documentation:
   production measured a seat whose own session cron kept its turn open, so the
   native tick logged 20 consecutive "skipped — the seat's turn is progressing"
   and could never reach it. The two mechanisms deadlock, and the only thing
   that breaks the deadlock is the seat dropping its own schedule first. So the
   mandate has to say that, in that order, and say it to a seat that is already
   holding one. */
test("the mandate hands the clock to the Viewer and forbids a seat scheduling itself", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## The Viewer's clock — you never schedule yourself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("The Viewer wakes you");
  /* Named tool by tool: "do not self-schedule" alone left CronCreate looking
     like a different thing from ScheduleWakeup, and CronCreate is what the
     measured seat actually used. */
  for (const tool of ["ScheduleWakeup", "CronCreate", "Monitor"]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(tool);
  }
  /* Idle between wakes is the correct state, not a symptom to fix by arming
     something — the belief that produced the self-schedule in the first place. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Between wakes you are idle on purpose");
});

test("the mandate's own arrival is the handover, and it says why waiting cannot work", () => {
  /* The decision this PR had to make and state: an explicit step, because
     "retire the fallback once you observe a native wake" is unsatisfiable while
     the fallback is what prevents the wake. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("cancel it in this turn");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("the arrival of this mandate is the handover, not a later observation");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("CronDelete");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Do not wait to \"see the Viewer's tick work first\"");
  /* The mechanism spelled out, so a seat that reasons about the instruction
     reaches the same conclusion instead of deciding it is over-cautious. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("the Viewer's tick finds you busy and drops its check every time");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Yours goes first");
});

test("the conveyor skill reference is portable across checkouts, and subordinate to the mandate", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("If this checkout carries an llv-conveyor skill, it is your playbook, subordinate to this mandate wherever the two disagree; otherwise the conveyor rules above are the playbook.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("The llv-conveyor skill in this checkout is your playbook");
});

/* #1245 — a mandate that forbids self-scheduling while the playbook it points
   at demands one is worse than neither: the seat has to pick, and the rule
   stops being enforceable. The playbook lives in this repository, so the
   agreement is checkable here rather than left to whoever edits it next. */
test("the checked-in playbook agrees with the mandate about the clock", () => {
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/llv-conveyor/SKILL.md"), "utf8");
  expect(skill).toContain("The Viewer owns the clock");
  expect(skill).toContain("the seat never schedules itself");
  /* The exact instruction that contradicted the mandate: self-pacing on a
     wakeup interval, which is what the measured seat was doing. */
  expect(skill).not.toContain("self-paces with ScheduleWakeup");
  expect(skill).not.toContain("ScheduleWakeup checkpoints");
});

test("mandate delivery keys off directive content and appends it exactly once", () => {
  const custom = "Caller-edited current-version mandate";
  const delivered = orchestratorMandateForDelivery(custom);

  expect(delivered).toStartWith(custom);
  expect(delivered.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
});

/* #1245 — the handover has to reach the seat that is actually holding a
   schedule, and that seat is precisely the one NOT carrying the current
   default: a rotation may keep the incumbent's mandate and version (#1452),
   and a bespoke mandate never had the paragraph at all. A paragraph that lived
   only inside the versioned default would change the clock's owner without
   telling either of them. */
test("the clock handover reaches a bespoke or older mandate, exactly once", () => {
  const stale = "A v10 seat's own mandate, carried through a rotation.";
  const delivered = orchestratorMandateForDelivery(stale);

  expect(delivered).toStartWith(stale);
  expect(delivered).toContain(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE);
  expect(delivered).toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  expect(delivered.split(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE)).toHaveLength(2);
  /* Idempotent: re-delivery after a host death appends nothing, so a seat
     never reads the handover twice in one mandate. */
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  /* A mandate that already carries the paragraph — the current default, or a
     caller-edited copy of it — is delivered untouched. */
  expect(orchestratorMandateForDelivery(`${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE}\n\nmy own rules`))
    .toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  expect(orchestratorMandateForDelivery(`${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE}\n\nmy own rules`)
    .split(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE)).toHaveLength(2);

  /* And a caller who reworded the section under its own heading keeps THEIR
     wording. Appending the canonical copy beside it would deliver two clock
     instructions in one mandate, which is the shape this is fixing. */
  const reworded = `${ORCHESTRATOR_VIEWER_CLOCK_HEADING}\nWake only when the Viewer tells you to.`;
  expect(orchestratorMandateForDelivery(reworded)).not.toContain(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE);
  expect(orchestratorMandateForDelivery(reworded)).toStartWith(reworded);
});

/* The versioned default carries it inline, so a fresh seat reads it in place
   rather than as an appendix — and delivery has nothing to append. */
test("the current default already contains the clock directive", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE);
});

/* #1016 — the seat had the attention tool and never used it: nothing it read said
   when moving the operator was the right thing to do, and the tool published no
   target shape, so the one seat that tried gave up after five guesses. The mandate
   now carries both halves — the occasions, and the shapes to call them with. */
test("the mandate teaches proactive attention steering with the occasions for it", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Steering the operator's attention (request_attention)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("you just spawned or resumed a worker for something they asked for");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a review verdict, merge or deploy lands");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a lane blocks on THEM");
  /* Sparingly and tied to concrete work — the failure mode on the other side is a
     seat that yanks the view on every poll. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Do not move them for polling, routine status");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("One move per real outcome");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("NO_ACTIVE_VIEW");
});

/* Verbatim shapes, so a seat following only the mandate reaches the operator's
   screen on its FIRST call. Each is parsed here as the tool would receive it. */
test("the mandate carries working target shapes for every surface it names", () => {
  for (const shape of [
    '{"kind":"conversation","conversationId":"conversation_..."}',
    '{"kind":"conversation","path":"/.../transcript.jsonl"}',
    '{"kind":"stage","pipelineId":"pipeline_...","stageId":"review"}',
    '{"kind":"pipeline","pipelineId":"pipeline_..."}',
    '{"kind":"flowRound","flowId":"flow_...","round":2}',
    '{"kind":"task","taskId":"task_..."}',
    '{"kind":"draft","draftId":"draft_..."}',
  ]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(shape);
    const target = JSON.parse(shape) as { kind: string };
    /* Each printed shape is a real target of a real kind, discriminated the way
       the tool discriminates it. */
    expect(FOCUS_TARGET_KINDS).toContain(target.kind as never);
  }
  /* The two facts a first call also needs: the draft's extra argument, and that
     intent decides framing versus opening. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("plus a top-level project");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('intent "show" frames and highlights the card; intent "open" also opens it');
});

/* #1026 — a fresh seat composed its first pipeline through seven sequential
   validation errors because nothing it had read named the stage shape. The
   mandate now carries that contract, with the two rules the walk actually
   turned on: runtime overrides live on the stage, and `next` defaults to null
   so an unwired review-loop is unreachable. */
test("the mandate carries the pipeline stage contract a first pipeline needs", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("## Pipeline stage contract");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('kind: "run" | "review-loop"');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("role: {roleId, params?}");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never inside role");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("DEFAULTS TO null");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("pass-reachable from a run stage");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a draft that pins baseBranch must also pass baseRef");
});

test("the prompt names every bridge report class and no others", () => {
  for (const reportClass of BRIDGE_REPORT_CLASSES) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(reportClass);
  }
});

test("the prompt states the report body bounds so the gateway is never handed raw output", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("2 KB");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("no raw tool output");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("no full board dumps");
});

test("the prompt carries the directive trailer contract in the exact wire form", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("[bridge ref=<seq>]");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never read one into unrelated prose");
});

/* #795 (superseding contract) — the designated agent decides the deploy and
   executes it directly. The prompt must say where the authority comes from
   (the server-attributed seat), that the SHA is resolved internally, and that
   nothing is ever routed back through the user for approval. */
test("the prompt encodes the designated-agent deploy contract and its refusals", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("YOU decide when to deploy, and you execute it yourself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Your authority is your designated seat, attributed server-side");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a seat acts only for its own project");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Resolve origin/main to a full 40-hex commit SHA yourself");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never route it through the user");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Deployments serialize");
});

test("the prompt forbids any user-facing confirmation step outright", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("ever asks the user to confirm, approve, repeat, or say a commit hash");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("There is no confirmation step for the user, anywhere");
});

test("the prompt tells the manager to re-derive board state rather than accumulate it", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Re-derive board state per turn");
});

/* #1720 v14 — the board task is the unit of work. A manager that opened a
   pipeline without `taskIds` produced a second card for work that already had
   one, and the operator saw two live claims on one outcome. The mandate now
   names the one canonical task, when to find it, and the fields that carry it
   into the launch. */
test("the mandate makes one product outcome own one task across its whole life", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_TASK_OWNERSHIP_HEADING);
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A board task is one PRODUCT OUTCOME");
  /* Every phase of one outcome, named, so a fix round or a release is not read
     as separate work deserving its own card. */
  for (const phase of ["the diagnosis", "the implementer", "every reviewer", "every retry", "the fix round", "the release"]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(phase);
  }
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Open a second task only for genuinely separate work");
});

test("the mandate makes discovery precede any launch, over every status", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("FIND IT BEFORE YOU LAUNCH ANYTHING");
  /* The failure this fixes: a seat that listed only inbox and assigned missed
     the blocked card that already owned the outcome and opened a second one. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("list_tasks for this project with NO status filter and limit: 200");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("blocked and finished work can reach you beside inbox and assigned");
  /* The answer is one capped page in creation order (`bindings.ts` slices
     `loadTasks()` with no cursor and no sort), and the project task cap is
     higher than the read cap — so a full page has dropped the newest work,
     which is exactly what the seat is looking for. The mandate must not
     promise a completeness the tool cannot give. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a page at the cap was truncated and the NEWEST work is what it dropped");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("treat it as a lead, never as the whole board");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("get_task any id the operator or a report hands you even when the page did not carry it");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("search_transcripts");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("create a task only when nothing you can reach owns this outcome");
});

test("the mandate requires a real title and description at creation, never left to the launched agent", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("FIRST LINE is a human title of 3 to 10 words");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("what the work has to achieve");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A role name, a stage id, a prompt excerpt and \"Untitled task\" are all unusable as titles");
  /* First-action refinement stays a fallback: the roles that cannot name a task
     are exactly the read-only ones, and a launch that dies first names nothing. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("read-only reviewers, verifiers and architects are told not to mutate state");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a launch that dies before its first turn names nothing");
});

/* The two fields are the whole enforcement: membership is committed from what
   the launch CALL carried. A pipeline carrying no task mints the container
   placeholder; a spawn carrying none joins the tasks of the parent it names and
   of the conversation it reviews, and with neither gets a placeholder card of
   its own. The mandate prints the field names the schemas declare, and
   no invented task id format — board ids are opaque. */
test("the mandate carries the task into the launch call itself, by field name", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("CARRY THE TASK INTO THE LAUNCH ITSELF");
  /* What an omitted binding does depends on the parent the call has. MCP
     spawn_agent dispatches same-origin with the operator capability, so the
     route infers no parent and a task-less call that names none is a duplicate
     placeholder card (spawnRecovery.integration.test.ts). An agent-capability
     POST to /api/spawn always makes the caller the parent, so the worker lands
     on the seat's card. The mandate must state both, and must not tell a seat
     that every spawn lands on its own card. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A pipeline created without taskIds is given a placeholder card of its own");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A spawn without a task joins the cards of its parent and of the work it reviews, or gets a placeholder card when neither holds one");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("spawn_agent sets a parent only when the call names one, while POST /api/spawn always makes you the parent");
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE)
    .not.toContain("a spawn_agent call without taskId joins the task of the conversation that MADE the call");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('taskIds: ["<board task id>"] in the SAME call as stages and autoStart');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('spawn_agent or POST /api/spawn — pass taskId: "<board task id>"');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("run, review-loop, retry, fail branch");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Adding it after the pipeline exists comes too late for the stages that already started");
  /* A reviewer spawn that names a parent joins the parent's card beside the
     reviewed work's (membership.test.ts), so reviewer spawns pass taskId too;
     review flows and review-loop stages really do need nothing. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("on EVERY spawn, reviewers included: an explicit id wins over inheritance");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A review flow or a pipeline's review-loop stage inherits the task of the work it reviews. Pass nothing, create nothing.");
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain("A review flow or a reviewer spawn inherits");
  /* The cross-project refusal belongs to create_pipeline, which validates the
     ids against the pipeline's project at the store seam. A spawn's explicit
     target carries its own project and a single foreign id is admitted
     (pinned in membership.test.ts), so the mandate must not promise a refusal
     there — a manager acting on that promise binds an agent to another
     project's card and is told nothing. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("create_pipeline also refuses a task belonging to another project, while spawn_agent takes the id as given and binds the agent to that other project's card");
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE)
    .not.toContain("or a task in another project, refuses the launch before any agent starts");
  /* No invented id shape: the mandate must never teach a format the board does
     not mint. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain('"task_');
});

test("the mandate extends existing work and reuses the same task for a successor pipeline", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("EXTEND THE WORK THAT EXISTS");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A started pipeline's graph is fixed");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("create the successor pipeline with the SAME taskIds, so one card carries both");
});

/* A pipeline created without taskIds adopts its placeholder at the first
   stage's reservation, so a repair starts from [placeholder]. link-task
   appends (later stages join both cards); unlinking the placeholder afterwards
   leaves [outcome] and nothing re-adopts, because re-adoption needs an EMPTY
   list. So the repair is link, read back, unlink the placeholder — and the
   only forbidden unlink is the last one (taskBinding.test.ts pins all three). */
test("the mandate orders the binding repair, separates the assignment-only tool, and forbids unlinking the last task", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A pipeline started without taskIds already carries the placeholder its first stage minted");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('Repair in order: pipeline_action "link-task" with the outcome\'s task, read it back, then "unlink-task" the placeholder id that was there before');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("stages already admitted stay on the placeholder card");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("link_task_to_pipeline records one assignment and leaves the pipeline's task list alone, so it repairs nothing");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Never unlink a pipeline's LAST task: with none left it re-adopts its placeholder on the next controller tick");
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain('Never use "unlink-task" to tidy a duplicate');
});

test("the mandate requires a membership readback and states that a linked task may still be invisible", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("READ BACK WHAT YOU DID");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("get_pipeline and confirm its taskIds contain the task");
  /* The task-side proof is `pipelineIds`, which `projectTaskPipelineIds`
     computes from `pipeline.taskIds` on every get_task read, so it is true as
     soon as the link lands. Assignments are NOT: link-task writes none, and
     `planAdmissions` skips a pipeline that already carries taskIds, so a
     manager told to look for an assignment reads a successful repair as a
     failed one and reaches for the tools this section just warned it off. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("get_task and confirm the task's pipelineIds contain the pipeline");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("a link writes none, and the stages already running stay on the card they were admitted to");
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain("get_task and confirm the launch is recorded on it");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A task can hold a launch and still draw no band on the board");
});

/* Retiring a superseded container is gated on the transfer having happened:
   the opposite error — closing live containers to tidy the board — destroys
   work the operator is still owed. */
test("the mandate retires a superseded container only after the outcome moved, and never in bulk", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("ONE OUTCOME NEVER SHOWS TWO LIVE CLAIMS");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("only once the outcome is carried by the surviving one and nothing in the old one is still running or unknown");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("say out loud what you are dropping");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("mark a task blocked with the reason when it cannot proceed");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Never close containers in bulk to tidy the board");
});

test("the mandate keeps an unknown outcome under its original receipt key", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("RECEIPTS ARE THE RECORD");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("A retry of the SAME logical operation reuses its id and replays the original receipt");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("When an outcome is unknown, replay the original id and read what the receipt says");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Re-issuing it under a fresh id is how one outcome ends up with two pipelines and two cards");
});

/* The conveyor section is what a seat reads when it spawns an implementer, so
   the binding field has to appear there too. */
test("the conveyor rules name the task binding on the spawn call and the one card", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("taskId = the outcome's board task");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Keep the outcome's ONE task card updated");
});

/* Delivery, on exactly the terms the clock handover established: the seats that
   launch work without a task are the ones carrying a bespoke or older mandate,
   and a rotation hands the successor the INCUMBENT's mandate. */
test("the task-ownership section reaches a bespoke or older mandate, exactly once", () => {
  const bespoke = "A seat's own mandate, written before #1720.";
  const delivered = orchestratorMandateForDelivery(bespoke);

  expect(delivered).toStartWith(bespoke);
  expect(delivered).toContain(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE);
  expect(delivered.split(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE)).toHaveLength(2);
  /* The other two directives still arrive, each once. */
  expect(delivered.split(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE)).toHaveLength(2);
  expect(delivered.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  /* Idempotent: a redelivery after a host death appends nothing. */
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  /* And a caller who reworded the section under its own heading keeps THEIR
     wording — appending the canonical copy would deliver two ownership rules. */
  const reworded = `${ORCHESTRATOR_TASK_OWNERSHIP_HEADING}\nOne card per outcome. Ask me before you open another.`;
  expect(orchestratorMandateForDelivery(reworded)).not.toContain(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE);
  expect(orchestratorMandateForDelivery(reworded)).toStartWith(reworded);
});

/* The current default carries all three inline, so a fresh seat reads each in
   place and delivery has nothing to append. */
test("the delivered default carries each directive exactly once and is unchanged by delivery", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE);
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
  for (const directive of [
    ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE,
    ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE,
    ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT.split(directive)).toHaveLength(2);
  }
});

/* Ownership decides whether work starts on the right card, so the seat reads it
   before the section that starts pipelines by default. */
test("the ownership section precedes the start-by-default pipeline contract", () => {
  const ownership = ORCHESTRATOR_SYSTEM_PROMPT.indexOf(ORCHESTRATOR_TASK_OWNERSHIP_HEADING);
  const start = ORCHESTRATOR_SYSTEM_PROMPT.indexOf("## Start-by-default pipeline contract");
  expect(ownership).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(ownership);
});
