> Operator request (2026-10-05, paraphrased): look at the whole interface again from how I really use it (how I talk to agents, what tasks I do) and work out how the UX should be redesigned. I want several different prototypes. First the sidebar: remove it altogether or recombine it differently while keeping every function it has now; it does not look good. The burger and three-dots menus hold too many buttons and should be done differently. Take liquid glass and Apple's approaches as the base; there is a `ui-ux-pro-max` skill, use it (and `frontend-design`). Take screenshots from production, and never publish them in any issue or PR: it is my working project. UI only. After the prototypes we decide on the rework.

# Interface redesign: usage audit and control inventory

Date: 2026-10-05. Source of the opening requirement: the pinned specification supplied with this design task. It is the supplied paraphrase, reproduced verbatim; the original conversation was read privately.

This note completes deliverables 1 and 2. It records the operator's working pattern, the current functions, and measurable friction. It authorizes no implementation and selects no replacement interface. Numbered prototypes and the operator's choice belong to the next design step. No product source, live settings, or services were changed.

## Evidence and limits

Source references below are repository-relative `file:line` locations at `ee19907eb0dc9a9e39fc0fd23363d1869eb9b2e3`. The running installation was observed separately on 2026-10-05. Its deployed commit could not be established from the deployment response, so these observations do not assert that production runs this exact source commit.

The private reference bundle remains in the specification's external handoff directory. This note contains no live images, recordings, raw transcripts, project identifiers, task titles, member names, account names, or message excerpts. Evidence IDs below identify aggregate observations; private paths and conversation identifiers stay in the handoff bundle.

| ID | Evidence gathered | What it can establish |
| --- | --- | --- |
| U1 | Project-scoped `search_transcripts`, then `conversation_messages` on the active orchestrator conversation; 180 records with role `user`, of which 23 have member authorship, dated October 3–5 | Repeated operator requests and explicit complaints. Automated wakes, relays, and summaries were excluded from the human sample. |
| U2 | `list_conversations`, newest 100 of 1,747 project conversations at observation time; 60 Claude and 40 Codex, 16 recent and 84 idle | A large working set and two agent engines. Creation, recency, and idle state do not measure human visits. |
| U3 | Project-scoped and unscoped searches for sidebar/menu/interface, overlap, extra buttons, microphone, reports, phone, and pipelines; relevant hits read through `conversation_messages` | The originating request, earlier rejected overlays, and the operator's own complaints. Search snippets alone were insufficient proof of authorship. |
| U4 | `search_memory` in several UI/navigation phrasings, relevant results opened by ID; prior local memory checked against current components | Useful isolation guidance and the preference for quiet chrome. Several UI hits concerned other products and were excluded. No prior answer settled this redesign. |
| R1 | 24 settled live frames: board, rail menu where present, board menu, conversation, and phone conversation menu; EN/UK at 1440×900, 1000×800, and 390×844 | Current layout, control counts, menu dimensions, and centre hit-tests in a bounded live state. |
| C1 | Current component branches, callbacks, menu builders, and mounting conditions | Function coverage, conditional entries, and source-derived interaction paths. |

The 23 human messages comprise 5 on October 3, 6 on October 4, and 12 on October 5, using UTC dates. This is a purposeful recent sample around active work and UI complaints. It is neither a random sample nor click telemetry. Voice transcripts appear as text, so the sample cannot establish a voice/text percentage or a statistically ranked list of clicks.

Read-only capture used an isolated browser profile with mutation requests and remote requests blocked. No message was sent, microphone activated, account selected, task changed, or host controlled. Two reads were also blocked in the observer: member-session loading, which otherwise showed a sign-in curtain, and operator-settings synchronization, which otherwise replaced the observer's chosen language. No session response was fabricated. Thus R1 shows the application with bearer read access and no member session; conditional signed-in actions were inventoried from C1. The initial curtain and unsettled first-pass frames are retained privately and excluded from measurements. This is browser evidence at phone dimensions; the operator's physical iPhone/Edge was not tested.

## How the operator works

The recurring loop is: tell the orchestrator what needs doing, let agents and pipelines perform it, read the result, ask for an explanation or status, and decide what proceeds. Opening an individual agent or pipeline supplies detail when the summary is insufficient. The board organizes that work; the conversation remains a central way to direct it.

| Working pattern | Evidence, expressed without private content | Interface implication |
| --- | --- | --- |
| Steer work through the orchestrator | U1 includes requests to start work, take over existing work, finish fixes, review, and continue queues across all three dates. | Preserve a quick route into the existing conversation and composer. Project switching must retain orientation and drafts. |
| Read and understand results | U1 includes queue-status requests, explanations of a large change and waiting pipelines, and a request to explain recently delivered features. | Results and decisions need a legible home beside the conversation. Actual daily use of the dedicated Reports panel is inferred from this need, rather than observed in telemetry. |
| Decide what happens next | U1 includes numbered choices, merge/queue policy choices, and questions about work waiting for a decision. | Pending decisions deserve a direct route with enough context to choose safely. |
| Inspect a worker or pipeline when necessary | U1 includes examination of idle work, continuation from an existing change, and verification of agent capability. U2 confirms a large pool of recent and idle conversations. | Keep agent, task, pipeline, stage, and predecessor relationships accessible without turning their entire history into navigation chrome. |
| Use the phone and voice | U1 explicitly names iPhone Edge and repeated microphone permission requests after reload. | A phone conversation, reports, and the return to work need compact navigation. Voice is part of the primary composition path; its permission defect has separate functional scope. |
| Understand operational exceptions | U1 includes launch, connection, rotation, linked-host, and update problems. | Host/account diagnostics remain necessary. They can be secondary while healthy and explicit when they explain a failure. |

