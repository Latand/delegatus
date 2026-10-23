# Human route workspace gates

Slice (b) applies the workspace directory from `docs/design/workspaces.md` to
human HTTP callers. `src/lib/team/gate.ts` checks the signed-in member before
routing; `src/lib/team/workspaceRoute.ts` resolves and checks every supplied
project, cwd, transcript, task and pipeline target before a project handler.
Unknown routes require the owner. An unreadable authorization store refuses
access. Verified agent and service credentials retain their existing checks;
the MCP workspace fence belongs to slice (c).

The owner retains all reads and writes, including on installations with no
workspaces. Members read and act inside their workspaces. Managers also read
Unassigned catalog projects and can place them into a workspace they manage;
unknown keys cannot be placed by managers. Local file routes require both
catalog membership and project access, including when an older placement
already names an undiscovered key. Other writes require workspace membership.
Project-settings reads allow members; `PUT /api/projects/settings` requires
the project's workspace manager or the owner. Resource-panel pane targets
and the `kill-target` action on `/api/conversation-host` and `/api/tmux`
require the owner, including beside an authorized conversation identity.
A person with no workspace opens the Team page and its own sign-in/session surface. Foreign project requests return
403 `workspace_forbidden`; aggregate reads filter their source rows. Scoped
board responses use private validators scoped to the member and their current
permissions. The route translates these to an operator validator internally;
an unchanged source returns 304 without decoding or re-encoding its JSON.
Full member responses support gzip; operator deltas remain private.
Conversation cursors bind the member and their permission snapshot.
Streams refresh project authority once per replay or log batch, after awaited
reads and before emitting bytes, and retain session revocation. Runtime
snapshots load one ownership resolver for the whole batch.

## Shared records and writers

| Record | Producers and defaults | Consumers and cascades |
|---|---|---|
| `workspace_members` | Owner or workspace manager through `PUT /api/team/workspaces/[id]/members`; invite redemption inserts role `member` in the redemption transaction. No implicit membership for a plain invite. | Workspace gates, directory, Activity, board/runtime projection and streams. Workspace deletion removes its rows; member status is checked on each request. Reopening the store retains membership. |
| Invite challenge `payload.workspaceId` | Owner may omit it; a manager must name a workspace they manage. Uses the existing durable challenge payload; no secret is published. | Redemption rechecks the active inviter and workspace authority before consuming the challenge, creating the person, membership and session in one transaction. List/withdraw checks the same workspace permission. A missing/deleted workspace refuses redemption. |
| Project placement | Existing canonical project rows; manager may move Unassigned or their own managed project into a workspace they manage, or return their own project to Unassigned. Owner keeps all placements. | The existing alias resolver determines the workspace on every lookup. Task ids, pipeline ids and persisted conversation ownership take precedence over submitted hints; the cwd is checked independently at launch. Deputy ask ids, retry ids, seat ids and saved request replays are checked against stored ownership. |
| Activity scope | Server supplies canonical readable keys, including discovered Unassigned projects for managers. | Human and agent inputs are filtered before time aggregation. Token queries apply the same restriction to totals, series, lists and comparisons; the permission snapshot participates in the cache key. |

## Decisions

- **project**: resolve every target and check its workspace before the handler;
  read-only POST batches check every transcript. Placement has a separate manager check.
- **collection**: check explicit targets and filter collection rows at the producer.
- **owner**: installation-wide settings, credentials, maintenance or stores with
  no project ownership (including unattached draft uploads).
- **team**: the team handler enforces member, own-session, owner or workspace-manager
  permission; task icon glyphs are static assets available to signed-in people.
- **capability**: MCP keeps its verified caller contract for slice (c). Opaque HTML
  frames use a signed, expiring directory grant minted by the gated artifact route.
- **peer**: authenticated linked-install transport; its existing peer grant applies.

## Pages and assets

| Route | Decision |
|---|---|
| `/` | Signed-in workspace member; an unplaced member redirects to `/team`. Owner unchanged. |
| `/activity` | Same page gate; HTTP reports apply the server-derived project filter. |
| `/team` | Any signed-in member, including one with no workspace. |
| `/team/workspaces/[id]` | Owner or member of that workspace. |
| `/sign-in`, `/join/[code]` | Existing read-only sign-in pages; their action endpoints retain their own checks. |
| `/telegram-file-confirmation` | Signed-in workspace member; its installation endpoints remain owner-only. |
| `/_next/static/*`, `/brand/*`, icons and manifest | Existing static assets; Host checks remain. |

