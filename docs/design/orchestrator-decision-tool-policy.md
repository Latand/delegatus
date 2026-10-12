# Orchestrator decision tools

Every operator decision a seat needs goes through `publish_prototype_review`
with 3–7 questions when attached to a board task, or 1–7 questions without a
task to gather open decisions together. Every question has options and exactly
one recommended option. Variants are optional. Chat and reports point to the
form, where the operator answers the decision.

PR #2758 supplies the project's «Рішення» column and seat rounds through this
same tool. This change adds no form store, delivery route or rendered surface.
It upgrades shipped mandate text and appends the rule to bespoke mandates.
Version 49 preserves main's outcome-report rule and marks existing default
seats stale until rotation or upgrade.

Native questions are denied on fresh launches, boot re-hosts and terminal
resume commands. Claude receives `AskUserQuestion` and
`ExitPlanMode` in `--disallowedTools`. Codex disables the synchronous question
tool and installs a trusted `PreToolUse` denial for `request_user_input`,
`request_user_input_async` and its catalog alias `send_user_message_async`.
In Codex 0.162.1 the synchronous setting alone leaves the asynchronous tool
available. The hook refuses it before execution and directs the seat to
`publish_prototype_review`.

Denial uses the engines' existing launch boundaries. Converting native calls
would require translating their payloads, binding a task, tracking publication
and supplying an engine response through another delivery path. Denial keeps
one form contract. The role recorded at launch selects this policy; an active
seat designation also selects it when an existing conversation is re-hosted.
Worker launches retain their existing tools and hooks.

This takes effect at the next engine process launch. A running process keeps
the tool policy it started with.
