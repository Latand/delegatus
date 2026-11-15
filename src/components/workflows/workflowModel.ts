/** Workflow drafts shared the dashboard's draft list with agent drafts; the
    id prefix told them apart (agent ids are plain uuids, so the non-hex
    prefix never collides). */
export const WORKFLOW_DRAFT_PREFIX = "wf-";

export function isWorkflowDraftId(id: string): boolean {
  return id.startsWith(WORKFLOW_DRAFT_PREFIX);
}

/**
 * Drop legacy workflow-draft ids (issue #136): workflows are retired, and a
 * `wf-*` draft persisted in a tab's sessionStorage survives a deploy reload.
 * Filtering them on restore is the inert dismissal.
 */
export function dropLegacyWorkflowDrafts(ids: readonly string[]): string[] {
  return ids.filter((id) => !isWorkflowDraftId(id));
}

/** Everything a workflow draft kept in sessionStorage. */
export function clearWorkflowDraftStorage(id: string) {
  for (const name of ["template", "dir", "task", "mode"]) sessionStorage.removeItem(`llvWfDraft:${id}:${name}`);
}
