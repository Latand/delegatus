Originating requirement, paraphrased from the verified owner relay dated 2026-10-22: inspect the public code of Delegatus competitors, beginning with Kipster, and identify useful improvements. This document supplies research and priorities; implementation remains a separate decision.

# Coding-agent fleet competitors, October 2026

The strongest candidates are human review comments attached to changed lines, a managed application preview, and reusable workspace setup. Delegatus already has the main orchestration machinery these tools advertise. The operator workflows between seeing a result and correcting it are the clearest area for improvement.

## What was observed

Kipster's source is public. A direct fetch of [kipster.app](https://kipster.app/) returned HTTP 200 and linked to the [Kipster repository][kipster]. The linked repository's homepage points back to the same site. GitHub repository searches for `kipster` and `"kipster.app"` were also checked: the name search found the matching repository, while the exact domain query returned zero repositories. The site's link and matching repository metadata establish the match; search absence alone would have missed it. The web search engine also returned unrelated namesakes.

Four additional open-source tools were selected: Vibe Kanban for a web workspace/review UI, Emdash for an integrated desktop workspace, ccmux for terminal fleet supervision, and Claude Squad for a smaller worktree/session manager. Each manages real coding-agent processes. General agent SDKs and chat-only interfaces were excluded.

### Snapshot and activity

The five main product repositories and Superset were read from GitHub's repository API on **2026-10-22, 15:43 UTC**. The separately discovered Kipster Software Factory companion was read at **15:54 UTC**. Stars are a point-in-time count. Last commit means the **committer timestamp of the cloned default-branch HEAD**, converted to UTC; `pushed_at` can describe a different ref and was not substituted for it. All compared repositories were unarchived. Popularity and recency do not establish reliability.

| Tool and repository | Licence at inspected revision | Stars | Default branch | Last commit, UTC | Inspected HEAD |
| --- | --- | ---: | --- | --- | --- |
| [Kipster][kipster] | [Apache-2.0][k-license] | 4 | `next` | 2026-10-22 12:14:34 | `981f8ced38115d12d246b84b03aa880d32bd27f2` |
| [Kipster Software Factory companion][factory] | [Apache-2.0][f-license] | 1 | `next` | 2026-10-19 17:06:39 | `c8cd2666483423145eb8652bcb6bfb038fe6deed` |
| [Vibe Kanban][vibe] | [Apache-2.0][v-license] | 28,426 | `main` | 2026-09-19 06:51:27 | `d5cbb5380fa0b32e98ef9b8d987f63decce4be3a` |
| [Emdash][emdash] | [Apache-2.0][e-license] | 6,055 | `main` | 2026-10-22 07:26:25 | `1a8b1321a813eb3aec1cf387fd705375583c6796` |
| [ccmux][ccmux] | [MIT][c-license] | 234 | `main` | 2026-10-18 20:06:16 | `333a7b37234a93fd5fdb6ea2e1bc9a59096428cd` |
| [Claude Squad][squad] | [AGPL-3.0][s-license] | 8,647 | `main` | 2026-08-20 05:09:45 | `ce1ffb4392b01f38e2c4599c7c84d2a93973b138` |

Counts came from the repository endpoints for [Kipster][k-meta], [its Software Factory companion][f-meta], [Vibe Kanban][v-meta], [Emdash][e-meta], [ccmux][c-meta] and [Claude Squad][s-meta]. Code links below pin the full inspected commit, so later changes on `main` or `next` do not change the evidence.

