# MCP page cursors

MCP page cursors are opaque 22-character server-side handles. Pass a handle
unchanged as `cursor` with the same tool, caller and query/options. Each handle
expires five minutes after issuance. Reading it or replaying the page does not
extend its lifetime. Invalid, expired, evicted, foreign and mismatched handles
return `cursorReset:true` with no saved page data; restart without the cursor.
Legacy base64 cursors also reset. A reset reruns the requested page using the
current caller and submitted filters, then returns the tool's normal page with
`cursorReset:true`; it never returns the held continuation or its page data.

The MCP service owns the translation outside receipt storage. Receipts retain
the underlying continuation, and an ordinary receipt replay reuses its live
handle. After expiry, a replay can issue a new handle. Resuming a page still
enters the tool's existing authorization and source-validity checks.
Receipt keys stay unchanged. A private caller stamp binds saved continuations;
legacy receipts without that stamp reset pagination without repeating effects.
The stamp is removed before the answer leaves the service.

Each serving process has one store on `globalThis` under a shared symbol,
including when Next.js puts the service in multiple bundles. The task executor
owns task-list handles; the Viewer owns its inline tools' handles. A Viewer or
task-executor restart discards that process's handles: resumption returns
`cursorReset:true`. Handle mappings are never written to disk or shared between processes.
An unidentified compatibility adapter can resume pages through its negotiated
HTTP connection identity. Its operations retain the existing unidentified
authority; the identity scopes pagination only, and a different connection
cannot replay its handle.

The store retains at most 2,048 handles and 8 MiB of accounted continuation
state, including fixed metadata overhead per entry. Insertion evicts the oldest
issued handles first until both limits hold. Identical live continuations reuse
their handle without changing FIFO position. Expiry is checked on lookup;
expired entries also leave through ordinary FIFO eviction. No timer, whole-store
scan, synchronous lock wait or backing-store read is needed.

## Translation boundary

The producer/consumer inventory below describes the existing state kept behind
the handle. Direct HTTP endpoints and internal readers retain their own formats.
The common `createMcpToolService` boundary covers normal HTTP, forwarded stdio,
task HTTP and the task channel before returning a page to an MCP caller.

| MCP family | Existing continuation producer and consumer | Public field |
| --- | --- | --- |
| `list_tasks`, `list_pipelines`, `list_flows` | SQLite board selection, with the in-memory list adapter as fallback | `nextCursor` |
| `list_conversations` | Conversation catalog, then byte-budget page splitting | `nextCursor` |
| `search_transcripts` | Indexed transcript search snapshot | `nextCursor` |
| `conversation_messages` | Reverse transcript message reader | `cursor` |
| `deployment_status` | Deployment-list endpoint or host-retirement report reader | `nextCursor` or `cursor` |
| `agent_fleet`, `agent_activity` | Observed rows split by the MCP byte budget | `nextCursor` |
| `dismiss_attention` read | Needs-you read endpoint | `nextCursor` |
| `curate_rules` read | Revision-bound curation scope reader | `cursor` |
| `telegram_bot_messages` | Telegram message-page endpoint | `nextCursor` |
| `relay_owner_history` | Owner-history date/chat continuation | `nextCursor` |
| `relay_service_tools` | Direct service-tool pages in the live relay turn | `results[].next_cursor` |

Pipeline stage `cursor` objects and numeric lifecycle journal sequence positions
keep their contracts. They do not represent opaque page continuations.

## Response-byte measurement

`bun test src/lib/mcp/pageCursors.integration.test.ts` builds a three-conversation
index at a frozen clock, searches four terms in relevance order, and reads one
conversation per page with `full:true`. The unchanged binding's page is compared
with the MCP service's answer, including its envelope; the test verifies that
only the cursor differs and that the next page still reads the same snapshot.

Three repetitions in the isolated run measured **1,294 → 953 JSON response
bytes**, saving 341 bytes each (26.4%). Totals vary with the generated fixture
path. The underlying cursor was 363 characters; its handle was 22. This is a
fixture measurement, without a latency or aggregate-token claim.
