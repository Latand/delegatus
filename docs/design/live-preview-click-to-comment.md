# Live app preview with click-to-comment: design

Design only. Nothing here is built. Code references are to revision
`662a6012b39f` of `main` (2026-11-11). Vendor facts were read on 2026-11-11
and carry their source. Measurements were taken on 2026-11-11 between 13:03
and 13:10 UTC on the installation this design was written on.

Revision 1 (2026-11-11) answers the first review round: the dev server's own
port, the login on a separate preview site, the capture browser's network
reach, the crop's path into the message box and what production React still
names. §12 lists each change and what was re-checked for it.

## 0. The originating requirement

The board task, created 2026-10-23 from the operator's decision form on the
competitor research (question 2), quoted from the pinned task:

> Живий перегляд застосунку з кліком на елемент
> Агент запускає dev-сервер, оператор бачить результат у Delegatus і може
> клікнути елемент, щоб він пішов коментарем агенту. Велике й ризиковане:
> спершу окремий дизайн, після першої партії ідей з конкурентів.

In English: "Live app preview with a click on an element. The agent starts a
dev server, the operator sees the result in Delegatus and can click an
element so that it goes to the agent as a comment. Big and risky: a separate
design first, after the first batch of competitor ideas."

In that form the operator chose the recommended timing for this item: after
the first batch, as a separate design, and left no comment. The first batch
has merged: #3257 (2026-10-25), #3264 (2026-10-25), #3265 (2026-11-03) and
#3263 (2026-11-04 14:29 UTC), each read from the forge on 2026-11-11.

