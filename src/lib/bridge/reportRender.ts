import { privateClassLabel, privateClasses, EMPTY_DENY_LIST, type PrivateClass, type PublicDenyList } from "./publicSafe";
import {
  CLASS_EMOJI,
  reportDateTime,
  reportWords,
  SEAT_SECTION_IDS,
  SECTION_EMOJI,
  SECTION_ITEM_LIMIT,
  type ReportLocale,
  type ReportSectionId,
  type SeatSectionId,
} from "./reportWords";
import type { BridgeReportClass } from "./types";

/*
 * One manager report, cut once and rendered twice
 * (docs/design/orchestrator-reports.md §3.2, §5.2).
 *
 * The seat passes a summary line and short items in fixed sections; the Viewer
 * owns everything else: the header with its emoji, kind and local time, the
 * headings, the task changes on a deploy report, the scrub of private
 * information, and the size. The result is one CUT report, and both copies
 * come from it: the plain text stored as the bridge row's body (the report log
 * and the voice relay read it) and the Telegram HTML (`telegramReport.ts`).
 * Nothing is ever cut mid-text: whole items give way, and each section says
 * how many it no longer shows.
 */

/** UTF-8 bytes of the plain rendering, under the store's 2 048-byte cap so
    the store never cuts a report with "…". */
export const REPORT_PLAIN_BUDGET_BYTES = 1_900;
export const REPORT_SUMMARY_MAX_CHARS = 120;
export const REPORT_ITEM_MAX_CHARS = 200;
/** Titles one task-change group lists before the rest are counted. */
export const TASK_GROUP_TITLE_LIMIT = 6;
export const TASK_TITLE_MAX_CHARS = 90;

export type ReportSectionsInput = Partial<Record<SeatSectionId, readonly string[]>>;

export type TaskChangeKind = "done" | "blocked" | "assigned" | "created";
export const TASK_CHANGE_KINDS: readonly TaskChangeKind[] = ["done", "blocked", "assigned", "created"];

/** The board's status changes between two deploy snapshots (§3.8). */
export interface TaskChanges {
  /** Titles per kind, newest board order, unscrubbed. */
  groups: Partial<Record<TaskChangeKind, readonly string[]>>;
  /** The deploy failed: the changes are listed as not on prod yet. */
  notOnProdYet: boolean;
}

export interface CutTaskGroup {
  kind: TaskChangeKind;
  titles: string[];
  /** Every task of the kind, shown or not. */
  total: number;
  /** Titles left out because they carried private information. */
  hidden: number;
}

export interface CutSection {
  id: ReportSectionId;
  items: string[];
  /** Items no longer shown: past the section's limit or cut for size. */
  more: number;
  /** Only on `tasks`. */
  groups?: CutTaskGroup[];
  notOnProdYet?: boolean;
}

export interface CutReport {
  locale: ReportLocale | null;
  emoji: string;
  name: string;
  kind: string;
  when: string;
  summary: string;
  sections: CutSection[];
}

export interface RenderReportInput {
  class: BridgeReportClass;
  /** A report about a settled deploy: its kind reads "deploy". */
  deploy?: boolean;
  name: string;
  at: Date;
  locale: ReportLocale | null;
  timeZone: string | null;
  summary?: string | null;
  sections?: ReportSectionsInput | null;
  /** An older caller's free body, one `inProgress` item per line. */
  legacyBody?: string | null;
  taskChanges?: TaskChanges | null;
  deny?: PublicDenyList;
}

