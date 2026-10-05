# MCP call cost defaults

Pure reads may omit `clientRequestId` for a fresh observation. Explicit keys keep
replay and conflict detection. Mutations require stable keys, including tools
with durable effects such as `agent_activity`, `search_memory`, `lifecycle_events`
and settings tools. The registered schema states whether the key is optional.

`get_pipeline` returns the compact row with revision and graph/stage digests.
Use `stageId` for one conclusion, or `full:true` / `compact:false` for the complete
record, delivery ownership, close report, links and retained bodies. Routine
`pipeline_action` replies retain revision and changed fields; graph edits retain
digests. Changed delivery, publish, takeover and retry replies retain ownership.
`pipeline_action` with `full:true` restores complete detail.

`resources` returns system and Viewer observations, session count/memory/process
totals and freshness. `full:true` / `compact:false` restores session rows with
stale evidence. The summary has the same collection cost; it saves response size.

A process that holds no resource observation answers an ordinary `resources`
read within 750 ms. Its first collection takes the scan's scope and none of its
enrichment; when even that outlives the wait, the answer carries the current
system block, an empty session table, and `freshness.pending: true` with reason
`collecting`, and a later call returns the table. `fresh:true` still waits for
the completed observation.

`agent_activity` waits 700 ms for a conversation catalog. A process that holds
none answers with the hosts the registry names and `catalog: "pending"`, and
the scan keeps running for the next call; a process that holds an older one
answers from it with `selection.cacheStatus: "stale"`.

`get_conversation` returns a summary inside a text budget: 40,000 characters of
messages and 24,000 of tools, newest kept, each record cut to `maxChars` (4,000
for messages, 1,000 for tools) after secret redaction and marked
`truncated: true`. `omitted` counts the older records left out. With
`tailLines`, a raw line longer than `maxChars` keeps its head and ends in
`… [+N chars]`, and `tail.cutLines` counts them. `full:true` returns complete
records and lines; `conversation_messages` pages them.

`search_transcripts` keeps corpus counts and pagination; `full:true` includes
static tokenizer/field statistics. `conversation_messages` keeps source records,
authors, redaction, truncation and cursors; `includeMetadata:true` / `full:true`
includes transcript/engine/time/scan metadata. Capped scan evidence is always
returned. Prefer an already-known `conversationId` when it identifies the source.

`list_pipelines` accepts `statusOnly:true` to omit per-stage cards from compact
rows. All list scopes and continuation cursors are retained. Use filters and
limits for the question being asked; a complete-board read must follow all pages.
`list_tasks`, `list_pipelines`, `pipeline_action`, `agent_activity` and task write
acknowledgements omit repeated `readMore` text; `includeHints:true` or `full:true`
restores it. Never write truncated display text back to a stored record.

`create_pipeline.src` may be omitted when the authenticated capability uniquely
pins a receipt, registry entry and current native generation of the caller.
Ambiguous, missing or stale lineage is refused before admission. Explicit source
paths keep the existing engine validation. Stage prompts and acceptance criteria
are preserved. Cryptographic write guards keep their existing lengths.

Synchronous Git/forge work, attention arrival waits, historical tail telemetry,
conversation cursor redesign and external discovery-instruction duplication
remain follow-ups. These changes do not guarantee every tool finishes in a second.
