# MCP input budgets

## Observation before implementation

Observed on 2026-10-21 against main revision `bb9bf4a4`. `package.json` and
`bun.lock` pin `@modelcontextprotocol/sdk` 1.32.0. A frozen installation of
that lockfile supplies both options below; no dependency upgrade is needed.

[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453)
says “Upgrading alone changes nothing” and describes `maxToolInputElements`
as “off by default”. It requires enabling that option and reducing the HTTP
body budget to suit the tools.

The installed SDK source, under `node_modules/@modelcontextprotocol/sdk/dist/esm/`,
confirms:

- `server/mcp.d.ts:10` declares `McpServerOptions.maxToolInputElements`.
  `server/mcp.js:10` counts array entries and own object members recursively;
  `server/mcp.js:207` checks before schema validation. Excess returns an
  `isError: true` tool result naming the maximum, without invoking the tool.
  The matching [upstream source](https://github.com/modelcontextprotocol/typescript-sdk/blob/fd26801b3b387742fe24a90ed4b275dd6072209f/src/server/mcp.ts#L64)
  contains the option, counting algorithm and default.
- `server/webStandardStreamableHttp.d.ts:115` declares `maxRequestBodySize`.
  Its default is 4 MiB. A caller supplying `parsedBody` bypasses this check,
  as the [transport source](https://github.com/modelcontextprotocol/typescript-sdk/blob/fd26801b3b387742fe24a90ed4b275dd6072209f/src/server/webStandardStreamableHttp.ts)
  and the installed `server/webStandardStreamableHttp.js:486` show.
- `server/requestBody.js:29` exports `readRequestBody`. It refuses a declared
  length over the budget without reading, otherwise counts streamed bytes
  before decoding and stops at the first excess. The [reader source](https://github.com/modelcontextprotocol/typescript-sdk/blob/fd26801b3b387742fe24a90ed4b275dd6072209f/src/server/requestBody.ts#L24)
  also supplies the explicit 413 error message.

## Measured workflow envelopes

`src/lib/mcp/inputLimits.test.ts` generates synthetic inputs from current domain
constants, validates the existing schemas, counts elements using the SDK's
semantics, measures UTF-8 bytes of the complete JSON-RPC request, and sends each
through the exported HTTP route and real SDK. Only the final service operation
is inert, so measurement creates no pipelines, publications or bridge messages.
Three-byte Unicode text exercises byte growth beyond character counts.

| Tool | Input envelope | Argument elements | HTTP bytes |
| --- | --- | ---: | ---: |
| `create_pipeline` | 8 stages, 8,000-character prompts, 20 output paths per stage, 256 KiB spec | 246 | 493,480 |
| `publish_prototype_review` | 9 variants, 240 frames with 4,095-byte paths and 200-character captions, 7 questions with 6 options each | 1,417 | 1,172,733 |
| `update_task` | Details at the 20,000-character domain cap | 3 | 60,163 |
| `bridge_report` | 120-character summary, 200-character section items, 240 covered outcome keys | 278 | 20,157 |

`create_pipeline.spec`, bridge arrays and some passthrough values have no finite
schema maximum. These measurements describe supported workflow envelopes;
they cannot establish a mathematical maximum for arbitrary schema-valid JSON.
The transport budgets establish an explicit bound while preserving these
large workflows. No tool schema, field cap, default or downstream operation changes.

`src/lib/mcp/inputLimits.ts` sets **8,192 elements** and **2,097,152 body bytes**.
Against the largest measured envelope, these leave 6,775 elements (478%) and
924,419 bytes (79%) of margin. The body budget is half the SDK's default.
A future workflow requiring a larger envelope should update its measured case
and these budgets together.

## Enforcement paths

The producers are the stdio adapter and SDK HTTP clients. The HTTP route also
accepts native peer proof and service-authenticated unattributed clients.
`src/lib/mcp/http.ts` parses bodies for native proof, the small framed task
optimization and ordinary dispatch. Each read now uses the SDK bounded reader
before JSON parsing. Oversized input answers HTTP 413 with
`Payload Too Large: Request body must not exceed 2097152 bytes`.
The transport also receives `maxRequestBodySize: 2097152` explicitly; local
reads enforce the same budget when passing `parsedBody`.

`createViewerMcpServer` is the single element-budget owner. The HTTP route,
stdio entry and task executor worker all call it. The task worker's HTTP path
constructs this same server before validating its already parsed task call;
its private task channel also uses that path. Neither task routing nor caller
authentication gains a bypass of the SDK element check. Direct internal
`McpToolService.callTool` operations keep their domain validation; they do not
perform SDK schema validation.

There is no cumulative counter, settings override or persisted budget to
migrate. Both budgets apply per request. Tests exercise exact boundaries,
first-excess refusals, nested object keys and array entries, missing and
misleading lengths, UTF-8 bytes, native proof, and two fresh OS processes.
Under-budget malformed JSON retains its existing parse error. No performance
gain is claimed; this change bounds admitted input.

## Reproduction

From an isolated scratch export with the frozen dependencies, run these explicit
files through the stage's owned `gate-slot.sh` wrapper:

```sh
bun test ./src/lib/mcp/inputLimits.test.ts
bun test ./src/lib/mcp/http.test.ts
bun test ./src/lib/mcp/http.cancellation.test.ts
bun test ./src/lib/mcp/schemaParity.test.ts
bun test ./src/lib/mcp/answerSizes.test.ts
```

The test preload creates private HOME, config, temporary and state roots.
Set `TMPDIR=/tmp`, omit an inherited state owner/directory so the preload
allocates a fresh state root, and set `LLV_VIEWER_CONTROL_URL` to a closed
loopback port before the test process starts. The census prints its measured
counts and bytes. The byte-boundary and element-boundary cases also prove
that refusals leave the service able to accept another valid request.
