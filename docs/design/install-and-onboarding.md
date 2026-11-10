# Install, first run and the community launcher

Status: design, no product change. Written 2026-11-10 against `main` at
`3192d84b` (2026-11-10). Every `file:line` on our side is from that commit.
The community launcher was read at its commit `b2cc436e11affd49496098ac4517b441f3bc2c68`
(committed 2026-11-10 03:51 UTC); its paths below are relative to its
repository root. Nothing was built or run for this document: the launcher was
cloned into private scratch and read as text, and our code was read without
starting it.

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

- **A.** Recommend linking the launcher as an unofficial community project
  and publishing a short launcher contract on our side (A1 below). Adopting
  its code would make us own a Swift app, a C# and PowerShell launcher,
  Apple signing and notarization, Windows signing and Windows testing. The
  launcher would also open a Delegatus that on native Windows has no Codex and
  no managed accounts, which defeats point B1 on that platform. Its value to
  a newcomer stops where our setup guide starts, so B does not depend on A.
- **B.** The setup guide already carries most of the six points. The design
  moves the optional Telegram step out of the way, makes sign-in the main
  action until an engine is connected, offers the existing memory switch right
  after sign-in, adds one advice line for Codex-only installs, and makes the
  first message's placeholder say that sending it starts an agent. No new
  screen is needed. Two defects found while reading: a newcomer's memory
  import may wait forever for an orchestrator seat in a project the newcomer
  never opens (§3.6, to be confirmed in slice 0), and on a Claude-only install
  the first request that becomes a pipeline is refused because Builder and
  Reviewer default to Codex, while the guide promises a "next step" that no
  longer follows (§3.5).