### Frequency vocabulary used throughout the inventory

- **D — daily candidate:** central to the repeated loop; a design priority, without a measured visits-per-day claim.
- **C — conditional recurring:** useful when selecting work, handling a decision, or diagnosing an exception.
- **R — occasional/setup:** plausibly needed during configuration, recovery, organization, or access changes.
- **U — unknown:** no defensible frequency estimate from this sample. Availability must be preserved until tested with the operator.

Conversation/composition and reading results are D. The board, pending decisions, agents, and pipelines are C with frequent entry in active work. Phone use is directly established; daily phone use is unmeasured. Accounts and host diagnostics become C during failures. No surface can be labelled **never used** from this evidence. Setup guides, tours, member administration, archival controls, and appearance choices have no repeated-use evidence in U1 and belong to R/U, without a removal decision.

### Friction the operator has already named

| Evidence | Complaint, paraphrased | Constraint for the next design step |
| --- | --- | --- |
| U1/U3, October 5 | The sidebar looks poor; remove or recombine it while retaining its functions. Burger and overflow menus contain too many buttons. | Compare multiple navigation structures and supply a function-to-new-home mapping. |
| U1, October 5 | Additional model-stage buttons covered the existing UI; the existing selector was expected to handle the choice. | Reuse a current decision surface; every extra control must justify its space. |
| U1/U3, October 3–5 | Navigation should find the operator's messages and answers despite service wakes; arrows must not cover any UI. Earlier overlays covered message text, composer/header controls, or scrollbar corners. | Separate human reading from service traffic through a chosen view. Reserve layout space and test intersections; floating navigation needs proof. |
| U1, October 4 | Microphone permission is requested again after reload. | Preserve a discoverable voice entry. Track permission/session behaviour separately from this shell design. |
| U1, October 3 | Recently delivered features were hard to keep up with. | Make results and changes discoverable through the report-reading path; additional badges require evidence of benefit. |
| U1, October 4–5 | Waiting decisions and queues needed explanation; operational connection failures interrupted work. | Put the reason and next action where the work is read. Healthy-state chrome should stay quiet. |

The prior prototype conversation records overlap rejections and a later numbered choice. Its assistant-reported hit-test totals were not rerun here and are not current proof. This note uses the operator's constraint and today's measurements independently.

## Sidebar inventory

The desktop rail mounts at `src/components/Viewer.tsx:1651`. The phone uses a project sheet instead, at `src/components/mobile/MobileProjectSheet.tsx:19`. Dormant mobile markup in `ProjectRail` does not describe the current phone shell. Hiding the whole rail already exists; it does not redistribute the rail's functions.

| ID | Every current rail function | Source | Plausible importance |
| --- | --- | --- | --- |
| S1 | Hide rail; restore it through the shell button or keyboard B; remember visibility | `src/components/ProjectRail.tsx:210`; `src/components/Viewer.tsx:725`, `:1377`, `:1659` | C: reclaim space while reading |
| S2 | Filter projects by text | `src/components/ProjectRail.tsx:239` | C: locate a project in a large set |
| S3 | Create project; enter name/root, browse/select directory, create a missing root when offered, submit/cancel and retain validation errors | `src/components/ProjectRail.tsx:254`, `:626`, `:760` | R: setup |
| S4 | Open Overview; select a project; read activity, attention, conversation counts and age | `src/components/ProjectRail.tsx:126`, `:282`, `:831` | C: switch context and recognize work needing attention |
| S5 | Pin/unpin a project with the crown; sort pinned projects ahead of regular projects | `src/components/ProjectRail.tsx:143` | C/U: useful selection shortcut, actual use unmeasured |
| S6 | Expand/collapse archived projects and open an archived project | `src/components/ProjectRail.tsx:298` | R: recover older context |
| S7 | Fold/unfold the system footer and remember that choice | `src/components/ProjectRail.tsx:534`, `:547`, `:576` | C: reduce persistent chrome; expanded by default |
| S8 | Read resource pressure; open host/session details; toggle a session's seat monitor; choose an idle age; stop idle sessions, all eligible sessions, or one session with the existing safety steps | `src/components/ResourcesFooter.tsx:195`, `:474`, `:497`, `:508`, `:526`, `:734`, `:756` | Readings C during exceptions; stopping R and safety-sensitive |
| S9 | Read engine/account capacity; open accounts; open usage/burndown history; read supported additional-engine limits | `src/components/LimitsFooter.tsx:265`, `:303`, `:344` | C: capacity affects whether work can run |
| S10 | Open messaging integration status/configuration | `src/components/LimitsFooter.tsx:388`; `src/components/TelegramConnect.tsx:413` | R/U: connection and reporting setup |

