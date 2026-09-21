# Repository cleanup inventory

Baseline: `c558a7fca`. Issue states checked on 2026-09-21. The checkout was clean.

The audit covered every tracked file under docs, evidence, spikes, scripts, fixtures, public and security; root files; vendor packaging; and source modules without incoming imports. Baseline checkout payload: **3,094 tracked files, 62,254,260 bytes**. Bytes are the sum of tracked file sizes, excluding Git history, dependencies and generated build output.

## Method

For each removal, searched the full path and basename across all tracked text, including hidden workflows, package scripts, Docker/deploy inputs, tests, privacy manifests and the placeholder generator, documentation and runtime strings. Checked parent directories and extensionless names for generated paths and imports. Resolved TypeScript/JavaScript imports with the installed TypeScript resolver, including the `@/` alias, then checked runtime string references separately. Open issue bodies were checked for retained design and evidence dependencies. No dependency was added.

A reference within a removed group is identified below. Generic basenames are disambiguated by their containing path. No retained consumer or document link points into a removed group. Deleted paths in this inventory are historical identifiers, not links.

## Candidate inventory and dispositions

| Area / candidate | Decision and evidence |
| --- | --- |
| Closed-issue screenshots and acceptance stills | Remove the individual files listed below; capture harnesses for closed issues 390 and 406 have no external callers. |
| Issue media | Remove twelve unreferenced rasters from closed issues 145, 155 and 292; preserve every README-linked asset and every privacy-listed asset. |
| Completed runtime spike 25 and its report | Remove as one group. The report is the only external referrer into the spike and has no incoming references. The production runtime hosts replace the prototype. |
| Closed-issue JSON evidence | Remove the listed unconsumed records; retain evidence referenced by tests, docs or open issues, including all issue 1695 evidence. |
| Board capture scripts 1614 and 1758 | Remove uncalled issue-specific drivers; issue 1758 output goes with its driver. The shared geometry driver and browser suites stay. |
| `src/hooks/useColumns.ts`, `src/lib/runtime/index.ts` | Remove: no resolved incoming import, runtime path consumer or package export. The runtime implementation modules remain imported directly. |
| Other `scripts/` | Keep CI/deploy/build/package/privacy tools and scripts with callers. Keep uncalled manual verification scripts pending a retention decision; details below. |
| `fixtures/` | Keep all demo-home fixtures: `scripts/demo-capture.ts` copies the directory and renders templates; filenames alone cannot establish non-use. |
| `public/` | Keep audio and the push service worker. `src/lib/audio/loopAsset.ts` selects the ambient WAV; `cues.ts` selects fixed and variant MP3 names; browser push code registers the service worker. |
| `security/audit-allowlist.json` | Keep: dependency audit in CI reads it. |
| `vendor/` | Keep, owner decision only. Package files and Telegram provisioning consume the vendored tree. |
| Root files | Keep README, architecture/contribution guides, changelog, license, build/config/test entry points and lockfile. Keep `spec.md` pending a retention decision. |
| `docs/design/` | Keep all design documents: active links, open work, retirement dependencies or unresolved historical value. Protected designs and documents linked from README, ARCHITECTURE or CONTRIBUTING stay. |
| Remaining `docs/` | Keep release, operational, investigation, performance, research and acceptance notes whose archival value is uncertain, plus referenced media and provenance. |
| `spikes/issue-863/` | Keep: performance test points to the profile, and the retirement design cites its corpus. |
| Other source candidates | Keep runtime workers, subprocess fixtures, framework entries and MCP entry points: runtime strings reach these without imports. Keep `SectionHeader.tsx` (design-system references) and `WorkflowStrip.tsx` (retirement design reference). |
| Fenced areas | Preserve `src/lib/flows`, `src/components/flows`, `src/lib/reviewHistory`, `evals/`, README, changelog, license and CI/deploy consumers. |

## Removal ledger

Each row passed the full-path and basename search. Counts and byte sizes are from the baseline checkout. `Zero` means no references outside the file or removal group.

