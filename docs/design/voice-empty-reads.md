The incident's empty voice reads came from literal query matching. The voice
sent `"PR 2800"`; the list selectors searched for the entire lower-case substring
`"pr 2800"` in task text or pipeline titles. The relevant lane titles begin
`"#2800"`. The project resolved successfully, and completed records were eligible.
The associated task carries that PR through its pipelines, without the number
in its own text. Fix both reference parsing and association lookup.

This is the read-only observation and implementation contract for step one.
Implementation, failing-before/passing-after regression tests and deployment
remain work for the build stage.

**Evidence and scope.** All times below are UTC. The incident voice session
started at `2026-10-12T23:33:11.300Z` and ended at
`2026-10-12T23:37:28.295Z`. The stored backend was the API companion. The durable
call journal is `voice-companion/transcripts/<incident-session>.jsonl`, relative
to the installation state directory. Its `session_start` entry and the session
row in `voice-companion.json` agree on the start time. No transcript identities,
opaque production project keys or receipt identities are published here.

`P` below denotes the actual canonical Delegatus project key. The session's
`project` and `currentProject` both equal `P`. The catalog's case-insensitive
`delegatus` name and the configured report label `Delegatus` resolve uniquely
to that same key. Both returned #2800 lanes and their common task have
`project == P`. These equality checks were made from stored JSON and a
read-only SQLite snapshot at `23:41:59.289Z`, `23:42:17.338Z` and
`23:43:18.974Z`; catalog uniqueness was checked at `23:42:53.547Z`.

Deployment evidence is `deployment_status({"compact":true,"limit":4})`, read
during `23:39Z–23:40Z`: `8f1cfd53` succeeded at `23:05:39.638Z`; the successor
`40451576` began at `23:35:04.115Z` and succeeded at `23:37:40.196Z`.
The empty calls below therefore ran before the successor took over. Source
tracing used `git show 8f1cfd53:<file>`, not an assumed main implementation.

**Exact voice arguments.** Durable entries 7 and 30 contain the first calls:

```json
{"name":"list_tasks","arguments":{"project":"Delegatus","statuses":null,"openOnly":null,"query":"PR 2800","ids":null,"cursor":null,"limit":10,"refresh":null}}
{"name":"list_pipelines","arguments":{"project":"Delegatus","state":null,"includeClosed":true,"ids":null,"query":"PR 2800","cursor":null,"limit":10,"refresh":null}}
```

Entries 36 and 37 contain the calls alongside the spoken production check:

```json
{"name":"list_pipelines","arguments":{"project":"Delegatus","state":null,"includeClosed":true,"ids":null,"query":"PR 2800","cursor":null,"limit":10,"refresh":null}}
{"name":"list_tasks","arguments":{"project":"Delegatus","statuses":null,"openOnly":false,"query":"PR 2800","ids":null,"cursor":null,"limit":10,"refresh":null}}
```

Entries 44 and 45 provide a control inside the same call:

```json
{"name":"list_tasks","arguments":{"project":"Delegatus","statuses":null,"openOnly":null,"query":null,"ids":null,"cursor":null,"limit":10,"refresh":null}}
{"name":"list_pipelines","arguments":{"project":"Delegatus","state":null,"includeClosed":null,"ids":null,"query":null,"cursor":null,"limit":10,"refresh":null}}
```

| Entry | Call start | Tool | Stored result |
| --- | --- | --- | --- |
| 7 | 23:33:33.920Z | list_tasks | done; total/shown/more = 0/0/0 |
| 30 | 23:33:36.876Z | list_pipelines | done; 0/0/0 |
| 36 | 23:34:06.207Z | list_pipelines | done; 0/0/0; repeated=true, readSecondsAgo=29 |
| 37 | 23:34:07.908Z | list_tasks | done; 0/0/0 |
| 44 | 23:34:35.700Z | list_tasks | done; 493/10/483 |
| 45 | 23:34:37.464Z | list_pipelines | done; 180/10/170; includes two completed #2800 lanes |

The four empty results have `rows:[]`, `nextCursor:null`, `truncated:false` and
speech `"0 tasks. "` or `"0 pipelines. "`. The control results are paginated and
truncated. Journal entry times are call starts, derived as
`session.createdAt + entry.atMs`; they are not response completion timestamps.