The S9 account panel exposes select active account, add a labelled account, sign in/open the authentication link/submit a code, retry or cancel sign-in, copy an account-bound terminal command, remove an account with confirmation and cleanup outcome, finish/retry orphan cleanup, retry an operation notice, refresh limits, spend an available reset credit, and configure a compatible provider/load models/save. These branches are at `src/components/AccountsPanel.tsx:197`, `:262`, `:323`, `:531`, `:740`, `:758`, `:888`, `:984`, `:1005`, `:1026`, `:1236`, `:1362`, `:1391`. The usage chart switches between available limit windows and closes (`src/components/BurndownPanel.tsx:173`, `:185`). Account switching is C; authentication/recovery C when broken; provider configuration and removal R. There is no inferred account-rename action: the label input is part of account creation/provider configuration.

S10 includes save client credentials, connect, display/copy login QR, submit a secondary password, cancel, reconnect/refresh, log out and delete local connection data (`src/components/TelegramConnect.tsx:144`, `:244`, `:287`, `:308`, `:354`, `:385`, `:394`). Its report section enables/disables a schedule, chooses time and source groups, edits/saves/resets the prompt, runs now, and opens history/report output (`src/components/TelegramReports.tsx:111`, `:150`, `:197`, `:244`). Its bot section connects/replaces credentials, refreshes/removes the bot, adds a destination, edits its alias/post permission, sends a test, and configures document roots (`src/components/TelegramBot.tsx:70`, `:186`, `:256`, `:349`). These are retained R/U capabilities; nothing in this audit justifies dropping them or running them during capture.

### Rail header overflow: installation-wide functions

`src/components/ProjectRail.tsx:411` opens a menu with 13 default functional rows and a conditional signed-in sign-out row. R1 showed 13 controls. An opener, separators, and headings are excluded from that function count.

| ID | Function | Source | Importance |
| --- | --- | --- | --- |
| G1 | Change EN/UK language | `src/components/ProjectRail.tsx:430`; `src/components/LanguageToggle.tsx:8` | R: persistent preference |
| G2 | Show phone-access QR/link, copy link, open phone setup guide | `src/components/ProjectRail.tsx:439`; `src/components/AccessQrButton.tsx:48`, `:90`, `:185` | R: initial access/reconnection |
| G3 | Enable/disable browser push notifications, with permission/support state | `src/components/ProjectRail.tsx:443`; `src/components/PushBell.tsx:20` | R: notification setup |
| G4 | Open setup guide | `src/components/ProjectRail.tsx:448` | R |
| G5 | Start interface walkthrough | `src/components/ProjectRail.tsx:455` | R |
| G6 | Open agent mapping/setup | `src/components/ProjectRail.tsx:463` | R/C when launch context is wrong |
| G7 | Open dictation setup | `src/components/ProjectRail.tsx:471` | R/C during voice problems |
| G8 | Open telemetry settings | `src/components/ProjectRail.tsx:477` | R |
| G9 | Open linked-installation settings | `src/components/ProjectRail.tsx:479` | R/C during linked-host faults |
| G10 | Open external-relay settings | `src/components/ProjectRail.tsx:482` | R |
| G11 | Open update status/settings | `src/components/ProjectRail.tsx:487` | R/C during update faults |
| G12 | Open activity page | `src/components/ProjectRail.tsx:496` | C/U: diagnostic/history view |
| G13 | Open team page | `src/components/ProjectRail.tsx:504` | R/U: access administration |
| G14 | Sign out the current member, conditional on member session | `src/components/ProjectRail.tsx:512` | R; absent from the observer session |

The current phone project picker covers S3, S4, S6 and resource details S8 (`src/components/mobile/MobileProjectSheet.tsx:121`, `:127`, `:141`, `:147`, `:162`, `:185`). It shows crown markers but has no crown-toggle callback or project text filter. Account management lives in the board menu instead. G1–G3 and G14 have no direct row in the current phone board menu. This asymmetry matters to the next mapping; the dormant rail cannot be counted as their phone home.

## Desktop and phone board overflow

The desktop board menu is built at `src/components/ProjectDashboard.tsx:2170`. Its generic trigger is `src/components/ProjectBar.tsx:261`. The phone's menu is assembled separately at `src/components/ProjectDashboard.tsx:2051` and rendered by `src/components/mobile/MobileMenuSheet.tsx`. Conditional entries depend on view, account layout, archive eligibility, browser support, and available callbacks.

