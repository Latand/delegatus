# Delegatus for Mac: a real app — design

## Reopening the app

Open Delegatus again to return to the server left running when the app quit.
The window reuses that process, including an installed version older or newer
than the app's bundle. Reopening performs no server restart or installation.
If the verified server cannot pass automatic readiness, choose **Open existing**
(**Відкрити наявний**) beside Try Again and Open Logs. A missing or refused
saved key opens a fresh web session where the page can ask for its key.

## Originating requirement

On 2026-11-12 the operator asked again for a Mac launcher. A Mac has no
`delegatus` command until something installs one, so the terminal steps in
the Quick start do not work for a Mac user who never opens a terminal. On
2026-11-10 the operator had pointed at a public, MIT-licensed community
launcher (a Swift macOS app) and asked whether it could be built in. Source:
the operator's conversation with the project orchestrator on those dates, and
the pinned task specification "Delegatus launcher for Mac: a real app, no
terminal".

The pinned specification asks for:

1. a native `Delegatus.app` for Apple Silicon and Intel, downloadable as a
   `.dmg` or `.zip` from this repository's GitHub releases: download, drag to
   Applications, double-click, and Delegatus opens in its own window with its
   icon;
2. a first run that checks for Bun and Delegatus and, after one confirmation,
   installs them privately for the user, with no `sudo` and no shell-profile
   edits, then starts Delegatus and shows it;
3. later runs that reuse a healthy Delegatus on its port or start one;
4. controls for start at login, stop, update to the published release, open
   logs, and a clear message for a busy port;
5. no installation of, or sign-in to, Claude Code or Codex: Delegatus's own
   setup guide does that;
6. a UI language that follows the system (English and Ukrainian);
7. reuse of the community launcher's code where useful, with its license
   notice kept;
8. a build on the macOS CI runners, a CI smoke test that installs the app
   into a fresh user, launches it and gets HTTP 200 from Delegatus, and
   attachment of the artifact to releases through the existing publish
   workflow (the smoke meets "a fresh user" with fresh data in the runner's own
   session; §7 says why);
9. ad-hoc signing, with the README and the guide saying how to open an
   unsigned app, and the PR saying what an Apple Developer account would add;
10. a README Quick start that points a Mac user at the app first, and public
    text that names no people or accounts.

This requirement supersedes the 2026-11-11 answer V1 a in
`docs/design/install-and-onboarding-second-view.md` ("the launcher's code is
not adopted"): a native app is now required.

## Decisions

1. **One window, one Swift executable.** `Delegatus.app` is AppKit plus a
   `WKWebView`. A native status view covers install, start and errors; it
   gives way to the web view once Delegatus answers. The source lives in
   `macos/`; it is built with `swiftc` and `lipo`, with no Xcode project.
2. **The app drives the product's existing commands and adds no new server
   mechanism.** It starts `bun <cli.mjs> --no-open --port 8898`, stops with
   `stop --all`, toggles start at login with `service install` and
   `service remove`, and opens the product's own Update dialog. `bin/cli.mjs`
   needs no change.
3. **The private install has one fixed path for its whole life.** The package
   root's path names the install identity, so it never moves (§2, Publish).
4. **The health rule is the product's own probe.** The app sends
   `HEAD /api/onboarding/diagnostics` and expects `204` with
   `x-delegatus-diagnostics: 1`, which is what `delegatus doctor` uses. A
   `401` or `403` is retried once with the access key from the key file (§4).
5. **The app never stops a process it finds on the port.** A busy port gets a
   message that names the listener and offers Try Again and Open Logs. A verified
   Delegatus also offers Open existing when automatic attachment cannot finish.
6. **Quitting the app leaves Delegatus running** after one question, so that
   agents can finish their work. Stop is a separate menu command.
7. **Releases ship one universal `.dmg`, ad-hoc signed.** A reusable workflow
   builds and smoke-tests it; `publish.yml` calls that workflow after the npm
   publication and uploads the `.dmg` to the GitHub Release.

## What the code says today

| Fact | Evidence |
| --- | --- |
| The CLI takes `--port`, `--hostname` and `--no-open`; its default port is 8898; its readiness ceiling is 90 s. | `bin/cli.mjs:47-49`, `parseArgs` at `374-421` |
| `stop --all` stops every recorded launcher on the state directory, its Viewer and runtime host, and every recorded agent host, each by recorded identity. It starts nothing. | `bin/cli.mjs:1168-1176`, `bin/stop-all.mjs:1-30` |
| A launcher that receives SIGTERM stops its children and exits 0. | `bin/cli.mjs:1073-1092` |
| `service install [--port n]` writes `~/Library/LaunchAgents/org.delegatus.server.plist` with `RunAtLoad`, `KeepAlive {SuccessfulExit: false}` and the log `~/Library/Logs/Delegatus/server.log`. It starts the job when nothing else runs. `service remove` boots it out and deletes the plist. | `bin/login-service.mjs:55-60`, `217`, `250-275`; `bin/service-manager.mjs:4` |
| `service install` refuses a root under the temp directory, a `bunx` cache, a `self-update/…/releases/` directory, a git checkout, and a root without `dist/standalone/server.js` and `dist/runtime-host.mjs`. | `bin/login-service.mjs:171-177` |
| The install identity `installId` is a hash of the package root's path. It names the launcher record, the release pointer, the runtime-host socket and lock, and the `runtime-events-<id>.sqlite` journal. | `bin/server-runtime.mjs:198-208`, `238-239`; `bin/cli.mjs:1673-1676` |
| A packaged install already updates from the Update dialog. The runner verifies the npm provenance, runs `bun add --exact` on the verified tarball under the self-update releases directory, writes the release pointer, and relaunches. | `src/lib/selfUpdate/package.ts:72-110`; `docs/design/self-update-every-install.md` decision 6 |
| The Update dialog opens on the window event `llv:open-self-update`. | `src/components/selfUpdate/openSelfUpdate.ts:4-9`, `SelfUpdateDialog.tsx:282` |
| `HEAD /api/onboarding/diagnostics` answers `204` with `x-delegatus-diagnostics: 1`. `delegatus doctor` reads `401` and `403` as `auth-required`. | `src/app/api/onboarding/diagnostics/route.ts:28-33`; `bin/doctor.mjs:46-66` |
| With `LLV_TOKEN` set, every request needs the key (cookie, `Bearer` header or `?k=`), loopback included. Without it, `/api/*` answers 403 and pages answer a 403 text. The key turns on after the setup guide's Phone step or a links grant, and lives in `<config>/delegatus/token`. | `src/proxy.ts:105-146`, `42-55`; `bin/viewerGateKey.mjs:57-76` |
| The web UI picks its language from a saved choice, otherwise from `navigator.language`. The CLI picks its language from `LLV_LANG`, otherwise from `LC_ALL` or `LANG`. | `src/components/BootShell.tsx:84`, `src/lib/i18n/index.ts:26`; `bin/cli.mjs:72-77` |
| The Bun pin is 1.4.0 in the `Dockerfile`; the macOS jobs read it with one `sed`. | `Dockerfile:6`; `.github/workflows/macos-identity.yml` "resolve the image pin" step |
| `publish.yml` creates the GitHub Release, publishes to npm on `ubuntu-latest`, verifies registry visibility and records a release receipt. | `.github/workflows/publish.yml:91-145`, `147-538` |
| `macos-newcomer.yml` already rehearses a clean first start on `macos-latest` from a checkout tarball or the exact npm release. | `.github/workflows/macos-newcomer.yml`; `scripts/newcomer-install.mjs` |
| Delegatus finds `claude` and `codex` in `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, the Codex app bundle and `PATH`. | `bin/agent-binaries.mjs:7-25` |

The community launcher was read at commit `a7b0eaf` of its public repository
(`Source/Launcher.swift`, `Source/Core.swift`, `Source/setup-runtime.sh`,
`Source/build.sh`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`).

