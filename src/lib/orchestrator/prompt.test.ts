import { shortId } from "@/lib/shortIds";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { expect, test } from "bun:test";

import { ROLE_DEFAULTS, WORKING_RULES, WORKING_RULES_SHORT } from "@/lib/roles/defaults";
import { launchOverheadBytes } from "./handoffDigest";
import { loadRoleDefinitionsOrDefaults, loadRoleRegistrySnapshot, saveRoleMapping } from "@/lib/roles/store";
import { resolveSpawnRole, roleSpawnPrompt } from "@/lib/roles/registry";
import type { RegistryRoleDefinitions, RoleDefinition } from "@/lib/roles/types";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import {
  ORCHESTRATOR_BOARD_REPORT_DIRECTIVE,
  ORCHESTRATOR_BOARD_REPORT_HEADING,
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_PROTOTYPE_DIRECTIVE,
  ORCHESTRATOR_REPORTS_AND_PROJECTS_DIRECTIVE,
  ORCHESTRATOR_REPORTS_AND_PROJECTS_HEADING,
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
  orchestratorMandateUpgraded,
  orchestratorMandateWithRoleTable,
  orchestratorMandateStale,
  orchestratorRoleTable,
} from "./prompt";

test("the manager draft defaults to the Claude Opus alias on low effort through the role preset", () => {
  /* OrchestratorPanel seeds its shared launch controls from this live preset. */
  expect(ORCHESTRATOR_SPAWN_CONFIG).toMatchObject({ engine: "claude", model: "opus", effort: "high", role: "orchestrator" });
});

/* Seats record the mandate version they were spawned on; `get_orchestrator` reports
   this constant as defaultPromptVersion, so an older seat reads as stale without a diff. */