| ID | Function and current placement | Source | Importance |
| --- | --- | --- | --- |
| B1 | Search messages: conditional desktop menu; direct phone top-bar search | `src/components/ProjectDashboard.tsx:2184`; `src/components/mobile/MobileShell.tsx:343` | C: find context; differs from filtering board cards |
| B2 | Change project account choices: desktop inline when wide, menu when compact; phone Accounts/limits screen | `src/components/ProjectDashboard.tsx:2167`, `:2193`, `:2078`; `src/components/ProjectAccounts.tsx:75` | C: execution capacity and routing |
| B3 | Toggle sound; open sound options | `src/components/ProjectDashboard.tsx:2197`, `:2102` | R/C: ongoing alert preference; two controls within one row |
| B4 | Set project merge-on-review policy | `src/components/ProjectDashboard.tsx:2200`, `:2120` | R/C: execution policy |
| B5 | Set project sharing | `src/components/ProjectDashboard.tsx:2201`, `:2121` | R: access scope |
| B6 | Set bridge report delivery | `src/components/ProjectDashboard.tsx:2202`, `:2122` | R: report routing |
| B7 | Set installation-wide “Asks you” behaviour | `src/components/ProjectDashboard.tsx:2203`, `:2125` | R/C: notification/attention policy; broader scope than project |
| B8 | Archive eligible project or unarchive it; phone receipt offers restore | `src/components/ProjectDashboard.tsx:2205`, `:2132`, `:2144` | R: organization; preserve running-work guard and recovery |
| B9 | Delete project through the guarded desktop action; no corresponding phone row | `src/components/ProjectDashboard.tsx:2211` | R: destructive |
| B10 | Create agent, task, or pipeline: three phone menu rows; desktop creation controls are outside this menu | `src/components/ProjectDashboard.tsx:2053`; `src/components/ProjectBar.tsx:90` | C: often delegated through the orchestrator; direct creation still needed |
| B11 | Open task list; open pipelines list | `src/components/ProjectDashboard.tsx:2057`, `:2060` | C: inspect work |
| B12 | Open hidden work; restore individual hidden items in its tray | `src/components/ProjectDashboard.tsx:2066`; `src/components/kanban/KanbanBoard.tsx:1383` | C/R: recover deliberately hidden work |
| B13 | Choose board or all-conversations view | `src/components/ProjectDashboard.tsx:2073` | C: switch spatial/task view and conversation catalogue |
| B14 | Open host details/background-task diagnostics | `src/components/ProjectDashboard.tsx:2079` | C when something fails |
| B15 | Keep screen awake when supported | `src/components/ProjectDashboard.tsx:2110` | C/U: phone reading preference |
| B16 | Phone copies G4–G13: four onboarding entries, telemetry, linked settings, relay, update, activity, team | `src/components/ProjectDashboard.tsx:2093`, `:2112`; `src/components/onboarding/menuEntries.tsx:1` | Same frequency as the corresponding G function |

Maximum phone project-menu shape: 27 logical rows, including two view choices, supported keep-awake, hidden work and one archive alternative. A sound-options button and the sheet close button affect DOM control counts separately. R1 had 28 mounted controls in its particular state. The desktop sample had nine controls, including sound's secondary button; this is not the maximum for every account layout.

The phone Overview overflow has a smaller branch: hidden work where the board is drawn, sound/options, keep-awake when supported, activity, team, four onboarding entries, and update (`src/components/OverviewBoard.tsx:255`). That is at most ten logical rows. Telemetry, linked settings, relay, and project policies are reached through a project's board menu. Identical overflow icons therefore lead to different configuration coverage.

The compact desktop Create menu contains new task and new agent; wide mode exposes those as separate controls (`src/components/ProjectBar.tsx:137`, `:151`; `src/components/kanban/KanbanBoard.tsx:1353`). This is already an example of collapsing optional chrome without removing a capability.

## Work, pipeline, and reader overflow

These menus are part of the preservation inventory even though their contents vary with the selected object. Counts below exclude headings/separators and count each choice or swatch separately where stated. A disabled action remains a capability with an eligibility rule.

| ID / surface | Every function | Source | Importance and shape |
| --- | --- | --- | --- |
| W1 — column menu | Hide idle assigned work; hide finished Done work; open hidden tray in each column | `src/components/kanban/KanbanBoard.tsx:1361` | C/R; one or two rows according to column |
| W2 — card status menu | Choose Inbox/Assigned/Blocked/Done, edit hold reason, move to previous/next column | `src/components/kanban/KanbanBoard.tsx:1341`, `:1402`, `:1406` | C: work state; seven choices/actions |
| W3 — full card menu | Four statuses; hold reason; High/Normal/Low priority for a task; eight colours plus None; task icon picker; collapse/expand; rename; add/edit description; attach work links; hide from board with seat protection; each attached pipeline's W4 group | `src/components/kanban/KanbanBoard.tsx:1420`, `:1430`, `:1440`, `:1461`, `:1472` | State C; metadata C/R; colour/icon U. A real task has 23 targets before pipeline groups, including nine swatches. Previous/next-column actions belong to W2. |
| W4 — pipeline group/menu | Expand pipeline; attach work links; pause/resume; retry eligible stage; skip eligible stage; optionally mark this lane as finishing its task; close lane | `src/components/kanban/KanbanBoard.tsx:1554`, `:1565` | C for inspection/decisions; closure R. Six functions plus conditional finish-task toggle. Guards and state-specific labels remain essential. |
| W5 — stage menu | Edit draft prompt; choose draft-stage account; retry stage; skip stage; show it in the stages panel where offered | `src/components/kanban/KanbanBoard.tsx:1515`; triggers at `src/components/kanban/StagesSheet.tsx:457`, `src/components/kanban/StageDraft.tsx:343` | C: inspect/resolve stage. Up to five actions, conditional on stage and entry point. |
| W6 — reader menu | Enter/leave full pane; copy conversation deep link; hand off where supported; link to task; unlink an explicit assignment; close conversation on board with reopen receipt; open guarded stop-host control where available | `src/components/kanban/KanbanBoard.tsx:1582`, `:1645`; `src/components/kanban/KanbanReaders.tsx:313` | Reading C; linking C/R; handoff/close/stop R. Up to seven functions. Closing a card, unlinking work, and stopping a host have distinct effects. |
| W7 — standalone pipeline strip | Skip a waiting-decision stage; discard draft or close existing lane | `src/components/pipelines/PipelineStrip.tsx:772` | C/R; primary start/pause/resume/retry controls are already outside the overflow at `:744`. |
| W8 — phone task overflow | Rename; priority submenu with three choices; colour submenu with nine swatches; edit details; attach work links; hide/show unless seat-protected; open board menu | `src/components/mobile/MobileTaskScreen.tsx:942`, `:966`, `:994` | C/R, appearance U; up to seven first-level rows. Task status is a separate direct control at `:1031`. |
| W9 — phone task's lane sheet | Open pipeline; open current stage conversation; conditional finish-task toggle; state-dependent pause/resume and close lane | `src/components/mobile/MobileTaskScreen.tsx:850` | C: navigate/decide; closure R. This sheet reaches the full pipeline rather than duplicating all stage decisions. |
| W10 — phone pipeline overflow | State-dependent pause/resume; close lane; open board menu | `src/components/mobile/MobilePipelineScreen.tsx:214`, `:463` | C/R; zero to two lane actions plus board-menu navigation. Retry/skip decisions remain in stage content. |
| W11 — agent strip overflow | Compact context; copy/open terminal attach command | `src/components/AgentControlStrip.tsx:289`, `:311`, `:339` | C during context pressure; terminal R. Two secondary actions fold on compact panes; stop/recheck stay on the face. |
| W12 — work-links “+N” overflow | Open complete link list; open forge issue/PR; detach manual link; attach a link through input/submit | `src/components/workLinks/WorkLinkChips.tsx:119`, `:174`, `:185`, `:201` | C/R: inspect or correct associations; list length variable |
| W13 — phone card action sheet / gesture tray | Task: move to each of the other three statuses, hide unless seat-protected, dismiss current attention with undo, open first agent. Conversation/pipeline cards delegate to O7 with card-wide dismissal. | `src/components/mobile/MobileKanban.tsx:1040`, `:1051`, `:1090` | C: six task actions at most; gesture entry differs from opening the task's W8 menu |

