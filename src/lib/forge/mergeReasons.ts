/*
 * The merge runner's blocked reasons (#2187 §4.4), one plain sentence each.
 * Browser-safe: the runner writes them onto the record, and the board reads
 * them back to say each one in the operator's language.
 */
export const MERGE_REASONS = {
  conflict: "conflict with the base branch",
  noChecks: "no checks reported on this head",
  checksTimeout: "checks did not finish in 90 min",
  draft: "the PR is a draft",
  closed: "the PR was closed",
  headChanged: "the PR head changed after the lane finished",
  mainMoving: "main keeps moving",
  unreachable: "GitHub CLI not signed in or unreachable",
  settingOff: "the project's merge setting was turned off",
  reviewRequired: "branch protection wants an approving review",
  protection: "branch protection wants something else (GitHub says BLOCKED)",
} as const;

export type MergeReasonKey = keyof typeof MERGE_REASONS;

/** A reason with a part of its own: a named red check, or GitHub's words. */
export const MERGE_REASON_PATTERNS = {
  check: /^check "(.+)" failed$/,
  refusedMerge: /^GitHub refused the merge: (.+)$/,
  refusedUpdate: /^GitHub refused to update the branch: (.+)$/,
} as const;

export const checkFailedReason = (name: string): string => `check "${name}" failed`;
