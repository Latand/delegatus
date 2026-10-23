# Team workspaces: prototype

Deliverable 2 of `docs/design/workspaces.md`. Static HTML, CSS and a small
script, with no product code. One variant per isolation level of the design's
§6, numbered to match. The design's §9 drew levels 3 and 4 as one variant.
Here they are two, because the level 4 workspace has its own setup, its own
overview columns and its own way of moving a project.

| Variant | Level | What a person sees |
|---|---|---|
| 1 | Views and permissions | A workspace switcher in the rail header, the rail limited to the workspace's projects, a Workspaces tab on the Team page, invite into a workspace, a no-access card, and the owner's All view with an Unassigned fold |
| 2 (recommended) | Partitioned defaults and an agent fence | Variant 1, plus a second step when creating a workspace (allowed accounts, report chat, worker share), a workspace page with those settings and its usage, and the fence stated where it is configured, with what it does not stop |
| 3 | One installation per workspace, same computer user | The switcher lists the installations on this computer and opens each in a new tab; an overview of the linked installations; creating a workspace prints the start command; each Team page is its own team; a link into another workspace meets that installation's sign-in |
| 4 | One computer user per workspace | Variant 3, plus the computer user and CLI logins of each workspace, setup lines that need `sudo`, run by hand, and a project move that clones the repository again |

## The states

Every variant covers the five states the task names. Variants 1 and 2 add the
member in no workspace; each variant adds what its level changes.

| # | Variant 1 | Variant 2 | Variant 3 | Variant 4 |
|---|---|---|---|---|
| 1 | Where the current workspace is shown | same | same (the installation) | same |
| 2 | Switching workspaces | same, plus Workspace settings | switching installations | same |
| 3 | Owner's All view, Unassigned, Move to… | Creating a workspace: its defaults | Owner's overview of all workspaces | same, with users and logins |
| 4 | Creating a workspace | The workspace page | Creating a workspace (prints a command) | Creating a workspace (prints `sudo` lines) |
| 5 | Inviting into a workspace | same | Inviting (this installation only) | Moving a project to another workspace, in two steps |
| 6 | A member without access | same | A member without access (sign-in of the other installation) | Inviting (this installation only) |
| 7 | A member in no workspace | same | | A member without access |

Variant 4's states 1 and 2 are the same screens as variant 3's: the
switcher shows names and sign-in status only, so the computer user first
appears on the owner's overview (state 3).

On the desktop the workspace is named once, in the rail header. On the phone
the board header names it, with its colour dot, above the project name; the
project sheet that header opens starts with the workspace row, which is the
phone's switcher. A member without access still sees their own workspace
there, above a locked "Project hidden" title. Variant 1 states in its create dialog and on the Workspaces
tab that agents are not fenced. In variants 3 and 4 the switcher shows each
installation's name and whether you are signed in to it; ports and computer
users are on the owner's overview only. Every create dialog makes "Design", a
name no other frame lists.

Variant 4's move dialog numbers its two steps: 1, clone the repository as the
workspace's computer user (a command to copy and run by hand), and 2, move the
tasks and history, which is the dialog's primary action and the one that
completes the move.

The phone draws variant 4's state 5 as two screens, 5a and 5b, each with its
own caption: the move sheet covers the project sheet that opened it, so 5a
shows the project sheet with Move pressed and the Move to… choices, and 5b the
move sheet.

## What is reused and what is new

Reused, drawn from the product's tokens (`src/styles/tokens.css`) and its
components: the rail rows, section labels and counts (`ProjectRail.tsx`); the
Team page header, tabs, member rows and dialog (`src/components/team/`); the
invite copy (`team.invite.*`); the sign-in card frame (`AuthShell.tsx`); the
phone sheet, its rows and its indented sub-list (`MobileSheet.tsx`,
`MobileProjectSheet.tsx`); the member colours and avatars; the board columns
(`kanban.status.*`).

New, where nothing existing fits: the switcher, drawn as the account switch's
chip (`EngineAccountSwitch.tsx`); the "not in this workspace" card, in the
sign-in card's layout; the workspace and role fields of the invite dialog; the
Workspaces tab; and, in variant 2, the workspace page.

The commands in variants 3 and 4 use what the CLI accepts today
(`bunx delegatus-cli --port`, `LLV_STATE_DIR`, `bin/cli.mjs`). The export
and import tool a level 4 move needs does not exist; the caption of variant 4's
state 5 says so, outside the product copy.
All names, ports and accounts are invented.

## Opening it

Open `index.html`, or a variant directly:
`variant-2.html?lang=uk&theme=dark`. Add `story` (`variant-2.html?story&lang=uk`)
for the storyboard the frames are taken from. Without `story` the page is the
clickable prototype: the switcher, the menus, the tabs and the dialogs work,
and the bar at the bottom right jumps between the numbered states.

## The frames

The frames are rendered locally and are not committed: `render.mjs` writes
`variant-N-<width>-<lang>.png` (light) and `…-dark.png` (dark) into this
directory, and its `.gitignore` keeps them out of the repository. Each
storyboard draws every state of the variant at a viewport of 1440 or 390 px,
captioned with its number.

Rendered by `render.mjs` in headless Chromium:

```
PLAYWRIGHT_CORE=<playwright-core package> CHROME_BIN=<chromium binary> \
  CHROME_TMPDIR=<short temp directory> node docs/prototypes/workspaces/render.mjs
```

Before writing each frame, the script checks every text range of every state
against the screen edge and against every clipping ancestor, every ellipsis,
and every popover, dialog and sheet against the screen. It also checks that no
token of a command block is split across lines and no continuation backslash
wraps onto its own line, that no inline identifier (a computer user, a folder)
breaks across lines, and that switcher rows and the invite role control's
subtitles stay on one line. The frames the design review saw passed with no
finding at 1440 and 390, and at 820 px (`--widths=820`).
