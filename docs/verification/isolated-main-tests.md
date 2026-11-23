Each candidate was run before editing on main `b746244f6` on 2026-11-05.
The branch integrated `cd8236392` and `86864304c`. Those advances update the
remote gate and message delivery. They change none of these test files, policy
tables, voice components, browser fixture inputs, or the test preload. The
standalone files were checked again after integration. Browser receipts retain
the source hashes of the unchanged fixture and repaired voice components.

Every invocation selects one file with `bun run test <file>` and gets a
fresh log, exit status, HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR.
`LLV_VIEWER_CONTROL_URL` points at closed loopback port 1. The package preload
keeps its owned child runner and cleanup. Browser cases additionally set
`LLV_KANBAN_BROWSER_TEST=1`, select one named case, and use a private Chromium
temporary directory. No run uses operator state or a live provider.

| File | State on main | Cause | Change |
| --- | --- | --- | --- |
| `src/lib/voiceCompanion/tools.test.ts` | 12 pass, 1 fail | Five mutating MCP tools lacked voice action summaries. | Add summaries for browser access, recorded checks, voice tool proposals, cloud environment changes and App connection requests; suppress read-only branches. |
| `src/lib/voiceCompanion/readPaths.test.ts` | 14 pass, 4 fail | Fixtures supplied catalog membership without completed project labels, refused hosted transcript descriptions, and skipped inventory preparation. | Supply the current domain boundaries, including project matching before selection; retain all assertions. |
| `src/lib/team/workspaceRoutes.test.ts` | 1 pass, 1 fail | Eleven routes lacked explicit decisions. | Review their handlers and declare them owner-only. Unknown routes were already refused to workspace members by the owner-only default in `src/lib/team/gate.ts`. |
| `src/lib/externalRelay/protocol.test.ts` | 25 pass, 1 fail | A hash froze a current UI measurement file that #3017 deliberately regenerated. | Remove the obsolete `chats.json` capture pin; retain all 34 other pins and every immutable wire hash. |
| `src/components/kanban/KanbanStages.dom.test.tsx` | 47 pass, 2 fail | Two cases required the removed terminal review-grant action. | Remove that obsolete parameterized test. Review budgets stay frozen; existing terminal-action coverage remains. |
| `src/components/kanban/KanbanPipelines.dom.test.tsx` | 32 pass, 1 fail | The fixture declared Assigned work that completion now returns to Inbox. | Declare the intended blocked work explicitly; keep the exact stopped-state assertion. |
| `src/components/pipelines/PipelineBlock.dom.test.tsx` | 26 pass, 2 fail | The fixture still supplied the removed CPU ETA text. | Build elapsed-wait detail with the production `cpuQueueDetail` writer. |
| `src/components/kanban/KanbanOpenAgents.dom.test.tsx` | 11 pass | Green alone. | Unchanged. |
| `src/components/kanban/agentWindowHostedColumn.dom.test.tsx` | 2 pass | Green alone. | Unchanged. |
| `src/components/keys/OpenAiServices.dom.test.tsx` | 51 pass, 6 fail | Assertions predated Rules key routing and its explicit provider preference. | Match #3611 and `src/lib/openaiServices/policy.test.ts`: unsaved Rules follows credentials; explicit choices persist when a key is absent. Exercise both through the UI. |
| `src/components/mobile/MobileShell.board.dom.test.tsx` | 9 pass, 1 fail | Menu expectations were stale; deeper Settings reads received fabricated empty successes. | Retain the full row assertions with the shipped entries, provide the real keys envelope, and refuse unimplemented fixture routes. |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | Four named cases fail separately | Result cards were evicted by following speech; the Ukrainian memory error was clipped at 390 px; the settings control count omitted devices and timers. | Let result cards release their former confirmation height and retain them like reports; reveal the error within its scroller; count the shipped controls. |

The four browser selections are `dropped on a control`, `a refused voice
setting`, `a confirmation the model asked for`, and `off by default`.
The withdrawal-note, complete confirmation-text, single-send, control-overlap
and clipped-error assertions remain intact. The error copy is unchanged.

The old report also described interference when several DOM files share a
runner. This task's one-file procedure avoids that configuration. The five
associated files were checked separately, as listed above; no grouped-run or
flake claim is made.

PR #3650 changes the settings architecture and two of these test files. The
repair hunks keep the existing architecture. Whichever branch lands second
must merge main, retain the new navigation, and keep refusal revelation on
the settings surface that serves the error. Re-run the named browser cases
and both settings DOM files after that integration.