test("the default mandate is at version 58, and a v57 seat reads as stale", () => {
  expect(ORCHESTRATOR_PROMPT_VERSION).toBe(58);
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
     risk-based review budgets and the default of three rounds. v40 (#2518)
     adds the ask-first bug report and the seat-to-seat rule for another
     project's work. v41 points the operator to a task's prototype review
     instead of describing variants in prose. v42 clears waiting rows that ask
     nothing. v43 adds the questionnaire before ambiguous work. v44 combines
     both with linked-seat coordination. v46 marks a report of a handled
     incident or an outside publication with `outcome`. v47 makes every decision
     a form (docs/design/operator-decision-forms.md §2.7). v48 denies native
     asks; v49 keeps forms without a task and asks 3–7 on a task. v50
     shortens equivalent draft wording to keep the delivery reserve. v51
     retains the reviewed branch's refreshing fence alongside those rules. v52
     combines them with automatic release control and incident holds. v53
     adds the machine-wide worker limit while retaining those rules. v54 puts
     waiting and repeated unanswered asks into forms. v55 (the operator's
     variant 4 of docs/design/role-prompts-rewrite.md) leaves the universal
     rules to the role prompt's working rules and holds tasks instead of
     marking them blocked. v56 (the operator, 2026-10-15) retires reply drafts:
     every ask, the bug report's two included, goes through a decision form. v57
     (the operator, 2026-10-16) sends a proposal beyond the literal request to a
     decision form, not to chat. v58 (the operator, 2026-10-20) states the
     maintenance practice of docs/design/gpt-6-maintenance.md in every
     installation's mandate, and ships the working rule 16 #3083 rewrote. */
  expect(orchestratorMandateStale(30)).toBe(true);
  expect(orchestratorMandateStale(31)).toBe(true);
  expect(orchestratorMandateStale(32)).toBe(true);
  expect(orchestratorMandateStale(33)).toBe(true);
  expect(orchestratorMandateStale(34)).toBe(true);
  expect(orchestratorMandateStale(35)).toBe(true);
  expect(orchestratorMandateStale(36)).toBe(true);
  expect(orchestratorMandateStale(37)).toBe(true);
  expect(orchestratorMandateStale(38)).toBe(true);
  expect(orchestratorMandateStale(39)).toBe(true);
  expect(orchestratorMandateStale(40)).toBe(true);
  expect(orchestratorMandateStale(41)).toBe(true);
  expect(orchestratorMandateStale(42)).toBe(true);
  expect(orchestratorMandateStale(43)).toBe(true);
  expect(orchestratorMandateStale(44)).toBe(true);
  expect(orchestratorMandateStale(45)).toBe(true);
  expect(orchestratorMandateStale(46)).toBe(true);
  expect(orchestratorMandateStale(47)).toBe(true);
  expect(orchestratorMandateStale(48)).toBe(true);
  expect(orchestratorMandateStale(49)).toBe(true);
  expect(orchestratorMandateStale(50)).toBe(true);
  expect(orchestratorMandateStale(51)).toBe(true);
  expect(orchestratorMandateStale(52)).toBe(true);
  expect(orchestratorMandateStale(53)).toBe(true);
  expect(orchestratorMandateStale(54)).toBe(true);
  expect(orchestratorMandateStale(55)).toBe(true);
  expect(orchestratorMandateStale(56)).toBe(true);
  expect(orchestratorMandateStale(57)).toBe(true);
  expect(orchestratorMandateStale(58)).toBe(false);
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
  37: "354299e815ca8a1bf68cb465bfc935919bb543fdca02a4e1ba5af45e16663e81",
  38: "387a04753adca331c8c0c2d149d75a3be428911cfabf5c8d82a10d6db7af040b",
  39: "2fb23f0ae08fdc4eaccbe7940fa3b9ff91740c6ab9c3b268c96e9b069829ad03",
  40: "f47058676c2751ec1e7c4031d082b6c513df41c5e085774975e508ebf626427c",
  41: "3a2ea3525bcb81cd062e2f6388fd4540a618442b003ae9479e383f1dbb363448",
  42: "87da100ab11b67c8309e22764c89bc37c8b81922eb358e4c2adb2eef8ce82688",
  43: "4c55ef1e031677516bba9dbd27fcc0e86e3805bc57f5080c1f8317400c726c0f",
  44: "34697f21c8943d0cdeb8ae45260d613de72c91cac67fd8888f06ced89cf79cbc",
  45: "13f8d5ab3ce3a2770245d7c87fd1f534139b76c3cd02c48c518e0f6056adb26c",
  46: "2f8d1ef97f331cb982a32746575816ea2d1fe5a4869c17a6329f05033b3f15f1",
  47: "0a204f45fe2e477c20d14888313530363eece18a53e608f8a8f427fb5ef3241c",
  48: "b5ac29298046ae89343fee1ea5d7149bd9b26d2bc8b4270300e5ca7892dd2ce2",
  // The reviewed refresh branch independently used v46 with fingerprint
  // b5640fe536df8622b6e84e9500e27418742d6b25b830a7821d795e82d5651222,
  // then v49 with 8c62ea15caffab8bcddd09e68756275fb21d82113f3e400c47e9496d5f8155c0.
  // Keep main's version history; v51 combines both branches' mandate rules.
  49: "1fb19f7e3d633f95f46e7c2353fefa2cb2d00f74adfe3ace721c0d4c88336c47",
  50: "e693c187ca781f08d3612007ff7829e3baf4ec5f64c69d7e4966fd091cdb4cb8",
  // The automatic release branch independently used v51 with fingerprint
  // baf75098802ed3f0ebe3ad97b183ff917536f12f8e32086cda86f9224e1dbc89.
  // v52 combines its release rule with main's refreshing fence.
  51: "16ededfd81b40430ab1f9d48abe8155b77411e725b5c478a28ae3d7d2a24d54b",
  52: "faa19a0588778962bad646ccf910e8fd68c7894fa09d5b62ce89c80819f3774a",
  // The worker-limit branch independently used v49 with fingerprint
  // a50133384753b7ad25d86b7792dcfa19ec54feb944776cbc4ebc93a62a7f2f22.
  // v53 combines its worker-limit rule with main's mandate.
  53: "28e34e893a3677250f71ccad3a56a58f0c5188a34e9eb6f9812910b465e1f5d6",
  // v54 keeps waiting and repeated unanswered asks in forms.
  54: "d0a97d9a92192e47a48cc4d4e59b60476717ae1ecc78fd252ffd8de2e1bf304e",
  // v55 is variant 4 of docs/design/role-prompts-rewrite.md.
  55: "61412fba0b5617e722a1761a69e3550976315a4615bdda0b5ff841bcdaaac4b4",
  // v56 retires reply drafts: every ask goes through a decision form.
  56: "b3d3166f2c01b81db853ccd15e4182c0c88ed9b46be86e52a2ab613b5f32950a",
  // v57 puts a proposal beyond the literal request in a decision form.
  57: "928041c147b9f068a23674313b33c285c78555fa6a8afc0a89aeb20f49e99639",
  // v58 states the maintenance practice and ships #3083's working rule 16.
  58: "632ee54064e12e71db96a1ed427d0fc6f59566d6983d4b659429056ca7f4fb38",
};

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

/* Delivery adds each current tick-contract clause once to a bespoke mandate. */
const CLAUSE_IN_MANDATE: readonly string[] = [
  "then make ONE bounded pass over this project's whole board and act on what stands still: list_pipelines for lanes completed, parked or failed to spawn, the open pull requests their finished lanes left, agent_activity with liveOnly for live and stalled agents, and open tasks with nothing running.",
  "Record every outcome on the board card or the pipeline, not only in this conversation.",
  "set its task's hold with the reason: that is the stop, and the only one.",
  "So do not schedule yourself",
  "seat_tick_settings turns the tick off or on, or changes how often it wakes you, per project, with a reason shown on the board.",
  "Never wait on the operator inside a wake's turn.",
];

test("every clause the tick contract carried lives in the mandate, and reaches every seat once (#2030)", () => {
  /* A bespoke mandate is exactly the one without it, and delivery is what gives
     it the section, once. */
  const bespoke = "A seat's own mandate, carried through a rotation.";
  const delivered = orchestratorMandateForDelivery(bespoke);
  for (const stated of CLAUSE_IN_MANDATE) expect(delivered.split(stated)).toHaveLength(2);
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
    ORCHESTRATOR_REPORTS_AND_PROJECTS_DIRECTIVE,
    ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ]) {
    expect(ORCHESTRATOR_SYSTEM_PROMPT.split(directive)).toHaveLength(2);
  }
});

