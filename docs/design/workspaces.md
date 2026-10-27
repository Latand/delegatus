# Team workspaces: what a workspace is, and how far isolation can go

Status: research, 2026-10-20, read-only design stage. Nothing here is built;
the operator chooses first. Every code claim was checked against `main` at
`144c87e12` (the worktree's starting commit). The companion deliverables are a
static prototype of the UI variants named in §9 and a decision form carrying
the questions of §8.

## 0. Originating requirement

Operator, 2026-10-20 about 09:45Z, in chat to the orchestrator, in Ukrainian.
The operator asked that the exact wording stay out of every published file, so
this is the orchestrator's English paraphrase, carried in the pinned task:

> A new, very important feature. Research first, then a prototype; the UI has
> to change a little, maybe the backend too. Several people, a team, may work
> on one Delegatus. The operator wants to create separate workspaces, with
> some degree of isolation between them, and does not yet know how that is
> possible.

What the words settle: several people share one installation; a workspace is
something a person creates, more than one of them; isolation is wanted "in
some sense" and its degree is open; research and a prototype come before any
build. What they leave open is in §8.

## 1. Decisions in one page

| # | Decision | Why (short) |
|---|---|---|
| D1 | **A workspace is a named set of projects plus the members who may see them**, recorded beside the team store. The project key stays the unit of everything the product already partitions (boards, seats, pipelines, bindings, report chats, bridge channels), and the workspace groups keys. | §2 shows the state is already keyed by project almost everywhere; what is missing is only the grouping and the gate. |
| D2 | **The current workspace is a browser-side selection, like the selected project**, carried in the URL hash beside `#p=`, with one server-side default per member. | No server state to migrate, works per tab, matches how the rail selects projects today. |
| D3 | **Four isolation levels are possible; level 2 is recommended** (§6, §7): views and permissions in the Viewer plus a workspace fence on what agents reach through the Viewer MCP, with per-workspace defaults for accounts, Telegram chats and limits. Levels 3 and 4 (one installation per workspace; one OS user per workspace) stay documented as the path if an untrusted team ever shares a machine. | Every member directs agents, and an agent runs as the installation's own OS user with that user's files and credentials (§2 row "agent process"). Below level 4 a workspace separates attention, defaults and mistakes; containing an adversary takes level 4. The operator's team is small and trusted, so level 2 buys what the requirement names at a fraction of level 4's cost. |
| D4 | **The owner sees every workspace; a workspace manager runs one; a member works inside the ones they were added to.** Three roles, the first already built. | The built team has `owner` and `member` and nothing per project (§2). One added role per workspace is the smallest vocabulary that lets a teammate run their own space without owning the installation. |
| D5 | **A project belongs to at most one workspace; a project in none is "Unassigned" and visible to the owner alone** until placed. | Two homes for one board means two sets of members with two sets of defaults for one seat; the pipeline, seat and binding code all assume one project has one scope. |
| D6 | **Nothing changes on a solo installation.** The workspace store is absent until an owner creates the first workspace, and an installation with one workspace draws no switcher. | Same rule as team mode (sign-in-and-team D2, A1): the file's absence is the feature being off. |

No ADR: the store is additive, the gate is a filter at the existing identity
gate, and every level above the recommended one is reachable later from the
same record.

## 2. What exists today, verified in code

Everything below is per **installation** (one state directory, one Viewer,
one runtime host) unless the row says otherwise. "Keyed by project" means the
record carries the canonical project key and nothing more; nobody reads it
through a member or a group.

| Piece | Where | Scope today |
|---|---|---|
| Perimeter | `src/proxy.ts:96-109` (`LLV_TOKEN`) | one key per installation; a key holder reads everything |
| Identity gate | `src/lib/team/gate.ts:1-80`; sign-in-and-team A13 | pass / sign-in / `401 member_required`; it never looks at a path's project |
| Members | `src/lib/team/contract.ts:13` (`owner \| member`), `:23-37` (the built `Member`) | roles are installation-wide; the built record has **no** per-project field (the design's planned `grants: []` was not built; its §14 defers "the capability matrix and per-project membership") |
| Owner-only writes | `src/lib/team/http.ts:52,59` (`requireMember`, `requireOwner`); `src/app/api/team/invites/route.ts:14,28` | invite, revoke, phone access: owner; everything else: any member |
| Actor on a write | `src/lib/team/actor.ts:62-79` | agent → service → member → operator/anonymous; no project in the answer |
| Who-did-what | `src/lib/team/events.ts:46-61`, index `events_project` at `src/lib/team/store.ts:232` | events already carry a `project`; the Activity tab filters by it |
| Task reads | `src/app/api/tasks/route.ts:44-63` | `?project=` filters; no member filter; a member reads every board |
| Tasks | `src/lib/tasks/types.ts:194`; store at `src/lib/tasks/store.ts:44,274` | keyed by project, one `tasks` collection in `state.sqlite` |
| Orchestrator seats | `src/lib/orchestrator/seats.ts:80-81,210` | one active seat per project, all in `orchestrator-seats.json` |
| Pipelines | `src/lib/pipelines/types.ts:29` | keyed by project |
| Agent accounts | `src/lib/accounts/claude.ts:55`, `codex.ts:114` (`<config>/accounts/<engine>/`); default account `claude.ts:361` | installation-wide pool and default; quotas are per account (`account_limits`) |
| Account↔project bindings | `src/lib/accounts/projectBindings.ts:11-27` | opt-in per project and engine, stored under the canonical key; a project nobody bound is unrestricted |
| Telegram bot | `src/lib/telegram/bot/store.ts:239-265` (`bot` row `CHECK (id = 1)`, `chats` with `alias`, `post_allowed`) | one bot per installation; which chats agents may post in is per chat |
| Report destination | `src/lib/projects/settings.ts:44-56`; `src/lib/projects/reportDestination.ts:20-33` | per project: the chat a project's reports go to |
| Bridge channels | `src/lib/bridge/types.ts:332-338` | per project and seat |
| External relay | `src/lib/externalRelay/store.ts:50-69,115` | one paired relay with one `owner` identity per installation; targets per relay |
| Interface language, time zone | `src/lib/operator/settings.ts:40-57` | one per installation (per-member locale deferred in sign-in-and-team §14) |
| Worker cap, CPU admission | `src/lib/operator/workerLimit.ts:38` | one per installation |
| Project keys | `src/lib/projects/identity.ts:57` (`dir-<hash>`), `:170` (`repo-<hash>`); `src/lib/projects/aliases.ts:75` (`canonicalProject`); `src/lib/scanner/describe.ts:860` (`projectInfoFromCwd`) and AGENTS.md "Worktree → project grouping" | every worktree groups under its parent repository's key; a key can change (`dir-` → `repo-<local>` → `repo-<remote>`) and the alias map joins old to new |
| Manual projects, crowns, archive | `src/lib/projects/curation.ts:14-21`; `src/components/ProjectRail.tsx:146` (`crownedProjects`, `archivedProjects`, `onCreateProject`) | installation-wide; the rail already has a create-project form and per-project pin/hide controls |
| Linked installs | `src/lib/links/state.ts:19,62,91` (`Shared { all, projects }`), `src/lib/links/linked.ts:17`; `docs/design/linked-seats-and-activity.md:3` (implemented 2026-10-09) | per-project opt-in sharing between **installations**; the precedent for "pick which projects" UI and for a cross-installation overview |
| Transcript roots | `src/lib/scanner/roots.ts:69-70,81-91` | the operator's own `~/.claude/projects`, `~/.codex/sessions` and every managed account home are scanned into one catalog |
| Agent process | `src/lib/runtime/claudeStreamBrokerHost.ts:909,936` (spawn with `cwd`); `Dockerfile:105` (`nsenter … setpriv --reuid=<host user>`); `docs/design/agent-memory-isolation.md` §1 | every agent runs as the Viewer's OS user, in the checkout it was given, with that user's home, SSH keys, `gh` login and every other checkout reachable |
| Agent config sandbox | `src/lib/runtime/agentConfigSandbox.ts:82-123` | per **account home**, under the temp root; it keeps the agent's config writes out of the operator's state, nothing more |
| Memory cell | `src/lib/runtime/agentMemory.ts:68-82` | one transient systemd scope per agent, in `delegatus-agents.slice`; the precedent for a per-workspace slice |
| Viewer MCP | `src/lib/agent/spawnPolicy.ts:93-98` (the server pins the real state directory); `src/lib/mcp/server.ts:3549` ("a seat, deputy or worker sees its own project; operator root sees all") | tools take `project` as a free argument; the only existing fence is the per-caller project on fleet reads and the task↔cwd check at `src/lib/agent/spawnAdmission.ts:18-30` |
| MCP server grants | `src/lib/agent/mcpAllowlist.ts:1-30` | per launch, bounded to a fixed list; the precedent for "what an agent may reach is decided at spawn" |
| State directory | `src/lib/stateOwnership.ts:27,44`; `docs/deploy-checkout.md:30-33` (`LLV_STATE_DIR` explicit per checkout install); `src/runtime-host/main.ts:180`, `bin/cli.mjs:45` (port 8898) | one directory, one writer authority (`src/lib/state/hotStateAuthority.ts:9`), one stable port per installation; a second installation on one machine needs its own directory and port |
| Team page and menus | `src/components/team/TeamPage.tsx:23` (Members, Activity, Sessions tabs); `src/components/headerMenu/HeaderMenu.tsx:212` (desktop ⋯ → Team); `src/components/team/menuEntry.tsx:12` (phone Team row); `src/components/mobile/MobileProjectSheet.tsx:53` (phone project picker) | the surfaces a workspace UI extends |
| Team copy | `src/lib/i18n/en.ts:6648-6727`, mirrored in `uk.ts` | invite, approve, roles, presence: the vocabulary the prototype reuses |

Two consequences carry the whole design:

1. **The partition exists; the grouping does not.** Boards, seats, pipelines,
   bindings, report chats, bridge channels and audit events are keyed by
   project. A workspace that is a set of project keys inherits all of it.
2. **Below the OS, a member equals the operator.** Sign-in-and-team already
   states it (its "The key is the operator's" paragraph, lines 132-145): any
   member can direct an agent, and the agent runs as the installation's user.
   A Viewer-side permission therefore protects against what a teammate sees and
   does by accident or habit. What they could make an agent do stays open.

### 2.1 Prior work searched

`search_transcripts` project-scoped and unscoped in three phrasings
(workspaces/isolation/separate state; the operator's Ukrainian words; per-project
membership/capability matrix/grants) and `search_memory` for
workspace/multi-tenant: the only hits on topic are this lane's own kickoff.
The one earlier answer is sign-in-and-team §14, which defers "the capability
matrix (#634) and per-project membership" and "ownership transfer and several
owners". #634's vocabulary (`task:manage-others`, `orchestrator:control`) is
per action; nothing earlier groups projects for people. Linked installs
(§2, row "Linked installs") solved the neighbouring problem, which projects
cross to another machine, with a per-project opt-in list and an "all" switch;
that UI shape is reused here.

## 3. What a workspace contains

| Part | In a workspace | Why there, and what stays installation-wide |
|---|---|---|
| Projects | the set of canonical keys; a project is in at most one workspace (D5); every worktree, scratchpad and alias of a key follows it by the rules in AGENTS.md, so nothing is added to `projectInfoFromCwd` | the key is the unit; the alias map is read at every lookup (`canonicalProject`), exactly as bindings do |
| Boards, tasks, pipelines, seats, bridge channels | follow their project | nothing to add; they are keyed already |
| Members | member id → workspace role `manager \| member`; the installation `owner` is implicitly a manager everywhere | roles stay in the team store (`members`), the mapping beside it |
| Agents and conversations | a conversation belongs to the workspace of its project (ownership record, launch profile, cwd, in that order: `src/lib/accounts/conversationProject.ts`) | conversations with no project ("Unresolved") are the owner's |
| Agent accounts and quotas | the **shared pool** stays installation-wide; a workspace holds the accounts its projects may use, written as the existing per-project bindings for every project in it (D3, level 2) | one CLI login per engine per account is the operator's; per-workspace pools are level 3 (§6) |
| Telegram | one bot; a workspace names the chats its projects report to and the chats whose directives it accepts (the existing per-project report setting, defaulted from the workspace) | a bot per workspace is level 3 |
| External relay | stays installation-wide; the paired owner is the installation's owner | a relay per workspace is level 3; a per-workspace relay target belongs to the relay design |
| Reports, Activity | filtered by the workspace's projects; `team_events.project` already exists | the owner's unfiltered view stays |
| Settings | per workspace: default report chat, allowed accounts, worker share (a cap inside the installation cap), optionally a default locale for reports | interface language and time zone stay per installation until per-member locale lands (sign-in-and-team §14) |
| Audit | `workspace.created`, `workspace.project_added/removed`, `workspace.member_added/removed/role_changed`, in `team_events` with `project: null` and `subject: { kind: "workspace" }` | same chokepoint as every other team event |

### 3.1 The record

In `team.sqlite`, beside `members` (sign-in-and-team A1: the file's absence is
solo mode; a workspace cannot exist without a team).

```
workspaces          id (w_ + 16 random bytes hex), name (1–40), slug, color (MemberColor),
                    created_at, created_by (member id), archived_at
workspace_projects  workspace_id, project (canonical key), added_at, added_by   PK(project)
workspace_members   workspace_id, member_id, role ('manager' | 'member'), added_at, added_by
                    PK(workspace_id, member_id)
```

`PK(project)` is D5. Keys are canonicalized on write and read; when the alias
map later joins an old key to a new one (a folder that gained an origin), the
row is rewritten by the same succession pass that already migrates seats and
bindings (`src/lib/projects/succession.ts`, named in AGENTS.md).

### 3.2 The current workspace

`#w=<id>` in the URL beside `#p=`, `#c=`; the rail shows the workspace's
projects and the board the selected project's tasks. A member with one
workspace never sees a switcher; the owner's "All" view is the rail as it is
today. The last choice per browser is stored like the rail's footer mode
(`llv:rail-footer-detail:v1` in `localStorage`), and the server stores one
default per member for a fresh device. Nothing on the server is "current".

## 4. Who can see and do what

| Action | Owner | Workspace manager | Workspace member | Member of no workspace |
|---|---|---|---|---|
| See a workspace's projects, boards, conversations, agents, activity | all workspaces | own workspaces | own workspaces | nothing but the sign-in and the Team page |
| Create a workspace, archive one | yes | no | no | no |
| Add or remove projects | yes | own workspaces, from the Unassigned list the owner exposes (Q3) | no | no |
| Invite a person into a workspace | yes | own workspaces (the invite link carries the workspace) | no | no |
| Change a member's workspace role | yes | own workspaces | no | no |
| Revoke a member from the installation | yes (today's rule) | no | no | no |
| Send to an agent, spawn, edit tasks, answer questions | everywhere | own workspaces | own workspaces | no |
| Change workspace defaults (chat, accounts, worker share) | yes | own workspaces | no | no |
| Installation settings (accounts pool, bot, relay, phone access, updates, deploys) | yes (today's rule) | no | no | no |

Enforcement is where the identity gate already is and nowhere new: the gate
stays path-blind, and every route that takes a project (or resolves one from
a conversation, task or pipeline id) asks one helper,
`workspaceAccess(actor, project) → "owner" | "manager" | "member" | "none"`,
before `recordTeamEvent`. The catalogue, files and stream routes
(`/api/files`, `/api/logs/stream`, `/api/runtime/stream`) filter their rows by
the same helper, and a stream a member opened already ends with their session
(sign-in-and-team A24). Threat cases the helper must refuse on every path that
answers before it: a task id from another workspace in a PATCH body; a
conversation id from another workspace in a send; a pipeline id in
`pipeline_action`; a `?project=` the member is not in; a cwd whose project the
member is not in on `/api/spawn`.

**Agents.** An agent's calls through the Viewer MCP carry its conversation,
and the conversation's project names the workspace. At level 2 the server
answers list and read tools (`list_tasks`, `list_pipelines`, `agent_fleet`,
`search_transcripts`, `search_memory`, `board_snapshot`) only for projects in
that workspace, and refuses spawns and task writes outside it, with the owner's
own root conversations exempt, which is the rule `agent_fleet` already states
(`src/lib/mcp/server.ts:3549`). This is a Viewer-side fence on the tools, not
on the agent's shell: see level 2's "does not protect" row.

## 5. Interaction with members, sessions and project keys

- **Sessions are untouched.** A session proves a member; the workspace mapping
  is read per request from the member id. Revoking a member ends every
  workspace at once, as today.
- **Invite links carry a workspace.** The join code's challenge row gains an
  optional `workspace_id`; redeeming it adds the `workspace_members` row with
  role `member`. An invite from the owner's Team page without a workspace
  behaves as today and lands the person in no workspace (Q4 decides whether
  that state is allowed at all).
- **Telegram sign-in and the bot** are unchanged: the bot answers the
  installation; a workspace only decides which chats a project reports to.
- **Project keys.** The record holds canonical keys. The AGENTS.md invariant,
  that a deleted worktree still groups under its parent repository, holds for
  workspaces by construction, because membership is looked up by the key the
  scanner resolved, and the path is not read. The one new rule: when the succession pass
  aliases `dir-<a>` to `repo-<b>`, it moves the `workspace_projects` row in the
  same transaction as the seat and binding rows. A `repo-<remote>` rename
  proved by the forge (same numeric repository id) is already an alias and
  needs no extra handling.
- **Unassigned projects.** The scanner keeps discovering projects (a new
  checkout, a scratch folder). They land in no workspace and show for the
  owner only, under an "Unassigned" fold in the rail, with "Move to…" on the
  row (Q3).
- **Linked installs** share by project; a workspace changes nothing on the wire
  and the share list is still a list of keys. If a peer installation also has
  workspaces, nothing crosses: the share is per project on each side.

## 6. Isolation levels

Each level includes the ones below it. "Protects against" is what a level
stops a **trusted but fallible** teammate from seeing or breaking, and, where
it applies, what it stops a **hostile** one from doing.

### Level 1: views and permissions

The record of §3.1, the gate helper of §4 on human routes, the rail switcher,
a workspace tab on the Team page, invite-into-workspace. Agents are not fenced.

| | |
|---|---|
| Protects against | a teammate seeing or acting on another team's boards, chats and agents from the UI by accident; a wrong send into the wrong orchestrator; a board edit by someone the project's owner never added. Attribution per workspace in Activity. |
| Does not protect against | anything an agent does: a member's agent can read any checkout, any transcript the Viewer MCP returns, and send to any conversation by id; the catalogue it reads is installation-wide. A hostile member is the operator (§2, consequence 2). |
| Code | team store tables; one helper; call sites in the project-taking routes (tasks, conversation-host, spawn, pipelines, flows, orchestrator, bridge, answer, proc, files, logs/runtime streams, search); the rail and the phone project sheet; Team page tab; i18n. On the order of 25 route touch points, each one line, plus a test per threat case of §4. |
| Migration | none: no record changes shape; an installation without the tables is "no workspaces". |
| CPU, memory | one indexed read per request on `workspace_projects` (same cost class as the session row read, sign-in-and-team A2); the files answer is filtered after the catalogue read, which is a bound the catalogue already pays. |
| Operator friction | create a workspace, drag projects in, invite people into it. Nothing on a solo installation (D6). |
| Breaks or changes | `GET /api/tasks` and `/api/files` answer fewer rows for a member; any client that assumed "every project" (the Overview, the burndown, Needs-you counts) computes over the filtered set. The MCP server is unchanged. |
| Members and sessions | unchanged; one optional column on the invite challenge. |
| Project-key rules | unchanged; the succession pass moves one more row. |

### Level 2: partitioned defaults and an agent fence (recommended)

Level 1, plus: the Viewer MCP fences every tool to the caller's workspace
(§4, "Agents"); each workspace carries defaults that are written into the
existing per-project records for each project in it (allowed accounts →
bindings; report chat → the project report setting; a worker share → a per-
workspace cap under the installation cap); the Activity and report surfaces
group usage by workspace; a per-workspace systemd slice under
`delegatus-agents.slice` (the memory cell already makes one scope per agent)
so a runaway workspace's agents are the ones the kernel kills.

| | |
|---|---|
| Protects against | level 1, and: an agent in workspace A reading A-unrelated boards, transcripts and fleet rows through the Viewer tools, or messaging B's orchestrator; A's agents using B's reserved account and its quota; A's reports landing in B's chat; A's runaway agents starving B's. |
| Does not protect against | an agent's **shell**: it still runs as the installation's user, so a prompt that says "read `~/Projects/other/`" or "cat the other account's credentials" works. Workspaces at this level separate attention, defaults and mistakes; containing an adversary takes level 4. |
| Code | level 1, plus the MCP fence (one resolver `callerWorkspace(conversationId)` and a check in the tool dispatcher before the per-tool `project` argument is honoured, about 12 tools), the defaults writer (reuses `projectBindings.ts` and `projects/settings.ts`), one slice name in `agentMemory.ts`, and the usage grouping in Activity. The fence needs the same project resolution the receipts already record (`src/lib/mcp/server.ts:959`, `caller.project`). |
| Migration | none for records; existing bindings and report settings stay as the per-project truth and the workspace default only fills blanks. |
| CPU, memory | the fence adds one map lookup per MCP call; slices add nothing per agent beyond the scope already created. |
| Operator friction | one more step at creation: pick the accounts and the chat. Per-workspace caps need a number. |
| Breaks or changes | a seat or worker whose project moves workspace mid-run keeps the old fence until its next launch (same rule as MCP grants, `mcpAllowlist.ts`); a cross-workspace `send_message_to_orchestrator` from a worker is refused with a named reason, which today succeeds. `pipeline-account-contention.md`'s pool arithmetic gains a per-workspace share. |
| Members and sessions | as level 1. |
| Project-key rules | as level 1. |

### Level 3: one installation per workspace, same OS user

No workspace record at all: the owner runs N Delegatus processes, each with
its own `LLV_STATE_DIR`, port, runtime host, team, accounts pool, bot token
and relay pairing, and links them with the existing linked-installs pairing
for one overview board.

| | |
|---|---|
| Protects against | level 2, and: a Viewer bug or a gate mistake in one workspace cannot show another's data, because the process never holds it; state corruption, a bad migration, a disk-full in one workspace leaves the others serving; independent updates and rollbacks. |
| Does not protect against | the shell: same OS user, same home, same checkouts, same credential files. Nothing an agent can do at level 2 is stopped here. |
| Code | the product already supports it (`LLV_STATE_DIR`, `--port`, `LLV_VIEWER_PORT`, checkout installs with explicit state per `docs/deploy-checkout.md:30-33`). New: a launcher that runs N installations under one user unit, self-update that walks N release pointers, and the linked-installs overview widened from boards and seats to "which workspace is which". The runtime host's stable port and its succession are per installation today (`src/runtime-host/main.ts:180`), so N hosts on N ports is the untested surface; AGENTS.md calls host changes three-review-round work. |
| Migration | splitting an existing state directory by project: tasks, seats, pipelines, bindings, bridge channels, team members and events, each exported by key and imported into the right directory; transcripts stay in account homes and are scanned by every installation unless each gets its own accounts. A one-shot tool with a dry run, on the order of the SQLite migration slices already done. |
| CPU, memory | N Viewers and N runtime hosts: N times the idle footprint the `resources` tool reports for the two processes today, plus N catalogue scans of the same transcript roots unless accounts are split too. |
| Operator friction | N logins per engine (an account belongs to one installation, or one login is copied into N homes and every quota reading is per copy); N bots or one bot with N tokens; N relay pairings; N addresses or one reverse proxy with N paths; N phone QR codes. |
| Breaks or changes | the "one Delegatus on this machine" assumptions: MCP `viewer` links pin one state directory per spawn (`spawnPolicy.ts:93-98`), which is fine per installation but means an agent reaches only its own; the self-update restart probe, deploy adapter and `deploy-verdicts` are per installation and multiply. |
| Members and sessions | separate teams; the same person signs in N times with N cookies (the cookie name is one, so N origins or N paths are needed). |
| Project-key rules | unchanged inside each installation; a repository checked out under two workspaces is two projects with the same key on two machines-worth of state, which linked installs already treat as one project across peers. |

### Level 4: one OS user (or container) per workspace

Level 3, with each installation under its own Unix user: its own home,
checkouts, CLI logins, SSH and `gh` identity, `XDG_RUNTIME_DIR`, user bus and
cgroup tree. Or the equivalent in a container per workspace with its own
mounted checkouts.

| | |
|---|---|
| Protects against | the shell: an agent in workspace A cannot read B's checkouts, credentials or transcripts (mode 0700 homes), cannot kill B's processes, cannot exceed B's memory. This is the only level at which a workspace contains a hostile or careless member's agent, and the only one that matches "isolation of agent processes and files" literally. |
| Does not protect against | a shared network (both reach the same forge and the same cloud accounts if they hold the same tokens); a shared machine's CPU and disk (cgroup limits per user slice bound them, nothing stops a user from filling a shared mount). |
| Code | level 3, plus nothing inside the product; everything is deployment: per-user `delegatus.service`, lingering, per-user Bun and CLIs, per-user `DelegateControllers` for the memory cell. In Docker, one compose project per workspace, each `privileged` with `pid: host` today (`docker-compose.yml:11-12`) and `nsenter` into the host user, which would need a per-workspace host user to mean anything. |
| Migration | level 3's split, then `chown` and re-login of every account per user, and every checkout cloned again under the new user (a worktree of another user's repository defeats the point). |
| CPU, memory | level 3's N processes; no extra per workspace beyond a user manager each (tens of MB). |
| Operator friction | the highest: `sudo` to create users and units (`sudo` steps are the operator's to run by hand), N sets of CLI logins that cannot be shared, N copies of every tool, and no "move this project to that workspace" without a re-clone. A person in two workspaces has two of everything. |
| Breaks or changes | nothing in the product; the host deploy command `scripts/rebuild.sh` and the checkout procedure run per user; the Telegram bridge's single bot needs one token per user or one bot proxied by the owner's installation. |
| Members and sessions | as level 3. |
| Project-key rules | unchanged; a repository present under two users has two local paths and one `repo-<remote>` key, which the linked overview already merges by key. |

### 6.1 The levels at a glance

| | 1 Views | 2 Partition + fence | 3 Installation each | 4 OS user each |
|---|---|---|---|---|
| Teammate sees only their boards | yes | yes | yes | yes |
| Agent tools fenced to the workspace | no | yes | yes (by construction) | yes |
| Accounts, chats, caps per workspace | no | defaults | separate pools | separate pools |
| Agent files and shell separated | no | no | no | yes |
| Viewer bug cannot leak across | no | no | yes | yes |
| New processes per workspace | 0 | 0 | 2 | 2 + a user manager |
| Code | small | medium | medium, host-level | deployment only |
| Migration of today's state | none | none | split by key | split, chown, re-clone |
| `sudo` needed | no | no | no | yes |

## 7. Recommendation: level 2, built as level 1 then the fence

Level 2, for these reasons:

1. **It is what the words ask for.** "Separate workspaces, with some degree of
   isolation" names attention and defaults, and the operator's team today is a
   handful of trusted people on one machine (sign-in-and-team §1, the stage
   box). Level 2 gives each of them their own boards, agents, chats and
   accounts, and keeps one Delegatus, one bot, one relay, one update.
2. **The partition is already there.** Every record that matters is keyed by
   project (§2), so the build is a grouping table, one gate helper and one
   MCP fence, no new store of boards or seats, no migration.
3. **Level 3 pays for a guarantee it cannot give.** Its only gain over level 2
   is process separation against Viewer bugs; its cost is N processes, N
   logins, N bots and a state split, and the shell is still shared. If the
   trust model ever changes, level 4 is the honest answer, and it is a
   deployment choice that needs nothing from this design beyond the key-based
   split tool.
4. **It leaves the door open.** The workspace record of §3.1 is the input of
   the level 3 split tool (export by `workspace_projects`), so choosing level 2
   now costs nothing later.

Order of slices, each shippable alone: (a) the record, the owner's workspace
page and the rail switcher; (b) the gate helper on human routes and
invite-into-workspace; (c) the MCP fence and per-workspace defaults; (d) the
slice and usage grouping. The prototype shows (a) and (b) as what a member
sees and (c) as what the owner configures.

## 8. Open questions for the operator

One recommended option each. The decision form carries the same questions.

**Q1. How much isolation?**
- (a) Views and permissions only (level 1).
- (b) **Recommended:** level 2: views and permissions, agents fenced to their workspace through the Viewer tools, per-workspace accounts, chat and worker share. One Delegatus, one bot, one update.
- (c) One Delegatus per workspace, same OS user (level 3): separate processes and state, N logins and bots.
- (d) One OS user per workspace (level 4): the only level where an agent cannot read another workspace's files; needs `sudo` and re-cloning.

**Q2. Who creates workspaces and adds projects?**
- (a) **Recommended:** the owner creates workspaces; a workspace manager adds projects from the Unassigned list and invites people into their workspace.
- (b) Only the owner does everything.
- (c) Any member may create a workspace and becomes its manager.

**Q3. Where does a newly discovered project go?**
- (a) **Recommended:** into "Unassigned", visible to the owner and to managers, with a "Move to…" control on the row; nobody else sees it until it is placed.
- (b) Into the workspace of the person who created it (manual projects and spawns name a creator; scanned checkouts do not, so those still need (a)).
- (c) Visible to everyone until placed, as today.

**Q4. Can a person be in no workspace?**
- (a) **Recommended:** yes, briefly: an invite from the owner's Team page without a workspace signs them in to the Team page only, and the owner places them. The invite dialog defaults to a workspace so this is rare.
- (b) No: every invite names a workspace and the plain invite goes away.

**Q5. Accounts and quotas**
- (a) **Recommended:** one shared pool; each workspace lists the accounts its projects may use (today's bindings, written per project), and usage is shown per workspace. A workspace with no list uses any account.
- (b) Each workspace owns its accounts outright; an account is in one workspace.
- (c) No per-workspace account rule at all; only the display groups usage.

**Q6. Telegram**
- (a) **Recommended:** one bot; each workspace names its report chat and the chats whose directives it accepts; the owner's private chat stays the installation's.
- (b) One bot per workspace, each with its own token.

**Q7. The owner's own view**
- (a) **Recommended:** the owner keeps today's rail with every project, with a workspace fold per group and an "All" at the top; switching is a filter.
- (b) The owner also picks one workspace at a time and sees nothing else until switching.

## 9. What the prototype shows

Numbered variants, one per isolation shape that changes what a person sees;
levels 3 and 4 look alike from the UI and are one variant.

1. **Workspace as a rail filter** (level 1): a workspace switcher in the rail
   header beside the ⋯ menu; the project list is the workspace's; Team page
   gains a Workspaces tab with create, add projects, invite into; a member
   without access to a project opens its link and sees "You are not in this
   workspace" with the manager's name. Phone: the switcher is a row at the top
   of the project sheet.
2. **Workspace as a container with its own settings** (level 2): variant 1
   plus a workspace page (projects, people, accounts, chat, worker share,
   usage), the agent fence stated on the page, and the Activity and usage
   surfaces grouped by workspace.
3. **One Delegatus per workspace** (levels 3 and 4): the switcher lists
   installations, switching opens another origin; the Team page shows this
   installation's team only; a "Workspaces" hub on the owner's installation
   lists the linked installations with their boards (the linked-installs
   overview) and a "Create workspace" that prints the launch command rather
   than creating anything in the UI.

Every variant reuses: the rail rows, crown and archive folds, the project
sheet on the phone, the Team page header and tabs, the invite dialog
(`team.invite.*`), the member avatar and role words, the decision-form chrome.
New chrome, only where nothing fits: the switcher itself (a labelled select in
the rail header, the control `src/components/EngineAccountSwitch.tsx` already draws), and the
"not in this workspace" card (the sign-in card's layout with different copy).
Frames per variant at 1440 and 390, en and uk, light and dark, for: creating
a workspace, switching, inviting into one, the no-access view, and the place
the current workspace is shown.

## 10. Deferred: not currently justified

- **Per-workspace interface language and time zone**: waits on the per-member
  locale of sign-in-and-team §14; reports already take a per-project name.
- **Workspace-level relay targets**: the relay pairs one owner per
  installation; a per-workspace answer profile is a relay design change.
- **Several owners, ownership transfer**: still deferred from sign-in-and-team.
- **Project in two workspaces** (D5): revisit only if a real case needs one
  board under two teams.
- **Per-workspace API keys for the Viewer MCP from outside** (a member's own
  scripts): the perimeter key stays the operator's (A13); a per-member bearer
  is #20 territory.
- **Billing or spend per workspace**: usage grouping is in level 2; money is
  not asked for.
- **The level 3 split tool and the N-installation launcher**: built only if Q1
  answers (c) or (d).
- **Sharing a workspace to a linked installation as a unit**: linked installs
  share by project; a workspace-level share is one checkbox over the same list
  and can wait for a second machine that has workspaces.

## 11. Validation against the requirement

| Asked (paraphrase) | Where |
|---|---|
| Research first, then a prototype; nothing built yet | this document; §9 names the prototype; no product code changes |
| Several people on one Delegatus, as a team | §2 rows "Members", "Identity gate"; §4 roles |
| Create separate workspaces | §3 (what one contains), §3.1 (the record), §4 (who creates), §9 variants 1–3 |
| Some degree of isolation, degree unknown | §6 four levels with what each protects and costs; §6.1 side by side; §7 the recommended degree and why; Q1 for the choice |
| The UI changes a little, maybe the backend | §9 reuses existing chrome and adds two controls; §6 level 2 names the backend pieces, none of them a new store |
| "How is that even possible?" | §2's two consequences: the partition exists, and below the OS a member equals the operator; §6 levels 3 and 4 say what full separation takes |

## 12. Decision (operator, 2026-10-20)

The operator answered the decision form of §8 the same day. Paraphrased here,
as the pinned task carries it; the operator's own wording stays out of every
published file.

| Question | Answer |
|---|---|
| Q1 How much isolation | **Level 2**, prototype variant 2: views and permissions, agents fenced to their workspace through the Delegatus tools, per-workspace accounts, chat and worker share. One Delegatus, one bot, one update. |
| Q2 Who creates and fills workspaces | The owner creates workspaces. A workspace manager adds projects to it and invites people into it. |
| Q3 A newly found project | Lands in an "Unassigned" group that the owner and the managers see, with "Move to…" on its row. |
| Q4 A person in no workspace | Allowed for a short time: an invite that names no workspace gives only the Team page, and the owner places the person later. |
| Q5 Accounts and quotas | One shared account pool. Each workspace has an allow-list of accounts, and usage is shown by workspace. |
| Q6 Telegram | One bot. Each workspace has its own report chat and directive chats. The owner's private chat stays with the installation. |
| Q7 The owner's view | The owner sees the full list grouped by workspace, with "All" at the top. Switching workspace only filters. |

Every answer is the recommended option, so §7's order of slices stands. Two
earlier sentences are now superseded:

- D5 said a project in no workspace is visible "to the owner alone". Under Q3
  the owner **and the managers** see it. Managers exist from slice (b).
- §4's rule that a member of no workspace sees "nothing but the sign-in and
  the Team page" is now the Q4 answer, and it takes effect with the gate in
  slice (b).

The prototype at commit `6f3b45a18` (`docs/prototypes/workspaces/`) numbers its
variants by isolation level, with levels 3 and 4 drawn as two variants where §9
drew one. "Variant 2" is level 2 in both numberings.

## 13. Slice (a) build brief

Slice (a) is the first of §7's four slices: the workspace record (§3.1), the
current workspace (§3.2), the owner's workspace management (create, rename,
delete an empty workspace, add and remove projects, the Unassigned group,
"Move to…") and the rail switcher with "All". It **restricts nothing**. A
workspace in (a) is a named group of projects that anyone signed in can use
as a filter. Members, the gate, invites into a workspace (b), the MCP fence
and per-workspace defaults (c), and the slice and usage grouping (d) are later
lanes and are not started here.

Everything below was checked against `main` at `eb912ba8a`. `origin/main`
moved one commit since then (`1aef6f0f4`, an MCP change), and that commit
touches none of the files named here. The one open pull request that touches
any of them is #3129 (CPU admission queue, inside the fence), and it shares
only the i18n files.

### 13.1 Where this brief departs from §3 and §5, and why

1. **No `#w=` in the URL (changes §3.2 and D2).** The hash grammar is parsed
   in four places: `parseConversationHash` and `recognizedFragment` in
   `src/components/Viewer.tsx`, the inline boot script in
   `src/components/BootShell.tsx:80`, `src/lib/accounts/identity.ts:113` and
   `src/lib/artifact/linkTarget.ts`. Any fragment they do not recognise raises
   the unknown-fragment notice (`Viewer.tsx:520`). The operator's answer to Q7
   ("switching only filters") does not need a choice per tab. The choice is
   kept per browser in `localStorage` instead, under `llv:workspace:v1`, the
   same way the rail keeps its footer mode (`useStoredChoice`,
   `ProjectRail.tsx:561`). One rule keeps links working: when the selected
   project (from a link, a search result, a notification or a phone push) is
   outside the chosen workspace, the choice moves to that project's workspace,
   or to "All" if the project is Unassigned. The selected row is then always
   in the rail. The server keeps no default per member in (a). A per-member
   default only matters once members have workspaces (b).
2. **Aliases resolve on read; nothing moves at succession (changes §3.1 and
   §5).** The earlier text said the succession pass moves the
   `workspace_projects` row "in the same transaction" as the seat and binding
   rows. That cannot be done. `team.sqlite` is a separate file, the alias map
   is written by `persistProjectAliases` (`src/lib/projects/aliases.ts:286`),
   and the board layout moves in `migrateBoardProjects`
   (`src/lib/projects/succession.ts:115`). No transaction covers all three.
   Instead, every key is passed through `canonicalProject` when it is
   written, and every stored row is resolved again through
   `projectAliasResolver()` (`aliases.ts:80`, a single snapshot for the batch)
   when it is read. This is the way bindings resolve
   (`src/lib/accounts/projectBindings.ts:329`). Writes repair the store as a
   side effect (§13.2). `succession.ts`, `aliases.ts` and `describe.ts` are
   not changed.
3. **Two tables, and no other schema change.** Only `workspaces` and
   `workspace_projects` are added. `slug` and `archived_at` are dropped,
   because nothing in (a) reads them and a workspace is deleted only when it is
   empty. `workspace_members` comes with (b). The team store's
   `SCHEMA_VERSION` stays `1`. Raising it would make the release before this
   one refuse the file on rollback (`store.ts:345-347`), and that is a sign-in
   outage. An older release ignores two extra tables. No index is declared
   either. Both tables are keyed by their primary key, and a list of a
   workspace's projects scans a table of tens of rows. A new name in
   `teamIndexes` would make the first process to open an existing file run an
   index repair. Under `assertStateStartupMutation`, only the Viewer and the
   runtime host may do that, so a launcher or the MCP server opening the
   store first would throw.
4. **Nothing starts in a workspace.** There is no default workspace and no
   migration. Every project is Unassigned until the owner places it. A team
   installation with no workspace draws exactly today's UI (D6), and so does a
   solo installation: a workspace needs the team's owner, and the team store
   is absent in solo mode (`store.ts:33-36`).
5. **Unassigned is visible to everyone in (a).** Q3 shows it to the owner and
   the managers. In (a) there are no managers, and the slice may not hide
   anything, so every signed-in person sees the Unassigned group. Only the
   owner sees "Move to…". The prototype's note "Only you see these until you
   place them." would be false in (a), so it ships with (b).
6. **No audit events in (a).** §3's `workspace.*` team events and their
   Activity rendering come with (b), together with the membership events that
   make them useful (§13.11).

### 13.2 The record

The tables are created in `TeamStore`'s constructor DDL block
(`src/lib/team/store.ts:255`), beside `members`, as `CREATE TABLE IF NOT
EXISTS`. That block already runs for every table on every open.

```
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,           -- "w_" + 32 lowercase hex, minted by the client (§13.3)
  name TEXT NOT NULL,            -- trimmed, inner whitespace collapsed, 1–40 characters
  name_key TEXT NOT NULL UNIQUE, -- the name NFKC-normalised and lower-cased: two workspaces never read the same
  color TEXT NOT NULL,           -- a MemberColor (contract.ts:10)
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,      -- the owner's member id
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_projects (
  project TEXT PRIMARY KEY,      -- the key as canonicalProject answered at write time
  workspace_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL
);
```

Invariants, which the domain module (`src/lib/team/workspaces.ts`, new) holds
and tests:

- **One workspace per project (D5).** On write, `PRIMARY KEY(project)` holds
  for the raw key. On read, several raw keys can resolve to one canonical key
  (`dir-a` was placed in W1, `repo-b` in W2, and an alias later joins `dir-a`
  to `repo-b`). The **directory** (`workspaceDirectory(store, resolve)`)
  decides which row wins: first the row whose raw key equals the canonical
  key, then the earliest `added_at`, then the lowest raw key. Losing rows are
  left in the table and ignored.
- **Writes repair.** Placing, moving or removing a project deletes, in the
  same `store.transaction(…)`, every row whose raw key resolves to the
  target's canonical key, and then inserts at most one row under the
  canonical key. A deleted workspace leaves no rows, because deletion is
  refused while any row resolves to it.
- **Limits.** At most 64 workspaces (`409 workspace_limit`). At most 500
  projects in one create (`400 too_many_projects`). Project keys are trimmed,
  1–200 characters, have no C0 control characters, and are never the rail's
  `__overview__` sentinel (`src/components/projectModel.ts:10`); anything
  else is `400 invalid_project`. The key shape is not checked further. The
  rail also lists keys that are not `dir-`/`repo-` hashes, such as manual and
  legacy names, and each of those has to be placeable.
- **Names.** Empty gives `400 name_required`. More than 40 characters gives
  `400 name_too_long`. A `name_key` already in use gives `409 name_taken`. A
  colour outside `MEMBER_COLORS` gives `400 invalid_color`. When the create
  sends no colour, the first colour no workspace uses is picked, or `slate`.

Store methods added to `TeamStore` (SQL only, no rules): `workspaceRows()`,
`workspaceProjectRows()`, `insertWorkspace(row)`, `updateWorkspace(row)`,
`deleteWorkspace(id)`, `deleteWorkspaceProjects(rawKeys)`,
`insertWorkspaceProject(row)`. Domain functions in `workspaces.ts`, each
throwing `TeamError` with the codes above: `workspaceDirectory`,
`createWorkspace`, `updateWorkspace`, `deleteWorkspace` (refused with
`409 workspace_not_empty` while the directory gives it any project, and
`404 workspace_gone` for an unknown id), `placeProject(project,
workspaceId | null)`. Types go in `src/lib/team/contract.ts`, which stays
client-safe:

```
interface Workspace { id: string; name: string; color: MemberColor; createdAt: string; projects: string[] }
type WorkspacesView =
  | { mode: "solo" }
  | { mode: "team"; canManage: boolean; workspaces: Workspace[];
      catalog?: { ready: boolean; projects: { project: string; displayName: string; smt: number }[] } };
```

`projects` holds canonical keys only, sorted. `workspaces` is sorted by name
with `Intl.Collator` in the installation's locale.

State ownership: the store resolves its file through `statePath` (`store.ts:684`)
like every other team read, so a build or a test gets a throw-away directory
under the rules of `src/lib/stateOwnership.ts`. The workspace code never
creates the file. Reads use `existingTeamStore()`, and every route answers
solo without a `stat` past the one that function already makes.

### 13.3 Routes

All of these sit under `src/app/api/team/`. Each one runs `crossOrigin(req)`
first and answers errors through `teamErrorResponse`, with `Cache-Control:
no-store` from `teamJson`. None of them is added to the gate's sign-in list
(`src/lib/team/gate.ts`), so the identity gate covers every one.

| Route | Who | Body / query | Answer |
|---|---|---|---|
| `GET /api/team/workspaces` (`workspaces/route.ts`) | solo: anyone; team: `requireMember` | `?catalog=1` adds `catalog` | `WorkspacesView`; `canManage` is true for the owner |
| `POST /api/team/workspaces` | `requireOwner` | `{ id, name, color?, projects?: string[] }` | `201 { workspace }`. A replay with the same `id` and the same name answers `200` with the stored row, so a lost answer retried with its key does not create a second workspace (rule 15). The same `id` with another name is `409 id_taken` |
| `PATCH /api/team/workspaces/[id]` (`workspaces/[id]/route.ts`) | `requireOwner` | `{ name?, color? }` | `{ workspace }` |
| `DELETE /api/team/workspaces/[id]` | `requireOwner` | none | `{ ok: true, deleted: boolean }`; `409 workspace_not_empty`; deleting an id that is already gone answers `deleted: false` |
| `PUT /api/team/workspace-projects` (`workspace-projects/route.ts`) | `requireOwner` | `{ project, workspaceId: string \| null }` | `{ project, workspaceId }` with the canonical key. `null` means Unassigned. The same request again changes nothing. `404 workspace_gone` |

Add, Remove and Move to… are all the single `PUT` call, which is why it is
not nested under one workspace's id.

`requireOwner` (`src/lib/team/http.ts:59`) answers `401 member_required` when
there is no session and `403 owner_required` for a member. Those are the only
two refusals for a non-owner, and both are tested on every write route.

**The `catalog` read.** Only the Team page's Workspaces tab and the
workspace page ask for it, once when they open and once after each of their
own writes. Nothing polls it. It is one pass over
`conversationCatalogSnapshot()` (`src/lib/scanner/conversationCatalog.ts:80`,
held on `globalThis`, so it is the Viewer's single shared instance): it
reduces entries to one row per canonical key, taking the newest `mtime` as
`smt` and the label from `projectName` or `projectDisplayName`. The manual
projects of `projectCurationSnapshot()` (`src/lib/projects/curation.ts`) are
added after that pass. `ready` is `conversationCatalogReady()`. Before the
first scan the list is empty, and the UI says the projects are still loading
(§13.5). The pull request reports the time this read takes in a scratch
export, against a synthetic catalog of 53,299 rows (the size the candidate
performance gate uses), with the conditions written beside the number. The
board's rail does not use this read. It computes Unassigned from the
summaries it already has (§13.4).

### 13.4 Client state and filtering

- **`src/components/team/workspacesClient.ts`** (new). One module-level store,
  shared by every hook, like `teamClient.ts`. `useWorkspaces({ catalog? })`
  fetches `GET /api/team/workspaces` the first time something subscribes on a
  team install, and fetches again when the tab becomes visible and after each
  write. There is no interval. It returns `null` while loading. The writes
  are optimistic (learned rule `r_3f9acb28`): the directory shows the result
  on the click, and the request runs in the background. On a refusal the
  directory rolls back to the last state the server confirmed, and the error
  shows where the action was taken (the row, the menu or the dialog). Create
  is optimistic too, because the client mints the id (`w_` plus 16 bytes from
  `crypto.getRandomValues`, as hex) and the replay rule of §13.3 makes a retry
  safe. Nothing waits on a spinner.
- **The current workspace.** `useCurrentWorkspace()` reads and writes
  `llv:workspace:v1` (`"all"` or a workspace id). An id that no longer exists
  reads as `"all"`. With zero workspaces the value is ignored.
- **`src/components/team/workspaceFilter.ts`** (new, pure, unit-tested):
  `workspaceScope(view, current) → ReadonlySet<string> | null`, where `null`
  means All; `workspaceOf(view, project) → id | null`;
  `followSelection(view, current, selected) → next current`, the rule in
  §13.1.1; and `groupAll(summaries, view)`, which returns the sections of the
  All view in order: one section per workspace, sorted as the API sorts them,
  then Unassigned.
- **Where the scope applies.** The scope applies in three places and nowhere
  else: `ProjectRail` (its summaries, before the pinned / projects / archive
  split, so crown and archive keep working inside a workspace),
  `MobileProjectSheet` (the same), and `OverviewBoard` (its summaries, and
  the `tasks` it draws, filtered by `task.project` against the scope). Each
  gets one optional prop, `workspace?: WorkspaceRailState`, carrying the view,
  the current choice and the setters. When the prop is absent (solo, no
  workspaces, still loading) the component renders exactly as it does today.
  `Viewer.tsx` builds that prop once and runs `followSelection` in an effect
  on `project`. The Needs-you panel, the search, the header counts,
  `railOrder` (`Viewer.tsx:1039`), `/api/files` and `/api/tasks` are **not**
  filtered in (a). That is the "only filters" answer applied to the rail and
  the Overview, and the gate in (b) narrows the rest.

### 13.5 UI states, desktop and 390 px, en and uk

All of these follow prototype variant 2 at `6f3b45a18`
(`docs/prototypes/workspaces/app.js`: `railHeader`, `switchPop`, `rail`,
`movePop`, `workspacesTab`, `createStep1`, `wsPage`, `phoneBar`,
`projectSheet`). Sections that belong to a later slice are cut, as listed
after each state. Existing controls are reused. The new pieces are the ones
§9 names as having no existing equivalent: the switcher chip and its menu, the
Workspaces tab, and the workspace page.

**Desktop** (the rail is 248 px; evidence at 1440, at 820 between the named
widths, and at 390):

| # | State | Defining element (visible text on the first screen) | Built from | Cut from the prototype in (a) |
|---|---|---|---|---|
| D1 | Current workspace shown | Rail header: mark, then the chip `● Client work ▾` in place of the product name, then hide and ⋯. With "All" the chip reads `All workspaces` with the folders icon | the `chip` trigger class of `EngineAccountSwitch.tsx:21`; `HEADER_SQUARE` buttons unchanged | — |
| D2 | Switcher open | Menu titled `Workspaces`. Rows: `All workspaces · N projects` with a check when current, then one row per workspace (dot, name, count, check), a divider, then for the owner `Workspace settings` (only while a workspace is current), `New workspace` and `Manage workspaces`. A member sees only the rows and `Manage workspaces` | the dismissal of `RailHeaderMenu` (`ProjectRail.tsx:483`: outside pointer, Escape, focus return) and the `BAR_MENU_ROW` row class | — |
| D3 | Owner's All view | Rail sections: `● <workspace> N` for each workspace, then `Unassigned N`, then the Archive fold. A pinned project stands first under its own workspace with a crown before its name, so each heading counts the rows under it and the number the switcher shows; the Pinned section stays inside a chosen workspace, where an empty `Projects 0` heading is not drawn. On the selected Unassigned row, or one with keyboard focus, a `Move` button takes the marks' columns, which step aside the way the age steps aside for the crown (`ProjectRail.tsx:429`). It opens a `Move to…` menu listing the workspaces | `SectionLabel` with a dot icon; `RailRow` unchanged | the "Only you see these" note (§13.1.5) |
| D4 | Team → Workspaces tab | A fourth tab, `Workspaces`, after `Members`. Lead line, then `New workspace` (owner). Each workspace row has its colour square and name, and under them `N projects · name, name…` (one line, truncated), with ⋯ (owner: Open, Rename, Delete). A heading `Unassigned projects · N`, then rows with name and age and `Move to…` (owner) | `TeamPage` tab strip (`TeamPage.tsx:72`); the row layout of `MembersTab` | manager line, member avatars, the unfenced warning |
| D5 | New workspace | Dialog `New workspace`: `Name` (focused), `Colour` (the 8 swatches of `MembersTab.tsx:466`), `Projects` (a checklist: Unassigned first, then the ones in another workspace with `in <workspace>`) with the hint, then `Cancel` and `Create workspace` | `TeamDialog` (`src/components/team/ui.tsx:110`), `Field`, `INPUT`, `BUTTON` | `Manager` field (b); step 2 (accounts, chat, share) (c); the step counter, since (a) has a single step |
| D6 | Workspace page | `/team/workspaces/<id>`: the back link `Board`, the title `● Client work`, the subline `Workspace · 3 projects`, and the actions Rename (inline field) and Delete. A section `Projects` with `Add project`, which opens the same checklist as a menu; each project row has its name, then its age, then `Remove from workspace` | the `TeamPage` header and back link; the `Field` input | `Members`, `Agent accounts`, `Report chat`, `Worker share`, `Usage this week`, `Agent fence` sections ((b)–(d)) |
| D7 | Delete refused | On a workspace that has projects, Delete is disabled and the text beside it reads `Move its projects out first.` | — | — |

**Phone** (390 × 844; the board's bar is 52 px):

| # | State | Defining element | Built from |
|---|---|---|---|
| P1 | Current workspace shown | The board bar title: a small line `● Client work` above the project name (with All: `All workspaces`). The same line appears over the Overview title | `MobileBarTitle` (`src/components/mobile/MobileShell.tsx:397`), which gains an `eyebrow` slot in the `meta` line's classes, above the name. The bar holds two lines at most: while the reconnecting line or `meta` shows, the eyebrow is hidden |
| P2 | Switcher expanded | First row of the Projects sheet: `● Client work`, sub `Workspace`, with a chevron. A tap expands an indented list under it: `All workspaces · N projects`, each workspace with its count and the current one checked, then for the owner `Workspace settings` and `New workspace`. While it is expanded and a workspace is current, the project list is hidden, as in the prototype | `MobileSheetRow` and the indented sub-list (`MobileProjectSheet.tsx`, `MobileSheet.tsx`) |
| P3 | All view in the sheet | After the divider, `Overview · N projects`, then for each workspace a small heading (dot, name, count) and its rows, a crowned one first, then `Unassigned N` with its rows. Owner: each Unassigned row has a `Move` button, which takes the place of the row's working and needs-you marks. A tap expands `Move to…` with the workspaces under it | `MobileSheetRow` trailing slot; the sheet's section style |
| P4 | Team → Workspaces tab | As D4. The four tabs share the width (`max-sm:flex-1`), and each row holds two lines | `TeamPage` |
| P5 | New workspace | D5 as a bottom sheet (`TeamDialog` on the phone) | `TeamDialog` |
| P6 | Workspace page | D6 in one column, with 44 px rows and `Remove` written out | — |

Every state ships in en and uk, light and dark. All the copy goes into
`src/lib/i18n/en.ts` and `uk.ts`. The uk strings are the prototype's, except
where (a) changes the meaning:

| Key | en | uk |
|---|---|---|
| `workspaces.label` | Workspace | Простір |
| `workspaces.heading` / `team.tabs.workspaces` | Workspaces | Простори |
| `workspaces.all` | All workspaces | Усі простори |
| `workspaces.new` | New workspace | Новий простір |
| `workspaces.manage` | Manage workspaces | Керувати просторами |
| `workspaces.settings` | Workspace settings | Налаштування простору |
| `workspaces.unassigned` | Unassigned | Без простору |
| `workspaces.unassignedTitle` | Unassigned projects | Проєкти без простору |
| `workspaces.move` | Move | Перенести |
| `workspaces.moveTo` | Move to… | Перенести в… |
| `workspaces.lead` | Each workspace is a named set of projects. | Простір — це іменований набір проєктів. |
| `workspaces.create.name` | Name | Назва |
| `workspaces.create.colour` | Colour | Колір |
| `workspaces.create.projects` | Projects | Проєкти |
| `workspaces.create.projectsHint` | A project belongs to one workspace. | Проєкт належить одному простору. |
| `workspaces.create.submit` | Create workspace | Створити простір |
| `workspaces.inWs` | in {ws} | у «{ws}» |
| `workspaces.page.sub` | Workspace · {projects} | Простір · {projects} |
| `workspaces.page.add` | Add project | Додати проєкт |
| `workspaces.page.remove` | Remove from workspace | Прибрати з простору |
| `workspaces.page.empty` | No projects yet. | Проєктів ще немає. |
| `workspaces.rename` | Rename | Перейменувати |
| `workspaces.delete` | Delete workspace | Видалити простір |
| `workspaces.deleteBlocked` | Move its projects out first. | Спершу перенесіть його проєкти. |
| `workspaces.catalogLoading` | Projects are still being found. | Проєкти ще шукаються. |
| `workspaces.error.nameRequired` | Give the workspace a name. | Дайте простору назву. |
| `workspaces.error.nameTaken` | A workspace with this name exists. | Простір із такою назвою вже є. |
| `workspaces.error.gone` | This workspace was deleted. | Цей простір видалено. |
| `workspaces.error.notEmpty` | Move its projects out first. | Спершу перенесіть його проєкти. |

Counts reuse `mobile2.projects.count` ("{count} projects" / «{count}
проєкти/проєктів»). The back link reuses `activity.back`, and Cancel and
Close reuse `common.cancel` and `common.close`. The prototype's
`create.projectsHint` second sentence ("Only the people in this workspace will
see it") is not shipped, because it is false until (b).

### 13.6 Files to touch

| File | Change |
|---|---|
| `src/lib/team/contract.ts` | `Workspace`, `WorkspacesView` |
| `src/lib/team/store.ts` | the two tables in the constructor DDL; the seven SQL methods of §13.2 |
| `src/lib/team/workspaces.ts` (new) | directory, rules, writes (§13.2) |
| `src/app/api/team/workspaces/route.ts` (new) | `GET`, `POST` |
| `src/app/api/team/workspaces/[id]/route.ts` (new) | `PATCH`, `DELETE`. Read `node_modules/next/dist/docs/` for the route `params` shape this Next version uses, as `members/[id]/route.ts` already does (`ctx.params` is a Promise) |
| `src/app/api/team/workspace-projects/route.ts` (new) | `PUT` |
| `src/components/team/workspacesClient.ts` (new) | store, hooks, optimistic writes |
| `src/components/team/workspaceFilter.ts` (new) | the pure functions of §13.4 |
| `src/components/team/WorkspaceSwitch.tsx` (new) | D1/D2 chip and menu, P2 sheet rows, the shared `Move to…` menu (D3, D4, P3) |
| `src/components/team/WorkspacesTab.tsx` (new) | D4, D5 (dialog) |
| `src/components/team/WorkspacePage.tsx` (new) | D6, D7 |
| `src/components/team/TeamPage.tsx` | `TeamTab` gains `"workspaces"`; the fourth tab |
| `src/app/team/page.tsx` | `TABS` gains `"workspaces"`; `?create=1` opens D5 |
| `src/app/team/workspaces/[id]/page.tsx` (new) | mounts `WorkspacePage` |
| `src/components/ProjectRail.tsx` | `workspace` prop: the header chip (D1), scope, the All grouping and the Move button (D3) |
| `src/components/mobile/MobileProjectSheet.tsx` | `workspace` prop: P2, P3 |
| `src/components/mobile/MobileShell.tsx` | `MobileBarTitle` `eyebrow` (P1) |
| `src/components/ProjectDashboard.tsx`, `src/components/OverviewBoard.tsx` | pass the eyebrow; `OverviewBoard` applies the scope |
| `src/components/Viewer.tsx` | build `WorkspaceRailState` on team installs and pass it to the rail, the sheet and the Overview; the `followSelection` effect |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | §13.5 keys |
| tests and the two evidence fixtures | §13.8, §13.9 |

### 13.7 What must not change

- **A solo installation.** No file is created, no request beyond today's runs,
  and no pixel changes. `GET /api/team/workspaces` answers `{ mode: "solo" }`
  after the one `stat` that `existingTeamStore` makes. A test checks that
  `team/team.sqlite` is still absent afterwards (#1905).
- **A team installation with no workspace.** The rail, the sheet and the
  bars render as they do today. The existing `ProjectRail.header.dom.test.tsx`,
  `ProjectRail.dom.test.tsx` and `MobileShell*.dom.test.tsx` pass unchanged.
- **What anyone may see.** `/api/files`, `/api/tasks`, the streams, the MCP
  server and the identity gate return exactly what they return today, to
  everyone. The filter runs only in the browser, in the three places of
  §13.4.
- **Project-key logic.** `src/lib/scanner/describe.ts`,
  `src/lib/projects/succession.ts`, `src/lib/projects/aliases.ts` and
  `src/lib/projects/identity.ts` are not changed.
- **The hash grammar**, the boot script, and the team store's
  `SCHEMA_VERSION` and `teamIndexes` stay as they are.
- **Crown and archive** keep their meaning inside a workspace. A crowned
  project in a filtered-out workspace leaves the Pinned section while
  filtered out and comes back on All.
- **No new loop or poll**, and no added work on the files poll, the board
  summary or the runtime snapshot. The runtime host is untouched.
- **Fences:** `src/lib/mcp/*`, the CPU admission queue, and
  `src/lib/runtime/agentSignalSandbox.ts` belong to other lanes.

### 13.8 Tests

Every test runs by explicit path through `scripts/gate-slot.sh bun test
<file>`, with HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` pointed under
the OS temp root and `LLV_VIEWER_CONTROL_URL` set to a closed port. None runs
against live state.

1. `src/lib/team/workspaces.test.ts` (new): create, rename, recolour, delete;
   the name rules (empty, 41 characters, `name_key` collisions that differ
   only in case or NFKC form); default colour choice; the 64-workspace limit;
   a create replayed with the same id and name gives one row, and with another
   name `id_taken`; `placeProject` moves a project between workspaces and
   back to Unassigned, keeping one row; deleting a workspace that has projects
   is refused, and a workspace with none deletes.
2. **Alias resolution**, in the same file, with an isolated `LLV_STATE_DIR`
   and the real `persistProjectAliases`:
   - (a) a project is placed as `dir-a`, `dir-a → repo-b` is aliased, and the
     directory lists `repo-b` in the same workspace while `workspaceOf(repo-b)`
     answers that workspace;
   - (b) `dir-a` is in W1 and `repo-b` in W2 before the alias is recorded, and
     the `repo-b` row wins;
   - (c) a move after (b) leaves one row under `repo-b`;
   - (d) a delete check counts a project held only through an alias;
   - (e) a chain `dir- → repo-<local> → repo-<remote>` resolves to the last
     key.
3. **Schema**: a `team.sqlite` written by the current store (without the
   tables) opens, gains both tables, and keeps `meta.schema = 1`; the
   declared indexes are the same set as before.
4. `src/app/api/team/workspaces.routes.test.ts` (new, in the style of
   `routes.test.ts`):
   - the owner's full round trip (create with projects, rename, place, move,
     unassign, delete-refused, empty, delete);
   - every write as a member gives `403 owner_required`, signed out gives
     `401 member_required`, and from another origin is refused by
     `rejectCrossOrigin`;
   - invalid ids, names, colours and projects (including `__overview__`
     and control characters) give 400;
   - an unknown workspace gives 404;
   - in solo mode `GET` answers `{ mode: "solo" }` and creates no file;
   - `?catalog=1` reduces a seeded catalog to one row per canonical key and
     adds manual projects.
5. `src/components/team/workspaceFilter.test.ts` (new): the scope for All and
   for one workspace; an unknown stored id reads as All; `followSelection`
   moves to the selected project's workspace, and to All for an Unassigned
   one; the order of `groupAll`, with Unassigned last and empty workspaces
   kept with count 0.
6. DOM tests:
   - `ProjectRail.workspaces.dom.test.tsx` (new, beside the existing rail DOM
     tests): no prop draws today's header; a chosen workspace lists only its
     rows and keeps crown and archive inside it; All draws the sections in
     order; the Move button appears on the selected Unassigned row for the
     owner and never for a member; a refused move rolls back with its error.
   - `MobileProjectSheet` gets the same cases in a new
     `MobileProjectSheet.workspaces.dom.test.tsx`.
   - `MobileShell.dom.test.tsx` gets one case for the eyebrow, hidden while
     reconnecting.
   - `TeamPage`'s Workspaces tab gets one case for D4 as owner and member.
7. The project's own checks: `bunx tsc --noEmit`, eslint on the changed
   files, and the privacy gate with the committed fingerprints. These are the
   ones the pre-push hook runs (AGENTS.md "Local hooks mirror the publication
   gate").

### 13.9 Rendered evidence through the existing drivers

No new driver is written. The cases are added to the two that exist:

- **Desktop**: one `describe("team workspaces slice (a)")` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx` over
  `issue1695Evidence.fixture.tsx`. The fixture gets three scenarios.
  `scenario=workspaces` is the real `Viewer`, with `/api/team` answering team
  mode with an owner and a member, and `/api/team/workspaces` answering three
  workspaces and two Unassigned projects (the fixture's routes in
  `HEADER_ROUTES`, `issue1695Evidence.fixture.tsx:3832`). `workspaces-team`
  and `workspaces-page` mount `TeamPage` and `WorkspacePage` in the fixture's
  `createRoot` switch (`issue1695Evidence.fixture.tsx:4871`), which already
  mounts other surfaces by scenario. Frames are D1–D7, plus D2 as a member,
  at 1440, 820 and 390 wide, in en and uk, light and dark. Gate:
  `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`.
- **Phone**: one block in
  `src/components/mobile/issue1671Evidence.browser.test.tsx` over
  `issue1671Evidence.fixture.tsx` with the same mocked routes. Frames are
  P1–P6 at 390 × 844, en and uk, light and dark. Gate:
  `LLV_SWIPE_BROWSER_TEST=1`.
- Both blocks assert, from text ranges:
  - each state's defining text is on the first screen;
  - no menu, popover or sheet leaves the viewport or covers foreign text;
  - the chip label truncates inside its own box at 248 px with a 40-character
    name;
  - the phone eyebrow and the name both fit in the 52 px bar.

  The geometry JSON is committed under `evidence/` only if the driver
  already writes it there. No rendered image is committed (acceptance 1;
  learned rule `r_51be04341d386e99`).
- The drivers are heavy, so they go through `scripts/gate-slot.sh` with a
  short Chrome `TMPDIR`.

### 13.10 The prototype sources

The static sources may land under `docs/prototypes/workspaces/` from
`6f3b45a18`. Those are `README.md`, `index.html`, `variant-1.html` to
`variant-4.html`, `app.js`, `styles.css`, `render.mjs` and the two
`assets/*.svg`. **None of the 32 `*.png` frames** lands with them. If they
land:

- a `.gitignore` inside that directory ignores `*.png`, because `render.mjs`
  writes its frames there;
- the README's "The frames" section is rewritten to say the frames are
  rendered locally and not committed.

This stage's write access is the design document only, so the build lane
carries this step (`git checkout 6f3b45a18 -- <each path>`, never the PNGs).
The prototype's names and accounts are invented. The privacy gate still runs
over the copied files before the push.

### 13.11 Deferred from slice (a): not currently justified

- Audit events (`workspace.created`, `…project_added/removed`) and their
  Activity rendering: with (b), next to the membership events.
- The server-side default workspace per member, and `#w=` in the URL: (b), if
  a member with several workspaces needs one on a fresh device.
- Hiding Unassigned from non-managers, the "Only you see these" note, and
  the no-access and no-workspace cards: (b).
- Filtering the Needs-you panel, search, header counts and the API answers:
  (b), at the gate.
- Archiving a workspace (`archived_at`) and a workspace `slug`: not asked for.

### 13.12 Slice (a) against the requirement and the decision

| Asked | Where in (a) |
|---|---|
| Create separate workspaces | §13.2 record, §13.3 `POST`, D5/P5 |
| The owner creates workspaces (Q2) | owner-only writes, `requireOwner`; members get read-only rows |
| A newly found project lands in Unassigned with Move to… (Q3) | §13.1.4 (nothing starts placed), D3, D4, P3; managers come with (b) |
| The owner sees the full list grouped by workspace, All at the top; switching only filters (Q7) | D2, D3, P2, P3; §13.4 (browser-side filter, nothing restricted) |
| The UI changes a little | three new pieces (chip and menu, tab, page); everything else reuses existing controls (§13.5) |
| Survives project-key succession | §13.1.2, §13.2, tests 2 (a)–(e) |
| Level 2's fence, accounts, chats, usage (Q1, Q5, Q6) | slices (c) and (d), not started here |

## 14. Slice (c): MCP authority and defaults

A team launch records `LaunchProfile.workspace = { memberId, workspaceId }`
from authenticated server attribution. Task-card launches, pipeline stages,
seat creation and rotation carry it too; migration and resume retain the
profile. Pipeline and pending-seat records retain the same scope across
restart. Existing member-directed conversations resolve their latest server-admitted
member input, including sends without a browser message id, reused ids, queue
edits, task fan-out and question answers. Parallel asks retain the authenticated
member and workspace in their durable deputy record; registration, delivery,
replay and retry preserve that binding independently of the seat's later inputs.
Parallel request keys join or replay only within the same project and member;
a collision returns no saved ask or deputy identity.
Member decision answers and stage edits bind an installation pipeline in the
same transaction as the accepted edit. These input routes and the project
report route keep the admitted member identity across body and catalog waits.
An unavailable team store refuses their writes.
That per-conversation authority is persisted before
dispatch and is independent of the feed's first-author attribution. Retired-seat
redirects carry that authority to the successor before enqueueing, and refuse a
revoked member. An uncertain
or refused dispatch conservatively retains the admitted member fence. Older
conversations fall back to their latest recorded message author. Owner
conversations and installation-owned seats without a member binding retain
their existing reach.

Authority resolution shares one lazy seat map across the parent chain. The
process retains one map for the seats file's path and filesystem identity;
unchanged files are never reparsed by repeated calls. Each resolution checks
device, inode, size, modification time, change time and mode, so peer rebinding
or revocation is visible to the next call. Failed reads are retried.
Solo installations and teams without workspaces skip that read. Unreadable
seat authority returns a retryable refusal.

History pruning keeps the latest author row for each conversation as authority,
including tied timestamps in admission order. Older message rows and unbound
history still expire; expiry and restart never widen a legacy member session.

The production MCP dispatcher checks the binding before pagination and
receipt replay. It uses slice (b)'s `workspaceScope` for current membership
and the bound workspace for project placement. Explicit projects, tasks,
pipelines, conversations, selected-card references, nested targets and launch
directories all need authority. Collections default to the caller's project;
a caller can explicitly select another project in the same workspace.
Installation-wide tools refuse for a member-bound caller. Checks repeat at
binding and HTTP dispatch, inside task writes and before a read result is
returned. Unknown or inaccessible targets disclose no resource content.
Full result identities are checked before display compaction, so a foreign or
Unassigned project's short prefix cannot impersonate an allowed project.
Transcript search discards the unscoped fallback and installation-wide corpus
and duplicate metadata.

`GET` and `PUT /api/team/workspaces/[id]/defaults` admit the owner and that
workspace's managers. The durable value holds `accounts` (Claude and Codex
lists), `reportChat` (chat, report name and optional topic), and
`directiveChats`. A report chat must be known and postable in the bot catalog.
Managers cannot select another workspace's destination, an explicit report
destination of a project outside their workspace, or the owner's linked private
chat; aliases, ids and usernames resolve to the same chat. The owner may select
any postable destination. Explicit project report overrides apply the same
reservation and recheck manager authority after Telegram verification.
Empty account lists preserve the unrestricted shared pool.
Per-project account bindings narrow a workspace's allowed pool; an empty
intersection permits no account. An explicit report choice takes precedence,
including "Log only". Defaults are inherited at the existing project
account and report resolvers, rather than copied into those stores: this keeps
new placements, aliases and edits consistent while preserving explicit project
choices. No workspace read writes a project setting.

Launch admission uses the inherited pool. A member-bound named account cannot
bypass it. Telegram report replies must originate in an allowed directive chat
when a workspace names such a list. Queued replies retain their source chat and
recheck it after readiness; a withdrawn permission terminally refuses the row
with its reason. The bot's existing sender, report-reply and posting checks
continue to apply. Usage grouping, worker shares and resource slices remain
slice (d).