| File | Bytes | Non-use proof / historical reason |
| --- | ---: | --- |
| `docs/acceptance/issue-334-342/terminal-retry-desktop-1440.png` | 135,722 | Zero retained references; closed issue 334, 342 |
| `docs/acceptance/issue-334-342/terminal-retry-mobile-390.png` | 38,205 | Zero retained references; closed issue 334, 342 |
| `docs/acceptance/issue-383/successor-lineage-desktop-1440.png` | 82,070 | Zero retained references; closed issue 383 |
| `docs/acceptance/issue-383/successor-lineage-mobile-390.png` | 62,968 | Zero retained references; closed issue 383 |
| `docs/acceptance/issue-383/superseded-round-desktop-1440.png` | 136,425 | Zero retained references; closed issue 383 |
| `docs/acceptance/issue-383/superseded-round-mobile-390.png` | 54,879 | Zero retained references; closed issue 383 |
| `docs/acceptance/issue-404/empty-preflight-desktop-1440-en.png` | 138,760 | Zero retained references; closed issue 404 |
| `docs/acceptance/issue-404/empty-preflight-desktop-1440-uk.png` | 142,152 | Zero retained references; closed issue 404 |
| `docs/acceptance/issue-404/empty-preflight-mobile-390-en.png` | 56,382 | Zero retained references; closed issue 404 |
| `docs/acceptance/issue-404/empty-preflight-mobile-390-uk.png` | 56,559 | Zero retained references; closed issue 404 |
| `docs/screenshots/issue-241/current-board-atlas.png` | 432,059 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-241/current-codex-pane.png` | 280,516 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-241/current-live-pane.png` | 347,794 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-241/current-mobile-pane.png` | 159,206 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-241/current-mobile-question.png` | 169,661 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-241/current-question-pane.png` | 309,310 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-241/current-subagent-pane.png` | 244,970 | Zero retained references; closed issue 241 |
| `docs/screenshots/issue-390/after-strip-390-uk-light.png` | 21,371 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/after-strip-uk-light.png` | 34,597 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/apply-error-codex-390-en-light.png` | 25,045 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/apply-error-codex-en-light.png` | 38,267 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/applying-codex-390-en-light.png` | 24,598 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/applying-codex-en-light.png` | 38,091 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/before-strip-390-uk-light.png` | 26,649 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/before-strip-uk-light.png` | 43,356 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/capture.sh` | 3,976 | Zero retained references; closed issue 390; common basename hits resolve to other directories |
| `docs/screenshots/issue-390/claude-disabled-en-light.png` | 50,860 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/claude-disabled-uk-light.png` | 55,749 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/harness.tsx` | 13,960 | Zero retained references; closed issue 390; common basename hits resolve to other directories |
| `docs/screenshots/issue-390/model-codex-en-light.png` | 49,241 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/popover-codex-en-dark.png` | 54,355 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/popover-codex-en-light.png` | 58,421 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/popover-codex-uk-light.png` | 63,814 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/rest-codex-390-en-light.png` | 21,968 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/rest-codex-en-light.png` | 35,232 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/rest-codex-uk-dark.png` | 34,611 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/resume-codex-en-light.png` | 58,421 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/sheet-codex-390-en-light.png` | 34,978 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/sheet-codex-390-uk-dark.png` | 40,709 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/speed-codex-en-light.png` | 49,478 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/stage-controls-390-en-light.png` | 31,582 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-390/stage-controls-en-light.png` | 45,012 | Zero retained references; closed issue 390 |
| `docs/screenshots/issue-406/capture.sh` | 1,995 | Zero retained references; closed issue 406; common basename hits resolve to other directories |
| `docs/screenshots/issue-406/finished-1440-en-light.png` | 27,664 | Zero retained references; closed issue 406 |
| `docs/screenshots/issue-406/finished-390-en-light.png` | 15,075 | Zero retained references; closed issue 406 |
| `docs/screenshots/issue-406/harness.tsx` | 2,319 | Zero retained references; closed issue 406; common basename hits resolve to other directories |
| `docs/screenshots/issue-406/running-1440-en-light.png` | 28,638 | Zero retained references; closed issue 406 |
| `docs/screenshots/issue-406/running-1440-uk-dark.png` | 28,244 | Zero retained references; closed issue 406 |
| `docs/screenshots/issue-406/running-390-en-light.png` | 16,226 | Zero retained references; closed issue 406 |
| `docs/screenshots/issue-406/running-390-uk-dark.png` | 16,002 | Zero retained references; closed issue 406 |
| `spikes/issue-25/README.md` | 2,588 | Only prototype/report group references; closed issue 25; production hosts supersede it; common basename hits resolve to other directories |
| `spikes/issue-25/claude-broker.ts` | 4,284 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/claude-late-viewer.ts` | 1,649 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/claude-stream-json-demo.ts` | 5,486 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/claude-wire.ts` | 493 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/codex-app-server-demo.ts` | 5,849 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/codex-late-viewer.ts` | 1,715 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/codex-rpc.ts` | 4,465 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/evidence/claude-stream-json.jsonl` | 2,101 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/evidence/codex-app-server.jsonl` | 3,379 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `spikes/issue-25/lib.test.ts` | 1,648 | Only prototype/report group references; closed issue 25; production hosts supersede it; common basename hits resolve to other directories |
| `spikes/issue-25/lib.ts` | 3,076 | Only prototype/report group references; closed issue 25; production hosts supersede it; common basename hits resolve to other directories |
| `spikes/issue-25/ws-inbox.ts` | 1,574 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `docs/spikes/issue-25-runtime.md` | 10,707 | Only prototype/report group references; closed issue 25; production hosts supersede it |
| `scripts/capture-issue-1614-board.ts` | 66,578 | Only removed driver/output references; closed issue 1614 |
| `scripts/capture-issue-1758-board-origin.ts` | 21,529 | Only removed driver/output references; closed issue 1758 |
| `evidence/issue-1758/board-origin.json` | 4,589 | Only removed driver/output references; closed issue 1758 |
| `evidence/issue-1059/telegram-states.json` | 4,783 | Zero path/parent consumers; closed issue 1059 |
| `evidence/issue-1841/columns-wide.json` | 179,013 | Zero path/parent consumers; closed issue 1841 |
| `evidence/issue-1841/seat-placement.json` | 171,067 | Zero path/parent consumers; closed issue 1841 |
| `evidence/issue-1841/seats.json` | 63,558 | Zero path/parent consumers; closed issue 1841; basename hits are the distinct state file `orchestrator-seats.json` |
| `evidence/issue-1857/account-removal.json` | 83,751 | Zero path/parent consumers; closed issue 1857; shared driver writes a new file beneath its external capture directory |
| `evidence/issue-1858/escape-and-hints-previous-head.json` | 8,882 | Zero path/parent consumers; closed issue 1858 |
| `evidence/issue-1858/layering-after.json` | 17,924 | Zero path/parent consumers; closed issue 1858 |
| `evidence/issue-1858/layering-before.json` | 23,250 | Zero path/parent consumers; closed issue 1858 |
| `evidence/issue-613/geometry.json` | 6,033 | Zero path/parent consumers; closed issue 613; generic basename belongs to other evidence outputs |
| `evidence/issue-648/geometry.json` | 1,184 | Zero path/parent consumers; closed issue 648; generic basename belongs to other evidence outputs |
| `evidence/issue-653/geometry.json` | 608 | Zero path/parent consumers; closed issue 653; generic basename belongs to other evidence outputs |
| `evidence/issue-866/attention-voice.json` | 5,934 | Zero path/parent consumers; closed issue 866 |
| `evidence/issue-866/back-forward.json` | 11,483 | Zero path/parent consumers; closed issue 866 |
| `evidence/issue-873/handoff.json` | 7,548 | Zero path/parent consumers; closed issue 873; basename hits are temporary test files |
| `evidence/issue-875/preview.json` | 8,828 | Zero path/parent consumers; closed issue 875; basename hits are temporary test files |
| `evidence/issue-884/fragment.json` | 3,720 | Zero path/parent consumers; closed issue 884 |
| `evidence/issue-961/status-vocabulary.json` | 2,332 | Zero path/parent consumers; closed issue 961 |
| `evidence/issue-962/depth-ladder.json` | 4,669 | Zero path/parent consumers; closed issue 962 |
| `evidence/issue-964/card-anatomy.json` | 16,786 | Zero path/parent consumers; closed issue 964 |
| `src/hooks/useColumns.ts` | 728 | Zero resolved incoming imports and runtime path references |
| `src/lib/runtime/index.ts` | 195 | Zero resolved incoming imports and runtime path references; common basename hits resolve to other directories |
| `docs/media/issue-145/after-task-sheet.png` | 30,634 | Zero basename/path references, including privacy lists; closed issue 145 |
| `docs/media/issue-145/after-uk-create.png` | 73,394 | Zero basename/path references, including privacy lists; closed issue 145 |
| `docs/media/issue-145/before-toolbar-overflow.png` | 72,485 | Zero basename/path references, including privacy lists; closed issue 145 |
| `docs/media/issue-155-slice2/after-1440.png` | 257,113 | Zero basename/path references, including privacy lists; closed issue 155 |
| `docs/media/issue-155-slice2/after-390.png` | 138,866 | Zero basename/path references, including privacy lists; closed issue 155 |
| `docs/media/issue-155-slice2/before-390.png` | 130,513 | Zero basename/path references, including privacy lists; closed issue 155 |
| `docs/media/issue-155/after-1440.png` | 109,853 | Zero basename/path references, including privacy lists; closed issue 155 |
| `docs/media/issue-155/after-390.png` | 48,093 | Zero basename/path references, including privacy lists; closed issue 155 |
| `docs/media/issue-155/before-390.png` | 48,133 | Zero basename/path references, including privacy lists; closed issue 155 |
| `docs/media/issue-292/relation-strip-390.png` | 132,987 | Zero basename/path references, including privacy lists; closed issue 292 |
| `docs/media/issue-292/task-card-compact.png` | 155,181 | Zero basename/path references, including privacy lists; closed issue 292 |
| `docs/media/issue-292/task-card-expanded.png` | 155,107 | Zero basename/path references, including privacy lists; closed issue 292 |