The current managed pipeline block suppresses its own overflow when the card owns the actions (`src/components/pipelines/PipelineBlock.tsx:687`, `:1024`). The problem now is growth inside one card menu as lanes accumulate. An audit must account for that consolidation already present in the source.

### Phone conversation overflow

`src/components/mobile/MobileConversationMenu.tsx` assembles up to 19 fixed entry types and N subagent rows. Availability is conditional; “19 + N” describes the builder's possible branches. The mounted count depends on which branches coexist. U1 makes conversation reading and steering D; the individual lifecycle tools are C/R as below.

| ID | Function | Source | Importance |
| --- | --- | --- | --- |
| M1 | Open pinned tasks/relations sheet | `src/components/mobile/MobileConversationMenu.tsx:180` | C: recover context |
| M2 | Open background tasks sheet | `src/components/mobile/MobileConversationMenu.tsx:189` | C during long-running work |
| M3 | Open orchestrator seat/status/mandate/rotation sheet | `src/components/mobile/MobileConversationMenu.tsx:204` | C/R: inspect ownership; rotation is exceptional |
| M4 | Open current stage's pipeline, or project pipelines for a non-stage conversation | `src/components/mobile/MobileConversationMenu.tsx:220`; `src/components/mobile/MobileFocusView.tsx:614` | C: inspect work; destination depends on context |
| M5 | Open each subagent; unavailable descendants retain disabled state | `src/components/mobile/MobileConversationMenu.tsx:236` | C, variable N; sampled conversation had 38 rows |
| M6 | Open attention/pending decisions | `src/components/mobile/MobileConversationMenu.tsx:255` | C: repeated decision workflow; also direct header route when relevant |
| M7 | Open reports | `src/components/mobile/MobileConversationMenu.tsx:256` | D candidate; orchestrator also has a direct Reports header control at `src/components/mobile/MobileFocusView.tsx:734` |
| M8 | Rename conversation | `src/components/mobile/MobileConversationMenu.tsx:259` | R: organization |
| M9 | Crown/uncrown conversation | `src/components/mobile/MobileConversationMenu.tsx:268` | C/U: selection shortcut |
| M10 | Hand off conversation where supported | `src/components/mobile/MobileConversationMenu.tsx:276` | R/C: recovery/continuation |
| M11 | Open predecessor conversation | `src/components/mobile/MobileConversationMenu.tsx:288` | C when work spans rotations |
| M12 | Interrupt running turn | `src/components/mobile/MobileConversationMenu.tsx:305` | C: correct active work |
| M13 | Compact context | `src/components/mobile/MobileConversationMenu.tsx:318` | C during context pressure |
| M14 | Open host details | `src/components/mobile/MobileConversationMenu.tsx:325` | C when work fails |
| M15 | Copy terminal attach command or open its fallback dialog | `src/components/mobile/MobileConversationMenu.tsx:340` | R: manual inspection |
| M16 | Recheck runtime state | `src/components/mobile/MobileConversationMenu.tsx:348` | C during uncertain state |
| M17 | Open search | `src/components/mobile/MobileConversationMenu.tsx:355` | C; duplicates the direct header entry |
| M18 | Open this project's board-menu face | `src/components/mobile/MobileConversationMenu.tsx:364` | C/R: another layer before project/global configuration |
| M19 | Close conversation card with reopen receipt | `src/components/mobile/MobileConversationMenu.tsx:383` | R: organization; does not mean stop host |
| M20 | Stop/kill host through ownership and escalation guards | `src/components/mobile/MobileConversationMenu.tsx:396` | R: destructive recovery; distinct from M12 and M19 |