## API route inventory

Every route is listed below. GET also receives Next's implicit HEAD handling
unless a separate HEAD handler is listed. The inventory test fails when a
served API route has no declared decision or a project handler loses its gate.

| Route | Exported methods | Gate |
|---|---|---|
| `/api/access` | GET | owner |
| `/api/access/phone` | POST | owner |
| `/api/account-migrations/[intentId]` | POST | owner |
| `/api/account-project-bindings` | GET, POST | owner |
| `/api/accounts` | GET | owner |
| `/api/accounts/claude` | DELETE, PATCH, POST | owner |
| `/api/accounts/claude/[id]/status` | GET | owner |
| `/api/accounts/claude/active` | POST | owner |
| `/api/accounts/claude/limits` | POST | owner |
| `/api/accounts/claude/login/[operationId]` | DELETE | owner |
| `/api/accounts/claude/login/[operationId]/input` | POST | owner |
| `/api/accounts/claude/policy` | PATCH | owner |
| `/api/accounts/claude/terminal` | POST | owner |
| `/api/accounts/cli` | GET | owner |
| `/api/accounts/codex` | DELETE, POST | owner |
| `/api/accounts/codex/active` | POST | owner |
| `/api/accounts/codex/limits` | POST | owner |
| `/api/accounts/codex/policy` | PATCH | owner |
| `/api/accounts/codex/reset-credits` | GET, POST | owner |
| `/api/accounts/codex/terminal` | POST | owner |
| `/api/accounts/copilot` | DELETE, GET, POST | owner |
| `/api/accounts/copilot/models` | GET | owner |
| `/api/activity` | GET | collection |
| `/api/activity/tokens` | GET | collection |
| `/api/agent` | GET | owner |
| `/api/agent/snapshot` | POST | owner |
| `/api/answer` | POST | project |
| `/api/artifact` | GET | project |
| `/api/artifact/frame/[...rest]` | GET | capability |
| `/api/asks-you` | GET, PUT | owner |
| `/api/asks-you/key` | GET, PUT | owner |
| `/api/attach-command` | GET | project |
| `/api/attention` | GET, POST | owner |
| `/api/attention/[id]` | POST | owner |
| `/api/attention/dismissals` | POST | project |
| `/api/attention/done` | GET, POST | collection |
| `/api/attention/needs-you` | POST | project |
| `/api/board` | GET, PATCH | project |
| `/api/board/maintenance/worktrees` | POST | owner |
| `/api/bridge` | GET, POST | owner |
| `/api/composer-upload` | POST | owner |
| `/api/conversation-host` | GET, POST | project |
| `/api/conversation-host/targets` | POST | project |
| `/api/conversations` | GET | collection |
| `/api/conversations/[conversationId]/migration` | GET, POST | project |
| `/api/external-relay` | GET | owner |
| `/api/external-relay/conversations` | GET | owner |
| `/api/external-relay/known` | GET | owner |
| `/api/external-relay/owner-history` | POST | owner |
| `/api/external-relay/pairings` | POST | owner |
| `/api/external-relay/pairings/[id]` | DELETE, GET, POST | owner |
| `/api/external-relay/relays/[id]` | DELETE, PATCH | owner |
| `/api/external-relay/relays/[id]/clone-avatars` | POST | owner |
| `/api/external-relay/relays/[id]/clone-requests` | POST | owner |
| `/api/external-relay/relays/[id]/clone-requests/[requestId]` | DELETE, GET | owner |
| `/api/external-relay/relays/[id]/targets/[targetId]` | PATCH | owner |
| `/api/external-relay/relays/[id]/targets/[targetId]/answers` | GET | owner |
| `/api/external-relay/relays/[id]/targets/[targetId]/answers/[requestId]` | GET | owner |
| `/api/files` | GET, HEAD | collection |
| `/api/flows` | GET, POST | owner |
| `/api/flows/[id]` | PATCH | owner |
| `/api/image` | GET | project |
| `/api/inbox` | DELETE, GET | owner |
| `/api/keys` | GET | owner |
| `/api/keys/[id]` | PUT | owner |
| `/api/keys/[id]/reveal` | POST | owner |
| `/api/keys/export` | POST | owner |
| `/api/keys/import` | POST | owner |
| `/api/lifecycle/reaper` | GET | owner |
| `/api/limits` | GET | owner |
| `/api/limits/history` | GET | owner |
| `/api/links` | GET, POST | owner |
| `/api/links/agents` | GET | owner |
| `/api/links/codes` | DELETE, GET, POST | owner |
| `/api/links/grants` | DELETE, GET | owner |
| `/api/links/peers` | GET, POST | owner |
| `/api/links/peers/[id]` | DELETE, POST | owner |
| `/api/links/shared` | GET, PATCH, POST | owner |
| `/api/log` | DELETE, GET | project |
| `/api/log/preflight` | POST | project |
| `/api/log/project-delete` | POST | project |
| `/api/log/provenance` | GET | project |
| `/api/logs` | POST | project |
| `/api/logs/stream` | GET | project |
| `/api/mcp` | DELETE, GET, POST | capability |
| `/api/memory/inject` | POST | owner |
| `/api/memory/settings` | GET, PUT | owner |
| `/api/memory/source` | GET, PUT | owner |
| `/api/monitor/runs` | GET, POST | owner |
| `/api/monitor/seat-tick` | GET | owner |
| `/api/monitor/seat-tick/settings` | GET, PUT | owner |
| `/api/onboarding` | GET, PUT | owner |
| `/api/onboarding/health` | DELETE, GET, POST | owner |
| `/api/operator/settings` | GET, PUT | owner |
| `/api/operator/worker-limit` | GET, PUT | owner |
| `/api/orchestrator/ghost` | GET, POST | project |
| `/api/orchestrator/message` | POST | project |
| `/api/orchestrator/reports` | GET | project |
| `/api/orchestrator/rotate` | POST | project |
| `/api/orchestrator/seat` | GET, POST | project |
| `/api/orchestrator/seat/status` | GET | project |
| `/api/peer` | DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT | peer |
| `/api/peer/[...path]` | DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT | peer |
| `/api/peer/v1/[...path]` | DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT | peer |
| `/api/peer/v1/self-check` | DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT | peer |
| `/api/pipelines` | GET, POST | collection |
| `/api/pipelines/[id]` | DELETE, GET, PATCH | project |
| `/api/pipelines/preflight` | POST | project |
| `/api/pipelines/tick` | POST | owner |
| `/api/proc` | POST | project |
| `/api/projects/create` | POST | owner |
| `/api/projects/crown` | POST | project |
| `/api/projects/decisions` | GET, POST | project |
| `/api/projects/directories` | GET | owner |
| `/api/projects/reports` | GET | collection |
| `/api/projects/settings` | GET, PUT | project |
| `/api/prototype-reviews` | POST | project |
| `/api/prototype-reviews/read` | POST | project |
| `/api/prototype-reviews/scope` | POST | project |
| `/api/prototype-reviews/telegram` | POST | owner |
| `/api/push` | GET, POST | owner |
| `/api/resources` | GET | owner |
| `/api/review-history` | GET | owner |
| `/api/review-history/[id]` | GET | owner |
| `/api/review-history/[id]/export` | GET | owner |
| `/api/role-memory` | GET, POST | owner |
| `/api/role-memory/lessons` | GET | owner |
| `/api/role-memory/profile` | GET, POST | owner |
| `/api/roles` | GET, PUT | owner |
| `/api/runtime/answer` | POST | project |
| `/api/runtime/delivery-progress` | GET | project |
| `/api/runtime/deployments` | GET, POST | owner |
| `/api/runtime/deployments/[deploymentId]` | DELETE, GET | owner |
| `/api/runtime/deployments/capabilities/v1` | GET | owner |
| `/api/runtime/hosts` | POST | owner |
| `/api/runtime/inject` | POST | project |
| `/api/runtime/interrupt` | POST | project |
| `/api/runtime/operations` | POST | owner |
| `/api/runtime/operations/[operationId]` | DELETE, GET, POST | owner |
| `/api/runtime/queue` | GET, POST | project |
| `/api/runtime/realtime` | POST | owner |
| `/api/runtime/send` | GET, POST | project |
| `/api/runtime/snapshot` | GET | collection |
| `/api/runtime/spawn` | POST | owner |
| `/api/runtime/steer` | POST | project |
| `/api/runtime/stream` | GET | collection |
| `/api/runtime/waits` | GET | owner |
| `/api/search/memory` | GET, POST | owner |
| `/api/search/transcripts` | GET | owner |
| `/api/self-update` | GET | owner |
| `/api/self-update/action` | POST | owner |
| `/api/self-update/auto` | POST | owner |
| `/api/self-update/check` | POST | owner |
| `/api/self-update/events` | GET | owner |
| `/api/self-update/launcher-admission` | GET | owner |
| `/api/self-update/restart` | POST | owner |
| `/api/self-update/steps/[step]/log` | GET | owner |
| `/api/self-update/update` | POST | owner |
| `/api/session` | GET | project |
| `/api/session/supersedence` | POST | project |
| `/api/session/title` | PATCH | project |
| `/api/spawn` | GET, POST | project |
| `/api/spawn/policy` | GET, PATCH | owner |
| `/api/spawn/validate` | POST | project |
| `/api/staging` | GET | owner |
| `/api/streams` | GET, POST | owner |
| `/api/structured-user/provenance` | POST | owner |
| `/api/subscription-api-consent` | GET, PUT | owner |
| `/api/task-album` | GET | project |
| `/api/task-attachments` | GET, POST | owner |
| `/api/task-icons` | GET | team |
| `/api/task-spend` | GET | project |
| `/api/tasks` | GET, POST | collection |
| `/api/tasks/[id]` | DELETE, PATCH | project |
| `/api/tasks/[id]/album` | GET, POST | project |
| `/api/tasks/[id]/album/image` | GET | project |
| `/api/tasks/[id]/assignment` | DELETE, PATCH, POST | project |
| `/api/tasks/[id]/prototypes` | GET, POST | project |
| `/api/tasks/[id]/prototypes/[reviewId]/video/[mediaId]` | GET | project |
| `/api/tasks/[id]/send` | POST | project |
| `/api/tasks/[id]/spawn` | POST | project |
| `/api/tasks/curator` | GET, POST | project |
| `/api/team` | GET | team |
| `/api/team/claim` | POST | team |
| `/api/team/events` | GET | team |
| `/api/team/invites` | GET, POST | team |
| `/api/team/invites/[id]` | DELETE | team |
| `/api/team/join-requests/[id]` | POST | team |
| `/api/team/join/[code]` | GET, POST | team |
| `/api/team/members/[id]` | PATCH | team |
| `/api/team/passkeys` | DELETE, GET, POST | team |
| `/api/team/public` | GET | team |
| `/api/team/session/approval` | POST | team |
| `/api/team/session/approval/[id]` | POST | team |
| `/api/team/session/approve` | POST | team |
| `/api/team/session/handoff` | POST | team |
| `/api/team/session/passkey` | POST | team |
| `/api/team/session/sign-out` | POST | team |
| `/api/team/session/telegram` | POST | team |
| `/api/team/session/telegram/[id]` | POST | team |
| `/api/team/sessions` | DELETE, GET | team |
| `/api/team/telegram` | DELETE | team |
| `/api/team/workspace-projects` | PUT | team |
| `/api/team/workspaces` | GET, POST | team |
| `/api/team/workspaces/[id]` | DELETE, PATCH | team |
| `/api/team/workspaces/[id]/members` | DELETE, PUT | team |
| `/api/telegram` | GET, POST | owner |
| `/api/telegram/bot` | GET, POST | owner |
| `/api/telegram/bot/agent` | GET, POST | owner |
| `/api/telegram/bot/confirmation` | GET, POST | owner |
| `/api/telegram/reports` | GET, POST | owner |
| `/api/telemetry` | GET, PUT | owner |
| `/api/timeline` | GET | project |
| `/api/tmux` | GET, POST | project |
| `/api/tmux/targets` | POST | project |
| `/api/transcribe` | POST | owner |
| `/api/transcribe/backend` | GET, POST | owner |
| `/api/transcribe/key` | PUT | owner |
| `/api/transcribe/token` | POST | owner |
| `/api/tts` | GET, POST | owner |
| `/api/tts/backend` | GET, POST | owner |
| `/api/tts/voices` | GET | owner |
| `/api/view/presence` | POST | owner |
| `/api/view/typing-latency` | POST | owner |
| `/api/voice-companion/calls` | GET | owner |
| `/api/voice-companion/key` | PUT | owner |
| `/api/voice-companion/memory` | DELETE, GET | owner |
| `/api/voice-companion/resume` | GET | owner |
| `/api/voice-companion/session` | GET, POST | owner |
| `/api/voice-companion/settings` | GET, PUT | owner |
| `/api/voice-tools` | GET, POST | owner |
| `/api/voice-tools/proposals` | POST | owner |
| `/api/workflows` | GET, POST | owner |
| `/api/workflows/[id]` | PATCH | owner |