## 1. App structure

```
macos/
  Sources/
    App.swift            entry point, menus, window, state machine
    Install.swift        install discovery, first-run setup process
    Server.swift         probe, start, stop, start at login, port owner
    WebView.swift        WKWebView delegates (adapted from the community launcher)
    Evidence.swift       --evidence-dir frames and STATE log lines
  Tests/CoreChecks.swift probe classification, discovery order, versions
  Resources/
    en.lproj/Localizable.strings, InfoPlist.strings
    uk.lproj/Localizable.strings, InfoPlist.strings
    setup-runtime.sh     private install (adapted from the community launcher)
  Info.plist.in
  THIRD_PARTY_NOTICES.txt
scripts/mac-app/
  build.sh               compile, bundle, sign, .dmg
  manifest.ts            runtime-manifest.json (Bun pin, digests, package)
  icon.ts                AppIcon.icns from public/brand/delegatus-touch-icon.svg
  smoke.mjs              the CI smoke driver (§7)
.github/workflows/macos-app.yml
```

Bundle: `Contents/MacOS/Delegatus` (universal arm64 and x86_64),
`Contents/Info.plist` (identifier `org.delegatus.app`, version equal to
`package.json`, `LSMinimumSystemVersion` 13.0, `CFBundleDevelopmentRegion`
`en`, `CFBundleLocalizations` `en` and `uk`, `NSMicrophoneUsageDescription`,
and `DelegatusReleaseRepository` filled from `$GITHUB_REPOSITORY` at build
time), `Contents/Resources/` (`AppIcon.icns`, both `.lproj` folders,
`setup-runtime.sh`, `runtime-manifest.json`, Delegatus `LICENSE`,
`THIRD_PARTY_NOTICES.txt`).

`runtime-manifest.json` holds everything the first run installs:

```json
{ "port": 8898,
  "bun": { "version": "1.4.0",
    "arm64":  { "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip", "sha256": "…" },
    "x86_64": { "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-x64-baseline.zip", "sha256": "…" } },
  "delegatus": { "version": "X.Y.Z", "tarball": "https://registry.npmjs.org/delegatus-cli/-/delegatus-cli-X.Y.Z.tgz",
    "integrity": "sha512-…", "gitHead": "<40 hex>" } }
```

Files the app owns on the user's Mac:

| Path | Content |
| --- | --- |
| `~/Library/Application Support/Delegatus/Runtime/bun/bin/bun` | private Bun |
| `~/Library/Application Support/Delegatus/Runtime/packages/node_modules/delegatus-cli/` | private package root, a fixed path |
| `~/Library/Logs/Delegatus/app-<date>-<time>.log` | one log per app launch, newest ten kept |
| `~/Library/Application Support/Delegatus/Listeners/<port>.json` | private process identities previously verified with CLI ancestry |

Delegatus's state stays where every install keeps it (`~/.config/delegatus`).
A user who started Delegatus from a terminal earlier keeps their board.

Processes the app starts, always with an argument array and never through a
shell:

| Command | When |
| --- | --- |
| `/bin/bash Resources/setup-runtime.sh <Runtime> <manifest>` | first run, or repair |
| `<bun> <cli.mjs> --no-open --port 8898` | Start, when start at login is off |
| `<bun> <cli.mjs> service install --port 8898` | turning start at login on |
| `<bun> <cli.mjs> service remove` | turning start at login off |
| `launchctl kickstart gui/<uid>/org.delegatus.server`, or `launchctl bootstrap gui/<uid> <plist>` when the job is not loaded | Start, while start at login is on |
| `<bun> <cli.mjs> stop --all` | Stop |
| `/usr/sbin/lsof -nP -a -iTCP:8898 -sTCP:LISTEN -Fpcu` | read-only, to name a port's listener |

