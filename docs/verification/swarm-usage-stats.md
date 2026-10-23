# Swarm usage stats verification

This change applies the independent stats portion of Codex Cloud result 09
(GPT-6.1 Sol) against main at
`adce5764927f7e838f20070cd2968128912e861c`.
The supplied patch is 16 246 bytes and its SHA-256 matches its metadata:
`286a0b9629a0f05b6979ae777e7eb63ceb101233570ee26e2577be5b84800b3d`.
Both the checksum comparison and `git apply --check` exited 0 before applying
the patch; `git apply` exited 0.

The implementation adds the dataset binding in `landing/wrangler.jsonc` and
the protected table in `landing/worker.ts`. It retains the patch's behavior,
clarifies the anonymous report count, and adds fixed-clock boundary assertions
and more fixture exports to the existing Worker test harness. At widths up to
700 px, each rule shows its five labeled counts vertically so headings and
percentages remain readable.

## Slice-1 dependencies and acceptance

PR #3262 was open and unmerged when inspected. Its actual diff adds
`preferences().swarmRules` in `src/lib/telemetry/store.ts`,
`swarmRulesEnabled` in `src/lib/memory/settings.ts`, and the shipped catalog in
`src/lib/memory/swarmRules.json` with its validated readers in `swarmPack.ts`.
These interfaces are absent from the base. No open pull request changed this
patch's five landing files at the initial overlap check.

Per the task's instruction to stay on main and report dependencies, this
change implements the independent stats portion of
`docs/design/swarm-role-memory.md` §3.2. The remaining
slice-2 criteria wait for #3262:

| Design requirement | Result |
| --- | --- |
| Access-protected table per rule over 30 days | Implemented and tested on both stats paths in Bun and workerd. |
| Dataset for anonymous swarm counts | Binding configured; the table tolerates an unavailable or empty dataset. |
| Production Viewer sender, loop label, paged cursor and keyed lesson reads, durable daily claim, five-second timeout | Deferred until slice-1 consent and swarm delivery/catalog interfaces exist on main. |
| Strict 16 KB `/api/swarm/usage` ingestion, exact schema, catalog membership, 250-entry and 10 000-count limits | Deferred until the shipped catalog exists on main. |
| Two days produce two identifier-free requests | Deferred with the sender. |
| Environment opt-outs send nothing | Deferred with the sender and consent integration. |
| Malformed or excessive usage submissions answer 400 without writes | Deferred with ingestion. |

The complete slice-2 feature is therefore still pending. This change introduces
no sender or ingestion route and makes no claim about live Analytics Engine
data or deployed behavior.

## Data flow and guards

The future ingestion producer must write `index1` as the shipped rule id and
`double1`, `double2`, `double3` as deliveries, applied, and misled counts.
The stats query consumes those columns from `swarm_usage`; test producers in
`landing/worker.test.ts` and `landing/runtime-tests/access.workerd.mjs` return
invented aggregate rows. There is no current production writer, copy, default
writer, or cascade for this binding. Existing install and landing-event
writers retain their datasets.

`validAccess` is the server-side guard before every stats query. Invalid
assertions, claims, keys and signatures reach no SQL; unauthorized methods
cannot write. Both stats paths use the same guard and renderer. `statsQuery`
keeps credentials server-side, refuses redirects, bounds results to 1 000
rows, and renders failures inline. Labels pass through `escapeHtml`.

The new query shares the existing UTC window, upper bound and ten-second
asynchronous SQL timeout. It weights totals by `_sample_interval`, groups only
by rule id, and adds one bounded query per authorized stats request. Applied
rate is applied divided by deliveries; zero deliveries show an em dash.
Reporting install-days count anonymous submissions and can be inflated by
repeat submissions. No performance improvement is claimed.

The SQL uses documented
[aggregate functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/)
and [conditional functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/conditional-functions/).
The tests inspect the exact outgoing SQL and mock its response; they do not
execute it against the live Analytics Engine service.

## Commands and outcomes

Heavy commands ran serially through `gate-remote`, which supplies private HOME,
XDG, TMPDIR and `LLV_STATE_DIR` roots. Main tests ran before patch application.
The complete repository search found two test consumers of `landing/worker.ts`:
the Bun import in `landing/worker.test.ts` and the source read in the workerd
harness.

| Revision | Command | Exit | Outcome |
| --- | --- | --- | --- |
| Main | `gate-remote -- bun test landing/worker.test.ts` | 0 | 103 passed. |
| Main | `gate-remote -- bash -c 'bun install --cwd landing/runtime-tests --frozen-lockfile && node --test landing/runtime-tests/access.workerd.mjs'` | 0 | Install and all 11 workerd cases passed. |
| Branch, supplied patch | `gate-remote -- env STATS_RENDER_DIR=.artifacts/swarm-stats bun test landing/worker.test.ts` | 0 | 105 passed. |
| Branch | `gate-remote -- bash -c 'bun install --cwd landing/runtime-tests --frozen-lockfile && node --test landing/runtime-tests/access.workerd.mjs'` | 0 | All 11 workerd cases passed, including 22 SQL calls over both stats paths. |
| Branch, before fixture refinements | `gate-remote -- bun x tsc --noEmit` | 0 | Typecheck passed. |
| Branch, fixed-clock tests | `gate-remote -- env STATS_RENDER_DIR=.artifacts/swarm-stats bun test landing/worker.test.ts` | 0 | 105 passed, 510 assertions. Repeated during browser capture. |