## Verification

Checks run through `gate-remote` and the admitted gate wrapper, with private
HOME, config, TMPDIR and state roots. The focused test comparison against
`d8c9778dc` completed all 13 selected files with zero new failures. Twelve files
passed completely. The existing files-projection suite retained the same ten
failing assertions on both revisions; the comparator classified all ten as
pre-existing, with no skipped assertions or flaky classifications.

```sh
bash scripts/gate-slot.sh bun scripts/local-gate-tests.ts --base d8c9778dc \
  src/lib/team/workspaceAccess.test.ts \
  src/lib/team/workspaceRoutes.test.ts \
  src/lib/team/workspaces.test.ts \
  src/lib/team/workspaceFilesResponse.test.ts \
  src/proxy.team.test.ts \
  src/app/api/team/workspaces.routes.test.ts \
  src/lib/runtime/sse.test.ts \
  src/lib/logTailStream.test.ts \
  src/app/api/artifact/route.test.ts \
  src/app/api/image/route.test.ts \
  src/app/api/runtime/snapshot/route.test.ts \
  src/lib/activity/tokenReport.test.ts \
  src/app/api/files/route.test.ts
```

Whole-project `bunx tsc --noEmit` and ESLint on the 19 source/test files
changed by the fix both exited 0. Publication privacy checks use the committed
fingerprints, and both added commits run the repository hooks.