- Five questions remain for the operator (§7).

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
| `docs/design/memory-source-switch.md` | One memory per install; turning on Delegatus memory imports Claude and Codex notes once through the curator | Point B2 |
| `docs/design/install-memory-transfer.md` (#3195, #3233) | `delegatus export` / `import`; only Delegatus memory travels; engine memory is imported once on the new install | Relation to task c2c481e5 |
| `docs/design/onboarding-diagnostics.md` (#3295) | `delegatus doctor` and `GET /api/onboarding/diagnostics` shipped 2026-10-25 | Launcher contract, relation to task 8cf753fd |
| `docs/design/windows-support.md` (#1201) and `docs/guide/getting-started.md:66-69` | Native Windows runs Claude Code only; Codex, managed accounts, the MCP server, dictation and `--tailscale` are missing | Part A Windows assessment |
| `docs/macos-newcomer.md` | The agent CLI resolver and the install prompt on macOS | Part A macOS assessment |
| `docs/verification/fresh-install-startup.md` | `delegatus-cli@1.13.0` failed its first start on a clean install under Bun 1.4.0 and 1.4.3 | Version-pin risk |
| Seat conversation, 2026-10-15 (paraphrased) | A Windows app shell (Tauri or Electron) is the layer after the backend starts natively and stably; wrapping a backend that does not start first gains nothing | Part A recommendation |
| Board tasks e6a358dc, 8cf753fd, c2c481e5 | Six setup-guide scenarios; diagnostics and doctor; moving memory and settings | §5 |

## 3. Observed facts

### 3.1 The community launcher (read at `b2cc436e`)

Repository: 5 commits between 2026-11-08 and 2026-11-10; MIT licence
(`LICENSE`), copyright "Delegatus Community Launcher contributors"; the
Delegatus icon is credited to our MIT project (`THIRD_PARTY_NOTICES.txt`).
It contains sources, build scripts, guides and a prebuilt Windows launcher
(`Windows/Delegatus.exe`, 16 384 bytes; its SHA-256 `ea5f6b74…72bf` matches
the repository's own `Windows/SHA256SUMS.txt`). The macOS app is not in the
repository; its README says a ready-made archive is "distributed separately".

| Aspect | macOS | Windows | Source |
|---|---|---|---|
| Form | AppKit app, universal arm64 + x86_64, macOS 13+, bundle id `org.delegatus.community-launcher` | `Delegatus.exe` (C#, .NET Framework 4.7.2) runs `Resources/Launch-Delegatus.ps1` in Windows PowerShell 5.1; `Start Delegatus.cmd` is a console fallback | `Source/build.sh:11-16,23,27,33`, `Source/WindowsLauncher.cs:24-53`, `Windows/Start Delegatus.cmd` |
| Window | Its own WKWebView window with back, forward, reload, controls and log buttons | An Edge or Chrome `--app=` window with a private `--user-data-dir` profile; default browser after confirmation if neither is found | `Source/Launcher.swift:272-300`, `Launch-Delegatus.ps1:570-587` |
| What it installs, after an explicit confirmation | Bun 1.4.3 from the official release, archive SHA-256 checked, then `delegatus-cli@1.11.0` with `bun install` into a private folder; the publish step is transactional | Bun 1.4.3 (x64 baseline or arm64, SHA-256 checked), then `bun add --exact delegatus-cli@1.11.0` into a private folder with a completion receipt | `Source/setup-runtime.sh:61-107`, `Launch-Delegatus.ps1:313-363`, `Resources/Runtime-manifest.json` |
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
   server. Not confirmed; our loopback `GET /` was not exercised.
5. **The user's `DELEGATUS_*` and `LLV_*` settings never reach a server the
   launcher starts**, and the Mac launcher forces Ukrainian CLI output
   (`bin/cli.mjs:70-76` reads `LLV_LANG`).

### 3.3 How Delegatus is installed today

| Path | What happens | Source |
|---|---|---|
| Package | `delegatus-cli` 2.0.0; commands `delegatus`, `dlg`, `delegatus-mcp`; `engines.bun >=1.4.0`; `os` linux, darwin, win32 | `package.json:2-28` |
| Run once | `bunx delegatus-cli`; installed command `bun add -g delegatus-cli` | `README.md:42-62`, `docs/guide/getting-started.md:77-104` |
| Install prompt | The website's prompt for Claude Code or Codex installs Bun, the agent CLI, the package, starts it with `--no-open` and registers the MCP server; on native Windows it stops at step one and asks for WSL 2 | `landing/site/copy.js`, `scripts/newcomer-install.mjs`, `docs/guide/getting-started.md:105-127` |
| From a clone | `bun install`, `bun run build`, `bun bin/cli.mjs` | `README.md:69-80` |
| Docker | `ghcr.io/latand/delegatus` for linux amd64 and arm64 | `README.md:86-99`, `docs/docker.md` |
| CLI | Port 8898, host 127.0.0.1, `--no-open`, `--tailscale`; `doctor`, `stop`, `team`, `export`, `import` | `bin/cli.mjs:47-48,85-97,1151-1177,1871-1876` |
| Self-update | Update dialog builds or downloads a release into the user's cache and relaunches; release pointer per install id | `bin/cli.mjs:1660-1667`, `docs/guide/operations.md:8-28`, `docs/design/self-update-every-install.md` |
| Start output | With neither agent CLI found, it prints install commands for Claude Code and Codex and points to the setup guide | `bin/agent-binaries.mjs:48-49` |
| Platforms | Linux main, macOS works, native Windows runs Claude Code only | `docs/guide/getting-started.md:47-69` |

There is no web app manifest: `/manifest.webmanifest` is exempted by the team
gate (`src/lib/team/gate.ts:40`) but no route serves it.

### 3.4 What the first run shows

| Fact | Source |
|---|---|
| The guide opens by itself when the per-install marker `onboarding.json` was never decided, or when a guide was left in the middle; an install that already holds seats, pipelines, tasks or role overrides is marked `existing-install` and never opens it | `src/app/api/onboarding/route.ts:16-34`, `src/lib/onboarding/marker.ts:41`, `src/components/onboarding/useOnboarding.ts:32-34,147-154` |
| Numbered steps: Engines, Project, Telegram (optional), Orchestrator; "Later, any time": Agents, Phone, Voice, Check, Relay | `src/lib/onboarding/steps.ts:15-17` |
| Nothing is gated: every step closes with Escape, ✕ or "Close, finish later"; reopened from the menu row "Setup guide" | `src/components/onboarding/OnboardingDialog.tsx:29-38`, `en.ts:6443` |
| Old `agent-log-viewer` state in use shows a notice with clean-start steps | `OnboardingDialog.tsx:168-174`, `src/lib/onboarding/legacyState.ts:10-23` |
| Phone: the same guide as a full-screen sheet with a step list in the header and footer buttons | `OnboardingDialog.tsx:476` onward |
| After the seat goes live, a three-stop interface walk: the seat composer, the board, "Needs you"; the last button is "Give it the first task" | `src/components/onboarding/OnboardingWalk.tsx:14-29,360`, `en.ts:6513-6525` |

### 3.5 How Claude and Codex accounts are detected and signed in

| Fact | Source |
|---|---|
| Engines step: one card per engine with the accounts screen's own rows; Copilot beside them; "Check again" | `src/components/onboarding/EnginesStep.tsx:13-22,106` |
| CLI presence from `GET /api/accounts` and `GET /api/accounts/cli` (a `--version` probe) | `OnboardingDialog.tsx:88-109` |
| "Connected" means the CLI is found and an account holds a credential | `EnginesStep.tsx:28-41` |
| Claude sign-in runs `claude auth login --claudeai` and takes the pasted code | `src/lib/accounts/claudeLogin.ts:468`, `src/app/api/accounts/claude/login/[operationId]/input/route.ts` |
| Codex sign-in is the ChatGPT device code through `codex app-server` | `src/lib/accounts/codexAppServer.ts:374-378` |
| Agents use their own Claude configuration, so a second sign-in is expected; the card says so | `EnginesStep.tsx:98`, `en.ts:6494` |
| One engine only, or neither: one line each. The one-engine line says roles that default to the other engine "need a new home, which the next step handles"; the next numbered step is Project, and the role move lives in the Agents step under "Later" | `EnginesStep.tsx:177-178`, `en.ts:6540-6541`, `steps.ts:15-17` |
| Builder and Reviewer default to Codex GPT-6.1-Sol, so a Claude-only install has its first pipeline refused before any stage starts until roles move; the Agents table offers "Move them to {connected}" | `src/lib/roles/defaults.ts:261-292`, `docs/guide/getting-started.md:296-305`, `src/components/onboarding/AgentMappingTable.tsx:452-495`, `en.ts:6581` |
| Delegatus does not install agent CLIs; it tells the user what to run | `en.ts:6533-6535`, `bin/agent-binaries.mjs:48-49` |

### 3.6 What memory import exists

| Fact | Source |
|---|---|
| Settings row "Delegatus memory": off by default ("unchosen"); turning it on imports Claude and Codex notes through the curator, then switches the engines' own memory off | `src/components/memory/MemorySourceRow.tsx:10-27`, `src/components/settings/SettingsWindow.tsx:140`, `en.ts:116-135` |
| The first choice must be Delegatus memory | `src/lib/memory/source.ts:88-91` |
| `PUT /api/memory/source` needs operator authority and starts the import | `src/app/api/memory/source/route.ts:25-42` |
| Sources: `~/.claude/projects/*/memory` and `~/.codex/memories`, plus every managed account home under the state directory's `accounts/` | `src/lib/memory/importWork.ts:41-47,136-142` |
| Curation passes wait while learned rules, seat wakes or the curator are off, or during an update or deployment | `src/lib/memory/curation/admission.ts:29-38` |
| A curation pass also needs a designated, live orchestrator seat in its project | `admission.ts:47-56,116-133` |
| A note whose project has a live seat is curated there; every other note goes to the import's host project, which is the Delegatus repository's own project key | `importWork.ts:428-437`, `src/lib/projects/viewerRepository.ts:18-27` |
| Between installs: `delegatus export` / `delegatus import` carry Delegatus memory and settings; accounts arrive signed out | `bin/transfer.mjs`, `docs/guide/operations.md:83-101` |

Inferred from the code alone, without a run: on a newcomer's install the Delegatus repository is
usually no project at all, so the host project has no seat and every note not
tied to a seated project waits on "no designated seat". The Settings row's
admission reasons name memory, wakes, curator, update and deployment
(`en.ts:128-133`); none names a missing seat, so the row would say
"Importing … 0 of N" with no reason. Slice 0 measures this.

### 3.7 The first orchestrator: how it is created, what it says, what it runs on

| Fact | Source |
|---|---|
| The Orchestrator step explains in three lines and a schematic, names the project and "Runs on" with Change, and owns "Create the orchestrator" | `src/components/onboarding/OrchestratorStep.tsx:19-29,214-270`, `en.ts:6489-6492` |
| Create hands the project's own create draft a request with `confirm`; the draft presses its own Confirm, so the one designation path stays the draft's | `OrchestratorStep.tsx:25-28`, `src/components/orchestrator/draftPrefill.ts:8-19`, `OnboardingDialog.tsx:320-324` |
| Role default: Claude, `opus`, effort high | `src/lib/roles/defaults.ts:234-237` |
| Runtime choice: the role's engine when connected; otherwise the connected engine with its default model at high; Codex's default model is `gpt-6.1-sol` | `OrchestratorStep.tsx:56-62`, `src/lib/agent/models.ts:18,149-151` |
| For a newcomer: an API cost estimate, and "Use cheaper Codex · GPT-6.1-Sol" when Claude is chosen and Codex is connected | `OrchestratorStep.tsx:124-135,262-267`, `en.ts:6496-6498` |
| A line on permissions and a line on the plan and the wake interval (5 minutes by default) | `OrchestratorStep.tsx:259-261`, `OnboardingDialog.tsx:86`, `en.ts:6495,6499` |
| Blocking states: no project, no engine, a seat already held, the chosen account signed out | `OrchestratorStep.tsx:162-193` |
| First turn of a fresh seat: two lines, "Ready in {project}." and "Tell me what you want done here. I'll turn it into tasks on the board, have agents build and review it, keep it moving and report back. New work starts when you ask; I'll suggest what could come next." | `src/lib/orchestrator/prompt.ts:133,146-150` |
| The seat composer's placeholder: "what should get done in {project}?" | `src/components/orchestrator/OrchestratorConversation.tsx:86`, `en.ts:1470` |
| A failed create shows "Try again" on the draft's Confirm | `src/components/orchestrator/OrchestratorPanel.tsx:1289` |

### 3.8 What I could not confirm, and where I looked

| Question | Where I looked | Status |
|---|---|---|
| Does any Mac or Windows build of the launcher start under Gatekeeper or SmartScreen | Its READMEs and validation files | Not run, by the fence; the author reports the risk |
| Does a self-update started inside a launcher-run 1.11.0 finish without a terminal | `docs/guide/operations.md:15-28`, `bin/cli.mjs:1660-1700` | Unknown; needs a run (slice 0) |
| Does our loopback `GET /` answer 200 with a same-origin script on a solo and on a team install | `src/lib/team/gate.ts` (exemptions only) | Unknown; needs a run |
| Is `gpt-6.1-sol` offered to every Codex plan a newcomer may hold | `src/lib/agent/models.ts`, `src/app/api/accounts/codex/models/route.ts` | Unknown; the catalogue is per account |
| Does the memory import stall on a newcomer install (§3.6) | Code above | Inferred from code only |
| How the Engines step behaves on native Windows, where managed accounts are missing | `docs/guide/getting-started.md:66-69` | Not exercised |
| Whether browsers offer "install as app" for `http://127.0.0.1:8898` once a manifest exists | Nothing in this repository | Not checked |

## 4. Part A: options for the launcher

Cost is in agent lanes and owned surfaces; money for certificates and
memberships was not checked and is left out.

| # | Option | What the user gets | What we own afterwards | Cost | Risk | Needs from the author |
|---|---|---|---|---|---|---|
| A1 | **Link it as a community project**, labelled unofficial, with its own stated limits, and publish a short launcher contract on our side: the start arguments, a readiness check, the stop behaviour that is safe, `delegatus doctor --json`, and "install the current release" | Mac users who avoid a terminal get an app icon and a window today; everyone else is unchanged | One docs row and one contract section; answering issues that turn out to be launcher issues | One small docs lane | We point at unsigned binaries and a 1.11.0 pin; mitigated by the label and by the contract asking for the current release | Nothing required; tracking the contract is their choice |
| A2 | **Adopt it into this repository as the official launcher** | An official Mac app and Windows launcher | Swift, C#, PowerShell code beside a TypeScript project; macOS and Windows build jobs; Developer ID signing and notarization; Authenticode signing; a version pin that follows every release; Windows GUI testing we have no runner for; both interfaces in en and uk; support | Several lanes plus recurring signing and release work; a prebuilt `Delegatus.exe` cannot enter our tree as is, so CI must build it | High on Windows: native Delegatus there has no Codex and no managed accounts, so B1 and B6 fail on the launcher's main promise; bundle id `org.delegatus.*` already used by the community build | Nothing legally (MIT keeps the notice); a courtesy agreement on the name and bundle id |
| A3 | **Build a first-party launcher informed by it**, smallest first: a web app manifest so Chrome and Edge can install the running Viewer as its own window with our icon, then (later, macOS first) a signed app that starts `delegatus` and shows the same window | A window and an icon from any OS without new native code; later a signed Mac app | A manifest route; later one native app with signing | One small lane for the manifest; a large lane for a signed app | Low for the manifest; the signed app carries A2's signing load for one platform | Nothing |
| A4 | **Do nothing** | Unchanged | Nothing | None | Users find the launcher anyway and meet the 1.11.0 pin with no guidance from us | Nothing |

**Recommendation: A1**, with A3's manifest as a candidate for a later slice.
A1 serves the operator's "build it in" at the boundary where the two tools
meet, which is the start command and the readiness check, and costs one docs
lane. A2 makes us own two native stacks and two signing chains before the
Windows backend can carry the onboarding the operator asked for; the
2026-10-15 seat analysis reached the same order for any app shell. A3's
manifest gives the "own window and icon" part for free once it is checked in
a browser (§3.8, last row), and stays deferred until the operator asks for it.

What the launcher contract states (for A1), each a fact our code already has:

| Item | Value | Source |
|---|---|---|
| Start | `delegatus --port <n> --hostname 127.0.0.1 --no-open` | `bin/cli.mjs:85-97` |
| Readiness | `GET /` answers 200 (the contract slice confirms this on a solo and a team install) | §3.8 |
| Diagnostics | `delegatus doctor --json`, exit 0, 1 or 2 | `docs/design/onboarding-diagnostics.md` |
| Stop | SIGTERM or SIGINT to the CLI runs our shutdown of the Viewer and the runtime host it started; `delegatus stop --all` also stops every agent; a forced tree kill skips both. Whether either signal path works the same on native Windows was not checked | `bin/cli.mjs:100,1059-1086` |
| Version | Install `delegatus-cli@latest`, or the newest tag; updates come from the Update dialog | `docs/guide/operations.md:8-28` |
| Bun | 1.4.0 is the verified pin | `Dockerfile:6` |

## 5. Part B: the first run

### 5.1 The flow, step by step

The guide keeps its shape (Engines → Project → Orchestrator, then the walk).
Telegram moves from the numbered steps to "Later, any time", where Phone and
Voice already are, so nothing optional stands between the user and the
orchestrator.

| # | Requirement point | Existing screen or control | Change | New chrome? |
|---|---|---|---|---|
| 1 | B1 account first | Engines step cards with sign-in rows (`EnginesStep.tsx`) | Until Claude or Codex is connected, the footer's filled button is the sign-in of the engine whose CLI is present; Continue becomes the bordered "Continue without an agent" (Q5). The lead gains one clause: the next steps create the agent you give work to | None; the footer already switches which button is filled (`OnboardingDialog.tsx` `stepOwnsPrimary`) |
| 1b | B5 holds only if the first request can run | The one-engine line (`en.ts:6540`) and the Agents table's "Move them to {connected}" (`AgentMappingTable.tsx:457-482`) | With exactly one engine connected, the one-engine line carries the table's own move action, so the roles the first pipeline needs sit on the connected engine before the orchestrator exists. Its text stops promising a "next step" | None; the move handler and its button are reused |
| 2 | B2 memory import | Settings row "Delegatus memory" (`MemorySourceRow`) | The same row renders under the engine cards once an engine is connected, with the number of notes found, and says the import starts after the orchestrator is running (Q3) | None; the row is reused as is. One server read counts notes |
| 3 | B3 teach the orchestrator first | Orchestrator step's three lines and schematic; walk stop 1 | Unchanged text; Telegram leaves the numbered steps, so the orchestrator is step 3 of 3 | None |
| 4 | B4 create it for the user | "Create the orchestrator" (`OrchestratorStep.tsx:195-200`) with the draft's confirm | Arrives with project, engine, model and account already chosen; one press (Q2) | None |
| 5 | B5 ask what to do, explain it starts an agent | The fresh seat's greeting (`prompt.ts:146-150`); the seat composer placeholder (`en.ts:1470`); walk stop 1 | The placeholder on a seat with no missions reads "What should it do in {project}? Sending this starts an agent on your {engine} plan." The greeting's offer line adds that each request starts agents on the user's plan (a new mandate version, using the existing `SHIPPED_GREETING_OFFERS` replacement) | None |
| 6 | B6 engine choice | `orchestratorRuntime` (`OrchestratorStep.tsx:56-62`); the newcomer cost lines | Codex only: a line under "Runs on" says Claude is recommended for the orchestrator and that this one runs on Codex GPT-6.1-Sol, with "Connect Claude" going to Engines (the step's existing go-to pattern). Both connected: Claude stays the default; the cheaper-Codex link is decided by Q4 | None |

Only one server change sits on the critical path: the note count for step 2.
The host-project fix for the import (§3.6) is a server change too, gated by
slice 0's measurement.

### 5.2 By sign-in situation

| Situation | Step 1 | Step 2 | Step 3 | After create |
|---|---|---|---|---|
| Claude only | Claude card connected; Codex card says "Not installed" or signed out; the one-engine line moves Builder, Reviewer and the other Codex roles to Claude | Memory row offered when Claude notes exist | Runs on Claude · Opus · high; cost line; no Codex link | Seat greets; placeholder names the Claude plan; the first pipeline can start |
| Codex only | Codex card connected; filled button stays Continue; the one-engine line moves the Claude-default roles to Codex | Memory row offered when Codex notes exist | Runs on Codex · GPT-6.1-Sol · high; the advice line recommends Claude with "Connect Claude" | Placeholder names the Codex plan |
| Both | Both connected | Memory row covers both | Claude default; Q4 decides the cheaper link | As Claude only |
| Neither | Filled button is sign-in for the engine whose CLI is present; with no CLI at all, each card shows its install command and "Check again" | Row hidden (nothing to import yet) | Existing "Connect Claude or Codex first" with "Go to Engines" | No seat; the guide reopens from the menu |

### 5.3 Failure at each step and the way back

| Step | Failure | What the user sees | Way back |
|---|---|---|---|
| 1 | CLI missing | The card's install line and "Check again" (`en.ts:6533-6538`) | Install, then Check again; or close and reopen from "Setup guide" |
| 1 | Sign-in fails or times out | The account row's own error (shared with the accounts screen) | Retry from the same row |
| 2 | Import write refused | The row's "The change was not saved; the switch is back." (`en.ts:119`) | The guide continues; Settings keeps the row |
| 2 | Import held | The row's admission reason; plus "waits for the orchestrator" once slice 0 confirms the seat hold | Settings → Delegatus memory; undo exists (`en.ts:134-135`) |
| 3 | Chosen account signed out | Existing warning and "Sign in to {engine} first" | Goes to Engines |
| 4 | Orchestrator launch fails | The guide has closed; the project's seat draft shows the failure and "Try again" (`OrchestratorPanel.tsx:1289`) | Try again there, or reopen the guide: the step offers "Open it" when a seat exists |
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
| Memory row | Row under the cards | The row's existing `phone` layout (`SettingsWindow.tsx:140`) |
| Advice line (Codex only) | Under "Runs on" | Wraps under "Runs on"; "Connect Claude" at 44 px |
| Placeholder | Seat composer | Phone seat composer; walk stop 1 anchors the phone's board dock (`OnboardingWalk.tsx:26`) |

The prototype (slice 1) renders each state in en and uk, light and dark, at
1440 px, 390 px and one width between, and measures that no line is cut.

## 6. How this relates to the three board tasks

| Task | What it owns | Overlap with this design | Rule |
|---|---|---|---|
| e6a358dc: setup guide, six scenarios | Verifying old-state disclosure, the isolated Claude sign-in line, project search and no preselection, newcomer cost choice, the Haiku alias, the permissions line | Steps 1 and 3 touch the cards and lines it verifies | Its six checks stay with it. This design's build slice must keep them green. Q4 settles the direction of its "newcomer cost choice" check, because the operator's 2026-11-10 request prefers Claude while the cheaper link pushes toward Codex |
| 8cf753fd: shared diagnostics and doctor | A read-only registry for CLI and onboarding | Its first slice shipped as #3295 on 2026-10-25 (`bin/doctor-command.mjs`, `GET /api/onboarding/diagnostics`); the task's note that no doctor command exists is out of date. No UI reads the route yet | The launcher contract (A1) points launchers at `delegatus doctor --json`. A diagnostics surface in the guide stays with that task |
| c2c481e5: memory and settings into a new install | `delegatus export` / `import` of Delegatus memory and settings (#3195, #3233), open items for orchestrator drafts and reverse transfer | Step 2 is the one-time engine-memory import that its decision names as the way engine memory enters Delegatus | Step 2 adds no bundle import. Offering a transfer bundle in the guide is deferred |

## 7. Questions for the operator

Each has exactly one recommended answer.

**Q1. What should we do with the community launcher?**
- a) Link it in our docs as an unofficial community project with its stated limits, and publish a short launcher contract on our side (start command, readiness, safe stop, doctor, current release). **Recommended.**
- b) Adopt its code into this repository as the official launcher, with signing and Windows testing on us.
- c) Build our own launcher informed by it, starting with an installable web app window.
- d) Do nothing.

**Q2. How should the first orchestrator be created?**
- a) One press: the Orchestrator step arrives with project, engine, model and account chosen, and "Create the orchestrator" starts it. **Recommended.**
- b) No press: it starts by itself as soon as an account and a project exist, and the step shows it running with Change.
- c) Keep today's order, with the optional Telegram step before it.

