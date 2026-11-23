# Repair document links in agent messages

Originating requirement, 2026-10-30: make document links in agent messages reliably open the intended file, adjusting link guidance or the opening behavior as needed.

The operator repeated the requirement on 2026-11-05: an agent's document link opens a 404 in another window. Open the intended file through authenticated Delegatus on desktop and phone. The full incident quote, source identities, destinations and provenance remain in the private task and primary transcripts. This brief uses neutral examples throughout.

## Confirmed cause and limits

Inspected source: `1fb5ca202ce8fa702f4e1b526114fe3e2f15af65`. The assigned checkout was clean. A read-only remote check still named this commit as main after reproduction.

The new primary final message, at 2026-11-05 20:33:26.349 UTC, contains a literal repo-relative Markdown destination ending in `.md:102`, without an invisible prefix. Its native journal and normalized conversation record agree. The native session header names the assigned sibling worktree. The stage's declared output was uncommitted at reporting time. Its recorded HEAD and a later passed commit do not prove the report's bytes; the original file SHA-256 remains unproved. Use the source worktree's file, and record its actual hash during acceptance.

| Step | Current implementation and observed consequence |
|---|---|
| Native text to feed | `src/components/feed/parse.ts`, `addProse`, preserves the Markdown destination in prose. `src/lib/scanner/describe.ts:1547` retains transcript `cwd` separately from canonical `projectRoot`. |
| Feed to Markdown | `src/components/LogFeed.tsx:2137,2221,2224` renders live and settled text without passing its source CWD to Markdown. |
| Destination to target | `src/components/feed/markdown.tsx:182` resolves relative links only when `MdDocumentContext` exists. Chat messages have no such document scope. `src/lib/artifact/linkTarget.ts:150` recognizes absolute, home, file URL and Viewer-fragment forms; a relative path returns null. |
| Anchor to browser | `Anchor` falls back to an ordinary anchor. Neutral `[report](docs/research/sample.md:102)` retains that href and navigates to `/docs/research/sample.md:102`, bypassing the artifact opener. |
| Supported control | A clean absolute destination reaches `FileAnchor`, whose resource href and plain-click preview request already work. Supplying the exact source directory to existing `resolveRelative` also yields the intended absolute target. |

The operator's 404/new-window report is primary testimony. The isolated browser reproduced ordinary navigation, with one page and no `target` attribute. The current chat renderer does not itself request a new window for this relative link. Neither an anonymous protected-URL fetch nor the fixture server establishes the installed server's status or the original new-window gesture. No static `/docs` route exists to serve this document.

The earlier diagnosis, final at 2026-10-30 06:11:22.494 UTC, was read directly. Its original three screenshots were inspected visually without OCR: a phone 404, a linked response, and a separate denied document pane. Its confirmed U+200B case still fails at this source: `trim()` preserves a leading U+200B before `/`, the resolver returns null, and the browser encodes it in ordinary navigation. Preserve the earlier distinction between that renderer defect and filesystem authorization.

## Implementation route

Use the existing artifact preview and server checks. Keep the repair within the renderer and pure resolver.

1. Introduce a nullable message-source context beside `MdDocumentContext` in `markdown.tsx`, carrying the source conversation's exact CWD. Keep the two contexts distinct: document scope also changes images and heading scrolling.
2. Add optional `sourceCwd` props to `FeedItem` and `LiveTurnRows`, defaulting to null. `LogFeed` passes `file.cwd` to its own native assistant prose and live rows, and scopes its direct `StreamingMd` branch the same way. Supply the context around those prose bodies only. Do not wrap the whole feed: `DeputyBlock` renders another conversation inside it, and relayed/user/report cards do not automatically inherit the receiving conversation's filesystem base. Existing callers without a proven source keep null. No source CWD is inferred from the selected project, canonical `projectRoot`, browser pathname, current HEAD or process directory.
3. In `Anchor`, preserve file-confirmation handling, document-relative links and Viewer hashes. For an otherwise unresolved relative file link with a proven source CWD, use existing `resolveRelative`, then `resolveLink`. Limit interception to previewable file destinations using the existing pure artifact classifier after suffix/fragment parsing. Leave generic browser routes, query links, bare headings, schemes and protocol-relative web links outside this new branch. A previewed document's own base directory takes precedence over message context.
4. Pass the resulting absolute spelling and `FileLinkTarget` to existing `FileAnchor`. The click must carry that resolved target through `previewBus` to `ArtifactPreviewHost`; it must never re-resolve the relative spelling against another context. Copy and modified-click hrefs remain authenticated `/api/artifact?path=…` resource URLs. Retain current suffix/heading behavior: Markdown line links enter source view; columns remain parsed metadata where supported.
5. In shared `resolveLink`, normalize only the observed literal leading U+200B prefix immediately before a local absolute destination. Preserve interior Unicode, ordinary URL encoding, external protocols, existing parentheses escaping, suffixes and fragments. Do not globally decode destinations or reinterpret an already-generated `/%E2%80%8B/…` browser URL as a trusted local path.

