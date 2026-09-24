import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "bun:test";

import { FOCUS_TARGET_KINDS } from "@/lib/attention/targets";
import { BRIDGE_REPORT_CLASSES } from "@/lib/bridge/types";
import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import type { RegistryRoleDefinitions, RoleDefinition } from "@/lib/roles/types";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_ROLE_TABLE_HEADING,
  ORCHESTRATOR_SEAT_TICK_CONTRACT,
  ORCHESTRATOR_SPAWN_CONFIG,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE,
  ORCHESTRATOR_TASK_OWNERSHIP_HEADING,
  ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE,
  ORCHESTRATOR_VIEWER_CLOCK_HEADING,
  orchestratorMandateCarriesTickContract,
  orchestratorMandateForDelivery,
  orchestratorMandateWithRoleTable,
  orchestratorMandateStale,
  orchestratorRoleTable,
} from "./prompt";

test("the manager draft defaults to the Claude Opus alias on low effort through the role preset", () => {
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
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/delegatus-orchestration/SKILL.md"), "utf8");
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
test("the default mandate is at version 23, and a v22 seat reads as stale", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(23);
  /* #1720, and again #1760 — a seat already running keeps the mandate it was
     delivered, so the version bump is the only thing that surfaces a changed
     section until its next spawn, adoption or rotation. #1749 is the change
     v18 carries (#1834): the card's text is the human's and agent context goes
     in the task's separate details field. v19 (#1843) adds the human-in-the-loop
     section. v20 (#1880) points "role per the role table" at the table
     delivery renders. v21 (#2030) carries the seat tick contract. v22 names the
     product Delegatus and says its MCP key stays `viewer`. v23 keeps work
     moving and removes tool-schema duplication from the delivered text. */
  expect(orchestratorMandateStale(22)).toBe(true);
  expect(orchestratorMandateStale(23)).toBe(false);
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("You are Delegatus's built-in Manager");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("registered under the key `viewer`");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("the viewer's built-in Manager");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("act on the items it lists and nothing else");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("AGENT CONTEXT GOES IN details");
});

/**
 * The text each version shipped with, as a SHA-256 of `ORCHESTRATOR_SYSTEM_PROMPT`
 * (#2030). v20's text was rewritten without a bump, so no seat ever received
 * the rewrite: rotation rebuilds a core only when the recorded version is
 * behind. An edit to the prompt fails this until the version is bumped and the
 * new text's fingerprint is ADDED here. Never rewrite an existing entry — that
 * is the unbumped edit this exists to refuse. v20 is the text at the merge
 * base of #2030, the last one that version named.
 */
const PROMPT_FINGERPRINTS: Readonly<Record<number, string>> = {
  20: "e49277d58a32cd581d1d9a3ab6658528b2d42de6465350e8108d00cffebdcfca",
  21: "99305652476c390cccbe283e49771f6abe408cb6ff8bdd14ed6fb4394dd7704c",
  22: "6e5ca84fd3997ce92d85d2ae1602d909b1786fa3340312539021e31d91dec74a",
  23: "4853170b7f7a47ad6e219e25276b2d2bc3a9baad55964b7b078f20735ea02cae",
};

test("any edit to the default mandate text moves its version (#2030)", () => {
  const fingerprint = createHash("sha256").update(ORCHESTRATOR_SYSTEM_PROMPT).digest("hex");
  const pinned = PROMPT_FINGERPRINTS[ORCHESTRATOR_PROMPT_VERSION];
  expect(
    pinned,
    `ORCHESTRATOR_SYSTEM_PROMPT is ${fingerprint}. After an edit, bump ORCHESTRATOR_PROMPT_VERSION and add ${ORCHESTRATOR_PROMPT_VERSION + 1}: "<new fingerprint>" to PROMPT_FINGERPRINTS; never rewrite an existing entry.`,
  ).toBe(fingerprint);
  /* One text per version and one version per text: an entry copied forward
     with the old fingerprint would let an edit ride an existing number. */
  const versions = Object.keys(PROMPT_FINGERPRINTS).map(Number);
  expect(Math.max(...versions)).toBe(ORCHESTRATOR_PROMPT_VERSION);
  expect(new Set(Object.values(PROMPT_FINGERPRINTS)).size).toBe(versions.length);
});

/** The contract every seat tick wake ended with until #2030, copied verbatim
    from `src/lib/monitor/report.ts` at the merge base, so a clause dropped or
    reworded on its way into the mandate fails here rather than silently. */
const SHIPPED_TICK_CONTRACT = [
  "Handle the listed items first, then make ONE bounded pass over this project's whole board and act on what stands still: list_pipelines for lanes completed, parked or failed to spawn, the open pull requests their finished lanes left, list_flows, agent_activity with liveOnly for live and stalled agents, and open tasks with nothing running.",
  "Record every outcome where it belongs — on the board card or on the pipeline — not only in this conversation.",
  "If an item cannot be done, mark its task blocked with the reason. That is the stop, and it is the only one.",
  "Do not schedule yourself. The Viewer ticks this seat; a self-scheduled monitor is refused practice.",
  "This tick is yours to govern: seat_tick_settings turns it off, changes how often it wakes you, or turns it back on, per project, with a reason that shows on the board.",
  "Do not wait on the operator inside this turn.",
];

/* Each shipped clause, and where the clock section now says it. The wording is
   the mandate's own (a wake no longer quotes it), so this maps rule to rule. */
const CLAUSE_IN_MANDATE: readonly [string, string][] = [
  [SHIPPED_TICK_CONTRACT[0]!, "then make ONE bounded pass over this project's whole board and act on what stands still: list_pipelines for lanes completed, parked or failed to spawn, the open pull requests their finished lanes left, list_flows, agent_activity with liveOnly for live and stalled agents, and open tasks with nothing running."],
  [SHIPPED_TICK_CONTRACT[1]!, "Record every outcome on the board card or the pipeline, not only in this conversation."],
  [SHIPPED_TICK_CONTRACT[2]!, "mark its task blocked with the reason: that is the stop, and the only one."],
  [SHIPPED_TICK_CONTRACT[3]!, "So do not schedule yourself"],
  [SHIPPED_TICK_CONTRACT[4]!, "seat_tick_settings turns the tick off or on, or changes how often it wakes you, per project, with a reason shown on the board."],
  [SHIPPED_TICK_CONTRACT[5]!, "Never wait on the operator inside a wake's turn."],
];

test("every clause the tick contract carried lives in the mandate, and reaches every seat once (#2030)", () => {
  expect(CLAUSE_IN_MANDATE.map(([shipped]) => shipped)).toEqual(SHIPPED_TICK_CONTRACT);
  for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE).toContain(clause);
  for (const [, stated] of CLAUSE_IN_MANDATE) {
    expect(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE).toContain(stated);
    expect(ORCHESTRATOR_SYSTEM_PROMPT.split(stated)).toHaveLength(2);
  }
  /* A bespoke mandate is exactly the one without it, and delivery is what gives
     it the section, once. */
  const bespoke = "A seat's own mandate, carried through a rotation.";
  const delivered = orchestratorMandateForDelivery(bespoke);
  for (const [, stated] of CLAUSE_IN_MANDATE) expect(delivered.split(stated)).toHaveLength(2);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
});