Browser capture uses the existing `STATS_RENDER_DIR` export and the
`agent-browser` CLI, with synthetic authenticated HTML. The initial browser
launch exited 1 because the runner requires Chromium's `--no-sandbox` option;
the preceding 105 tests passed. A corrected browser sequence exited 0, but its
single screenshot positional argument selected the default output directory.
`gate-remote -- bunx --yes agent-browser screenshot --help` exited 0 and
confirmed the selector/path signature.

The element captures were blank despite populated DOM text, so they were
discarded. Viewport captures after scrolling to the section produced usable
frames. Visual inspection then caught crowded phone headers in the supplied
patch; the stacked presentation fixes that defect.

## Final rendered observations

The final capture batch exited 0. Its individual commands were:

| Command inside the serial `gate-remote` batch | Exit | Outcome |
| --- | --- | --- |
| `STATS_RENDER_DIR=.artifacts/swarm-stats bun test landing/worker.test.ts` | 0 | 105 tests and 510 assertions passed. |
| `bunx --yes agent-browser --session swarm-usage-09 --args '--no-sandbox' --hide-scrollbars false open <exported-fixture>` | 0 each | Four real handler exports opened at each viewport width. |
| `agent-browser set viewport <width> 900` through the same CLI/session | 0 each | Widths 1280 and 390. |
| `agent-browser eval <section-text-range-check>` through the same CLI/session | 0 each | Every visible text range in the swarm section remained within the section and viewport; no page overflow. |
| `agent-browser screenshot --screenshot-dir <capture-directory>` through the same CLI/session | 0 each | All eight final frames were loaded and inspected visually. |
| `bun install --cwd landing/runtime-tests --frozen-lockfile` | 0 | Pinned workerd harness installed in the export. |
| `node --test landing/runtime-tests/access.workerd.mjs` | 0 | All 11 cases passed on the final Worker. |

The exports are `mocked-stats.html`, `empty-stats.html`,
`unavailable-stats.html`, and `zero-stats.html` beneath `STATS_RENDER_DIR`.
The capture uses `CHROME_BIN` supplied by the gate, waits two animation frames
after `scrollIntoView({block: "center"})`, and walks the section's text nodes
using `Range.getClientRects()`. Blank and hidden ranges are excluded. Any
visible range beyond the section's horizontal bounds or viewport's vertical
bounds, or a document wider than the viewport, refuses the check. An exit trap
requests closure of the owned browser session; its individual status is
suppressed, and the enclosing batch exited 0.

| Mode | Width | Visible text ranges | Section top / bottom in a 900 px viewport |
| --- | --- | --- | --- |
| Counts | 1280 | 14 | 638.90625 / 821.40625 |
| Empty | 1280 | 3 | 680.25 / 821.25 |
| Unavailable | 1280 | 3 | 669.90625 / 821.40625 |
| Zero deliveries | 1280 | 14 | 638.90625 / 821.40625 |
| Counts | 390 | 16 | 419.125 / 800.125 |
| Empty | 390 | 6 | 608.125 / 799.625 |
| Unavailable | 390 | 7 | 574.125 / 800.125 |
| Zero deliveries | 390 | 16 | 419.125 / 800.125 |

The opening page scroll is zero; evidence scrolls the swarm section into view.
There is no modal or focus change. All five labels and values fit in the phone
view, including the complete rule id and `25.0%`. Zero deliveries show the
escaped fixture label and an em dash. Empty and unavailable states show their
messages without a table. This surface follows the existing English, dark
stats page.

The final base recheck (`git fetch origin main`, `git rev-parse origin/main`)
exited 0 and still returned the starting main revision. A repeated
`gh pr view 3262` exited 0 and showed it open at
`6b19401e18b453a07f3b1ac406d4f934216c38b0`. The repeated open-PR inventory
exited 0, included 43 open pull requests, and found no landing-file overlap.

## Final static and publication checks

The final type/lint batch ran after the responsive layout change and reported
both individual exit codes, followed by an enclosing exit of 0:

| Command inside `gate-remote` | Exit |
| --- | --- |
| `bun x tsc --noEmit` | 0 |
| `bun x eslint landing/worker.ts landing/worker.test.ts landing/runtime-tests/access.workerd.mjs` | 0 |

`git diff --cached --check` and `bun run privacy:check` exited 0. The latter
used isolated HOME, XDG, TMPDIR and state roots and inspected the staged
verification document as well as the landing files. No workflow changed.
The commit uses the existing hook chain, which repeats staged whitespace,
publication privacy and ESLint checks.