**Q3. How should the first run offer memory import from Claude and Codex?**
- a) Right after sign-in, switched on when notes are found, with their count; it runs once the orchestrator is up. **Recommended.**
- b) Right after sign-in, switched off; the user turns it on.
- c) Only in Settings, as today.

**Q4. When both Claude and Codex are connected, what does a newcomer see on the Orchestrator step?**
- a) Claude by default with the cost line, and no "Use cheaper Codex · GPT-6.1-Sol" link. **Recommended.**
- b) Claude by default with the cost line and the cheaper Codex link, as today.

**Q5. How strictly should the guide insist on an account first?**
- a) Softly: until Claude or Codex is signed in, the main button is sign-in and the way forward is a secondary "Continue without an agent". **Recommended.**
- b) Strictly: the guide does not move past Engines until Claude or Codex is signed in.

## 8. Slices

| Slice | Content | Needs before it starts | Output |
|---|---|---|---|
| 0. Measure | On an isolated install (private HOME, XDG dirs, TMPDIR, `LLV_STATE_DIR`, control URL on a closed port): (i) a newcomer memory import with notes under a project that is not the Delegatus repository: does curation wait on "no designated seat"; (ii) a Codex-only account: is `gpt-6.1-sol` in its catalogue, and what the step does when it is missing; (iii) our CLI started with the launcher's arguments under Bun 1.4.0 and 1.4.3: `GET /` answer on a solo and a team install, SIGTERM shutdown, and an Update from 1.11.0 | Nothing | A verification note with commands and outputs |
| 1. Prototype | Numbered variants on the real guide components for the answers to Q2–Q5: Engines with the filled sign-in and the memory row; Orchestrator with the Codex advice line and with or without the cheaper link; the first-message placeholder. en and uk, light and dark, 1440, 900 and 390 px | Operator answers to Q2–Q5; slice 0 result (i) for the row's wording | Frames under the evidence directory; critic, fix, publish as a decision form |
| 2. Guide build | Telegram to "Later"; the filled sign-in; the role move on the one-engine line; the memory row in step 1; the Codex advice line; Q4's choice; the placeholder; the greeting line as a new mandate version | The chosen prototype variant | One PR with dom tests per state and the board driver's frames |
| 3. Import host | The import's host project becomes the newcomer's first seated project, and the row names the wait for a seat; plus the note-count read | Slice 0 confirms (i) | One PR with a test that fails on the current code |
| 4. Launcher contract | Q1's answer: for (a), a "Community launchers" row in `docs/guide/getting-started.md` and the contract table in `docs/guide/configuration.md`, with the launcher described by kind | Q1 answer; slice 0 result (iii) | One docs PR |

