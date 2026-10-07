import { ruleLine } from "./consolidate";
import { scopeKind, scopeRole } from "./scopes";
import { RULE_MAX_CHARS, WHY_MAX_CHARS, type RoleMemoryRule } from "./types";

/* What a stage agent reads: the learned rules below its brief when it starts,
   and the lesson request in the answer to its stage_report. Kept short on
   purpose (operator, 2026-10-07: «Треба, щоб не було дуже багато тексту»). */

export const LEARNED_RULES_HEADING = "Learned rules (Delegatus role memory)";

const LESSON_POINTER = "When you report with stage_report, its answer asks you for a lesson: answer it with leave_lesson before you end your turn.";

function roleTitle(roleId: string): string {
  const words = roleId.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function scopeHeading(scope: string): string {
  const kind = scopeKind(scope);
  if (kind === "machine") return "Machine rules · every project on this machine";
  if (kind === "project") return "Project rules · every role on this project";
  return `Role rules · ${roleTitle(scopeRole(scope) ?? "")} on this project`;
}

/** The block injected at spawn: the stage's role, project and machine rules
    together, as three labelled groups of separate items, each with its id. */
export function renderLearnedRules(scopes: readonly { scope: string; rules: readonly RoleMemoryRule[] }[]): string {
  const count = (kind: string) => scopes.filter((entry) => scopeKind(entry.scope) === kind).reduce((sum, entry) => sum + entry.rules.length, 0);
  const counts = [...(scopes.some((entry) => scopeKind(entry.scope) === "role") ? [`${count("role")} role`] : []), `${count("project")} project`, `${count("machine")} machine`].join(" · ");
  return [
    `${LEARNED_RULES_HEADING}: ${counts}`,
    "Earlier agents left these when they finished their stages. They are rules of thumb: the brief, the pinned specification and the project's instruction files win where they disagree. Keep them on this machine: never copy a rule into a commit, pull request, issue, task or report; name it by its id.",
    ...scopes.flatMap((entry) => ["", scopeHeading(entry.scope), ...(entry.rules.length ? entry.rules.map(ruleLine) : ["- none yet"])]),
    "",
    LESSON_POINTER,
  ].join("\n");
}

/** The controller lines every stage reads last; the block goes right above them, below the brief and the role scaffold. */
const CONTROLLER_ANCHORS = [
  "Design and UI stages publish variants with publish_prototype_review",
  "Report this stage's completion with the Delegatus MCP tool stage_report",
];

export function insertLearnedRules(prompt: string, block: string): string {
  for (const anchor of CONTROLLER_ANCHORS) {
    const at = prompt.indexOf(`\n${anchor}`);
    if (at >= 0) return `${prompt.slice(0, at)}\n\n${block}\n${prompt.slice(at)}`;
  }
  return `${prompt}\n\n${block}`;
}

export interface HandedFindings {
  stageId: string;
  severities: (string | null)[];
}

function handedLine(handed: HandedFindings | null): string[] {
  if (!handed || !handed.severities.length) return [];
  const counts = new Map<string, number>();
  for (const severity of handed.severities) counts.set(severity ?? "unranked", (counts.get(severity ?? "unranked") ?? 0) + 1);
  const ranked = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([severity, count]) => `${severity} ×${count}`).join(", ");
  const n = handed.severities.length;
  return [`This attempt was handed ${n} finding${n === 1 ? "" : "s"} from stage ${handed.stageId} (${ranked}). Start there.`];
}

/** The stage-end prompt (design §2.4), as lines so a tool card shows it line by line. */
export function lessonRequestLines(handed: HandedFindings | null): string[] {
  return [
    "Your stage report is recorded. Before you end this turn, leave what this stage taught you for the agents who come after you; Delegatus gives them your lessons as learned rules when they start.",
    ...handedLine(handed),
    "Write one to three lessons. Each is an abstract rule: a class of mistake or situation and what to do about it, so the whole class stops recurring. A one-off fact (a file name, a pull request number, the state of a branch today) belongs in your report and makes no lesson.",
    "Look first at the findings you were handed or found yourself: which rule, followed from the start, would have prevented each class? Then at a wrong turn you corrected, a check that failed late, a retry, or a learned rule that proved wrong.",
    `For each lesson give rule (imperative, at most ${RULE_MAX_CHARS} characters), why (one line, at most ${WHY_MAX_CHARS} characters: what went wrong here) and scope:`,
    "- role: the next agent of a role on this project; your own role unless you name another in role. Reviewers and verifiers take no learned rules.",
    "- project: every role on this project.",
    "- machine: every project on this machine (tools, the operating system, the environment).",
    "Write no names of people, accounts, emails, tokens, ids or absolute paths: learned rules go into other agents' prompts, and machine rules into other projects. Keep a rule's text out of commits, pull requests, issues, tasks and reports; name it by its id.",
    "Call leave_lesson once with all your lessons. If this stage taught nothing new, call it with none and one line saying why; leaving at least one lesson is better. Then end your turn: the stage itself is complete.",
  ];
}
