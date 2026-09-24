/**
 * The icon a task without one is drawn with (#2102): a small keyword map over
 * its title, read in order, so the same title always gets the same icon. The
 * suggestion is presentation only and is never stored; a task nobody gave an
 * icon and whose title matches nothing gets {@link DEFAULT_TASK_ICON}.
 *
 * This module is imported by every card, so it holds only these few names and
 * never the full lucide list (`lucideIconNames.ts`).
 */

/** The quiet icon of a task with no icon and no suggestion. */
export const DEFAULT_TASK_ICON = "circle-dashed";

/**
 * One rule per icon, first match wins. A keyword ending in `*` matches every
 * word it starts (`fix*` matches "fixes"); any other keyword matches a whole
 * word. English first, then Ukrainian stems, since the board is written in
 * both.
 */
export const TASK_ICON_RULES: readonly { icon: string; words: readonly string[] }[] = [
  { icon: "bug", words: ["bug*", "fix*", "repair*", "crash*", "broken", "regression*", "hotfix*", "баг", "баги", "багів", "помилк*", "виправ*", "полагод*", "злам*"] },
  { icon: "rocket", words: ["deploy*", "release*", "ship", "shipping", "rollout", "promot*", "launch*", "деплой*", "реліз*", "випуск*"] },
  { icon: "search-check", words: ["review*", "audit*", "critique*", "inspect*", "рев'ю", "ревю", "перевір*", "аудит*"] },
  { icon: "flask-conical", words: ["test*", "flak*", "e2e", "тест*"] },
  { icon: "shield", words: ["secur*", "privacy", "auth", "authentication", "authoriz*", "permission*", "sandbox*", "безпек*", "приватн*"] },
  { icon: "gauge", words: ["perf", "performance", "slow*", "latency", "speed*", "memory", "freeze*", "bundle*", "швидк*", "пам'ят*"] },
  { icon: "smartphone", words: ["phone*", "mobile*", "iphone", "android", "телефон*", "мобіл*"] },
  { icon: "mic", words: ["voice*", "audio", "speech", "dictation", "tts", "transcrib*", "transcription", "голос*", "диктув*"] },
  { icon: "message-square", words: ["telegram", "chat*", "message*", "messaging", "composer*", "повідомл*", "чат*"] },
  { icon: "palette", words: ["design*", "ui", "ux", "layout*", "css", "style*", "theme*", "icon*", "дизайн*", "іконк*"] },
  { icon: "file-text", words: ["doc", "docs", "document*", "readme*", "guide*", "write-up", "документ*"] },
  { icon: "workflow", words: ["pipeline*", "workflow*", "stage*", "orchestrat*", "lane*", "конвеєр*", "пайплайн*"] },
  { icon: "database", words: ["database*", "sqlite", "migrat*", "storage", "база*", "бази*", "міграц*"] },
  { icon: "git-branch", words: ["git", "branch*", "merge*", "rebase*", "worktree*", "commit*", "pr", "гілк*"] },
  { icon: "package", words: ["build*", "docker*", "container*", "npm", "install*", "package*", "dependenc*", "збірк*"] },
  { icon: "plug", words: ["mcp", "api", "endpoint*", "integration*", "connector*", "webhook*", "інтеграц*"] },
  { icon: "user-round", words: ["account*", "login*", "quota*", "limit*", "profile*", "акаунт*", "обліков*"] },
  { icon: "square-kanban", words: ["board*", "kanban*", "card*", "task*", "дошк*", "картк*", "задач*"] },
  { icon: "bell", words: ["notif*", "alert*", "attention", "remind*", "сповіщ*", "нагадув*"] },
  { icon: "clock", words: ["schedul*", "timer*", "deadline*", "cron", "timeout*", "розклад*", "таймер*"] },
  { icon: "languages", words: ["i18n", "translat*", "locale*", "ukrainian", "english", "переклад*", "локаліз*"] },
  { icon: "scroll-text", words: ["log", "logs", "logging", "transcript*", "history", "журнал*", "лог", "логи", "логів", "історі*"] },
  { icon: "search", words: ["search*", "find", "lookup", "пошук*", "знайт*"] },
  { icon: "wrench", words: ["refactor*", "cleanup", "clean", "simplif*", "tidy", "chore*", "рефактор*", "прибира*", "спрост*"] },
];

/** Every icon a suggestion can name, with the default: what the picker offers
    before the operator types. */
export const SUGGESTED_TASK_ICONS: readonly string[] = [...new Set([...TASK_ICON_RULES.map((rule) => rule.icon), DEFAULT_TASK_ICON])];

type CompiledRule = { icon: string; exact: ReadonlySet<string>; stems: readonly string[] };
let compiled: CompiledRule[] | null = null;
function rules(): CompiledRule[] {
  compiled ??= TASK_ICON_RULES.map((rule) => ({
    icon: rule.icon,
    exact: new Set(rule.words.filter((word) => !word.endsWith("*"))),
    stems: rule.words.filter((word) => word.endsWith("*")).map((word) => word.slice(0, -1)),
  }));
  return compiled;
}

/** The title's words, lower-cased; an apostrophe stays inside a word ("рев'ю"). */
function titleWords(title: string): string[] {
  return title.toLowerCase().replace(/[’ʼ]/g, "'").split(/[^\p{L}\p{N}'-]+/u).flatMap((word) => {
    const trimmed = word.replace(/^['-]+|['-]+$/g, "");
    /* "e2e-flaky" is two words, and so is its hyphenated whole. */
    return trimmed ? [trimmed, ...(trimmed.includes("-") ? trimmed.split("-").filter(Boolean) : [])] : [];
  });
}

/** The icon the keyword map gives this title, or null when no rule matches. */
export function suggestTaskIcon(title: string): string | null {
  const words = titleWords(title.split("\n", 1)[0] ?? "");
  if (!words.length) return null;
  for (const rule of rules()) {
    if (words.some((word) => rule.exact.has(word) || rule.stems.some((stem) => word.startsWith(stem)))) return rule.icon;
  }
  return null;
}

export type TaskIconSource = "stored" | "suggested" | "default";

/** What a task is drawn with: its stored icon, else the suggestion, else the quiet default. */
export function displayTaskIcon(stored: string | null | undefined, title: string): { icon: string; source: TaskIconSource } {
  if (typeof stored === "string" && stored) return { icon: stored, source: "stored" };
  const suggested = suggestTaskIcon(title);
  return suggested ? { icon: suggested, source: "suggested" } : { icon: DEFAULT_TASK_ICON, source: "default" };
}
