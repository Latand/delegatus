> Operator request (2026-10-05, paraphrased): look at the whole interface again from how I really use it (how I talk to agents, what tasks I do) and work out how the UX should be redesigned. I want several different prototypes. First the sidebar: remove it altogether or recombine it differently while keeping every function it has now; it does not look good. The burger and three-dots menus hold too many buttons and should be done differently. Take liquid glass and Apple's approaches as the base; there is a `ui-ux-pro-max` skill, use it (and `frontend-design`). Take screenshots from production, and never publish them in any issue or PR: it is my working project. UI only. After the prototypes we decide on the rework.

# Interface redesign: numbered prototypes, measurements, costs and a recommendation

Date: 2026-10-05. Source of the opening requirement: the pinned specification of this design task, reproduced as supplied. This note covers deliverables 3 to 5. Deliverables 1 and 2 are in [interface-redesign-usage-audit.md](interface-redesign-usage-audit.md); the ids used below (S1, G4, B7, W3, M5, O3) are that note's inventory.

Nothing ships from this lane. No product file imports the prototype, and the operator answers with numbers before any build lane starts.

## The variants, by number

| No. | Direction | What changes | Where to look first |
| --- | --- | --- | --- |
| 0 | Today | Nothing. The baseline every other number is measured against. | board at rest; rail menu; board menu; card menu; phone menus |
| 1 | Sidebar: none | The rail is gone. The board header's project title opens one "Go to" palette (projects, then settings). One chip beside the status line stands for the whole system footer. | rest, `palette`, `system` |
| 2 | Sidebar: recombined | A 208 px rail that holds projects only. The system footer is one row; the header menu is one Settings row. | rest, `system`, `settings` |
| 3 | Sidebar: collapsible rail | 52 px of project tiles at rest. One control (or B) opens variant 2's rail beside the board. | rest, `open`, `system` |
| 4 | Menus A | Each overflow leads with two or three frequent actions as wide buttons; everything else sits in named groups one level in. | `board-menu`, `rail-menu`, `card-menu`, phone `board-menu`, `conversation-menu` |
| 5 | Menus B | An overflow holds only what acts on the object in front of you. Every preference, policy and setup entry lives in one Settings place with two scopes: this project, and Delegatus. | `board-menu`, `settings`, `card-menu`, phone `conversation-menu` |
| 6 | Visual language: glass | Today's structure with a translucent navigation layer (rail, bars, menus, sheets) over a soft colour wash. Shown beside today's frame, light and dark. | every state is a pair: 0 on the left, 6 on the right |
| 7 | Combined proposal | 1 + 5 + 6: no rail, object-only menus with one Settings place, glass. Also shown beside today's frame. | rest, `palette`, `settings`, phone `projects` |

Each number is printed in a strip above the frame, outside the application, so the number itself covers nothing.

### How to open them

