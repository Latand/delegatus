# Delegatus for Linux: a desktop package — design

## Originating requirement

On 2026-11-13 the owner asked, through the project orchestrator, for a Debian
package that gives Linux users what the Mac app gives Mac users. Linux has no
package at all; the Mac app (`docs/design/mac-launcher.md`, pull request
#3925) is the model. The deadline is "as soon as possible". Source: the pinned
task specification "Delegatus launcher for Linux: a .deb that installs an
app-menu entry and opens Delegatus in its own window".

The specification asks for:

1. a `.deb` for amd64 (and arm64 when the same build makes it cheaply), built
   reproducibly by a repository script from a checkout or an exact release,
   with no build-time network beyond what the Mac build uses;
2. on current Ubuntu LTS and Debian stable, `apt install ./<file>.deb` or a
   software-centre double click adds a «Delegatus» menu entry with the product
   icon. Starting it opens Delegatus in its own window, with no terminal. The
   first run installs the pinned runtime and the exact release for that user
   under the same manifest and integrity discipline as the Mac app. The app
   starts the server, reuses a healthy Delegatus on the port, says plainly when
   something else holds the port, and updates the way the Mac app does.
   Nothing runs as root beyond installing the package's own files. The user's
   state directory and shell profiles are left alone. Removal deletes the
   package's files and keeps user data;
3. declared dependencies that stock Ubuntu LTS and Debian stable provide, and
   the simplest window mechanism that meets point 2. Electron or another
   bundled browser is allowed only when nothing simpler meets it;
4. a CI workflow that builds the package, runs a package check, installs the
   package in a clean container, and launches it under a virtual display. The
   workflow must prove readiness and an open window (keeping a screenshot) and
   prove that removal keeps user data. Each verdict needs a negative case;
5. `publish.yml` attaching the `.deb` and its sha256 to the GitHub Release
   beside the DMG, plus install steps in `docs/RELEASING.md`, the README and
   `docs/guide/getting-started.md`, and a CHANGELOG entry;
6. English and Ukrainian for every text the user sees.

Deferred by the specification: an apt repository, package signing, RPM and
other formats, a rendered design review of the window chrome.

## Decisions

1. **Window: Python 3 + PyGObject + GTK 3 + WebKit2GTK 4.1.** A status view
   (install, start, errors) gives way to a `WebKit2.WebView` once Delegatus
   answers, as in the Mac app. No compiler, so one package serves every
   architecture.
2. **One `Architecture: all` package**, `delegatus_<version>_all.deb`, with no
   maintainer scripts. It holds the launcher, the runtime manifest, a desktop
   entry, icons and the Debian documents. Its Depends are `python3 (>= 3.11),
   python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, ca-certificates`.
3. **The Mac app's build-time code is shared; its run-time code is ported.**
   `scripts/mac-app/manifest.ts` gains a platform switch, and
   `scripts/mac-app/icon.ts` is reused unchanged. The installer, probe,
   listener check and discovery are ported to Python with the same contract
   (§3). Swift and AppKit do not run on Linux.
4. **The private install has one fixed path**:
   `~/.local/share/delegatus/runtime/`. `XDG_DATA_HOME` is ignored on purpose,
   because the package root's real path is the install identity
   (`bin/server-runtime.mjs:198`). The path never moves.
5. **The health rule is the product's own probe** (`HEAD
   /api/onboarding/diagnostics` → `204` with `x-delegatus-diagnostics: 1`). A
   listener that does not answer it is classified by its process identity from
   `/proc`. A booting Delegatus from this user's own install is therefore
   waited for, and an older Delegatus gets its own plain message, which names
   its version (§5).
6. **CI runs the whole first run inside clean `ubuntu:24.04`, `ubuntu:26.04`
   and `debian:13` containers under Xvfb on amd64, plus `ubuntu:26.04` on
   arm64.** A release builds once and attaches the bytes that every smoke leg
   passed.

## 1. The window mechanism

Facts observed for this design on 2026-11-13. `apt-cache policy` ran in fresh
`ubuntu:24.04`, `ubuntu:26.04`, `debian:13` and `debian:12` containers, and a
20-line probe window ran under `xvfb-run` as an unprivileged user:

| Fact | Evidence |
| --- | --- |
| `python3-gi`, `gir1.2-gtk-3.0`, `gir1.2-webkit2-4.1`, `gir1.2-gtk-4.0` and `gir1.2-webkit-6.0` are candidates on Ubuntu 24.04 and 26.04 and Debian 12 and 13 (WebKitGTK 2.50–2.54). | `apt-cache policy` in each image |
| GTK 3 + WebKit2 4.1 opened a mapped window and rendered and ran the page. This held on Ubuntu 24.04 and on Debian 13, both with and without a session bus. | probe log `LOADED … title= lang=uk`; screenshot inspected |
| GTK 4 + WebKitGTK 6.0 crashed in the same container: `bwrap: No permissions to create new namespace`, then `Connection: failed to receive credentials`, then a trap. Its web-process sandbox is mandatory and needs unprivileged user namespaces. | probe log |
| This Ubuntu 24.04 host has `kernel.apparmor_restrict_unprivileged_userns = 1`, the Ubuntu default that limits exactly those namespaces. | `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` |
| `WebContext.set_preferred_languages(["uk"])` makes `navigator.language` `uk`. With `GLib.set_prgname` and the application id, X11 reports `WM_CLASS` instance `org.delegatus.Delegatus`. | probe log, `xprop` |
| `Gtk.Application` without a session bus still registers and runs (non-unique). | probe log `registered= True` |

**Rejected:**

- **App-mode window of an installed browser** (`chromium --app=`, with
  `xdg-open` as the fallback). Stock Ubuntu ships only Firefox, which has no
  app mode. Ubuntu's `chromium` deb is a transitional package that installs a
  snap, so no browser can be a declared dependency. The fallback is a browser
  tab, which fails "its own window" on a stock install. The install, progress
  and busy-port screens would still need a second toolkit such as `zenity`.
- **GTK 4 + WebKitGTK 6.0.** It is the newer API, but its mandatory sandbox
  crashed in a container. Whether it runs on a stock Ubuntu desktop under the
  AppArmor namespace restriction was not established here. WebKit2 4.1 leaves
  its sandbox off unless enabled, so the question does not arise. The page it
  shows is only Delegatus's own loopback origin, and every other origin opens
  in the default browser (§4).
- **A compiled shell** (C, Vala, Go or Rust webview, Tauri). It uses the same
  WebKitGTK underneath and adds a toolchain, per-architecture binaries and two
  packages. Tauri adds Rust and an npm build on top.
- **Electron or a bundled Chromium.** Excluded by point 3, and the probe shows
  that the system web view is enough.

## 2. The package

```
/usr/lib/delegatus-app/delegatus-app           entry, #!/usr/bin/python3 -I
/usr/lib/delegatus-app/delegatus_app/core.py    manifest, discovery, probe, /proc listener, installer (no GTK)
/usr/lib/delegatus-app/delegatus_app/window.py  GTK 3 + WebKit2 4.1 window and state machine
/usr/lib/delegatus-app/delegatus_app/strings.py en and uk texts, the same keys
/usr/lib/delegatus-app/runtime-manifest.json    from manifest.ts (§3)
/usr/lib/delegatus-app/app.json                 {"version", "repository"} for the update check
/usr/lib/delegatus-app/delegatus.tgz            pr mode only; refused by the installer in a release manifest
/usr/share/applications/org.delegatus.Delegatus.desktop
/usr/share/icons/hicolor/scalable/apps/org.delegatus.Delegatus.svg
/usr/share/icons/hicolor/{16,32,64,128,256,512}x…/apps/org.delegatus.Delegatus.png
/usr/share/doc/delegatus/copyright             DEP-5 header + LICENSE at build time
/usr/share/doc/delegatus/changelog.gz          one entry, dated from SOURCE_DATE_EPOCH
```

The source lives in `linux/` (`linux/delegatus-app`, `linux/delegatus_app/*.py`,
`linux/tests/test_*.py`, `linux/org.delegatus.Delegatus.desktop`,
`linux/copyright.in`), mirroring `macos/`.

**Control.** `Package: delegatus`, `Version` from `package.json` (the first `-`
becomes `~`, so `2.1.0-rc.1` sorts before `2.1.0`), `Architecture: all`,
`Section: devel`, `Priority: optional`, `Homepage: https://delegatus.org`, and
`Maintainer: Delegatus <noreply@delegatus.invalid>`. lintian 2.122 accepts that
address. It names nobody, which the privacy gate requires of any address in a
committed file, and the repository publishes no contact address. The copyright
`Source:` and `app.json` `repository` come from `$GITHUB_REPOSITORY` at build
time, as `DelegatusReleaseRepository` does for the Mac app, so no committed
file names the account.

**Desktop entry.** `Name=Delegatus`, `Comment` and `Comment[uk]`, `Keywords`
and `Keywords[uk]`, `Exec=/usr/lib/delegatus-app/delegatus-app`,
`Icon=org.delegatus.Delegatus`, `Terminal=false`, `Categories=Development;`,
`StartupNotify=true`, `StartupWMClass=org.delegatus.Delegatus`. The application
id, the desktop file name, the icon name, `GLib.set_prgname` and
`Gdk.set_program_class` are all `org.delegatus.Delegatus`, so GNOME matches the
window to the entry on Wayland (app id) and X11 (`WM_CLASS`).

**No maintainer scripts.** dpkg's own triggers from `hicolor-icon-theme` and
`desktop-file-utils` refresh the menu and the icon cache. Nothing runs as root
except dpkg unpacking `/usr` files. `apt remove` or `purge` removes exactly
those files, because the package has no conffiles. A Delegatus that the app
started keeps running from the per-user runtime.

**Rejected:**

- **Bun and Delegatus inside the `.deb`.** Point 2 requires a per-user install
  of the exact release on first run. A root-owned package root would also tie
  Delegatus versions to apt and away from the product's Update dialog.
- **Per-architecture packages.** The payload holds no binary, and the first
  run picks the Bun archive for `uname -m`. An `all` package also installs on
  armhf, i386 and others, where the app's first screen says the processor is
  unsupported.
- **A command in `/usr/bin`.** Its name would compete with the CLI's
  `delegatus` in `~/.bun/bin`, and lintian then wants a manual page. The menu
  entry is the interface.
- **An `unzip` dependency.** Python's `zipfile` unpacks the Bun archive.

## 3. Shared with the Mac app, and Linux-only

| Piece | Shared | Linux-only |
| --- | --- | --- |
| Runtime manifest | `scripts/mac-app/manifest.ts` gains `LAUNCHER_PLATFORM=linux` (default `darwin`, Mac output unchanged except a new `"platform"` key that Swift's decoder ignores). It selects `bun-linux-aarch64.zip` for key `arm64` and `bun-linux-x64-baseline.zip` for key `x86_64`; both names are present in Bun 1.4.0's `SHASUMS256.txt`. The Dockerfile pin, the `SHASUMS256.txt` check, the registry identity, `gitHead` and publisher-integrity checks, `bundle:delegatus.tgz` in pr mode and the schema are unchanged. `manifest.test.ts` gains the Linux names. | — |
| Icon | `scripts/mac-app/icon.ts` unchanged; the Linux build copies its PNGs into hicolor sizes and the SVG as `scalable` | — |
| Integrity at first run | the contract of `macos/Resources/setup-runtime.sh`: lock, staging inside `runtime/`, HTTPS-only download, Bun SHA-256 against the manifest, `bun --version` equals the pin, tarball sha512 against `integrity`, `bun add --exact` in a staging folder with `{"private":true}` and a staging `HOME`, `package.json` name and version, the three required files, rename-publish, never replace an existing package root, roll back on failure or cancel, the newest Bun kept | Python implementation in `core.py` (`fcntl.flock`, `hashlib`, `zipfile`, `urllib` with a redirect handler that refuses non-HTTPS). `macos/` stays untouched: the script hard-codes `lockf`, `plutil`, `shasum` and `stat -f`, and the «HEAD 404» lane is changing the Mac app now. |
| Probe | the rule of `mac-launcher.md` §4 and `docs/guide/configuration.md` "For launcher authors", under every gate: one HEAD with no proxy, no redirect and a 2 s timeout; `204` + marker is Delegatus; `401`/`403` retried once with the key only after the listener is verified (§5); refused connection is free; a timeout is "not yet". The key comes from `LLV_TOKEN`, else `<config>/delegatus/token`, else the legacy `agent-log-viewer/token`; it is held in memory and redacted from logs. | `http.client` (no proxies, no redirects) |
| Who holds the port | — | `/proc/net/tcp{,6}` LISTEN rows for the port, their uid and inode; then this user's `/proc/<pid>/fd` links to find the owner; `cmdline` (exact argv) and the parent from `stat` (§5) |
| Product commands | `<bun> <cli.mjs> --no-open --port 8898`, `stop --all`, `service install --port 8898`, `service remove`, the Update dialog event `llv:open-self-update` | `systemctl --user start delegatus.service` in place of `launchctl` |
| Texts | the Mac keys and wording where the meaning is the same | `strings.py`, en and uk, with Linux paths and terms |

## 4. Window behaviour

- **Layout.** A `Gtk.ApplicationWindow` of 1100×780 (minimum 680×500) with a
  `Gtk.HeaderBar` holding Back, Forward, Reload and a menu button. A
  `Gtk.Stack` switches between the status view (icon, title, detail, buttons)
  and the web view. Menu: Check for Updates…, Start at Login (a toggle), Start
  Delegatus, Stop Delegatus, Open Logs, Open in Browser, About, Quit (Ctrl+Q).
  A second launch presents the existing window through `Gtk.Application`
  uniqueness.
- **Language.** `uk` when the first of `LANGUAGE`, `LC_ALL`, `LC_MESSAGES`,
  `LANG` that is set (with C/POSIX treated as unset) starts with `uk`, and
  `en` otherwise. The same value goes to the CLI as `LLV_LANG` and to WebKit
  through `set_preferred_languages`, so the web UI's `navigator.language`
  follows.
- **Web data.** A `WebsiteDataManager` with data at
  `~/.local/share/delegatus/webview` and cache at `~/.cache/delegatus/webview`.
  The cookie manager's persistent storage is an SQLite file there, so the
  key's 30-day cookie and the UI's saved settings survive restarts. The first
  load of a keyed Delegatus is `/?k=<key>`, as on the Mac.
- **Navigation.** `decide-policy` keeps navigation inside
  `http://127.0.0.1:8898`. Any other origin opens in the default browser
  through `Gio.AppInfo.launch_default_for_uri` and is ignored in the view. A
  same-origin `window.open` gets its own window with a related view. File
  inputs, downloads and JavaScript dialogs use WebKitGTK's defaults.
- **Microphone.** `enable-media-stream` is on. `permission-request` grants
  `UserMediaPermissionRequest` only while the view's URI has the Delegatus
  origin and denies every other request. CI does not verify the microphone
  (Deferred).
- **Status states**, each with its own title, detail and buttons:
  `needs-install` (Install, Quit); `installing` (step line, Cancel, Open
  Logs); `starting`; `stopped` (Start); `port-busy` and `other-user` (Try
  Again, Open Logs); `older-delegatus` (Open in Browser, Try Again, Open
  Logs); `failed` (log tail, Try Again, Open Logs); `unsupported` (for a
  processor without a Bun build).
- **Closing.** While Delegatus runs, closing the window or Quit asks: "Keep
  Delegatus running?" with Keep Running and Quit, or Cancel. During an install
  it cancels the installer, waits for its rollback, then quits.
- **Logs.** Each launch writes `~/.local/state/delegatus/logs/app-<time>-<pid>.log`
  (mode 0600, newest ten kept), with the home path replaced by `$HOME` and the
  key redacted, using the Mac's two patterns. Open Logs opens that folder in
  the file manager. Under start at login, the failure view shows the tail of
  `journalctl --user -u delegatus.service -n 60 -o cat`.
- **Log vocabulary** (the smoke reads it): `STATE <state> …`, `PROBE …`,
  `LISTENER <class> …`, `WEB loaded status=<n> language=<lang>`.

## 5. Discovery, launch decision and the port

**Discovery** (first match wins, every launch):

1. **An owned user unit.** `systemctl --user show delegatus.service
   --property=FragmentPath --value` (5 s bound; skipped when `systemctl` or the
   user manager is missing) names a regular file that this uid owns, whose
   first line is `# ` + `SERVICE_MARKER` (`bin/login-service.mjs:8`). Its
   `ExecStart=` arguments (quoted, with `\\`, `%%` and `$$` unescaped) give
   the Bun and the `cli.mjs`. Its `Environment=` lines are added to every
   child, as the Mac app does with the plist's `EnvironmentVariables`. A
   `--port` other than 8898 shows the `service-port` message.
2. **The private install**, when `runtime/bun/bin/bun` and
   `runtime/packages/node_modules/delegatus-cli/bin/cli.mjs` exist and the
   package is valid.
3. **A Bun global install**: `~/.bun/bin/bun` with
   `~/.bun/install/global/node_modules/delegatus-cli`.
4. **Nothing**: the first-run question.

A found install runs as it is, and no second copy is ever installed beside it.
Children get the app's environment plus `PATH` (the install's Bun directory,
`~/.bun/bin`, `~/.local/bin`, then the session `PATH` or
`/usr/local/bin:/usr/bin:/bin`), `LLV_LANG` and `NO_COLOR=1`. No shell profile
is read or written.

**Listener classes.** When the probe at launch is anything but `ready` or
`free`, the app reads who listens on the port:

| Class | Evidence | What the app does |
| --- | --- | --- |
| `own-install` | the listener's uid is this user's; its argv has an element ending in `/dist/runtime-host.mjs` or `/dist/standalone/server.js`; an ancestor (or the PID the app started) has argv `[<bun>, …, <root>/bin/cli.mjs, …]`, whose `<root>/package.json` names `delegatus-cli`; and `<root>` is the discovered install | treat as starting: the start wait below, no new process |
| `other-delegatus` | the same evidence for another `delegatus-cli` root | `older-delegatus` view naming its version from `<root>/package.json` |
| `program` | this user's process with neither shape | `port-busy`: "Port 8898 is in use by **<comm>** (process <pid>). Quit that program, then press Try Again." |
| `other-user` | the LISTEN row's uid differs, or no fd of this user owns the inode | `other-user` view |

The key retry in the probe is sent only to `own-install` or `other-delegatus`,
the classes where the listener runs `delegatus-cli` code as this user. That
code can already read the key file. A `ready` answer from either class is
reused, so a healthy Delegatus that a terminal started from the global install
is used as it is. The Mac app verifies only the discovered install. Linux
widens this because any `delegatus-cli` of this user shares the state directory
and `stop --all` reaches it. The app never signals a listener.

**The launch decision:**

1. Probe `ready` and listener `own-install` or `other-delegatus`: reuse, log
   `STATE reused`.
2. Probe `free`: with no install, ask the first-run question (§6). With the
   private Bun older than the pin, run the installer, which replaces only Bun.
   With an owned unit, run `systemctl --user start delegatus.service`.
   Otherwise spawn `<bun> <cli.mjs> --no-open --port 8898` in a new session
   (`start_new_session=True`), with output to the app log.
3. Anything else: classify the listener as above.

**The start wait.** Probe every 500 ms for up to 180 s. A `404`, a `503` or a
timeout from the listener counts as "not ready yet" until the deadline. The
listener must classify as `own-install` before the app reports `ready`. A
spawned launcher that exits gets 30 s more, for a launcher already starting
elsewhere. The failure view shows the exit code and the log tail.

**Stop** runs `<bun> <cli.mjs> stop --all` after the Mac's confirmation and
waits up to 60 s for a free port. **Start at Login** runs `service install
--port 8898` or, after a confirmation, `service remove` followed by a direct
start, as on the Mac. **Liveness**: a probe every 15 s while the web view
shows. Two failures switch to `stopped`, and an answer returns the web view.

## 6. First run and updates

**The question** (once, in the status view): "Install Bun <pin> and Delegatus
<version> for this user? About <N> MB plus dependencies will download from
GitHub and npm into ~/.local/share/delegatus. No administrator password is
needed, and your shell settings stay as they are. You will connect Claude Code
or Codex later, in Delegatus's setup guide." Buttons: Install, Quit. `N` comes
from the manifest's `bytes`. `--accept-install` (smoke only; a web page cannot
pass arguments) answers it.

**The installer** runs as a child, `delegatus-app --install <runtime>
<manifest>`, in its own process group. Each step prints `SETUP 1/3`, `SETUP 2/3`
or `SETUP 3/3`, which the status view shows. Cancel sends `SIGTERM` to the
group, and the child's handler kills `bun add`, removes the staging folder and
restores the previous Bun. A failure shows the last log lines, Try Again and
Open Logs. Afterwards the app starts Delegatus (§5), whose setup guide signs the
user in to Claude Code or Codex. The app never runs those CLIs.

**Updates**, the same as the Mac app's §6:

- Check for Updates… dispatches `llv:open-self-update` in the web view. The
  product's Update dialog moves the per-user Delegatus forward, verifies its
  provenance, keeps the package root in place and can roll back.
- It also reads `https://api.github.com/repos/<repository>/releases/latest`.
  When that tag is newer than `app.json`'s version and the release carries
  `delegatus_<version>_all.deb`, a dialog offers Download, which opens the
  asset in the default browser. The user installs it with apt or the software
  centre.
- A newer package never reinstalls the package root. Bun moves with the
  package: on a launch with a free port, a private Bun older than the pin is
  replaced by one rename.

## 7. Build script and inputs

`scripts/linux-app/build.sh pr|release OUTPUT [TARBALL]`, the same interface as
`scripts/mac-app/build.sh`:

- **Inputs.** A checkout after `bun install --frozen-lockfile` (for `sharp`);
  in pr mode the `npm pack` tarball of that checkout, and in release mode the
  tag checkout with optional `EXPECTED_INTEGRITY`; `GITHUB_REPOSITORY`
  (`owner/name`); and `SOURCE_DATE_EPOCH`, which defaults to `git log -1
  --format=%ct`. Tools: `bun`, `python3`, `dpkg-deb`, `gzip`.
- **Network.** Bun's `SHASUMS256.txt` and the two Linux Bun zips from GitHub,
  and the npm registry in release mode. These are the requests the Mac build
  makes, with other archive names.
- **Steps.**
  1. `LAUNCHER_PLATFORM=linux bun scripts/mac-app/manifest.ts …` (in pr mode,
     the tarball is also copied as `delegatus.tgz`).
  2. `bun scripts/mac-app/icon.ts` writes the hicolor PNGs, and the SVG is
     copied from `public/brand/delegatus-touch-icon.svg`.
  3. Copy `linux/`, write `app.json`, `copyright` and `changelog.gz` (`gzip
     -9n`, dated `date -u -R -d @$SOURCE_DATE_EPOCH`), then `control` with
     `Installed-Size` and `md5sums`.
  4. `python3 -I -m unittest discover -s linux/tests`.
  5. Modes 0644/0755, `touch -h -d @$SOURCE_DATE_EPOCH`, then `dpkg-deb
     --root-owner-group -Zxz --build`.
  6. Write `delegatus_<debversion>_all.deb.sha256`.

  Two builds with the same inputs and epoch gave identical hashes in the
  `debian:13` trial for this design.
- **From a checkout by hand:** `npm pack --pack-destination <scratch>`, then
  `GITHUB_REPOSITORY=<owner/name> bash scripts/linux-app/build.sh pr <scratch>/out
  <scratch>/delegatus-cli-<v>.tgz`.

## 8. CI: `.github/workflows/linux-app.yml`

Triggers `pull_request`, `workflow_dispatch` and `workflow_call` (inputs `mode`,
`tag`, `integrity`), with the same concurrency as `macos-app.yml`.

| Job | Runner | Does |
| --- | --- | --- |
| `scope` | `ubuntu-latest` | `ci-platform-scope.ts --workflow .github/workflows/linux-app.yml` with prefixes `linux/`, `scripts/linux-app/`, `scripts/mac-app/manifest.ts`, `scripts/mac-app/icon.ts`, `bin/`, `src/app/api/onboarding/`, `src/proxy.ts`, `Dockerfile`, `.github/workflows/publish.yml`. A skipped leg reports success. |
| `pack` (pr mode) | `ubuntu-latest` | the `macos-app.yml` pack steps; uploads `linux-app-package` |
| `Linux app build` | `ubuntu-24.04` | build twice and compare hashes; `dpkg-deb -c` and `-e` content checks; `lintian --fail-on error,warning` in `debian:13`, with its negative case; uploads `linux-app-deb` |
| `Linux app smoke (<image>, <arch>)` | job `container:` on `ubuntu-24.04` (amd64: `ubuntu:24.04`, `ubuntu:26.04`, `debian:13`) and `ubuntu-24.04-arm` (arm64: `ubuntu:26.04`) | `apt-get install ./delegatus_*_all.deb` from a fresh image, then smoke tools, then `python3 -I scripts/linux-app/smoke.py <deb> <report>`; uploads the report and frames |

**The smoke driver** (`scripts/linux-app/smoke.py`) is the one driver for this
surface, and later cases are added to it. It refuses to run outside a
container with `CI=true`. It runs as root only to install, create the
unprivileged user `tester` and remove the package. It runs every app launch as
`tester` under one `Xvfb` it starts (`-screen 0 1280x800x24`) and
`dbus-run-session`. The command comes from the installed desktop entry's
`Exec=`, without a shell. Each case gets an empty home, and the install cases
share one on purpose. The container's network namespace keeps port 8898 off
the host. The driver stops what it started by recorded PID, or through `stop
--all`.

**Cases, in order.** Each verdict names the observation that can turn it red
and its negative control. The driver records each outcome in `report.json`, and
the job fails when a verdict fails or a negative control passes.

| # | Case | Verdict (red when …) | Negative control |
| --- | --- | --- | --- |
| V1 | build: lintian | an error or warning tag appears | the package copy without `usr/share/doc/delegatus/copyright` must fail lintian |
| V2 | build: reproducible | the two hashes differ | a build with `SOURCE_DATE_EPOCH+1` must differ |
| V3 | build: root footprint | `dpkg-deb -c` lists a path outside `/usr/lib/delegatus-app/`, `/usr/share/applications/`, `/usr/share/icons/hicolor/` and `/usr/share/doc/delegatus/`; or the control holds anything besides `control` and `md5sums`; or a release-mode package holds `delegatus.tgz` | the same checker on a copy with an added `postinst` must fail |
| V4 | dependencies | after `apt-get install ./deb` on the fresh image, `delegatus-app --check-imports` (requires `Gtk 3.0` and `WebKit2 4.1`, no display) fails | before that, the same check in the image with only `python3-gi` installed must fail and name `WebKit2` |
| V5 | `confirm` | without `--accept-install`, after 20 s the log lacks `STATE needs-install`, or anything exists under `~/.local/share/delegatus/runtime` | V7 shows that the same file check sees the runtime once installed |
| V6 | window | no mapped top-level window titled `Delegatus` with `WM_CLASS` `org.delegatus.Delegatus` and `_NET_WM_PID` equal to the app's PID; or its frame (`import -window <id>`) has pixel standard deviation ≤ 0.02 | the window check on the display before launch must fail; the deviation check on the blank root frame must fail |
| V7 | `first-run` (`--accept-install`, `LANG=en_US.UTF-8`) | within 12 min: no `HEAD` 204 with the marker, no `GET /` 200 from 8898, the listener's launcher argv is not `…/.local/share/delegatus/runtime/bun/bin/bun …/runtime/packages/node_modules/delegatus-cli/bin/cli.mjs`, or the log lacks `STATE ready` and `WEB loaded status=200 language=en`; V6 is also checked here | the readiness function against the V10 stub must report not ready |
| V8 | home confined | the before/after listing differs outside `.local/`, `.config/` and `.cache/`, or any of `.profile`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile` and `.config/fish/` appears or changes | the comparator on a listing with a planted `.profile` change must fail |
| V9 | `reuse` (end the app by PID, relaunch with `LANG=uk_UA.UTF-8`) | the log lacks `STATE reused` or `WEB loaded status=200 language=uk`, or the launcher PID changed | the first launch in V7 logged `STATE ready` and not `reused` |
| V10 | `busy-port` (`stop --all`, then a Python listener answering `HEAD` with 404 that records `Authorization` headers) | the log lacks `STATE port-busy` with `python3` and the stub's PID, a new `cli.mjs` process appears, or the stub saw an `Authorization` header | V9 shows that a Delegatus listener is not called busy |
| V11 | `older-delegatus` (a fake `delegatus-cli` 1.11.0 tree whose `bin/cli.mjs`, run by the private Bun, spawns `dist/runtime-host.mjs` that answers 404) | the log lacks `STATE older-delegatus 1.11.0`, or a new `cli.mjs` from the private install appears | in V10 the foreign stub must not be classified `older-delegatus` |
| V12 | `booting` (the driver starts the private install's CLI itself and launches the app at once) | the log shows `STATE port-busy` or `older-delegatus`, or lacks `STATE ready`/`reused` within 180 s | V10 shows that the busy classification is reachable |
| V13 | removal (root: `stop --all` as `tester`, then `apt-get remove -y delegatus` and `purge`) | any path from the earlier `dpkg -L delegatus` that is a file still exists, or `~tester/.local/share/delegatus/runtime/packages/node_modules/delegatus-cli/package.json` or `~tester/.config/delegatus/` is gone | the file check run before removal must fail; the data check on an empty scratch home must fail |

Frames kept as artifacts: `needs-install` in en and uk, `port-busy`,
`older-delegatus`, and the loaded window in en and uk. They are evidence for a
person; the deferred chrome review uses them. The report redacts the key and
the case homes, as the Mac smoke does.

**Installer checks** (`linux/tests/test_install.py`, in the build job; network
for the real Bun zip): a bad Bun SHA-256 and a damaged `delegatus.tgz` are
refused with nothing published; `bundle:` is refused in a release manifest; a
held lock refuses a second install; `SIGTERM` during `bun add` leaves no
`packages`, no stage and the previous Bun. `linux/tests/test_core.py` covers
probe classification, `ExecStart`/`Environment` parsing, `/proc/net/tcp` row
parsing, listener classes over a fake `/proc` tree, language choice and en/uk
key parity.

**Required checks.** After the workflow lands, the seat adds `Linux app build`
and the smoke legs to main's branch protection. Until then, a green run on the
pull request's head is the evidence.

## 9. Release and documents

`publish.yml` gains two jobs and changes none:

```yaml
  linux-app:
    needs: [verify-tag, github-release, publish]
    uses: ./.github/workflows/linux-app.yml
    with:
      mode: release
      tag: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}
      integrity: ${{ needs.publish.outputs.integrity }}
  attach-linux-app:
    needs: [verify-tag, linux-app]
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:  # download linux-app-deb, then:
      - run: gh release upload "$RELEASE_TAG" linux-app/*.deb linux-app/*.sha256 --clobber
```

A failed Linux leg leaves the release without the `.deb`. npm, the DMG and the
notes are unaffected, and a dispatch for the tag retries.

Documents:

- **README Quick start.** After the Mac paragraph: "**On Ubuntu or Debian:**
  download `delegatus_<version>_all.deb` from the latest release, run `sudo
  apt install ./delegatus_<version>_all.deb` (or open it in your software
  centre), then start **Delegatus** from the applications menu. The app
  installs Bun and Delegatus for your user and opens the setup guide." Use the
  same relative release link.
- **`docs/guide/getting-started.md`.** In "Choose how to install", a **Linux
  package** item after the Mac app. In "Open Delegatus as an app", a Linux
  paragraph covering the menu, Keep Running, removal (`sudo apt remove
  delegatus` keeps `~/.local/share/delegatus`, `~/.config/delegatus` and a
  login service; `delegatus service remove` first if Start at Login was on)
  and how to delete the private runtime. In "If something does not start", the
  older-Delegatus message.
- **`docs/RELEASING.md`.** One paragraph: the `.deb` is built once, smoke-tested
  in Ubuntu and Debian containers on amd64 and arm64, and attached with its
  checksum; it is unsigned and there is no apt repository.
- **`CHANGELOG.md`**, under Unreleased → Added: "**Linux desktop package.**"
- `docs/design/mac-launcher.md` is left alone, because the «HEAD 404» lane is
  editing it. This document replaces its "Linux launchers" deferral.

## Facts not established here

- **A software-centre double click** on Ubuntu 26.04 and Debian 13. CI proves
  `apt install ./file.deb`. The double click relies on the package being a
  standard, lintian-clean `.deb`.
- **WebKit2 4.1 on a real Wayland desktop.** The probe and the smoke use X11
  (Xvfb). GTK 3 picks Wayland on its own and the web view is the same.
- **The Mac lane's answer to an older Delegatus.** That lane is still
  diagnosing and had published no branch when this was written. The Linux
  classes above need nothing from it. If it chooses "stop and replace", the
  Linux app can adopt that later (Deferred).

## Validation against the requirement

| Requirement | Where |
| --- | --- |
| 1. `.deb` for amd64 (arm64 at no cost), reproducible, no extra build network | §2 `all`, §7, V2, smoke on arm64 |
| 2. Menu entry with icon, own window, no terminal, per-user install with the Mac's integrity discipline, start, reuse, busy-port message, updates, nothing root beyond package files, profiles and state untouched, removal keeps data | §2, §3, §4, §5, §6; V3–V13 |
| 3. Stock dependencies; simplest window; no bundled browser | §1, §2; V4 |
| 4. CI build, package check, clean install, virtual display, ready, window with screenshot, removal, negatives | §8 |
| 5. Release attachment and documents | §9 |
| 6. English and Ukrainian | §4 language, `strings.py`, V7/V9, en and uk frames |

## Deferred — not currently justified

- An apt repository, and with it updates of the package through apt.
- Signing the package or a repository.
- RPM, Flatpak, Snap, AppImage and other formats.
- A rendered design review of the window chrome. The smoke keeps frames for
  one.
- Verifying the microphone in the Linux window.
- AppStream metainfo for richer software-centre pages.
- Stopping and replacing an older Delegatus from the app.
- A port setting, and stopping the process that holds the port. These are the
  Mac app's deferrals, for the same reasons.
- Start at login exercised in CI (`bin/login-service.test.ts` covers the
  command), and an update rehearsal from one package to the next.
- A dark-theme frame set, and a Wayland smoke leg.
- WebKitGTK 6.0 / GTK 4, once its sandbox is shown to run on stock Ubuntu.

## Build plan

One builder, in this order. Every test runs by path, with `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under the stage's temporary
root. Docker runs use the default bridge network, never `--network host`.
Nothing runs on this machine's port 8898.

1. **Shared manifest.** Add `LAUNCHER_PLATFORM` to `scripts/mac-app/manifest.ts`
   (archive table per platform, a `platform` key in the output) and Linux cases
   to `scripts/mac-app/manifest.test.ts`. Run that test file through
   `scripts/gate-slot.sh bun test`.
2. **`linux/delegatus_app/core.py`**: manifest load, language, child
   environment, discovery (unit parsing), probe, `/proc` listener classes,
   start wait and installer, with `linux/tests/test_core.py` and
   `test_install.py`.
3. **`strings.py`** (en and uk, Mac keys plus `older-delegatus`, `other-user`,
   `unsupported` and Linux paths).
4. **`window.py`** and the entry `linux/delegatus-app` (`--install`,
   `--check-imports`, `--accept-install`), the desktop file and
   `copyright.in`.
5. **`scripts/linux-app/build.sh`.** Build a pr-mode package from `npm pack` in
   scratch, then run lintian in `debian:13`.
6. **`scripts/linux-app/smoke.py`** and `.github/workflows/linux-app.yml`. Run
   one leg locally with `docker run --rm -e CI=true` on `ubuntu:26.04`, through
   `scripts/gate-slot.sh`, before publication.
7. **`publish.yml`** jobs `linux-app` and `attach-linux-app`.
8. **README, getting-started, RELEASING, CHANGELOG.** Run the privacy
   publication gate on the branch.

## Acceptance checks

1. `bun test scripts/mac-app/manifest.test.ts` passes, including the Linux
   archive names, and the Mac manifest for the same inputs differs only by
   `"platform": "darwin"`.
2. `python3 -I -m unittest discover -s linux/tests` passes.
3. `bash scripts/linux-app/build.sh pr …` twice gives identical `.deb` hashes,
   and `lintian --fail-on error,warning` in `debian:13` passes (V1–V3 with
   their negative controls).
4. On the pull request head, `Linux app build` and all four
   `Linux app smoke` legs are green. `report.json` in each leg shows V4–V13
   passed and every negative control went red, and the frames show the
   Delegatus page in en and uk.
5. `git diff origin/main --stat` touches only `linux/`, `scripts/linux-app/`,
   `scripts/mac-app/manifest.ts`, `scripts/mac-app/manifest.test.ts`,
   `.github/workflows/linux-app.yml`, `.github/workflows/publish.yml`,
   `README.md`, `docs/guide/getting-started.md`, `docs/RELEASING.md`,
   `CHANGELOG.md` and this document. Nothing under `macos/` changes.
6. `bun scripts/privacy-publication-gate.ts --base <merge-base>` passes.
7. After the next release tag, the GitHub Release lists
   `delegatus_<version>_all.deb` and its `.sha256` beside the DMG
   (verified after merge by whoever cuts the release).

## Prior work consulted

`docs/design/mac-launcher.md` and the code it describes on main (`macos/`,
`scripts/mac-app/`, `macos-app.yml`, the `mac-app` and `attach-mac-app` jobs),
`bin/login-service.mjs` and `bin/service-manager.mjs` for the Linux unit, and
`docs/guide/configuration.md` "For launcher authors". `search_transcripts` for
the Mac «HEAD 404» found the lane diagnosing it, whose hypotheses (an older
Delegatus without the 2026-10-25 diagnostics route, or a booting server) shaped
§5. No earlier Linux package design or memory existed.
