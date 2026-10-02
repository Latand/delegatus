import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { expect, test } from "bun:test";

import { FOCUS_TARGET_KINDS } from "@/lib/attention/targets";
import { BRIDGE_REPORT_CLASSES } from "@/lib/bridge/types";
import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { loadRoleDefinitionsOrDefaults, loadRoleRegistrySnapshot, saveRoleMapping } from "@/lib/roles/store";
import type { RegistryRoleDefinitions, RoleDefinition } from "@/lib/roles/types";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { renderTaskColorRule, TASK_COLOR_RULE } from "@/lib/tasks/colorRule";

import {
  ORCHESTRATOR_BOARD_REPORT_DIRECTIVE,
  ORCHESTRATOR_BOARD_REPORT_HEADING,
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
  ORCHESTRATOR_SHIPPED_CLOCK_OPENING,
  orchestratorMandateCarriesTickContract,
  orchestratorMandateForDelivery,
  orchestratorMandateWithRoleTable,
  orchestratorMandateStale,
  orchestratorRoleTable,
} from "./prompt";

test("the manager draft defaults to the Claude Opus alias on low effort through the role preset", () => {
  /* OrchestratorPanel seeds its shared launch controls from this live preset. */
  expect(ORCHESTRATOR_SPAWN_CONFIG).toMatchObject({ engine: "claude", model: "opus", effort: "high", role: "orchestrator" });
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
test("the default mandate is at version 36, and a v35 seat reads as stale", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(36);
  /* #1720, and again #1760 — a seat already running keeps the mandate it was
     delivered, so the version bump is the only thing that surfaces a changed
     section until its next spawn, adoption or rotation. #1749 is the change
     v18 carries (#1834): the card's text is the human's and agent context goes
     in the task's separate details field. v19 (#1843) adds the human-in-the-loop
     section. v20 (#1880) points "role per the role table" at the table
     delivery renders. v21 (#2030) carries the seat tick contract. v22 names the
     product Delegatus and says its MCP key stays `viewer`. v23 keeps work
     moving and removes tool-schema duplication from the delivered text. v24
     gives every new task an icon and a colour by one rule. v25 (#2187) says
     a spent review budget ends in one more fix and the lane completes, that
     stop-after-fix is the explicit stop, and that new review-loop stages are
     stored as a reviewer and a fix stage. v26 (#2187, D1 = A) puts every
     automatic merge, the seat's too, under the project's merge setting and
     says when to mark the lane that finishes a task. v27 (#2146) says to file
     no bridge reports while the project's Bridge reports setting is off. v28
     (#2166) opens without issue numbers, greets in plain words and runs a
     project's own release step only when the operator turned releases on.
     v29 (docs/design/orchestrator-reports.md §5.7) makes the report log the
     operator's catch-up surface: file what each wake lists as owed or due,
     under its keys, as a summary and sections in the interface language.
     v30 (docs/design/agent-prompt-contract.md) runs every piece of work as a
     pipeline whose review is a reviewer and a fix stage, teaches one verdict
     vocabulary, names no stack, and gives the seat its personality. v31
     (docs/design/board-maintenance-report.md §8) tells the seat how to read
     the board maintenance report it is sent when it is seated. v32 adds
     risk-based review budgets and the default of three rounds. */
  expect(orchestratorMandateStale(30)).toBe(true);
  expect(orchestratorMandateStale(31)).toBe(true);
  expect(orchestratorMandateStale(32)).toBe(true);
  expect(orchestratorMandateStale(33)).toBe(true);
  expect(orchestratorMandateStale(34)).toBe(true);
  expect(orchestratorMandateStale(35)).toBe(true);
  expect(orchestratorMandateStale(36)).toBe(false);
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE);
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("File what a wake lists, under its keys");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("operator's interface language (operatorLocale)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("keep these rare");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Off: file no bridge reports at all");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('onExhausted?: "advance" | "stop-after-fix" | "park"');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Use stop-after-fix only when the operator asked to look before merge");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('The kind "review-loop" is a legacy form kept for stored lanes; do not compose it.');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("You are this project's orchestrator in Delegatus");
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
  24: "3053cebbd39a69790a168102612399f4bb971b95893b1c001cf41197c9452109",
  25: "36b7de5003aead298b5bd6294aec840139503042f01260c3e797e89c512ed4d2",
  26: "4da3e6ed8d2f92540fc4fb1bcab2373a7173ca673736250ee235d8219b19b547",
  27: "1135c1274c1dc36fcc1f595035837e13f0913a818ed7d59ce1db79791de01a37",
  28: "90819032b795f74b3ac4f5bf0699f5443cf31353e95c1ad19ef87b16e8e1ab60",
  29: "220722434e6ce6a265155097b000d1ec5cbf6461e67e7d39193b61cae5b6318a",
  30: "9743e8688175e3e08fd07d54df961ff363b8798b049d50ff11973e7bf2624e69",
  31: "e1583b032cf61e67f50b486172f974ae2a2ae03649cc666b0738b010247c106d",
  32: "032c79825baef89c4f62fca96d0eeb5ac9f3f5a68aea62f316ce19d408d42e74",
  33: "651f90a57a1921b41e14a536a4178a7e47b45028ca9224dbfbd9f8fd9ec0d821",
  34: "a8097e56de1afa912ce3a2f88aea81821aafe80a79d49c000979c3b9bb2ecde3",
  35: "3a35d3334e259e60d3388454068ab6ce1836fbcf8f87b05c7207e8caf626929b",
  36: "851761d46924e3c16328ea1e31f1c768ae15d1aecb48b6ab9ee1b25c2aac9749",
};

/* #2187 §4.7, decided D1 = A: the setting governs every automatic merge. Off,
   the seat reports the PR ready and merges only when the operator asks; on,
   the runner merges and the seat leaves the lanes it holds alone and acts on
   a stopped one. §5.4: when to mark the lane that finishes a task. */
test("the merge bar follows the project's merge setting, and the mandate says when a lane finishes its task", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("merge on APPROVE");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("Merge bar: merge only on an APPROVE verdict");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("governs every automatic merge, yours included");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('Setting off: you do not merge on your own; tell the operator "PR ready: <url>" and merge only when they ask.');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("never merge a lane whose merge it holds (merge.state queued, checking, waiting-checks, updating or merging)");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("then pipeline_action retry-merge");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Red checks hold merging");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Set finishesTask: true on create_pipeline (or pipeline_action link-task with finishes: true) when this lane's PR delivers the whole task.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("For a task split into slices, mark only the lane of the last slice, or mark none and move the task yourself.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("it waits for every other started lane on the task to end");
});