The current incident has a proved native source CWD. Unknown provenance stays unresolved; a missing/deleted source file shows the existing missing/denied preview result when its absolute target is known. Never search another checkout for the same basename. If future records require per-turn CWD changes, prove that case before extending parser metadata; the parser's private `conversationCwd` currently supports tool display and is not attached to prose rows.

## Keep-list and shared consumers

| Editable implementation surface | Required work |
|---|---|
| `src/lib/artifact/linkTarget.ts`, `.test.ts` | Narrow U+200B normalization; retain pure parsing and relative joining. |
| `src/components/feed/markdown.tsx`, `artifactAnchor.dom.test.tsx` | Separate nullable message context, guarded relative-file resolution, real click regressions. |
| `src/components/LogFeed.tsx`, `src/components/feed/FeedItem.tsx`, `src/components/conversation/LiveTurnRows.tsx` | Carry exact source CWD through native settled/live prose; reset isolation at conversation changes and foreign-content boundaries. |
| Existing `src/components/conversation/conversationWindow.browser.test.tsx` and `conversationWindowEvidence.fixture.tsx` | Add a reusable document-link case using real feed and preview components. No new driver. |

Read/verify without policy changes: `ArtifactPreviewHost`, `previewBus`, `artifactResource`, `DocumentPanes`, `markdownDocument`, artifact and frame routes, `localFile`, `workspaceRoute`, `workspaceAccess`, `proxy` and the team gate. Existing resolver consumers include fragment routing, Markdown documents, preview target fallback and local file chips; their calls without source context retain existing semantics. Images keep their existing source/document rules. Memoized feed items must receive CWD through props/context rather than a mutable global.

Read the installed Next 16.4.2 guides before implementing: `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`, `04-linking-and-navigating.md`, and `15-route-handlers.md`. They were read for this brief. Context/events remain client-side; bytes remain a dynamic authenticated Route Handler response.

## Authorization and the historical denied document

The server remains authoritative. A source CWD identifies a file and grants no access. All changed link entry points must still reach these checks:

| Read surface | Existing boundary to preserve |
|---|---|
| Meta, body, download, ranges | `proxy`: Host/perimeter and team-session gate; `workspaceRoute`: current session and project access before handler and revalidation after reads; `route.ts`: same-origin rejection, lexical admission, realpath admission, workspace `canReadFile`, pinned descriptor, classification/sniff, size/time limits and validators. |
| HTML frame and its assets | Existing minted directory scope, frame route verification and sandbox/CSP. No new token or frame authority. |
| Other filesystem readers | `/api/image` and album readers share `localFile` policy; keeping that policy unchanged prevents this repair from adding a read surface there. |

Registered exact projects/worktrees and product scratch remain the document roots. Evidence roots remain raster-only; fenced stores remain excluded. Team APIs return 401 for an anonymous caller and 403 for a caller outside the workspace, subject to the installation's perimeter checks. Test revoked sessions and membership changes; a browser-supplied CWD or forged path never overrides these decisions.

The sealed historical handoff is a separate root/workspace refusal. Preserve its original bytes, modes, seal, manifests and checksums. The earlier neutral production-route probe established that one byte-exact copy in product-owned scratch could be owner-readable while an unrelated member and anonymous caller were refused. Scratch is temporary and supplies no durable member grant. This stage creates no copy. Later delivery must first establish the intended user's supported authenticated context, then use a sanctioned narrow artifact mechanism and verify its returned bytes from the original message. If that mechanism or authority is unavailable, record the exact delivery gap and keep this acceptance item open. No blanket home/evidence roots or new memberships are authorized.

## Regression and browser contract

Add failing tests on the captured base, then show the same assertions passing on the implementation head. The diagnostic additions below are scratch-only and intentionally do not constitute a repair.

- Through actual `LogFeed`/`FeedItem`, Markdown and click: a neutral repo-relative uncommitted declared output opens the source worktree's distinct content. Seed the same filename in the parent repo and a sibling with different bytes. Change selected project and later-current HEAD metadata; the old message keeps its source CWD. Missing source worktree must never fall back to either duplicate. Cover history, completed live overlay and history takeover, switching conversations, missing CWD, deputy and relayed-content isolation.
- Resolver and renderer: `:102`, `:102:7`, `#L102`, heading/encoded fragment, `./` and `../`, literal leading U+200B, internal U+200B and other valid Unicode, spaces/escaped parentheses, file URLs, home paths, transcript/Viewer hashes, external percent-encoded URLs, `mailto:`, ordinary routes and query/heading links. Keep document-relative links/images and Telegram file confirmations working. Exercise plain, keyboard, modified and middle clicks.
- Through existing server fixtures: anonymous, revoked session, wrong workspace/member; traversal including encoded/double-encoded forms; final/parent symlink escapes and races; sibling-prefix confusion; unregistered home/private documents; fenced stores; meta/body/download and HTML frame paths as applicable. Current checks must deny them without widened roots. Metadata must never expose contents.
- Extend the existing conversation-window driver with real neutral message clicks and an isolated authenticated route adapter. Render at 390×844 with touch, 820×900 and 1280×900, both en/uk and light/dark. Record the requested absolute path, meta/body statuses and expected content/hash. Inspect the intended file/version and supported source-line/heading location. Verify close/Back, no surprise page/window, existing denied/missing/changed states, and safe explicit external opening. Measure text ranges, viewport containment, controls and focus/inert behavior for the existing pane where modal. Visually inspect every retained frame without OCR. A mocked successful content fetch alone does not prove authorization.