[Superset](https://github.com/superset-sh/superset) was screened and cloned as well. Its inspected revision, `3a2f0efb7762be0935677d2f416f845e9fd48793`, declares [Elastic License 2.0][superset-license], including a hosted-service restriction. It is treated here as source-available and excluded from the four open-source comparators. Its API reported 15,466 stars; inspected HEAD was committed on 2026-10-22 at 08:49:04 UTC. No Superset implementation is proposed for reuse.

### Method and limits

All seven repositories were cloned into this stage's external scratch directory, outside the Delegatus checkout. Inspection used `rg --files`, targeted `rg -n`, and reads of entry points and their callees. No competitor dependencies were installed, applications launched, agent accounts connected, or benchmark results inferred. UI observations below describe implemented controls and wiring. Rendered usability and accessibility were outside this audit.

The reproducible source procedure is `git clone --depth 1 --filter=blob:none <repository-url> <stage-scratch-destination>`, followed by `git show -s --format='%H %cI'`. To repeat this audit after a branch moves, fetch and check out the full SHA listed above. Repository metadata used `GET https://api.github.com/repos/{repository}` and the fields `default_branch`, `stargazers_count`, `archived`, and `license`. The star snapshot is recorded here; a later API call will return its later count.

Delegatus was inspected at **`a3e6d8b07a379d5ded546fa371c81077e5bada7e`**. All local `file:line` references below refer to that revision. Earlier [July research](canvas-agent-orchestration-2026-07.md#L19) already discussed Vibe Kanban, Claude Squad, inline feedback and workspaces. Project-scoped and unscoped transcript/memory searches found the current request and no additional completed Kipster comparison. Those earlier suggestions were checked against current code before ranking them again.

## Delegatus baseline: avoid proposing features it already has

The UI trace began at [src/app/page.tsx:1](../../src/app/page.tsx#L1), through [Viewer.tsx:82](../../src/components/Viewer.tsx#L82) and its mounted dashboard at [Viewer.tsx:1925](../../src/components/Viewer.tsx#L1925). Conversation diffs reach `BranchPane` → `LogFeed` → `FeedItem` → `ToolCard` → `DiffCard`; artifact links call the preview bus and reach the host mounted by `Viewer`. The pipeline editor is actually rendered by [SchemeBoard.tsx:1716](../../src/components/scheme/SchemeBoard.tsx#L1716). This distinguishes active surfaces from files merely present in the tree.

| Area | Current evidence | Consequence for the comparison |
| --- | --- | --- |
| Agent engines, accounts and limits | [AgentLaunchControls.tsx:40](../../src/components/draft/AgentLaunchControls.tsx#L40) defines Claude/Codex/Copilot launch choices; [AgentLaunchControls.tsx:61](../../src/components/draft/AgentLaunchControls.tsx#L61) limits default pipeline/seat choices. [README.md:147](../../README.md#L147) documents accounts and usage limits. | Multiple agents, accounts and model selectors are existing capabilities. Broader provider counts alone do not justify another engine integration. |
| Isolated worktrees | [src/lib/pipelines/git.ts:195](../../src/lib/pipelines/git.ts#L195) provisions from a persisted base SHA; [git.ts:161](../../src/lib/pipelines/git.ts#L161) resolves that base. | Worktree isolation already exists. A new idea needs a specific additional workspace interaction. |
| Review and merge | [types.ts:103](../../src/lib/pipelines/types.ts#L103) defines stages and fail edges; [autoMerge.ts:364](../../src/lib/forge/autoMerge.ts#L364) describes the active review/check-gated merge path. | Independent agent review, repair rounds and optional merging already exist. Human line comments would extend them. |
| Transcript diffs | [BranchPane.tsx:519](../../src/components/BranchPane.tsx#L519), [LogFeed.tsx:2190](../../src/components/LogFeed.tsx#L2190), [FeedItem.tsx:360](../../src/components/feed/FeedItem.tsx#L360) and [ToolCard.tsx:189](../../src/components/feed/cards/ToolCard.tsx#L189) reach [DiffCard.tsx:105](../../src/components/feed/cards/DiffCard.tsx#L105). It expands and copies tool-reported file diffs. | The increment is a current branch/file review surface with line-anchored feedback. |
| Artifact viewing and decisions | [Viewer.tsx:1987](../../src/components/Viewer.tsx#L1987) mounts previews; [markdown.tsx:135](../../src/components/feed/markdown.tsx#L135) opens them. [DocumentPanes.tsx:27](../../src/components/preview/DocumentPanes.tsx#L27) sandboxes HTML; [ArtifactPreviewHost.tsx:349](../../src/components/preview/ArtifactPreviewHost.tsx#L349) dispatches document/image panes. [prototypeReview/types.ts:123](../../src/lib/prototypeReview/types.ts#L123) already models decision forms. | HTML reports, previews and structured answers exist. A live application session or versioned document-edit submission is a distinct extension. |
| Attention, search and memory | [attentionQueue.ts:61](../../src/components/attention/attentionQueue.ts#L61) builds Needs you; [Viewer.tsx:1481](../../src/components/Viewer.tsx#L1481) binds attention/filter/search keys; [memory/mcp.ts:5](../../src/lib/memory/mcp.ts#L5) serves shared memory search. | Waiting-agent lists, keyboard access and shared memory already exist. |
| Workspace setup | [git.ts:2164](../../src/lib/pipelines/git.ts#L2164) installs frozen Bun dependencies before publication. Older [workflows/provision.ts:124](../../src/lib/workflows/provision.ts#L124) has setup execution, but [api/workflows/route.ts:13](../../src/app/api/workflows/route.ts#L13) returns 410 on creation and [retirement.ts:1](../../src/lib/flows/retirement.ts#L1) retires flows/workflows. Active [CreatePipelineRequest, types.ts:1285](../../src/lib/pipelines/types.ts#L1285) has no declarative workspace lifecycle recipe. | Publication installation is real; the old setup engine is historical code. A general repository recipe is a gap in the active pipeline contract. |
| Worktree retention and pause | [worktreeSweep.ts:196](../../src/lib/pipelines/worktreeSweep.ts#L196) records kept/removed paths and reasons; [worktreeSweep.ts:1558](../../src/lib/pipelines/worktreeSweep.ts#L1558) exposes aggregate counts/bytes through [resources.ts:2672](../../src/lib/resources.ts#L2672). [engine.ts:14160](../../src/lib/pipelines/engine.ts#L14160) pauses execution without removing the checkout. | Cleanup and pause already exist. A per-worktree explanation view and deliberate checkout parking would be new increments. |
| Scheduling and PR sources | [SeatTickSettings, seatTickSettings.ts:105](../../src/lib/monitor/seatTickSettings.ts#L105) has an interval, enable switch and expiry. [types.ts:1285](../../src/lib/pipelines/types.ts#L1285) accepts delivery PR metadata and pinned bases; [PipelineEditor.tsx:72](../../src/components/pipelines/PipelineEditor.tsx#L72) edits task/spec/repository. | Scheduling and PR-aware pipelines exist. Named weekday/time-zone windows and a PR/issue picker with a launch preview were not found in these active contracts/surfaces. |

Gap statements are scoped to the checked UI and pipeline contracts. The targeted search covered `src/components`, `src/lib`, API routes and `docs/guide`, excluding tests and generated provider protocol types. Terms included `devServer`, `previewServer`, `review.comment`, `inline.comment`, `inspect.mode`, `setupScript`, `teardownScript`, document submission, schedules and worktree reports. A prompt can already ask an agent to approximate many of these workflows; the proposed increment is explicit product support.

## Tool findings

### Kipster

Kipster is an early personal-agent system with a central admin agent, persistent conversations and agent-owned files. Its [README][k-readme] explicitly labels it early development and not a supported release. Core's personal-agent use case is adjacent to Delegatus; the separate [Software Factory][factory] addresses coding fleets directly.

The Node/TypeScript entry, [`core/src/host.ts`][k-host], composes PostgreSQL, providers and the HTTP service. [`core/src/runtime.ts`][k-runtime] owns persisted services; [`platform/jobs/public.ts`][k-jobs] uses pg-boss for durable wakeups. [`workflows/adapter-registry.ts`][k-adapters] forks adapter runners and tracks readiness, generations and failures. The Codex adapter starts an app-server process and opens/resumes threads in [`adapters/codex-cli/src/index.ts`][k-codex]; the Claude adapter uses a detached `claude -p` stream-json process and group termination in [`adapters/claude-cli/src/process.ts`][k-claude]. These are observed implementations, including Claude code beyond the README diagram's status labels.

The dispatcher assigns each execution the kip's directory in [`text-dispatch.ts`][k-dispatch]. The inspected dispatch path uses that directory without creating Git worktrees or establishing an OS sandbox. Core's routes cover conversations, work and approvals; no dedicated coding PR/review/merge conveyor was found in this audit. [`interface/kipster-ui/src/main.tsx`][k-ui] mounts a React app with browser/Tauri platform selection; its connected workspace mounts documents and work panels in [`Workspace.tsx`][k-workspace].

The companion has its own CLI/server and executor path. [`src/server.ts`][f-server] composes a Hono API, PostgreSQL store, workflow library and scheduler. [`executors/cli.ts`][f-cli] builds fresh Codex/Claude commands; [`executors/supervisor.ts`][f-supervisor] watches its IPC parent and terminates the child group on disconnect. [`workspace/workspaces.ts`][f-workspaces] maintains repository caches and ticket worktrees. [`engine/merge-gate.ts`][f-merge] gathers live PR/CI and tester/reviewer evidence; [`domain/merge-gate.ts`][f-domain] checks verdict commits against the current head and records blockers or owner decisions. [`web/src/App.tsx`][f-ui] routes the React UI through Today, repositories, workflows, tickets and decisions. This establishes a real coding workflow and substantial overlap with Delegatus's current pipeline/review/merge behavior. The [repository kit][f-kit] declares setup, checks and verification startup/readiness; the [verification harness][f-verification] supplies disposable checkouts, ports and optional databases. Those smaller configuration ideas reinforce ranks 2 and 3.

Two concrete ideas stand out. A document can carry editable blocks, questions and comments, then submit a revision back to an agent through [`modules/documents/public.ts`][k-docs] and [`transport/http/documents.ts`][k-doc-routes]; [`SubmitDock.tsx`][k-submit] shows the pending answers, comments, edits and saved-draft state. Delegatus's artifact preview and decision forms cover reading and answering, while this document round trip is an additional interaction (rank 8). [`modules/routines/schedule.ts`][k-schedule] expresses weekday/time-zone schedules; [`routine-dispatch.ts`][k-routines] uses a shared timer and persisted due work. Calendar-aware wake windows would extend Delegatus's interval/expiry settings (rank 9). Its memory, admin-agent and approval concepts overlap existing Delegatus features and are not ranked as missing.

### Vibe Kanban

Vibe Kanban brings coding-agent workspaces, chat, diffs, review and application preview into a web UI. [`crates/server/src/main.rs`][v-entry] starts an Axum/Tokio server and a separate preview-proxy listener. The local deployment's [`container.rs`][v-container] owns child processes, cancellation, log persistence and exit monitors; its name does not establish container-based security. Claude and Codex executors launch process groups in [`executors/claude.rs`][v-claude] and [`executors/codex.rs`][v-codex]. [`workspace_manager.rs`][v-workspaces] creates one worktree per repository inside a workspace and rolls back worktrees created before a provisioning failure. This also supports a workspace spanning multiple repositories.

Review is an operator-facing activity as well as an agent action. [`ReviewProvider.tsx`][v-review] collects file/line/side comments and formats review Markdown; [`SessionChatBoxContainer.tsx`][v-chat] consumes that context. [`WorkspacesLayout.tsx`][v-layout] mounts the review provider and preview. [`routes/workspaces/git.rs`][v-git] supplies diff, merge and rebase endpoints, refusing a direct local merge when an open PR exists. This code does not establish a Delegatus-style required independent-review policy.

The useful increments are a branch review workspace that hands selected comments to the agent (rank 1), explicit development-server start/stop and responsive preview via [`usePreviewDevServer.ts`][v-dev] and [`PreviewBrowserContainer.tsx`][v-preview] (rank 2), and click-to-component context sent into the prompt (rank 5). Delegatus already renders transcript diffs and sandboxed HTML artifacts at the baseline references above. Neither surface supplies these complete workflows. Multi-repository workspaces are observed, but deferred because the originating request supplies no cross-repository execution requirement.

### Emdash

Emdash is an Electron development environment for local or SSH projects, agent sessions and code review. [`apps/emdash-desktop/src/entry/main.ts`][e-entry] loads the desktop bootstrap; [`main/bootstrap/index.ts`][e-bootstrap] opens a window, completes backend startup and handles startup recovery. The process layer supports PTYs through [`NodePtySpawner`][e-pty] and structured ACP connections through [`acp-agent-connection.ts`][e-acp], with exit handling and scope-owned teardown. [`session-lifecycle.ts`][e-sessions] persists and reconciles session intent. [`create-worktree.ts`][e-worktree] provisions branches/checkouts and reports provisioning stages. A worktree separates files; it does not itself restrict the agent's host permissions.

The source-control [`changes-panel.tsx`][e-changes] composes staged, unstaged and PR views. [`draft-comments-context.ts`][e-comments] appends line comments to agent context. [`pull-request-engine.ts`][e-pr] delegates PR creation/merge operations to integration clients; this is evidence of integrated actions, without a claim that Emdash enforces Delegatus's review policy. [`build-create-task-params.ts`][e-task] builds initial PTY/ACP conversations and derives a review state for a linked open PR.

Its strongest incremental idea is a small repository recipe: [`.emdash.json` schema][e-config] declares `prepare`, `setup`, `run`, `teardown`, shell setup and explicit preservation patterns. [`scripts-plane.ts`][e-scripts] runs lifecycle commands through the shared scripts runtime and reports success, failure, timeout and cancellation. [`lifecycle-scripts.ts`][e-script-ui] exposes run/stop/status in the UI (rank 3). This extends Delegatus's publication dependency installation and avoids reviving its retired workflows. Emdash also reinforces the PR launch picker (rank 4) and preview discovery through [`preview-server-service.ts`][e-preview]. Automatically copying ignored files is not recommended: dependency caches and secret-bearing configuration require different treatment.

### ccmux

ccmux supervises coding-agent sessions through a daemon and a terminal UI. [`src/index.ts`][c-entry] enters its command program; [`daemon/index.ts`][c-daemon] starts transcript watchers, hooks, reconciliation, attention tracking and the server. [`daemon/server.ts`][c-server] handles spawning and session control; [`spawn-command.ts`][c-spawn] builds tmux window/pane arguments. Agent state combines hooks, transcripts and process/pane observations. [`worktree-create.ts`][c-worktree] provisions worktrees, while [`worktree-move-changes.ts`][c-move] can relocate existing uncommitted work using a retained stash and explicit failure outcomes. These worktrees separate files. Host permissions remain a separate concern.

The CLI's [`commands/review.ts`][c-review] opens an external `hunk` viewer; the TUI's [`utils/review.ts`][c-review-ui] collects review notes for handback. Review depends on that external tool. [`commands/worktree.ts`][c-prune] presents cleanup candidates and skipped reasons, and documents that its dry-run still fetches/prunes remote-tracking refs. GitHub helpers supply PR observations. The inspected review and spawn paths do not implement a required review/merge pipeline.

The [PR/issue source picker][c-picker] and [`gh-spawn-source.ts`][c-source] turn a selected source into a seeded agent prompt and checkout (rank 4). The per-worktree candidate/skip presentation suggests exposing Delegatus's existing sweep evidence as an operator drilldown (rank 6). Moving a dirty checkout suggests an explicit import-from-local-changes action (rank 7); the first Delegatus slice should copy a reviewed patch and preserve the source. Its waiting-agent list, handoffs, search and attention tracking largely overlap existing Delegatus behavior.

### Claude Squad

Claude Squad is a compact Go/Bubble Tea terminal manager. [`main.go`][s-entry] starts the TUI or optional daemon. [`app/app.go`][s-app] composes the session list, preview/diff/terminal tabs and session commands. [`session/instance.go`][s-session] creates worktrees and tmux sessions, persists session metadata and exposes pause/resume. [`session/tmux/tmux.go`][s-tmux] runs the agent command; [`session/git/worktree_ops.go`][s-worktree] creates or restores a checkout from a branch. Supervision is tmux/session-oriented, with an optional [`daemon/daemon.go`][s-daemon] polling prompts and pressing Enter in auto-yes mode. Auto-yes is not a review gate and is not recommended for adoption.

Review is a diff/checkout/push handoff in the TUI; the inspected paths do not implement Delegatus's independent-review conveyor. The useful difference is explicit checkout parking: `Pause` commits dirty changes locally, detaches the session, removes the worktree and keeps the branch; `Resume` recreates or reuses it. That suggests an optional disk-saving parked state (rank 10), distinct from Delegatus's execution pause at [engine.ts:14160](../../src/lib/pipelines/engine.ts#L14160).

The implementation also contains aggressive orphan-directory removal and accumulated-error paths around pause/restore. This is an interaction idea only, with no inference that its recovery algorithm is safe to transplant. Delegatus's existing preservation rules remain the baseline. Session lists, profiles and diff tabs otherwise add little that is missing.

## Ranked improvement shortlist

Ranking is an architectural judgement about operator value and reuse of existing Delegatus primitives. **S** means one local surface/helper; **M** means a bounded UI/backend workflow; **L** crosses persisted lifecycle or runtime boundaries. The estimates describe scope. Risk names the main implementation hazard. Only the first slice is proposed for further design.

| Rank | Improvement and operator benefit | Competitor evidence and Delegatus delta | Effort / risk | First slice |
| ---: | --- | --- | --- | --- |
| 1 | Review changed files and send line comments back to the responsible agent. Avoid retyping paths and describing which line needs correction. | [Vibe Kanban review context][v-review], [Emdash comment handback][e-comments]. Extends the existing [DiffCard.tsx:105](../../src/components/feed/cards/DiffCard.tsx#L105), which displays tool diffs. | **M**, medium: comments become stale when the branch moves. | Open a bounded changed-file list for one pipeline, pin base/head SHAs, add line/side comments, and send one explicit feedback message. If the head changes, ask for re-anchoring; retain the draft. Reuse current delivery receipts. |
| 2 | Give an app preview a visible owner and readiness state. Let the operator inspect a working result without finding a terminal URL. | [Vibe Kanban dev-server controls][v-dev] and [preview][v-preview], [Emdash preview service][e-preview], [Kipster Factory verification][f-verification]. Extends static [DocumentPanes.tsx:27](../../src/components/preview/DocumentPanes.tsx#L27). | **L**, high: process ownership, port collisions and separating an untrusted app from Viewer authority. | Support one explicitly configured local dev command for one workspace, an assigned free port, readiness probe, logs, and stop of its owned process. Open a separate origin. Embedding and remote forwarding can follow. |
| 3 | Reuse a repository's workspace setup recipe. Make dependency/service failures visible before an agent spends a turn diagnosing its environment. | [Emdash config][e-config] and [script execution][e-scripts], [Kipster Factory kit][f-kit]. Active [types.ts:1285](../../src/lib/pipelines/types.ts#L1285) has no recipe; [git.ts:2164](../../src/lib/pipelines/git.ts#L2164) already handles publication dependencies. | **M**, medium: repository-supplied commands execute on the host; retries can repeat side effects. | An opt-in project setting for one setup command, pinned to its reviewed content, with cwd, output and settled result. Run it before the first builder; retain failures for retry. Add no new workflow engine. |
| 4 | Start from a selected PR or issue with a checkout preview. Reduce mistakes about the source branch, task context and an already-existing workspace. | [ccmux source picker][c-picker] and [resolver][c-source], [Emdash linked PR task][e-task]. Delegatus already accepts delivery PR and base metadata in [types.ts:1285](../../src/lib/pipelines/types.ts#L1285); its editor exposes task/spec/repository at [PipelineEditor.tsx:72](../../src/components/pipelines/PipelineEditor.tsx#L72). | **M**, medium: fork remotes, stale heads and duplicated tasks. | Paste a PR URL, show resolved repository/base/head, find an existing linked task, and prepare a draft pipeline for review. No launch occurs until the ordinary start action. Issue search can follow. |
| 5 | Select a rendered element and attach its context to feedback. Make visual corrections specific without requiring the operator to know component names. | [Vibe Kanban component bridge][v-preview]. Delegatus's [ArtifactPreviewHost.tsx:349](../../src/components/preview/ArtifactPreviewHost.tsx#L349) supplies document viewers, without this selector-to-prompt interaction. | **M** after rank 2, high: page messages and selectors are untrusted input. | For an opted-in preview, capture the selected element's text/selector and preview revision into a visible draft message. Validate the frame and message shape; send only after the operator reviews it. Source mapping is optional. |
| 6 | Explain retained worktrees individually. Let the operator find which completed task consumes disk and why cleanup kept it. | [ccmux cleanup presentation][c-prune]. Delegatus already records path/reason/bytes at [worktreeSweep.ts:196](../../src/lib/pipelines/worktreeSweep.ts#L196), but exposes aggregates at [worktreeSweep.ts:1558](../../src/lib/pipelines/worktreeSweep.ts#L1558). | **S** for a bounded read view, low: stale evidence or paths shown outside the permitted project. | Add an authorized, paged drilldown of the persisted sweep report: task, relative checkout, bytes, reason and observation time. Reuse the sweep's decisions. Add no deletion action in this slice. |
| 7 | Seed an isolated task from reviewed local changes. Let an operator hand unfinished work to an agent without first arranging a commit. | [ccmux change relocation][c-move]. Delegatus's [git.ts:195](../../src/lib/pipelines/git.ts#L195) provisions from a commit, with no patch-import field in [types.ts:1285](../../src/lib/pipelines/types.ts#L1285). | **M**, high: untracked files, conflicts and concurrent source edits. | Preview and copy a tracked-files patch against an exact source HEAD into a fresh checkout. Leave source files and the index untouched. Refuse conflicts and preserve the patch; defer untracked/ignored files and any move operation. |
| 8 | Submit comments and small edits against a document revision. Let the operator correct an agent's proposal in the document's context. | [Kipster revisioned documents][k-docs] and [submission UI][k-submit]. Extends the existing read/render panes at [DocumentPanes.tsx:59](../../src/components/preview/DocumentPanes.tsx#L59) and decision forms at [prototypeReview/types.ts:123](../../src/lib/prototypeReview/types.ts#L123). | **M** for comments, **L** for editing, medium: stale revisions and conflicting submissions. | Attach comments to quoted ranges in one immutable Markdown artifact and submit them as one message to its producing stage. Start with comments; editing and rich blocks remain optional. |
| 9 | Add optional weekday/time-zone wake windows. Make periodic maintenance match the operator's working schedule. | [Kipster schedule parser][k-schedule] and [due-work dispatcher][k-routines]. Extends interval/expiry scheduling at [seatTickSettings.ts:105](../../src/lib/monitor/seatTickSettings.ts#L105). | **M**, medium: daylight-saving changes, restarts and postponed work. | Add one named time zone and weekday window for scheduled maintenance wakes, with the next wake displayed. Keep explicit messages and active pipeline work independent. Define skip/coalesce behavior for missed windows before enabling it. |
| 10 | Offer deliberate checkout parking for stopped work. Retain a resumable task while reclaiming a checkout only when preservation can be proven. | [Claude Squad Pause/Resume][s-session]. Delegatus's [engine.ts:14160](../../src/lib/pipelines/engine.ts#L14160) already stops execution; its sweep handles eligible settled work. Parking an unfinished task would be additional behavior. | **L**, high: user files, transcript resumability, artifacts and branch changes. | First prove a park/restore round trip for a stopped, clean, fully preserved checkout in scratch. Require an immutable commit and known artifact locations; refuse dirty or unaccounted files. Consider a product action only if rank 6 shows meaningful disk pressure. |

Ranks 1 and 8 share feedback-delivery primitives, but their anchors differ: a Git base/head/line versus an artifact revision/quoted range. They should share message delivery, without forcing both source models into a new general annotation framework. Rank 5 depends on a usable preview. Ranks 6 and 10 concern explanation and lifecycle mutation respectively; the read view should precede any parking mechanism.

## Licence and adoption boundaries

Delegatus's current [LICENSE:1](../../LICENSE#L1) is MIT. The inspected Kipster Core, Software Factory, Vibe Kanban and Emdash roots are Apache-2.0; ccmux is MIT; Claude Squad is AGPL-3.0. The classifications were checked against the pinned licence files. Superset's ELv2 restrictions are the reason it is outside the open-source set.

Every ranked item is **an idea for an independent Delegatus implementation**. No competitor source, assets, prompts, fixtures or screenshots were copied into this repository. AGPL-licensed Claude Squad code is a reference for behavior only; it must not be pasted into an MIT-distributed module. Superset code is also excluded from reuse. Any later proposal to reuse even MIT/Apache-licensed code needs a separate check of the actual file, bundled dependencies, licence/NOTICE obligations and the intended distribution. This research authorizes no such import.

## Deferred — not currently justified

- Replacing the runtime host, pipeline engine, state database or memory system with a competitor's architecture. No inspected code or measurement establishes a benefit that would justify that migration.
- General multi-repository execution based on Vibe Kanban's workspace manager. It adds shared provisioning and release coordination without a concrete requirement here.
- Broad provider expansion, an external adapter/plugin marketplace, or automatic configuration imports. Existing engine capability and account controls already solve the central fleet case; each new provider requires its own control and recovery contract.
- Auto-yes prompt acceptance, aggressive orphan cleanup, automatically copying ignored configuration, and moving a dirty source checkout. The useful interactions can be implemented while preserving Delegatus's current ownership and data-preservation rules.
- A rich document editor, remote preview tunnels, and checkout parking in the first implementation batch. Their smaller predecessors appear in ranks 8, 2 and 6; the larger mechanisms need evidence of demand.
- New board/canvas modes, universal annotation infrastructure, and another workflow DSL. Existing task, stage, decision and delivery objects are sufficient for the first slices.

## Validation of this research

The report covers Kipster plus four open-source coding-fleet tools, their licences and dated activity, actual spawn/supervision and workspace paths, review/merge boundaries, UI wiring, and ten ranked ideas. Gap claims name the active Delegatus behavior they would extend. Source inspection supports the architectural descriptions; no claims of measured speed, cost, stability or rendered UI quality are made. Validation checked every linked local/external source path against the inspected trees, every numeric line anchor against file bounds, all reference definitions, and the ten ranked rows. The whitespace check and the project's scoped publication privacy gate passed. Privacy validation ran from a scratch source export with isolated HOME, configuration, state and temporary directories. Product tests and browser checks were unnecessary for this documentation-only change.

[kipster]: https://github.com/manikanta-kops/kipster
[vibe]: https://github.com/BloopAI/vibe-kanban
[emdash]: https://github.com/generalaction/emdash
[ccmux]: https://github.com/epilande/ccmux
[squad]: https://github.com/smtg-ai/claude-squad
[k-meta]: https://api.github.com/repos/manikanta-kops/kipster
[v-meta]: https://api.github.com/repos/BloopAI/vibe-kanban
[e-meta]: https://api.github.com/repos/generalaction/emdash
[c-meta]: https://api.github.com/repos/epilande/ccmux
[s-meta]: https://api.github.com/repos/smtg-ai/claude-squad
[k-license]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/LICENSE
[v-license]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/LICENSE
[e-license]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/LICENSE.md
[c-license]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/LICENSE
[s-license]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/LICENSE.md
[superset-license]: https://github.com/superset-sh/superset/blob/3a2f0efb7762be0935677d2f416f845e9fd48793/LICENSE.md
[k-readme]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/README.md
[k-host]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/host.ts
[k-runtime]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/runtime.ts
[k-jobs]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/platform/jobs/public.ts
[k-adapters]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/workflows/adapter-registry.ts
[k-codex]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/adapters/codex-cli/src/index.ts#L109
[k-claude]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/adapters/claude-cli/src/process.ts
[k-dispatch]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/workflows/text-dispatch.ts#L766
[k-ui]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/interface/kipster-ui/src/main.tsx
[k-workspace]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/interface/kipster-ui/src/features/workspace/Workspace.tsx#L2384
[k-docs]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/modules/documents/public.ts
[k-doc-routes]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/transport/http/documents.ts
[k-submit]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/interface/kipster-ui/src/features/documents/SubmitDock.tsx
[k-schedule]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/modules/routines/schedule.ts
[k-routines]: https://github.com/manikanta-kops/kipster/blob/981f8ced38115d12d246b84b03aa880d32bd27f2/core/src/workflows/routine-dispatch.ts
[v-entry]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/server/src/main.rs
[v-container]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/local-deployment/src/container.rs#L480
[v-claude]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/claude.rs#L630
[v-codex]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/codex.rs#L653
[v-workspaces]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/workspace-manager/src/workspace_manager.rs#L292
[v-review]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/packages/web-core/src/shared/hooks/ReviewProvider.tsx
[v-chat]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/packages/web-core/src/features/workspace-chat/ui/SessionChatBoxContainer.tsx#L298
[v-layout]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/packages/web-core/src/pages/workspaces/WorkspacesLayout.tsx#L212
[v-git]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/server/src/routes/workspaces/git.rs#L179
[v-dev]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/packages/web-core/src/features/workspace/model/hooks/usePreviewDevServer.ts
[v-preview]: https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/packages/web-core/src/pages/workspaces/PreviewBrowserContainer.tsx#L438
[e-entry]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/entry/main.ts
[e-bootstrap]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/main/bootstrap/index.ts
[e-pty]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/packages/core/src/services/pty/api/node/node-pty-spawner.ts
[e-acp]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/packages/core/src/runtimes/acp/node/connection/acp-agent-connection.ts
[e-sessions]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/packages/core/src/services/session-lifecycle/node/session-lifecycle.ts
[e-worktree]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/packages/core/src/runtimes/workspace-registry/node/create-worktree.ts
[e-changes]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/core/features/source-control/contributions/browser/changes-panel.tsx
[e-comments]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/core/features/conversations/browser/acp/draft-comments-context.ts
[e-pr]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/core/services/pull-requests/node/engine/pull-request-engine.ts#L50
[e-task]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/core/features/tasks/browser/create-task-modal/build-create-task-params.ts
[e-config]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/packages/core/src/primitives/emdash-config/api/emdash-config.ts
[e-scripts]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/packages/core/src/runtimes/workspace-registry/node/scripts-plane.ts
[e-script-ui]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/core/features/workspaces/api/browser/lifecycle-scripts.ts
[e-preview]: https://github.com/generalaction/emdash/blob/1a8b1321a813eb3aec1cf387fd705375583c6796/apps/emdash-desktop/src/core/features/preview-servers/node/preview-server-service.ts
[c-entry]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/index.ts
[c-daemon]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/daemon/index.ts#L438
[c-server]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/daemon/server.ts#L4317
[c-spawn]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/daemon/spawn-command.ts#L883
[c-worktree]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/daemon/worktree-create.ts
[c-move]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/daemon/worktree-move-changes.ts
[c-review]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/commands/review.ts
[c-review-ui]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/tui/utils/review.ts
[c-prune]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/commands/worktree.ts
[c-picker]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/tui/components/source-picker-rows.ts
[c-source]: https://github.com/epilande/ccmux/blob/333a7b37234a93fd5fdb6ea2e1bc9a59096428cd/src/daemon/gh-spawn-source.ts
[s-entry]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/main.go
[s-app]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/app/app.go
[s-session]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/instance.go#L422
[s-tmux]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/tmux/tmux.go
[s-worktree]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/git/worktree_ops.go
[s-daemon]: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/daemon/daemon.go
[factory]: https://github.com/manikanta-kops/kipster-software-factory
[f-meta]: https://api.github.com/repos/manikanta-kops/kipster-software-factory
[f-license]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/LICENSE
[f-server]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/server.ts
[f-cli]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/executors/cli.ts
[f-supervisor]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/executors/supervisor.ts
[f-workspaces]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/workspace/workspaces.ts
[f-merge]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/engine/merge-gate.ts
[f-domain]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/domain/merge-gate.ts#L114
[f-ui]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/web/src/App.tsx
[f-kit]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/kit/kit.ts
[f-verification]: https://github.com/manikanta-kops/kipster-software-factory/blob/c8cd2666483423145eb8652bcb6bfb038fe6deed/src/verification/harness.ts