/* #2518: both rules, in the default and in whatever mandate a seat holds. */
test("the mandate asks before a bug report is filed, publishes only an approved preview, and sends another project's work to its seat", () => {
  const section = ORCHESTRATOR_REPORTS_AND_PROJECTS_DIRECTIVE;

  /* A bespoke mandate receives both required rules once. A retained heading
     cannot suppress them when its body was edited or removed. */
  const delivered = orchestratorMandateForDelivery("Run this project.");
  expect(delivered.split(section)).toHaveLength(2);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  for (const body of ["", "My own wording.", "Ask before filing issues.", "Route another project's work to its orchestrator."]) {
    const reworded = `Run this project.\n\n${ORCHESTRATOR_REPORTS_AND_PROJECTS_HEADING}\n${body}`;
    const deliveredEdit = orchestratorMandateForDelivery(reworded);
    expect(deliveredEdit).toStartWith(reworded);
    expect(deliveredEdit.split(section)).toHaveLength(2);
    expect(orchestratorMandateForDelivery(deliveredEdit)).toBe(deliveredEdit);
    expect(orchestratorMandateWithRoleTable(reworded, null)).toContain(section);
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
    expect(second).toContain(`Registry revision: ${shortId(nextRevision)}. Registry health: healthy.`);
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
     runtimes took the table past its first 3 000-byte bound, and the
     visual-critic row with its UI-lane step past 3 300. */
  expect(Buffer.byteLength(section)).toBeLessThan(3_500);
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
     The scheduled maintainer row uses another 200 bytes of that room. v40
     (#2518) takes 1 100 more: the bug report and other-project section and
     the issue-reporter row. The visual-critic row and the UI-lane step that
     ends on it take 150 more. The prototype-review pointer adds 47 bytes;
     the delivered default includes the questionnaire, board cleanup and
     linked-seat coordination alongside the applyNow pointer: 29 367 bytes,
     and the pointer to the rule for a report's `outcome` 18 more.
     The scaffold is 750 bytes, and
     handoffDigest.test.ts still finds a full history section beside it. */
  /* v55 carries the working rules in their short form (WORKING_RULES_SHORT)
     and the seat's scaffold gave 534 bytes back (750 → 216): scaffold and
     delivered default together leave a rotation's history the room v54 left. */
  /* v58 takes 536 bytes for the maintenance practice (the operator,
     2026-10-20: the mandate may grow to state it fully): delivered 29 576 →
     30 112 bytes, both bounds 300 higher. The scaffold and the spawn envelope
     still fit with 1 673 bytes to spare; handoffDigest.test.ts states what the
     same 536 bytes take from a rotation's history. */
  expect(Buffer.byteLength(delivered)).toBeLessThan(MAX_STRUCTURED_TEXT_BYTES - 1_850);
  expect(Buffer.byteLength(delivered) + launchOverheadBytes("spawn", { mode: "standard" })).toBeLessThan(MAX_STRUCTURED_TEXT_BYTES - 1_650);
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
  expect(table).toContain("builder:frontend (was claude/opus/xhigh); tell the operator");
  /* Delivery replaces the table up to the first blank line, so it carries none. */
  expect(table).not.toContain("\n\n");
  const delivered = orchestratorMandateWithRoleTable("Bespoke mandate", table);
  expect(orchestratorMandateWithRoleTable(delivered, table)).toBe(delivered);
});

/* A v29 seat's stored clock section is replaced by exact match, so its board
   pass stops listing review flows; a reworded section stays its author's. */
test("delivery replaces the clock section a v29 mandate carries", () => {
  const v29Section = shippedClockSection(ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE.split("\n").slice(3).join("\n")
    .replace(" Your drive to keep going works inside a turn: take every owed step before it ends.", "")
    .replace("their finished lanes left, agent_activity", "their finished lanes left, list_flows, agent_activity")
    .replace("set its task's hold with the reason", "mark its task blocked with the reason"));
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
  const reworded = `## The Viewer's clock — you never schedule yourself\nWake only when told.`;
  const kept = orchestratorMandateForDelivery(`Run the widgets project.\n\n${reworded}`);
  expect(kept).toContain(reworded);
  expect(kept).not.toContain(ORCHESTRATOR_VIEWER_CLOCK_HEADING);
  expect(kept.split("you never schedule yourself")).toHaveLength(2);
});

test("the mandate asks every decision as a form", () => {
  for (const mandate of [ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateForDelivery("Coordinate the project.")]) {
    expect(mandate).toContain(ORCHESTRATOR_PROTOTYPE_DIRECTIVE);
  }
});

test("the decision-form mandate upgrades every shipped pointer once and preserves bespoke wording", () => {
  const directive = ORCHESTRATOR_PROTOTYPE_DIRECTIVE;
  const questionnaire = `Prototype review: point to the task's review. Before work that is non-trivial or reads two ways, or on request, ask 3–7 questions there; the operator may skip. After the answers, write "how I understood" (3–5 lines) into the task text and start.`;
  const shipped = [
    "Prototype review: every decision is a form: publish_prototype_review, 1–7 questions, taskId for a task; chat and reports only point to it. Before non-trivial or two-way work, or on request, ask 3–7 there. After answers, write \"how I understood\" (3–5 lines) in the task text and start.",
    "Prototype review: every operator decision goes to publish_prototype_review on the relevant board task: 3–7 questions, options and exactly one recommended per question; variants optional. Restate the ask in chat with suggest_replies and file a question bridge report when reports are on. Never use engine built-in ask tools. Before non-trivial or two-way work, or on request, use this form; the operator may skip. After answers, write \"how I understood\" (3–5 lines) in task text and start.",
    "Prototype review: every operator decision is a form: publish_prototype_review; taskId for a task (3–7 questions), omit it without a task (1–7). Give options with exactly one recommended per question; variants optional. Chat and reports only point to the form. Never use engine built-in ask tools. Before non-trivial or two-way work, or on request, use a form; the operator may skip. After answers, write \"how I understood\" (3–5 lines) in task text and start.",
  ];
  for (const input of [ORCHESTRATOR_SYSTEM_PROMPT, "Coordinate the project.", "Coordinate.\nPrototype review: point to the task's review.", `Coordinate.\n\n${questionnaire}`, ...shipped]) {
    const delivered = orchestratorMandateForDelivery(input);
    expect(delivered).toContain(directive);
    expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
    expect(delivered.split(directive)).toHaveLength(2);
  }
  for (const previous of shipped) expect(orchestratorMandateForDelivery(previous)).not.toContain(previous);
  expect(orchestratorMandateForDelivery("Prototype review: our own wording.")).toContain("Prototype review: our own wording.");
});

test("the board walk clears only rows that ask nothing and replaces the shipped paragraph exactly", () => {
  const previous = `## Reading the board maintenance report\nEach time you are seated, Delegatus makes one read-only pass over this board and sends it after your first turn, headed "[Delegatus] Board maintenance report". Your first turn gives status and leaves the board walk to it; later wakes still make their own pass. Take its sections in order and re-read each item before you change it. You alone change this board: close items one by one with the reason, and a card marked "ask first" only when the operator agrees. Offer its suggested issues with suggest_replies and start none unasked; where it finds no recorded priority, say so once and never ask for labels or fields. Cover an unavailable section or a missing report with your own reads.`;
  // Use the current heading; only the paragraph has changed between releases.
  const shipped = previous.replace(previous.split("\n")[0]!, ORCHESTRATOR_BOARD_REPORT_DIRECTIVE.split("\n")[0]!);
  expect(orchestratorMandateForDelivery(shipped)).toContain(ORCHESTRATOR_BOARD_REPORT_DIRECTIVE);
  expect(orchestratorMandateForDelivery(shipped.replace("Take its sections", "Walk its sections"))).toContain("Walk its sections");
});

/* A seat delivered v54 keeps its stored mandate until it rotates; delivery
   replaces each v54 directive that v55 rewrote by exact match, so the seat
   reads one current copy and no stale one, and removes the v54 section on
   reply drafts the same way, so the seat is never told to ask with them. The
   fixture is the v54 default byte for byte: its fingerprint is the one v54
   shipped with. */
test("delivery replaces every rewritten v54 directive by exact match", () => {
  const v54 = fs.readFileSync(path.join(import.meta.dir, "fixtures/mandate-v54.txt"), "utf8");
  expect(createHash("sha256").update(v54).digest("hex")).toBe(PROMPT_FINGERPRINTS[54]);
  const delivered = orchestratorMandateForDelivery(v54);
  for (const directive of [ORCHESTRATOR_VIEWER_CLOCK_DIRECTIVE, ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE, ORCHESTRATOR_PROTOTYPE_DIRECTIVE, ORCHESTRATOR_BOARD_REPORT_DIRECTIVE, ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE]) {
    expect(delivered.split(directive)).toHaveLength(2);
  }
  for (const stale of ["mark its task blocked with the reason", "no ScheduleWakeup, no CronCreate", "GIVE IT AN ICON AND A COLOUR.", "Prototype review: every operator decision is a form"]) {
    expect(v54).toContain(stale);
    expect(delivered).not.toContain(stale);
  }
  for (const retired of ["suggest_replies", "Reply drafts"]) expect(v54).toContain(retired);
  for (const retired of ["suggest_replies", "Reply drafts", "reply draft"]) expect(delivered).not.toContain(retired);
  /* Removing the section leaves one blank line between its neighbours. */
  expect(delivered).toContain("Targets are typed by kind (conversation, stage, pipeline, task, draft, region, point) and the tool schema gives each shape and intent.\n\n## Delegatus's clock");
  expect(delivered).not.toContain("\n\n\n");
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  expect(orchestratorMandateWithRoleTable(v54, null)).toBe(orchestratorMandateWithRoleTable(orchestratorMandateWithRoleTable(v54, null), null));
  expect(orchestratorMandateCarriesTickContract({ mandate: v54, promptVersion: 54 })).toBe(true);
  /* A bespoke section under the same heading keeps its own wording. */
  const bespoke = "## Reply drafts (suggest_replies)\nOur own wording about replies.";
  expect(orchestratorMandateForDelivery(`Coordinate.\n\n${bespoke}`)).toContain(bespoke);
});

/* A seat delivered v55 keeps its stored mandate until it rotates; delivery
   replaces the two directives v56 rewrote and removes the reply-draft
   paragraph, each by exact match, so the seat is never told to ask with reply
   drafts. The fixture is the v55 default byte for byte. */
test("delivery takes every reply-draft instruction out of a v55 mandate by exact match", () => {
  const v55 = fs.readFileSync(path.join(import.meta.dir, "fixtures/mandate-v55.txt"), "utf8");
  expect(createHash("sha256").update(v55).digest("hex")).toBe(PROMPT_FINGERPRINTS[55]);
  expect(v55).toContain("suggest_replies");
  const delivered = orchestratorMandateForDelivery(v55);
  for (const directive of [ORCHESTRATOR_PROTOTYPE_DIRECTIVE, ORCHESTRATOR_BOARD_REPORT_DIRECTIVE, ORCHESTRATOR_REPORTS_AND_PROJECTS_DIRECTIVE]) {
    expect(delivered.split(directive)).toHaveLength(2);
  }
  for (const retired of ["suggest_replies", "Reply drafts", "reply draft"]) expect(delivered).not.toContain(retired);
  /* Removing the paragraph leaves its neighbours as the current body has them. */
  expect(delivered).toContain(`${ORCHESTRATOR_PROTOTYPE_DIRECTIVE}\nBridge reports.`);
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  /* With the role table set aside, the delivered v55 mandate is the current one. */
  expect(orchestratorMandateWithRoleTable(orchestratorMandateUpgraded(v55), null)).toBe(orchestratorMandateWithRoleTable(ORCHESTRATOR_SYSTEM_PROMPT, null));
  expect(orchestratorMandateCarriesTickContract({ mandate: v55, promptVersion: 55 })).toBe(true);
  /* A bespoke mandate's own wording about replies survives. */
  expect(orchestratorMandateForDelivery("Coordinate. Reply drafts: our own wording.")).toContain("Reply drafts: our own wording.");
});

/* A seat delivered v56 keeps its stored mandate until it rotates; delivery
   replaces the literal-request sentence v57 rewrote by exact match, so the seat
   proposes in a decision form and not in chat. The fixture is the v56 default
   byte for byte. */
test("delivery sends a v56 mandate's proposals to a decision form by exact match", () => {
  const v56 = fs.readFileSync(path.join(import.meta.dir, "fixtures/mandate-v56.txt"), "utf8");
  expect(createHash("sha256").update(v56).digest("hex")).toBe(PROMPT_FINGERPRINTS[56]);
  expect(v56).toContain("is a proposal offered in chat and acted on only after their yes");
  const delivered = orchestratorMandateForDelivery(v56);
  expect(delivered).not.toContain("offered in chat");
  expect(delivered).toContain("anything beyond the literal request is a proposal, put to the operator in a decision form and acted on only after their yes.");
  expect(orchestratorMandateWithRoleTable(orchestratorMandateUpgraded(v56), null)).toBe(orchestratorMandateWithRoleTable(ORCHESTRATOR_SYSTEM_PROMPT, null));
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  /* A bespoke mandate's own wording about proposals survives. */
  expect(orchestratorMandateForDelivery("Coordinate. Proposals are offered in chat.")).toContain("Proposals are offered in chat.");
});

/* docs/design/gpt-6-role-prompts.md §3.3, the operator's answer of
   2026-10-20: the seat's maintenance practice is product text in every
   installation's mandate, one bullet beside the declared-outputs rule, and it
   names no project's paths. */
const MAINTENANCE_BULLET_START = "- Maintenance (dead code, stale mechanisms, flaky tests, check cost) is report first:";

function maintenanceBullet(text: string): string {
  const start = text.indexOf(MAINTENANCE_BULLET_START);
  return start < 0 ? "" : text.slice(start, text.indexOf("\n", start));
}

/* A seat delivered v57 keeps its stored mandate until it rotates; delivery
   adds the v58 maintenance practice after the outputs bullet and replaces the
   working rule 16 #3083 rewrote, each by exact match, so the seat reads the
   current mandate. The fixture is the v57 default byte for byte. */
test("delivery gives a v57 mandate the maintenance practice and the current rule 16 by exact match", () => {
  const v57 = fs.readFileSync(path.join(import.meta.dir, "fixtures/mandate-v57.txt"), "utf8");
  expect(createHash("sha256").update(v57).digest("hex")).toBe(PROMPT_FINGERPRINTS[57]);
  expect(v57).not.toContain(MAINTENANCE_BULLET_START);
  expect(v57).toContain("16. Leave the checkout as you found it: work in a scratch export;");
  const delivered = orchestratorMandateForDelivery(v57);
  expect(maintenanceBullet(delivered)).toBe(maintenanceBullet(ORCHESTRATOR_SYSTEM_PROMPT));
  expect(delivered.split(MAINTENANCE_BULLET_START)).toHaveLength(2);
  expect(delivered).not.toContain("work in a scratch export;");
  expect(delivered).toContain(WORKING_RULES_SHORT.split("\n").find((line) => line.startsWith("16. "))!);
  expect(orchestratorMandateWithRoleTable(orchestratorMandateUpgraded(v57), null)).toBe(orchestratorMandateWithRoleTable(ORCHESTRATOR_SYSTEM_PROMPT, null));
  expect(orchestratorMandateUpgraded(orchestratorMandateUpgraded(v57))).toBe(orchestratorMandateUpgraded(v57));
  expect(orchestratorMandateForDelivery(delivered)).toBe(delivered);
  /* A pending intent replays what it recorded: the upgrade is applied when a
     request composes a new intent, never on the replay renderer. */
  expect(orchestratorMandateWithRoleTable(v57, null)).toBe(v57);
  /* A bespoke mandate without the outputs bullet gets no maintenance bullet. */
  expect(orchestratorMandateForDelivery("Coordinate. Audits are ours.")).not.toContain(MAINTENANCE_BULLET_START);
});

/* The short form retains the full form's rule numbering. */
test("the seat's mandate carries all sixteen working rules in their short form", () => {
  const numbers = (text: string) => text.split("\n").flatMap((line) => line.match(/^(\d+)\. /)?.[1] ?? []);
  expect(numbers(WORKING_RULES_SHORT)).toEqual(numbers(WORKING_RULES));
  expect(numbers(WORKING_RULES_SHORT)).toHaveLength(16);
});

/* The short form first shipped without what the memory delta added to rules 6
   and 12 (role-memory-to-prompts.md §4.1), so no seat read those duties. Each
   pair is one duty: its words in the full rule and in the short one, checked
   on the first message a seat spawn actually sends. */
test("a seat's launch prompt carries the evidence and publication duties of rules 6 and 12", () => {
  const resolved = resolveSpawnRole({ role: "orchestrator" });
  if (!resolved.ok || !resolved.value) throw new Error("orchestrator role did not resolve");
  const launch = roleSpawnPrompt(resolved.value, orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT));
  expect(launch.split(WORKING_RULES_SHORT)).toHaveLength(2);
  expect(launch).not.toContain(WORKING_RULES);
});