**Resolved server arguments and filters.** `CompanionLiveSessions.read` calls
`resolveProject`, then `CompanionBoardReads.normalize`. Normalization removes
nulls and `refresh`, replaces the name with `P`, and preserves the query.
`CompanionBoardReads.read` adds `compact:true, includeHints:false` before calling
the shared in-process read bindings. The resulting backend inputs are:

| Entries | Backend input, using P for the withheld canonical key |
| --- | --- |
| 7 | `{project:P,query:"PR 2800",limit:10,compact:true,includeHints:false}` |
| 30, 36 | `{project:P,includeClosed:true,query:"PR 2800",limit:10,compact:true,includeHints:false}` |
| 37 | `{project:P,openOnly:false,query:"PR 2800",limit:10,compact:true,includeHints:false}` |
| 44 | `{project:P,limit:10,compact:true,includeHints:false}` |
| 45 | `{project:P,limit:10,compact:true,includeHints:false}` |

The list handlers trim/lowercase the query to `"pr 2800"`; missing query becomes
`""`. Task statuses, placement, priority, ids and updatedSince are unrestricted;
openOnly is false. Pipeline states, ids and updatedSince are unrestricted;
includeClosed is true for the empty pipeline query and false for entry 45.
False excludes closed/hidden lanes, while completed visible lanes remain
eligible. All are first-page reads. Entry 36 reused entry 30's result under
the existing two-minute normalized-call cache; it made no new backend read.
The normalized arguments are reconstructed from the pinned source, because
the journal stores submitted arguments and projected answers rather than a
separate resolved-scope record.

**Receipt comparison.** The seat's stored tool call at `23:34:43.774Z` was
`list_pipelines({clientRequestId:<private-key>,query:"2800",compact:true,
statusOnly:true,includeClosed:true})`. Its SQLite receipt was claimed at
`23:34:43.780Z`, and the transcript result arrived at `23:34:43.810Z`: total=2,
both completed, both carrying `delivery.target.pr=2800` and the same project
as the voice. The seat omitted project. The pinned list handler treats that as
an empty project predicate; this comparison call itself does not prove a
seat-only read fence. Its returned records were independently checked against
`P` in stored state.

Voice board reads call `viewerReadTools` directly through
`createCompanionBoardReadPaths`, bypassing `createMcpToolService` and its receipt
store. Their durable tool entries are the voice receipts available here.
At `23:41:03.675Z`, the read-only MCP receipt query for the incident interval
found the seat's comparison receipt and no keys containing the incident voice
session or the first voice call handles. Absence alone is insufficient proof;
the pinned in-process call path explains why no matching MCP receipt exists.

**Causal verification.** The production selection index in
`src/lib/mcp/boardSelection.ts` indexes only `task.text` / `pipeline.task` and
requires `instr(text, scope.query) > 0`, with a substring-equivalent path for
explicit ids. The fallback implementations in `src/lib/mcp/bindings.ts` use
`.toLowerCase().includes(scope.query)`. Neither searches PR associations.
The same session's unfiltered results establish that records were accessible
while the query returned zero. Later read-only snapshots confirm the literal
predicate yields zero for both lists, while `"2800"` yields two lane titles.
The feature's common task has no `2800` in text or details and no manual link;
its two linked pipelines each carry `delivery.target.pr=2800`. Merely removing
`PR ` would recover the lanes and still miss that task.

The shared selectors, name resolution and normalization are unchanged between
the incident revision and this stage's base. The intervening voice changes
concern private group history, outside these calls. This was established by
`git diff 8f1cfd53..HEAD -- src/lib/mcp/bindings.ts
src/lib/mcp/boardSelection.ts src/lib/voiceCompanion/readPaths.ts
src/lib/voiceCompanion/boardReads.ts src/lib/voiceCompanion/readSchemas.ts
src/lib/voiceCompanion/liveSession.ts` during `23:41Z–23:44Z`.

**Read-only reproduction queries.** Private local bindings `AUDIT_STATE`,
`VOICE_TRANSCRIPT`, `SEAT_TRANSCRIPT`, `P` and `SEAT_REQUEST_KEY` denote the
installation directory, identified journals, verified canonical key and paired
seat receipt key. These bindings are deliberately omitted from this public
document. They select existing artifacts; no application store is instantiated.

The voice extraction at `23:40:47.939Z` was rechecked at `23:46:43Z` with this
command, with `AUDIT_STATE` supplied privately in the environment:

```sh
rtk proxy python3 - <<'PY'
import datetime, json, os
from pathlib import Path
root = Path(os.environ['AUDIT_STATE'])
state = json.loads((root / 'voice-companion.json').read_text())
session = next(s for s in state['sessions'].values() if s['createdAt'] == 1791847991300)
transcript = root / 'voice-companion' / 'transcripts' / (session['id'] + '.jsonl')
for line_number, line in enumerate(transcript.open(), 1):
    entry = json.loads(line)
    data = entry['data']
    if entry['kind'] != 'tool' or data['name'] not in ['list_tasks', 'list_pipelines']:
        continue
    result = json.loads(data['result'])
    instant = datetime.datetime.fromtimestamp((session['createdAt'] + entry['atMs']) / 1000, datetime.timezone.utc)
    print(json.dumps({'line': line_number, 'utc': instant.isoformat(), 'name': data['name'],
                     'arguments': json.loads(data['arguments']), 'status': data['status'],
                     'result': {key: result.get(key) for key in ['total', 'shown', 'more', 'truncated', 'repeated', 'readSecondsAgo']}}, ensure_ascii=False))
PY
```

The state snapshots at `23:41:59.289Z` and `23:42:17.338Z` used Python sqlite3,
`file:<AUDIT_STATE>/state.sqlite?mode=ro`, `PRAGMA query_only=ON`, and `BEGIN`.
The client disconnect ended the transaction. The exact count query was:

```sql
SELECT count(*) FROM state_rows
WHERE collection = ?
  AND json_extract(value_json, '$.project') = ?
  AND instr(lower(json_extract(value_json, ?)), lower(?)) > 0;
```

Bindings were `(pipelines,P,$.task,PR 2800)`, `(pipelines,P,$.task,2800)`,
`(tasks,P,$.text,PR 2800)` and `(tasks,P,$.text,2800)`, yielding 0, 2, 0 and 3.
The three task text matches are other records; the common feature task is absent.
The visible-lane check additionally applied
`json_extract(value_json,'$.state') != 'closed' AND
json_extract(value_json,'$.hiddenAt') IS NULL`; its query counts remain 0 and 2.
Current unfiltered counts have advanced since the call and are not historical
replays of its 493/180 totals.

The MCP snapshot at `23:41:03.675Z` used the same read-only connection options
against `mcp-receipts.sqlite` and this query:

```sql
SELECT receipt_key, claimed_at, result_json, binding_json
FROM mcp_receipts
WHERE claimed_at >= 1791847800000 AND claimed_at < 1791848400000
  AND (receipt_key LIKE '%list_pipelines%' OR receipt_key LIKE '%list_tasks%')
ORDER BY claimed_at;
```

Its UTC bounds are `[23:30:00Z,23:40:00Z)`. The paired seat receipt was selected
by `SEAT_REQUEST_KEY`. Its submitted arguments were read with
`conversation_messages({transcriptPath:SEAT_TRANSCRIPT,
since:"2026-10-12T23:32:00Z",kinds:["message","tool_call","tool_result"],
limit:35,maxChars:2500})`, following the earlier page's cursor with unchanged
filters. The exact matching call/result times are above.

No HTTP voice GET was issued: the session GET calls `service.events`, which
reconciles reports, and creating the service can recover sessions. Reading
stored artifacts avoids those runtime effects. Project-scoped and unscoped
`search_transcripts` queries included `voice list_pipelines 2800`,
`voice empty project`, `"PR-number" "list_tasks"` and `"voice" "empty" "reads"`.
`search_memory` queries included `voice project scope`, `list_pipelines empty`,
`companion project binding` and `PR query task search`. They found this incident
and adjacent voice work, with no prior verified fix for this query defect.
The seat transcript hit was opened through `conversation_messages`; the one
memory hit concerned where pipeline review findings are stored and did not
establish this cause. The restarted attempt's transcript was also read.

**Implementation contract.** Parse a whole PR reference such as `2800`,
`#2800`, `PR 2800` or `pull request 2800` into a number before candidate matching.
Keep ordinary text queries working. Match the parsed number against existing
resolved work links, including delivery, manual, provenance and cached branch
associations; use existing forge helpers and stored cache without a network
refresh. Return tasks with their own matching PR links or matching linked
pipelines. Deduplicate tasks shared by several lanes. Keep references distinct
from longer numbers and from issue links when the query explicitly says PR.
Title-reference matching can cover a lane whose retained title names #2800.

