# GitHub publication language

GitHub prose uses English independently of the operator's interface language.
No project publication-language setting currently exists. Board titles, chat,
timeline results and task summaries keep the operator's language.

`create_pipeline.prTitle` is an optional public title, stored separately from
`task`. The override is available through the MCP API; there is no separate
board control. Without it, publication uses an English board title or derives a title
from the English stage report's first line. A retained lane with neither gets
the English fallback “Implement project changes”. This is a deterministic
fallback without a translation service; it makes no translation-quality claim.
Stage prompts request English final reports and structured summaries. Reports
with foreign-script prose are omitted from generated PR bodies. Code, links
and quoted interface labels retain their source language.

Before creating or refreshing a pipeline PR, script hints identify the title
or body line, without storing matched content. Hints are advisory. The attempt
retains them, and the lifecycle projector emits a deduplicated high-signal
`publication_language_hint` event for the seat. Explicit titles and existing
PR text with hints remain reviewable and do not refuse the lane. The script
detector cannot distinguish languages that share Latin script.

## Write paths and copies

| Surface | Producer and consumer |
| --- | --- |
| Pipeline title | MCP schema → engine validation → pipeline store → `stagePullRequest.ts` |
| Automatic refresh | `forge/autoRefresh.ts` carries `prTitle` to the successor request |
| Draft title edits | `engine.ts` changes the board task; the separate public title stays stored |
| PR creation/body refresh | `pipelines/stagePullRequest.ts` reads the current producer report or deferred refresh summary; existing descriptions and attribution remain intact |
| Stage reports | `pipelines/prompts.ts` requests publication prose in English; `result` and `taskSummary` remain local |
| Workflow PRs | `workflows/provision.ts` derives an English title and omits foreign-script reports |
| Batch PRs | `forge/mergeBatchTitle.ts` generates English titles; `scripts/merge-batch.ts` generates English bodies and landing/empty-batch comments |
| Batch commits | `scripts/merge-batch.ts` derives English subjects and omits foreign-script summaries while keeping attribution; existing history is not rewritten |
| Automated revert PR | `forge/postMerge.ts` generates an English title and body |
| Issue delivery comments | `forge/issueDelivery.ts` generates English text and omits localized copied PR titles |
| Bug reports | `mcp/server.ts` requests English issue text; `mcp/bindings.ts` adds advisory hints to the exact-text preview; `issueReports/publish.ts` publishes the approved text |

PR squash subjects follow the public PR title. Existing PRs and main history
are not translated in bulk. Privacy checks remain independent of language hints.
