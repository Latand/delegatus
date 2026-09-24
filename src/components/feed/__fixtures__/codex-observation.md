# Codex tool observation (before implementation)

Baseline: `75abc565f6e8dbbf76664ced6dacc5bd5cca078b`. Line references below
refer to this baseline: `src/components/feed/parse.ts`,
`src/components/feed/tools.ts`, and `src/lib/session/reader.ts`.

Observed 2026-09-20 in a local Codex CLI 0.155.1 rollout. Read the tool,
reasoning and trace records through Viewer `conversation_messages` (the session
reader), then inspected field names and relationships in the same rollout.
No transcript content is used as fixture data. All test values are hand written.
History searches for readable tools and orchestration found no prior solution
for these current shapes.

| Record shape | Existing presentation and cause |
| --- | --- |
| `response_item/custom_tool_call {name: exec, call_id, input}` followed by `event_msg/item_completed {item: {type: CommandExecution, id: exec-…, command: string[], cwd, stdout, stderr, exit_code, duration: {secs,nanos}}, started_at_ms, completed_at_ms}`, then matching `custom_tool_call_output` | One JS orchestration and its concrete operations are both rendered. Child IDs differ from the wrapper call ID. `parse.ts:1848` registers the wrapper and `parse.ts:2343` independently upserts the shell. `reader.ts:274` exposes the command. There is no explicit parent-call field on the child. |
| The same interval with `FileChange {id: exec-…, changes: {path: {type, content or unified_diff}}, status}` | Wrapper patch and typed patch both become rows (`parse.ts:2380`). Existing diff machinery already computes file counts. |
| `McpToolCall {id: exec-…, server, tool, arguments: object, result: {content, structuredContent}, duration}` | Typed MCP already reaches the shared summarizer (`parse.ts:2260`, `tools.ts:296`), but the wrapper adds another action; the first argument may be a request identifier rather than meaningful input. `reader.ts:284` omits arguments from its normalized text. |
| `Extension {id: exec-…, kind: web.search, query, action: {type: search, queries: string[]}, results: [{title,url,snippet,…}]}` | This is a web operation. `parse.ts:2267` names it Extension; the object action becomes a JSON preview and grouping uses the opaque tool name. `reader.ts:289` keeps only string action fields and result keys. |
| `function_call {namespace: collaboration, name: followup_task, arguments: JSON string with target/message, call_id}` | Generic first-string fallback at `tools.ts:305` displays only the target. Some real message values are encrypted strings: their plaintext cannot be recovered from this record. The UI must acknowledge unavailable task text rather than display ciphertext. |
| `SubAgentActivity {id, kind: started/interacted/completed, agent_thread_id, agent_path}` | Started/interacted IDs match the collaboration call ID. Completed events carry the agent path but no result text in this shape. `parse.ts:2304` and `reader.ts:301` discard identity and emit a loose kind heading. |
| `Reasoning {id, summary_text: [], raw_content: []}` and a Responses reasoning mirror with empty summary | `parse.ts:2040` creates a source-identified unavailable row even for empty text. `reader.ts:263` correctly returns empty text. |

Design: reuse Claude tool rows and disclosures. Match concrete operations only
inside a single bounded, open exec interval, with the observed `exec-` identity
and matching operation kinds; keep wrappers with missing or ambiguous children.
Never infer success or task plaintext from absent data. Keep source-only legacy
orchestrations readable. Hide empty reasoning while retaining source anchors for delayed live text.
New copy stays within the feed ownership boundary, in English and Ukrainian.


## Validation interpretation

The Claude disclosure anatomy is retained on both screen sizes. Empty reasoning
keeps only hidden source anchors so a later live explanation can take its original
place. Completed sub-agent records report completion; they do not supply a result
body in the observed shape. Encrypted task text is explicitly unavailable.
The existing shared browser driver is extended with a feed case; its fixture and
product changes stay in the feed. Evidence JSON is committed, raster frames stay
local. History also contained a token-volume audit; it had no tool-row repair.

## Credential-chip observation before the review fix

At `92db8083`, `tools.ts:317-318` serializes nested MCP values before
`chip` at `tools.ts:96-99` applies assignment-text redaction. That redactor
consumes only the first whitespace-delimited value: an authorization value
containing a scheme and credential leaves the credential visible. Nested JSON
also loses its key context. `parse.ts:1727-1729` trusts the summarizer's chips;
both Claude tool-use and Codex typed MCP records reach this same path. The
session reader is not responsible for the disclosure.

The current rollout was read again through Viewer `conversation_messages`:
an exec source record, typed CommandExecution and McpToolCall children, and
the exec output remain the observed shape. Existing main only displays the
first string argument, so a query followed by credentials did not expose the
additional fields. Hand-assembled cases will exercise direct sensitive fields,
nested objects and arrays, and Bearer text in ordinary fields for both engines.
The fix must sanitize values before serialization with explicit traversal limits
and reuse the feed's existing record-text redaction.
