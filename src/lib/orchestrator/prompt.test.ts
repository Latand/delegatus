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

/* The instruction that #976 decision 7 retired: work starts by default, so a
   mandate that forbids auto-start outright must not come back. */
test("no auto-start prohibition survives in the mandate", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("NEVER auto-start");
});

/* #982 — pipeline requests used to carry different authority depending on whether
   they arrived in the manager's own conversation or through the gateway. Under PRD
   #976 decision 7 both channels are equal, including an explicit request for a draft. */
test("the retired unequal-channel phrasing does not return", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("same request, relayed through the gateway");
});

test("the canonical direct-spawn example includes the mandatory semantic title", () => {
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/live-log-viewer-orchestration/SKILL.md"), "utf8");
  expect(skill).toContain('"title":"<semantic task title>"');
});

/* #982 / PRD #976 decision 7 — the operator talks to whoever they want, the manager
   included. Mandate v4 replaced #691's "You do not talk to the user" section with two
   channels: direct chat in the manager's own conversation, and bridge reports for the
   voice gateway. The prohibition cannot creep back in silently — in the replaced
   section or anywhere else. */
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

/* Seats record the mandate version they were spawned on; `get_orchestrator` reports
   this constant as defaultPromptVersion, so an older seat reads as stale without a diff. */
test("the default mandate is at version 17, and a v16 seat reads as stale", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(17);
  /* #1720, and again #1760 — a seat already running keeps the mandate it was
     delivered, so the version bump is the only thing that surfaces a changed
     section until its next spawn, adoption or rotation. #1749 is the change
     v17 carries: the clock paragraph no longer fences a wake to its items. */
  expect(orchestratorMandateStale(16)).toBe(true);
  expect(orchestratorMandateStale(17)).toBe(false);
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("act on the items it lists and nothing else");
});

/* #1428 v13 — the index over every message of every transcript existed, and no
   prompt told a seat to look. The mandate names both tools the seat calls: the
   search, and the reader that turns a snippet into the surrounding turns. */
test("the mandate names the transcript search and read tools", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("search_transcripts");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("conversation_messages");
});

/* #1301 — the fences list the viewer surfaces a seat may use, and a seat that
   reads `tmux` there repeats it into reports the operator reads. No tmux runs
   in the delivery path. */
test("no transport named tmux survives in the mandate", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).not.toContain("tmux");
});

/* #1245 v11 — the Viewer owns the clock. Named tool by tool: "do not
   self-schedule" alone left CronCreate looking like a different thing from
   ScheduleWakeup, and CronCreate is what the measured seat actually used.
   CronDelete is how a seat already holding one drops it. */
test("the clock section names every scheduling tool a seat could reach for", () => {
  for (const tool of ["ScheduleWakeup", "CronCreate", "Monitor", "CronDelete"]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(tool);
  }
});

test("the playbook reference is no longer pinned to this checkout", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("The llv-conveyor skill in this checkout is your playbook");
});

/* #1245 — a mandate that forbids self-scheduling while the playbook it points
   at demands one is worse than neither: the seat has to pick, and the rule
   stops being enforceable. The playbook lives in this repository, so the
   exact instruction that contradicted the mandate — self-pacing on a wakeup
   interval, which is what the measured seat was doing — is checkable here. */
test("the checked-in playbook no longer tells the seat to schedule itself", () => {
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/llv-conveyor/SKILL.md"), "utf8");
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

/* #1016 — the seat had the attention tool and never used it, and the one seat
   that tried gave up after five guesses because the tool published no target
   shape. Verbatim shapes, so a seat following only the mandate reaches the
   operator's screen on its FIRST call. Each is parsed here as the tool would
   receive it. */
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
  /* The sentinel the tool answers with when there is nothing to move. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("NO_ACTIVE_VIEW");
});

/* #1026 — a fresh seat composed its first pipeline through seven sequential
   validation errors because nothing it had read named the stage shape. The
   mandate now prints that shape as the schema declares it. */
test("the mandate carries the pipeline stage shape a first pipeline needs", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('kind: "run" | "review-loop"');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("role: {roleId, params?}");
});

test("the prompt names every bridge report class and no others", () => {
  for (const reportClass of BRIDGE_REPORT_CLASSES) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(reportClass);
  }
});

test("the prompt carries the directive trailer contract in the exact wire form", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("[bridge ref=<seq>]");
});