Apply the resolved, authorized project before joining any references, counting
or pagination. Omitted/null voice project continues to use the project in view;
an explicit name must resolve uniquely within the operator's allowed root.
Validate unknown/stale project context and return a structured scope refusal
with speech explaining that nothing was read. Never turn refusal into a zero
count or widen to all projects after a miss. A valid empty project/query can
still return zero. Implement the specification's seat-only project selection
using authenticated designation, including omitted-project calls and explicit
cross-project refusals. Do not infer authority from model-supplied arguments.
Keep session ownership, targeted-record checks and other operation fences.

For PR reads, preserve the observed inclusion of completed lanes and done
tasks; do not inject `state:["open"]` or `openOnly:true`. Retain explicit state,
closed-history and status filters when the operator asks for them. Pagination,
totals, cursor scope and the voice cache must describe the same normalized
reference and project. A prompt-only instruction to retry with `2800` is
insufficient for a task whose text lacks the number.

| Implementation area | Files to examine/change |
| --- | --- |
| Shared query parsing and association selection | `src/lib/mcp/bindings.ts`, `src/lib/mcp/boardSelection.ts`; a small shared query helper if needed |
| Existing PR identity/link rules | `src/lib/forge/resolve.ts`, `src/lib/forge/workLinks.ts`; reuse these rules |
| Voice scope validation, normalized cache and explanatory refusals | `src/lib/voiceCompanion/readPaths.ts`, `src/lib/voiceCompanion/boardReads.ts`, `src/lib/voiceCompanion/liveSession.ts` |
| Query descriptions if the contract changes | `src/lib/voiceCompanion/readSchemas.ts`, relevant list descriptions in `src/lib/mcp/server.ts` |

The local gate/CI and delivery-confirmation lanes are fenced work. No gate,
composer, delivery or runtime lifecycle implementation change is needed for
this cause.

**Regression and required validation.** Add the observed case to
`src/lib/voiceCompanion/readPaths.test.ts`: synthetic project A, two completed
lanes titled with `#2800`, `delivery.target.pr=2800`, and one done task linked
to both with no PR number in its text. Call through `CompanionBoardReads` and
the real production persistence selection with the exact submitted null/filter
shapes above. Assert the query returns both lanes and the one task. This
expectation must fail on the captured main base and pass after the fix.

Cover bare/prefixed references, links without a title number, manual/provenance
associations, longer-number and issue-only negatives, project B with the same
number, deduplication and cursor pagination. Exercise indexed, explicit-id and
fallback selectors so none retains the old substring-only behavior. Put focused
shared-binding coverage in a sibling topic test such as
`src/lib/mcp/pullRequestReads.test.ts`; retain existing link-rule tests in
`src/lib/forge/workLinks.test.ts` and `src/lib/mcp/workLinks.test.ts` when those
implementations change.

Add missing/unknown/ambiguous or unauthorized scope cases to
`src/lib/voiceCompanion/boardReads.test.ts` /
`src/lib/voiceCompanion/readPaths.test.ts`, and verify through
`src/lib/voiceCompanion/liveSession.test.ts` that a refusal yields explanatory
speech instead of `0`. Keep valid-empty results distinct. Test default reads
after a project switch and ensure cached results stay project-specific. Cover
the authenticated seat's own-project default and cross-project refusal through
the real MCP service. Use synthetic words for record identities and repository
names; copy no production record bodies into fixtures.

Run every changed test file explicitly, one process per file, through
`bash scripts/gate-slot.sh bun test <file>` with fresh isolated `HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `CLAUDE_CODE_TMPDIR` and
`LLV_STATE_DIR`. With absent dependencies, export the captured revision into
stage scratch and install there through the gate; leave this audit worktree
untouched. The build stage also owes the repository's types, changed-file ESLint,
privacy and touched-test publication checks. This observation stage changes
only this document; its checks are whitespace and the document's publication
privacy scan. No implementation or behavioral-test pass is claimed here.

The first document scan passed at `2026-10-12T23:45:59.382Z`, using
`bash scripts/gate-slot.sh bun scripts/privacy-publication-gate.ts
--require-known-values --paths docs/design/voice-empty-reads.md` with the
committed fingerprint catalog and isolated environment. Whitespace passed
with `git diff --no-index --check /dev/null docs/design/voice-empty-reads.md`
at `23:46:19Z`. The final document is checked again before the stage report.