The child environment is the app's own environment plus three values.
`PATH` is the private Bun directory, then `~/.bun/bin`, `~/.local/bin`,
`/opt/homebrew/bin`, `/usr/local/bin` and the lines of `/etc/paths`.
`LLV_LANG` is the app's chosen localization (`en` or `uk`), and `NO_COLOR`
is `1`. The app reads no shell profile and writes none. For an install named
by a login-service plist (§2), every command also gets that plist's
`EnvironmentVariables`, so `stop --all` and the key lookup use the same
state and config directories as the service.

## 2. First-run install flow

**Discovery.** The first match wins, checked on every launch:

1. The install named by an owned login-service plist
   (`~/Library/LaunchAgents/org.delegatus.server.plist` whose third line is
   the `service install` marker). Its `ProgramArguments` give the Bun and the
   `cli.mjs`. That install is the one that runs at login and owns the state.
2. The private install, when both its Bun and its `cli.mjs` exist.
3. A Bun global install: `~/.bun/install/global/node_modules/delegatus-cli`
   with `~/.bun/bin/bun`, the command the guide's "Keep a command installed"
   step creates.
4. Nothing: the first-run question.

The app runs a found install as it is. It never installs a second copy beside
one it found, because two installs on one state directory have two identities
(two journals, two sockets) and can run different versions against one
database.

**The question.** One sheet in the window, shown once:

> Delegatus needs Bun 1.4.0 and Delegatus X.Y.Z. Install them for this user?
> About N MB is downloaded from GitHub (Bun) and npm (Delegatus and its
> dependencies) into ~/Library/Application Support/Delegatus. No
> administrator password is needed, and your shell settings are left alone.
> You will connect Claude Code or Codex later, in Delegatus's setup guide.
>
> [Install] [Quit]

N is the size of the Bun zip plus the package tarball, which the build
records in the manifest; the dependencies come on top. For scale, the
published 2.0.0 package unpacks to 212 MB before its dependencies
(`npm view delegatus-cli dist.unpackedSize`, read on 2026-11-12).

**`setup-runtime.sh`** is adapted from the community script and keeps its
shape: a lock directory, a staging directory inside `Runtime`, a `TERM`/`INT`
trap that ends the child and keeps the previous installation, and a short
publish transaction. The changes:

- Versions, URLs and digests come from `runtime-manifest.json`, and nothing is
  hard-coded.
- **Bun:** `curl --proto '=https'` fetches the zip for `uname -m`, checks the
  manifest's SHA-256, unzips, then runs `bun --version` and compares it with
  the manifest.
- **Delegatus:** `curl` fetches the tarball and checks its sha512 against the
  manifest's `integrity`. Then `bun add --exact <tarball>` runs in a staging
  folder whose `package.json` is `{"private": true}` and a temporary `HOME`
  inside the staging directory, keeping Bun's default cache out of the user's
  home. This is the install step the in-product updater uses (`package.ts:98-99`). The script then
  checks that `package.json` names `delegatus-cli` at the manifest version,
  and that `bin/cli.mjs`, `dist/standalone/server.js` and
  `dist/runtime-host.mjs` exist.
- **Publish:** `bun` and `packages` are each renamed into `Runtime/`. The path
  of `packages/node_modules/delegatus-cli` is identical before and after, so
  the install identity never changes.
- Each step prints one line, `SETUP 1/3 …` to `SETUP 3/3 …`. The app shows it
  in the status view, and the full output goes to the app log.

Cancel ends the script through its trap. A failure shows one localized
explanation, Try Again and Open Logs. Technical observations stay in Logs.

**After install** the app starts Delegatus (§3) and shows the web view.
Delegatus's own setup guide then signs the user in to Claude Code or Codex.
The app never runs those CLIs.

## 3. Finding, starting, reusing and stopping Delegatus

**Probe** (§4 gives the classification). On launch, after Start, and every
15 s while the web view shows.

**Launch decision:**

1. The probe says ready and every listener belongs to this user with verified
   installed Bun and Viewer/runtime-host identity: reuse it. Open the web
   view and log `STATE reused`. Stable v1 Delegatus releases lacking the
   diagnostics route use the legacy rule in §4. Their version is logged.
   A running installation from the former launcher's private runtime is also
   checked against that identity. A stopped copy there does not change normal
   installation discovery. Reuse leaves the running release in place.
   The listener itself must run the selected installation's Viewer or runtime
   host by exact entry-point path, and `proc_pidpath` must name that installation's
   Bun executable (real paths are compared). Normally its ancestors include the
   installed CLI or the CLI PID this app started. While that ancestry is proven,
   `Server.listener` starts a headless copy of the native launcher. That keeper
   independently repeats the live-CLI verification and retains each listener's
   pid, uid, kernel birth seconds/microseconds and real Bun, CLI and serving-package
   paths in memory. An explicit launcher PID is admitted only from a parent
   running this same native executable. This boundary serves discovery, startup,
   monitoring and Open existing.
   After the CLI exits, reaching launchd without it also requires that exact
   retained identity. A new process using the same pid, or an unrelated script
   using the same Bun and a copied process title, cannot inherit that proof.
   Each retained generation has its own Unix socket, so an older process still
   alive after releasing the port cannot block a successor's keeper. The new
   app connects to that socket and checks the connected peer's uid
   with `getpeereid`, its PID with `LOCAL_PEERPID`, and its executable with
   `proc_pidpath`. Only the same native launcher executable may supply retained
   identities. Socket replacement cannot change that connected peer. A regular
   JSON file, including a forged old `Listeners/<port>.json` with the correct
   current PID/birth and mode 0600, grants no trust. Each response is bounded to
   32 KiB and 64 identities. Connect/read/write waits are bounded and run off
   the app's main actor. The keeper checks only its retained process generations,
   exits when one disappears or changes, and never reads access keys or signals
   the server. If the keeper is unavailable, a live CLI must prove ancestry again;
   an orphan cannot create its own proof. A normal app quit leaves the keeper
   and server running.
   Missing/malformed process rows, cycles, unreadable or different executables,
   another uid, incomplete packages and argument-path decoys still refuse. A
   descendant of Delegatus running another program cannot borrow its ancestry.
   Every credential-bearing probe rechecks the listener and selected package;
   a protected instance must accept this account's saved key before automatic
   readiness or a keyed web load. This avoids trusting process names or HTTP
   markers alone, while allowing the server to outlive its original launcher.