The idea comes from two rows of
[`docs/research/competitors-2026-10.md`](../research/competitors-2026-10.md).
Rank 2 ([line 109](../research/competitors-2026-10.md#L109)) proposed as a
first slice: "Support one explicitly configured local dev command for one
workspace, an assigned free port, readiness probe, logs, and stop of its owned
process. Open a separate origin. Embedding and remote forwarding can follow."
Rank 5 ([line 112](../research/competitors-2026-10.md#L112)) proposed: "For an
opted-in preview, capture the selected element's text/selector and preview
revision into a visible draft message. Validate the frame and message shape;
send only after the operator reviews it. Source mapping is optional."

The requirement has three parts, and this design is checked against each:

- **(a)** an agent starts a dev server;
- **(b)** the operator sees the result in Delegatus;
- **(c)** the operator clicks an element and it reaches that agent as a comment.

It does not ask for editing in the preview, browser developer tools, previews
of other machines, or several repositories at once. Those stay deferred (§9).

## 1. The recommendation on one page

| Question | Recommendation | Why, in one line |
| --- | --- | --- |
| First slice | **Point at a picture**: in a conversation's full-screen image viewer, tap a spot on any picture, write a note, and the note plus a marked crop land in that conversation's message box. | No new route, process, store or trust surface; works on the phone and over the network; useful the day it ships (§6.1). |
| How the result reaches the operator | **Pictures first, live later.** Slice 2 adds a "Capture" button that photographs the agent's running app at phone and desktop width, with an element map for precise picking. A live embedded app is slice 4. | The operator works from a phone too (every change owes a 390 px view), and a phone's browser never runs on the machine that runs the dev server. Every live option for a remote browser needs a second web address to keep the app's code away from the operator's Delegatus session (§5.2). |
| Who owns the dev server | **The agent, as today, until the operator asks for more.** Slice 3 lets Delegatus start it from a command the operator approves once per project, boxed like the setup command. | Today an agent's dev server already ends with the agent's own process tree (§3.2). A product-owned server is needed only to look at a lane after its agent has finished. |
| Where a comment goes | **Into the conversation's message box as a draft.** The operator sends it with Send. | The operator sees and can edit what page text goes to the agent under their name; delivery reuses the composer's receipts (§5.4). |
| Who may use it on a team installation | Slice 1: whoever can already send to that conversation. Slices 2 to 4: **the owner only at first** (question Q3). | Slice 1 adds no path; later slices add new routes and stores. |

No ADR now: slice 1 is a client control that one revert removes. Slice 4 adds
a listener and a second web address, which is hard to reverse, and would take
an ADR when it is chosen.

## 2. What the two competitor ideas actually do

Both repositories were cloned on 2026-11-11 at their current default-branch
heads and read without installing or running them. Both are Apache-2.0 at
these revisions (GitHub repository API, 2026-11-11). They are references for
behaviour only; no code is copied.

### 2.1 Vibe Kanban (rank 2 and rank 5)

Revision [`2d03b13`](https://github.com/BloopAI/vibe-kanban/tree/2d03b13cced7759ee94c5eb6e23ebd10cf00b063),
committed 2026-11-11 11:10 UTC. The research document read `d5cbb53`
(2026-09-19); the preview code has moved since.

- **The product owns the dev server.** Its documentation says: "Once you've
  saved a script, click **Start dev server** in the preview panel to launch
  it", logs "stream in real-time", and the URL is detected "automatically"
  ([workspaces/preview](https://vibekanban.com/docs/workspaces/preview), read
  2026-11-11). In code a dev server is an execution process that the workspace's
  run chain skips when it settles: "Never finalize DevServer processes"
  ([container.rs:203-215](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/services/src/services/container.rs#L203-L215)),
  and the URL is found by matching `http://localhost:NNNN`-style text in its
  output ([usePreviewUrl.ts:11-14](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/packages/web-core/src/shared/hooks/usePreviewUrl.ts#L11-L14)).
  The documentation does not say what happens to the server when a
  workspace closes.
- **A separate proxy listener and one origin per dev server.** "The proxy
  listens on a separate port and routes requests based on the Host header
  subdomain. A request to `{port}.localhost:{proxy_port}/path` is forwarded to
  `localhost:{port}/path`"
  ([preview-proxy/lib.rs:1-8](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/lib.rs#L1-L8),
  port taken from the Host label at
  [366-382](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/lib.rs#L366-L382)).
  It strips the app's `content-security-policy` and `x-frame-options`
  ([77-85](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/lib.rs#L77-L85)),
  drops the browser's `origin` header before forwarding
  ([proxy_common.rs:3-26](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/proxy_common.rs#L3-L26)),
  and injects four scripts into every HTML page: a console and network
  capture, a React DevTools hook, a click-to-component picker and an
  in-page devtools console
  ([88-98](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/lib.rs#L88-L98)).
- **The frame.** The iframe runs with `allow-scripts allow-same-origin …`
  ([PreviewBrowser.tsx:32-33](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/packages/ui/src/components/PreviewBrowser.tsx#L32-L33)),
  which is safe only because the `{port}.localhost` origin differs from the
  product's. A preview whose URL is not loopback "load[s] directly in the
  iframe — intentionally degraded: no bridge, no injected scripts, no
  Eruda/inspect mode"
  ([PreviewBrowserContainer.tsx:261-318](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/packages/web-core/src/pages/workspaces/PreviewBrowserContainer.tsx#L261-L318)).
  So its isolation needs the browser to run on the machine that runs the
  dev server.
- **The click.** "Click **Select element as context** in the toolbar to enter
  inspect mode, hover over any element to highlight it, then click to select
  … the component's details are sent to the chat as context"
  ([browser-testing](https://vibekanban.com/docs/browser-testing), read
  2026-11-11). The injected picker sends `framework`, the component name, a
  truncated `htmlPreview` of the element and up to three owner-stack entries
  with file, line and column when React exposes them
  ([click_to_component_script.js:190-232](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/click_to_component_script.js#L190-L232)),
  posted to the parent with target origin `'*'`
  ([15-21](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/click_to_component_script.js#L15-L21)).
  When no owner stack with source files is available, it falls back to
  component names it reads by walking up the fiber tree to composite fibers
  ([150-180](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/click_to_component_script.js#L150-L180),
  [219-233](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/crates/preview-proxy/src/click_to_component_script.js#L219-L233)).
  The parent accepts it only from its own iframe's window and puts it into a
  pending chat draft that the user sends
  ([PreviewBrowserContainer.tsx:453-470](https://github.com/BloopAI/vibe-kanban/blob/2d03b13cced7759ee94c5eb6e23ebd10cf00b063/packages/web-core/src/pages/workspaces/PreviewBrowserContainer.tsx#L453-L470)).
  The documentation warns: "Make sure the dev server is running a
  **development** build (production builds strip component metadata)".
- **The phone.** The preview offers a "Phone frame at 390×844, with device
  chrome" and a draggable responsive mode (browser-testing page). That is a
  phone-sized frame drawn on a desktop screen.
- **The older web companion** is an npm package the app itself installs; its
  README says it "adds point-and-click edit functionality to web apps, when
  used with Vibe Kanban", that "tree-shaking will remove
  vibe-kanban-web-companion from production builds", and that it is a fork of
  click-to-component
  ([vibe-kanban-web-companion](https://github.com/BloopAI/vibe-kanban-web-companion),
  read 2026-11-11). The 2026-11 documentation says the built-in inspector
  needs "no packages to install". The page the research cited,
  `docs/core-features/preview-mode`, answered 404 on 2026-11-11.

### 2.2 Emdash (rank 2)

Revision [`ccc6cce`](https://github.com/generalaction/emdash/tree/ccc6cce4a41627deb6888db6763f3de5ff0e4e08),
committed 2026-11-10 04:05 UTC.

- **The terminal owns the dev server.** Emdash watches terminal output and
  registers a preview target when a dev server prints its URL
  ([dev-server-bridge.ts:214-226](https://github.com/generalaction/emdash/blob/ccc6cce4a41627deb6888db6763f3de5ff0e4e08/apps/emdash-desktop/src/main/core/preview-servers/dev-server-bridge.ts#L214-L226)).
  A target closes on `pty-exit`, a failed local probe or a detached source
  ([preview-server-service.ts:24-56](https://github.com/generalaction/emdash/blob/ccc6cce4a41627deb6888db6763f3de5ff0e4e08/apps/emdash-desktop/src/core/features/preview-servers/node/preview-server-service.ts#L24-L56)),
  and stopping a preview interrupts the terminal that runs it
  ([261-288](https://github.com/generalaction/emdash/blob/ccc6cce4a41627deb6888db6763f3de5ff0e4e08/apps/emdash-desktop/src/core/features/preview-servers/node/preview-server-service.ts#L261-L288)).
  For SSH projects it forwards the port over the SSH connection (same file,
  `PortForwardService`).
- **The view is an Electron `<webview>`** with its own session partition
  ([browser-pane.tsx:147-155](https://github.com/generalaction/emdash/blob/ccc6cce4a41627deb6888db6763f3de5ff0e4e08/apps/emdash-desktop/src/core/features/browser/browser/browser-pane.tsx#L147-L155)),
  so cookies and storage are separate by construction. A web application
  has no such primitive.
- **No element picker** was found: `inspect`, `pickElement` and
  `selectElement` have no match under `core/features/browser`.

### 2.3 What carries over to Delegatus

Both tools assume the operator's browser runs on the machine that runs the
agents. Vibe Kanban's isolation rests on `*.localhost`, and it degrades a
remote preview on purpose; Emdash rests on Electron partitions. The
installation this design was written on runs with its access key enabled
(observed 2026-11-11: the Viewer process carries `LLV_TOKEN`; only the
variable names were read), and the
project's rendered-evidence rules ask for a 390 px phone view on every
change. A phone's browser never runs on the machine that runs the dev server.
Whether the operator ever uses a browser on that machine is unknown (U1). So
the competitor shape fits only the local case, and the phone case needs a
different first step (§5.2).

Ideas worth taking: the click lands in a **draft** the user sends; the picker
sends a **component name, an element excerpt and an owner stack** when the
framework exposes one, and **component names alone** when it does not;
previews need a **development build** for owner stacks and source locations;
one origin per dev server.

## 3. What Delegatus stands on today

### 3.1 Worktrees and processes

| What | Where | What it means here |
| --- | --- | --- |
| A lane's checkout | `git worktree add -b <branch> <worktreeDir> <baseRef>` in [git.ts:244-251](../../src/lib/pipelines/git.ts#L244-L251) | A dev server for a lane runs from this directory. The sweep keeps or removes it with a recorded reason ([worktreeSweep.ts:229](../../src/lib/pipelines/worktreeSweep.ts#L229)). |
| An agent's resource scope | `systemd-run --user --scope … MemoryMax=… OOMPolicy=continue … BindsTo=<viewer unit>` in [agentMemory.ts:80-89](../../src/lib/runtime/agentMemory.ts#L80-L89) | Everything the agent starts, a dev server included, counts against the agent's memory cap. |
| An agent's signal domain | `bwrap --unshare-user --unshare-pid --bind / / … --new-session --die-with-parent` in [agent-signal-sandbox.py:396-400](../../bin/agent-signal-sandbox.py#L396-L400) | A private PID namespace, the whole filesystem and the host network. A dev server is reachable on host loopback and lives inside the agent's PID namespace. |
| Tool network profile | Full-access stages run Codex with `danger-full-access`; restricted stages with `workspace-write` ([structuredSpawn.ts:226-251](../../src/lib/runtime/structuredSpawn.ts#L226-L251)) | Whether a restricted stage may listen on loopback is unverified (U7). |
| Background work an agent leaves running | Claude records background commands, monitors and wake-ups; Codex has none ([backgroundTasks.ts:10-41](../../src/lib/pipelines/backgroundTasks.ts#L10-L41)) | A dev server started with "run in background" is recorded as harness work. The listed records have no shape for a process started with `&` inside a command, so such a server is not tracked. |
| When a lane's host stops | "Terminal lanes and replaced attempts no longer own future work" ([hostRetirement.ts:11-17](../../src/lib/pipelines/hostRetirement.ts#L11-L17)) | The host is released once idleness is proved. |
| What a release cuts | Releasing an idle Claude host ends "harness background work its ended turn still waits on … with its process" ([structuredDeliveryController.ts:2746-2758](../../src/lib/runtime/structuredDeliveryController.ts#L2746-L2758)); every host is released before a Viewer release hands over, except a surviving native Codex listener ([2913-2928](../../src/lib/runtime/structuredDeliveryController.ts#L2913-L2928)) | Each Delegatus update that hands the Viewer to a new release ends the dev servers of Claude agents. |
| A product-owned process with a provable end | The owned runner starts `systemd-run --user --unit=<unit> … KillMode=control-group … MemoryMax=…`, stops it with `systemctl --user stop <unit>` and then inspects the exact cgroup ([owned-runner.ts:279-302](../../scripts/owned-runner.ts#L279-L302)) | The pattern a product-owned dev server or capture would reuse. |
| A project command run by the product | The setup recipe is a reviewed, hash-pinned command with a relative cwd ([setupRecipe.ts:9-10](../../src/lib/projects/setupRecipe.ts#L9-L10), [37-50](../../src/lib/projects/setupRecipe.ts#L37-L50)). It runs under `bwrap … --unshare-pid …` with a private home, read-only system trees, and only the checkout and a scratch directory writable ([setupExecution.ts:30-53](../../src/lib/pipelines/setupExecution.ts#L30-L53)) | The confinement a product-run dev command would reuse. It is stronger than an agent's own domain, which binds the whole filesystem. |
| CPU placement | Work runs in `delegatus-agents-work.slice` ([cpuPlacement.ts:25](../../src/lib/runtime/cpuPlacement.ts#L25)), with per-scope quotas ([116-118](../../src/lib/runtime/cpuPlacement.ts#L116-L118)) | A capture or a product-owned dev server goes there, below the Viewer. |

### 3.2 A dev server an agent starts today

Nothing in the product starts, registers or shows a dev server; the research's
search for `devServer` and `previewServer` found none
([competitors-2026-10.md:54](../research/competitors-2026-10.md#L54)), and a
search of this revision for `preview_register`, `devServer` and
`previewServer` under `src/` found none either. An agent that wants one runs it
from its shell. What follows is what such a server is today.

**Where it runs.** Inside the agent's scope and PID namespace (§3.1), on the
host network, with the agent's environment. That environment carries the
Viewer's `NODE_ENV`: both structured hosts start the child environment from
`{ NODE_ENV: source.NODE_ENV }`
([claudeStreamBrokerHost.ts:480](../../src/lib/runtime/claudeStreamBrokerHost.ts#L480),
[codexAppServerHost.ts:545](../../src/lib/runtime/codexAppServerHost.ts#L545)),
and the Viewer runs `next start` with `NODE_ENV=production` (observed in this
stage's own environment and the Viewer's, 2026-11-11). A Vite dev server
started in that environment pre-bundled `react-dom-client.production.js`, and
its React fibers carried no `_debug*` fields (probe in §11): no owner, no
owner stack and so no source location. Component names stay readable:
walking `fiber.return` up to the nearest function component and reading its
`type.name` returned `App`, and `Card` then `App` for an element inside a
`Card`, under production React too (revision-1 probe in §11, React 19.2.8;
the review round observed the same on 19.3.1). An agent's dev server today
therefore names components but gives no owner stack or source location unless
the agent overrides `NODE_ENV`. The names come from the functions as the dev
server serves them; a minified production build was not tested.

**When it ends.** The kernel's manual for PID namespaces: when the namespace's
init exits, "the kernel terminates all of the processes in the namespace via
a SIGKILL signal", and "When a child process becomes orphaned, it is
reparented to the "init" process in the PID namespace of its parent"
([pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html),
read 2026-11-11). Bubblewrap runs with `--die-with-parent`
([agent-signal-sandbox.py:400](../../bin/agent-signal-sandbox.py#L400)). So a
server that stays inside the domain ends with the agent's engine process: at
host release after its lane settles and at every Delegatus update for a Claude
agent. Under memory pressure it can end sooner: when an agent's tree passes
its limit, the memory watchdog kills the tree's largest process, and when all
agents pass the shared budget it kills the largest process of any agent
([agentMemory.ts:268-285](../../src/lib/runtime/agentMemory.ts#L268-L285));
a dev server can be that process.

**What that boundary does not cover.** The signal-sandbox design records that
the systemd user manager stays reachable from every domain, so
`systemd-run --user` can start a process outside it, and that Docker and the
shared tmux server are allowed services
([agent-signal-sandbox.md:40](agent-signal-sandbox.md#L40)). A dev server
started through any of them outlives the agent. Where the namespace boundary
cannot be established, the engine starts without it (same document, the
2026-10-20 availability decision). Both cases are why slice 2 checks which
process holds the listening socket (§6.2) before it trusts a URL.

**Where it listens.** A dev server listens on whatever address its command
names. One bound to every address is reachable from the network on its own
port, and that port is outside Delegatus's perimeter: no access key, no
session and no `workspaceRoute` stand in front of it. Such a listener still
accepts loopback connections, so a loopback URL proves nothing about it: a
listener on `0.0.0.0` shows the local address `00000000` in `/proc/net/tcp`
and one on `::` shows all zeros in `/proc/net/tcp6`, while `127.0.0.1` shows
`0100007F` and `::1` ends in `01000000` (revision-1 probe in §11; the review
round connected over loopback to a `0.0.0.0` listener). Slice 2 therefore
reads the listener's own address (§6.2).

**What runs now.** At 13:03 UTC on 2026-11-11 no Node or Bun process on this
machine ran Vite, `next dev`, webpack, Astro, Nuxt or a Python HTTP server,
apart from the Viewer's own `next start`. Agents in other projects on this
machine have started Vite dev servers (found by transcript search, §11), so
the case is real, but it is not constant.

### 3.3 Pictures and frames from agents

- **Agent pictures in the feed.** Every picture an agent looks at becomes an
  image block drawn by `ImageCard`, inline bytes or a path loaded through
  `/api/artifact` ([ImageCard.tsx:50-55](../../src/components/feed/cards/ImageCard.tsx#L50-L55),
  [docs/design/agent-images.md](agent-images.md)). A tap opens `Lightbox`,
  the full-screen viewer with wheel and pinch zoom, pan, swipe and keyboard
  stepping ([Lightbox.tsx:76-111](../../src/components/feed/Lightbox.tsx#L76-L111)).
  The conversation feed provides its picture list to the viewer
  ([LogFeed.tsx:1923](../../src/components/LogFeed.tsx#L1923)).
- **Which files are served.** Project roots serve any previewable type;
  evidence roots and the report picture store serve rasters only
  ([localFile.ts:109-133](../../src/lib/artifact/localFile.ts#L109-L133)).
  JSON is a text type ([classify.ts:34-35](../../src/lib/artifact/classify.ts#L34-L35)),
  so a JSON file beside a screenshot in an evidence directory is **not**
  served today.
- **HTML reports in a sandbox.** An agent's HTML report runs in an iframe
  sandboxed without `allow-same-origin`: "the page gets an opaque origin, so
  it cannot read the viewer's DOM, storage or cookies, and its API calls arrive
  cross-origin and are refused"
  ([DocumentPanes.tsx:22-27](../../src/components/preview/DocumentPanes.tsx#L22-L27),
  frame at [157-169](../../src/components/preview/DocumentPanes.tsx#L157-L169)).
  The frame route sends the same sandbox as a CSP
  ([frameScope.ts:82](../../src/lib/artifact/frameScope.ts#L82)) and
  authorizes each request by a signed directory scope that expires after 12
  hours ([frameScope.ts:21-40](../../src/lib/artifact/frameScope.ts#L21-L40)),
  minted by the same-origin meta read
  ([artifact/route.ts:143](../../src/app/api/artifact/route.ts#L143),
  frame route [frame/[...rest]/route.ts:16-41](../../src/app/api/artifact/frame/%5B...rest%5D/route.ts#L16-L41)).
  The perimeter lets frame requests through on the scope alone
  ([proxy.ts:110-116](../../src/proxy.ts#L110-L116)).
- **The preview sheet.** `ArtifactPreviewHost` dispatches Markdown, HTML,
  text, image and PDF panes ([ArtifactPreviewHost.tsx:363-378](../../src/components/preview/ArtifactPreviewHost.tsx#L363-L378))
  in a side sheet on desktop and a full-screen dialog on the phone
  ([384-405](../../src/components/preview/ArtifactPreviewHost.tsx#L384-L405)).
- **Decision forms with frames.** `publish_prototype_review` copies an
  agent's frames into a private store and the operator answers with a choice
  and a comment ([docs/design/prototype-review-server.md](prototype-review-server.md)).
  The store is fenced from every path route
  ([localFile.ts:91](../../src/lib/artifact/localFile.ts#L91)).

### 3.4 Browser access agents already have

- **Through their shell.** `playwright-core` is a development dependency
  ([package.json:83](../../package.json#L83)); the repository's drivers launch
  Chromium from `CHROME_BIN` ([kanbanBoard.browser.test.tsx:70](../../src/components/kanban/kanbanBoard.browser.test.tsx#L70)).
  On this machine Playwright's Chromium builds sit in the account's browser
  cache (observed). An agent of any project can open its own dev server in a
  headless browser and take screenshots; the product neither starts nor
  watches that browser.
- **Through the Viewer MCP.** A worker starts with only `viewer`; the grantable
  set is `viewer` and `telegram`
  ([mcpAllowlist.ts:29-52](../../src/lib/agent/mcpAllowlist.ts#L29-L52)).
  Control of the operator's own browser was designed and deferred
  ([worker-browser-control.md](worker-browser-control.md)).
- **A saved agent login to the Viewer.** On a team installation an agent's
  Playwright login state names one ordinary member's session cookie for
  `127.0.0.1` ([agentBrowserAccess.ts:16-41](../../src/lib/team/agentBrowserAccess.ts#L16-L41)),
  and `grant_agent_browser_access` places that member in the calling seat's
  workspace ([71-97](../../src/lib/team/agentBrowserAccess.ts#L71-L97)).
- **The product itself ships no browser.** None of the 18 production
  dependencies in [package.json](../../package.json) is a browser or a browser
  driver; Chromium appears only in the candidate gate image
  ([candidateBrowserRun.ts](../../src/runtime-host/candidateBrowserRun.ts)).

### 3.5 Rendered-evidence drivers

There is one driver of each kind, and an issue adds a case to it
([AGENTS.md:338-360](../../AGENTS.md#L338-L360)): board geometry
(`scripts/capture-board-geometry.ts`), run directories
(`scripts/capture-directory.ts`), the kanban board
(`src/components/kanban/kanbanBoard.browser.test.tsx`), the conversation
window (`src/components/conversation/conversationWindow.browser.test.tsx`) and
the phone (`src/components/mobile/issue1671Evidence.browser.test.tsx`). The
conversation-window fixture already drives `appendComposerDraft`
([conversationWindowEvidence.fixture.tsx:1166](../../src/components/conversation/conversationWindowEvidence.fixture.tsx#L1166)).

### 3.6 The composer and how a message reaches a running agent

- **A draft from elsewhere.** `appendComposerDraft(id, text)` "Drops text into
  a conversation's composer from outside": it grows the stored draft and a
  mounted composer reloads it and takes focus
  ([ConversationComposer.tsx:1886-1893](../../src/components/ConversationComposer.tsx#L1886-L1893),
  [1919-1923](../../src/components/ConversationComposer.tsx#L1919-L1923)).
  `appendComposerDraft` writes session storage without catching an error
  ([1919-1924](../../src/components/ConversationComposer.tsx#L1919-L1924)).
  Draft pictures live in session storage too, but `writeDraftImages` is not
  exported, and it swallows a storage error without touching the visible tray
  ([1532-1544](../../src/components/ConversationComposer.tsx#L1532-L1544));
  its comment, "The visible in-memory tray remains authoritative", holds for
  pictures that are already in the tray, because the composer writes the tray
  to storage after each change
  ([3358-3361](../../src/components/ConversationComposer.tsx#L3358-L3361)).
  The compose-event handler reloads only the text
  ([3530-3548](../../src/components/ConversationComposer.tsx#L3530-L3548)).
- **The tray.** A mounted composer holds its pictures in memory in
  `useImageAttachments`
  ([imageAttachments.tsx:196-234](../../src/components/imageAttachments.tsx#L196-L234)).
  Its limit check refuses past the engine's picture count and byte budget
  ([115-129](../../src/components/imageAttachments.tsx#L115-L129)), and
  `replace` restores a whole tray from a draft
  ([506-551](../../src/components/imageAttachments.tsx#L506-L551)); nothing
  adds one ready picture to a tray from outside. The composer's text is
  published in memory first and then persisted, with no catch around the
  persist ([useComposer.ts:145-149](../../src/hooks/useComposer.ts#L145-L149),
  [ConversationComposer.tsx:2289-2292](../../src/components/ConversationComposer.tsx#L2289-L2292)).
- **The send.** The composer seals text, pictures (`{ base64, mime }`) and
  files into one envelope with an idempotency key and a delivery policy
  ([3805-3835](../../src/components/ConversationComposer.tsx#L3805-L3835)).
  `/api/conversation-host` is wrapped in `workspaceRoute`
  ([conversation-host/route.ts:12](../../src/app/api/conversation-host/route.ts#L12))
  and admits pictures before planning the delivery
  ([handlers.ts:340-357](../../src/app/api/conversation-host/handlers.ts#L340-L357)):
  at most 16 per message, 10 MB each, 18 MB in total
  ([runtimeImageStore.ts:22-24](../../src/lib/runtime/runtimeImageStore.ts#L22-L24)).
- **A server-composed send by a person.** The lane review route lets only a
  person send ([laneReview/http.ts:34-42](../../src/lib/laneReview/http.ts#L34-L42)),
  keys the message so a repeat delivers nothing twice
  ([108-111](../../src/lib/laneReview/http.ts#L108-L111)) and calls the
  conversation host in-process with the person as actor
  ([180-190](../../src/lib/laneReview/http.ts#L180-L190)). The prototype
  decision form uses the same path
  ([prototypeReview/decision.ts:175](../../src/lib/prototypeReview/decision.ts#L175)).

### 3.7 The phone

The phone layout renders whenever either axis is under 640 × 600
([eligibility.ts:20-26](../../src/lib/attention/eligibility.ts#L20-L26)). The
image viewer and the preview sheet are full screen there (§3.3). The lane
review's phone sheet is the precedent for "read on the phone, write on a
computer" ([LaneReviewPhoneSheet.tsx:14-16](../../src/components/laneReview/LaneReviewPhoneSheet.tsx#L14-L16)).

### 3.8 Access: perimeter, cookies, origins, team and workspaces

- **The access key cookie is the key.** With `LLV_TOKEN` set, a visit with
  `?k=` stores the token itself as `llv_auth`, `HttpOnly`, `SameSite=Lax`,
  `Path=/`, host-only ([proxy.ts:11](../../src/proxy.ts#L11),
  [25-39](../../src/proxy.ts#L25-L39)); every later request is admitted by
  that cookie ([118-127](../../src/proxy.ts#L118-L127)).
- **Session cookies.** A team member's session is `llv_member`, `HttpOnly`,
  `SameSite=Lax` ([sessions.ts:18](../../src/lib/team/sessions.ts#L18),
  [111-120](../../src/lib/team/sessions.ts#L111-L120)); a solo browser session
  is `llv_operator`, `SameSite=Strict`
  ([gate.ts:147](../../src/lib/team/gate.ts#L147)).
- **The origin gate ignores ports.** "Ports stay independent"
  ([sameOrigin.ts:24-33](../../src/lib/sameOrigin.ts#L24-L33)): a write's
  `Origin` passes when its host name, without port, is allowed
  ([sameOrigin.ts:94-102](../../src/lib/sameOrigin.ts#L94-L102)). A configured
  public HTTPS origin is pinned exactly, port included
  ([85-93](../../src/lib/sameOrigin.ts#L85-L93)). The last check refuses any
  `Sec-Fetch-Site` other than `same-origin` or `none`
  ([104-105](../../src/lib/sameOrigin.ts#L104-L105)).
- **Team and workspaces.** `teamActor` names an agent, a service or a member
  per request ([actor.ts:63](../../src/lib/team/actor.ts#L63)); a member must
  still be active to deliver ([actor.ts:46-49](../../src/lib/team/actor.ts#L46-L49)).
  Workspaces partition projects and fence agents' Viewer tools, and by the
  operator's decision of 2026-10-20 they do not contain an agent's shell
  ([workspaces.md §1, D3](workspaces.md#1-decisions-in-one-page),
  [§4](workspaces.md#4-who-can-see-and-do-what), [§12](workspaces.md#12-decision-operator-2026-10-20)).
- **Open work in this area, read 2026-11-11.** Lane `cd072467` (PR #3861,
  Workspaces W3) binds the report-frame token to the minting session, so
  revocation, sign-out and expiry refuse a frame and its assets; it edits
  `frameScope.ts`, both artifact routes and the team store. Lane `edab49ae`
  (Workspaces W1, not yet pushed) edits the account-pool routes, `i18n`, the
  workspace page and two evidence drivers. Lane `078240ea` (the first-run
  guide, not yet pushed) edits the onboarding components, `i18n`, the
  prototype-review types and the kanban driver. None of them touches
  `Lightbox.tsx`, `ImageCard.tsx`, `LogFeed.tsx` or `ConversationComposer.tsx`.
  This design edits none of their files; §6 says where a later slice meets
  them.

### 3.9 The machine

Observed 2026-11-11 13:03 UTC: 24 CPUs; 125.6 GiB of memory with 82.6 GiB
available; load average 10.1 / 9.8 / 10.8; 148 active `delegatus-agent-*`
user scopes; the Viewer's own process at 6.3 GiB resident.

## 4. Trust: who could do what, and what this design claims

**Assets.** The operator's Delegatus authority in their browser (the access
key in `llv_auth`, the `llv_member` and `llv_operator` sessions, every
same-origin route); other members' sessions on a team installation; the
machine's memory and CPU.

**Adversaries.**

1. **The app's code**: the repository's own code, its npm dependencies and
   whatever the agent wrote, including text a web page or an issue planted in
   the agent. It runs wherever the dev server and the page run.
2. **Another member's agent** on a team installation.
3. **A network peer** that can reach a port the preview opens, or the dev
   server's own port.
4. **Anyone holding a copied preview link**: a link pasted into a chat, a
   screenshot of the address bar, a browser history on another computer.

**The boundary this design does not move.** An agent and its dev server run
as the installation's own OS user. On a solo installation and below
workspace level 4, nothing here keeps that code from the machine, and this
design claims nothing of the kind (workspaces.md D3). In particular the dev
server itself runs on the host network and can fetch anything that user can,
including another agent's dev server, and serve it as its own page. Nothing
below prevents that; the claims are about what Delegatus itself opens,
registers, fetches and shows.

**What this design does claim, and the check that holds each claim:**

| Claim | Check that holds it |
| --- | --- |
| App code never runs in the operator's browser with access to Delegatus's cookies, storage or same-origin routes. | Slices 1 to 3 send the browser pictures and validated data only: bytes through `/api/artifact` and `/api/image` with `nosniff` and a raster MIME, drawn by `<img>`. Slice 4 needs a separate site (§5.2) plus the `Sec-Fetch-Site` check at [sameOrigin.ts:104-105](../../src/lib/sameOrigin.ts#L104-L105). |
| Page text cannot pose as the operator's words. | Page-derived strings go into a labelled quote block of the draft, capped in length, and nothing is sent until the operator presses Send in the composer (§5.4). |
| A registered port is the registering agent's own (slice 2). | The kernel's socket table and the agent scope's `cgroup.procs`: every listening socket on the port must have an inode held by a process inside that scope, at registration and again before every capture (§6.2). |
| Delegatus never registers, captures or shows a dev server whose port is reachable from the network (slices 2 to 4). | The listening socket's own local address in `/proc/net/tcp` and `/proc/net/tcp6`: every listener on the port must be loopback, checked at registration, before every capture and when a preview connection opens; a product-owned unit with any non-loopback listener is stopped (§6.2, §6.3). The URL's host name is not the check. |
| The capture browser reaches only the registered port (slice 2). | The browser runs in its own network namespace whose only reachable address is a relay to that port, so subresources, nested frames, redirects, fetch, WebSocket, EventSource, workers and beacons to any other address find no route (§6.2, probe in §11). |
| A copied preview link opens nothing for anyone else (slice 4). | The preview site admits a request only with a cookie that a one-time login code set in the owner's own browser, checked on every HTTP request and every WebSocket upgrade against a live session (§6.4). |
| A product-owned process ends (slices 2 and 3). | `KillMode=control-group`: "all remaining processes in the control group of this unit will be killed on unit stop" ([systemd.kill(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), read 2026-11-11); `RuntimeMaxSec=`: a service "active for longer than the specified time … is terminated and put into a failure state" ([systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), read 2026-11-11); then the owned runner's empty-cgroup check ([owned-runner.ts:302](../../scripts/owned-runner.ts#L302)). |
| A member sees and comments only inside their workspace. | `workspaceRoute` on every route that names a conversation or a project ([conversation-host/route.ts:12](../../src/app/api/conversation-host/route.ts#L12), [workspaceRoute.ts:259](../../src/lib/team/workspaceRoute.ts#L259)). |

Two facts from the standards decide the live options. Cookies "do not provide
isolation by port. If a cookie is readable by a service running on one port,
the cookie is also readable by a service running on another port of the same
server", and "If a cookie is writable by a service on one port, the cookie is
also writable by a service running on another port of the same server"
([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5), read
2026-11-11). And `Sec-Fetch-*` headers are attached only when "r’s current URL
is … a potentially trustworthy URL"
([Fetch Metadata §3](https://w3c.github.io/webappsec-fetch-metadata/), read
2026-11-11), which covers `https`, loopback addresses and names ending in
`.localhost`, and returns "Not Trustworthy" for plain `http` on any other host
([Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/), read
2026-11-11). Ports do not take part in "same site"
([HTML, same site](https://html.spec.whatwg.org/multipage/browsers.html#same-site),
read 2026-11-11).

## 5. The design space

Every option below is compared on the same eight criteria:

- **C1** Does app code run in the operator's browser, and with what reach?
- **C2** Which Delegatus credentials reach the app?
- **C3** Does it work for an operator on a phone or another computer?
- **C4** Does it fit the existing team and workspace checks?
- **C5** What owns the processes, and what ends them?
- **C6** What does it cost the machine (measured where measured)?
- **C7** How much is built, and how easily is it removed?
- **C8** What can the operator do with the result?

### 5.1 Who starts the dev server and owns its lifetime

| Option | C1 / C2 | C3 / C4 | C5: owner and end | C6 | C7 | C8 |
| --- | --- | --- | --- | --- | --- | --- |
| **A. The agent starts it, as today** | Depends on §5.2 | Depends on §5.2 | The agent's scope and PID namespace; ends with the agent's engine, at lane release, at every update for a Claude agent, or sooner when the memory watchdog picks it (§3.2). Escapes through the user manager, Docker or tmux are not covered. | Counted against the agent's cap. Minimal Vite: 112–163 MB (§5.6). | Nothing new. | The preview exists only while the agent runs. |
| **B. The agent asks Delegatus to start it** (`preview_start` on the Viewer MCP) | Same | Same | A product unit: owned-runner pattern with `KillMode=control-group`, `MemoryMax`, `RuntimeMaxSec`, idle stop, the setup recipe's sandbox. Survives the agent; ends on idle, on lane close, on worktree sweep. | One unit per previewed lane. | MCP tool, unit lifecycle, adoption across a Viewer restart. | The preview outlives the agent's turn. |
| **C. Delegatus starts it from a command the operator approved for the project** | Same | Same | Same unit as B, started on the operator's click. | Same as B. | B plus a project setting modelled on the setup recipe. | The operator can look at any lane, including finished ones. |
| **D. No dev server in the product**: the agent captures pictures | No app code in the browser | Works everywhere | The agent's capture ends with its command. | Capture cost lands in the agent's scope. | Nothing new. | Pictures only, when the agent takes them. |

The requirement says the agent starts the dev server. B keeps that wording
and moves ownership to the product; C does not keep it. That is why who
starts it is question Q2 for the operator, and why the recommendation stays on
A (and D for pictures) until the operator wants to look at finished lanes.

### 5.2 How the result reaches the operator's browser

| Option | C1 | C2 | C3 | C4 | C7 | C8 |
| --- | --- | --- | --- | --- | --- | --- |
| **R1. Pictures the agent already takes**, with a point-and-comment control | None | None | Yes, phone and remote | Existing feed and composer checks | Small, client-only | Point at a spot |
| **R2. Capture on request**: Delegatus photographs the running app at chosen widths, with an element map | None; the app runs in a headless browser on the machine with a fresh profile, in a network namespace that reaches only the registered port | None | Yes | New capture route and store, behind `workspaceRoute` | Medium: runner, store, pane | Pick an element precisely; no clicking through the app |
| **R3. A link to the dev server's own address** | Full, in the app's own origin | Opened on the Viewer's host name, the browser sends `llv_auth` (the access key) to the dev server (RFC 6265 §8.5) | Only if the dev server listens on a public interface, which leaves its port open to the whole network with no login | None | Tiny | Full, but no picker |
| **R4. A path proxy under the Viewer's origin, sandboxed** like report frames | Opaque origin: no cookies, no storage | None reach the app | Yes | Fits the frame-scope model ([frameScope.ts](../../src/lib/artifact/frameScope.ts)) | Medium | Apps that use storage or absolute asset paths (`/@vite/client`, `/_next/…`) break |
| **R5. A proxy on another port of the Viewer's host name** | Full | The browser sends every Delegatus cookie to the proxy (the proxy can drop them), and app code can **write** cookies that Delegatus then receives (RFC 6265 §8.5). Over plain HTTP on a non-loopback host no `Sec-Fetch-Site` is sent and the origin gate ignores ports ([sameOrigin.ts:94-105](../../src/lib/sameOrigin.ts#L94-L105)), so app code can post to Delegatus routes with the operator's `SameSite=Lax` cookies. | Needs that port reachable | Needs a login bound to the operator's browser (§6.4) | Medium plus origin-gate hardening | Full |
| **R6. A proxy on a separate site** (`<id>.localhost` locally; a second host name remotely) | Full, in its own site | None | Locally yes. Remotely only with a second host name and its certificate. | Needs a login on the preview site bound to the operator's browser and checked against a live session on every request (§6.4). A token in the URL or host name alone is a bearer credential that works in any browser. | Large; a new listener with WebSocket bridging for hot reload, plus the login | Full, plus a picker script |

Observed for R6: Chromium 156 resolved `preview-a1.localhost` to the loopback
dev server and reported a secure context (probe in §11). Vite allows
"`localhost` and domains under `.localhost` and all IP addresses … by
default" ([Vite server options](https://vite.dev/config/server-options), read
2026-11-11). Next.js 16.4.2 "already allows `localhost`, its subdomains, and
the hostname it was started with. Any other hostname needs an entry" in
`allowedDevOrigins` (the Next documentation shipped in the installed release,
`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/allowedDevOrigins.md`).
A proxy for a remote site would therefore strip or rewrite `Origin`, as Vibe
Kanban does (§2.1). `tailscale serve` provisions a certificate for the
machine's own name and documents "Serve for a Tailscale Service with a
distinct virtual IP"
([tailscale serve](https://tailscale.com/kb/1242/tailscale-serve), read
2026-11-11); whether that gives a second, separate host name is unknown (U4).

Conclusion: R3 and R5 hand the app the operator's Delegatus cookies and are
rejected. R4 breaks the apps it is meant to show. R6 is the only sound live
option, and remotely it needs infrastructure the operator has to choose
(question Q4). R1 and R2 need none of that.

### 5.3 Access control

- **Solo installation.** Every route these slices add sits behind the
  existing perimeter: the access key or the solo session
  ([proxy.ts:99-146](../../src/proxy.ts#L99-L146)). The perimeter guards
  Delegatus's own port only. A dev server's port is outside it, so no slice
  links to a dev server's address, and slices 2 to 4 refuse a dev server whose
  port listens on anything but loopback (§3.2, §6.2). Whether the machine's
  firewall closes other ports is outside this design; an agent can still open
  a public port from its shell (D3), and Delegatus then shows nothing of it.
- **Team installation, slice 1.** No new route. Who sees a picture is who can
  read the conversation; who can send the comment is who passes
  `workspaceRoute` on `/api/conversation-host`. A revoked member's next send is
  refused by `activeDeliveryActor` ([actor.ts:46-49](../../src/lib/team/actor.ts#L46-L49)).
- **Slices 2 and 3.** New routes take the conversation's project and pass
  `workspaceRoute`. Capture and start are person-only, refused for an agent
  capability or a service, as the lane review refuses them
  ([laneReview/http.ts:34-42](../../src/lib/laneReview/http.ts#L34-L42)).
  Registration is agent-only and binds to the caller's own conversation, never
  a supplied id. The capture store is fenced from the path routes, as the
  prototype review store is ([localFile.ts:91](../../src/lib/artifact/localFile.ts#L91)),
  and answers only through its manifest, its conversation and the workspace
  check. It is not shown in search or the task album.
- **Slice 4.** A login on the preview site, set in the operator's own browser
  by a one-time code that only an authenticated same-origin request to
  Delegatus can mint, and checked on every request (§6.4). The W3 binding
  (PR #3861, open, read 2026-11-11) is a different guarantee: its
  `verifyFrameScope` checks that the session named inside the signed token is
  still live and its member active; it does not look at the requester's own
  cookie. A copied token therefore keeps working in another browser until
  that session ends. Slice 4 reuses W3's liveness test for the grant and adds
  the browser binding on top. Owner-only first (Q3).
- **Agents.** No agent reads a capture through a path route. An agent reaches
  previews only through the tools named in §6, fenced to its workspace by the
  existing MCP fence.

### 5.4 How a click becomes a comment the agent can act on

**Element identity, from least to most.**

1. **A point on a picture** (slice 1): picture, natural-pixel coordinates,
   percentages, a crop with the spot ringed. The agent maps the point to an
   element; it took the picture and can open the same page.
2. **An element from a map captured with the picture** (slice 2): tag, id,
   classes, a short text excerpt and the box, chosen client-side as the
   smallest box that contains the point, with "larger" and "smaller" to walk
   to the parent or a child. Measured on the fixture: 29 and 32 visible
   elements, 1.8 and 2.1 KB of JSON (§5.6).
3. **A component, its owners and a source location**, when the framework
   exposes them. These are three different facts with different conditions:
   - **Component name.** Walk `fiber.return` from the element's host fiber to
     the nearest function or class component and read
     `type.displayName ?? type.name`; keep walking for the enclosing ones.
     Observed under production React (19.2.8 here, 19.3.1 in the review round,
     both with `NODE_ENV=production`): `App` for a button rendered by `App`,
     and `Card` then `App` for a button inside a `Card`. Vibe Kanban falls
     back to the same walk (§2.1). A fixed number of `return` steps is wrong:
     two steps from the button in `App` land on the host `main` element, which
     is what the first version of this design's probe read.
   - **Owner and owner stack.** React owner stacks are "only available in
     development" and `captureOwnerStack` "will always return `null` outside
     of development"
     ([captureOwnerStack](https://react.dev/reference/react/captureOwnerStack),
     read 2026-11-11). Observed on React 19.3.1 with Vite 8.3.8: under the
     inherited `NODE_ENV=production` a fiber had no `_debug*` fields; under
     `NODE_ENV=development` it had `_debugOwner` (`App`) and `_debugStack`.
   - **Source location.** The development `_debugStack` named
     `App (…/src/main.jsx:25:28)`, while the element is on line 5 of the
     source file. The stack names the component and the module file; its line
     belongs to the transformed module and needs that module's source map to
     become a source line (U9).

   Slice 2 records the component names by the walk whenever React is present,
   and the owner stack head only when the build has one. Source mapping stays
   optional and deferred (§9).

**Untrusted text.** Element text, ids and classes come from the page and may
carry instructions planted for the agent. They go into the draft as a quote
block labelled "Text from the page (not written by the operator)", each
string capped at 120 characters, control characters removed. The operator
sees exactly that before Send. The picture crop is pixels of the agent's own
screenshot and adds nothing the agent did not already see.

**Delivery.** The comment goes into the conversation's composer as a draft,
with the crop as a draft picture, handed to the mounted composer whole or not
at all (§6.1). The operator edits and sends; delivery,
retry and receipts are the composer's own (§3.6). A one-tap direct send, like
the lane review's, was considered and not chosen: it would put page-derived
text under the operator's name without a look. Several comments in a row
append to one draft, up to the 16-picture limit of one message.

### 5.5 The phone

| Slice | What the phone gets |
| --- | --- |
| 1 | Everything: the viewer is full screen, a tap places the ring, the note field sits above the keyboard, the comment lands in the conversation's message box. |
| 2 | Capture at 390 px and pick an element; the preview pane is the full-screen sheet ([ArtifactPreviewHost.tsx:398](../../src/components/preview/ArtifactPreviewHost.tsx#L398)). |
| 3 | Start and stop buttons with the same states as desktop. |
| 4 | The live app in the full-screen sheet; the app's own phone layout at the phone's width. Remote use needs the second host name (Q4). |

### 5.6 Cost on a machine that already runs many agents

Measured 2026-11-11 13:04–13:06 UTC, three runs, on the machine of §3.9
(load average 10.6 at the start, 10.3 at the end; 148 agent scopes). Fixture:
a Vite 8.3.8 + React 19.3.1 page of 40 cards, served on `127.0.0.1` port 0.
Capture: Chromium 156 headless shell through `playwright-core` 1.62.1, one
browser, a page at 390 × 844 at device scale 2 and a page at 1440 × 900 at
scale 1, each loaded to network idle, screenshotted and mapped. Resident
memory is the sum of `VmRSS` over the process tree, sampled every 50 ms.

| Measure | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Vite ready after start | 347 ms | 142 ms | 136 ms |
| Vite resident, idle | 158 MB | 112 MB | 114 MB |
| Vite resident, after two page loads | 163 MB | 143 MB | 142 MB |
| Capture at 390 × 844, load to map | 2,750 ms | 2,113 ms | 2,037 ms |
| Capture at 1440 × 900, load to map | 3,101 ms | 3,265 ms | 2,982 ms |
| Browser launch to both captures done | 7,987 ms | 6,723 ms | 6,169 ms |
| Browser tree, peak resident | 437 MB | 443 MB | 442 MB |

Pictures: 68,046 bytes at 390 px (scale 2) and 34,001 bytes at 1440 px.
Element maps: 29 and 32 rows, 1,848 and 2,061 bytes.

What this means, per option:

- **Slice 1:** nothing on the machine. The crop is drawn in the operator's
  browser.
- **Slice 2:** about 440 MB for about 7 s per capture of two widths. One
  capture at a time per installation bounds the peak at about 0.3% of
  this machine's memory.
- **Slices 3 and 4:** one dev server per previewed lane, 112–163 MB for the
  minimal fixture. A real application is larger, and a `next dev` of a large
  application was not measured (U5). Slice 4 adds a proxy process and one
  hot-reload connection per open preview, unmeasured.
- The fixture is a lower bound, and the runs share the machine with agents,
  so the times vary by a factor of 2.5 for Vite's start.

## 6. Slices

### 6.1 Slice 1: point at a picture (recommended first)

**Outcome.** In a conversation's full-screen image viewer, the operator taps
"Point", taps a spot on the picture, types what should change and presses
"Add to message". The viewer closes; the conversation's message box holds a
short text naming the picture and the spot, the note, and a crop of the
picture with the spot ringed. Nothing is sent until Send. It works for every
picture in that conversation: the agent's screenshots, pictures it viewed,
pictures the operator attached. When the message box cannot take the comment
whole, the viewer stays open with the ring and the note and says why;
nothing is half-added.

**Where it lives.**

- `src/components/feed/Lightbox.tsx`: a "Point" toggle in the viewer's own
  control row, a button beside the existing controls and never inside the
  picture's own button. Point mode: a single tap or click places or moves the
  ring; pinch, wheel and drag-pan still work; double-tap zoom, sideways
  stepping and the vertical swipe that closes the viewer are off while the
  mode is on; the first Esc leaves the mode, the
  next one closes the viewer as today. A one-line note field and "Add to
  message" appear once a ring is placed. The control appears only when the
  viewer was opened from a conversation feed and a composer for that
  conversation is mounted (`TaskAlbum` provides no conversation, so the album
  shows no control). "Add to message" closes the viewer only on the answer
  `added`; on `refused` it keeps the ring and the note and shows the reason
  in the viewer's control row.
- `src/components/LogFeed.tsx`: provides the conversation identity next to
  the existing gallery provider ([LogFeed.tsx:1923](../../src/components/LogFeed.tsx#L1923)),
  computed as the composer computes its own, `conversationIdentity(file)`
  ([ConversationComposer.tsx:2124](../../src/components/ConversationComposer.tsx#L2124)).
- `src/lib/pointComment/` (new, pure): map a click to natural pixels, compute
  the crop, compose the text.
  - Mapping: `x = (clientX - rect.left) / rect.width * naturalWidth`, from the
    `<img>` element's `getBoundingClientRect()`, which includes the viewer's
    zoom and pan transforms.
  - Crop: a square of side `clamp(round(0.35 × min(W, H)), 160, 1024)` natural
    pixels centred on the spot and shifted inside the picture (the whole
    picture when it is smaller), scaled so its longest side is at most 800 px,
    with a ring of radius `max(12, side / 20)` output pixels drawn as a 3 px
    accent stroke inside a 2 px white stroke. PNG, or JPEG at quality 0.85
    when the PNG exceeds 1 MB. The source is the same-origin `/api/artifact`
    URL or the `data:` URL `ImageCard` already uses
    ([ImageCard.tsx:54](../../src/components/feed/cards/ImageCard.tsx#L54)),
    so the canvas is not tainted.
  - Text, in the interface language, deterministic:

    ```
    Pointed at a spot on a picture in this conversation.
    Picture: <path, or "attached at HH:MM"> (W × H px)
    Spot: x X, y Y px (P% across, Q% down). The attached crop rings it.
    Note: <note>
    ```

    ```
    Позначка на картинці з цієї розмови.
    Картинка: <шлях або «додана о HH:MM»> (W × H px)
    Місце: x X, y Y px (P% по ширині, Q% по висоті). На доданому фрагменті воно обведене кільцем.
    Примітка: <примітка>
    ```

- `src/components/ConversationComposer.tsx`: a mounted composer registers an
  intake under its conversation identity and removes it on unmount. A new
  export, `offerToComposer(id, { text, image })`, answers synchronously with
  `added` or with `refused` and a reason. The intake runs these steps in
  order and stops at the first refusal:
  1. `no-composer` when nothing is registered for the id, for example when
     the composer unmounted while the viewer was open;
  2. `limit` when the in-memory tray plus the crop fails the tray's own limit
     check ([imageAttachments.tsx:115-129](../../src/components/imageAttachments.tsx#L115-L129))
     or would pass 16 pictures, counting slots that are still being read;
  3. `storage` when session storage refuses: the intake reads the two keys it
     is about to change (the draft text and the draft pictures), writes the
     grown picture list (the tray's ready pictures plus the crop) and the
     grown text with each error caught, and when either write throws, writes
     both keys back to the values it read;
  4. otherwise it commits the crop to the in-memory tray as one ready picture
     and the text through the composer's own `setText`, and answers `added`.

  The crop never goes through `appendComposerDraft`, which can throw after a
  change has begun ([1919-1924](../../src/components/ConversationComposer.tsx#L1919-L1924)),
  or through `writeDraftImages`, which swallows the error and never reaches
  the tray ([1532-1544](../../src/components/ConversationComposer.tsx#L1532-L1544)).
  With the crop in the tray, the composer's existing write of the tray to
  storage after each change
  ([3358-3361](../../src/components/ConversationComposer.tsx#L3358-L3361))
  covers it like any pasted picture.
- `src/components/imageAttachments.tsx`: an additive `appendReady(images)`
  beside `replace` ([506-551](../../src/components/imageAttachments.tsx#L506-L551)),
  which adds ready picture slots after the existing ones and leaves reading,
  failed and file slots as they are. `replace` cannot serve: it aborts uploads
  and rebuilds the whole tray.
- `src/lib/i18n/en.ts` and `uk.ts`: the new strings. Lanes `edab49ae` and
  `078240ea` also edit these two files; whichever lands second resolves an
  additive conflict.

**Bounds.** The draft holds at most 16 pictures, the message limit
([runtimeImageStore.ts:22](../../src/lib/runtime/runtimeImageStore.ts#L22)).
At 16 the control reads "This message already has 16 pictures; send it
first". A note is 1 to 2,000 characters. When session storage has no room,
the viewer reads "The browser has no room to keep this draft. Send the
message or remove a picture, then add again." and keeps the ring and the
note; the message box and storage are as they were.

**What it adds and what it does not.** No route, MCP tool, process, store or
setting. No element identity (the agent maps the point), no live view, no dev
server management.

**Acceptance, as observable behaviour.**

1. At 1440, 900 and 390 px, a picture opened from a conversation's feed shows
   a "Point" control; a picture opened from the task album does not.
2. In point mode a tap or click places a ring exactly where it landed, at fit
   and at 200% zoom after a pan; the crop's ring sits on the same detail of
   the picture (checked against a fixture picture with a known marker).
3. With a note typed, "Add to message" closes the viewer, and that
   conversation's composer shows the text with the picture's path or time,
   the pixel coordinates, the percentages and the note, plus one new
   thumbnail of the ringed crop.
4. Two comments in a row produce two text blocks and two thumbnails in one
   draft; a remount of the composer and a reload of the page keep both.
5. With session storage refusing writes, "Add to message" leaves the viewer
   open with the ring and the note and shows the storage reason; the
   composer's text, its tray and both storage keys are exactly as before.
   The same holds when only the second of the two writes is refused. With
   the composer unmounted while the viewer was open, "Add to message" says
   the message box is closed and keeps the ring and the note.
6. Send delivers the text and the pictures with the usual delivery marks, and
   the agent's transcript records the image blocks.
7. Esc in point mode leaves the mode and adds nothing; nothing is ever sent
   without Send.
8. A member whose workspace does not hold the conversation is refused at Send
   by the existing route, with no new path to it.
9. Rendered evidence through the conversation-window driver and the phone
   driver, en and uk, light and dark, at 390, 900 and 1440 px: point mode
   before a tap; the ring with a note; the composer with the draft; the
   16-picture refusal; the storage refusal.

**Tests.** Pure: mapping under zoom and pan, the crop rectangle at the four
corners and for pictures smaller than the crop, both languages of the text,
the 16-picture limit. DOM: the control appears only with a conversation and
a mounted composer, Esc layering, the draft text and picture appear in a
mounted composer, a remounted composer restores both. The intake against a
session-storage double that throws `QuotaExceededError` on the first write,
and one that throws only on the second: the answer is `refused` with
`storage`, both keys hold their earlier values, and the tray and the text
are unchanged. A refusal test fails when the rollback is removed.

### 6.2 Slice 2: capture the running app on request, with element picking

**Outcome.** While an agent's dev server runs, the conversation's ⋯ menu shows
"Preview". It opens a pane with the newest capture at phone or desktop width,
a "Capture again" button and the capture's time and URL. A tap highlights the
element under it, "Larger" and "Smaller" move to its parent or child, and the
note goes to the composer as in slice 1 with an element block.

**Pieces.**

- `preview_register { url }` on the Viewer MCP, agent-only, bound to the
  calling conversation. It refuses a URL that is not `http` on `127.0.0.1`,
  `::1` or `localhost`; that only names the port. The check that counts reads
  every row of `/proc/net/tcp` and `/proc/net/tcp6` in the listening state
  (`0A`) whose local port is that port, and refuses unless there is at least
  one and every one of them:
  - has a loopback local address: `127.0.0.0/8` in `tcp`, and `::1` or
    `::ffff:127.0.0.0/104` in `tcp6`. A wildcard (`00000000`, or all zeros in
    `tcp6`) or any other address refuses with "the dev server listens on
    <address>, which the network can reach; restart it on 127.0.0.1". The
    URL's host never stands in for this: a wildcard listener accepts loopback
    connections too (§3.2);
  - has an inode that appears among the `/proc/<pid>/fd` links of a PID listed
    in the caller's own agent scope's `cgroup.procs`.

  The same check runs again before every capture; when the port has no
  listener left, the pane says the dev server stopped with its agent, and
  when a listener has moved off loopback, it says so and captures nothing. A
  server started outside the agent's domain (§3.2) cannot be registered, and
  the Viewer's own port is refused by construction. An agent that runs
  without a scope (no user manager, macOS) cannot be checked, and its
  registration is refused with that reason. Between two checks a server can
  rebind; Delegatus then captures nothing until the next check passes, and
  what the port exposed meanwhile is the agent's own doing (D3).
- **The capture runner**: a product unit in the work slice, owned-runner
  pattern, `MemoryMax=1G`, `RuntimeMaxSec=60`, `KillMode=control-group` and a
  `TasksMax` task limit (gate units carry `TasksMax=768` since #3860, merged
  2026-11-11 after this design's base, `scripts/gate-tasks.ts`), one at a
  time per installation with a queue of three. It drives a headless
  browser with a fresh profile through the Chrome DevTools Protocol over
  `--remote-debugging-pipe` (navigate, set the viewport, wait for load, run
  the map script, capture a PNG). That needs no new library; `playwright-core`
  would have to move from development to production dependencies. The browser
  is the installation's own, from `CHROME_BIN` or a found Chromium; without
  one the pane says "Capture needs a browser on this computer" and names what
  was looked for (U2).
- **The capture browser's network.** A rule about where the page may
  navigate covers only the top frame. Everything else the page asks for
  (images, stylesheets, nested frames, redirects, fetch, WebSocket,
  EventSource, workers, beacons) would leave a browser on the host network
  for any address the machine can reach: another workspace's dev server,
  other local services, the local network. So the browser runs in a network
  namespace of its own, where the registered port is the only address with
  anything behind it:
  - the unit starts the browser under `unshare --user --map-root-user --net
    --pid --fork --kill-child`, brings the namespace's loopback up, and starts
    a relay inside it that listens on the registered port on `127.0.0.1` and
    `::1`, so the page keeps its own origin;
  - the relay forwards each connection over a Unix socket in the run's
    scratch directory to a relay outside, which connects to the registered
    port on the host loopback and nowhere else;
  - every other connection finds no listener and fails at once; a name
    lookup should fail the same way, since a resolver is just another
    address (an inference; the probe did not test a lookup);
  - the runner records the URLs of failed loads through the DevTools
    protocol and the pane lists their origins under the picture ("3 requests
    to other addresses were blocked: …"), so a page that renders without its
    web fonts or a remote API says why.

  Observed on this machine on 2026-11-11 (revision-1 probe, §11): with page A
  reaching for B through an iframe, an iframe redirected by A, an image on
  `localhost:B`, a stylesheet, fetch, WebSocket, EventSource, a worker's fetch
  and a beacon, B accepted 9 connections from a browser on the host network
  and 0 from the same browser in such a namespace, while A loaded with status
  200 in both. Bubblewrap's own `--unshare-net` failed here at loopback setup
  ("Failed RTM_NEWADDR: Operation not permitted") while `unshare` from
  util-linux brought loopback up. The repository already knows that message:
  the setup recipe adds `--unshare-net` for a restricted sandbox
  ([setupExecution.ts:42-44](../../src/lib/pipelines/setupExecution.ts#L42-L44)),
  its test accepts the message as an isolation refusal
  ([setupExecution.test.ts:23](../../src/lib/pipelines/setupExecution.test.ts#L23)),
  and an earlier diagnosis met the same failure with explicit user and network
  namespaces too ([issue-3647-diagnosis.md:34](issue-3647-diagnosis.md#L34)).
  Which tool works where is therefore unknown (U12). Where no network
  namespace can be made (macOS, user namespaces disabled or restricted),
  capture is refused with that reason and never runs unfenced. A browser
  proxy setting was considered as the fence and not chosen: it is a
  preference of the browser being fenced, and it was not observed against
  every channel above. Exceptions an app may need, such as web fonts, a CDN
  or a remote API, are not allowed in slice 2. A per-project list of HTTPS origins the operator
  approves, served by an outside relay that resolves the name and refuses
  loopback, private and link-local results, is deferred (§9).
- **The map script** records, for each visible element, tag, id, the first
  three classes, a 120-character text excerpt and the box, at most 2,000 rows
  and 256 KB, plus the nearest component names found by walking `fiber.return`
  (up to three) and the owner stack head when the build has one (§5.4). The
  Viewer validates the shape and the bounds before storing it.
- **The store**: `state/preview-captures/<id>/`, fenced like the prototype
  review store, the newest 20 captures per conversation and none older than
  30 days, at most 512 MB per installation, served through `/api/image` with
  the conversation's workspace check.
- **The pane**: a new kind in `ArtifactPreviewHost`. It shows stored
  pictures through `/api/image`, behind the perimeter and the team gate, so it
  needs no frame token. W3's session binding matters to slice 4 only.

**Acceptance (outline).** Registration refused for a non-loopback URL, for a
port held by another agent's process and for the Viewer's port; registration
refused for a server of the agent's own scope listening on `0.0.0.0` and for
one listening on `::`, each registered under an `http://127.0.0.1:<port>`
URL, and accepted for the same server on `127.0.0.1`; a server that rebinds to
`0.0.0.0` after registration gets no further capture. With two stub servers A
and B on loopback ports, a capture of A whose page reaches for B through an
iframe, a redirect, an image, a stylesheet, fetch, WebSocket, EventSource, a
worker and a beacon shows A, B records no connection, and the pane lists B's
origin as blocked. A capture at 390 and 1440 appears within 10 s on the
fixture; a tap selects the element the map names, with its component name
under production React; the draft carries the labelled page-text block; with
no browser installed, or no network namespace available, the pane names the
reason; after the agent's host is released the pane reads "stopped with its
agent" and keeps the old captures.

### 6.3 Slice 3: Delegatus starts the dev server from an approved command

Only if the operator answers Q2 with B or C. A project "preview command"
modelled on the setup recipe: reviewed, hash-pinned, relative cwd, approved
once ([setupRecipe.ts:9-50](../../src/lib/projects/setupRecipe.ts#L9-L50)). It
runs in the setup sandbox ([setupExecution.ts:40-53](../../src/lib/pipelines/setupExecution.ts#L40-L53))
with `NODE_ENV=development`, `MemoryMax`, a `TasksMax` task limit, an idle
stop 15 minutes after the last capture or view, `RuntimeMaxSec` of two hours,
and a stop on lane close and on worktree sweep. Stop is by the recorded unit,
followed by the empty-cgroup check. `preview_start` on the Viewer MCP lets
the agent ask for the same unit, which keeps "the agent starts it" true.
Rendered evidence and states as in slice 2.

**Its port, and who can reach it.** The unit keeps the host network, so the
app can still reach the remote APIs and packages it needs: it uses the setup
sandbox without the `--unshare-net` that a restricted recipe adds
([setupExecution.ts:43](../../src/lib/pipelines/setupExecution.ts#L43)), and
which fails on this machine anyway (§6.2). Its ingress is
closed by Delegatus's own enforcement:

- the approved command must bind loopback, and the preview setting shows the
  operator that requirement before approval;
- Delegatus finds the port from the unit's own listening sockets (the inodes
  of PIDs in the unit's cgroup matched to `/proc/net/tcp` and
  `/proc/net/tcp6`), never from the server's printed output, which is a hint
  for the log only;
- at readiness, every 10 seconds while the unit runs, and before every
  capture or view, every listening socket held by the unit's cgroup must
  have a loopback local address, as in slice 2. One that does not stops the
  unit, records the address in the unit's log and tells the operator "the
  dev server opened <address>:<port> to the network and was stopped";
- a Viewer restart adopts the unit by its recorded name and runs the same
  check before showing anything.

Two stronger fences were considered and not chosen. A network namespace for
the server itself, as for the capture browser, closes ingress by
construction but also cuts the app off from every remote API and package
registry. systemd's `IPAddressDeny=` filters by peer address in both
directions, so it cannot allow outbound traffic while refusing inbound from
the same addresses, and its manual says the settings "will have no effect"
where control-group eBPF is unavailable
([systemd.resource-control(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html),
read 2026-11-11); whether it acts in a user manager was not observed. The
check above leaves a window of up to 10 seconds in which a misbehaving app
can serve the network before it is stopped; the ADR for slice 3 decides
whether that window is acceptable or the namespace's loss of outbound access
is.

**Acceptance (outline).** A command that binds `0.0.0.0` or `::` is stopped
within 10 seconds of readiness with the address named, and nothing is
captured or shown from it; one that binds `127.0.0.1` runs, is found by its
socket and is captured; a server that prints a port it does not hold is not
trusted on that port.

### 6.4 Slice 4: the live app inside Delegatus

Only with a preview address the operator has chosen (Q4). A small proxy
process owned like the units above and kept out of the runtime host, which is
this repository's critical process. It routes `<preview id>.<preview site>`
to the registered port, strips or rewrites `Origin` for the dev server's own
host checks, bridges WebSockets for hot reload, and injects one picker script
whose messages the pane accepts only from its own frame's window and origin,
with the payload shape and size checked. Before it forwards a connection it
runs the loopback-listener check of §6.2 on the registered port, cached for
at most 2 seconds. Owner only first. It needs an ADR, measured proxy and
connection costs, and the origin-gate case of §5.2 R5 kept closed by design:
the preview lives on a separate site and on no other port of the Viewer's
name.

**Who may open a preview: a login bound to the browser.** The host name
names the preview; it is no credential, because the app's own code reads it
from `location.hostname` and a copied link carries it anywhere. The
credential is a cookie that only the owner's browser can obtain:

1. **Open.** The pane asks Delegatus, on its own origin,
   `POST /api/preview/<preview>/open`. The route passes the same-origin gate
   ([sameOrigin.ts:94-105](../../src/lib/sameOrigin.ts#L94-L105)),
   `workspaceRoute` for the conversation's project, and is person-only, owner
   only at first (Q3). It records a grant: preview, conversation, workspace,
   the requesting member session (team) or the solo marker, and an expiry of
   12 hours like report frames ([frameScope.ts:21-40](../../src/lib/artifact/frameScope.ts#L21-L40)).
   It answers with a one-time login code: 32 random bytes, stored only as a
   hash, valid for 60 seconds, consumed on first use.
2. **Log in.** The pane points its frame at
   `https://<preview id>.<preview site>/__delegatus/login?code=…`. The proxy
   consumes the code atomically, mints a new random 32-byte value, stores its
   hash with the grant, and answers with a redirect to `/` that sets
   `__Host-dlg-preview=<value>` with `HttpOnly`, `Secure` and `Path=/`; the
   `__Host-` prefix keeps the cookie host-only, so a sibling preview cannot
   set or shadow it. In a frame the cookie also carries `SameSite=None` and
   `Partitioned`; opened in its own tab it carries `SameSite=Lax`.
3. **Every request.** Each HTTP request and each WebSocket upgrade must carry
   that cookie. The proxy looks up the grant by the value's hash and admits
   only while the grant has not expired, the preview is still registered and
   loopback-only, and, on a team installation, the grant's session is live
   and its member active and still in the conversation's workspace, the same
   test W3 adds for frames (PR #3861, `verifyFrameScope`). A solo grant ends
   once the installation has an active team owner, as W3's solo scope does.
   A WebSocket upgrade must also carry an `Origin` equal to the preview's own
   origin. The decision may be cached per cookie for 5 seconds, and open
   WebSockets are re-checked every 30 seconds and closed when the grant ends.
   Anything else gets 401 and no byte from upstream.
4. **Upstream.** The proxy removes every `__Host-dlg-` cookie and every
   header it set before forwarding, and adds no Delegatus credential.
   Delegatus's own cookies are set without a `Domain` attribute, so they are
   host-only on Delegatus's name and never reach the preview site
   ([proxy.ts:25-39](../../src/proxy.ts#L25-L39),
   [sessions.ts:111-120](../../src/lib/team/sessions.ts#L111-L120),
   [gate.ts:147](../../src/lib/team/gate.ts#L147)). The proxy's only path of its own on the preview
   origin is `/__delegatus/login`: the app's code shares that origin, so
   stop, capture and the picker's delivery all go through the Delegatus
   origin and never through the preview's.

What is not known yet: whether every browser the operator uses keeps a
`Partitioned` cookie set inside a cross-site frame, and whether `__Host-`
cookies work on `http://<id>.localhost` for the local case (U11). Where the
framed cookie is refused, the frame shows the 401, and the pane offers to
open the preview in its own tab, where the same login sets a first-party
cookie. In its own tab the picker has no Delegatus window to post to, so
pointing there falls back to slice 1 and 2.

**Acceptance (outline).** The owner's browser opens the preview, loads its
assets and keeps hot reload. The same preview URL, and the same login URL
after its first use or after 60 seconds, opened in a second browser profile
without the cookie, gets 401 for the page, for a script asset and for the
WebSocket upgrade, and the upstream stub records none of those requests. A
WebSocket upgrade with a foreign `Origin` is refused even with the cookie.
Signing the member out, revoking them or moving the conversation out of
their workspace refuses new requests within 5 seconds and closes an open
WebSocket within 30. The upstream stub never sees a `__Host-dlg-` cookie.

### 6.5 The requirement's example through each slice

| Slice | (a) the agent starts a dev server | (b) the operator sees the result in Delegatus | (c) a click reaches the agent as a comment |
| --- | --- | --- | --- |
| 1 | As today, from its shell | As the agent's screenshots in the conversation | A point on the screenshot, with the note and the ringed crop, sent from the composer |
| 2 | As today, then registers it | On request, at phone and desktop width, while the agent runs | The element under the tap, with its excerpt and box, sent from the composer |
| 3 | Asks Delegatus, or Delegatus starts it on the operator's click | Also after the agent has finished | As slice 2 |
| 4 | As slice 2 or 3 | Live, interactive | The element the picker names, with its component names, and its owner stack and file when the build is a development build |

Nothing that exists today is removed by any slice. The agent's own screenshots
stay the result shown in slice 1 and stay available in every later slice.

## 7. Questions for the operator

These are the decisions only the operator can make. Each stands on its own.

**Q1. What should the first build give you?**

- **a) Point at any picture in a conversation (recommended).** You tap a spot
  on a screenshot the agent showed you, write what is wrong, and it goes into
  that agent's message box with the spot circled. Small, safe, works on the
  phone. You still see the app only through the agent's screenshots.
- b) A "Capture" button: Delegatus photographs the agent's running app at
  phone and desktop width, and you tap the exact element. Medium; needs a
  browser installed on the server and a Linux server; works only while the
  agent runs. The photographing browser can reach only that app, so a page
  that loads fonts or data from the internet shows up without them.
- c) The live app inside Delegatus that you can click through. Large; needs a
  second web address for previews (Q4); desktop first.

**Q2. Who should start the app's dev server when you want to look?**

- **a) The agent, as now (recommended for now).** The preview ends when the
  agent's work ends or when Delegatus updates.
- b) Delegatus, from a command you approve once per project, boxed like the
  project's setup command. You can look at a lane's result after the agent has
  finished; it stops by itself after 15 idle minutes.
- c) Both: the agent can ask Delegatus to start it, and you can start it
  yourself.

**Q3. On a team installation, who may use previews?**

- **a) Only you, the owner, at first (recommended).** Pointing at pictures
  (Q1 a) works for everyone who can already message that agent; the new
  capture and live parts start owner-only.
- b) Everyone who can message that agent in their workspace.

**Q4. Only if you want the live app (Q1 c): what web address should previews
use?**

- **a) Decide later, when the live app is next (recommended).**
- b) A second domain name just for previews, with its own certificate. Safe:
  the preview cannot see or use your Delegatus login. You open each preview
  from Delegatus, which signs that browser in to it; a copied preview link
  opens nothing for anyone else.
- c) The same address on another port. Cheaper to set up, but your Delegatus
  login would be sent to the preview and the app's code could change it, so it
  is not offered as safe.

## 8. Unknowns, and the observation that settles each

| # | Unknown | Observation that settles it |
| --- | --- | --- |
| U1 | Whether the operator ever opens Delegatus in a browser on this machine. Decides whether `*.localhost` previews (R6 local) are worth anything. | Ask, or count loopback against remote client addresses in a week of Viewer access records. |
| U2 | Whether an installation from the npm package has a usable Chromium. | Install the published package into a scratch home and look for `CHROME_BIN`, a system Chromium and a Playwright cache; repeat on macOS. |
| U3 | Whether Safari resolves `*.localhost` to loopback. Matters only for a local Mac browser. | Open `http://x.localhost:<port>/` in Safari against a loopback server. |
| U4 | Whether a Tailscale Service gives a second host name usable as a separate preview site. | Configure one on a test tailnet and read the name and certificate it serves. |
| U5 | Memory of real dev servers: `next dev` of a large application, Vite on a large single-page app. | Run the §11 probe against a scratch export of each target project. |
| U6 | How often agents start dev servers, and for how long. | A week of 10-minute samples of dev-server processes by scope, plus a transcript count of dev-server commands. |
| U7 | Whether a restricted stage (`workspace-write`) may listen on loopback. | In a restricted stage, run a one-line server on port 0 and record the result. |
| U8 | Element-map size on real pages. Measured only on a 40-card fixture: 29–32 rows. | Run the map script on three real applications at both widths. |
| U9 | Whether an owner-stack line maps to a source line through the module's source map under Vite and Next. | Fetch the module's map from the dev server and resolve the observed frame. |
| U10 | Session-storage room for several draft crops on a phone browser. Slice 1 refuses an add that does not fit, so this decides how often the refusal shows, never whether a comment is lost. | Add sixteen 800-pixel crops on iOS Safari and Android Chrome and count the refusals. |
| U11 | Whether the browsers the operator uses keep a `Partitioned; SameSite=None; Secure; HttpOnly` cookie set by the preview site inside a Delegatus frame (Chromium, Firefox, Safari on macOS and iOS), and whether a `__Host-` cookie works on `http://<id>.localhost`. Decides whether slice 4 is framed or opens its own tab. | In each browser, frame a stub preview site from a stub Delegatus page, run the login of §6.4 and read whether the next request carries the cookie. |
| U12 | Which tool makes the capture browser's network namespace on each supported Linux: `unshare` worked here and bubblewrap's `--unshare-net` did not (§6.2). | On each target distribution, run the §11 network probe with both tools and record which one brings loopback up. |
| U13 | Whether Chromium's own sandbox starts inside the capture namespace. The probes ran with `--no-sandbox`; without the sandbox a renderer exploit has the OS user's files, which the app's own server code already has (D3). | Start the headless shell inside the namespace without `--no-sandbox` and read whether it starts and which sandbox layers it reports. |

## 9. Deferred — not currently justified

- Product-owned dev servers (slice 3) until the operator asks to look at
  finished lanes (Q2).
- The live embedded app (slice 4) until a preview address exists (Q4).
- Previews of other machines, tunnels and SSH forwarding (Emdash's
  `PortForwardService`); no requirement names them.
- An in-page devtools console, network capture and console capture (Vibe
  Kanban's injected Eruda and devtools scripts).
- Pointing at frames in decision forms and the task album; their comments go
  to a decision or to no single agent, a different target from a conversation.
- Mapping owner-stack lines to source lines through source maps (U9).
- Letting a capture load approved outside origins (web fonts, a CDN, a remote
  API) through a relay that refuses loopback, private and link-local
  addresses (§6.2). Slice 2 lists what it blocked instead.
- A network namespace for product-owned dev servers, which closes their
  ingress by construction and cuts their outbound access (§6.3); the ADR for
  slice 3 decides.
- Changing what agents inherit as `NODE_ENV` (§10); it is a separate change
  with effects beyond previews.
- A phone frame drawn on desktop. Slice 2 captures at 390 px.
- Recording videos of a preview, editing the page in place, several
  repositories in one preview.

## 10. A side finding: agents inherit `NODE_ENV=production`

Both structured hosts pass the Viewer's `NODE_ENV` to the agent
([claudeStreamBrokerHost.ts:480](../../src/lib/runtime/claudeStreamBrokerHost.ts#L480),
[codexAppServerHost.ts:545](../../src/lib/runtime/codexAppServerHost.ts#L545)),
and the Viewer runs production. A Vite dev server started by an agent then
serves production React: component names stay readable by walking the fiber
tree, but there is no owner, no owner stack and no source location (§5.4,
probes in §11). This design does not change it. Slices 3 and 4 set
`NODE_ENV=development` for the units they own; whether agents' environments
should stop inheriting it belongs to a separate task.

## 11. Evidence and method

**Earlier answers.** Transcript searches, project-scoped then unscoped, for
"live preview dev server click to comment", "dev server preview iframe agent
app embed", "клікнути елемент коментар агенту dev-сервер", "Vibe Kanban
preview proxy click-to-component", "element picker inspect click send
selector to agent prompt", "preview untrusted dev server separate origin
iframe sandbox", "живий перегляд застосунку" and "dev-сервер превью". They
found the 2026-10-23 decision form (§0), the research delivery, board
maintenance notes on this task, and agents in other projects running Vite dev
servers. They found no earlier design or implementation of dev-server
management or element picking in Delegatus. Memory searches for "live preview
dev server iframe embed agent app" and "agent browser access grant chrome
operator" returned nothing. The July research already listed Vibe Kanban's app
previews ([canvas-agent-orchestration-2026-07.md:19](../research/canvas-agent-orchestration-2026-07.md#L19)).
The deferred browser-control design is related but different: it lets an
agent drive the operator's browser ([worker-browser-control.md](worker-browser-control.md)).

**Code.** Read at `662a6012b39f`. Before handing over, `main` had moved to
`e4215ed935d9` (#3849, #3860); of the files cited here only
`scripts/owned-runner.ts` changed, by gaining the gate task limit that §6.2
and §6.3 now name. Open pull requests and open lanes were read
from the forge and the board on 2026-11-11; the two lanes without pushed
commits were read from their worktrees with `git --no-optional-locks`.
For revision 1, `main` was at `1037130eed9d` (#3858 added, which changes
`scripts/local-gate.ts`, cited nowhere here); the forge's comparison from
`662a6012b39f` showed no other cited file changed. Of the open pull requests
read on 2026-11-11, only #3861 touches a file this design cites
(`frameScope.ts`); none touches the composer, the picture tray, the image
viewer or the feed.

**Vendors.** Cloned with `git clone --depth 1 --filter=blob:none` into the
stage scratch directory; revisions and licences in §2. Documentation pages
and standards were fetched on 2026-11-11 and are linked where cited.

**Probes.** All in the stage scratch directory, with private `HOME`,
`XDG_CONFIG_HOME` and `LLV_STATE_DIR`, the Viewer control URL on a closed port,
`127.0.0.1` port 0, and every process stopped by the PID recorded at its start
(each run reports `viteStopped: true`). The sources and outputs are kept in
the stage's evidence directory under `live-preview-design-probe/`.

- `measure.mjs`: §5.6, three runs.
- `probe-fiber.mjs` and `probe-fiber-dev.mjs`: the React fields of §5.4 under
  the inherited `NODE_ENV=production` and under `development`. They read the
  component two `return` steps up, which for the button in `App` is the host
  `main` element; the name conclusion of the first version rested on that
  and is corrected by the revision-1 probe below.
- `probe-localhost.mjs`: Chromium 156 resolved `preview-a1.localhost` to the
  loopback server (status 200, `isSecureContext` true).
- Machine observations of §3.9: `nproc`, `free -b`, `/proc/loadavg`,
  `systemctl --user list-units --type=scope`, `ps` filtered to Node and Bun
  dev-server command lines, and the names (never the values) of the Viewer
  process's access variables.

**Revision-1 probes**, 2026-11-11 between 14:43 and 14:45 UTC, kept under
`live-preview-design-probe/revise-1/` with the same isolation:

- `run.sh` with `stubA.py`, `stubB.py`, `relay.py`, `chrome-netns.sh` and
  `drive.mjs`: Chromium 156.0.8078.4 headless shell through `playwright-core`
  1.62.1 loads page A, which reaches for B through nine channels. On the host
  network B accepted 9 connections; inside `unshare -Urn --pid --fork
  --kill-child` with the relay to A's port only, B accepted 0 and A loaded
  with status 200 (§6.2). The same session's `bwrap --unshare-user
  --unshare-net` refused with the loopback error quoted in §6.2. Every server
  and relay was stopped by its recorded PID; a final process listing found
  none left.
- `listeners.py`: the `/proc/net/tcp` and `/proc/net/tcp6` rows of
  listeners on `127.0.0.1`, `::1`, `0.0.0.0` and `::` (dual stack), each on
  port 0 and closed within the same run (§3.2, §6.2).
- `probe-depth.mjs`: React and react-dom 19.2.8 (the repository's own) in
  happy-dom 21.0.4 under `NODE_ENV=production` and `development`: no
  `_debug*` fields in production; the walk to composite fibers returned
  `App`, and `Card` then `App`, in both; two `return` steps from the button
  in `App` landed on `main` (§5.4).
- The Vibe Kanban picker re-read at `2d03b13` for its name fallback (§2.1),
  PR #3861's diff re-read for what `verifyFrameScope` checks (§5.3), and the
  systemd resource-control manual for `IPAddressDeny=` (§6.3).

No dev server ran against the operator's live state, no browser was left
open, and no product file other than this document was written.

## 12. What changed in revision 1

The first review round found five defects. Each was re-checked against the
code or the source behind it before the text changed.

1. **A dev server's own port could bypass the preview's protections.** The
   first version checked the URL's host name and the socket's owner; a server
   on `0.0.0.0` registered under a `127.0.0.1` URL passed both while its port
   stayed open to the network with no login. Re-checked: the
   `/proc/net/tcp{,6}` encodings of loopback and wildcard listeners
   (revision-1 probe). Changed: §3.2 says where a dev server listens and
   what that exposes; slice 2 registration now requires every listener on
   the port to be loopback and owned by the agent's scope, rechecked before
   every capture (§6.2); slice 3 finds its port from the unit's sockets and
   stops a unit that listens beyond loopback, with the 10-second window and
   the stronger alternatives stated (§6.3); §4, §5.2 and §5.3 no longer
   claim the perimeter covers the dev server's port.
2. **The separate preview site had no login of its own.** The first version
   relied on a capability in the host name and on W3's session binding.
   Re-checked: PR #3861's `verifyFrameScope` tests the life of the session
   named inside the token and never reads the requester's cookie, so a copied link
   works in another browser. Changed: §6.4 now specifies a one-time code
   minted by an authenticated same-origin request, a host-only `__Host-`
   cookie set in the owner's browser, the per-request and WebSocket checks,
   what is stripped upstream, and acceptance with a second browser; U11
   records what browsers must still show; §5.2, §5.3, §4 and Q4 follow.
3. **The capture browser could reach any address.** The first version
   limited navigation only. Re-checked by a probe: a page reached another
   loopback server through nine channels from a browser on the host network,
   and through none from a browser in its own network namespace. Changed:
   §6.2 runs the capture browser in a namespace whose only reachable address
   is a relay to the registered port, says what happens to fonts, CDNs and
   remote APIs, and refuses capture where no namespace can be made; the
   acceptance carries the two-server test; U12 and U13 are new; the
   outside-origin allow-list is deferred (§9).
4. **A refused session-storage write would have lost the crop.** The first
   version wrote through `writeDraftImages` and claimed the tray kept the
   picture. Re-checked: that function swallows the error and never touches
   the tray (`ConversationComposer.tsx:1532-1544`); the review round's probe
   on the real function confirmed it. Changed: slice 1 hands the comment to
   the mounted composer, which checks the limit, writes both storage keys or
   rolls both back, and only then adds the crop and the text to its
   in-memory state; the viewer keeps the ring and the note on any refusal
   (§6.1); §3.6 records the composer facts this rests on; U10 is reworded.
5. **Production React was said to hide component names.** It hides owners,
   owner stacks and source locations; component names stay readable. Re-checked by a probe on
   the repository's React 19.2.8 and against Vibe Kanban's fallback.
   Changed: §3.2, §5.4, §2.1, §2.3, §6.2's map script, §6.5 and §10 now
   keep the three facts apart, and §11 says why the first probe read the
   wrong fiber.
