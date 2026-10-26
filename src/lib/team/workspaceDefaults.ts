import { existingTeamStore, type TeamStore } from "./store";
import { workspaceDirectory } from "./workspaces";
import { requireWorkspaceManager } from "./workspaceAccess";
import { TeamError } from "./members";
import type { Member } from "./contract";

export interface WorkspaceDefaults {
  accounts: { claude: string[]; codex: string[] };
  reportChat: { chat: string; name: string; topicId?: number } | null;
  directiveChats: string[];
}

export function parseWorkspaceDefaults(value: unknown): WorkspaceDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TeamError("invalid_defaults", "workspace defaults must be an object");
  const input = value as Record<string, unknown>;
  const strings = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item !== "string" || !item.trim() || item.length > 200 || /[\u0000-\u001f]/.test(item)))
      throw new TeamError("invalid_defaults", "choose at most 100 bounded account or chat names");
    return [...new Set((items as string[]).map(item => item.trim()))].sort();
  };
  const accounts = input.accounts as Record<string, unknown> | undefined;
  if (accounts !== undefined && (!accounts || typeof accounts !== "object" || Array.isArray(accounts)))
    throw new TeamError("invalid_defaults", "account defaults must name engine pools");
  const report = input.reportChat as Record<string, unknown> | null | undefined;
  if (report != null && (typeof report !== "object" || Array.isArray(report) || typeof report.chat !== "string" || !report.chat.trim() || report.chat.length > 200
    || typeof report.name !== "string" || !report.name.trim() || report.name.length > 120
    || (report.topicId !== undefined && (!Number.isSafeInteger(report.topicId) || Number(report.topicId) <= 0))))
    throw new TeamError("invalid_defaults", "choose a report chat and report name");
  return {
    accounts: { claude: strings(accounts?.claude ?? []), codex: strings(accounts?.codex ?? []) },
    reportChat: report == null ? null : { chat: (report.chat as string).trim(), name: (report.name as string).trim(), ...(report.topicId === undefined ? {} : { topicId: report.topicId as number }) },
    directiveChats: strings(input.directiveChats ?? []),
  };
}

export function readWorkspaceDefaults(store: TeamStore, id: string): WorkspaceDefaults {
  const raw = store.workspaceDefaults(id);
  return parseWorkspaceDefaults(raw === undefined ? {} : raw);
}

export function setWorkspaceDefaults(store: TeamStore, actor: Member, id: string, input: unknown): WorkspaceDefaults {
  const value = parseWorkspaceDefaults(input);
  return store.transaction(() => {
    requireWorkspaceManager(store, actor, id);
    store.putWorkspaceDefaults(id, value);
    return readWorkspaceDefaults(store, id);
  });
}

/** Read-through inheritance keeps aliases, newly placed projects and later edits
 * consistent without copying stale defaults over explicit project choices. */
export function workspaceDefaultsForProject(project: string | null | undefined): WorkspaceDefaults | null {
  const store = existingTeamStore();
  if (!store || !project) return null;
  const id = workspaceDirectory(store).workspaceOf(project);
  return id ? readWorkspaceDefaults(store, id) : null;
}