The first buildable slice is slice 0: it needs no answer and decides the
wording of slice 1 and whether slice 3 exists. No UI is built before the
slice 1 prototype has passed its critic and the operator has chosen a variant.

## 9. Deferred — not currently justified

- **Adopting the launcher's Swift, C# and PowerShell code** (A2). Revisit when
  native Windows runs Codex and managed accounts and the project accepts
  signing and notarization as standing work.
- **A Windows launcher of our own.** Blocked by the same Windows gaps.
- **An installable web app window** (A3's manifest). Cheap; waits for the
  operator to ask for it and for a browser check on `127.0.0.1`.
- **A signed macOS app of our own.** Waits for A3's manifest to prove
  insufficient.
- **A text field in the guide for the first request.** The seat composer
  already asks; a field would duplicate it.
- **Installing Claude Code or Codex from inside Delegatus.** The cards show
  the commands; running third-party installers from the Viewer is a new trust
  boundary nobody has asked for.
- **Offering a transfer bundle import in the guide.** Stays with c2c481e5 and
  the CLI.
- **Starting Delegatus at login on macOS and Windows.** Not in the request.

## 10. Check against the requirement

| Point in the request | Where it is answered |
|---|---|
| Can the launcher be built in, and how | §4, Q1, slice 4 |
| Convenient installation | §3.3 inventory; A1 contract; A3 deferred with its trigger |
| Account first | §5.1 step 1, Q5 |
| Memory import from that account | §5.1 step 2, §3.6 defect, Q3, slices 0 and 3 |
| Teach that work starts with the orchestrator | §5.1 step 3 |
| Possibly create it for the user | §5.1 step 4, Q2 |
| Ask what to do and explain that it starts an agent | §5.1 steps 1b and 5 |
| Claude preferred; Codex only runs on GPT-6.1-Sol with advice | §3.7 (already runs on GPT-6.1-Sol), §5.1 step 6, Q4 |