## Checks performed and remaining acceptance

All probes used a Git archive of the inspected source under the stage's own scratch, isolated HOME/config/temp/state, `LLV_VIEWER_CONTROL_URL` on a closed port, Bun 1.4.0 and the declared gate wrapper, one explicit file per invocation. No product edit, live-state test/write, build, staging, commit, push, restart or source-project mutation occurred. Only this declared document changes in the assigned checkout.

| Command inside the isolated export | Result |
|---|---|
| `bun run test src/components/feed/artifactAnchor.dom.test.tsx` with two diagnostic assertions appended | 11 existing pass; 2 expected failures. Each broken destination produces zero preview requests where one is required. |
| `LLV_CONVERSATION_BROWSER_TEST=1 bun run test src/components/conversation/conversationWindow.browser.test.tsx --test-name-pattern 'document link baseline diagnosis'` | 1 pass, 51 filtered. Real clicks at 390/en/light and 1280/uk/dark reproduce ordinary relative navigation; clean absolute control opens preview. Both neutral frames visually inspected. This is baseline diagnosis, not repaired UI acceptance. |
| `bun run test src/app/api/artifact/route.test.ts` with one neutral source/sibling control appended | 23 pass, including existing traversal/symlink/origin/root checks. Joining to exact source CWD serves the uncommitted output's distinct bytes with parsed line, column and heading retained. |
| `bun scripts/privacy-publication-gate.ts --repository <scratch-export> --require-known-values --paths docs/design/document-link-repair.md` | PASS for the complete declared document, using the repository's committed fingerprints. |

The first browser attempt ended before rendering because Chromium's socket path exceeded the Unix limit. The successful run used a short descriptor alias to its own scratch directory. Both terminal receipts are retained. Neutral patches, all gate logs, screenshots and browser readings are under `$LLV_EVIDENCE_DIR/diagnosis` and `$LLV_EVIDENCE_DIR/baseline-neutral`; no incident document was copied there.

For implementation, run changed/direct tests by explicit path through the declared gate wrapper, with private HOME, XDG_CONFIG_HOME, TMPDIR, LLV_STATE_DIR and closed control URL. Select `linkTarget.test.ts`, `artifactAnchor.dom.test.tsx`, relevant feed/live DOM tests, `ArtifactPreviewHost.dom.test.tsx`, `DocumentPanes.dom.test.tsx`, artifact/frame route tests and workspace tests by the actual change and threat cases. Run the browser case above with the final head's real feed, preview and auth adapter. Do not run directory lifecycle suites. Type/build/full publication checks belong to the authorized publication step; preserve hooks and required CI contexts. Use three independent review rounds because authorization boundaries are high risk.

The release report must name the final source SHA, actual checks, retained rendered evidence, installed serving SHA and precise release/auth gaps. Installed acceptance still requires the intended authenticated user to click the original new report message and the historical handoff, proving the correct file/version. No deployed opening or task completion is claimed by this design stage.

## Open changes

Read-only inventory found 20 open PRs and 19 open Delegatus lanes. Relevant actual diffs: document-handoff design #3644 proposes a new managed store/report contract; this lane needs its separate renderer repair and carries no approval for that store. #3491 and #3396 append prototype cases to the conversation-window driver. #3650 changes shared browser-harness settings captures; its fixture-serving path is outside those hunks. Add a separate case and preserve those changes. No open diff changes the resolver/Markdown/LogFeed files in this keep-list. Recheck open diffs and main immediately before implementation and final review; earlier October overlap lists are historical.

## Deferred — not currently justified

- A new store, schema, grant, MCP publication contract or automatic deliverable collector; coordinate any durable handoff design separately with the existing document-handoff work.
- Generic filesystem/page redirects, a static `/docs` route, blanket roots, private-document publication, prompt-wide link-format changes and UI redesign.
- Runtime/account/configuration changes, cleanup, source-worktree changes, restarts and deployment in this stage.
- Historical file snapshots or per-turn provenance storage. Preserve the proved source path now; do not claim immutable historical bytes from a commit identifier.
