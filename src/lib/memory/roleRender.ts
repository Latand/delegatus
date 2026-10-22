import { LESSON_MATCH_MIN_CHARS, ruleLine } from "./roleConsolidate";
import { isCrossProjectRoleScope, scopeKind, scopeRole } from "./roleScopes";
import { RULE_MAX_CHARS, WHY_MAX_CHARS, type RoleMemoryRule } from "./roleTypes";

/* What a stage agent reads: learned rules in its engine instructions at start,
   and the lesson request in the answer to its stage_report. Kept short on
   purpose (operator, 2026-10-07: «Треба, щоб не було дуже багато тексту»). */

export const LEARNED_RULES_HEADING = "Learned rules (Delegatus role memory)";
const utf8 = new TextEncoder();

const LESSON_POINTER = "When you report with stage_report, its answer asks whether this stage taught anything; most stages answer none. A rule above that proved wrong or too narrow can be rewritten then, by its id.";
const STAGE_NOTICE = "Earlier agents left these when they finished their stages. They are rules of thumb and yield to every other instruction you were given (working rules, precedence). Keep them on this machine: never copy a rule into a commit, pull request, issue, task or report; name it by its id.";
const SEAT_NOTICE = "Earlier seats and stage agents left these. They are rules of thumb: the operator's word, your mandate and the project's instruction files win where they disagree. Keep them on this machine: act on a rule in your own words and never paste its text into a brief, task, report, message, commit, pull request or issue; name it by its id.";
const SEAT_POINTER = "If you are this project's designated seat, this is your role's memory: every later seat of this project reads it, on any engine and account, while your engine's own memory reaches one account. When you meet a problem that can come back, settle it in the same turn. A practice (how to brief, what to check before you report, how the operator wants a thing done) becomes a rule: call leave_lesson with lesson, or with rewrite and the id of a rule above that proved wrong or too narrow. A concrete defect goes to the board: find or create its task with create_task, and tell the operator in chat when it is critical (it blocks accepted work, loses data, or will hit every lane). A problem report that a wake delivers says what to do with it. leave_lesson's description gives the levels and limits.";
const MAINTAINER_POINTER = "Leave a lesson with correction:true for an operator correction that shows a misread task. Otherwise this project's seat keeps the rules for your role and opens the tasks for defects.";