/* #2166 §3.7: the mandate a newcomer's seat reads opens and greets in plain
   words, names no issue, and leaves a project's own release step off until the
   operator turns releases on for that project. */
test("the mandate opens without issue numbers, greets in plain words and runs releases only when turned on", () => {
  const opening = ORCHESTRATOR_SYSTEM_PROMPT.split("\n")[0]!;
  expect(opening).toBe("You are this project's orchestrator in Delegatus — the agent that owns its board and runs its work through Delegatus's MCP tools (registered under the key `viewer`). You never act outside them.");
  expect(opening).not.toMatch(/#\d/);
  expect(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE).toContain(`Ready in {project}.\n${CURRENT_GREETING_OFFER}`);
  expect(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE).not.toContain("lanes");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("- The project's own release step runs only when the operator has turned releases on for this project, in their message or as a standing line in your monitor note.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("release step, where it has one");
});

/* v30: a proactive seat keeps accepted work moving, so the greeting says what
   still waits for the operator's word: new work. */
const CURRENT_GREETING_OFFER = "Tell me what you want done here. I'll turn it into tasks on the board, have agents build and review it, keep it moving and report back. New work starts when you ask; I'll suggest what could come next.";

for (const [version, offer] of [
  ["v25", "Tell me what to ship — I open lanes, spawn implementers and reviewers, and merge on APPROVE. Nothing starts until you ask."],
  ["v26", "Tell me what to ship — I open lanes, spawn implementers and reviewers, and bring each PR to ready; merges follow this project's merge setting. Nothing starts until you ask."],
  ["v29", "Tell me what you want done here. I'll turn it into tasks on the board, have agents build and review it, and report back. Nothing starts until you ask."],
] as const) {
  test(`a mandate delivered with the greeting as it shipped up to ${version} greets once, in the current words`, () => {
    const shipped = ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE.replace(CURRENT_GREETING_OFFER, offer);
    expect(shipped).toContain(offer);
    const delivered = orchestratorMandateForDelivery(`Run the widgets project.\n\n${shipped}`);
    expect(delivered).not.toContain(offer);
    expect(delivered.split("## Initial visible status").length - 1).toBe(1);
    expect(delivered).toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  });
}

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
  /* v30 dropped list_flows: the seat composes no review flows. */
  [SHIPPED_TICK_CONTRACT[0]!, "then make ONE bounded pass over this project's whole board and act on what stands still: list_pipelines for lanes completed, parked or failed to spawn, the open pull requests their finished lanes left, agent_activity with liveOnly for live and stalled agents, and open tasks with nothing running."],
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

/** The clock section's heading and opening three paragraphs as they shipped
    from v11 to v29, copied verbatim from those bodies: v30 names the product
    Delegatus in them (docs/design/agent-prompt-contract.md, review of #2301). */
const SHIPPED_CLOCK_OPENING = `## The Viewer's clock — you never schedule yourself
The Viewer wakes you. A controller in the release that owns traffic checks this project's seat every few minutes and sends you a wake when something is actually owed: a stage parked, a decision waiting, a lane event landed, a board task nobody started, or the interval elapsing while work is open. It survives your session, your host dying, a Viewer restart and a rotation, because it is durable state rather than a schedule living inside a conversation.
So do not schedule yourself: no ScheduleWakeup, no CronCreate, no Monitor loop, for self-monitoring or for polling the board. A session schedule dies with the session and takes the monitor with it, which is how every rotation used to silently drop it, and two clocks on one seat means the outgoing one keeps acting after its authority is gone.
If you are holding a self-schedule right now, cancel it in this turn — the arrival of this mandate is the handover, not a later observation. Delete every recurring job you created (CronDelete on each id CronList returns) and arm no replacement. Do not wait to "see the Viewer's tick work first": while your own schedule keeps your turn open, the Viewer's tick finds you busy and drops its check every time, so the two deadlock and the wake you are waiting for can never arrive. Yours goes first.`;

/** The clock section's last paragraph as it shipped in v11–v16 and in
    v17–v20, copied verbatim from those bodies. Each shipped section is the
    shipped opening plus one of these. */
const SHIPPED_CLOCK_LAST_PARAGRAPHS = [
  "Between wakes you are idle on purpose, and idle is correct: a seat with nothing owed costs nothing. When a wake arrives, act on the items it lists and nothing else, record every outcome where it belongs, and mark a task blocked with the reason when it cannot be done — that is the stop. This paragraph outranks every playbook, skill and checkpoint convention in the checkout: one that still tells you to self-pace with wakeups is out of date, and this governs.",
  "Between wakes you are idle on purpose, and idle is correct: a seat with nothing owed costs nothing. When a wake arrives, act on the items it lists first, then make one bounded pass over the rest of the board — lanes, pull requests, agents, tasks — and act on what stands still, record every outcome where it belongs, and mark a task blocked with the reason when it cannot be done — that is the stop. This paragraph outranks every playbook, skill and checkpoint convention in the checkout: one that still tells you to self-pace with wakeups is out of date, and this governs.",
];
const shippedClockSection = (lastParagraph: string) => `${SHIPPED_CLOCK_OPENING}\n${lastParagraph}`;

/* The module's own copy, which the seat and tick tests build their older
   mandates from, is the text that shipped. */
test("the shipped clock opening the module keeps is the one that shipped", () => {
  expect(ORCHESTRATOR_SHIPPED_CLOCK_OPENING).toBe(SHIPPED_CLOCK_OPENING);
});

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
  /* v30: a review-flow round is no target a seat creates any more; the tool
     keeps the kind until the flow removal takes it. */
  expect(namedKinds?.sort()).toEqual(FOCUS_TARGET_KINDS.filter((kind) => kind !== "flowRound").sort());
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("the tool schema gives each shape");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("The shapes, verbatim:");
  /* The sentinel the tool answers with when there is nothing to move. */
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("NO_ACTIVE_VIEW");
});

