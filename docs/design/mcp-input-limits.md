# MCP input budgets

## Preparing bounded text and guarded writes

Read the current tool schema, copy the target identifiers and guards from its
read tool, then measure the field using its declared unit. A recommended target
leaves drafting space below the real maximum. Values above the target and at
or below the maximum remain valid. A rejected authoritative field must be
rewritten explicitly; no length repair may discard a condition, identifier,
receipt or provenance.

| Input | Hard maximum | Recommended target | Measurement |
| --- | ---: | ---: | --- |
| Lesson/rewrite rule | 300 (minimum 20) | 240 | Unicode code points after trimming and collapsing whitespace |
| Lesson/rewrite reason, closing `none` | 160 | 120 | Same normalized code points; rule and reason also need 16 letters or digits after NFKC matching normalization |
| Curation editorial note | 1000 | 750 | UTF-16 code units after schema trimming; direct domain writers also check raw length |
| Problem statement / evidence | 300 / 1000 | 240 / 750 | Same normalized code points |
| Task title/body | 6000 | 4500 | UTF-16 code units after task text normalization |
| Task note | 280 | 220 | UTF-16 code units after collapsing whitespace and trimming |
| Task details, including the result of line edits | 20000 | 15000 | UTF-16 code units; replacements trim, line edits preserve indentation |
| Task step id / reference | 40 / 200 | exact identity | ASCII bytes for ids; UTF-16 code units after trimming references |
| Task step text | 120 | 90 | UTF-16 code units after trimming; at most 20 steps |
| Task summary headline / text / left | 120 / 600 / 200 | 90 / 450 / 150 | Raw Unicode code points and normalized UTF-16 code units; whitespace collapses |
| Hold note / reference | 200 / 500 | 150 / exact reference | Note collapses whitespace; reference is preserved exactly, in UTF-16 code units |
| Monitor authored instructions (combined) | 500 | 375 | UTF-16 code units of the merged instruction text |
| Monitor prompt | 16000 | 12000 | Both raw and trimmed/redacted UTF-16 code units must fit |
| Decision question / option label | 300 / 120 | 240 / 90 | Unicode code points after trimming |
| Decision answer (`resolve-decision`) | 12000 | 9000 | UTF-16 code units; key at most 200 units |
| Stage summary / blocked reason | 2000 | 1500 | Trimmed UTF-16 code units; summary also keeps its raw 2000-code-point bound |
| Stage result | 160 | 120 | Raw Unicode code points and normalized UTF-16 code units; whitespace collapses |
| Stage finding text | 1995 | 1500 | Raw Unicode code points and trimmed UTF-16 code units; severity prefix makes the stored bound 2000 units; at most 50 findings |
| Complete bridge report | 8192 | 6000 | UTF-8 bytes of summary, headings and items joined by newlines |

The recognisability counter applies NFKC to its matching view; stored rule and
provenance text retain their Unicode spelling.

An astral scalar occupies one Unicode code point, two UTF-16 code units and
four UTF-8 bytes. Combining marks are separate code points. These limits count
neither grapheme clusters nor the escaped JSON representation. Zod string bounds in this dependency version count Unicode code points.
The form store and replica reader use that metric. Domain fields that use
JavaScript string length retain their explicit UTF-16 bounds. The affected schemas publish their unit explicitly;
normalized bounds use `x-normalized-minLength` and
`x-normalized-maxLength`, because a raw JSON Schema `maxLength` would reject
valid padded input before normalization. A field with both a raw code-point
bound and a normalized UTF-16 bound publishes both metrics. UTF-16 schemas check code units explicitly and expose `x-length-unit`.
Their raw JSON Schema bounds are necessary scalar bounds; the explicit
validator enforces the declared code-unit maximum.

The protocol can check a raw field before a domain writer normalizes it.
Draft within the raw bound as well as the normalized one. Task details line
edits are checked against the resulting whole field atomically. New hold and
nested step writes refuse overages before persistence; readers preserve legacy
full hold references, reasons and monitor prompts so recovery loses no text.
Opaque `ref` values also remain complete in MCP answers; display abbreviation
does not turn an external reference into an unusable prefix. Only
task/pr/issue/external holds retain a reference. Unsupported hold kinds
still normalize to `unstated` with a warning.

`update_task` requires `expectedProject` and `expectedRevision` together when
either is supplied, for hide/restoreHold and for guarded position/placement
writes. Copy both from `get_task`; a mismatch requires a fresh read and a new
decision. The schema publishes the dependencies and checks them before a
receipt or mutation. `pipeline_action resolve-decision` requires `answer`,
`expectedStageId`, positive `expectedAttempt` and `expectedRevision` from
`get_pipeline`. Other actions keep their own guards: graph edits use
`expectedStageDigest`, and retrying a failed launch uses its own launch identity.

Deterministic pipeline argument errors and stale guards preserve their code
and field and refuse unchanged automatic retries. Invalid stage reports do the
same. A retryability flag supplies no proof that an earlier effect never ran.