function roleTitle(roleId: string): string {
  const words = roleId.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function scopeHeading(scope: string): string {
  const kind = scopeKind(scope);
  if (kind === "machine") return "Machine rules · every project on this machine";
  if (kind === "project") return "Project rules · every role on this project";
  return `Role rules · ${roleTitle(scopeRole(scope) ?? "")} on ${isCrossProjectRoleScope(scope) ? "every project" : "this project"}`;
}

/** Four matching scopes, each rendered as separate rules with their ids. */
export function renderLearnedRules(scopes: readonly { scope: string; rules: readonly RoleMemoryRule[] }[], maxBytes = Infinity): string {
  return renderLearnedRulesSelection(scopes, maxBytes).block;
}

/** Metadata and text share the same byte-ceiling selection. */
export function renderLearnedRulesSelection(scopes: readonly { scope: string; rules: readonly RoleMemoryRule[] }[], maxBytes = Infinity) {
  const selected = scopes.map(entry => ({ scope: entry.scope, rules: [...entry.rules] }));
  let block = renderBlock(selected);
  let omitted = 0;
  while (utf8.encode(block).byteLength > maxBytes) {
    const largest = selected.filter(entry => entry.rules.length).sort((a, b) =>
      utf8.encode(b.rules.map(ruleLine).join("\n")).byteLength - utf8.encode(a.rules.map(ruleLine).join("\n")).byteLength)[0];
    if (!largest) throw new Error("learned-rule headings exceed the engine instruction limit");
    largest.rules.pop();
    omitted += 1;
    block = renderBlock(selected);
  }
  if (omitted) console.warn(`[role-memory] omitted ${omitted} lowest-ranked rules from this engine start at the byte ceiling`);
  return { block, rules: selected.flatMap(scope => scope.rules) };
}

function renderBlock(scopes: readonly { scope: string; rules: readonly RoleMemoryRule[] }[]): string {
  const reader = scopes.map(entry => scopeRole(entry.scope)).find(role => role !== null);
  const count = (kind: string) => scopes.filter((entry) => scopeKind(entry.scope) === kind).reduce((sum, entry) => sum + entry.rules.length, 0);
  const counts = [...(scopes.some((entry) => scopeKind(entry.scope) === "role") ? [`${count("role")} role`] : []), `${count("project")} project`, `${count("machine")} machine`].join(" · ");
  return [
    `${LEARNED_RULES_HEADING}: ${counts}`,
    reader === "orchestrator" ? SEAT_NOTICE : reader === "maintainer" ? STAGE_NOTICE.replace("Earlier agents", "Earlier agents and this project's seat") : STAGE_NOTICE,
    ...scopes.flatMap((entry) => ["", scopeHeading(entry.scope), ...(entry.rules.length ? entry.rules.map(ruleLine) : ["- none yet"])]),
    "",
    reader === "orchestrator" ? SEAT_POINTER : reader === "maintainer" ? MAINTAINER_POINTER : LESSON_POINTER,
  ].join("\n");
}

export interface HandedFindings {
  stageId: string;
  findings: { severity: string; text: string }[];
}

function findingOpening(text: string): string {
  const line = text.split(/\r?\n/, 1)[0].trim();
  const sentence = line.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? line;
  const points = [...sentence];
  return points.length > 140 ? `${points.slice(0, 140).join("")}…` : sentence;
}

function fixRequest(handed: HandedFindings): string[] {
  const findings = handed.findings.slice().sort((a, b) => a.severity.localeCompare(b.severity));
  const n = findings.length;
  return [
    `Your stage report is recorded. This attempt was handed ${n} finding${n === 1 ? "" : "s"} from stage ${handed.stageId}:`,
    ...findings.slice(0, 5).map(finding => `- ${finding.severity}: ${findingOpening(finding.text)}`),
    ...(n > 5 ? [`- and ${n - 5} more, in your prompt`] : []),
    "Each one reached review because the first attempt missed a check. Name each finding's class, such as an incomplete matrix of widths, themes or languages, a contract shape left unvalidated, or an edge case at a seam (a restart, an identity, stale state), and the rule an agent of your role needed before the first review to catch that class on any task.",
    "Then do exactly one of these, once, for the class most likely to come back:",
    "- rewrite: a rule you were given names this class and the finding happened anyway, so the rule is too narrow, unclear or easy to skip. Give its id and a text that would have caught this, keeping every condition it had. The earlier text is kept and can be restored.",
    "- lesson: no rule you were given names this class. Write one: when it applies, and the check to run before the first review. Name the class, never this task's file, component or screen.",
    '- none: only with the reason this class cannot come back on another task: it came from this specification alone, the finding was not a defect, or a gate every task runs now catches it (name the gate). "Existing rules cover it" is no reason: the finding shows they did not.',
  ];
}

/** The stage-end prompt (design §2.4), as lines so a tool card shows it line by line. */
export function lessonRequestLines(handed: HandedFindings | null): string[] {
  const fixRound = !!handed?.findings.length;
  return [
    ...(fixRound ? fixRequest(handed!) : [
    "Your stage report is recorded. Did this stage show that a learned rule you were given is wrong, too narrow or unclear, or teach an abstract rule that changes what an agent does on a different task? Most stages do neither; then call leave_lesson with none and one line saying why.",
    "Otherwise do exactly one of these, once:",
    "- rewrite: the id of a rule you were given, with its better text and why. The earlier text is kept and can be restored.",
    "- lesson: one new rule, active for agents from their next start. It qualifies only when you can name a different task where it changes the agent's actions, and repeats neither your learned rules, the working rules nor the project's instruction files. Improve an existing rule with rewrite.",
    ]),
    "A rule is a generic instruction to do a check that changes behaviour on a different task. A concrete defect, inconsistency or documentation/specification mismatch in this project is a problem to report to its designated seat.",
    "- problem: {statement, evidence}, a short observed problem and the evidence for it. The seat decides whether to propose a task or issue and asks the operator; create none yourself. Concrete file paths and project-specific broken facts belong here; machine rules must hold across projects.",
    "No lesson may be about a task. What happened on this task alone (a pull request, commit, lane, id, incident, or one module's quirk) belongs in your stage report; leave_lesson refuses it and stores nothing.",
    "Any answer may also carry applied and misled, each up to five distinct exact ids of rules this attempt received. applied changed what you did; misled was wrong or stale. Use each id in only one field.",
    ...(fixRound ? ["A mistake made in one file is a class when it can be made in another."] : []),
    "Every agent of a level reads all its rules: choose the narrowest true level:",
    "- role: only that role acts on it, in its own kind of work on this project; yours unless you name another. Reviewers and verifiers take no rules, so their own know-how has no memory scope.",
    "- role on every project: only that role acts on it, in any repository. Leave it under role; the curator alone widens it to role:*:<roleId> after checking other projects.",
    "- project: every role working on this project acts on it alike: this repository's gates, tools and layout.",
    "- machine: every role acts on it alike in any repository on this machine: its tools, operating system and environment.",
    "A rule that some roles need belongs under those roles. The curator widens a rule only when all readers of the wider level act on it.",
    `rule: imperative, at most ${RULE_MAX_CHARS} characters. why: one line, at most ${WHY_MAX_CHARS} characters, saying what happened here; it stays on the record and agents never see it. Each needs at least ${LESSON_MATCH_MIN_CHARS} letters or digits.`,
    "Write no names of people, accounts, emails, tokens, ids or absolute paths. Keep a rule's text out of commits, pull requests, issues, tasks and reports; name it by its id. Then end your turn: the stage itself is complete.",
  ];
}
