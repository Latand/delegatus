# Saved prompt for the Claude cloud scheduled task

Delegatus prepares the scheduled task automatically for each allowed account when
Claude Cloud is used. It adopts a matching task first, enables it, clears its
connectors and records its id in `claudeCloudTasks`.

The saved prompt is shipped in `src/lib/pipelines/claudeCloudTaskPrompt.ts`.
A run started by Delegatus receives its assignment in follow-up messages; a
scheduled run without an assignment ends at once. See
`docs/design/claude-cloud-auto-prepare.md` for readiness and human-only setup steps.

GitHub write access on the account’s connection is allowed. Each assignment part
supersedes the obsolete probe requirement in older saved prompts, so existing
tasks need no prompt update. Results return through the patch export; the
controller publishes them.