After a deterministic no-effect refusal, correct the named field using the
reported limit and actual length, then submit the changed payload with a new
key. For uncertain execution, keep the original key and arguments or use the
operation's recovery read. `message_receipt` takes the accepted send's
`operationId`; pipeline, launch and client request identifiers name other
families. An unknown receipt is a non-retryable lookup error and supplies no
proof that an original effect did not happen.

For bridge reports, 120 summary units and 200 item units are display targets.
The full report remains recoverable within the 8192-byte bound. An over-limit
whole report is refused with its actual byte count before recording or
delivery. Summarize whole items or split complete reports under distinct keys,
preserving every owed decision.

The contract paths are:

- MCP discovery and SDK admission: `src/lib/mcp/server.ts`, shared by HTTP,
  stdio and task execution; internal service calls still use domain validation.
- Lessons: `roleStage.ts` and `roleProblems.ts`, then the role store and its
  existing curation/replay paths. Curation shares the lesson schema.
- Tasks: create/patch commands and nested step parsing, then the store and its
  hold/summary readers; full details and line edits share the whole-field bound.
- Forms: `prototypeReview/input.ts` is shared by MCP and publication parsing.
- Stage completion: SDK schema and `pipelines/verdict.ts`, then persisted stage
  reports. Summary overages are refused rather than silently sliced.
- Monitor notes: settings writer and legacy reader, then wake composition.
- Bridge reports: renderer measures the complete retained representation;
  binding admission precedes storage and delivery.

`src/lib/mcp/textLimits.test.ts` drives the production SDK/service builders and
domain writers at the maximum and one over, including Unicode, corrected
retries, zero dispatch on refusal, nested holds and persisted readback. The
existing bridge, monitor, hold and stage-verdict files cover their complete
production paths. No hard maximum is raised and no performance gain is claimed.

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
constants, validates the existing schemas and the production domain validators,
counts elements using the SDK's semantics, measures UTF-8 bytes of the complete
JSON-RPC request, and sends each through the exported HTTP route and real SDK.
Pipeline validation runs with repository preflight stubbed after request-shape
validation; prototype parsing, task detail updates and bridge report size checks
use their production validators. Only the final service operation is inert, so
measurement creates no pipelines, publications or bridge messages. Three-byte
Unicode text exercises byte growth beyond character counts, while quoted
prototype paths exercise JSON escaping at the accepted path-length limit.

| Tool | Input envelope | Argument elements | HTTP bytes |
| --- | --- | ---: | ---: |
| `create_pipeline` | 8 stages, 8,000-character prompts, 20 maximum-length output paths per stage, 16,000-character spec | 246 | 280,208 |
| `publish_prototype_review` | 9 variants, 240 frames with 4,088-character quote-heavy paths and 200-character captions, 7 questions with 6 options each | 1,417 | 2,150,103 |
| `publish_prototype_review` | 240 frames with one readable 4,094-character segmented path containing U+0001 characters and 200-character captions, plus 7 maximum questions and 6 options each | 1,377 | 5,858,677–5,937,877 across isolated temp-root lengths |
| `update_task` | Details at the 20,000-character domain cap | 3 | 60,163 |
| `bridge_report` | 120-character summary, 27 section items at 200 characters, 64 covered outcome keys; whole-report limit enforced | 102 | 6,929 |

`create_pipeline.spec`, bridge arrays and some passthrough values have no finite
schema maximum. The measured workflow envelopes pass their domain validators
as well as SDK and HTTP validation; they cannot establish a mathematical
maximum for arbitrary schema-valid JSON. Bridge report content also passes the
production whole-report byte limit. The transport budgets establish an explicit
bound while preserving these large workflows. No tool schema, field cap, default
or downstream operation changes.

`src/lib/mcp/inputLimits.ts` sets **8,192 elements** and **8,388,608 body bytes**.
Against the largest measured envelope, these leave 6,775 elements (478%) and
2,450,731 bytes (29%) of margin. The body budget is twice the SDK's default
4 MiB cap; each ingress path still enforces this explicit cap before parsing.
A future workflow requiring a larger envelope should update its measured case
and these budgets together.

## Enforcement paths

The producers are the stdio adapter and SDK HTTP clients. The HTTP route also
accepts native peer proof and service-authenticated unattributed clients.
`src/lib/mcp/http.ts` parses bodies for native proof, the small framed task
optimization and ordinary dispatch. Each read now uses the SDK bounded reader
before JSON parsing. Oversized input answers HTTP 413 with
`Payload Too Large: Request body must not exceed 8388608 bytes`.
The transport also receives `maxRequestBodySize: 8388608` explicitly; local
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
bun run test ./src/lib/mcp/textLimits.test.ts
bun run test ./src/lib/mcp/inputLimits.test.ts
bun run test ./src/lib/mcp/http.test.ts
bun run test ./src/lib/mcp/http.cancellation.test.ts
bun run test ./src/lib/mcp/schemaParity.test.ts
bun run test ./src/lib/mcp/answerSizes.test.ts
```

The test preload creates private HOME, config, temporary and state roots.
Set `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` to separate
private roots inside the stage's owned scratch directory, and set
`LLV_VIEWER_CONTROL_URL` to a closed loopback port before the test process starts. The census prints its measured
counts and bytes. The byte-boundary and element-boundary cases also prove
that refusals leave the service able to accept another valid request.