The prototypes are the real Viewer over the kanban evidence fixture (`src/components/kanban/issue1695Evidence.fixture.tsx`, scenario `stages`) with the variant's chrome around it. The existing kanban browser driver renders all of them:

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chromium> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "interface redesign"
```

Run it with `HOME`, `TMPDIR`, `LLV_STATE_DIR` under the OS temp root and `LLV_VIEWER_CONTROL_URL` on a closed port, as every driver run from a lane is. The frames land in `LLV_INTERFACE_REDESIGN_OUT` (default `.artifacts/interface-redesign/`, never committed) as `v<number>-<width>-<language>[-dark]-<state>.png`; `LLV_INTERFACE_REDESIGN_ONLY=1,7`, `LLV_INTERFACE_REDESIGN_FRAMES=390` and `LLV_INTERFACE_REDESIGN_LANGS=uk` narrow a run. A full run draws 227 frames in about twelve minutes: every state at 1440×900, 1000×800 and 390×844, in English and Ukrainian, and the two glass variants once more in dark.

The prototypes are interactive in that frame: the palette filters, the rail collapses, menus drill in and return, toggles and segments switch, Settings changes section. A row that would start a product action (create a project, stop a host) does nothing.

Content the prototype draws itself (five projects, their counts, limit percentages, 38 agents) is invented. The board, the orchestrator pane and the phone screens under it are the fixture's own synthetic content. No frame of the live installation is in this repository or this pull request; the private reference frames from the audit stayed where the audit left them.

### How a variant is attached to the real Viewer

Three mechanisms, all in `src/components/kanban/interfaceRedesign.prototype.tsx`:

1. **Navigation as a layout sibling.** A variant with its own navigation hides the real rail with one style rule and draws its rail beside the Viewer in the same flex row. Nothing floats. Variant 1 places its two controls inside the real board header, in the slot of the project title and after the status line.
2. **Existing buttons answer.** Regrouped menus open from the buttons that exist today: the rail's "⋯", the board's "⋯", a card's "⋯", the phone's "⋯" and the phone's project title. No trigger is added for a menu.
3. **One stylesheet for glass.** Variant 6 changes fills, edges, radii and shadows of real surfaces and changes no box.

The rows of every regrouped menu and the home of every function come from `interfaceRedesign.prototype.model.ts`, and `interfaceRedesign.prototype.model.test.ts` fails when a function has no home.

## Rules taken from earlier rejections, and how each is proved

The operator rejected earlier designs for controls that lay over text and other controls, and for added buttons. Four rules follow, each with a measurement recorded in `evidence/interface-redesign/measurements.json`.

| Rule | Measurement, per state, width and language | Result |
| --- | --- | --- |
| Nothing new lies on top of an existing control or text | Every control a variant draws is hit-tested at its centre and four corners (the point must answer with that control) and intersected with every other control a pointer can reach | 0 misses and 0 intersections in 227 measured states |
| Nothing leaves the window | Each drawn control and each open surface against the window; sideways scroll of the page | 0 outside, 0 px sideways scroll |
| Chrome is cut, never added | Controls visible at rest, counted the way the audit counted today's; rail width and main width | table "At rest" below |
| A menu's first view is bounded | Box, mounted controls and whether it scrolls, for today's menus and the regrouped ones on the same fixture | table "Menus" below; no regrouped menu scrolls in its first view |
| A touch target is a touch target | Smallest drawn control: at least 44×44 on the phone, 24×24 with a mouse | smallest 44×44 on the phone, 28×28 and 66×24 on the desktop |
| Glass moves nothing | Variant 6 against today's frame, control by control | 79 to 109 controls compared per 1440 frame, 50 to 94 per 1000 frame, 12 to 34 on the phone; 0 moved beyond 0.5 px |
| Text on glass keeps WCAG AA | Each text on the glass layer against the pixels behind it, the text hidden while the picture is taken; 4.5:1, or 3:1 for large text | lowest reading 4.92:1 light and 5.6:1 dark, with one inherited exception; table "Glass" below |

The measurements found defects in the first drafts, which is what they are for: a rail field that pushed its "+" out of the rail, a palette whose last row hung below the window, a card menu that scrolled at 1000 px, secondary labels at 4.2:1 over a dimmed backdrop, and a bar whose blur moved the attention notice it hosts (see "Glass" below). Each is fixed in the prototype and the run is green.

## Sidebar: variants 1, 2 and 3

All three keep every rail function (S1 to S10) and every entry of the rail's header menu (G1 to G14). Two functions are removed on purpose, and both are stated in the table: S7, which folds the system footer, has nothing left to fold once the footer is one control; in variant 1 S1, which hides the rail, has no rail to hide, and its key B opens the palette.

The phone has no rail today. Its project sheet (the title in the top bar) is the phone's rail, and the audit found it lacks four things the desktop has: a project filter, the crown toggle, and any home for language, phone access, push notifications and sign-out. All three variants give that sheet the same additions; on the phone, 1, 2 and 3 are one design.

| ID | Function today | 1 No sidebar | 2 Recombined | 3 Collapsible rail |
| --- | --- | --- | --- | --- |
| S1 | Hide and restore the rail (B) | removed: there is no rail to hide; B opens the Go-to palette · phone: n/a (no rail on the phone) | hide control in the rail header; B · phone: n/a | collapse control at the rail's foot; B · phone: n/a |
| S2 | Filter projects by text | the palette's field, focused when it opens (title, B or Ctrl+K) · phone: field at the top of the project sheet (new on the phone) | field at the top of the rail · phone: field at the top of the project sheet (new on the phone) | field at the top of the open rail; / opens the rail on it · phone: field at the top of the project sheet (new on the phone) |
| S3 | Create a project | New project row at the palette's foot · phone: project sheet from the title, New project row | + beside the rail's field · phone: project sheet from the title, New project row | + tile under the project tiles; + beside the field when open · phone: project sheet from the title, New project row |
| S4 | Open Overview, select a project, read its counts | the board header's project title opens the palette: Overview, then projects with their counts · phone: project sheet from the title (as today) | the rail's list · phone: project sheet from the title (as today) | project tiles with an attention dot; names and counts when open · phone: project sheet from the title (as today) |
| S5 | Pin a project with the crown | crown at the end of a palette row · phone: crown at the end of a sheet row (new on the phone) | crown at the end of a rail row · phone: crown at the end of a sheet row (new on the phone) | crown at the end of a row when open; pinned tiles come first when closed · phone: crown at the end of a sheet row (new on the phone) |
| S6 | Archived projects | Archived fold at the end of the palette's projects · phone: project sheet from the title, Archived fold (as today) | Archived fold at the end of the rail's list · phone: project sheet from the title, Archived fold (as today) | Archived fold when open; the fold's tile opens the rail · phone: project sheet from the title, Archived fold (as today) |
| S7 | Fold the system footer | removed: the footer it folded is now one chip · phone: n/a | removed: the footer it folded is now one row · phone: n/a | removed: the footer it folded is now one ring · phone: n/a |
| S8 | Resource pressure, sessions, stop idle sessions | System chip in the board header, opens the System panel · phone: project sheet from the title, System row (as today's resource row) | the rail's one System row, opens the System panel · phone: project sheet from the title, System row | status ring at the rail's foot, opens the System panel · phone: project sheet from the title, System row |
| S9 | Engine limits, accounts, usage history | System chip in the board header, opens the System panel; the chip prints the tightest limit · phone: board menu, Accounts and limits (as today) | the rail's one System row, opens the System panel; the row prints each engine's tightest limit · phone: board menu, Accounts and limits (as today) | status ring at the rail's foot, opens the System panel; the ring is the tightest limit · phone: board menu, Accounts and limits (as today) |
| S10 | Messaging integration status and setup | Telegram row of the System panel · phone: board menu (as today) | Telegram row of the System panel · phone: board menu (as today) | Telegram row of the System panel · phone: board menu (as today) |
| G1 to G3, G14 | Language, phone access, push notifications, sign out | Settings group of the Go-to palette · phone: Settings row of the project sheet (new on the phone) | Settings row at the rail's foot · phone: Settings row of the project sheet (new on the phone) | gear at the rail's foot · phone: Settings row of the project sheet (new on the phone) |
| G4 to G13 | Setup guide, walkthrough, agent mapping, dictation, telemetry, linked installations, relay, updates, activity, team | Settings group of the Go-to palette · phone: board menu (as today) | Settings row at the rail's foot · phone: board menu (as today) | gear at the rail's foot · phone: board menu (as today) |

### At rest (measured on the fixture, identical in English and Ukrainian)

| | 0 Today | 1 None | 2 Recombined | 3 Collapsible (closed) |
| --- | --- | --- | --- | --- |
| Navigation width | 248 px | 0 px | 208 px | 52 px |
| Main area at 1440 | 1192 px | 1440 px | 1232 px | 1388 px |
| Main area at 1000 | 752 px | 1000 px | 792 px | 948 px |
| Board header height at 1000 | 88 px (two rows) | 48 px (one row) | 48 px | 48 px |
| Navigation controls that are chrome | 9 | 1 (the system chip) | 5 | 4 |
| Navigation controls that are projects | 3 for 1 project | 1 (the title) | 12 for 5 projects | 6 for 5 projects |
| Controls in the whole window at 1440 | 83 | 80 | 93 to 95 | 86 to 88 |
| Controls in the whole window at 1000 | 53 | 47 | 62 | 55 |

The fixture's real rail lists one project; the prototypes list five, so the "projects" row grows with the list and the "chrome" row is the fair comparison: today's rail spends nine controls on things that are not projects (hide, menu, filter, create, footer fold, resources, two account buttons, messaging), variant 2 five, variant 3 four, variant 1 one. The whole-window count rises in 2 and 3 only because four more projects are listed and a wider board shows more of its own controls. On the live installation the audit counted 21 visible rail controls with six projects.

### What each sidebar direction costs and gives

| | 1 None | 2 Recombined | 3 Collapsible |
| --- | --- | --- | --- |
| Operator gains | 248 px back (24.8 % of a 1000 px window) and a one-row header at 1000; eight fewer chrome controls; one finder for projects and settings; Ctrl+K from anywhere | 40 px back; four fewer chrome controls; the footer's six lines become one row | 196 px back; five fewer chrome controls; projects stay one press away with their attention dots |
| Operator pays | Switching project is 2 presses (title, row) where it was 1; other projects' attention shrinks to one dot on the title; accounts are 2 presses where they were 1 | Accounts are 2 presses where they were 1; limits show as one number per engine until the row is pressed | Names become two-letter tiles until the rail opens; two projects that start alike need a third letter or a colour |
| Files and surfaces | `Viewer.tsx` (rail mount, B key), the board header's lead in `KanbanBoard.tsx` and `ProjectBar.tsx` (the same lead for the Overview and the loading and empty states), a new palette built from `ProjectRail.tsx`'s list, a System panel hosting `ResourcesFooter.tsx` and `LimitsFooter.tsx`, `MobileProjectSheet.tsx` | `ProjectRail.tsx`, the same System panel, `MobileProjectSheet.tsx` | variant 2's files plus a closed mode in `ProjectRail.tsx` and its persistence in `Viewer.tsx` |
| Tests that move | `ProjectRail.header`, `.footerFold`, `.firstRun` dom tests; the driver's #1819 and #1802 blocks; the walkthrough's rail anchors in `OnboardingWalk.tsx` | footer-fold tests and the #1802 block | variant 2's, plus the #1819 block (hide becomes collapse) |
| Risk | Medium to high: every screen that shows a board header needs the switcher, including the Overview, which has no project title today; the walkthrough points at the rail | Low: one component, no change to any other screen | Medium: a second layout of the same rail to keep right at every width |
| Size | about five small lanes | about two | about three |

## Overflow menus: variants 4 and 5

Both directions apply to the rail's menu, the board's menu, the card menu, the phone board menu and the phone conversation menu. Stage, reader, column, strip and context menus (W1, W5 to W7, W9 to W13, O1 to O8) stay as they are in both; they are short already or belong to a direct control.

Two things are left out of a menu in both directions, and one more in B, each because the function already has a direct control: the phone conversation menu's copy of Search (M17; the top bar carries Search), and in B the orchestrator's Reports row (M7; the orchestrator's header carries Reports, and a conversation without that header keeps the row). Nothing else is dropped.

| ID | Function today | 4 Menus A | 5 Menus B | 7 Combined |
| --- | --- | --- | --- | --- |
| S1 | Hide and restore the rail (B) | unchanged | unchanged | removed: there is no rail to hide; B opens the Go-to palette · phone: n/a (no rail on the phone) |
| S2 | Filter projects by text | unchanged | unchanged | the palette's field, focused when it opens (title, B or Ctrl+K) · phone: field at the top of the project sheet (new on the phone) |
| S3 | Create a project | unchanged | unchanged | New project row at the palette's foot · phone: project sheet from the title, New project row |
| S4 | Open Overview, select a project, read its counts | unchanged | unchanged | the board header's project title opens the palette: Overview, then projects with their counts · phone: project sheet from the title (as today) |
| S5 | Pin a project with the crown | unchanged | unchanged | crown at the end of a palette row · phone: crown at the end of a sheet row (new on the phone) |
| S6 | Archived projects | unchanged | unchanged | Archived fold at the end of the palette's projects · phone: project sheet from the title, Archived fold (as today) |
| S7 | Fold the system footer | unchanged | unchanged | removed: the footer it folded is now one chip · phone: n/a |
| S8 | Resource pressure, sessions, stop idle sessions | unchanged | unchanged | System chip in the board header, opens the System panel · phone: project sheet from the title, System row (as today's resource row) |
| S9 | Engine limits, accounts, usage history | unchanged | unchanged | System chip in the board header, opens the System panel; the chip prints the tightest limit · phone: board menu, Accounts and limits (as today) |
| S10 | Messaging integration status and setup | unchanged | rail footer (as today) and Settings, Delegatus, Connections · phone: Settings, Delegatus, Connections | Telegram row of the System panel; Settings, Delegatus, Connections · phone: Settings, Delegatus, Connections |
| G1 | Language | rail menu, promoted "Language" · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, General · phone: board menu, "Settings", then Settings, Delegatus, General | gear in the rail header, then Settings, Delegatus, General · phone: board menu, "Settings", then Settings, Delegatus, General |
| G2 | Open on phone (QR, link, guide) | rail menu, promoted "Open on phone" · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, General · phone: board menu, "Settings", then Settings, Delegatus, General | gear in the rail header, then Settings, Delegatus, General · phone: board menu, "Settings", then Settings, Delegatus, General |
| G3 | Browser push notifications | rail menu, promoted "Notifications" · phone: board menu, row "Notifications", one level in | gear in the rail header, then Settings, Delegatus, Notifications · phone: board menu, "Settings", then Settings, Delegatus, Notifications | gear in the rail header, then Settings, Delegatus, Notifications · phone: board menu, "Settings", then Settings, Delegatus, Notifications |
| G4 | Setup guide | rail menu, row "Setup and guides", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides |
| G5 | Interface walkthrough | rail menu, row "Setup and guides", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides |
| G6 | Agent mapping | rail menu, row "Setup and guides", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides |
| G7 | Dictation setup | rail menu, row "Setup and guides", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides | gear in the rail header, then Settings, Delegatus, Setup and guides · phone: board menu, "Settings", then Settings, Delegatus, Setup and guides |
| G8 | Telemetry settings | rail menu, row "Connections and updates", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates |
| G9 | Linked installations | rail menu, row "Connections and updates", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates |
| G10 | External relay | rail menu, row "Connections and updates", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates |
| G11 | Updates | rail menu, row "Connections and updates", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates | gear in the rail header, then Settings, Delegatus, Connections and updates · phone: board menu, "Settings", then Settings, Delegatus, Connections and updates |
| G12 | Activity page | rail menu, row "Activity and team", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Activity and team · phone: board menu, "Settings", then Settings, Delegatus, Activity and team | gear in the rail header, then Settings, Delegatus, Activity and team · phone: board menu, "Settings", then Settings, Delegatus, Activity and team |
| G13 | Team page | rail menu, row "Activity and team", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Activity and team · phone: board menu, "Settings", then Settings, Delegatus, Activity and team | gear in the rail header, then Settings, Delegatus, Activity and team · phone: board menu, "Settings", then Settings, Delegatus, Activity and team |
| G14 | Sign out | rail menu, row "Activity and team", one level in · phone: board menu, row "Delegatus", one level in | gear in the rail header, then Settings, Delegatus, Activity and team · phone: board menu, "Settings", then Settings, Delegatus, Activity and team | gear in the rail header, then Settings, Delegatus, Activity and team · phone: board menu, "Settings", then Settings, Delegatus, Activity and team |
| B1 | Search my messages | board menu, promoted "Search my messages" · phone: Search in the top bar (as today) | board menu, row "Search my messages" · phone: Search in the top bar (as today) | board menu, row "Search my messages" · phone: Search in the top bar (as today) |
| B2 | Project account choices | board menu, promoted "Accounts" · phone: board menu, row "Accounts and limits" | board menu, "Settings", then Settings, This project, Accounts | board menu, "Settings", then Settings, This project, Accounts |
| B3 | Sound on or off, sound levels | board menu, row "Notifications", one level in | board menu, "Settings", then Settings, Delegatus, Notifications | board menu, "Settings", then Settings, Delegatus, Notifications |
| B4 | Merge when review passes | board menu, row "Project policies", one level in · phone: board menu, row "Project settings", one level in | board menu, "Settings", then Settings, This project, Policies | board menu, "Settings", then Settings, This project, Policies |
| B5 | Share with linked machines | board menu, row "Project policies", one level in · phone: board menu, row "Project settings", one level in | board menu, "Settings", then Settings, This project, Policies | board menu, "Settings", then Settings, This project, Policies |
| B6 | Orchestrator reports delivery | board menu, row "Project policies", one level in · phone: board menu, row "Project settings", one level in | board menu, "Settings", then Settings, This project, Policies | board menu, "Settings", then Settings, This project, Policies |
| B7 | Asks you (installation-wide) | board menu, row "Notifications", one level in | board menu, "Settings", then Settings, Delegatus, Notifications | board menu, "Settings", then Settings, Delegatus, Notifications |
| B8 | Archive or unarchive the project | board menu, row "Archive or delete", one level in · phone: board menu, row "Project settings", one level in | board menu, "Settings", then Settings, This project, Archive | board menu, "Settings", then Settings, This project, Archive |
| B9 | Delete the project (desktop) | board menu, row "Archive or delete", one level in · phone: n/a (desktop only, as today) | board menu, "Settings", then Settings, This project, Archive · phone: n/a (desktop only, as today) | board menu, "Settings", then Settings, This project, Archive · phone: n/a (desktop only, as today) |
| B10 | Create agent, task or pipeline (phone menu) | n/a (phone menu only, as today) · phone: board menu, row "Create" | n/a (phone menu only, as today) · phone: board menu, row "Create" | n/a (phone menu only, as today) · phone: board menu, row "Create" |
| B11 | Task list, pipelines list (phone menu) | n/a (phone menu only, as today) · phone: board menu, promoted "Tasks" | n/a (phone menu only, as today) · phone: board menu, row "Tasks" | n/a (phone menu only, as today) · phone: board menu, row "Tasks" |
| B12 | Hidden work | n/a (phone menu only, as today) · phone: board menu, promoted "Hidden" | n/a (phone menu only, as today) · phone: board menu, row "Hidden work" | n/a (phone menu only, as today) · phone: board menu, row "Hidden work" |
| B13 | Board or all conversations (phone menu) | n/a (phone menu only, as today) · phone: board menu, row "View" | n/a (phone menu only, as today) · phone: board menu, row "View" | n/a (phone menu only, as today) · phone: board menu, row "View" |
| B14 | Host details (phone menu) | n/a (phone menu only, as today) · phone: board menu, row "Host details" | n/a (phone menu only, as today) · phone: board menu, row "Host details" | n/a (phone menu only, as today) · phone: board menu, row "Host details" |
| B15 | Keep the screen awake (phone) | n/a (phone menu only, as today) · phone: board menu, row "Notifications", one level in | n/a (phone menu only, as today) · phone: board menu, "Settings", then Settings, Delegatus, General | n/a (phone menu only, as today) · phone: board menu, "Settings", then Settings, Delegatus, General |
| B16 | Phone copies of G4 to G13 | n/a (phone menu only, as today) · phone: board menu, row "Delegatus", one level in | n/a (phone menu only, as today) · phone: board menu, Settings: the same sections as G4 to G13 | n/a (phone menu only, as today) · phone: board menu, Settings: the same sections as G4 to G13 |
| W2 | Card status menu | card menu, promoted "Status" · phone: phone task overflow, same grouping | card menu, promoted "Status" · phone: phone task overflow, same grouping | card menu, promoted "Status" · phone: phone task overflow, same grouping |
| W3 | Full card menu | card menu, promoted "Status" · phone: phone task overflow, same grouping | card menu, promoted "Status" · phone: phone task overflow, same grouping | card menu, promoted "Status" · phone: phone task overflow, same grouping |
| W4 | Pipeline group in the card menu | card menu, row "Pipeline: Search fix", one level in · phone: phone task overflow, same grouping | card menu, row "Pipeline: Search fix", one level in · phone: phone task overflow, same grouping | card menu, row "Pipeline: Search fix", one level in · phone: phone task overflow, same grouping |
| W8 | Phone task overflow | n/a (phone) · phone: phone task overflow, in the card menu's grouping (drawn once, on the desktop card) | n/a (phone) · phone: phone task overflow, in the card menu's grouping (drawn once, on the desktop card) | n/a (phone) · phone: phone task overflow, in the card menu's grouping (drawn once, on the desktop card) |
| M1 | Pinned tasks and relations | n/a (phone menu) · phone: conversation menu, row "Context", one level in | n/a (phone menu) · phone: conversation menu, row "Tasks and background work" | n/a (phone menu) · phone: conversation menu, row "Tasks and background work" |
| M2 | Background tasks | n/a (phone menu) · phone: conversation menu, row "Context", one level in | n/a (phone menu) · phone: conversation menu, row "Tasks and background work" | n/a (phone menu) · phone: conversation menu, row "Tasks and background work" |
| M3 | Orchestrator seat sheet | n/a (phone menu) · phone: conversation menu, row "Context", one level in | n/a (phone menu) · phone: conversation menu, row "Orchestrator seat" | n/a (phone menu) · phone: conversation menu, row "Orchestrator seat" |
| M4 | Open the pipeline | n/a (phone menu) · phone: conversation menu, promoted "Pipelines" | n/a (phone menu) · phone: conversation menu, row "Pipelines" | n/a (phone menu) · phone: conversation menu, row "Pipelines" |
| M5 | Open a subagent (N rows) | n/a (phone menu) · phone: conversation menu, row "Agents" | n/a (phone menu) · phone: conversation menu, row "Agents" | n/a (phone menu) · phone: conversation menu, row "Agents" |
| M6 | Attention and pending decisions | n/a (phone menu) · phone: conversation menu, row "Needs you" | n/a (phone menu) · phone: conversation menu, row "Needs you" | n/a (phone menu) · phone: conversation menu, row "Needs you" |
| M7 | Reports | n/a (phone menu) · phone: conversation menu, row "Context", one level in | left out: the orchestrator header already carries Reports; a conversation without that header keeps its row | left out: the orchestrator header already carries Reports; a conversation without that header keeps its row |
| M8 | Rename the conversation | n/a (phone menu) · phone: conversation menu, row "Conversation", one level in | n/a (phone menu) · phone: the conversation sheet's title row | n/a (phone menu) · phone: the conversation sheet's title row |
| M9 | Crown the conversation | n/a (phone menu) · phone: conversation menu, row "Conversation", one level in | n/a (phone menu) · phone: the conversation sheet's title row | n/a (phone menu) · phone: the conversation sheet's title row |
| M10 | Hand off | n/a (phone menu) · phone: conversation menu, row "Conversation", one level in | n/a (phone menu) · phone: conversation menu, row "Hand off" | n/a (phone menu) · phone: conversation menu, row "Hand off" |
| M11 | Predecessor conversation | n/a (phone menu) · phone: conversation menu, row "Context", one level in | n/a (phone menu) · phone: conversation menu, row "Earlier conversation" | n/a (phone menu) · phone: conversation menu, row "Earlier conversation" |
| M12 | Interrupt the running turn | n/a (phone menu) · phone: conversation menu, promoted "Interrupt" | n/a (phone menu) · phone: conversation menu, row "Interrupt" | n/a (phone menu) · phone: conversation menu, row "Interrupt" |
| M13 | Compact context | n/a (phone menu) · phone: conversation menu, promoted "Compact" | n/a (phone menu) · phone: conversation menu, row "Compact context" | n/a (phone menu) · phone: conversation menu, row "Compact context" |
| M14 | Host details | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in |
| M15 | Terminal attach command | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in |
| M16 | Recheck runtime state | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in |
| M17 | Search (menu copy) | left out: the phone header already carries Search; the menu's copy is the duplicate | left out: the phone header already carries Search; the menu's copy is the duplicate | left out: the phone header already carries Search; the menu's copy is the duplicate |
| M18 | Project board menu | n/a (phone menu) · phone: conversation menu, row "Project menu" | n/a (phone menu) · phone: conversation menu, row "Settings" | n/a (phone menu) · phone: conversation menu, row "Settings" |
| M19 | Close the conversation card | n/a (phone menu) · phone: conversation menu, row "Conversation", one level in | n/a (phone menu) · phone: conversation menu, row "Close the card" | n/a (phone menu) · phone: conversation menu, row "Close the card" |
| M20 | Stop the host | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in | n/a (phone menu) · phone: conversation menu, row "Host", one level in |

### Menus (measured on the fixture)

| Menu | 0 Today | 4 Menus A | 5 Menus B |
| --- | --- | --- | --- |
| Desktop rail "⋯" | 232×437 px, 13 controls | 280×232 px, 7 controls, 3 groups | opens Settings directly |
| Desktop board "⋯" | 256×440 px (491 px in Ukrainian), 8 controls | 280×171 px, 5 controls | 280×110 px, 3 controls |
| Card "⋯", task with two lanes | 383×884 px (456 px wide in Ukrainian), 30 controls, scrolls | 300×296 px, 11 controls | 300×344 px, 14 controls |
| Phone board "⋯" | 390×743 px, 29 controls mounted, 16 in view, scrolls | 390×488 px, 13 controls | 390×411 px, 10 controls |
| Phone conversation "⋯" | 390×743 px, scrolls; 16 controls on the fixture, 55 on the audit's live sample with 38 agents | 390×440 px, 9 controls, whatever the number of agents | 390×655 px, 14 controls, whatever the number of agents |
| Settings place | does not exist: three menus share the entries | does not exist | desktop 720×427 px, two panes; phone one sheet, a list of eight sections |

In both directions the list of agents leaves the conversation menu's first view: "Agents 38" is one row, and the 38 rows are a scrolling list one level in.

### Presses, counted from the closed menu to the control that does the thing

| Task | 0 Today | 4 Menus A | 5 Menus B |
| --- | --- | --- | --- |
| Desktop: search my messages | 2 | 2 | 2 |
| Desktop: change language | 2 | 2 | 2 |
| Desktop: open a setup guide | 2 | 3 | 3 |
| Desktop: toggle "merge when review passes" | 2 | 3 | 4 |
| Desktop card: set status | 2 | 2 | 2 |
| Desktop card: set priority | 2 | 3 | 2 |
| Desktop card: pause a lane | 2, after scrolling | 3 | 3 |
| Desktop card: colour | 2 | 3 | 3 |
| Phone board: task list | 2 | 2 | 2 |
| Phone board: toggle a project policy | 2, after scrolling | 3 | 4 |
| Phone board: change language | no control exists | 3 | 4 |
| Phone conversation: interrupt | 2 | 2 | 2 |
| Phone conversation: rename | 2, after scrolling past every agent | 3 | 2 |
| Phone conversation: open an agent | 2, after scrolling | 3 | 3 |
| Phone conversation: stop the host | 2, after scrolling past every agent | 3 | 3 |

The audit's five priority paths (reach the orchestrator's field, Reports, a waiting pipeline, a worker's conversation, the task list) pass through no overflow menu on the desktop and are unchanged in every variant; the phone's task list stays at 2.

### What each menu direction costs and gives

| | 4 Menus A | 5 Menus B |
| --- | --- | --- |
| Operator gains | First views of 5 to 13 controls where there were 8 to 30 (55 live); no first view scrolls; the frequent action is a wide button at the top | First views of 3 to 14 controls; one place for every setting, the same on desktop and phone; "Asks you", which is installation-wide, stops living in a project menu; the phone gains language, phone access, push and sign-out |
| Operator pays | One more press for anything in a group; which two or three actions are "frequent" is a guess until the operator confirms it | A setting is 3 to 4 presses where it was 2; Settings is a new surface to learn |
| Files and surfaces | `ProjectRail.tsx` (menu), `ProjectDashboard.tsx` (both menu builders), `kanbanMenus.tsx` and `KanbanBoard.tsx` (a drill-in item type and the card builder), `MobileMenuSheet.tsx`, `MobileConversationMenu.tsx`, `MobileTaskScreen.tsx` | a new Settings surface (desktop dialog and phone sheet) that at first opens today's dialogs from its rows; the same builders, with rows removed; `MobileConversationMenu.tsx`; `kanbanMenus.tsx` for the lane drill-in |
| Risk | Medium: two menu systems (the kanban menu and the phone sheet) each gain drill-in; group names must stay stable in two languages | Medium: tests and the walkthrough address menu rows by `data-rail-menu-*`; a guard is needed so no entry is lost in the move, and the model test in this lane is the pattern |
| Size | about four small lanes | about five, the first of which (Settings with rows that open today's dialogs) is useful alone |

## Visual language: variant 6

The glass treatment follows one rule: the navigation layer is glass, and what is read stays opaque. Rail, bars, the phone's top bar and dock, menus, popovers and sheets become translucent and blur what is behind them; cards, the conversation feed and the message field keep their solid surface. Columns are translucent without a blur, because they are large and they scroll. A soft three-colour wash (the emblem's warm tone, the accent's indigo, a faint green) sits under everything so the translucency has something to show. Radii grow one step (controls 8 to 10 px, surfaces 12 to 16 px). Motion is the product's own 200 ms ease on menus, and none under reduced motion. With `prefers-reduced-transparency` the fills return to today's solid surfaces.

This is the reading of Apple's guidance used here: glass belongs to controls and navigation that float above content, content itself stays legible on a solid ground, and blur marks a layer, never decoration (`ui-ux-pro-max`: `blur-purpose`, `color-accessible-pairs`, `reduced-motion`; `frontend-design`: no glass on everything, no glow, tinted neutrals). Apple's guideline pages need a browser session this lane did not use for them, so no rule here is quoted from Apple.

### Glass (measured beside today's frame, Ukrainian, light and dark)

| | Light | Dark |
| --- | --- | --- |
| Controls compared with today's frame, desktop | 50 to 109 per frame, 0 moved | the same, 0 moved |
| Lowest text contrast on the glass layer, variant 6 | 4.92:1 (the engine label below aside) | 5.6:1 |
| Lowest text contrast on the same surfaces today | 3.03:1 (the engine label) | 4.67:1 |
| Lowest text contrast, variant 7 (palette, Settings, menus) | 4.94:1 | 6.37:1 |
| Texts under AA on glass | 1, inherited: the engine name "Claude" in the rail footer, 2.95:1 (3.03:1 today) | 0 |
| Texts under AA today that glass lifts over it | 1: a column's count over the dotted ground | 0 |

Four findings a build must carry:

- **A backdrop blur on a bar moves what the bar hosts.** The board header hosts the fixed attention notice. A `backdrop-filter` on the header makes it the containing block of that notice, and the notice slid under the orchestrator pane. The prototype draws the blur on a layer under the bar's content, and the control-by-control comparison holds it.
- **Secondary labels need one step more ink on glass.** Over a dimmed backdrop the muted label colour read 4.2:1 on a menu. On glass surfaces the prototype mixes 30 % of the primary text colour into the muted one, and menus and sheets use an 86 % fill. Both belong in `tokens.css` with a case in `tokens.contrast.test.ts`.
- **One label is under AA today and stays there.** The engine name in the rail footer is drawn in the engine's orange and reads 3.03:1 on today's card and 2.95:1 on glass. Variant 7 has no footer and prints engine names in the primary text colour; a build that keeps the footer should give that label an AA ink.
- **In dark the wash is faint.** Dark glass reads mostly as today's dark with softer edges. That is honest to the restraint the requirement asks for; a stronger dark wash would cost contrast on the columns.

Cost: about 40 style rules and six tokens (`src/styles/tokens.css`, `kanbanBoard.css`, the phone bar and sheet classes), one lane, plus the contrast case. Risk: low for layout (nothing moves, measured), medium for performance on a phone, where three blurred layers (bar, dock, sheet) should be profiled on the operator's own device before it ships. Gain: depth and a calmer shell with no control added or moved.

## The combined proposal: variant 7

Variant 7 puts together 1 (no rail), 5 (object-only menus and one Settings place) and 6 (glass).

- The window at rest has no rail: the board gets the full width, the header is one row at 1000 px, and 80 controls are visible at 1440 where there were 83 with one project (the gap grows with every project the rail would list).
- The project title opens the palette: projects with their counts and crowns, Archived, New project, then Settings. On the phone the same content is the project sheet, with System and Settings as its last two rows.
- The chip after the status line prints the tightest limit and opens the System panel: memory, sessions with "Stop idle", each engine's windows with Accounts, and messaging.
- The board's "⋯" has three rows. A card's has its status, priority and six rows, then one row per lane. The phone's board menu has seven rows and the conversation menu twelve, whatever the number of agents.
- Settings is one surface with two scopes, the same on both devices.

Where every function lives in 7 is the last column of the menu table above for G, B, W and M, and variant 1's column of the sidebar table for S.

## Recommendation

**Sidebar: 1.** It is the only direction that answers "remove it altogether", it returns a quarter of a narrow window, and it leaves one finder where there were a filter, a rail and a header menu. Its price is one more press to switch project. If the operator switches projects many times an hour and reads the other projects' attention marks from the rail, 3 is the better answer: it keeps one-press switching and per-project dots for 52 px. Variant 2 changes the least and gains the least; it is worth building only as the first step towards 1 or 3, because its System row and its Settings row are the same pieces.

**Menus: 5.** The complaint is too many buttons, and 5 removes the most from every first view while giving settings one address that is the same on the phone. Its price is depth on rare settings. Variant 4 keeps settings closer and reads well on the phone conversation, where its three wide buttons (Interrupt, Compact, Pipelines) beat 5's twelve even rows. A fair mix is 5 everywhere with 4's promoted row on the phone conversation menu; it is listed as a question below.

**Visual language: 6**, as tokens and fills only, after the structure is settled, with the four findings above carried into the build.

**Together: 7.**

### Order of work, in small mergeable steps

Each step leaves the product whole and can be the last one.

1. **The System panel.** `ResourcesFooter` and `LimitsFooter` render inside one panel; the rail's footer becomes the one row that opens it. Removes five lines of footer and S7. No other screen changes.
2. **The Settings place, desktop.** A dialog with the two scopes whose rows open today's dialogs. The rail's "⋯" opens it. The model test of this lane moves beside it as the guard that no entry is lost.
3. **The board menu, desktop and phone.** Policies, sound and "Asks you" leave for Settings; the phone menu drops to seven rows; the phone gets language, phone access, push and sign-out through Settings.
4. **The phone conversation menu.** Agents become one row with a list behind it; rename and crown move to the sheet's title row; the menu's copy of Search goes.
5. **The card menu.** Lane actions drill in; colour and icon move into Details.
6. **The palette and the title switcher.** The project title in every board header opens it; Ctrl+K and B open it; the rail stays, hidden by default, for one release.
7. **The rail is removed**, with its tests, its storage key and the walkthrough's anchors re-pointed.
8. **The phone project sheet** gains the filter, the crown, System and Settings.
9. **Glass tokens**, with the contrast case and a phone performance check.

Steps 1 to 5 are worth doing whichever sidebar number is chosen. If the answer is 3 in place of 1, steps 6 and 7 become "the rail's closed mode" and the rail's list is kept.

## Questions for the operator

Answer with numbers.

1. **Sidebar: 1, 2 or 3?** Recommended: 1. Choose 3 if switching project must stay one press with each project's attention mark in view.
2. **Menus: 4 or 5?** Recommended: 5.
3. **On the phone conversation menu, 5 as drawn (twelve even rows) or 5 with 4's three wide buttons on top?** Recommended: with the three buttons.
4. **Glass: 6, yes or no?** Recommended: yes, last.
5. **Which actions are frequent enough to be promoted?** The prototype guesses: Interrupt, Compact and Pipelines in a conversation; Tasks, Pipelines and Hidden on the phone board; Search and Accounts on the desktop board. The audit could not rank clicks, so this is the operator's call.

## Deferred — not currently justified

- **Scroll-under bars.** Real liquid glass lets content pass under a floating bar. Today's bars are layout siblings of the content, so nothing scrolls under them, and the prototype keeps that. Making content scroll under the header and the phone's bars changes every screen's insets; it has no evidence of need yet.
- **A full command palette of actions** (create a task, start a pipeline, jump to an agent by name). The palette here finds projects and settings. Actions and agents need a search index and ranking the audit did not ask for.
- **Inlining today's settings dialogs into Settings.** Step 2 opens them from rows. Merging telemetry, linked installations, relay and updates into panes is a later, separate change.
- **A morphing or refracting glass effect, tinted glass per project, animated washes.** Decoration with no function behind it.
- **Human-message navigation in a conversation** (the audit's F6) is a separate design with its own rejected drafts; this lane changes no conversation chrome.
- **Reordering projects by hand, monogram colours, a third tile letter** for variant 3: only if 3 is chosen.
- **The phone task overflow (W8)** takes the card menu's grouping in both directions; it is described in the table and was drawn once, on the desktop card.
- **No ADR.** Nothing here is decided, and every step above is reversible.

## Limits of this evidence

- The fixture's board is synthetic and smaller than the live one: one real project in today's rail, 16 controls in today's phone conversation menu where the audit's live sample had 55. Where the two differ, both numbers are given.
- Press counts for today's paths come from the audit's source reading and this run's menus; they exclude typing, scrolling and the final confirmation of a guarded action.
- Frames are Chromium at phone dimensions with touch emulation. The operator's physical phone and its browser were not used, and blur performance was not profiled.
- The prototype's menus are inert: a row's product action, its disabled states and its safety steps (stop a host, delete a project) are today's and must be carried over unchanged by the build.
- The glass contrast reading covers the glass layer's text in the measured states; body text on cards and in the feed is on today's solid surfaces and was not re-measured.
- Checks run for this lane: the kanban browser driver's `interface redesign` block (the frames and `evidence/interface-redesign/measurements.json`), `interfaceRedesign.prototype.model.test.ts`, eslint on the touched files, the type check, and the repository's publication hooks. Hosted CI was not awaited.