/** The clock section's last paragraph as it shipped in v11–v16 and in
    v17–v20, copied verbatim from those bodies. The three paragraphs before it
    never changed, so each shipped section is the current opening plus one of
    these. */
const SHIPPED_CLOCK_LAST_PARAGRAPHS = [
  "Between wakes you are idle on purpose, and idle is correct: a seat with nothing owed costs nothing. When a wake arrives, act on the items it lists and nothing else, record every outcome where it belongs, and mark a task blocked with the reason when it cannot be done — that is the stop. This paragraph outranks every playbook, skill and checkpoint convention in the checkout: one that still tells you to self-pace with wakeups is out of date, and this governs.",
  "Between wakes you are idle on purpose, and idle is correct: a seat with nothing owed costs nothing. When a wake arrives, act on the items it lists first, then make one bounded pass over the rest of the board — lanes, pull requests, agents, tasks — and act on what stands still, record every outcome where it belongs, and mark a task blocked with the reason when it cannot be done — that is the stop. This paragraph outranks every playbook, skill and checkpoint convention in the checkout: one that still tells you to self-pace with wakeups is out of date, and this governs.",
];
const shippedClockSection = (lastParagraph: string) =>
  `${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE.split("\n").slice(0, 4).join("\n")}\n${lastParagraph}`;

/* #2030 review: every mandate composed from a v20-or-older body carries the
   clock HEADING with the old paragraph under it, so appending by heading gave
   those seats none of the clauses their wakes stopped repeating. */