2. The probe says something else holds the port, or `lsof` lists nothing for
   a port that answers (a process of another macOS user): show the busy-port
   view.
3. The port is free:
   - with no install, ask the first-run question (§2);
   - with start at login on, start the LaunchAgent with `launchctl kickstart`
     (or `bootstrap` when it is not loaded). The app never runs
     `service install` here: that command rewrites the plist from the
     caller's environment (`bin/login-service.mjs:242-244`), and a plist
     written from a terminal can carry config and state directories the app's
     environment lacks;
   - otherwise spawn `<bun> <cli.mjs> --no-open --port 8898` with output to
     the app log.

   Then probe every 500 ms for up to 180 s. A start attempt that exits gets
   30 s more before the wait fails, because a launcher already starting
   elsewhere (at login, or from a terminal) makes ours exit while that one
   comes up. A temporary 404 keeps this wait pending. The wait ends when
   Delegatus verifies as ready, or with one localized timeout message and
   Try Again / Open Logs. The exit code, probe responses and ancestry refusal
   remain in Logs; the window contains no raw log tail.

**Busy port**, en and uk:

> Port 8898 is in use by Python (PID 4312). Check that program, then press
> Try Again.

For a verified Delegatus the busy-port action row also offers **Open existing**
and explains that its page may ask for the access key. The button is absent for
foreign programs, another uid and unverified listeners. Pressing it rechecks
the installation and listener, probes again, then opens that instance in the
app window. Only a freshly accepted saved key is passed to the page. Otherwise
the new WKWebView has a nonpersistent cookie store and receives no key; native
health monitoring leaves that manual session open. Neither path signals or
replaces the server.

When `lsof` names no process of this user: "Port 8898 is in use by a program
of another user on this Mac." When a Delegatus answers but the key file holds
no matching key, its access screen names the version, explains that the saved
key could not open it, and offers Open existing to continue on its page. A
key-protected Viewer currently asks for the link containing its access key
(`src/proxy.ts`, `forbidden`); the launcher adds no key-entry form.
The English and Ukrainian access screens have the same three
actions. The app sends no signal to the listener.

**Stop** (Delegatus menu → Stop Delegatus). This is the same stop as the web
UI's own «Stop Delegatus» (`src/lib/stopAll.ts:1-10`). It reaches a
launcher the app did not start, and the guide's "For launcher authors"
section asks for it as a separate, confirmed action
(`docs/guide/configuration.md:104-110`). A confirmation says that running
agents stop too. For current supported releases, the app then runs `stop --all` from the selected install,
waits up to 60 s until the probe reports a free port, and shows the stopped
view with Start. Under start at login the launcher exits 0 on SIGINT and
SIGTERM, so launchd's `KeepAlive {SuccessfulExit: false}` does not restart it
until the next login.

For a verified 1.11.0 installation, Stop Delegatus and Start at Login are
disabled because that release has neither supported CLI operation. The app
continues to reuse the verified server; use its existing installation's own
controls to stop it or configure login startup.

**Start at login** (Delegatus menu, a checkmark). The checkmark means an owned
plist exists. Turning it on runs `service install --port 8898` and shows the
localized service-failed message if it exits non-zero; command details are in
Logs. Turning it off runs `service remove`. That stops a Delegatus the service
was running, so the app asks first and then starts Delegatus itself with the
direct spawn. The server starts at login and the app window does not; the
window reattaches whenever the app opens.

**Quit.** While Delegatus runs, ⌘Q asks: "Delegatus keeps running so your
agents can work." The buttons are Quit and Keep Running (the default), Stop
and Quit, and Cancel, with "Don't ask again" stored in `UserDefaults`.
Closing the window keeps the app and the server running. Reopening the app
from the Dock shows the window again.

**Liveness while the window is open.** Two failed probes in a row switch to
the stopped view, and probing continues. If listener ownership is verified but
the saved key no longer works, the app instead shows the localized
access-unavailable guidance with Open existing, Try Again and Open Logs. When Delegatus
answers again, after an Update relaunch or a Stop from the web UI's own menu,
the web view returns.

## 4. The health rule, under every gate

The request is `HEAD http://127.0.0.1:8898/api/onboarding/diagnostics`, with
no proxy, no redirect following and a 2 s timeout per request.

