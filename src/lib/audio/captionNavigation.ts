import type { CaptionTarget } from "./captions";

/**
 * What a sound caption's click does (docs/design/sound-captions.md §4): the
 * entry it announced when it is still waiting, else the lane, project or
 * conversation behind it. The shell hands in its own navigation, so the rule
 * lives here and can be exercised without mounting the shell.
 */
export interface CaptionNavigation<Entry extends { id: string }, File extends { path: string; conversationId?: string | null }> {
  needsYou: readonly Entry[];
  files: readonly File[];
  jumpToEntry(entry: Entry): void;
  focusLane(pipelineId: string, project: string): void;
  selectProject(project: string): void;
  /** Opens the conversation, switching to its project when it is in another. */
  openFile(file: File): void;
}

export function openCaptionTarget<Entry extends { id: string }, File extends { path: string; conversationId?: string | null }>(
  first: CaptionTarget,
  navigation: CaptionNavigation<Entry, File>,
): void {
  let target: CaptionTarget | null = first;
  if (target.kind === "needs-you") {
    const { entryId } = target;
    const entry = navigation.needsYou.find((candidate) => candidate.id === entryId);
    if (entry) {
      navigation.jumpToEntry(entry);
      return;
    }
    target = target.then;
  }
  if (!target || target.kind === "needs-you") return;
  if (target.kind === "lane") {
    navigation.focusLane(target.pipelineId, target.project);
    return;
  }
  if (target.kind === "project") {
    navigation.selectProject(target.project);
    return;
  }
  const { path, conversationId } = target;
  const file = navigation.files.find((candidate) => (path && candidate.path === path) || (conversationId && candidate.conversationId === conversationId));
  if (file) navigation.openFile(file);
}