The authorization cases cover private home files through both file routes,
symlinks, unknown placements, catalog-file success, and deputy reads, retries
and saved-request replays. Projection cases cover scoped 304/gzip responses,
overlapping refresh/eviction, scope changes and revocation during awaited reads. Stream cases
cover batch admission, revocation and unavailable authorization.

`docs/design/workspaces.md` matches the complete base copy at `c2d19d9d`;
`git diff c2d19d9d..HEAD -- docs/design/workspaces.md` is empty. No workflow or
UI files changed in the fix, so no new rendered frames are included.

### Authorization review follow-up

`src/lib/team/workspaceAccess.test.ts` covers resource-pane kill and attach on
both mounts with an authorized conversation beside the pane target. Refusals
preserve the allowlist and invoke no pane effects; owner attach and kill still
succeed. Settings cases cover each switch and clearing the report destination,
unchanged persisted settings on refusal, manager and owner success, and a
manager downgraded while target resolution is awaiting its parameters.
The first two regression cases both failed on the reviewed code (200 instead
of 403); all 24 workspace-access tests pass with the fixes.

An isolated eight-file comparison against `d4eed38dd` reports zero new
failures, zero skipped assertions and zero flaky classifications. Its one
pre-existing failure is the Telegram topic-link discovery assertion in
`src/app/api/projects/settings/route.test.ts`. The selected files are:

```sh
bash scripts/gate-slot.sh gate-remote -- bun scripts/local-gate-tests.ts --base d4eed38dd \
  src/lib/team/workspaceAccess.test.ts \
  src/lib/team/workspaceRoutes.test.ts \
  src/app/api/projects/settings/route.test.ts \
  src/app/api/conversation-host/route.test.ts \
  src/app/api/tmux/route.test.ts \
  src/app/api/conversation-host/longText.test.ts \
  src/proxy.team.test.ts \
  src/proxy.test.ts
```

Whole-project `bunx tsc --noEmit --incremental false` and ESLint on the two
changed TypeScript files pass through `gate-remote`. The workspace-access
suite also passes locally in a private scratch export (24/24), matching the
remote outcomes. Publication privacy scans the complete three changed files.
No performance gain is claimed.

## Changed files

- `docs/workspace-human-routes.md`
- `evidence/workspaces/member-projection-performance.json`
- `scripts/benchmark-workspace-projection.ts`
- `src/app/api/activity/route.test.ts`
- `src/app/api/activity/route.ts`
- `src/app/api/activity/tokens/route.ts`
- `src/app/api/answer/route.ts`
- `src/app/api/artifact/route.ts`
- `src/app/api/attach-command/route.ts`
- `src/app/api/attention/dismissals/route.ts`
- `src/app/api/attention/done/route.ts`
- `src/app/api/attention/needs-you/route.ts`
- `src/app/api/board/route.ts`
- `src/app/api/conversation-host/route.test.ts`
- `src/app/api/conversation-host/route.ts`
- `src/app/api/conversation-host/targets/route.ts`
- `src/app/api/conversations/[conversationId]/migration/route.ts`
- `src/app/api/conversations/route.ts`
- `src/app/api/files/route.ts`
- `src/app/api/image/route.ts`
- `src/app/api/log/preflight/route.ts`
- `src/app/api/log/project-delete/route.ts`
- `src/app/api/log/provenance/route.ts`
- `src/app/api/log/route.ts`
- `src/app/api/logs/route.ts`
- `src/app/api/logs/stream/route.ts`
- `src/app/api/orchestrator/ghost/route.ts`
- `src/app/api/orchestrator/message/route.ts`
- `src/app/api/orchestrator/reports/route.ts`
- `src/app/api/orchestrator/rotate/route.ts`
- `src/app/api/orchestrator/seat/route.ts`
- `src/app/api/orchestrator/seat/status/route.ts`
- `src/app/api/pipelines/[id]/route.ts`
- `src/app/api/pipelines/preflight/route.ts`
- `src/app/api/pipelines/route.ts`
- `src/app/api/proc/route.ts`
- `src/app/api/projects/crown/route.ts`
- `src/app/api/projects/decisions/route.ts`
- `src/app/api/projects/reports/route.ts`
- `src/app/api/projects/settings/route.ts`
- `src/app/api/prototype-reviews/read/route.ts`
- `src/app/api/prototype-reviews/route.ts`
- `src/app/api/prototype-reviews/scope/route.ts`
- `src/app/api/runtime/answer/route.ts`
- `src/app/api/runtime/delivery-progress/route.ts`
- `src/app/api/runtime/inject/route.ts`
- `src/app/api/runtime/interrupt/route.ts`
- `src/app/api/runtime/queue/route.ts`
- `src/app/api/runtime/send/route.ts`
- `src/app/api/runtime/snapshot/route.ts`
- `src/app/api/runtime/steer/route.ts`
- `src/app/api/runtime/stream/route.ts`
- `src/app/api/session/route.ts`
- `src/app/api/session/supersedence/route.ts`
- `src/app/api/session/title/route.ts`
- `src/app/api/spawn/route.ts`
- `src/app/api/spawn/validate/route.ts`
- `src/app/api/task-album/route.ts`
- `src/app/api/task-icons/route.ts`
- `src/app/api/task-spend/route.test.ts`
- `src/app/api/task-spend/route.ts`
- `src/app/api/tasks/[id]/album/image/route.ts`
- `src/app/api/tasks/[id]/album/route.ts`
- `src/app/api/tasks/[id]/assignment/route.ts`
- `src/app/api/tasks/[id]/prototypes/[reviewId]/video/[mediaId]/route.ts`
- `src/app/api/tasks/[id]/prototypes/route.ts`
- `src/app/api/tasks/[id]/route.ts`
- `src/app/api/tasks/[id]/send/route.ts`
- `src/app/api/tasks/[id]/spawn/route.ts`
- `src/app/api/tasks/curator/route.ts`
- `src/app/api/tasks/route.ts`
- `src/app/api/team/events/route.ts`
- `src/app/api/team/invites/[id]/route.ts`
- `src/app/api/team/invites/route.ts`
- `src/app/api/team/workspace-projects/route.ts`
- `src/app/api/team/workspaces.routes.test.ts`
- `src/app/api/team/workspaces/[id]/members/route.ts`
- `src/app/api/team/workspaces/route.ts`
- `src/app/api/timeline/route.ts`
- `src/app/api/tmux/route.test.ts`
- `src/app/api/tmux/route.ts`
- `src/app/api/tmux/targets/route.ts`
- `src/lib/activity/report.ts`
- `src/lib/activity/tokenReport.test.ts`
- `src/lib/activity/tokenReport.ts`
- `src/lib/logTailStream.test.ts`
- `src/lib/logTailStream.ts`
- `src/lib/runtime/sse.test.ts`
- `src/lib/runtime/sse.ts`
- `src/lib/scanner/conversationCatalog.test.ts`
- `src/lib/scanner/conversationCatalog.ts`
- `src/lib/team/gate.ts`
- `src/lib/team/members.ts`
- `src/lib/team/store.ts`
- `src/lib/team/workspaceAccess.test.ts`
- `src/lib/team/workspaceAccess.ts`
- `src/lib/team/workspaceFilesResponse.test.ts`
- `src/lib/team/workspaceFilesResponse.ts`
- `src/lib/team/workspaceProjection.ts`
- `src/lib/team/workspaceRoute.ts`
- `src/lib/team/workspaceRoutes.test.ts`
- `src/lib/team/workspaceRoutes.ts`
- `src/lib/team/workspaces.test.ts`
- `src/lib/team/workspaces.ts`
- `src/proxy.team.test.ts`