M5 is the variable entry family; the other 19 rows are the fixed possibilities. The sampled menu mounted 55 controls including its close control, and only 15 geometrically intersected the viewport initially. The long descendant list occurs before rename, context tools, host details and board configuration. An operator seeking a later action must scroll through unrelated agent rows.

### Other overflow and context menus

| ID / surface | Every function | Source | Importance |
| --- | --- | --- | --- |
| O1 — background process ⋯ | Stop/kill the owned process; show/hide output; copy its command. PID is information. | `src/components/mobile/MobileChromeSheets.tsx:92`, `:109`, `:122`, `:129` | C during diagnostics; stop R |
| O2 — member ⋯ | Opens edit dialog: save name/colour; link/unlink messaging identity for self; add/remove passkey; owner revoke/restore access with confirmation | `src/components/team/MembersTab.tsx:183`, `:422`, `:433`, `:458`, `:474`, `:497` | R/U: administration; this is a dialog opener rather than a flat action menu |
| O3 — send-chevron menu | Toggle automatic context; ask in parallel; queue message for native agent; inject context; steer active turn or interrupt/resend fallback; send quick acknowledgement, each subject to capability/state | `src/components/ComposerBar.tsx:495`; `src/components/TmuxComposer.tsx:4987` | C: advanced steering within a D composer. Six conditional action families; normal Send is the primary button. |
| O4 — runtime selector | Select model; select account; choose Standard/Fast service tier; choose reasoning effort; return from subview | `src/components/RuntimePill.tsx:1095`, `:1106`, `:1127`, `:1150`, `:1155`, `:1166` | C: execution choice; reuse this existing surface for compatible choices |
| O5 — microphone context menu | Choose transcription backend by right-click/long-press, with environment locks and unavailable explanations | `src/components/MicButton.tsx:192`, `:259` | R/C during voice problems; primary record remains direct |
| O6 — speech context menu | Choose speech backend and inspect availability/length/cost information; primary speak/replay/stop stays on its button | `src/components/feed/SpeakMenu.tsx:281`, `:320`; `src/components/feed/SpeakButton.tsx:444` | R/U: listening setup |
| O7 — phone row swipe / long-press sheet | Conversation: dismiss a current attention reason with undo; close card with reopen. Waiting pipeline: dismiss attention with undo; close lane with a receipt that can cancel the pending close. | `src/components/mobile/MobileRowActions.tsx:82`, `:147` | C/R: organization and attention; dismissal leaves execution untouched |
| O8 — conversation account badge menu | Choose the conversation's next account, return a waiting choice to the current account, or open account management; eligibility and in-flight switch state constrain choices | `src/components/AccountBadge.tsx:153`, `:231`, `:274`; `src/components/RuntimePill.tsx:1127` | C: execution routing; preserve pending versus running account state |

The loading shell's ellipsis is a non-interactive placeholder (`src/components/BootShell.tsx:134`), so it supplies no additional function. The current phone shell opens projects through its title; it has no mounted burger/drawer navigation (`src/components/mobile/MobileProjectSheet.tsx:19`). The originating wording still describes a valid navigation concern, but a redesign should start with today's mounted controls.

## What is wrong today

### Measured baseline

Controls were counted as mounted interactive DOM elements with nonzero visible boxes, intersecting the viewport and not hidden by CSS. “At rest” means menus closed after settling. Disabled targets remain controls. This geometric count does not guarantee that a scrim or scrolling clip lets a pointer reach the centre. Menu-specific centre hit-tests therefore appear separately. Whole-viewport counts include visible work and composer controls and depend on this live sample; they are not a constant shell budget.

| Surface at rest | 1440×900 | 1000×800 | 390×844 |
| --- | --- | --- | --- |
| Desktop rail | 248 px; 21 visible controls / 30 mounted | 248 px; 21 visible / 30 mounted | Not mounted |
| Board header | 1192×48 px; 12 controls | 752×88 px; 10 controls | 390×52 px; 4 controls |
| Whole board viewport | 81 controls | 59 controls | 19 controls |
| Whole conversation viewport | 98 controls | 73 controls | 12 controls |
| Phone conversation header | — | — | 390×52 px; 5 controls |

These sampled counts match in EN and UK. Header/rail control counts exclude open menus. Rail width consumes 17.2% of a 1440 window and 24.8% of a 1000 window, before any task or reader pane. The source sets that width at `src/components/ProjectRail.tsx:172`.

| Open menu | Measured box | Mounted / geometrically visible controls | Centre hits in menu |
| --- | --- | --- | --- |
| Desktop rail ⋯, both widths/languages | 232×437 px | 13 / 13 | 13 / 13 |
| Desktop board ⋯, EN | 256×496 px | 9 / 9 | 9 / 9 |
| Desktop board ⋯, UK | 256×516.7 px | 9 / 9 | 9 / 9 |
| Phone board ⋯, both languages | 390×742.7 px; top at 101.3 px | 28 / 17 | 16 / 17 geometric candidates |
| Phone conversation ⋯, both languages | 390×742.7 px; top at 101.3 px | 55 / 15 | 14 / 15 geometric candidates |

Both phone sheets occupy 88.0% of the viewport height. One partially exposed target in each sheet has its centre outside the scrolling clip; this explains the geometric/hit discrepancy without claiming an overlapping-control defect. Background controls under the intentional modal scrim are excluded from the menu hit verdict. This stage does not certify zero intersections for a future design.