| Gate on the running Viewer | Answer | App reading |
| --- | --- | --- |
| None (fresh install) | `204`, `x-delegatus-diagnostics: 1` | Delegatus |
| Key on (Phone step, links, `--tailscale`, a non-loopback `--hostname`) | `403` JSON | verify this account's listener, installed Viewer/runtime host and kernel Bun identity under §3 before reading `~/.config/delegatus/token` (or legacy `~/.config/agent-log-viewer/token`) and retrying with `Authorization: Bearer <key>`; `204` with the marker means Delegatus, and the web view's first load is `/?k=<key>`, which sets the 30-day cookie (`src/proxy.ts:132-135`) |
| Team install (a team gates only alongside the key) | `401` JSON "sign in required" (`src/lib/team/gate.ts:107-134`) | apply the same listener identity check before the retry; the key is checked before the team perimeter (`src/proxy.ts:117-146`) |
| Self-update handoff (`503` applies to writes only) | `204` (HEAD passes `handoffBlock`) | Delegatus |
| Verified stable v1 Delegatus | diagnostics `404`, including after an authorized retry | verify the active package version and listener ancestry, then require `HEAD /` to answer `200`; verify again before accepting it |
| Verified Delegatus whose saved key is missing or refused | `401`/`403` | localized access-key guidance, Open existing, Try Again and Open Logs |
| Foreign or unverified listener | anything, including a copied diagnostics marker | busy port; no access key is sent; Open existing is absent |
| Nothing listening | connection refused | free |

This is the request behind the `viewer.server` row that the guide's "For
launcher authors" section documents (`docs/guide/configuration.md:78-102`),
sent directly so that each probe costs one HEAD and starts no Bun process.
Timeouts and refused connections count as "not ready yet" until the start
deadline, as that section asks. It also fixes the community launcher's
defect W1 (`install-and-onboarding-second-view.md` §4). That launcher reads
`GET /` with HTML and a script as health, which a keyed Viewer answers with
403. The app
holds the key in memory only, never logs it, and puts it in no URL it shows
or copies.

The legacy exception requires a valid installed `delegatus-cli`, the active
serving package from the validated self-update pointer (when present), a stable
version from 1.0.0 up to 2.0.0 exclusive, and the same process ownership and
installation identity used for modern reuse. A root page or a version-shaped HTTP response
alone proves nothing. The app checks ownership before each request carrying a
key, and checks ownership and the selected package again before accepting
readiness. Redirects remain disabled for the root request too. A modern
package whose diagnostics stays at 404 keeps waiting even if its root returns
200. The same rule governs initial discovery, an app-started CLI, and every
15-second monitor probe. Two failed probes show the stopped view. If listener
ownership remains verified and the saved key is refused, the app shows
localized access-unavailable guidance. A verified recovery restores the web
view.

## 5. Window, language and web behaviour

- **Language.** The app ships `en.lproj` and `uk.lproj`, so macOS picks
  Ukrainian for a user whose preferred languages put Ukrainian before
  English, and English otherwise. The CLI gets that choice as `LLV_LANG`.
  `WKWebView` reports the app's localization as `navigator.language`, which
  the web UI reads when no language has been saved in it (§12, U2).
- **Web view.** It keeps the persistent `WKWebsiteDataStore.default()`, so
  the key cookie and the web UI's saved settings survive restarts. Adapted
  from the community launcher: links to other hosts open in the default
  browser, popups get a window, file inputs use `NSOpenPanel`, downloads use
  `NSSavePanel`, and `alert`, `confirm` and `prompt` become sheets. The
  Back, Forward and Reload toolbar stays, and the Edit menu (needed for copy
  and paste in a `WKWebView`) is kept too.
- **Microphone** (community defect W2). `NSMicrophoneUsageDescription` is in
  `Info.plist`, localized in `InfoPlist.strings`. The
  `requestMediaCapturePermissionFor` delegate grants
  `http://127.0.0.1:8898` and denies every other origin.
- **Menus.** Delegatus: About, Check for Updates…, Start at Login, Stop or
  Start Delegatus, Open Logs, Quit. Edit. View: Reload, Open in Browser.
  Window.
- **Status view states.** Each state has its own heading and buttons:
  needs install, installing (step line and Cancel), starting ("The first start
  can take up to a minute and a half"), stopped (Start), busy port (Try
  Again, Open Logs, plus Open existing for a verified Delegatus), access
  unavailable (localized key guidance, Open existing, Try Again, Open Logs),
  and failed (plain localized message, Try Again, Open Logs).
- **Open Logs** reveals `~/Library/Logs/Delegatus/` in Finder with the newest
  file selected. Under start at login that folder also holds `server.log`.

## 6. Updates

**Check for Updates…** does two things:

1. It opens Delegatus's own Update dialog in the web view by dispatching
   `window.dispatchEvent(new Event("llv:open-self-update"))`. For every
   packaged install, the private one included, that dialog fetches the npm
   `latest`, verifies its provenance, installs it beside the package root and
   relaunches with rollback. The package root and its identity stay put. A
   comment on `OPEN_SELF_UPDATE_EVENT` records that the Mac app depends on
   this name.
2. It reads `https://api.github.com/repos/<DelegatusReleaseRepository>/releases/latest`.
   When the tag is newer than the app's own version and the release carries
   `Delegatus-<version>-mac.dmg`, an alert offers Download, which opens that
   asset in the default browser. The user drags the new app over the old one.

A newer app never reinstalls an existing package root. Delegatus versions move
only through the Update dialog, so a newer app cannot downgrade a server the
dialog already moved forward. Bun moves with the app: when the app's pinned
Bun is newer than the private one, the app installs the new Bun beside the
old one and swaps the `bun` directory with one rename. Running processes keep
the old binary until their next start.

## 7. CI: build and smoke test

New reusable workflow `.github/workflows/macos-app.yml`, triggered by
`pull_request`, `workflow_dispatch` and `workflow_call` (inputs `mode`,
`pr` or `release`, and `tag`).

