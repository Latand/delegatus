# Install, first run and the community launcher

Status: design, no product change. Written 2026-11-10 against `main` at
`3192d84b` (2026-11-10) and revised the same day after one critique round:
every fact the critique disputed was read again in the code and in a fresh
scratch clone of the launcher. At revision time `main` was at `688dc34f`, which
touches none of the files cited here. Every `file:line` on our side is from
`3192d84b`. The community launcher was read at its commit
`b2cc436e11affd49496098ac4517b441f3bc2c68` (committed 2026-11-10 03:51 UTC);
its paths below are relative to its repository root. Nothing was built or run
for this document: the launcher was cloned into private scratch and read as
text, and our code was read without starting it.

## 0. Originating requirement

Source: the operator's request in the Delegatus seat conversation,
2026-11-10, about 13:00 UTC. The pinned specification keeps the verbatim
message private, so this is a neutral English paraphrase:

> Someone outside the project built a launcher for Delegatus. Can we think
> about how to build it in? More broadly, design a convenient installation and
> onboarding: first make sure an agent account is set up, then import memory
> from that account, teach that work starts with the orchestrator, perhaps
> create the orchestrator for the user right away, simply ask what they want
> done and explain that this will start an agent. Claude is preferred for the
> orchestrator; when only Codex is available, recommend Claude but run the
> orchestrator on Codex GPT-6.1-Sol.

The seat split this into two questions:

- **A.** The unofficial community launcher (a macOS app in Swift, a Windows
  launcher in C# and PowerShell, MIT) opens Delegatus in its own window and
  installs Bun and Delegatus privately per user. Can it be built into the
  project, and how?
- **B.** The first run as a whole, against six points: (1) an agent account
  first; (2) memory import from that account; (3) teach that work starts with
  the orchestrator; (4) possibly create the orchestrator for the user;
  (5) ask what the user wants done and explain that this starts an agent;
  (6) prefer Claude for the orchestrator, and with Codex only, recommend Claude
  and run on Codex GPT-6.1-Sol.

## 1. Short answer

- **A.** Recommend publishing a short launcher contract on our side now, and
  linking the launcher as an unofficial community project once it offers a
  downloadable build (A5 below). Today a link gives a user who avoids the
  terminal nothing to run: the launcher's repository has no releases and no
  tags, its Mac app exists only as source to build with Apple's command-line
  tools, and its Windows launcher was never run on Windows. Adopting its code
  (A2) would make us own a Swift app, a C# and PowerShell launcher, Apple
  signing and notarization, Windows signing and Windows testing, for a
  native-Windows Delegatus that has no Codex and no managed accounts. B does
  not depend on A.
- **B.** The setup guide already carries most of the six points. The design:
  - makes sign-in the next action until an engine is connected, and puts the
    install command into the engine card when no agent CLI is found;
  - moves the roles that pipelines need onto the one connected engine and
    leaves the orchestrator row on Claude, so a Codex-only orchestrator runs
    GPT-6.1-Sol at high effort, and a Claude sign-in before Create, or before
    the next project's orchestrator, puts it back on Claude;
  - offers the memory switch right after sign-in and sends it only once the
    orchestrator exists, because the import fixes where each note is curated
    at the moment it starts;
  - adds one advice line for Codex-only installs, and makes the first
    message's placeholder say that sending it starts an agent.

  No new screen is needed. The new elements are small and sit in existing
  places: the command line in the engine card, the advice line on the
  Orchestrator step and a failure line in the seat panel. Two defects were
  found while reading. A newcomer's memory
  import sends every note outside a seated project to the Delegatus
  repository's own project, which has no seat on a newcomer's install (§3.6;
  slice 0 measures it). On a Claude-only install the first pipeline is refused
  because Builder and Reviewer default to Codex, while the guide promises a
  "next step" that does not follow (§3.5).
- Six questions remain for the operator (§7).

## 2. Earlier work this builds on

Searched first, as the working rules ask. Transcript searches, project-scoped
then unscoped: "setup wizard first run", "onboarding first orchestrator
created for the user", "memory import from account into new installation",
"desktop app wrapper Tauri Electron native window", "community launcher".
`search_memory` for onboarding, first run and orchestrator engine returned
nothing. What the searches and the repository gave:

| Source | What it settled | Reused here |
|---|---|---|
| `docs/design/onboarding.md` (#1876) | The setup guide, its marker per install, engine sign-in rows | Steps, marker, "nothing is gated" principle |
| `docs/design/orchestrator-first-onboarding.md` (#2166) | Desktop first run leads to the orchestrator; the interface walk; the greeting a newcomer reads | Steps 3–5 of the flow |
| `docs/design/orchestrator-reports.md` §5.6 | At the operator's request of 2026-09-25 the guide gained an optional Telegram reports step, placed before Orchestrator so the new seat's first report knows its destination | Q6 |
| `docs/design/memory-source-switch.md` | One memory per install; turning on Delegatus memory imports Claude and Codex notes once through the curator | Point B2 |
| `docs/design/install-memory-transfer.md` (#3195, #3233) | `delegatus export` / `import`; only Delegatus memory travels; engine memory is imported once on the new install | Relation to task c2c481e5 |
| `docs/design/onboarding-diagnostics.md` (#3295) | `delegatus doctor` and `GET /api/onboarding/diagnostics` shipped 2026-10-25 | Launcher contract, relation to task 8cf753fd |
| `docs/design/windows-support.md` (#1201) and `docs/guide/getting-started.md:66-69` | Native Windows runs Claude Code only; Codex, managed accounts, the MCP server, dictation and `--tailscale` are missing | Part A Windows assessment |
| `docs/macos-newcomer.md` | The agent CLI resolver and the install prompt on macOS | Part A macOS assessment |
| `docs/verification/fresh-install-startup.md` | `delegatus-cli@1.13.0` failed its first start on a clean install under Bun 1.4.0 and 1.4.3; the corrected build answered `GET /` with 200 | Version-pin risk, readiness |
| Seat conversation, 2026-10-15 (paraphrased) | A Windows app shell (Tauri or Electron) is the layer after the backend starts natively and stably; wrapping a backend that does not start first gains nothing | Part A recommendation |
| Board tasks e6a358dc, 8cf753fd, c2c481e5 | Six setup-guide scenarios; diagnostics and doctor; moving memory and settings | §6 |

## 3. Observed facts

### 3.1 The community launcher (read at `b2cc436e`)

Repository: 5 commits between 2026-11-08 and 2026-11-10; MIT licence
(`LICENSE`), copyright "Delegatus Community Launcher contributors"; the
Delegatus icon is credited to our MIT project (`THIRD_PARTY_NOTICES.txt`).
It contains sources, build scripts, guides and a prebuilt Windows launcher
(`Windows/Delegatus.exe`, 16 384 bytes; its SHA-256 `ea5f6b74…72bf` matches
the repository's own `Windows/SHA256SUMS.txt`).

How a user gets it (read 2026-11-10 from the repository and the GitHub API):

- The repository has no releases, no tags and no homepage; its release and
  tag lists both came back empty.
- The README says the ready-made universal ZIP for Mac and Windows "is
  distributed separately" and names no place to get it (`README.md:31-40`).
- The Mac app is in the repository only as source. `Source/BUILD.txt` builds
  it with `./build.sh` and Xcode Command Line Tools, which needs a terminal.
- Windows users are told to download the repository as a ZIP and open its
  `Windows` folder (`README.md:32-36`).

| Aspect | macOS | Windows | Source |
|---|---|---|---|
| Form | AppKit app, universal arm64 + x86_64, macOS 13+, bundle id `org.delegatus.community-launcher` | `Delegatus.exe` (C#, .NET Framework 4.7.2) runs `Resources/Launch-Delegatus.ps1` in Windows PowerShell 5.1; `Start Delegatus.cmd` is a console fallback | `Source/build.sh:11-16,23,27,33`, `Source/WindowsLauncher.cs:24-53`, `Windows/Start Delegatus.cmd` |
| Window | Its own WKWebView window with back, forward, reload, controls and log buttons | An Edge or Chrome `--app=` window with a private `--user-data-dir` profile; default browser after confirmation if neither is found | `Source/Launcher.swift:272-300`, `Launch-Delegatus.ps1:570-587` |
| What it installs, after an explicit confirmation | Bun 1.4.3 from the official release, archive SHA-256 checked, then `delegatus-cli@1.11.0` with `bun install` into a private folder; the publish step is transactional | Bun 1.4.3 (x64 baseline or arm64, SHA-256 checked), then `bun add --exact delegatus-cli@1.11.0` into a private folder with a completion receipt | `Source/setup-runtime.sh:61-107`, `Launch-Delegatus.ps1:313-363,418-424`, `Resources/Runtime-manifest.json` |
| Where | `~/Library/Application Support/Delegatus Launcher/{Runtime,Logs,settings.json}` | `%LOCALAPPDATA%\Delegatus Launcher\{Runtime,Logs,BrowserProfile,settings.json}` | `Source/Core.swift:22-35`, `Launch-Delegatus.ps1:656`, `Windows/README_EN.txt` |
| Discovery and reuse | A healthy server on `127.0.0.1:8898` is reused and left running on quit. Otherwise it looks for Bun ≥ 1.4.0 (or the package's `engines.bun`) and `delegatus-cli/bin/cli.mjs` in the saved paths, its private folder, `~/.bun`, `~/.npm-global`, `BUN_INSTALL`, `PATH` and Homebrew paths; the user may pick both files by hand | Same order: saved paths, `~/.bun`, `BUN_INSTALL`, `%APPDATA%\npm`, `PATH`, private folder (only completed installs) | `Source/Core.swift:87-153`, `Source/Launcher.swift:134-141`, `Launch-Delegatus.ps1:236-281,748-756` |
| "Healthy" means | `GET /` answers 200 with HTML containing "Delegatus" and a same-origin `<script src=…js>` that answers 200 | Same check | `Source/Launcher.swift:112-133`, `Launch-Delegatus.ps1:496-507` |
| How it starts us | `bun <cli.mjs> --port 8898 --hostname 127.0.0.1 --no-open` as its child; up to 90 s for readiness | Same arguments; 90 s; logs per run | `Source/Launcher.swift:170-206`, `Launch-Delegatus.ps1:517-536` |
| Child environment | Drops every `LLV_*` and `DELEGATUS_*` variable, sets `LLV_LANG=uk` and `NO_COLOR=1`, rebuilds `PATH` | Drops `LLV_*` and `DELEGATUS_*`, sets `NO_COLOR=1`, a private Bun cache, prepends Bun to `PATH` | `Source/Core.swift:95-105`, `Launch-Delegatus.ps1:97-116` |
| Busy port | Lists listeners with `lsof`, asks, sends SIGTERM to the confirmed PIDs only, waits 8 s, never force-kills | Lists owners with `Get-NetTCPConnection`, asks, rechecks identity, `Stop-Process` on confirmed owners | `Source/Launcher.swift:555-617`, `Launch-Delegatus.ps1:431-472` |
| Stopping | Quit sends SIGTERM to the server it started; a reused server is left alone | "Stop own server" or Exit → Yes runs `taskkill /PID … /T /F` on the server's process tree | `Source/Launcher.swift:636-659`, `Launch-Delegatus.ps1:508-516,588-604` |
| Leaves untouched | Global Bun and Delegatus installs, shell profiles | Global packages, shell profiles, `PATH`, PowerShell execution policy, system settings | `Source/setup-runtime.sh:2`, `Launch-Delegatus.ps1:1-3`, both READMEs |
| Agent CLIs and accounts | Not installed and not signed in; the setup dialog says each user connects Codex or Claude Code in Delegatus | Same | `README.md` "Getting started", `Source/Launcher.swift:451` |
| Interface language | Ukrainian only | English only | `README.md`, `Source/build.sh` (`CFBundleDevelopmentRegion uk`) |

Limits the launcher states about itself (`README.md` "Validation status",
`VALIDATION.json`, `Windows/VALIDATION.txt`):

- The Windows app and its interface were never run on Windows; checks were a
  PowerShell 7 parse and C# compilation on macOS. No Bun or Delegatus
  install was executed for the Windows package.
- The Intel slice of the Mac app was compiled, never run on Intel hardware.
- The Mac app is ad-hoc signed and not notarized; the Windows EXE is not
  Authenticode-signed. Both READMEs say the first launch may be blocked.
- One interface language per platform, as above.

### 3.2 What follows from the launcher for us (inference from the code above)

1. **It installs a release from 2026-10-10.** `v1.11.0` is dated 2026-10-10;
   npm's `latest` for `delegatus-cli` is `2.0.0` (read with
   `npm view delegatus-cli dist-tags` on 2026-11-10). A packaged install newer
   than 1.9.0 can update itself from the Update dialog
   (`docs/guide/operations.md:8-28`), so a launcher user starts on 1.11.0 and
   updates from inside. Whether the update then asks for a launcher restart
   that a user without a terminal cannot perform was not confirmed. The
   launcher's reason for the pin is not stated; 1.13.0 failed a clean first
   start (`docs/verification/fresh-install-startup.md:3-5`).
2. **Bun 1.4.3 is outside our verified pin.** Our image pins Bun 1.4.0
   (`Dockerfile:6,18,79`). AGENTS.md holds that a Bun version is verified only
   once the runtime host has run under it. The only record of 1.4.3 here is
   the fresh-install reproduction above.
3. **Windows stop is a forced tree kill.** `taskkill /T /F` ends the CLI, the
   Viewer, the runtime host and agent processes without our shutdown path
   (`bin/cli.mjs:1059-1086`).
4. **A non-200 answer from a live Delegatus reads as a busy port.** If `GET /`
   on loopback answered anything other than 200 with that HTML (for instance a
   sign-in redirect on a team install), the launcher would offer to stop our
   server. Not confirmed for a team install (§3.8).
5. **The user's `DELEGATUS_*` and `LLV_*` settings never reach a server the
   launcher starts**, and the Mac launcher forces Ukrainian CLI output
   (`bin/cli.mjs:70-76` reads `LLV_LANG`).
6. **A user who follows a link to it today gets no app without a terminal.**
   On macOS they must build it; on Windows they get an unsigned EXE that was
   never run there and that opens a Delegatus with Claude Code only.

### 3.3 How Delegatus is installed today

| Path | What happens | Source |
|---|---|---|
| Package | `delegatus-cli` 2.0.0; commands `delegatus`, `dlg`, `delegatus-mcp`; `engines.bun >=1.4.0`; `os` linux, darwin, win32 | `package.json:2-28` |
| Run once | `bunx delegatus-cli`; installed command `bun add -g delegatus-cli` | `README.md:42-62`, `docs/guide/getting-started.md:77-104` |
| Install prompt | The website's prompt for Claude Code or Codex installs Bun, the agent CLI, the package, starts it with `--no-open` and registers the MCP server; on native Windows it stops at step one and asks for WSL 2 | `landing/site/copy.js`, `scripts/newcomer-install.mjs`, `docs/guide/getting-started.md:105-127` |
| From a clone | `bun install`, `bun run build`, `bun bin/cli.mjs` | `README.md:69-80` |
| Docker | The project's image on GitHub Container Registry, linux amd64 and arm64 | `README.md:86-99`, `docs/docker.md` |
| CLI | Port 8898, host 127.0.0.1, `--no-open`, `--tailscale`; `doctor`, `stop`, `team`, `export`, `import`. The start flags are documented for users | `bin/cli.mjs:47-48,85-97,1151-1177,1871-1876`, `docs/guide/configuration.md:27-29` |
| Self-update | Update dialog builds or downloads a release into the user's cache and relaunches; release pointer per install id | `bin/cli.mjs:1660-1667`, `docs/guide/operations.md:8-28`, `docs/design/self-update-every-install.md` |
| Start output | With neither agent CLI found, it prints the install commands for Claude Code and Codex, asks for a restart after installing, and points to the setup guide | `bin/agent-binaries.mjs:48-49` |
| Platforms | Linux main, macOS works, native Windows runs Claude Code only | `docs/guide/getting-started.md:47-69` |

There is no web app manifest: `/manifest.webmanifest` is exempted by the team
gate (`src/lib/team/gate.ts:40`) but no route serves it.

### 3.4 What the first run shows

| Fact | Source |
|---|---|
| The guide opens by itself when the per-install marker `onboarding.json` was never decided, or when a guide was left in the middle; an install that already holds seats, pipelines, tasks or role overrides is marked `existing-install` and never opens it | `src/app/api/onboarding/route.ts:16-34`, `src/lib/onboarding/marker.ts:41`, `src/components/onboarding/useOnboarding.ts:32-34,147-154` |
| Numbered steps: Engines, Project, Telegram (optional), Orchestrator; "Later, any time": Agents, Phone, Voice, Check, Relay | `src/lib/onboarding/steps.ts:15-17` |
| The Telegram step sits before Orchestrator so the new seat's first report knows its destination; it was added at the operator's request of 2026-09-25. With no bot connected it shows the bot panel's token form | `steps.ts:1-14`, `docs/design/orchestrator-reports.md:28-40,1076-1095` |
| Nothing is gated: every step closes with Escape, ✕ or "Close, finish later"; reopened from the menu row "Setup guide" | `src/components/onboarding/OnboardingDialog.tsx:29-38`, `en.ts:6443` |
| The footer holds one filled button. While a step's own action is the next thing to press (Create the orchestrator, Run the check, Turn on phone access), Continue steps back to a border. The Engines step never claims this today | `OnboardingDialog.tsx:438-446` |
| Old `agent-log-viewer` state in use shows a notice with clean-start steps | `OnboardingDialog.tsx:168-174`, `src/lib/onboarding/legacyState.ts:10-23` |
| Phone: the same guide as a full-screen sheet with a step list in the header and footer buttons | `OnboardingDialog.tsx:476` onward |
| After the seat goes live, a three-stop interface walk: the seat composer, the board, "Needs you"; the last button is "Give it the first task" | `src/components/onboarding/OnboardingWalk.tsx:14-29,162-165,360`, `en.ts:6513-6525` |

### 3.5 How Claude and Codex accounts are detected and signed in

| Fact | Source |
|---|---|
| Engines step: one card per engine with the accounts screen's own rows; Copilot beside them; "Check again" | `src/components/onboarding/EnginesStep.tsx:13-22,106` |
| CLI presence from `GET /api/accounts` and `GET /api/accounts/cli` (a `--version` probe); Check again bypasses the one-minute cache | `OnboardingDialog.tsx:88-109`, `src/app/api/accounts/cli/route.ts:8-12` |
| "Connected" means the CLI is found and an account holds a credential | `EnginesStep.tsx:28-41` |
| With a CLI missing, its card says only "Install Claude Code, then press Check again." or "Install the Codex CLI, then press Check again."; the account rows stay listed and inert. The install commands appear only in the CLI's terminal start output | `en.ts:6533-6534`, `EnginesStep.tsx:95-105`, `bin/agent-binaries.mjs:48-49` |
| The command search looks in `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `/usr/local/bin`, Homebrew and `PATH` on each probe, so Check again can find a CLI installed while Delegatus runs if it lands there; where the vendors' installers put it was not checked | `bin/agent-binaries.mjs:6-39` |
| The repository records only the macOS and Linux shell installers for Claude Code and Codex; no Windows command is recorded | `README.md:50-51`, `docs/guide/getting-started.md:34-35`, `scripts/newcomer-install.mjs:158` |
| Claude sign-in runs `claude auth login --claudeai` and takes the pasted code | `src/lib/accounts/claudeLogin.ts:468`, `src/app/api/accounts/claude/login/[operationId]/input/route.ts` |
| Codex sign-in is the ChatGPT device code through `codex app-server` | `src/lib/accounts/codexAppServer.ts:374-378` |
| Agents use their own Claude configuration, so a second sign-in is expected; the card says so | `EnginesStep.tsx:98`, `en.ts:6494` |
| One engine only, or neither: one line each. The one-engine line says roles that default to the other engine "need a new home, which the next step handles"; the next numbered step is Project, and the role move lives in the Agents step under "Later" | `EnginesStep.tsx:177-178`, `en.ts:6540-6541`, `steps.ts:15-17` |
| Builder and Reviewer default to Codex GPT-6.1-Sol, so a Claude-only install has its first pipeline refused before any stage starts until roles move | `src/lib/roles/defaults.ts:261-292`, `docs/guide/getting-started.md:296-305` |
| The Agents table's "Move them to {connected}" moves every row on the missing engine that is not locked to it, the orchestrator row included. Moved to Codex, the orchestrator row becomes GPT-6.1-Sol at **medium** effort and is saved as this install's role config. Only the visual critic is locked (to Claude) | `src/components/onboarding/AgentMappingTable.tsx:51-67,449-465`, `src/lib/roles/equivalents.ts:60-91`, `src/lib/roles/locks.ts:12`, `en.ts:6580-6581` |
| Default engines of the table's rows: on Codex, Builder, its general fix row, Reviewer, the trivial reviewer, Verifier, Cleaner, Prod-auditor, Deployer, Maintainer and Merger; on Claude, Orchestrator, Architect, Issue-reporter, Visual critic, the builder rows for trivial, frontend and docs, and the frontend and docs fix rows | `defaults.ts:234-398`, `src/lib/roles/paramConfig.ts:12-22` |
| The curator role defaults to Codex GPT-6.1-Sol and has no row in the Agents table, so the move never reaches it | `defaults.ts:379-381`, `AgentMappingTable.tsx:51-67` |
| Delegatus does not install agent CLIs; it tells the user what to install | `en.ts:6533-6535`, `bin/agent-binaries.mjs:48-49` |

### 3.6 What memory import exists

| Fact | Source |
|---|---|
| Settings row "Delegatus memory": off by default ("unchosen"); turning it on imports Claude and Codex notes through the curator | `src/components/memory/MemorySourceRow.tsx:10-27`, `src/components/settings/SettingsWindow.tsx:140`, `en.ts:116-135` |
| Claude's and Codex's own memory stays on until the import finishes; then new agent starts remember through Delegatus rules only, and the engines' own memory is off for them. An undo exists | `en.ts:121-126,134` |
| The first choice must be Delegatus memory | `src/lib/memory/source.ts:88-91` |
| Pressing the row sends `PUT /api/memory/source`, which needs operator authority and starts the import in the same request | `MemorySourceRow.tsx:110`, `src/app/api/memory/source/route.ts:25-42` (start at `:39-40`) |
| When the import runs it fixes its host project (the first Delegatus-repository project with a designated seat, else the first one) and each note's curation project (the note's own project when that has a seat, else the host). Curation batches select notes by that stored project | `src/lib/memory/importWork.ts:428-437`, `src/lib/memory/importCuration.ts:103` |
| Sources: `~/.claude/projects/*/memory` and `~/.codex/memories`, plus every managed account home under the state directory's `accounts/` | `importWork.ts:41-47,136-142` |
| Curation passes wait while learned rules, seat wakes or the curator are off, or during an update or deployment | `src/lib/memory/curation/admission.ts:29-38` |
| A curation pass also needs a designated, live orchestrator seat in its project | `admission.ts:47-56,116-133` |
| The curator starts by role with no engine named; a launch refused for a missing engine settles the pass as "no-account" | `src/lib/memory/curation/run.ts:77,104` |
| Between installs: `delegatus export` / `delegatus import` carry Delegatus memory and settings; accounts arrive signed out | `bin/transfer.mjs`, `docs/guide/operations.md:83-101` |

Inferred from the code alone, without a run:

- **Timing.** A memory switch pressed before any seat exists starts the import
  at once and fixes every note's curation project then. On a newcomer's install
  the Delegatus repository is usually no project at all, so the host project
  has no seat and every note waits on "no designated seat". A seat created
  later changes nothing, because the stored curation project does not move.
- **Host.** Even when the import starts after the newcomer's first seat
  exists, only notes from that seat's own project are curated there. Every
  other note still goes to the Delegatus repository's project, because the
  host choice looks only at that repository's projects.
- **Reason line.** The Settings row's admission reasons name memory, wakes,
  curator, update and deployment (`en.ts:128-133`). None names a missing seat,
  so the row would say "Importing … 0 of N" with no reason.
- **Curator engine.** On a Claude-only install the curator would start on
  Codex and its pass would settle as "no-account".

Slice 0 measures all four.

### 3.7 The first orchestrator: how it is created, what it says, what it runs on

| Fact | Source |
|---|---|
| The Orchestrator step explains in three lines and a schematic, names the project and "Runs on" with Change, and owns "Create the orchestrator" | `src/components/onboarding/OrchestratorStep.tsx:19-29,214-270`, `en.ts:6489-6492` |
| Create hands the project's own create draft a request with `confirm`; the draft presses its own Confirm, so the one designation path stays the draft's. The pending confirm lives 60 s and is dropped if the user leaves the project | `OrchestratorStep.tsx:25-28`, `src/components/orchestrator/draftPrefill.ts:31-43,65-79,89-102`, `OnboardingDialog.tsx:320-324` |
| Role default: Claude, `opus`, effort high | `src/lib/roles/defaults.ts:234-237` |
| `orchestratorRuntime` returns the role row's own config whenever that row's engine is connected, effort included. Only a row on an unconnected engine falls back, to the connected engine's default model at high; Codex's default model is `gpt-6.1-sol` | `OrchestratorStep.tsx:56-62`, `src/lib/agent/models.ts:18,149-151` |
| The step remounts its launch draft whenever that answer changes, so connecting Claude before Create moves an untouched step from Codex to Claude · Opus · high when the role row is still on Claude | `OrchestratorStep.tsx:85-90` |
| The step never writes role defaults. The seat create draft outside the guide starts from a fixed Claude · Opus · high and does not read the role row | `OrchestratorStep.tsx:124-125`, `src/components/orchestrator/OrchestratorPanel.tsx:241-247`, `src/lib/orchestrator/prompt.ts:97-104` |
| A designated seat keeps its engine; its rotate draft has the same "Runs on" row, which is the way to move it | `OrchestratorPanel.tsx:941-948,1150` |
| For a newcomer: an API cost estimate, and "Use cheaper Codex · GPT-6.1-Sol" when Claude is chosen and Codex is connected | `OrchestratorStep.tsx:124-135,262-267`, `en.ts:6496-6498` |
| A line on permissions and a line on the plan and the wake interval (5 minutes by default) | `OrchestratorStep.tsx:259-261`, `OnboardingDialog.tsx:86`, `en.ts:6495,6499` |
| Blocking states: no project, no engine ("Connect Claude or Codex first." with "Go to Engines"), a seat already held, the chosen account signed out | `OrchestratorStep.tsx:162-193`, `en.ts:6502-6506` |
| First turn of a fresh seat: two lines, "Ready in {project}." and "Tell me what you want done here. I'll turn it into tasks on the board, have agents build and review it, keep it moving and report back. New work starts when you ask; I'll suggest what could come next." | `src/lib/orchestrator/prompt.ts:133,146-150` |
| The seat composer's placeholder: "what should get done in {project}?" | `src/components/orchestrator/OrchestratorConversation.tsx:86`, `en.ts:1470` |
| A failed create shows "Try again" on the draft's Confirm | `OrchestratorPanel.tsx:1289` |

### 3.8 What I could not confirm, and where I looked

| Question | Where I looked | Status |
|---|---|---|
| Does any Mac or Windows build of the launcher start under Gatekeeper or SmartScreen | Its READMEs and validation files | Not run, by the fence; the author reports the risk |
| Where the launcher's "distributed separately" package can be downloaded | Its README, its release and tag lists, its repository homepage field | Nowhere observed; all three are empty |
| Does a self-update started inside a launcher-run 1.11.0 finish without a terminal | `docs/guide/operations.md:15-28`, `bin/cli.mjs:1660-1700` | Unknown; needs a run (slice 0) |
| Does our loopback `GET /` answer 200 with a same-origin script on a solo and on a team install | `src/lib/team/gate.ts:40,170-184`, `docs/verification/fresh-install-startup.md:141-145` | Partly: a built Viewer on a solo install answered `GET /` with 200 there. The page's text, its script and a team install remain unchecked |
| Is `gpt-6.1-sol` offered to every Codex plan a newcomer may hold | `src/lib/agent/models.ts`, `src/app/api/accounts/codex/models/route.ts` | Unknown; the catalogue is per account |
| The four inferences at the end of §3.6 | Code above | Inferred from code only; slice 0 |
| How the Engines step behaves on native Windows, where managed accounts are missing | `docs/guide/getting-started.md:66-69` | Not exercised |
| The Windows install command for Claude Code or Codex | This repository | Not recorded here and not looked up elsewhere |
| Whether browsers offer "install as app" for `http://127.0.0.1:8898` once a manifest exists | Nothing in this repository | Not checked |

## 4. Part A: options for the launcher

Cost is in agent lanes and owned surfaces; money for certificates and
memberships was not checked and is left out. "The contract" is the short
section on our side described after the table.

| # | Option | What the user gets | What we own afterwards | Cost | Risk | Needs from the author |
|---|---|---|---|---|---|---|
| A1 | **Link it now** as an unofficial community project, with its stated limits, and publish the contract | A Mac user who follows the link finds source and a build script that needs Xcode Command Line Tools and a terminal; the ready-made package has no download location we could point to. A Windows user gets an unsigned EXE never run on Windows, which installs 1.11.0 and opens a Delegatus with Claude Code only. A user with a terminal gains nothing over `bunx delegatus-cli` | One docs row and the contract; keeping the contract's start arguments, readiness answer and stop behaviour stable for third parties, with notice before a change; answering issues that turn out to be launcher issues | One small docs lane | We point users at unsigned binaries and a 1.11.0 pin while nothing usable is downloadable; mitigated only by the label | Nothing required; tracking the contract is their choice |
| A2 | **Adopt it into this repository as the official launcher** | An official Mac app and Windows launcher | Swift, C#, PowerShell code beside a TypeScript project; macOS and Windows build jobs; Developer ID signing and notarization; Authenticode signing; a version pin that follows every release; Windows GUI testing we have no runner for; both interfaces in en and uk; support | Several lanes plus recurring signing and release work; a prebuilt `Delegatus.exe` cannot enter our tree as is, so CI must build it | High on Windows: native Delegatus there has no Codex and no managed accounts, so B1 and B6 fail on the launcher's main promise; bundle id `org.delegatus.*` already used by the community build | Nothing legally (MIT keeps the notice); a courtesy agreement on the name and bundle id |
| A3 | **Build a first-party launcher informed by it**, smallest first: a web app manifest so Chrome and Edge can install the running Viewer as its own window with our icon, then (later, macOS first) a signed app that starts `delegatus` and shows the same window | A window and an icon from any OS without new native code; later a signed Mac app | A manifest route; later one native app with signing | One small lane for the manifest; a large lane for a signed app | Low for the manifest; the signed app carries A2's signing load for one platform | Nothing |
| A4 | **Do nothing** | Unchanged | Nothing | None | Users find the launcher anyway and meet the 1.11.0 pin and the forced Windows stop with no guidance from us | Nothing |
| A5 | **Publish the contract now; link the launcher when it offers a downloadable build** | Nothing new today. Anyone writing a launcher, this one included, gets our start command, readiness check, safe stop and version advice in one place. A Mac user gets a link once there is something to download | The contract and its stability, as in A1; one docs row later | One small docs lane now, one row later | Low; the contract may go unread, since we do not contact the author | Nothing; a downloadable build is the trigger for the link |

**Recommendation: A5**, with A3's manifest as a candidate for a later slice.

- A link today (A1) sends the users the operator has in mind, people who avoid
  the terminal, to a repository with nothing they can run without one. It
  also adds a public promise to keep the contract stable.
- The contract is the place where "build it in" can happen without owning
  native code: the start command and the readiness check are where the two
  tools meet. It also answers, on our side, four things §3.2 found fragile in
  the launcher: the old version pin, the forced Windows stop, readiness read
  from page text, and dropped settings.
- The start flags are already public (`docs/guide/configuration.md:27-29`), so
  the new commitment is the readiness answer and the stop behaviour.
- A2 makes us own two native stacks and two signing chains before the Windows
  backend can carry the onboarding the operator asked for. The 2026-10-15 seat
  analysis reached the same order for any app shell.
- A3's manifest would give the "own window and icon" part cheaply once it is
  checked in a browser (§3.8, last row). It stays deferred until the operator
  asks for it.

What the contract states (for A1 and A5), each a fact our code already has:

| Item | Value | Source |
|---|---|---|
| Start | `delegatus --port <n> --hostname 127.0.0.1 --no-open` | `bin/cli.mjs:85-97`, `docs/guide/configuration.md:27-29` |
| Readiness | `GET /` answers 200; a launcher should not depend on the page's text or scripts. Recorded for a built Viewer on a solo install; the contract slice checks a team install | `docs/verification/fresh-install-startup.md:141-145`, §3.8 |
| Diagnostics | `delegatus doctor --json`, exit 0, 1 or 2 | `docs/design/onboarding-diagnostics.md` |
| Stop | SIGTERM or SIGINT to the CLI runs our shutdown of the Viewer and the runtime host it started; `delegatus stop --all` also stops every agent; a forced tree kill skips both. Whether either signal path works the same on native Windows was not checked | `bin/cli.mjs:100,1059-1086` |
| Settings | The CLI reads `LLV_*` and `DELEGATUS_*` from its environment; dropping them drops the user's settings | `bin/cli.mjs:70-76` |
| Version | Install `delegatus-cli@latest`, or the newest tag; updates come from the Update dialog | `docs/guide/operations.md:8-28` |
| Bun | 1.4.0 is the verified pin | `Dockerfile:6` |

## 5. Part B: the first run

### 5.1 The flow, step by step

The guide keeps its shape: Engines → Project → (Telegram, placed by Q6) →
Orchestrator, then the walk.

| # | Requirement point | Existing screen or control | Change | New chrome? |
|---|---|---|---|---|
| 1 | B1 account first | Engines step cards, their account rows and Check again (`EnginesStep.tsx`); the footer's one-filled-button rule (`OnboardingDialog.tsx:438-446`) | Until Claude or Codex is connected, the Engines step owns the primary, as Create does on the Orchestrator step: the footer's Continue steps back to a border and reads "Continue without an agent" (Q5). With a CLI present, the next action is that card's own Sign in row. With no CLI, each card adds the install command the CLI already prints at start (`bin/agent-binaries.mjs:48-49`) as one code line with the existing copy button (`src/components/feed/CopyButton.tsx:58`), and its line becomes "Paste this into Terminal, then press Check again." On native Windows the card keeps today's line, since no Windows command is recorded (§3.5). Which control carries the brand fill in each state is a prototype variant (slice 1); at most one is filled. The lead gains one clause: the next steps create the agent you give work to | One element: the command line in the card. Reason: a user who started Delegatus from an icon or a launcher never sees the terminal start output, and the card is where the guide already says "install" |
| 1b | B5 holds only if the first request can run | The one-engine line (`en.ts:6540`) and the Agents table's move (`AgentMappingTable.tsx:449-465`) | With exactly one engine connected, the one-engine line carries the table's own move action, so the rows pipelines run sit on the connected engine before the orchestrator exists. The move, here and in the Agents table alike, leaves the orchestrator row on its shipped Claude default. `orchestratorRuntime` already places a new orchestrator on the connected engine at high effort, and the seat draft outside the guide never reads the row (§3.7), so moving the row only stops a later Claude sign-in from taking effect. Claude only: the ten Codex-default rows move to Claude. Codex only: the seven Claude-default rows move to Codex (builder trivial, frontend, docs and their two fix rows, Architect, Issue-reporter); Orchestrator stays, and Visual critic stays because it is locked. The row keeps its own selects, so a user can still put it on Codex by hand. The cost, inferred from the code: a role launch of an orchestrator that names no engine (a child orchestrator or a stage with that role) on a Codex-only install still asks for Claude until the row is changed by hand. The line stops promising a "next step" | None; one more condition in the move's row filter, beside the lock condition (`AgentMappingTable.tsx:452-455`) |
| 2 | B2 memory import | Settings row "Delegatus memory" (`MemorySourceRow`); the guide's Create request (`draftPrefill.ts:31-43`) | Once an engine is connected, the same row renders under the engine cards with the number of notes found. Pressed in the guide while the install has no designated seat, it sends nothing yet. The row shows the choice as held ("Starts when the orchestrator is created"), the choice rides the guide's Create request, and the project's draft sends `PUT /api/memory/source` after its own Confirm has designated the seat. If Create is never pressed, or the pending confirm expires, the choice is dropped and the Settings row stays Off. With a seat already designated, the row behaves as in Settings. The order matters because the import fixes each note's curation project when it starts (§3.6) | No new control. Changes: the row's held state and its one line; one optional field on the Create request; the draft's send after Confirm; one server read that counts notes |
| 3 | B3 teach the orchestrator first | Orchestrator step's three lines and schematic; walk stop 1 | Unchanged text. With Q6's recommended answer, a newcomer without a Telegram bot sees the orchestrator as step 3 of 3 | None |
| 4 | B4 create it for the user | "Create the orchestrator" (`OrchestratorStep.tsx:195-200`) with the draft's confirm | Arrives with project, engine, model and account already chosen; one press (Q2) | None |
| 5 | B5 ask what to do, explain it starts an agent | The fresh seat's greeting (`prompt.ts:146-150`); the seat composer placeholder (`en.ts:1470`); walk stop 1 | The placeholder on a seat with no missions reads "What should it do in {project}? Sending this starts an agent on your {engine} plan." The greeting's offer line adds that each request starts agents on the user's plan (a new mandate version, using the existing `SHIPPED_GREETING_OFFERS` replacement) | None |
| 6 | B6 engine choice | `orchestratorRuntime` (`OrchestratorStep.tsx:56-62`); the newcomer cost lines; Go to Engines | Codex only: because step 1b left the orchestrator row on Claude, "Runs on" shows Codex · GPT-6.1-Sol · high. A line under it says Claude is recommended for the orchestrator and that this one runs on Codex GPT-6.1-Sol, with "Connect Claude" going to Engines (the step's existing go-to pattern). Once Claude is connected and the user comes back, the step shows Claude · Opus · high by itself (`OrchestratorStep.tsx:85-90`). After Create, the seat keeps Codex; its rotate draft's "Runs on" moves it (§3.7). Both connected: Claude stays the default; the cheaper-Codex link is decided by Q4 | One line in the step, of the same kind as the existing cheaper-Codex line |

Client changes on the critical path: the Engines step's primary and footer
label, the command line in the card, the orchestrator-row condition in the
move, the held memory choice on the Create request with its failure line in
the seat panel, the advice line and the placeholder. Server: one read that
counts notes. Slice 3 carries the rest of §3.6: the host-project fallback and
the curator's engine on the server, and the Settings switch disabled while the
install has no orchestrator.

### 5.2 By sign-in situation

| Situation | Step 1 | Step 2 | Before Create | After Create |
|---|---|---|---|---|
| Claude only | Claude card connected; Codex card says "Not installed" with its command, or "Installed, signed out"; the one-engine line moves the ten Codex-default rows to Claude | Memory row offered when Claude notes exist; held until Create | Runs on Claude · Opus · high; cost line; no Codex link | The import starts; the seat greets; the placeholder names the Claude plan; the first pipeline can start. The curator's engine is slice 0 (iv) |
| Codex only | Codex card connected; the one-engine line moves the seven Claude-default rows to Codex and leaves Orchestrator and Visual critic | Memory row offered when Codex notes exist; held until Create | Runs on Codex · GPT-6.1-Sol · high; the advice line recommends Claude with "Connect Claude". After Claude connects: Claude · Opus · high | The import starts; the placeholder names the Codex plan; the seat stays on Codex until its rotate draft moves it |
| Both | Both connected; no one-engine line | Memory row covers both; held until Create | Claude default; Q4 decides the cheaper link | As Claude only |
| Neither, a CLI present | The footer reads "Continue without an agent", bordered; the next action is that card's Sign in row | Row hidden (nothing to import yet) | Existing "Connect Claude or Codex first." with "Go to Engines" | No seat; the guide reopens from the menu |
| Neither, no CLI | Each card shows its install command with copy and "Paste this into Terminal, then press Check again."; on native Windows, today's line | Row hidden | As above | As above |

### 5.3 Failure at each step and the way back

| Step | Failure | What the user sees | Way back |
|---|---|---|---|
| 1 | CLI missing | The card's command, copy button and "Check again" | Paste the command into Terminal, then Check again; or "Continue without an agent"; or close and reopen from "Setup guide" |
| 1 | CLI installed but Check again does not find it | The card stays "Not installed" | Restart Delegatus, as the start output already says (`bin/agent-binaries.mjs:48-49`), and reopen the guide |
| 1 | Sign-in fails or times out | The account row's own error (shared with the accounts screen) | Retry from the same row |
| 1b | Move refused | The table's own line "Could not save the mapping: {reason}. Nothing changed." (`en.ts:6597`), rolled back | Press again; or the Agents step under "Later" |
| 2 | Held choice dropped (Create not pressed, or the 60 s pending confirm expired) | The Settings row shows Off | Settings → Delegatus memory |
| 2 | Memory write refused after Create | One warning line in the seat panel, of the same kind as its Telegram line (`OrchestratorPanel.tsx:775-778`): "Delegatus memory was not turned on: {reason}." with Retry; it clears on success | Retry there, or Settings → Delegatus memory |
| 2 | Import held | The row's admission reason | Settings → Delegatus memory; undo exists (`en.ts:134-135`) |
| 2 | Switch pressed in Settings before any orchestrator exists | After slice 3 the switch is disabled there, with the line "Needs an orchestrator first: create one in a project." Today it starts an import whose notes wait (§3.6) | Create an orchestrator, then turn the switch on |
| 3 | Chosen account signed out | Existing warning and "Sign in to {engine} first" | Goes to Engines |
| 4 | Orchestrator launch fails | The guide has closed; the project's seat draft shows the failure and "Try again" (`OrchestratorPanel.tsx:1289`). The held memory choice is sent only after a successful Confirm | Try again there, or reopen the guide: the step offers "Open it" when a seat exists |
| 5 | First message never sent | The walk's last button "Give it the first task" focuses the composer | The composer stays; nothing times out |
| 5 | First pipeline refused because a stage's engine is not connected (one-engine install whose roles were not moved) | The existing refusal names the engine (`docs/guide/getting-started.md:296-305`) | Settings → Roles: engine and model offers the same move; the orchestrator can also set each stage's engine |

### 5.4 Desktop and a 390 px phone

A first run on a phone means Delegatus was installed on a computer and the
guide was never finished; the marker is per install, so the phone opens the
same guide (§3.4). Every change above lands in components both layouts share.

| Element | Desktop | 390 px phone |
|---|---|---|
| Guide | Centred dialog with the step list on the left | Full-screen sheet, step list behind the header toggle, buttons in the footer at 44 px (`OnboardingDialog.tsx:476` onward) |
| Engine cards and sign-in | Side by side | Stacked; rows from `MobileAccountsBody` (`EnginesStep.tsx:106`); Claude's code is pasted, Codex's device code opens in the phone's browser |
| Install command (no CLI) | One code line in the card with the copy button | The line wraps inside the card; the copy button keeps its coarse-pointer size (`CopyButton.tsx:58` onward). A phone user cannot paste it into the computer's Terminal, so the line also says it is for the computer running Delegatus |
| Memory row | Row under the cards, held state until Create | The row's existing `phone` layout (`SettingsWindow.tsx:140`) |
| Advice line (Codex only) | Under "Runs on" | Wraps under "Runs on"; "Connect Claude" at 44 px |
| Placeholder | Seat composer | Phone seat composer; walk stop 1 anchors the phone's board dock (`OnboardingWalk.tsx:26`) |

The prototype (slice 1) renders each state in en and uk, light and dark, at
1440 px, 390 px and one width between, and measures that no line is cut.

## 6. How this relates to the three board tasks

| Task | What it owns | Overlap with this design | Rule |
|---|---|---|---|
| e6a358dc: setup guide, six scenarios | Verifying old-state disclosure, the isolated Claude sign-in line, project search and no preselection, newcomer cost choice, the Haiku alias, the permissions line | Steps 1 and 6 touch the cards and lines it verifies | Its six checks stay with it. This design's build slice must keep them green. Q4 settles the direction of its "newcomer cost choice" check, because the operator's 2026-11-10 request prefers Claude while the cheaper link pushes toward Codex |
| 8cf753fd: shared diagnostics and doctor | A read-only registry for CLI and onboarding | Its first slice shipped as #3295 on 2026-10-25 (`bin/doctor-command.mjs`, `GET /api/onboarding/diagnostics`); the task's note that no doctor command exists is out of date. No UI reads the route yet | The launcher contract points launchers at `delegatus doctor --json`. A diagnostics surface in the guide stays with that task |
| c2c481e5: memory and settings into a new install | `delegatus export` / `import` of Delegatus memory and settings (#3195, #3233), open items for orchestrator drafts and reverse transfer | Step 2 is the one-time engine-memory import that its decision names as the way engine memory enters Delegatus; this design only changes when that import starts on a first run | Step 2 adds no bundle import. Offering a transfer bundle in the guide is deferred |

## 7. Questions for the operator

Each has exactly one recommended answer.

**Q1. What should we do with the community launcher?**
- a) Publish a short launcher contract on our side now (start command, readiness, safe stop, doctor, current release), and link the launcher in our docs as an unofficial community project once it offers a downloadable build. **Recommended.**
- b) Link it in our docs now as an unofficial community project with its stated limits, and publish the contract.
- c) Adopt its code into this repository as the official launcher, with signing and Windows testing on us.
- d) Build our own launcher informed by it, starting with an installable web app window.
- e) Do nothing.

**Q2. How should the first orchestrator be created?**
- a) One press: the Orchestrator step arrives with project, engine, model and account chosen, and "Create the orchestrator" starts it. **Recommended.**
- b) No press: it starts by itself as soon as an account and a project exist, and the step shows it running with Change.

**Q3. How should the first run offer memory import from Claude and Codex?**
- a) Right after sign-in, switched on when notes are found, with their count. The choice is sent when the orchestrator is created and the import runs from then; once it finishes, new agents remember through Delegatus rules only and Claude's and Codex's own memory is off for them, with undo in Settings. **Recommended.**
- b) Right after sign-in, switched off; the user turns it on, with the same timing and the same effect on Claude's and Codex's own memory.
- c) Only in Settings, as today; there the switch turns on only once a project has an orchestrator.

**Q4. When both Claude and Codex are connected, what does a newcomer see on the Orchestrator step?**
- a) Claude by default with the cost line, and no "Use cheaper Codex · GPT-6.1-Sol" link. **Recommended.**
- b) Claude by default with the cost line and the cheaper Codex link, as today.

**Q5. How strictly should the guide insist on an account first?**
- a) Softly: until Claude or Codex is signed in, the Engines step's sign-in (or, with no agent CLI, its install command and Check again) is the next action, and the way forward is a secondary "Continue without an agent". **Recommended.**
- b) Strictly: the guide does not move past Engines until Claude or Codex is signed in.

**Q6. Where should the optional Telegram reports step sit in the first run? It was placed before the Orchestrator step at the operator's request of 2026-09-25, so a new orchestrator's first report knows its destination; without a bot it asks for a bot token.**
- a) Numbered before the Orchestrator step only when a Telegram bot is already connected; otherwise under "Later, any time" beside Phone and Voice. **Recommended.**
- b) Numbered before the Orchestrator step on every install, as today.
- c) Always under "Later, any time".

## 8. Slices

| Slice | Content | Needs before it starts | Output |
|---|---|---|---|
| 0. Measure | On an isolated install (private HOME, XDG dirs, TMPDIR, `LLV_STATE_DIR`, control URL on a closed port): (i) a newcomer memory import with notes under a project that is not the Delegatus repository, started once before and once after a first seat: where each note's curation waits; (ii) a Codex-only account: is `gpt-6.1-sol` in its catalogue, and what the step does when it is missing; (iii) our CLI started with the launcher's arguments under Bun 1.4.0 and 1.4.3: `GET /` on a solo and a team install, SIGTERM shutdown, and an Update from 1.11.0; (iv) a Claude-only install: does a curation pass start the curator on Codex and settle as "no-account" | Nothing | A verification note with commands and outputs |
| 1. Prototype | Numbered variants on the real guide components for the answers to Q2–Q6: Engines in each sign-in state, with the next action and the command line, and the memory row in its held state; Orchestrator with the Codex advice line and with or without the cheaper link; the Telegram step's place; the first-message placeholder. en and uk, light and dark, 1440, 900 and 390 px | Operator answers to Q2–Q6; slice 0 result (i) for the row's wording | Frames under the evidence directory; critic, fix, publish as a decision form |
| 2. Guide build | The Engines step's primary and "Continue without an agent"; the command line in the card; the move on the one-engine line, with the orchestrator row left out of the move; the memory row's held state, the Create request carrying it and the draft's send after Confirm; the note count; Q6's Telegram placement; the Codex advice line; Q4's choice; the placeholder; the greeting line as a new mandate version | The chosen prototype variant | One PR with dom tests per state, among them: Codex only, after the move `GET /api/roles` keeps the orchestrator on Claude, the step shows Codex · GPT-6.1-Sol · high, and after Claude connects it shows Claude · Opus · high; the memory `PUT` is sent only after the draft's Confirm succeeded; plus the board driver's frames |
| 3. Import host and curator | The import's host falls back to the project with a designated seat when no Delegatus-repository project has one; in Settings, while the install has no designated seat, the memory switch is disabled with one line saying an orchestrator is needed first; on a one-engine install the curator starts on the connected engine | Slice 2 merged, so the guide's import starts after a seat exists; slice 0 confirms (i) and, for the curator part, (iv) | One PR with tests that fail on the current code |
| 4. Launcher contract | Q1's answer: for (a), the contract table in `docs/guide/configuration.md`; the "Community launchers" row in `docs/guide/getting-started.md` waits for a downloadable build and describes the launcher by kind | Q1 answer; slice 0 result (iii) | One docs PR |

The first buildable slice is slice 0: it needs no answer and decides the
wording of slice 1 and what slice 3 must cover. No UI is built before the
slice 1 prototype has passed its critic and the operator has chosen a variant.

## 9. Deferred — not currently justified

- **Adopting the launcher's Swift, C# and PowerShell code** (A2). Revisit when
  native Windows runs Codex and managed accounts and the project accepts
  signing and notarization as standing work.
- **Linking the launcher before it offers a downloadable build** (A1). The
  trigger is a release or download location a user can reach without a
  terminal.
- **A Windows launcher of our own.** Blocked by the same Windows gaps.
- **An installable web app window** (A3's manifest). Cheap; waits for the
  operator to ask for it and for a browser check on `127.0.0.1`.
- **A signed macOS app of our own.** Waits for A3's manifest to prove
  insufficient.
- **A text field in the guide for the first request.** The seat composer
  already asks; a field would duplicate it.
- **Running the Claude Code or Codex installer from inside Delegatus.** Today
  the cards say only "Install …, then press Check again."; this design puts the
  command and a copy button in the card (step 1), which still needs one paste
  into Terminal. Running a third-party installer from the Viewer is a new trust
  boundary nobody has asked for.
- **A Windows install command in the engine card.** The repository records
  none, and none was looked up for this document.
- **Offering a transfer bundle import in the guide.** Stays with c2c481e5 and
  the CLI.
- **Starting Delegatus at login on macOS and Windows.** Not in the request.

## 10. Check against the requirement

| Point in the request | Where it is answered |
|---|---|
| Can the launcher be built in, and how | §4, Q1, slice 4 |
| Convenient installation | §3.3 inventory; the contract; A3 deferred with its trigger; the install command in the card (§5.1 step 1) |
| Account first | §5.1 step 1, §5.2 "Neither" rows, Q5 |
| Memory import from that account | §5.1 step 2, §3.6 defect and timing, Q3, slices 0, 2 and 3 |
| Teach that work starts with the orchestrator | §5.1 step 3, Q6 |
| Possibly create it for the user | §5.1 step 4, Q2 |
| Ask what to do and explain that it starts an agent | §5.1 steps 1b and 5 |
| Claude preferred; Codex only runs on GPT-6.1-Sol with advice | §3.7 (`orchestratorRuntime` already falls back to GPT-6.1-Sol), §5.1 steps 1b and 6, §5.2, Q4 |