test("delivery replaces the clock section an older mandate carries, so it states every contract clause once (#2030)", () => {
  for (const lastParagraph of SHIPPED_CLOCK_LAST_PARAGRAPHS) {
    const stored = `You run the conveyor for this project.\n\n${shippedClockSection(lastParagraph)}\n\n## Fences\n- Report, never ask.`;
    for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(stored).not.toContain(clause);
    const delivered = orchestratorMandateForDelivery(stored);
    for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(delivered.split(clause)).toHaveLength(2);
    expect(delivered).not.toContain(lastParagraph);
    expect(delivered.split(ORCHESTRATOR_VIEWER_CLOCK_HEADING)).toHaveLength(2);
    expect(delivered).toStartWith(`You run the conveyor for this project.\n\n${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE}\n\n## Fences\n- Report, never ask.`);
    expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  }
  /* The real v20 body: its whole clock section is the second shipped text. */
  const v20Core = ORCHESTRATOR_SYSTEM_PROMPT.replace(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, shippedClockSection(SHIPPED_CLOCK_LAST_PARAGRAPHS[1]!));
  expect(v20Core).not.toBe(ORCHESTRATOR_SYSTEM_PROMPT);
  const delivered = orchestratorMandateForDelivery(v20Core);
  for (const clause of ORCHESTRATOR_SEAT_TICK_CONTRACT) expect(delivered.split(clause)).toHaveLength(2);
  /* A seat's own rewording under the heading is not what shipped, and stays. */
  const reworded = `${ORCHESTRATOR_VIEWER_CLOCK_HEADING}\nWake only when the Viewer tells you to.`;
  expect(orchestratorMandateForDelivery(reworded)).toStartWith(reworded);
});

test("only a seat delivered a mandate that states the contract is spared its clauses in the wake (#2030)", () => {
  expect(orchestratorMandateCarriesTickContract({ mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: ORCHESTRATOR_PROMPT_VERSION })).toBe(true);
  /* Still running on what it was delivered before v21, or carried forward on
     an older mandate: the text now delivers the clauses, the seat never read
     them. */
  const v20Core = ORCHESTRATOR_SYSTEM_PROMPT.replace(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, shippedClockSection(SHIPPED_CLOCK_LAST_PARAGRAPHS[1]!));
  expect(orchestratorMandateCarriesTickContract({ mandate: v20Core, promptVersion: 20 })).toBe(false);
  expect(orchestratorMandateCarriesTickContract({ mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: 20 })).toBe(false);
  /* Bespoke rules claim no version and cannot say when they were delivered. */
  expect(orchestratorMandateCarriesTickContract({ mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: null })).toBe(false);
  /* A current seat whose own edit reworded the section lost the clauses. */
  const reworded = ORCHESTRATOR_SYSTEM_PROMPT.replace(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, `${ORCHESTRATOR_VIEWER_CLOCK_HEADING}\nWake only when told.`);
  expect(orchestratorMandateCarriesTickContract({ mandate: reworded, promptVersion: ORCHESTRATOR_PROMPT_VERSION })).toBe(false);
  expect(orchestratorMandateCarriesTickContract({ promptVersion: ORCHESTRATOR_PROMPT_VERSION })).toBe(false);
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
  const skill = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/delegatus-conveyor/SKILL.md"), "utf8");
  expect(skill).not.toContain("self-paces with ScheduleWakeup");
  expect(skill).not.toContain("ScheduleWakeup checkpoints");
  expect(skill).toContain("controller appends the stage_report contract");
  expect(skill).not.toContain("required fenced JSON verdict");
  expect(skill).not.toMatch(/\bSol\b|xhigh/);
});