| Job | Runner | Does |
| --- | --- | --- |
| `scope` | `ubuntu-latest` | `bun scripts/ci-platform-scope.ts --workflow .github/workflows/macos-app.yml --prefix macos/ --prefix scripts/mac-app/ --prefix bin/ --prefix src/app/api/onboarding/` plus `src/proxy.ts` and `Dockerfile`. A skipped leg reports success, as in `macos-identity.yml`. |
| `pack` (pr mode) | `ubuntu-latest` | `bun install --frozen-lockfile`, then `npm pack`, the same platform the publisher packs on; uploads the tarball |
| `macOS app build` | `macos-latest` | needs `scope` and `pack`; build, Swift checks; uploads the `.dmg` |
| `macOS app smoke (arm64)` | `macos-latest` | downloads that exact `.dmg`; smoke |
| `macOS app smoke (x86_64)` | `macos-15-intel` | the same smoke on an Intel Mac |

The `.dmg` is built once, so both architectures test the bytes a release
ships.

**Build** (`scripts/mac-app/build.sh`):

1. `manifest.ts` reads the Bun pin from the `Dockerfile` with the
   `macos-identity.yml` expression. It downloads both Bun zips and
   `SHASUMS256.txt`, requires each computed SHA-256 to match its line, and
   writes the manifest. In pr mode the Delegatus entry is the packed tarball
   as a `file://` URL with its computed sha512. In release mode it is the
   registry tarball. The step polls `npm view` for up to 10 minutes, as
   `macos-newcomer.yml` does, and requires `gitHead` to equal the tag commit
   and `dist.integrity` to equal the publish job's output when that output
   exists. Release mode refuses any URL that is not `https:`.
2. `icon.ts` renders `public/brand/delegatus-touch-icon.svg` with `sharp` into
   an `.iconset`, and `iconutil -c icns` turns it into `AppIcon.icns`. No
   binary icon is committed.
3. `swiftc -O -target {arm64,x86_64}-apple-macos13.0 -framework AppKit
   -framework WebKit`, then `lipo -create`.
4. The script assembles the bundle, runs `plutil -lint`, then
   `codesign --force --sign - Delegatus.app` and
   `codesign --verify --strict`.
5. `hdiutil create -format UDZO` builds the `.dmg` from a folder holding
   `Delegatus.app` and an `Applications` symlink. The artifact is
   `Delegatus-<version>-mac.dmg`, with a `.sha256` file beside it.

**Swift checks:** `swiftc macos/Sources/{Install,Server}.swift
macos/Tests/CoreChecks.swift`, run against a temporary folder (the community
`CoreChecks.swift` pattern).

**Smoke** (`node scripts/mac-app/smoke.mjs <dmg> <report-dir>`, the one driver
for this surface; later cases are added to it):

- **Runner session, fresh data.** A hosted macOS runner has one logged-in
  graphical session, the runner user's. An app started from a second operating
  system account has no connection to that session's window server, so it
  cannot create a window. The smoke therefore runs every GUI step as the runner
  user and gets its isolation from fresh data. An early check requires an
  unprivileged runner user and records the launchd manager of the session. A
  run creates one data root under the temporary directory, and each case that
  needs a clean start gets its own empty home folder there and the app's `HOME`
  points at it. The `.dmg` is attached read-only, and `ditto` copies the app into
  `Applications` under that root. The app, the replacement Delegatus
  servers, `stop --all` and the test listener get
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, no Bun and `DELEGATUS_TELEMETRY=0`,
  and inherit nothing else from the runner's environment. The helper
  commands (`hdiutil`, `ditto`, `defaults`, `ps`, `lsof`, `launchctl`, `log`)
  keep the runner's environment. AppKit and WebKit keep
  preferences, restored window state, web data and caches under the session
  user's own `Library`, whatever `HOME` says, so before each launch the smoke
  deletes the app's preference domain and those folders for its bundle
  identifier and passes `-ApplePersistenceIgnoreState YES`. Nothing carries
  from one case to the next except the one home that the install cases share on
  purpose. The smoke starts every app and every replacement server as its own
  child and stops each by its recorded PID, or through `stop --all`, which it
  runs without blocking its own event loop so that a launcher it started is
  reaped.
- **Case `confirm`.** Launch without `--accept-install` at the minimum window
  size, then at the default size in en/uk and light/dark. Each screen must show
  `STATE needs-install`; after 20 s nothing may exist under
  `~/Library/Application Support/Delegatus/Runtime`. The harness ends each app
  by its PID.
- **Case `error-surface`.** The evidence-only launch flag renders the existing
  localized failure screen in the default window size for legibility review.
- **Case `first-run`.** Launch with `--accept-install` and
  `-AppleLanguages (en)`. Within 12 minutes `GET /` must answer **200** and
  the protected HEAD probe must answer 204 with the marker. A temporary access
  key is stored in the case home's mode-0600 token file to exercise protected
  reuse without putting it in process arguments or logs. `ps` must show the
  listener's launcher as
  `…/Delegatus/Runtime/bun/bin/bun …/Runtime/packages/node_modules/delegatus-cli/bin/cli.mjs`
  under this run's data root. A listing of the case home taken before the first
  launch and after this case may differ only under `Library/`, `.config/`
  and `.cache/`, so no shell profile appears or changes. The check covers the
  case home only: the runner user is unprivileged, but the smoke does not watch
  the rest of the runner's disk. The log must show `STATE ready` and
  `WEB language=en…`.
- **Case `reuse`.** End the app by its PID. The server must keep answering.
  Relaunch with `-AppleLanguages (uk)`. The log must show `STATE reused` and
  `WEB language=uk…`, and the launcher PID must be unchanged.
- **Cases `relaunch`.** The app starts a fixture through the real Bun/CLI/server
  process relationship. End the app, then end that fixture's CLI while its
  detached server keeps listening. A new app process must reach `STATE reused`
  with the same server PID. Repeat with installed version metadata below and
  above the bundle, a modern diagnostics 404 and a refused saved key. The latter
  cases capture the button screen, click the actual NSButton and retain the
  finished page in English and Ukrainian; the page records any leaked key or
  cookie. The frame verdict requires the post-navigation page capture.
