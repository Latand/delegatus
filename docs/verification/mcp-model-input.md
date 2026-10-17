# MCP results in model input

Base: `c62bc941aefd94dfb6380cbde547dfe9ab5a3e02`. Observed 2026-10-17.
Candidate: the commit containing this record. Native observations and token
counts were repeated on its final source snapshot at 11:41 UTC.

Delegatus sends the original `JSON.stringify(result)` text once to Codex and
Claude Code. Client names from their actual initialize handshakes are
`codex-mcp-client` and `claude-code`. Their native HTTP requests also identify
these clients in User-Agent: `codex-mcp-client/0.162.1` and
`claude-code/2.1.302 (sdk-cli)` in this rehearsal. Formatting uses these names;
they grant no identity or authority. Existing HTTP connections benefit too.

`src/lib/mcp/server.ts` chooses text-only results from the stdio handshake.
`src/lib/mcp/http.ts` chooses them from the HTTP User-Agent, including executor
admission failures. `src/lib/mcpTask.worker.ts` makes the same choice after
`src/lib/mcp/taskExecutor.ts` forwards the header. The private task channel
preserves that header in `src/lib/mcp/taskChannel.ts`. The stable launcher in
`bin/mcp-server.mjs` reads text-only errors for its health accounting; successful
text results need no extra parse.

## Observations before the change

Before source edits, an existing Codex rollout `function_call_output` was
opened at its recorded line 240. Its result-bearing input_text serialized
both `content[0].text` and `structuredContent`. A Claude Code transcript
`tool_result` was opened at its recorded line 33: the model content was one
JSON string; its result metadata held the corresponding object separately.
Those private transcript paths and payloads stay outside the repository.

Fresh native clients then called viewer `list_tasks` against isolated local
fixture providers. They use no account, external model service or live Viewer.
Codex 0.162.1 code mode executed
`text(await tools.mcp__viewer__list_tasks({}));`. The provider's next request
contained the two-copy envelope. This version records the code-mode result as
`custom_tool_call_output`; the test also recognizes `function_call_output`.
Claude Code 2.1.302 forwarded one JSON string in `tool_result.content`.

`src/lib/mcp/modelInput.native.test.ts` runs both engines over stdio and HTTP,
with successful and refused results. On base, the four Codex cases fail at the
duplicate structuredContent assertion; all four Claude cases pass. On the
changed source, all eight pass. Each checks the canonical native transcript
and the next provider request. After the change Claude can use one text block
instead of a string; the JSON inside is byte-for-byte identical. Results with
`isError` retain their error flag and contain the JSON once.

## Compatibility and protocol

The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema)
requires structured output when an output schema is declared. These tools
declare none. The installed SDK 1.31.0's `McpServer.validateToolOutput` in
`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` returns early
without an outputSchema. SDK clients accept the tested text-only shapes.
`src/lib/mcp/modelInput.test.ts` checks the entire declared catalog has no
outputSchema, both engine-facing result shapes, validation errors, and the
admitted deployment probe.

Other clients retain both fields, including HTTP callers without either
engine User-Agent. The internal producers and consumers remain compatible:

| Path | Representation and reason |
| --- | --- |
| `src/lib/mcp/largeReads.ts` | Internal HTTP bridge reads structuredContent, then the outer engine server selects text-only. |
| `src/lib/mcp/http.ts` | Internal callers keep text JSON plus structuredContent; the executor fallback shares the result serializer. |
| `src/runtime-host/mcpRuntimeProbe.ts` | Admitted probe uses its own client name and keeps structured output, including the retired compatibility tool. |
| `scripts/deploy-checkout.py` | Its SDK client retains the structured result. |
| `scripts/transcript-search-bench.ts`, `scripts/mcp-state-writer-benchmark.ts`, `scripts/mcp-memory-benchmark.ts`, `scripts/mcp-call-cost-benchmark.ts` | Their client names and direct internal calls retain structured results. |
| `src/lib/attention/nativeCallerHook.ts` | PreToolUse only injects a caller proof; it never serializes the result. |
| `src/lib/runtime/fixtures/codexSeatSuccessor.ts` | Its fixture client keeps structured output. |
| `src/lib/voiceCompanion/seatTranscript.ts` | Its existing content-text fallback reads errors when structuredContent is absent. |
| Text JSON parsers | The original JSON text remains in content for every client. |

The HTTP tests exercise the real task executor, which serializes its own
response. Recognizable client headers with missing or invalid capabilities
still fail at the existing HTTP capability admission. Cancellation/session
headers and caller proofs keep their existing paths. Client-name changes in
either engine require updating the two-name format selection; the native
regressions detect a changed name or incompatible engine handling.

## Fixed token sample

`src/lib/mcp/fixtures/modelResults.json` contains five synthetic results shaped
like list pages, conversation pages, a mutation acknowledgement, a service
error and a validation error. No live data is committed. Count with:

```sh
uv run --no-project --with tiktoken==0.14.0 python scripts/measure-mcp-result-tokens.py
```

All three repetitions agree. Counts use `o200k_base` in tiktoken 0.14.0.
The Codex column counts the serialized MCP envelope that code mode can expose;
the Claude column counts its payload text after joining text blocks.
Timing prefixes, JSONL storage escaping and API message framing are excluded.
Claude numbers use o200k rather than Claude's native tokenizer.

| Sample | Codex before | Codex after | Claude before | Claude after |
| --- | ---: | ---: | ---: | ---: |
| List page | 1,488 | 757 | 729 | 729 |
| Conversation page | 631 | 328 | 301 | 301 |
| Mutation acknowledgement | 146 | 80 | 64 | 64 |
| Service error | 101 | 59 | 40 | 40 |
| Validation error | 167 | 91 | 73 | 73 |
| Total | 2,533 | 1,315 | 1,207 | 1,207 |

This unweighted fixed sample measures the affected Codex forwarding shape.
Codex calls that already project the text and Claude payload text have no
duplicate to remove. The earlier 128-result workload's 15.05% frequency-weighted
estimate is a separate measurement; this change claims no runtime speed gain.

## Rehearsal commands

Run through `scripts/gate-slot.sh` with private HOME, XDG_CONFIG_HOME,
XDG_CACHE_HOME, TMPDIR, LLV_STATE_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR,
LLV_CODEX_HOME and LLV_CLAUDE_HOME. Pin LLV_VIEWER_CONTROL_URL to
`http://127.0.0.1:1` and runtime socket paths to absent files under that sandbox.
The native fixture providers and HTTP executor tests bind their own port-0
listeners. Use frozen dependencies from the branch's own lockfile.

```sh
LLV_MCP_MODEL_INPUT_TEST=1 bun test src/lib/mcp/modelInput.native.test.ts
bun test src/lib/mcp/modelInput.test.ts
bun test src/lib/mcp/server.test.ts
bun test src/lib/mcp/stdio.integration.test.ts
bun test src/lib/mcp/http.test.ts
bun test src/lib/mcp/http.cancellation.test.ts
bun test src/lib/mcp/largeReads.test.ts
bun test src/lib/mcp/taskExecutor.test.ts
bun test src/lib/mcp/taskChannel.test.ts
bun test src/lib/mcp/answerSizes.test.ts
bun scripts/build-mcp.ts
bun test src/lib/mcp/stdio.integration.test.ts --test-name-pattern "receives JSON once"
node node_modules/typescript/bin/tsc --noEmit
bun scripts/eslint-changes.ts --base origin/main <changed JavaScript and TypeScript files>
bun run privacy:check
```

Hosted checks belong to the seat's subsequent publication. This stage commits
locally with hooks and opens no pull request.