### Concrete problems, reproduction and next-stage acceptance

| ID / surface | What the current evidence shows | How to inspect it safely | What a proposed replacement must prove |
| --- | --- | --- | --- |
| F1 — desktop rail, 1440/1000 | Fixed width takes nearly one quarter of the narrow window. Project navigation, capacity, host control and integration setup share the same edge; the expanded-by-default system footer competes with projects. The operator explicitly dislikes the rail. | Compare R1 settled board frames; inspect S1–S10 and the fixed width/default footer branch. Use synthetic content for subsequent reproduction. | At least three alternatives retain all S/G capabilities, reduce rest chrome or return width, and keep project/context selection discoverable. The existing hide switch is the baseline to beat. |
| F2 — desktop configuration, both widths | Two different ⋯ menus divide installation settings from project settings. The board menu also contains installation-wide “Asks you”, while account choices move between bar and menu with width. UK makes the same nine controls 20.7 px taller. | Open rail ⋯ and board ⋯; compare G and B inventories, width branches and R1 menu boxes. | Stable names and scope grouping; two or three frequent actions stay easy to reach; rare controls have one predictable settings home. No discarded action or invented new primary button. |
| F3 — phone board, 390 | A first-level work menu also carries setup, host diagnostics, access and delivery policies. At most 27 logical rows are possible; the sample mounts 28 controls and initially exposes 17. Menu choice requires scanning and scrolling even before a secondary panel opens. | Open the board menu; inspect B10–B16 followed by G/B policy rows. The read-only frame demonstrates shape without activating rows. | Two alternative groupings shorten the first view and retain all supported entries, including archive/recovery. Compare initial visible choices and taps on the same fixture. |
| F4 — phone conversation, 390 | The sampled 38 descendants make a 55-control menu. Later lifecycle, context and configuration actions sit below a growing list. Reports already has a direct header route; adding another Reports control would increase duplication. | Open the conversation menu; compare M5 placement with M8–M20. Use a synthetic large-descendant fixture for a repeatable check. | Bound the action menu independently of descendant count; place agent navigation in an appropriate list; preserve the existing direct Reports/attention paths and the three distinct interruption/closure/host-stop effects. |
| F5 — cards/pipelines/stages | Full task menu starts with 23 targets, counting appearance choices, then adds six or seven actions per lane. Object state, metadata and pipeline execution decisions coexist in one scrolling surface. The current source already removes a duplicate lane ellipsis. | Inspect W3/W4 menu builders with zero, one and several synthetic lanes; compare W5 and W7 direct controls. | A shorter initial decision set with explicit drill-down; keep task versus pipeline/stage scope clear. Test conditional and disabled branches as well as the default card. |
| F6 — navigation and reading | Phone overflow meaning changes between Overview, board, task, pipeline and conversation. Entering project settings from a conversation adds a menu layer. U1 also asks for human-message navigation amid service traffic; historical overlay attempts blocked content. | Compare menu builders and the tap paths below. Read private rejection evidence; reproduce using the existing synthetic phone/conversation fixture. | Stable return paths, a human-reading mode if still selected, preserved back stack/drafts, and measured clearance from feed/composer/header/scrollbar at every named size. |

F1–F6 are design problems to test in the prototype step. This audit found no basis to declare the current sampled header clipped, every menu target unreachable, or an existing global contrast failure. Glass contrast has not been measured because no glass treatment was authored.

### Five priority action families and current taps

The five families below follow repeated operator intent. Their order is a design hypothesis rather than an empirical click-frequency ranking. Count pointer/touch activations to reach the named destination; exclude typing, scrolling, authentication prompts, and the final decision or Send. Start on a loaded project board with the target work visible and an available orchestrator. Hidden rail, offscreen work, a missing seat, or recovery state adds steps. Source paths establish navigation cost; live commands did not execute the resulting actions.

| Priority family / destination | Desktop path and activations | Phone path and activations | Source / caveat |
| --- | --- | --- | --- |
| 1. Tell the orchestrator: reach its composer | 0 when seat open; header seat toggle 1 when collapsed | Tell orchestrator dock 1 | `src/components/ProjectBar.tsx:194`; `src/components/kanban/KanbanSeat.tsx:100`; `src/components/mobile/MobileBoard.tsx:379`; `src/components/ProjectDashboard.tsx:2415`. Sending adds 1; recording voice adds a separate microphone activation and permission flow. |
| 2. Read results: reach Reports | 0 when report column shown; Reports toggle 1 when closed, plus 1 if seat collapsed | Dock 1, then direct Reports header 1: total 2 from board, 1 from orchestrator conversation. Menu alternative takes 2 from that conversation. | `src/components/orchestrator/OrchestratorPanel.tsx:280`, `:486`; `src/components/mobile/MobileFocusView.tsx:734`; M7. Width determines beside/in-place presentation. |
| 3. Understand a waiting pipeline: reach its stages/decision context | Visible lane/stage opener 1; selected stage details can add 1 | Pipeline-only card opens pipeline 1; task-owned card opens task 1 then lane/stage 1: total 2. List fallback: board ⋯ 1, Pipelines 1, target 1: total 3. | `src/components/kanban/StagesSheet.tsx:457`; `src/components/mobile/MobileKanban.tsx:1118`; `src/components/mobile/MobileTaskScreen.tsx:725`; B11. Answer/retry/skip is a subsequent action with its own eligibility. |
| 4. Inspect a worker: reach its conversation | Visible agent/conversation opener 1 | Conversation-only card 1; task-owned card 1 then conversation row 1: total 2 | `src/components/kanban/KanbanReaders.tsx:313`; `src/components/mobile/MobileKanban.tsx:1118`; `src/components/mobile/MobileTaskScreen.tsx:1234`. A subagent in M5 costs menu + row, plus uncounted scrolling. |
| 5. Review work organization: reach task list | Header Tasks toggle 1 | Board ⋯ 1 then Tasks 1: total 2 | `src/components/ProjectBar.tsx:194`; `src/components/ProjectDashboard.tsx:2057`, `:2230`. Board inspection itself costs 0 from the stated start. |