- **Cases `same-bun-title`.** A foreign script uses the installed Bun and copies
  the installed server's process title. Test both a missing receipt and a forged
  mode-0600 receipt with its real current kernel birth and installation paths.
  Both languages must show port-busy without Open existing or a web navigation;
  Authorization, cookies and query keys remain absent. Core checks also require
  a direct attempt to start a keeper for that script to refuse it independently.
- **Case `transient-restart-recovers`.** Stop the running Delegatus, wait until
  two monitor samples show the stopped screen, then restart it with the same
  access key. The running app must log recovery and return to HTTP 200 without
  a manual Start action.
- **Case `busy-port`.** Run `stop --all` and require the disposable evidence
  port to be free within 30 s. Start a small Python listener on the driver's
  loopback port that answers
  `401` and records any `Authorization` header it receives, and record its PID, then launch the app. The log must show
  `STATE port-busy` with the listener's name and PID, and no new `cli.mjs`
  process may exist. The harness stops the listener and the app by their
  PIDs.

`--evidence-open-existing` clicks the native button after its screen capture;
it is active only with an evidence directory. `--accept-install`,
`--evidence-error`, `--evidence-dir <dir>` and
`--evidence-port <n>` are smoke-only launch arguments; the port is selected
from a disposable loopback port. A web page cannot set them. The app captures the composited
native window so painted text and controls
are included. The frames cover each confirmation layout, recovery and busy
screens, plus loaded pages in en and uk, light and dark. Dark comes
from the launch argument `-AppleInterfaceStyle Dark`, and a launch with
`--evidence-dir` also sets `NSApp.appearance` to dark or light from that
argument. The report, frames and logs (with the run's data root
replaced by `$SMOKE_ROOT` and the runner's home by `$RUNNER_HOME`) upload as an artifact for the visual critic.

**Known limitation.** Frames labelled "dark" for the system menu keep the
light system-menu look on the hosted runners. The dialogs do show both themes.

**Required checks.** After the workflow lands, the seat adds
`macOS app build`, `macOS app smoke (arm64)` and `macOS app smoke (x86_64)`
to main's branch protection.

## 8. Release attachment

`publish.yml` gains two jobs and changes none of its existing ones:

```yaml
  mac-app:
    needs: [verify-tag, github-release, publish]
    uses: ./.github/workflows/macos-app.yml
    with:
      mode: release
      tag: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}
  attach-mac-app:
    needs: [verify-tag, mac-app]
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      # download the build job's .dmg artifact; both smoke legs passed on it
      - run: gh release upload "$RELEASE_TAG" Delegatus-*-mac.dmg Delegatus-*-mac.dmg.sha256 --clobber
```

`--clobber` lets a `workflow_dispatch` recovery of an existing tag replace a
partial upload. A failed app leg leaves the release without the `.dmg`; the
npm package and the release notes are already out, and a dispatch for the tag
retries.

## 9. Documentation

- **README Quick start.** A new first paragraph, before step 1: "**On a
  Mac:** download `Delegatus-<version>-mac.dmg` from the
  [latest release](../../releases/latest), open it and drag Delegatus to
  Applications." The open steps for an unsigned app follow, then "The app
  installs Bun and Delegatus for you and opens the setup guide (step 5
  below)." The relative link names no account.
- **Opening an unsigned app** (README and guide). On macOS 13 and 14,
  Control-click (or right-click) the app, choose **Open**, then **Open**.
  On macOS 15 and later, double-click once, close the warning, open
  **System Settings → Privacy & Security**, press **Open Anyway** next to
  Delegatus and confirm. Both are needed because macOS 15 removed the
  right-click override.
- **`docs/guide/getting-started.md`.** "Choose how to install" lists the Mac
  app first. "Open Delegatus as an app" points Mac users to it, since the app
  also starts Delegatus. "If something does not start" gains the busy-port
  message and Open Logs.
- **`CHANGELOG.md`** gets the entry, and `docs/RELEASING.md` gets one line on
  the `.dmg` attachment.

## 10. What is reused from the community launcher

| Community file | Taken | Changed or left out |
| --- | --- | --- |
| `Source/setup-runtime.sh` | lock directory, staging, cancel trap, rollback, publish transaction, SHA-256 check of the Bun zip | manifest-driven versions; sha512 check of the Delegatus tarball; `bun add --exact` as the updater does; no reuse of an outside Bun |
| `Source/Core.swift` | `SemanticVersion`; the bounded `--version` probe with its kill on timeout; canonical file checks | discovery order of §2 in place of a scan of `PATH`, npm-global and `~/go/bin`; no `settings.json` |
| `Source/Launcher.swift` | the `WKWebView` delegates (navigation policy, popups, open panel, downloads, JS panels), toolbar, Edit menu, reopen handling, setup cancel, the `lsof` listener read | health via the diagnostics probe with the key retry (W1); no "free the port" stop; no forced `LLV_LANG=uk` and no hard-coded Ukrainian strings; microphone permission added (W2); quit keeps the server |
| `Source/build.sh` | `swiftc` per architecture, `lipo`, `Info.plist`, `PkgInfo`, `codesign -` | icon rendered from our SVG; manifest; `.dmg` |
| `Source/Delegatus.icns`, the Windows and Linux launchers | — | not taken |

Each adapted file starts with "Adapted from the Delegatus Community Launcher
(MIT); see THIRD_PARTY_NOTICES.txt". `macos/THIRD_PARTY_NOTICES.txt` carries
that project's MIT license text verbatim, with its copyright line "Delegatus
Community Launcher contributors". The bundle copies the notice into
`Contents/Resources/`.

## 11. What an Apple Developer account adds

- A Developer ID Application certificate replaces `--sign -` and adds the
  hardened runtime. With the hardened runtime, the microphone needs the
  entitlement `com.apple.security.device.audio-input`.
- Notarization (`xcrun notarytool submit --wait`) and `xcrun stapler staple`
  on the app and on the `.dmg`. The first open is then an ordinary
  double-click: no Open Anyway step and no warning.
- A stable signing identity. macOS keeps the microphone permission across app
  updates; with ad-hoc signing each new build asks again.
- CI needs the certificate and an App Store Connect API key as secrets,
  imported into a temporary keychain in the `macOS app` job. `build.sh`
  already reads `SIGNING_IDENTITY` as the community script does.

## 12. Risks and facts the first CI run settles

- **U1. Session for the smoke (settled).** An earlier revision ran the app
  under a second operating-system account. On the Intel runner it crashed at
  its first `NSWindow` with a `WMClientWindowManager` /
  `xpc_connection_set_target_uid` API-misuse trap: a hosted runner has one
  logged-in graphical session, and a second account launched from it has no
  window-server connection. Selecting that account's launchd context does not
  create a graphical login. The smoke now runs its GUI steps in the runner's own
  session and gets isolation from fresh data (§7). The hosted run on the final
  head passed both native smokes, arm64 and x86_64, with window creation, HTTP
  200 and the full PNG matrix.
- **U2. `navigator.language` in `WKWebView`.** I expect it to follow the
  app's localization. The `WEB language=` assertions in cases `first-run`
  and `reuse` prove it or fail.
- **U3. The `macos-15-intel` label.** It appears in GitHub's runner-images
  changelog and in other projects' workflows. If it is unavailable, the
  x86_64 leg runs the x86_64 slice under `arch -x86_64` on `macos-latest`,
  when Rosetta is installed there, and the report says so.
- **R1. Space in `Application Support`.** Every child gets its paths as
  argument arrays, and the community launcher started Delegatus from a path
  with spaces. The first-run case runs from exactly that path.
- **R2. A custom state directory set only in a shell profile.** A terminal
  user who sets `XDG_CONFIG_HOME` or `DELEGATUS_STATE_DIR` in a shell profile
  and has no login service gets the default state directory when the app
  starts Delegatus, because GUI apps do not read shell profiles. Such a user
  turns on start at login from a terminal once (`delegatus service install`
  captures those settings), and the app then uses that service (§2).
- **R3. A first update from the app's version through the Update dialog** is
  not rehearsed in CI (Deferred). The packaged updater first shipped in
  1.10.0 (`install-and-onboarding-second-view.md` W8), so every app release
  starts from a version that has it.

## Validation against the requirement

| Requirement | Where |
| --- | --- |
| 1. App for Apple Silicon and Intel, from releases, drag and double-click, own window and icon | §1, §7 build, §8 |
| 2. One confirmation, private install, no sudo, no profile edits, start and show | §2; smoke `confirm` and `first-run` |
| 3. Reuse a healthy Delegatus, or start one | §3, §4; smoke `reuse` |
| 4. Start at login, stop, update, open logs, busy port | §3, §5, §6; smoke `busy-port` |
| 5. No Claude Code or Codex install or sign-in | §2 "After install" |
| 6. System language, English and Ukrainian | §5; smoke language assertions |
| 7. Community code reused with its notice | §10 |
| 8. macOS CI build, fresh-data smoke with HTTP 200, release attachment | §7, §8 |
| 9. Ad-hoc signing, open-unsigned steps, developer-account note | §7 build step 4, §9, §11 |
| 10. README points Mac users to the app; no names in public text | §9; the release repository comes from `$GITHUB_REPOSITORY` at build time |

## Deferred — not currently justified

- **Developer ID signing and notarization.** It needs the operator's Apple
  Developer account (§11).
- **In-app replacement of the app itself** (a Sparkle-style updater). A
  download link is enough for a thin shell that changes rarely.
- **A port setting**, for two macOS users who both run Delegatus on one Mac.
  The CLI and `service install` already take `--port`; the busy-port message
  names the case.
- **Stopping the process that holds the port.** It was rejected on
  2026-11-11, because this project stops processes only by recorded identity.
- **Choosing existing Bun or Delegatus files by hand** (a community feature).
  The discovery in §2 covers the documented installs.
- **A menu bar item, and web push notifications in the app window.**
- **The app window opening at login.** The server starting at login is what
  is offered.
- **Start at login exercised in CI.** The smoke never registers a login
  service on the runner; `bin/login-service.test.ts` covers the command.
- **An update rehearsal in CI** from the previous release's app through the
  Update dialog to the new release.
- **Bun upgrades inside the in-product updater.** Today Bun moves with the
  app (§6).
- **Bun and Delegatus bundled inside the `.dmg`** for an offline install.
- **Windows and Linux launchers.**

## Prior work consulted

`search_transcripts` (project-scoped, then unscoped) found the 2026-11-10 and
2026-11-11 onboarding reviews and the lane that landed the web app manifest
and the guide's "For launcher authors" section. Their documents are
`docs/design/install-and-onboarding.md` and
`docs/design/install-and-onboarding-second-view.md`, whose W1, W2, W8 and V1
this design builds on or supersedes, and `docs/guide/configuration.md`
§"For launcher authors", whose probe and stop rules the app follows. `search_memory` for the Mac launcher,
the `.dmg` and Gatekeeper returned nothing. `docs/design/self-update-every-install.md`
gives the packaged update path, and `docs/macos-newcomer.md` with
`scripts/newcomer-install.mjs` gives the clean-start rehearsal pattern this
smoke follows.
