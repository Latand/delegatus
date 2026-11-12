# Saved prompt for the Claude cloud scheduled task

Delegatus prepares the scheduled task automatically for each allowed account when
Claude Cloud is used. It adopts a matching task first, enables it, clears its
connectors and records its id in `claudeCloudTasks`.

The saved prompt is shipped in
`src/lib/pipelines/claudeCloudTaskPrompt.ts`. A run started by Delegatus receives
its assignment in follow-up messages; a scheduled run without an assignment ends
at once. See `docs/design/claude-cloud-auto-prepare.md` for readiness and the
human-only setup steps.