This table exposes a useful distinction within the evidence: the operator often asks the orchestrator to explain work, while direct list inspection is a secondary path. Its daily rank is less certain than composition and results. The future numbered prototypes should test these five families and a direct pending-attention route, without asserting measured daily click counts.

Typical menu depths, including the entry activation: desktop rail setup is ⋯ → setup (2); desktop project policy is ⋯ → policy (2, then its choices); phone task priority is ⋯ → priority → choice (3); phone conversation project policy is ⋯ → Project → policy (3, then its choices). Reports from the phone orchestrator conversation is already one direct activation. A menu reduction succeeds only if it preserves these quick paths and makes the longer ones easier to understand.

## Inputs for the next design step

Both requested skills were applied to this audit: `ui-ux-pro-max` for hierarchy, target sizing, glass legibility and motion constraints; `frontend-design` for deliberate composition and removal of repeated chrome. The design-system search suggested liquid glass alongside marketing-style bento/hero treatments. The working evidence supports testing restrained shell layers and readable content. Marketing layout, decorative morphing, and a floating action button have no justification here.

Use Apple's [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) and [Menus](https://developer.apple.com/design/human-interface-guidelines/menus) guidance as references for the next comparison. The official web pages require JavaScript; this stage has not derived detailed platform rules from their unreadable page bodies. The task's own contract supplies the measurable requirements: WCAG AA text contrast on glass, light/dark, restrained motion, and no added chrome covering content. Compare navigation and menu structure before selecting a glass appearance. Keep ordinary content surfaces sufficiently opaque to read; layer navigation only where it helps orientation.

The next prototype's preservation matrix must include S1–S10, G1–G14, B1–B16, W1–W13, M1–M20 and O1–O8, with conditional availability and safety guards. Grouping rows in this audit does not authorize omission of their named subfunctions. For every proposed move, specify desktop and phone homes, shortcut/discoverability, and any state-specific difference.

## Deferred — not currently justified

The operator narrowed this stage to deliverables 1 and 2. Keep the remaining specification available for the next decision:

- Numbered browser prototypes: sidebar removal with redistributed functions, a recombined sidebar, and a collapsible rail; two overflow directions; glass shell/conversation/board alongside today's look; one combined recommendation. Print each number on screen and use synthetic content.
- Render every proposed direction at 1440, 1000 and 390, in EN/UK and light/dark. Record target hits, intersections, rest-control counts and tap differences under `evidence/` using synthetic fixtures. Check opacity/contrast against varied underlying content and reduced motion.
- Reuse `scripts/capture-board-geometry.ts`, `src/components/kanban/kanbanBoard.browser.test.tsx` over its existing fixture, and `src/components/mobile/issue1671Evidence.browser.test.tsx`. Add cases to those drivers; create no issue-specific capture framework. Live reference screenshots stay outside the repository regardless of which driver the prototypes use.
- Estimate files/surfaces/risk and gains for each actual prototype, then recommend small mergeable steps after the operator chooses numbers. Current source inventory supplies the surface list; credible build-cost comparisons require concrete prototypes.
- Functional work on microphone permission, host recovery, message delivery, orchestration behaviour, or telemetry collection remains outside this UI design. This note adds no tracking and makes no lifecycle change.
- No permanent sidebar choice, feature removal, visual tokens, new dependency, or hard-to-reverse decision is made here. An ADR would add no useful decision record at this stage.

## Completion and validation

| Scoped requirement | Result |
| --- | --- |
| Usage grounded in transcript search and conversation list | Complete with member-provenance filtering, aggregate counts, explicit inference and sampling limits |
| Earlier friction searched in the operator's words | Complete; relevant conversations read privately and paraphrased here |
| Sidebar and overflow functions on desktop/phone | Complete for current mounted shell and conditional source branches, including nested account/integration and context-menu capabilities |
| Concrete current problems and measurements | Complete: three widths, two languages, rest controls, menu boxes/counts/hits, and five source-derived action paths |
| Private live reference capture | Complete outside repository; no raw evidence in publication; observer limitations disclosed |
| Design-only scope | One Markdown note; no product-source edits, prototypes, service changes or behavioural tests |

All capture browsers were closed through their recorded owned process handles/PIDs. Browser HOME, state and temporary roots were isolated under the OS temporary root, with Viewer control pointed at a closed port. No live-state test suite was run. Documentation validation checks repository references, whitespace, forbidden writing constructions and publication privacy; the repository's normal commit/push hooks enforce the prose publication gate. No hosted-CI result is claimed.