## Kept, needs the owner's decision

| Candidate | Reason to keep pending a decision |
| --- | --- |
| `vendor/telegram-mcp` | Explicit fence; packaged connector and provisioning dependency. Removal requires a product/dependency decision. |
| `spec.md` | Closed issue 1059 specification; generic spec references also occur in review kickoff instructions and tests. No requirement to retire this acceptance contract was established. |
| Unreferenced design drafts | Closure or replacement is not established for the design itself: composer-controls, designated-agent-deploys, history-reader, computer-use-grant, conversation-messages, native-codex-queue-adapter, openclaw-engine, orchestrator-handoff-compaction, semantic-paginated-history, spawn-admission-fence, wakatime-integration and windows-support. |
| Manual verification scripts without callers | `verify-child-conversation-controls`, `verify-conversation-controls`, `verify-composer-payload-runtime`, `verify-composer-payload-scenarios`, `verify-composer-payload-storage`, `verify-composer-submissions`, `verify-legacy-composer-draft`, `verify-native-codex-delivery`, `verify-native-codex-injection-races`, `verify-native-queue-payload`: standalone acceptance procedures can remain useful without an automated caller. |
| `scripts/spawn-placeholder-audit.ts` | Uncalled manual diagnostic with a current state-owner entry claim; retirement is uncertain. |
| `docs/media/issue-353/capture-353-edges.ts` | Uncalled historical capture helper alongside retained privacy-bound assets; retain pending capture/provenance ownership decision. |
| Unlinked acceptance, performance, investigation and research notes | Lack of an inbound link does not establish that the recorded findings have been superseded. |
| `evidence/conversation-window/geometry.json`, `evidence/onboarding/geometry.json` | No path consumer found, but an unambiguous closed issue or retirement decision was not established. |

`scripts/profile-switching.ts` stays because open issue 1444 cites it. Active prototypes under desktop-v2, mobile-v2, automation-v2 and codex-api-update stay because open issues cite them. All explicitly protected designs stay.

## Recovery and validation

Every deletion group is archived and its bytes verified before deletion. Each group is committed separately so it can be reverted independently. The baseline inventory, detailed search results, backup manifests and check logs are retained in local scratch storage; they are excluded from publication. No sibling checkout or existing process was changed.

Validation results and final size accounting are recorded in the pull request. Fixtures used by retained tests are unchanged. The removed prototype test is self-contained; no retained workflow or script names it.