test("mandate delivery keys off directive content and appends it exactly once", () => {
  const custom = "Caller-edited current-version mandate";
  const delivered = orchestratorMandateForDelivery(custom);

  expect(delivered).toStartWith(custom);
  expect(delivered.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${orchestratorRoleTable(ROLE_DEFAULTS)}`);
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

/* #1016 put target examples in the mandate before the tool published them.
   The tool schema now owns their shapes; the mandate names every supported
   kind and directs the seat back to that schema. */
test("the mandate names every attention target and uses the tool schema for shapes", () => {
  const namedKinds = ORCHESTRATOR_SYSTEM_PROMPT.match(/Targets are typed by kind \(([^)]+)\)/)?.[1]?.split(", ");
  expect(namedKinds?.sort()).toEqual([...FOCUS_TARGET_KINDS].sort());
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("the tool schema gives each shape");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("The shapes, verbatim:");
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
   carried lives in the delegatus-conveyor skill the fences already name. */
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
test("the delivered default carries each directive exactly once, and delivery adds only the role table", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE);
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${orchestratorRoleTable(ROLE_DEFAULTS)}`);
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

/* #1880 — a manager launched a routine read-only audit with no runtime and it
   ran at the preset's xhigh: the mandate said "role per the role table" and
   carried no table. Delivery now renders it from the registry it is handed, so
   a changed preset shows up in the next mandate a seat receives. */
function roleTableLines(mandate: string): string[] {
  const start = mandate.indexOf(ORCHESTRATOR_ROLE_TABLE_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  return mandate.slice(start).split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| role ") && !line.startsWith("| ---"));
}

test("the delivered mandate renders the role table from the registry it is handed", () => {
  const registry: RoleDefinition[] = ROLE_DEFAULTS.map((role) => role.id === "prod-auditor"
    ? { ...role, config: { engine: "claude", model: "sonnet", effort: "low" } }
    : role);
  const delivered = orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT, registry);
  const rows = roleTableLines(delivered);

  expect(rows).toHaveLength(ROLE_DEFAULTS.length);
  expect(rows.find((row) => row.startsWith("| prod-auditor |"))).toStartWith("| prod-auditor | claude | sonnet | low | read-only |");
  expect(rows.find((row) => row.startsWith("| builder |"))).toStartWith("| builder | codex | gpt-6-astra | medium | read-write |");
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toContain("| prod-auditor | codex | gpt-6-astra | xhigh | read-only |");
});

test("the role table carries the runtime guidance beside it", () => {
  const delivered = orchestratorMandateForDelivery("Bespoke mandate");
  const section = delivered.slice(delivered.indexOf(ORCHESTRATOR_ROLE_TABLE_HEADING));
  expect(section).toContain("omits engine, model and effort");
  expect(section).toContain("on the stage");
  expect(section).toMatch(/low or medium/);
  expect(section).toContain("NEXT attempt");
  expect(section).toContain("create_pipeline");
});

test("the manager table uses resolved saved builder variants and keeps registry provenance", () => {
  const roles = ROLE_DEFAULTS.map((role) => role.id === "builder" ? {
    ...role,
    variants: {
      frontend: { engine: "claude" as const, model: "sonnet", effort: "high" },
      "apply-fixes": { engine: "codex" as const, model: "gpt-5.6-luna", effort: "xhigh" },
    },
  } : role) as RegistryRoleDefinitions;
  Object.defineProperty(roles, "registry", {
    value: { revision: "roles-1-saved-variant", health: { state: "healthy" } },
  });

  const table = orchestratorRoleTable(roles);
  expect(table).toContain("domain=frontend runs claude/sonnet/high");
  expect(table).toContain("mode=apply-fixes runs codex/gpt-5.6-luna/xhigh");
  expect(table).toContain("Registry revision: roles-1-saved-variant. Registry health: healthy.");
  const delivered = orchestratorMandateWithRoleTable("Bespoke mandate", table);
  expect(orchestratorMandateWithRoleTable(delivered, table)).toBe(delivered);
  expect(delivered).toContain("Registry revision: roles-1-saved-variant.");
});

test("the manager table makes a fallback registry visible", () => {
  const roles = ROLE_DEFAULTS.map((role) => ({ ...role })) as RegistryRoleDefinitions;
  Object.defineProperty(roles, "registry", {
    value: { revision: "roles-1-fallback", health: { state: "degraded", reason: "preset unavailable" } },
  });
  expect(orchestratorRoleTable(roles)).toContain("Registry health: degraded (preset unavailable; shipped defaults shown).");
});

test("delivery replaces a role table the mandate already carries, so it is always the live one", () => {
  const stale = orchestratorMandateForDelivery("Bespoke mandate", ROLE_DEFAULTS.map((role) => ({ ...role, config: { ...role.config, effort: "max" } })));
  const fresh = orchestratorMandateForDelivery(stale);

  expect(fresh.split(ORCHESTRATOR_ROLE_TABLE_HEADING)).toHaveLength(2);
  expect(fresh).not.toContain("| max |");
  expect(fresh).toBe(orchestratorMandateForDelivery("Bespoke mandate"));
  expect(orchestratorMandateForDelivery(fresh)).toBe(fresh);
});

test("the role table keeps the delivered default inside the structured envelope", () => {
  const delivered = orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT);
  const section = delivered.slice(delivered.indexOf(ORCHESTRATOR_ROLE_TABLE_HEADING));
  expect(Buffer.byteLength(section)).toBeLessThan(3_000);
  /* Leave the orchestrator scaffold and a rotation's history room beside it. */
  expect(Buffer.byteLength(delivered)).toBeLessThan(MAX_STRUCTURED_TEXT_BYTES - 8_000);
});