/* #1760 — the mandate is the prompt for a manager of ANY project, and the
   deploy section described deploying Agent Log Viewer itself. It is gone from
   the body for every project, the Viewer's own included; the protocol it
   carried lives in the llv-conveyor skill the fences already name. */
test("the mandate body says nothing about deploying the Viewer", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT.split("\n").filter((line) => line.trimEnd() === "## Deploys")).toHaveLength(0);
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("deploy_exact_sha");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("batched deploy");
});

/* #1720 v14 — the ownership section was rewritten because its earlier claims
   were wrong about what the launch path does. Each retired claim would send a
   manager down the path the section exists to prevent, so none may return. */
test("no retired task-binding claim survives in the ownership directive", () => {
  /* What an omitted binding does depends on the parent the call has. MCP
     spawn_agent dispatches same-origin with the operator capability, so the
     route infers no parent and a task-less call that names none is a duplicate
     placeholder card (spawnRecovery.integration.test.ts). */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE)
    .not.toContain("a spawn_agent call without taskId joins the task of the conversation that MADE the call");
  /* A reviewer spawn that names a parent joins the parent's card beside the
     reviewed work's (membership.test.ts), so reviewer spawns pass taskId too. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain("A review flow or a reviewer spawn inherits");
  /* A spawn's explicit target carries its own project and a single foreign id
     is admitted (pinned in membership.test.ts), so the mandate must not promise
     a refusal there — a manager acting on that promise binds an agent to
     another project's card and is told nothing. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE)
    .not.toContain("or a task in another project, refuses the launch before any agent starts");
  /* No invented id shape: the mandate must never teach a format the board does
     not mint. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain('"task_');
  /* Unlinking is the repair's second step, not a prohibition (taskBinding.test.ts). */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain('Never use "unlink-task" to tidy a duplicate');
  /* The task-side proof is `pipelineIds`; a manager told to look for an
     assignment reads a successful repair as a failed one. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain("get_task and confirm the launch is recorded on it");
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

/** The `## Deploys` section exactly as it shipped in the mandate body through
    v15, copied here from that body rather than read off the module, so the
    removal is checked against the bytes stored mandates actually carry. */
const SHIPPED_DEPLOYS_SECTION = [
  `## Deploys`,
  `YOU decide when to deploy, and you execute it yourself. Your authority is your designated seat, attributed server-side — a session that is not the designated orchestrator is refused, and a seat acts only for its own project. Nobody — you included — ever asks the user to confirm, approve, repeat, or say a commit hash. There is no confirmation step for the user, anywhere; deploys reach the user through your reports.`,
  `1. Prepare: merges landed on origin/main, gates green. Never deploy red.`,
  `2. Resolve origin/main to a full 40-hex commit SHA yourself and verify it contains what you shipped. The SHA is machine evidence — never route it through the user.`,
  `3. Call deploy_exact_sha with revision=<sha>. Deployments serialize (a busy receipt means one is already running); a retry reuses the same clientRequestId and replays the original receipt.`,
  `4. Report the outcome as a bridge report (completed/failed) — a statement of fact, never a question. The deployment ledger is the durable audit of what shipped and when.`,
].join("\n");

/* #1760 — a stored mandate composed from the body of v15 or earlier still
   carries those bytes, and it is replayed verbatim on a pending retry and
   carried through a rotation. Delivery removes the block that shipped by exact
   string match, so what surrounds it survives untouched. */
test("delivery removes the deploy section a stored mandate carries from the old body", () => {
  const stored = `You run the conveyor for this project.\n\n${SHIPPED_DEPLOYS_SECTION}\n\n## Fences\n- Report, never ask.`;

  const delivered = orchestratorMandateForDelivery(stored);
  expect(delivered).not.toContain("deploy_exact_sha");
  expect(delivered.split("\n").filter((line) => line.trimEnd() === "## Deploys")).toHaveLength(0);
  expect(delivered).toStartWith("You run the conveyor for this project.\n\n## Fences\n- Report, never ask.");
});

/* A seat's own section about ITS project's release is not the block that
   shipped, so nothing takes it off: delivery matches text, never a heading. */
test("a seat's own deploy section survives delivery", () => {
  const stored = "## Deploys\nPush the tag and let the pipeline build it.\n\n## Fences\n- Report, never ask.";
  expect(orchestratorMandateForDelivery(stored)).toStartWith(stored);
});