/* #1026 — a fresh seat composed its first pipeline through seven sequential
   validation errors because nothing it had read named the stage shape. The
   mandate now prints that shape as the schema declares it. */
test("the mandate names explicit graph insertion and verified terminal exhaustion (#2247)", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("add-stage preserves edges; after:<stageId>");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('fail parks with "budget spent: N findings left"');
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Another gate's fail loop permits a fresh handoff; rounds stay cumulative");
});

test("the mandate carries the pipeline stage shape a first pipeline needs", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('kind: "run"');
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
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE)
    .toContain("create_pipeline and spawn_agent both refuse a task belonging to another project");
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain("takes the id as given");
  /* No invented id shape: the mandate must never teach a format the board does
     not mint. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain('"task_');
  /* Unlinking is the repair's second step, not a prohibition (taskBinding.test.ts). */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain('Never use "unlink-task" to tidy a duplicate');
  /* The task-side proof is `pipelineIds`; a manager told to look for an
     assignment reads a successful repair as a failed one. */
  expect(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE).not.toContain("get_task and confirm the launch is recorded on it");
});

/* The task-creation section carries the colour and icon rule as the rule
   module renders it, so the mandate cannot teach a rule create_task does not. */
test("the task-creation section tells the manager to pass icon and color by the one rule", () => {
  const section = ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE.slice(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE.indexOf("NAME AND DESCRIBE IT AT CREATION."));
  expect(section).toContain("Pass icon and color on every create_task");
  expect(section).toContain("when a task you touch has no colour, give it one with update_task");
  expect(section).toContain(renderTaskColorRule());
  for (const { color, icons } of TASK_COLOR_RULE) {
    expect(section).toContain(`${color} = `);
    for (const icon of icons) expect(section).toContain(icon);
  }
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

/* docs/design/board-maintenance-report.md §8: a rotation that names no mandate
   keeps the incumbent's core (#2283), so delivery is the only way a running
   seat learns how to read the report it is sent. */
test("the board report section reaches a bespoke or older mandate once, and is recognized by its heading", () => {
  const bespoke = "A seat's own mandate, written before the board maintenance report.";
  const delivered = orchestratorMandateForDelivery(bespoke);
  expect(delivered.split(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE)).toHaveLength(2);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  const reworded = `${ORCHESTRATOR_BOARD_REPORT_HEADING}
Read the report, then ask me before closing anything.`;
  expect(orchestratorMandateForDelivery(reworded)).not.toContain(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE);
  expect(orchestratorMandateForDelivery(reworded)).toStartWith(reworded);
  /* The operator's decisions of 2026-09-27: their own cards close on their
     word (D3), and a missing priority is never a request to label (D2). */
  expect(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE).toContain('a card marked "ask first" only when the operator agrees');
  expect(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE).toContain("never ask for labels or fields");
  /* The report replaces the board walk of the first turn only; the clock
     contract's per-wake pass stands beside it. */
  expect(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE).toContain("Your first turn gives status and leaves the board walk to it; later wakes still make their own pass.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("make ONE bounded pass over this project's whole board");
  expect(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE).toContain("start none unasked");
});

/* The current default carries all three inline, so a fresh seat reads each in
   place and delivery has nothing to append. */
test("the delivered default carries each directive exactly once, and delivery adds only the role table", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE);
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${orchestratorRoleTable(ROLE_DEFAULTS)}`);
  for (const directive of [
    ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE,
    ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE,
    ORCHESTRATOR_BOARD_REPORT_DIRECTIVE,
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

test("successive mandate renders read saved rows, variants and revision from the current registry", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mandate-roles-"));
  process.env.LLV_STATE_DIR = state;
  try {
    const render = (mandate: string) => orchestratorMandateForDelivery(mandate, loadRoleDefinitionsOrDefaults());
    const first = render("Bespoke mandate");
    const firstRevision = loadRoleRegistrySnapshot().revision;
    saveRoleMapping({
      builder: { config: { engine: "codex", model: "gpt-6-sol", effort: "medium" }, variants: { frontend: { engine: "claude", model: "opus", effort: "high" } } },
      reviewer: { variants: { trivial: { engine: "codex", model: "gpt-5.6-luna", effort: "medium" } } },
    });
    const nextRevision = loadRoleRegistrySnapshot().revision;
    const second = render(first);
    expect(nextRevision).not.toBe(firstRevision);
    expect(second).toContain("| builder | codex | gpt-6-sol | medium |");
    expect(second).toContain("domain=frontend: claude/opus/high");
    expect(second).toContain("size=trivial: codex/gpt-5.6-luna/medium");
    expect(second).toContain(`Registry revision: ${nextRevision}. Registry health: healthy.`);
    expect(second).not.toContain(firstRevision);
    expect(second).not.toContain("| builder | codex | gpt-6.1-sol | high |");
    expect(second.split(ORCHESTRATOR_ROLE_TABLE_HEADING)).toHaveLength(2);
    saveRoleMapping({ builder: { config: null, variants: { frontend: null } }, reviewer: { variants: { trivial: null } } });
    expect(render(second)).toBe(first);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("the delivered mandate renders the role table from the registry it is handed", () => {
  const registry: RoleDefinition[] = ROLE_DEFAULTS.map((role) => role.id === "prod-auditor"
    ? { ...role, config: { engine: "claude", model: "sonnet", effort: "low" } }
    : role);
  const delivered = orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT, registry);
  const rows = roleTableLines(delivered);

  expect(rows).toHaveLength(ROLE_DEFAULTS.length);
  expect(rows.find((row) => row.startsWith("| prod-auditor |"))).toStartWith("| prod-auditor | claude | sonnet | low | read-only |");
  expect(rows.find((row) => row.startsWith("| builder |"))).toStartWith("| builder | codex | gpt-6.1-sol | high | read-write |");
  expect(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT)).toContain("| prod-auditor | codex | gpt-6.1-sol | xhigh | read-only |");
});

test("the role table carries the runtime guidance beside it", () => {
  const delivered = orchestratorMandateForDelivery("Bespoke mandate");
  const section = delivered.slice(delivered.indexOf(ORCHESTRATOR_ROLE_TABLE_HEADING));
  expect(section).toContain("Omitting engine, model and effort");
  expect(section).toContain("on the stage");
  expect(section).toMatch(/low or medium/);
  expect(section).toContain("NEXT attempt");
  expect(section).toContain("create_pipeline");
  /* The standing model rules (model landscape 2026-09) ride in the role rows;
     the builder's description names no model (agent-prompt-contract.md
     §2.10 B), since runtime advice belongs to the table's notes. */
  expect(section).toContain("| builder | codex | gpt-6.1-sol | high | read-write | Writes product code for a scoped brief.");
  expect(section).toContain("High per lane for risky backend diffs.");
  expect(section).toContain("claude/fable/high per lane for the largest cross-cutting designs");
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
  expect(table).toContain("domain=frontend: claude/sonnet/high");
  expect(table).toContain("mode=apply-fixes: codex/gpt-5.6-luna/xhigh");
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
  /* The sizing rule (docs/design/model-sizing-tiers.md §4) and the variant
     runtimes took the table past its first 3 000-byte bound. */
  expect(Buffer.byteLength(section)).toBeLessThan(3_300);
  /* Leave the orchestrator scaffold and a rotation's history room beside it.
     The sizing rule (docs/design/model-sizing-tiers.md §4) takes 200 bytes of
     that room, and keeping the review-loop read-only rule beside it another
     100; the UI-lane recipe (Opus brief, Sonnet build, Opus review) another
     100 net of the table words trimmed to make room; a rotation trims its
     history to what is left. v30 takes 2 850 more
     for one contract every agent reads (docs/design/agent-prompt-contract.md:
     how work runs, the stage contract, the fix rows) and the seat's
     personality; its scaffold gave 200 back. v31 takes 700 more for the
     board maintenance report section, paid for by the open-task list the
     rotation handoff no longer carries (docs/design/board-maintenance-report.md
     §5.5); handoffDigest.test.ts pins what that leaves a rotation's history.
     The scheduled maintainer row uses another 200 bytes of that room. */
  expect(Buffer.byteLength(delivered)).toBeLessThan(MAX_STRUCTURED_TEXT_BYTES - 3_900);
});

/* docs/design/model-sizing-tiers.md §4: the seat sizes every lane, reads each
   variant's runtime from the table, and hears about a reset row. */
test("the role table tells the seat to size lanes, lists every variant and names a reset row", () => {
  const roles = ROLE_DEFAULTS.map((role) => ({ ...role })) as RegistryRoleDefinitions;
  Object.defineProperty(roles, "registry", {
    value: {
      revision: "roles-1-reset",
      health: { state: "healthy" },
      resets: [{ id: "2026-09-builder-frontend-opus-xhigh", row: "builder:frontend", from: { engine: "claude", model: "opus", effort: "xhigh" }, at: "2026-09-27T08:00:00.000Z" }],
    },
  });
  const table = orchestratorRoleTable(roles);
  const builderRow = table.split("\n").find((line) => line.startsWith("| builder |"))!;
  /* Variants that share a runtime are listed once under it. */
  expect(builderRow).toContain("size=trivial, domain=frontend, domain=docs, domain=frontend mode=apply-fixes, domain=docs mode=apply-fixes: claude/claude-sonnet-5-5/high; mode=apply-fixes: codex/gpt-6-luna/high.");
  const reviewerRow = table.split("\n").find((line) => line.startsWith("| reviewer |"))!;
  expect(reviewerRow).toContain("size=trivial: codex/gpt-6-luna/high.");
  expect(table).toContain("- Size each lane first. trivial (a few lines of UI, copy, one flag or label; your brief states the exact change and its acceptance): builder and reviewer size=trivial, one review round.");
  expect(table).toContain("design (options, architecture, proposals, issues from design work): an architect stage first");
  /* The Sonnet 5.5 / Opus 5.5 table (docs/design/model-sizing-tiers.md §7). */
  expect(table).toContain("- Sonnet 5.5 for well-scoped build, fix, docs, verification, repeated work. Opus 5.5 for design, orchestration, judgment-heavy or long-horizon lanes (engine redesigns, deploy/runtime host, accounts/migration, security, cross-cutting refactors), hardest problems. Review backend on Codex, frontend on Opus.");
  expect(table).toContain("- size=trivial and a hand-set Sonnet builder need a brief from a large model (Opus, Fable, large Codex). Sonnet never orchestrates, architects or reviews above size=trivial.");
  expect(table).toContain("- UI lane: Opus read-only brief stage (files, states, 390px and desktop, what not to touch), builder domain=frontend, Opus review-loop.");
  /* §3 (a): the fix stage's params select its row. */
  expect(table).toContain("- Fix stages: builder mode=apply-fixes with the implementer's domain and size, on the builder row they select.");
  /* Review of #2301: a fix round takes what names its place, an OVER-BUILT cut
     included, and the seat is told that the rest parks the lane. */
  expect(table).toContain("OVER-BUILT cuts included");
  expect(table).toContain("which parks the lane: re-plan it.");
  expect(table).toContain("README, docs, public text: builder domain=docs.");
  expect(table).toContain("runtimeLine (spawn_agent: runtime)");
  expect(table).toContain("- Runtime overrides go on the stage. override-stage binds from the NEXT attempt.");
  expect(table).toContain("quote runtime, size and reason");
  expect(table).toContain("builder:frontend (was claude/opus/xhigh); tell the operator");
  /* Delivery replaces the table up to the first blank line, so it carries none. */
  expect(table).not.toContain("\n\n");
  const delivered = orchestratorMandateWithRoleTable("Bespoke mandate", table);
  expect(orchestratorMandateWithRoleTable(delivered, table)).toBe(delivered);
});

/* docs/design/agent-prompt-contract.md §2.11 review check: the mandate a seat
   is delivered names no language, tool, topology or this product's own code,
   and teaches one verdict vocabulary. The retired markers appear once, in the
   brief rule that tells the seat never to write them. */
const STACK_SPECIFIC = [/\btsc\b/, /bunx/, /TypeScript/, /blue\/green/, /external-worker/, /conveyor/i, /8898/, /Ukrainian/, /review flow/i, /list_flows/, /flowRound/, /review review/, /file ownership/, /one owner per file/, /\/api\//];

test("the delivered default names no stack and teaches one verdict vocabulary (v30)", () => {
  const delivered = orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT);
  for (const pattern of STACK_SPECIFIC) expect(delivered).not.toMatch(pattern);
  expect(delivered).not.toContain("COMMENT");
  for (const marker of ["REVIEW_READY", "NO FINDINGS"]) expect(delivered.split(marker)).toHaveLength(2);
  /* The two retired VERDICT lines are named exactly, in the one retiring sentence. */
  expect(delivered.match(/VERDICT/g)).toEqual(["VERDICT", "VERDICT"]);
  expect(delivered).toContain("never write REVIEW_READY, VERDICT: APPROVE, VERDICT: REQUEST_CHANGES or NO FINDINGS into a brief");
  /* A GitHub issue is attached when one exists and never waited for. */
  expect(delivered).toContain("no step waits for an issue");
  /* Recommended when the project has GitHub, never mandatory (operator, 2026-09-27). */
  expect(delivered).toContain("When the project has a GitHub remote, open or reuse an issue where it helps tracking and attach it to the lane (pipeline_action attach-link)");
  /* Review of #2301: the merge bar names the lanes Delegatus merges
     (forge/autoMerge.ts mergeEligible): reviews passed, or budget spent with
     the last fix passed, whose kept findings the seat reads. */
  expect(delivered).toContain("or spent their budget with the last fix passed and you have read the findings they kept");
  expect(delivered).toContain("Delegatus merges a completed lane whose reviews passed, or spent their budget with the last fix passed");
  expect(delivered).toContain("and nobody reads a spent budget's kept findings first;");
  /* One condition for stop-after-fix, stated once (review of #2301). */
  expect(delivered.match(/stop-after-fix only when|use stop-after-fix when/g)).toEqual(["stop-after-fix only when"]);
  expect(delivered).not.toContain("kept for you to read before you merge");
  /* The worker cap holds in every mode, in the scaffold's words. */
  /* A seat designated onto an existing conversation gets no scaffold, so the
     mandate names the default cap itself (review of #2301). */
  expect(delivered).toContain("Keep no more workers running at once than your role parameters allow (3 when they name none), in every mode: each running lane and each live spawned agent counts as one.");
});

/* The operator, 2026-09-27: a friend who teases a little, speaks their way,
   and keeps working. Each line that could read against "proactive" says what
   it means instead: accepted work moves unasked, new work waits for their
   word, and the drive lives inside the turns the seat is given. */
test("the seat's personality is proactive inside accepted work, and every line agrees", () => {
  const section = ORCHESTRATOR_SYSTEM_PROMPT.slice(ORCHESTRATOR_SYSTEM_PROMPT.indexOf("## Who you are"), ORCHESTRATOR_SYSTEM_PROMPT.indexOf("## Initial visible status"));
  expect(section).toContain("likes to tease a little");
  expect(section).toContain("Mirror how the operator talks: language, register, brevity, and their casual words when they use them.");
  expect(section).toContain("You are hard-working and want to keep going");
  expect(section).toContain("never start work nobody asked for, or change what the operator owns");
  expect(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE).not.toContain("Nothing starts until you ask");
  expect(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE).toContain("New work starts when you ask");
  expect(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE).toContain("Between wakes you are idle on purpose, and idle is correct: a seat with nothing owed costs nothing. Your drive to keep going works inside a turn: take every owed step before it ends.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Proactive means carrying accepted work to its merge bar and its owed reports unasked; new work you see is a proposal, started when the operator says so.");
});

/* A v29 seat's stored clock section is replaced by exact match, so its board
   pass stops listing review flows; a reworded section stays its author's. */
test("delivery replaces the clock section a v29 mandate carries", () => {
  const v29Section = shippedClockSection(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE.split("\n").slice(4).join("\n")
    .replace(" Your drive to keep going works inside a turn: take every owed step before it ends.", "")
    .replace("their finished lanes left, agent_activity", "their finished lanes left, list_flows, agent_activity"));
  expect(v29Section).toContain("list_flows");
  const delivered = orchestratorMandateForDelivery(`Run the widgets project.\n\n${v29Section}`);
  expect(delivered).not.toContain("list_flows");
  expect(delivered.split(ORCHESTRATOR_VIEWER_CLOCK_HEADING)).toHaveLength(2);
  expect(delivered).toStartWith(`Run the widgets project.\n\n${ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE}`);
  expect(orchestratorMandateCarriesTickContract({ mandate: `Run the widgets project.\n\n${v29Section}`, promptVersion: 29 })).toBe(true);
});

/* §3 (c2): a scaffold this install replaced stops every shipped prompt change,
   so the table names it and the seat can tell the operator. */
test("the role table names a role whose prompt text this install replaced", () => {
  expect(orchestratorRoleTable(ROLE_DEFAULTS)).not.toContain("Prompt text overridden");
  const roles = ROLE_DEFAULTS.map((role) => role.id === "deployer" ? { ...role, promptScaffold: "An install's own deployer text." } : role);
  const table = orchestratorRoleTable(roles);
  expect(table).toContain("- Prompt text overridden by this install: deployer. Shipped prompt changes do not reach these roles; tell the operator, who can restore the shipped text in the agent mapping.");
  expect(table).not.toContain("\n\n");
});

/* Review of #2301: text a seat reads names the product Delegatus, and a seat
   whose clock section still carries the heading it shipped with up to v29
   keeps its own wording under it and gets no second section. */
test("the delivered mandate names no Viewer, and the v29 clock heading still marks a seat's own section", () => {
  const delivered = orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT);
  expect(delivered.replaceAll("`viewer`", "")).not.toMatch(/\bviewer\b/i);
  expect(delivered).not.toContain("owns traffic");
  const reworded = `## The Viewer's clock — you never schedule yourself\nWake only when told.`;
  const kept = orchestratorMandateForDelivery(`Run the widgets project.\n\n${reworded}`);
  expect(kept).toContain(reworded);
  expect(kept).not.toContain(ORCHESTRATOR_VIEWER_CLOCK_HEADING);
  expect(kept.split("you never schedule yourself")).toHaveLength(2);
});

test("the mandate chooses an explicit review budget from consequences and probability", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("Choose review rounds from risk = consequences × probability: low risk 1; normal risk 2; high risk (data loss, security, production, runtime host, migrations) 3. The default is 3. More than 3 only when the operator asks; state the reason in the brief.");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain("unlimited");
});

test("agent-facing review skills agree with the mandate's risk budget", () => {
  for (const name of ["delegatus-conveyor", "review-loop"]) {
    const skill = fs.readFileSync(path.join(import.meta.dir, `../../../.claude/skills/${name}/SKILL.md`), "utf8");
    expect(skill).toContain("risk = consequences × probability: low risk 1; normal risk 2; high risk (data loss, security, production, runtime host, migrations) 3.");
    expect(skill).toContain("The default is 3. More than 3 only when the operator asks; state the reason in the brief.");
    expect(skill).not.toMatch(/roundLimit"?:? ?5|5–7 substantive|9–13/);
  }
  const reviewLoop = fs.readFileSync(path.join(import.meta.dir, "../../../.claude/skills/review-loop/SKILL.md"), "utf8");
  expect(reviewLoop).toContain('"roundLimit": 3');
  expect(reviewLoop).toContain("Unlimited review requires an explicit operator request and `roundLimit: 0`.");
});

test("the versioned mandate asks for a current status note in the operator's language", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("update_task note");
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("waiting on whom/what");
});
