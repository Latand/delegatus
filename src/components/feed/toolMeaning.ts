import { getLocale } from "@/lib/i18n";
import type { ToolEvent } from "./parse";

export const feedCopy = (en: string, uk: string): string => getLocale() === "uk" ? uk : en;

/** Encrypted collaboration arguments contain no displayable task text. */
export function taskText(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^gAAAAA[A-Za-z0-9_-]{60,}={0,2}$/.test(value)
    ? feedCopy("Task text unavailable", "Текст завдання недоступний") : value;
}

export function meaningfulToolGroup(calls: readonly ToolEvent[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = call.poll ? "poll" : call.tool === "write_stdin" ? "stdin" : call.tool === "subagent_activity" ? "agent" : call.family;
    counts.set(key, (counts.get(key) ?? 0) + (key === "edit" && call.body ? call.body.files.length : 1));
  }
  return [...counts].map(([kind, n]) => {
    switch (kind) {
      case "poll": return feedCopy(`${n} output check${n === 1 ? "" : "s"}`, `перевірок виводу: ${n}`);
      case "stdin": return feedCopy(`${n} input${n === 1 ? "" : "s"} sent`, `введень: ${n}`);
      case "agent": return feedCopy(`${n} agent update${n === 1 ? "" : "s"}`, `оновлень агентів: ${n}`);
      case "shell": return feedCopy(`ran ${n} command${n === 1 ? "" : "s"}`, `команд: ${n}`);
      case "edit": return feedCopy(`patched ${n} file${n === 1 ? "" : "s"}`, `змінено файлів: ${n}`);
      case "read": return feedCopy(`read ${n} file${n === 1 ? "" : "s"}`, `прочитано файлів: ${n}`);
      case "write": return feedCopy(`wrote ${n} file${n === 1 ? "" : "s"}`, `записано файлів: ${n}`);
      case "mcp": return feedCopy(`${n} MCP call${n === 1 ? "" : "s"}`, `викликів MCP: ${n}`);
      case "web": return feedCopy(`${n} web action${n === 1 ? "" : "s"}`, `вебдій: ${n}`);
      case "spawn": return feedCopy(`${n} agent task${n === 1 ? "" : "s"}`, `завдань агентам: ${n}`);
      case "search": return feedCopy(`${n} search${n === 1 ? "" : "es"}`, `пошуків: ${n}`);
      default: return calls.filter(c => c.family === kind).map(c => c.summary).join(" · ");
    }
  }).join(" · ");
}