## Projection measurement

`scripts/benchmark-workspace-projection.ts` compares the member serialization
path with the reviewed implementation at `d8c9778dc`. Run in a scratch export
through the gate with private HOME, config, TMPDIR and state roots:

```sh
git show d8c9778dc:src/lib/team/workspaceProjection.ts > src/lib/team/.workspaceProjection.before.ts
bash scripts/gate-slot.sh bun scripts/benchmark-workspace-projection.ts src/lib/team/.workspaceProjection.before.ts
```

The harness creates 53,299 catalog rows across 64 projects and eight
workspaces, plus 256 registered conversations. One member belongs to one
workspace. Both sides use the same data in one process, with one warm-up and
five alternating samples of five operations each. It reports wall time and
process CPU time. Both sides use the corrected authorization scope, so the
comparison isolates projection and batching costs. The board source is an already encoded, unchanged operator
projection; HTTP admission, scanner work, runtime-host transport, file I/O
and browser/network latency are excluded. The snapshot case measures ownership
filtering. Runtime events use two 128-event replay pages. The log predicate
case checks 64 candidate paths, including foreign ownership, independently of
subscription admission.

The Linux runner used Bun 1.4.0. Raw samples and source hashes are in
`evidence/workspaces/member-projection-performance.json`. The final run used
19,359,284 source bytes and 2,415,021 scoped bytes; each unchanged scoped
response was a 304 with no body. Median milliseconds per operation:

| Operation | Wall before | Wall after | CPU before | CPU after |
|---|---:|---:|---:|---:|
| unchanged member poll | 59.33 | 0.77 | 76.79 | 1.26 |
| snapshot ownership, 256 sessions | 13.20 | 10.47 | 17.76 | 14.41 |
| runtime replay, 2 x 128 events | 152.39 | 11.37 | 181.55 | 11.79 |
| log batch, 64 paths | 20.37 | 3.79 | 21.13 | 4.93 |

The gate shared the runner with other work; the alternating samples record
that variation. These figures describe this projection harness only. A cold
scope or a changed operator body still needs a full decode and filter; the
poll timings cover an unchanged source.

The member response cache belongs to the route module and retains at most
16 scopes and 32 MiB, evicting the least recently used entries. Oversized
responses are served without retaining them. Every request revalidates the
member and placement scope, and each source response revalidates the cached
body. Permission changes during source reads or compression refuse the response.

Owner-only surfaces remain owner-only, including roles, flows, composer
uploads, transcription, limits, `/api/streams` and view/presence. A workspace
manager can appoint or remove co-managers in their own workspace.