export interface RenderReportResult {
  cut: CutReport;
  warnings: string[];
  /** Nothing is left: no summary and no item in any seat section. */
  empty: boolean;
  /** Private classes found, with how many items or titles each dropped. */
  dropped: Partial<Record<PrivateClass, number>>;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut at a word boundary, marking the cut. Used for the summary and for an
    older caller's body lines, never for a sectioned item. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

const MACHINE_ID = /\b[0-9a-f]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-/i;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function renderReport(input: RenderReportInput): RenderReportResult {
  const words = reportWords(input.locale);
  const deny = input.deny ?? EMPTY_DENY_LIST;
  const warnings: string[] = [];
  const dropped: Partial<Record<PrivateClass, number>> = {};
  const countDrop = (classes: readonly PrivateClass[]) => {
    for (const found of classes) dropped[found] = (dropped[found] ?? 0) + 1;
  };

  /* The seat's sections, or an older caller's body. */
  const raw: Partial<Record<SeatSectionId, string[]>> = {};
  const given = input.sections ?? {};
  const hasSections = SEAT_SECTION_IDS.some((id) => (given[id]?.length ?? 0) > 0);
  if (hasSections) {
    for (const id of SEAT_SECTION_IDS) raw[id] = [...(given[id] ?? [])].map((item) => oneLine(String(item))).filter(Boolean);
  } else if (input.legacyBody?.trim()) {
    const lines = input.legacyBody.split(/\r?\n/).map((line) => oneLine(line.replace(/^[-•*]\s+/, ""))).filter(Boolean);
    raw.inProgress = lines.map((line) => cutAtWord(line, REPORT_ITEM_MAX_CHARS));
    warnings.push("Use summary and sections: a free body is filed as one \"in progress\" item per line.");
  }

  /* The scrub first, then the length rule, then the limits. */
  let tooLong = 0;
  let machineIds = 0;
  const kept: Partial<Record<SeatSectionId, string[]>> = {};
  for (const id of SEAT_SECTION_IDS) {
    kept[id] = (raw[id] ?? []).filter((item) => {
      const found = privateClasses(item, deny);
      if (found.length > 0) {
        countDrop(found);
        return false;
      }
      if (item.length > REPORT_ITEM_MAX_CHARS) {
        tooLong += 1;
        return false;
      }
      if (MACHINE_ID.test(item)) machineIds += 1;
      return true;
    });
  }

  let summary = oneLine(input.summary ?? "");
  if (summary) {
    const found = privateClasses(summary, deny);
    if (found.length > 0) {
      countDrop(found);
      summary = "";
      warnings.push("The summary carried private information and was replaced by the first item.");
    } else if (summary.length > REPORT_SUMMARY_MAX_CHARS) {
      summary = cutAtWord(summary, REPORT_SUMMARY_MAX_CHARS);
      warnings.push(`The summary is longer than ${REPORT_SUMMARY_MAX_CHARS} characters and was cut.`);
    }
  }

  const empty = !summary && SEAT_SECTION_IDS.every((id) => (kept[id]?.length ?? 0) === 0);
  if (!summary) {
    const first = SEAT_SECTION_IDS.map((id) => kept[id]?.[0]).find((item): item is string => !!item);
    summary = first ? cutAtWord(first, REPORT_SUMMARY_MAX_CHARS) : "";
  }

  const sections: CutSection[] = [];
  for (const id of SEAT_SECTION_IDS) {
    const items = kept[id] ?? [];
    const limit = SECTION_ITEM_LIMIT[id];
    if (items.length > 0) sections.push({ id, items: items.slice(0, limit), more: Math.max(0, items.length - limit) });
    if (id === "prod" && input.deploy && input.taskChanges) {
      const tasks = taskSection(input.taskChanges, deny, countDrop);
      if (tasks) sections.push(tasks);
    }
  }
  const limited = sections.reduce((sum, section) => sum + (section.id === "tasks" ? 0 : section.more), 0);

  const cut: CutReport = {
    locale: input.locale,
    emoji: CLASS_EMOJI[input.class],
    name: oneLine(input.name) || "Delegatus",
    kind: input.deploy ? words.kind.deploy : words.kind[input.class],
    when: reportDateTime(input.at, input.locale, input.timeZone),
    summary,
    sections,
  };
  const budgetCut = fitBudget(cut);

  for (const [found, count] of Object.entries(dropped) as [PrivateClass, number][]) {
    warnings.push(`${count} item(s) dropped: ${count === 1 ? "it" : "they"} named ${privateClassLabel(found)}. Reports can be public; leave that out.`);
  }
  if (tooLong > 0) warnings.push(`${tooLong} item(s) over ${REPORT_ITEM_MAX_CHARS} characters dropped; keep each item to one or two short sentences.`);
  if (limited > 0) warnings.push(`${limited} item(s) past a section's limit are shown as a count.`);
  if (budgetCut > 0) warnings.push(`${budgetCut} item(s) or task title(s) cut to fit the report's size; shorten the items.`);
  if ((input.class === "blocked" || input.class === "question") && (kept.decision?.length ?? 0) === 0) {
    warnings.push("A blocked or question report puts the ask in the decision section.");
  }
  if (machineIds > 0) warnings.push(`${machineIds} item(s) carry machine ids; name work by its title and #PR, a deploy by its 8-character sha.`);
  return { cut, warnings, empty, dropped };
}

function taskSection(
  changes: TaskChanges,
  deny: PublicDenyList,
  countDrop: (classes: readonly PrivateClass[]) => void,
): CutSection | null {
  const groups: CutTaskGroup[] = [];
  for (const kind of TASK_CHANGE_KINDS) {
    const titles = changes.groups[kind] ?? [];
    if (titles.length === 0) continue;
    let hidden = 0;
    const clean: string[] = [];
    for (const title of titles) {
      const line = cutAtWord(oneLine(title), TASK_TITLE_MAX_CHARS);
      const found = privateClasses(line, deny);
      if (found.length > 0 || !line) {
        countDrop(found);
        hidden += 1;
        continue;
      }
      clean.push(line);
    }
    groups.push({ kind, titles: clean.slice(0, TASK_GROUP_TITLE_LIMIT), total: titles.length, hidden });
  }
  if (groups.length === 0) return null;
  return { id: "tasks", items: [], more: 0, groups, notOnProdYet: changes.notOnProdYet };
}

/** A group's one line: its titles, the rest counted, the hidden counted. */
export function taskGroupLine(group: CutTaskGroup, locale: ReportLocale | null): string {
  const words = reportWords(locale);
  const label = words.task[group.kind];
  const rest = group.total - group.hidden - group.titles.length;
  const hidden = group.hidden > 0 ? ` (${words.hidden(group.hidden)})` : "";
  if (group.titles.length === 0) return `${label}: ${group.total}${hidden}`;
  return `${label}: ${group.titles.join("; ")}${rest > 0 ? `; ${words.andMore(rest)}` : ""}${hidden}`;
}

export function sectionHeading(section: CutSection, locale: ReportLocale | null): string {
  const words = reportWords(locale);
  const suffix = section.id === "tasks" && section.notOnProdYet ? ` ${words.notOnProdYet}` : "";
  return `${words.heading[section.id]}${suffix}`;
}

/** The lines of a section's body, bullet included, shared by both renderings
    so they list exactly the same things. */
export function sectionLines(section: CutSection, locale: ReportLocale | null): string[] {
  const words = reportWords(locale);
  const lines = section.id === "tasks"
    ? (section.groups ?? []).map((group) => taskGroupLine(group, locale))
    : [...section.items];
  if (section.more > 0) lines.push(words.andMore(section.more));
  return lines;
}

/** The bridge copy: plain text, stored as the row's body. */
export function renderPlain(cut: CutReport): string {
  const lines = [`${cut.emoji} ${cut.name} · ${cut.kind} · ${cut.when}`];
  if (cut.summary) lines.push(cut.summary);
  for (const section of cut.sections) {
    lines.push("", `${SECTION_EMOJI[section.id]} ${sectionHeading(section, cut.locale)}`);
    lines.push(...sectionLines(section, cut.locale).map((line) => `• ${line}`));
  }
  return lines.join("\n");
}

const CUT_ORDER: readonly SeatSectionId[] = ["queued", "inProgress", "merged", "prod"];

/**
 * Shrink the cut report, one whole item at a time, until its plain rendering
 * fits the budget (§3.2): task titles first, from the largest group; then
 * items from the end of `queued`, `inProgress`, `merged` and `prod`, each
 * keeping its first item until all four are down to one, and then the rest in
 * the same order. The decision section and the summary are never cut.
 * Returns how many things were removed.
 */
function fitBudget(cut: CutReport): number {
  let removed = 0;
  const over = () => bytes(renderPlain(cut)) > REPORT_PLAIN_BUDGET_BYTES;
  const tasks = cut.sections.find((section) => section.id === "tasks");
  while (over() && tasks?.groups?.some((group) => group.titles.length > 0)) {
    const largest = tasks.groups.reduce((best, group) => (group.titles.length > best.titles.length ? group : best));
    largest.titles.pop();
    removed += 1;
  }
  for (const floor of [1, 0]) {
    for (const id of CUT_ORDER) {
      const section = cut.sections.find((candidate) => candidate.id === id);
      if (!section) continue;
      while (over() && section.items.length > floor) {
        section.items.pop();
        section.more += 1;
        removed += 1;
      }
    }
  }
  cut.sections = cut.sections.filter((section) => section.id === "tasks" || section.items.length > 0 || section.more > 0);
  return removed;
}
