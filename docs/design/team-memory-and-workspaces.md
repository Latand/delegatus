# Team memory and workspaces: keep all memory, use all of it per launch, per-member rules that become team rules, and the isolation left to build

Status: design, 2026-11-03, read-only stage. Every code claim was checked
against `main` at `ead78b894` (this lane's starting commit); pull request
#3415 was read at its head `4e0bd2688`. Nothing here is built. The operator's
decision form follows this document. Projects other than this repository are
named by letter; no person, account, chat, path or rule text appears here.

## Originating requirement

Operator, 2026-11-03 about 10:40 UTC, by voice in Russian, in this
repository's orchestrator seat conversation. The words are private operator
speech held on this machine and the pinned specification marks them for
agents only, so this is a dated paraphrase:

1. Find the earlier task about raising the character limits and being able to
   keep all memory and use all memory. Consolidate it somehow, perhaps as a
   graph, so that it gathers. This was thought through once; find the issue
   and the conversations and decide what is best.
2. With team work, every account gets its own rules, and from them the
   curator creates rules for the whole company.
3. Finish workspaces with isolation, so that a company can install Delegatus,
   give each person an account, each account isolated as now or better. Each
   person signs in, sees only their workspaces, works only in their folders,
   does their own actions, and chooses a Claude or a Codex subscription. Each
   workspace has its own accounts and binding; that mostly exists already but
   must stay.

Operator update, 2026-11-03 about 10:55 UTC, same conversation (supersedes the
2026-10-22 selection answer): memory selection uses OpenAI Decisions with a
prompt checked by offline evaluations, with no shadow run and no
data-collection period; a separate lane is switching it now (task ebbf8f15,
lane d75de2eb). BM25 stays only as the failure fallback. For workspaces: each
project's report destination should be able to use a paired relay clone when
one is installed, and members must never reach the owner's private
conversations through the relay or a clone. A read-only audit of today's
access paths runs as task 5f5c4555 (lane 57064780); at the time of this
reading its first stage had not started (it was retained in `spawning` with
the error "role-memory privacy changed before dispatch"), so §4.5 lists the
paths from the code instead of citing the audit.

The default answer to "should we build this" is no unless the requirement
demands it. It asks to finish two features whose halves are already shipped,
and to extend memory in one new direction (per-member rules). Everything that
only the new words justify is built; everything else stays under "Deferred".

## 0. Earlier answers this design starts from

The pinned specification names the decisions below. Each record was read.
None is reopened unless the 2026-11-03 words change it, and §0.1 says where.

| Decision record | What it settled | Status on main |
| --- | --- | --- |
| `docs/design/role-memory-layers.md` §7.3, operator form of 2026-10-22 (task a6d8a8a0) | Role-on-every-project written by the curator only; Jev only if a second pilot beats BM25 by 10 points, else BM25; one hard maximum per launch of 24 000 bytes; store targets role-here 20 000, role-everywhere 30 000, project and machine 15 000 code points, raised together with selected delivery; layer field plus parent link, principles always-on up to 3 000; curator decides the layer; operator reviews quality visually | Slice 1 shipped (#3191: frozen block, shadow selection, applied/misled). Slices 3 (layers), 4 (selected delivery under the hard maximum) and 5 (targets) are unbuilt (§1.1) |
| Task ebbf8f15, 2026-10-29 analysis and #3570 (deployed 2026-11-02) | Jev had 0 successes in shadow until the admission fix; BM25 median 32 of 103 rules, applied recall 71.7 %; a week of shadow data was to be collected | Superseded by the 2026-11-03 update: Decisions, evaluated offline, delivered live; lane d75de2eb is building it |
| Operator decision of 2026-11-03 about 10:30 UTC (task 88398512, lane 4dee5653) | Compressed rules are rewritten as plain sentences, the curator archives instead of compressing, and the per-scope bound rises; the seat chose 15 000 as the interim value | Lane in the CPU queue at reading time; §2.5 reconciles it with the 2026-10-22 targets |
| `docs/design/swarm-role-memory.md` and task 48d60ffc, operator form of 2026-10-23 | Opt-in shared role rules shipped with releases, 4 000 code points per role, weekly; anonymous counts; proposals through the owner's approval | Slice 1 shipped (`src/lib/memory/swarmPack.ts`, empty pack); slices 2 to 4 open in the task's steps |
| `docs/design/workspaces.md` §12, operator form of 2026-10-20 (task 7e042e15) | Level 2 isolation; owner creates workspaces, manager adds projects and invites; Unassigned bucket; shared account pool with per-workspace allow-list and usage by workspace; one Telegram bot with per-workspace chats; build order (a) record and switcher, (b) human-route gate and invites, (c) MCP fence and defaults, (d) slice and usage grouping | (a) #3133 and (b) #3255 merged; (c) is PR #3415, open; (d) unstarted (§1.2) |
| `docs/design/sign-in-and-team.md` (#2243) | Members, sessions, authorship stamps, who-did-what; the perimeter key is the operator's; "below the OS a member equals the operator" | Built; §14 defers per-member locale, the capability matrix and several owners |
| `docs/design/per-project-relay-clone.md` (2026-11-02) | Part 1: a project's report destination names which paired clone posts its reports (`reportTelegram.poster`), set by the operator root or the designated seat through `seat_tick_settings.reportPoster` | Designed, not built; the operator's 10:55 UTC words restate its Part 1, so this document links to it and adds only the workspace fence (§4.4) |

### 0.1 Where the new words change an earlier decision

- **Selection provider.** Decision 2 of 2026-10-22 (Jev gated on a second
  pilot, else BM25) is replaced by the 10:55 UTC update: Decisions, evaluated
  offline, delivered live, BM25 on failure. This document designs on that
  basis (§2.3) and does not re-ask it.
- **Nothing else is reopened.** The hard maximum, the layer-plus-parent shape,
  the curator-only role-wide scope, level 2 and every workspace answer stand.
  Where the operator's "perhaps as a graph" could read as reopening decision 5,
  §2.4 weighs it and recommends keeping the decision with one addition.

### 0.2 Earlier conversations

`search_transcripts`, project-scoped first and then unscoped, in five
phrasings (Russian: memory, graph, consolidate, layers, rules; English:
memory graph consolidate layers abstraction; workspace isolation member
account subscription; per-account rules and company rules; relay clone owner
private conversations audit), and `search_memory` for role memory layers,
graph, workspaces and team rules (no hits). Hits opened:

| Conversation (title, date) | What it settles |
| --- | --- |
| Seat conversation of this repository, "You are the Orchestrator. Mode: standard. Safety fences…", 2026-11-03 10:39–10:49 UTC | The two operator requests above; the seat's inventory of earlier decisions that this document checks against code; the seat's lesson that no shadow runs or data-collection periods are wanted |
| Same seat line, 2026-11-03 10:34–10:35 UTC | The compressed-rules decision (option b) and the seat's interim choice of 15 000 |
| Seat conversation of this repository, "You are the Orchestrator. Mode: standard. In every mode, keep at most 3 workers…", 2026-10-11 about 13:38 UTC | The operator asked whether the curator deletes old rules or consolidates them into more abstract ones; the curation design answered with the four levels and merge-preserving-conditions, which §2.4 builds on |
| Codex research sessions of 2026-10-22 (lane 27902c33) | The layers research whose decisions are in §7.3 of the layers document; no graph beyond parent links was proposed there |

## 1. Inventory: shipped, open, missing

### 1.1 Memory

| Piece | State | Evidence |
| --- | --- | --- |
| One store, three row kinds, rules never deleted; archives and versions keep every text | Shipped | `src/lib/memory/roleStore.ts:84-87` (`keepHistory` keeps every curator pass entry), `:305-316` (`versionedRule`: a rewrite archives the prior text as a version row), `:384-409` (the rewrite path) |
| Four scopes a stage reads: role here, role on every project, project, machine; plus the opt-in swarm scope | Shipped | `roleStore.ts:154-156` (`readableScopes`), `src/lib/memory/roleScopes.ts:13-15` |
| Per-scope target 10 000 code points | Shipped, interim raise to 15 000 in flight | `src/lib/memory/roleTypes.ts:11`; lane 4dee5653 (task 88398512) |
| Emergency eviction only when curation is unavailable and the scope exceeds 125 % of its target; a new lesson never evicts; the curator integrates and restores budget archives | Shipped (#3340) | `src/lib/memory/roleConsolidate.ts:67-92`, `roleStore.ts:50-78` (`retentionPolicy.canCurate`), `src/lib/memory/curation/brief.ts:13` (check 7) |
| Whole-scope delivery, block frozen per attempt, 120 000-byte argument guard | Shipped (#3191) | `src/lib/memory/roleLaunch.ts:19`, `:58-104`; `src/lib/memory/roleSelection.ts:99-119` |
| Shadow selection per attempt: BM25 always, provider when a key, its limit and the cap allow; always-on set of operator-kept rules up to 3 000 code points; pack up to 9 000 code points and 24 000 bytes | Shipped, shadow only | `src/lib/memory/roleSelect.ts:10-11`, `:21-28`, `:64-81`, `:111` (`LLV_ROLE_MEMORY_SHADOW`), `roleLaunch.ts:93` |
| Provider chosen per feature: OpenAI Decisions or OpenRouter Jev; Decisions client, model and endpoint | Shipped (#3508) | `src/lib/memory/roleSelectionProvider.ts:81-91`, `:94-137`; `src/lib/openaiServices/decisions.ts:4-6`; `src/lib/openaiServices/policy.ts:15` (`rules` feature) |
| Live Decisions delivery, evaluated prompt, no shadow, BM25 on failure | Open: lane d75de2eb building | task ebbf8f15 |
| Hard maximum of 24 000 bytes on every delivery path | Missing on the live path: only the shadow pack applies it (`roleSelect.ts:11`); the delivered whole block is cut at 120 000 bytes (`roleLaunch.ts:19`, `src/lib/memory/roleRender.ts:51-65`) | layers design §4.3 (slice 4) |
| Layer field and parent link | Missing: the rule record has lineage fields (`mergedFrom`, `mergedInto`, `splitFrom`, `splitChildren`, `movedFrom`, `versions`, `against`) and no `layer` or `parent` | `roleTypes.ts:118-158` |
| Store targets 20 000 / 30 000 / 15 000 / 15 000 | Missing | layers design §7.3 decision 4 |
| applied and misled on `leave_lesson`, accepted only for ids the attempt received | Shipped | `roleStore.ts:366-373` |
| Curator pass per project over its role scopes, the role-wide scopes, the project and the machine; launched as role `curator` from the seat tick | Shipped | `src/lib/memory/curation/store.ts:153-170`, `:207-211`; `src/lib/memory/curation/run.ts:31` |
| Curator checklist: task, current, readers, level, duplicates, contradictions, integration before budget; 16 000-byte four-scope target as text | Shipped | `curation/brief.ts:7-13`, `:21-23` |
| Search of rules: active rules only | Shipped; archives unsearchable | `src/lib/memory/roleSearch.ts:6`, `src/lib/memory/roleViewSource.ts:366-369` |
| Rule text withheld from everything that leaves the machine; every rule and why in the publication gate's known values | Shipped | `roleStore.ts:780`, `:794-806` |
| Swarm scope: public pack shipped with releases, 4 000 code points per role, 36 000 per pack, opt-in switch; the pack is empty | Shipped, slice 1 | `src/lib/memory/swarmPack.ts:9-11`, `src/lib/memory/swarmRules.json`, `src/lib/memory/settings.ts:12-15` |
| Swarm slices 2 to 4 (anonymous counts, weekly proposals, upload decision) | Open, unstarted | task 48d60ffc steps s2 to s4 |
| Learned rules window and its routes | Shipped, owner-only | `src/components/roleMemory/LearnedRules.tsx:40`, `:174`; `src/lib/team/workspaceRoutes.ts:133-135` (`/api/role-memory*` → `owner`) |
| Any notion of a member in memory | Missing: a lesson's source names the conversation, stage and role (`roleTypes.ts:56-77`), never a member; no member or workspace scope kind (`roleTypes.ts:34`) | §3 |

What the measurements of 2026-10-21 showed still frames the problem: scopes
sat at 93 to 100 % of the bound, a quarter of a week's lessons left for budget,
and a builder start carried about 23 KB whole (layers design §1.2 to §1.4).
Since then #3340 stopped eviction while a curator is available, so the loss
moved from the write path to the curator's budget archive, which is reversible
and which the curator is told to restore when it fits (`brief.ts:13`).

### 1.2 Workspaces

| Piece | State | Evidence |
| --- | --- | --- |
| Record: `workspaces`, `workspace_members` (manager or member), `workspace_projects` (a project in at most one workspace) | Shipped, slice (a) #3133 | `src/lib/team/store.ts:356-378`, `:692-756` |
| Owner's workspace page, rail switcher and «Move to…», Unassigned group | Shipped, slice (a) | `src/components/team/WorkspaceSwitch.tsx:16-20`, `src/components/team/TeamPage.tsx:13-20` |
| Per-request scope: owner sees all; manager sees own workspaces plus Unassigned; member sees own workspaces; `access`, `canAct`, `canReadFile` | Shipped, slice (b) #3255 | `src/lib/team/workspaceAccess.ts:10-58` |
| One decision per API route (`owner`, `project`, `collection`, `team`, `capability`); unknown routes are owner-only; `/api/files` and runtime streams projected to the member's projects | Shipped, slice (b) | `src/lib/team/workspaceRoutes.ts:2`, `:250-258`; `src/lib/team/workspaceProjection.ts:9-25`; `src/lib/team/workspaceFilesResponse.ts` |
| Spawn, preflight and pipeline creation resolve `cwd` to its project the way their consumers do and require authority for every resulting project | Shipped, slice (b) | #3255 commit message; `src/app/api/spawn/route.ts:1-25` |
| Invite into a workspace; a removed manager cannot enroll | Shipped, slice (b) | `workspaceAccess.ts:60-72` |
| Delegatus's own browser-check member placed in the seat's workspace | Shipped (#3546) | `src/lib/mcp/server.ts:3941` |
| MCP fence: a closed list of project tools; installation-wide tools refused for a member-bound caller; every supplied identity resolved to a project before receipts; collections default to the caller's project; transcript search drops the unscoped fallback and installation-wide counts; `leave_lesson` with `machine` or `rewrite` refused for member-bound callers | Open: PR #3415 at `4e0bd2688` | PR file `src/lib/mcp/workspaceFence.ts` (tool list, conversation and task key sets, `assertResult`) |
| Member authority persisted on the launch profile (`workspace: { memberId, workspaceId }`), carried through pipelines, seats, resumes and migrations; older conversations fall back to their latest recorded author | Open: PR #3415 | PR file `src/lib/team/workspacePrincipal.ts`; PR's `docs/design/workspaces.md` §14 |
| Per-workspace defaults: account pools per engine, report chat with topic, directive chats; inherited at the existing resolvers, never copied into project settings; a manager cannot pick another workspace's chat or the owner's private chat | Open: PR #3415 | PR file `src/lib/team/workspaceDefaults.ts` |
| Checks on #3415's head | Red: `typecheck`, `build`, `bun-runtime` and `runtime-gate` failed at `4e0bd2688`; privacy, scope, native Codex and macOS checks passed; the last fix was not re-reviewed (review budget spent); the refresh lane's review passed on 2026-11-03 02:29 UTC and main has moved since | `gh pr view 3415`, task 7e042e15 summary |
| Slice (d): per-workspace systemd slice, usage grouped by workspace, per-workspace worker share | Missing. Today one transient scope per agent in `delegatus-agents.slice`; worker limits are per machine and per project; Activity filters a member's rows by workspace projects and groups nothing | `src/lib/runtime/agentMemory.ts:84-89`, `src/lib/runtime/cpuPlacement.ts:24`; `src/lib/operator/workerLimit.ts:37-56`; `src/lib/activity/report.ts:134`, `:282` |
| A member's own default engine and account | Missing: the default account is per engine per installation (`activeClaudeAccountId`, `claudeAccountForSpawn`); a spawn names an account or gets the default; #3415 narrows the pool per workspace. No member preference exists anywhere | `src/lib/accounts/claude.ts:353`, `:363`; `src/lib/agent/spawnCommand.ts:463-465`, `:945-957` |
| A member adding their own subscription login | Missing by decision of slice (b): every `/api/accounts/*` route is owner-only | `workspaceRoutes.ts:7-24` |
| Per-member interface language and time zone | Deferred since sign-in design §14; still one setting per installation | `src/lib/operator/settings.ts:42-57` |
| Report destination per project; topic links to a chat a paired bot posts in | Shipped; #3602 open at reading time for the paired-clone chat case | `src/lib/projects/settings.ts:320-367`; PR #3602 |
| Which paired clone posts a project's reports | Designed 2026-11-02, unbuilt | `docs/design/per-project-relay-clone.md` §5.1 |
| Owner's private conversations reachable by members | Partly closed by slice (b) routes and #3415's fence; the remaining paths are listed in §4.5 | §4.5 |

## 2. Memory: keep all of it, use all of it

### 2.1 What "keep all" has to mean here

The 2026-10-02 rule stands: nothing is deleted for disuse; at most it ranks
lower. Today the store already keeps every text (§1.1, first row). What is
lost is reach, in three places:

1. A budget archive leaves the delivered block and the selection pool. The
   curator may restore it, but only the curator reads it; no launch can.
2. An archived rule leaves search: `search_memory` and the rules window's
   search read active rows only (`roleViewSource.ts:366-369`).
3. A merge keeps the surviving text and archives the sources as `merged`;
   the conditions the curator folded in survive only in the survivor's words.

"Keep all memory" therefore means: every stored rule that is still true stays
a candidate for delivery and a hit for search, whatever its budget state. The
mechanism:

- **Two retention classes per scope, one store.** A scope's active list stays
  what it is (within its target). A rule the curator archives for `budget`
  enters the scope's **reserve**: the same row, `state: "archived"`,
  `reason: "budget"`, no new table. Reserve rows stay candidates for
  selection (§2.3) and hits for search (`activeRoleRuleRows` gains a
  `states` filter defaulting to active plus budget, with the state on each
  hit). Reserve rows are never delivered whole: only the selector, with a
  brief, can bring one into a block.
- **Every other archive reason stays out of delivery**: task-specific, stale,
  in-code, in-instructions, no-reader, contradicted, duplicate, problem,
  deleted (`roleTypes.ts:37-38`). Those are judgements that the text should
  not reach an agent; `budget` is the one reason that says only "no room".
  Search gains `states: ["archived"]` for the operator to find them, as the
  window's departed list does today.
- **Budget archives stay bounded by the hard maximum per launch (§2.3), so
  their count needs no cap for cost.** Their count needs a bound for the
  selector's pool: the existing 120 000-code-point pool ceiling
  (`roleSelect.ts:125`, reason `jev-pool`) stays and names the whole pool,
  active and reserve. Beyond it the oldest reserve rows by last application
  are left out of the pool for that launch, and the row records `pool-cut`.
  At the 2026-10-21 counts (437 active, 185 budget archives, mean 252 code
  points) the whole machine held about 170 000 code points across all
  scopes; one reader's four scopes held far less, under 40 000.

What the curator does with the reserve is unchanged (check 7): integrate,
restore when it fits, archive the least valuable. The only new instruction
is that a budget archive is a demotion to reserve and must say what the
reserve row still covers.

### 2.2 The bounds, reconciled

Three numbers exist now: the shipped 10 000 per scope, the interim 15 000 the
seat chose on 2026-11-03 (lane 4dee5653), and the 2026-10-22 targets 20 000 /
30 000 / 15 000 / 15 000, decided "together with selected delivery". The
10:55 UTC update makes selected delivery imminent (lane d75de2eb). The
reconciliation:

| Step | Role here | Role on every project | Project | Machine | Member (§3) | Workspace (§3) | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Today | 10 000 | 10 000 | 10 000 | 10 000 | – | – | – |
| Interim (lane 4dee5653) | 15 000 | 15 000 | 15 000 | 15 000 | – | – | Merges on its own; raises `ROLE_MEMORY_BOUND` for every scope kind |
| Decided targets (slice M3 below) | 20 000 | 30 000 | 15 000 | 15 000 | 10 000 | 15 000 | After the hard maximum is enforced on every delivery path, so a larger store cannot grow a start |

The interim value fits because it changes one constant and no path depends on
the constant being per kind. Slice M3 replaces the constant with a per-kind
target map (`roleTypes.ts:11` becomes `ROLE_MEMORY_TARGETS[kind]`) and the
curator brief's "well below 10 000" and "16 000 bytes" texts with the layer
guidance (`brief.ts:13`, `:21-23`). The 24 000-byte hard maximum is the
condition: it must be enforced in `renderLearnedRulesSelection` on the
delivered path before targets rise, because today the delivered whole block is
cut only at 120 000 bytes (`roleLaunch.ts:19`), and four scopes at the targets
could deliver about 60 KB whole. Lane d75de2eb's BM25 fallback and the
`whole` row of the selection table (layers design §5.1) both need the same
24 000-byte cut; if that lane ships without it, slice M1 adds it first.

### 2.3 Use all of it: selection per launch under 24 000 bytes

The delivery policy of the layers design §5.1 stands, with Decisions in the
seat Jev had:

- **Candidates**: the active rules of every scope the reader has (§3 adds the
  member and workspace scopes) plus their reserve rows, minus the always-on
  set, within the 120 000-code-point pool ceiling.
- **Always-on** (reserved first, never cut): rules the operator kept, and,
  once layers exist, the principles of the role's every-project scope, of the
  machine and of the reader's workspace, in curator rank order, while their
  lines stay within 3 000 code points.
- **Selected**: Decisions scores each candidate with one predicate question
  per rule, batches of 32, the brief as state, the rubric the provider adapter
  already carries (`roleSelectionProvider.ts:72-79`); rules at or above the
  evaluated threshold are packed by score to 9 000 code points of lines and
  24 000 bytes of block. The threshold and the prompt come from lane
  d75de2eb's offline evaluation, not from this document.
- **Fallback**: any provider failure, missing key, shape error, timeout or
  spent cap packs the BM25 order instead (today's `result(reason)` rows,
  `roleSelect.ts:124`); a selector exception delivers the `whole` row cut to
  24 000 bytes. Reserve rows take part in the BM25 fallback too.
- **Frozen per attempt**, operator deletion the one permitted change, as
  built (`roleSelection.ts:72-95`).
- **Rendering**: principles first with their delivered children indented under
  them; a child whose parent was not delivered renders alone; a reserve row
  renders like any other line (its state is on the ledger row, not in the
  text).

**What a full pool costs.** The Decisions client bills input tokens at the
rates in `decisions.ts:30-33`; the local ceiling per request is the body's
bytes plus 4 096 at the cache-write rate (`decisions.ts:20-22`). At the
decided targets a builder's pool is about 80 000 code points of rules (layers
design §4.2), about 20 000 tokens, sent in about 10 batches that each repeat
the brief (up to 13 000 characters, about 3 300 tokens). Uncached that is
about 53 000 input tokens, about $0.005 per launch at the $0.10 per million
rate; with the brief served from cache after the first batch, about $0.002.
At the 2026-10-21 volume of about 1 540 starts with rules a week, that is
roughly $3 to $8 a week, $13 to $35 a month. These are estimates from the
price constants and the measured pool and start counts; no live call was
made. The feature cap is $5 a month (`src/lib/memory/roleSelectionSpend.ts:5`,
decision 6 of 2026-10-22, set for shadow Jev). At the full pool it would be
spent within the first week, after which every launch would take the BM25
fallback, which the operator does not want as the normal path. Q1 asks the
operator to raise the cap or to bound the pool.

**Cost control that keeps Decisions the selector.** Two bounded measures,
both in the adapter, neither a pre-selection: (1) the brief is sent once per
launch as the shared state and the per-rule questions reference it, which is
what the request shape already does; (2) a per-launch ceiling (the sum of the
batch ceilings) above which the launch takes the `pool-cut` of §2.1 down to
the ceiling, oldest reserve rows first. BM25 scores are never mixed into a
Decisions pack.

### 2.4 Graph or layers

The operator asks whether memory should consolidate "as a graph, so that it
gathers". The 2026-10-22 decision is a layer field and a parent link (L3 of
the layers design §3). What the store already holds, and what a graph would
add:

| Edge | Exists today | Field | Used by |
| --- | --- | --- | --- |
| merged into / merged from | yes | `mergedInto`, `mergedFrom` (`roleTypes.ts:129`, `:147`) | task counting, import undo |
| split from / split children | yes | `splitFrom`, `splitChildren` (`:149-151`) | import undo, request attribution |
| moved from | yes | `movedFrom` (`:148`) | history |
| earlier text | yes | `versions`, `versionOf` (`:139-140`) | frozen-block resolution, revert |
| contradicts / duplicates | yes | `against` (`:146`) with reason `contradicted` or `duplicate` | curator apply check |
| serves a principle (derived from) | no | `parent` (decided) | rendering, always-on, budget order |
| layer | no | `layer` (decided) | always-on, curator checks |

So the store is already a graph of lineage; what it lacks is the one upward
edge that says "this specific serves that principle". Options:

| Option | What it adds | For | Against |
| --- | --- | --- | --- |
| G0. Layer plus parent, as decided | `layer`, `parent`; the existing lineage edges shown as a family in the curator read and the window | One field and one link; rendering stays a tree; the curator's "derive a more abstract rule" (check 7) gets a place to put the result without losing the children | A child has one parent; a specific that serves two principles is linked to one and the other is found by search |
| G1. Typed multi-edge graph | A separate `role_memory_edges` collection: `{ from, to, kind: supports \| derived-from \| contradicts \| supersedes \| same-class, by, at }`, any fan-in and fan-out, graph queries at selection time (bring a rule's neighbours when it is selected) | Expresses every relation the curator reasons about; could drive "expand the selection along edges" | A second collection with its own consistency on merge, split, move and archive (today each of those rewrites fields on the rule row in one transaction); graph expansion at launch adds rules the brief did not ask for, which is what the 2026-10-02 study found unhelpful ("graph gating lost its useful offer", layers design Deferred); nothing in the requirement needs more than "gathers upward" |
| G2. Replace scopes by a graph | Scopes become edges from rules to readers | Theoretical uniformity | Every reader, bound, curator pass and privacy path is keyed by scope today; a rewrite of the store for no asked-for behaviour |

**Recommendation: G0, with the lineage view.** The requirement's verb is
"gathers": practices gather under principles, principles gather into prompts
(layers design §3.4). A tree does that; a general graph adds machinery the
problem does not need (rule 9). The one thing taken from the graph idea is to
stop hiding the lineage the store already has: the curator read and the rules
window show a rule's family (its parent, its children, what it was merged from
or split from, what it contradicts), so consolidation stays visible and
reversible, and nothing is compressed away.

**Data model (slice M2).** On `RoleMemoryRule`, two optional fields, schema
version unchanged:

```
layer?:  "principle" | "practice" | "specific"   // absent = practice
parent?: string                                   // id of an active principle every reader of this scope also reads
```

Server checks on `curate_rules` apply (`curation/apply.ts`): a `parent` must
name an active rule with `layer: "principle"` in a scope that every reader of
the child's scope reads (role-here child → parent in role-here, role on every
project or machine; project child → project or machine; member child → member,
workspace or any installation scope; workspace child → workspace or
installation); a principle has no `parent`, fits 200 code points and names no
tool, product, file or project term by the curator's own judgement (no
detector refuses it, per the operator's rule that detectors hint and agents
judge). Merge stays within one layer (`CURATE_NARROWS` already refuses a
merge that loses reach; a new `CURATE_LAYER` refuses one that crosses layers).
A split may give parts different layers. Archiving a principle re-parents
its children to its own parent or clears them in the same call; the apply
refuses a call that leaves a dangling `parent`. Undo restores `layer` and
`parent` with the other prior fields.

**Curator algorithm (the Layer check, between Level and Duplicates):**

1. Label every unlabelled active rule and reserve row: a rule naming a
   project's file, command, gate budget or tool version is `specific`; a
   rule with a trigger and a check is `practice`; a one-sentence rule under
   200 code points naming no tool, product or project is `principle`.
2. For each role, read the role-here practices of every project in the pass
   (the pass already reads other projects' same-role rules as evidence for
   widening, `brief.ts:10`). When two or more practices in two or more
   projects, or from two or more members (§3), state one class, write the
   principle in the widest scope all their readers share (role on every
   project, or the workspace, or machine), link each practice's `parent` to
   it, and leave the practices in place. Nothing is compressed into the
   principle; the principle adds a line, the children keep theirs.
3. A specific's `parent` is the practice it instantiates, when one exists in
   a scope its readers share; otherwise none.
4. Budget order within a scope (check 7, refined): specifics with the fewest
   tasks and applications first, then practices whose principle is active
   (the class survives in the principle), then practices without a parent;
   principles leave for budget last, and a principle that is the parent of
   any delivered-in-the-last-30-days child never leaves for budget.
5. The curator's final message lists new principles by id with their
   children's count, as today it lists promotion candidates.

Existing rules get a layer in the first pass after deploy, as the layers
design §7.1 planned; until then every rule is a practice (selectable, never
always-on).

### 2.5 Where the interim 15 000 fits

The interim raise is the first step of decision 4 and needs no reversal: slice
M3 keeps 15 000 for project, machine and workspace, raises role here to
20 000 and role on every project to 30 000, and sets member at 10 000. The
interim lane also forbids compression and asks the curator to rewrite
compressed rules; §2.4's rule that consolidation adds a principle and keeps
the children is the structural form of that instruction, and the curator
brief gets both in one edit when M2 lands after 4dee5653.

### 2.6 Validation of the memory part against the words

| Asked (2026-11-03) | Where |
| --- | --- |
| Raise the character limits | §2.2 interim and targets, under the hard maximum |
| Keep all memory | §2.1 reserve class: budget archives stay searchable and selectable; nothing new is deleted |
| Use all memory | §2.3 selection over active and reserve rows, all scopes, per launch, within 24 000 bytes |
| Consolidate, perhaps as a graph | §2.4 G0 with the lineage view; principles gather practices without compressing them |
| Decisions selects, evaluated offline, no shadow; BM25 on failure (10:55 update) | §2.3; the evaluation and prompt belong to lane d75de2eb |

## 3. Team memory: per-member rules into team and company rules

### 3.1 What a member's rules are

Today a lesson is written by a stage, a seat or the operator's root
conversation, into role, project or machine (`roleStore.ts:355-359`). In a
team installation three new facts matter:

1. A conversation can have a **member principal**: PR #3415 records
   `LaunchProfile.workspace = { memberId, workspaceId }` at a team launch and
   resolves older conversations through their latest admitted author
   (`workspacePrincipal.ts`). So every lesson written from such a
   conversation can name the member whose agents learned it.
2. A **correction** by a member (a message that says "do it this way") is
   today written as a project or machine rule read by everyone
   (`leaveOperatorLessons`, `roleStore.ts:345-348`; the seat's
   `correction:true` path). In a team, one member's preference must not
   become every member's rule without review; and #3415 already refuses
   `machine` lessons from member-bound callers.
3. The operator's words put the curator between members and the company:
   member rules are the raw material, company rules the curated result.

Two scope kinds are added (`roleTypes.ts:34`, `roleScopes.ts:13-15`):

| Scope | Key | Who reads | Who writes | Target |
| --- | --- | --- | --- | --- |
| Member | `member:<memberId>` | every conversation whose principal is that member, in any role and any project of their workspaces; the designated seat reads it while it answers that member's message (§3.3) | lessons and corrections from that member's conversations; the curator | 10 000 code points |
| Workspace | `workspace:<workspaceId>` | every conversation whose project is in the workspace, installation seats of those projects included | the curator only, by promotion from member and role-here rules; the owner or a manager in the window | 15 000 code points |

The installation-wide scopes (`role:*:<role>`, `machine`) are the company
scopes: in a team installation the installation is the company. Nothing new
is needed for "company-wide" beyond the promotion step (§3.2).

**Where a member's lesson lands.** `leave_lesson` keeps its three levels for
agents. For a member-bound conversation the server resolves them as:

| Agent asked for | Operator-launched conversation (today) | Member-bound conversation |
| --- | --- | --- |
| `role` | `role:<project>:<role>` | `role:<project>:<role>` (the role's work is the workspace's), with `source.member` recorded |
| `project` | `project:<project>` | `project:<project>`, with `source.member`; the project belongs to one workspace, so its readers are that workspace's agents and the installation's seats |
| `machine` | `machine` | refused (#3415) |
| `correction: true` from a seat or root conversation | `project` or `machine` | `member:<memberId>` |

`StageRuleSource` and `SeatRuleSource` gain
`member?: { memberId: string; workspaceId: string | null }` (`roleTypes.ts:56-77`),
filled from the launch profile's principal at write time and never rendered.
It is provenance for the curator and the window; a rule's text stays what the
agent wrote.

**Privacy between members.** A member scope is delivered only to that member's
conversations, and the rules window shows it only to that member and the
owner (§3.4). A role-here or project rule a member's agent wrote is read by
every agent working in that project, which is the workspace's shared work; its
`source.member` is shown to managers and the owner in the window and never
rendered into a block. A rule's `why` stays on the record as today.

### 3.2 How the curator synthesizes upward

The ladder, each step the same operation (write a rule in the wider scope,
link the sources as children with `parent`, keep the sources):

```
member:<m>  ──┐
member:<m2> ──┼──►  workspace:<w>  ──►  role:*:<role> / machine  ──►  swarm pack (public, release)
role:<p>:<r> ─┘        (team)              (company)                 (every installation)
```

Promotion criteria, applied by the curator in the pass that reads the scopes
(the pass for a project already reads its role scopes, the role-wide scopes,
the project and the machine, `curation/store.ts:153-170`; it gains the
workspace scope of the project's workspace and the member scopes of that
workspace's members):

| From | To | Criterion | Who approves |
| --- | --- | --- | --- |
| Two or more member scopes in one workspace | `workspace:<w>` | The rules state one class and each has `applied` on at least one request, or they are corrections from two or more members saying the same | The curator writes it (as it widens role rules to `role:*` today, decision 1 of 2026-10-22); the window shows it to the managers with its sources |
| Role-here rules of two or more projects in one workspace | `workspace:<w>` | Same class, every role in the workspace acts on it (check 4's test for the project level, applied to the workspace) | The curator |
| `workspace:<w>` rules of two or more workspaces, or a workspace rule backed by two or more tasks in two or more projects | `role:*:<role>` or `machine` | Same class in two workspaces, or one workspace's rule that names no workspace, project or member term and has `applied` from two or more tasks | The curator proposes; the **owner approves** in the window with one action (the row is written in the wider scope as `state: "proposed"` and delivered to nobody until approved). Q4 asks whether this gate is wanted |
| Installation role rules | swarm pack | As the swarm design §3.1 item 7 | The maintainers' pack pass and the operator's pull request approval (unchanged) |

Why the approval sits at the workspace-to-company step and nowhere lower: a
member's rule reaching their own workspace is read by people who already share
that work; a rule crossing into another workspace's agents is the one step
where text written for one team reaches another, and the only place where a
project or member term could leak between teams. Inside one installation the
curator already widens role rules to every project without approval, so the
gate is new only for team installations; on a solo installation (no team
store) there are no member or workspace scopes and nothing changes.

**Provenance.** A promoted rule carries `derivedFrom: string[]` (the source
ids at promotion) in addition to its children's `parent` links, and `source:
{ origin: "curator", pass }` as curator-written rules do today. Sources keep
their text and their member provenance. The window's family view (§2.4) shows
the chain. Nothing about a member is rendered into any block.

**Demotion and contradiction.** A workspace rule one member's correction
contradicts does not change for the others: the member's correction lives in
their member scope, and the curator records `against` on it with reason
`contradicted` only when it decides the workspace rule is wrong for everyone.
A member scope rule always wins the render order inside that member's
conversations (member scope renders first, before the role scopes), so the
member's preference governs their agents without touching the team's rule.

**Relation to swarm.** The swarm design's slice 1 is the top rung of the same
ladder and is built; its slices 2 to 4 (counts up, weekly proposals, upload
decision) are untouched by this design. One consequence for the pack pass: a
candidate must come from an installation scope, never from a workspace or
member scope, which the pack's existing eligibility (role-wide rules with
`applied` marks) already implies.

### 3.3 Delivery to seats and pipelines

- A **pipeline stage** launched by a member reads: `member:<m>`, its role
  here, its role on every project, `workspace:<w>`, the project, the machine,
  the swarm scope when on. Render order puts the member scope first.
- A **designated seat** is installation-owned (PR #3415 keeps seats without a
  member binding at installation reach). It reads its role scopes, the
  workspace scope of its project, the project and the machine at start. When
  it answers a member's message it does not re-render its block (the block is
  frozen per start), so member preferences reach the seat through the
  workspace scope once promoted. A per-message member overlay is deferred
  (§8).
- An **owner** conversation (member with role `owner`) has no principal
  (`workspacePrincipal.ts` returns null for an active owner) and reads what
  it reads today; the owner's corrections keep landing in project or machine.

### 3.4 What the rules window shows a member

The window and its routes are owner-only today (`workspaceRoutes.ts:133-135`).
They move to the `project` decision with a filtered view: a member sees, for a
project they can act in, the role scopes of that project, the project scope,
their own member scope and the workspace scope; the installation scopes are
shown read-only because their agents receive them; other members' member
scopes are absent, and a manager additionally sees `source.member` on the
workspace scope's rows. Keep, return and delete stay owner actions; a manager
may keep or return rows of their workspace scope. The curator's proposed
installation rules (§3.2) appear to the owner in the installation column with
an approve action.

## 4. Workspaces: what is left to give each member their own fenced seat

### 4.1 The boundary at each layer

"Exists" means on `main` at `ead78b894`; "(c)" means in PR #3415.

| Layer | Boundary today | Gap | Closes in |
| --- | --- | --- | --- |
| Sign-in | A member session cookie; the perimeter admits a session or the operator's key; no key is handed to a teammate (`src/lib/team/gate.ts:107-120`; sign-in design A13) | None for this requirement | – |
| UI | The rail, the phone sheet, the Team page and `/api/files` are projected to the member's workspaces (`workspaceProjection.ts:9-25`); the owner's view groups everything with «All» on top | The Learned rules window and several owner-only panels are hidden from a member outright, with no filtered view (§3.4); no per-member default engine or account (§4.3) | W4, W5 |
| HTTP routes | Every route has a decision; `project` routes resolve the project of every identity in the request (cwd, conversation, task, pipeline) and ask `workspaceScope.access`; collections are filtered; unknown routes are owner-only (`workspaceRoutes.ts:2`, `:250-258`) | Memory routes owner-only (§3.4); account routes owner-only by design (§4.3) | W4, W5 |
| MCP (agents) | On main: tools take `project` as a free argument; only fleet reads and the task-to-cwd check are fenced (`server.ts:3877`, `src/lib/agent/spawnAdmission.ts`). In (c): a member-bound caller is confined to a closed list of project tools, every identity resolved, results checked before compaction, installation-wide tools refused | Owner-launched workers and installation seats in a shared project keep installation reach, including the owner-private tools and conversations of §4.5 | W1 (land (c)), W6 |
| Filesystem | HTTP and MCP resolve `cwd` to a project and refuse foreign ones (#3255, (c)); the files route answers only the member's projects | The agent's shell runs as the installation's OS user and can read any checkout, any account home, any state file (level 2's stated limit, workspaces design §6) | Level 4 only (§8) |
| Process and systemd | One transient scope per agent in `delegatus-agents.slice` with a memory cap (`agentMemory.ts:84-89`); CPU placement per host (`cpuPlacement.ts:24`); worker limit per machine and per project | No per-workspace slice, no per-workspace worker share, no usage grouped by workspace | W2, W3 |
| Accounts | Installation pool; per-project bindings restrict a project's work to listed accounts (`src/lib/accounts/projectBindings.ts:439`); (c) adds per-workspace pools inherited by the resolvers and refuses a named account outside the pool | A member cannot set a default engine or account for their own launches; a member cannot add a login (owner-only routes) | W5; Q5 |
| Telegram | One bot; a project's report chat and name per project; (c) adds per-workspace report and directive chats with the reservation that keeps another workspace's chat and the owner's private chat out of a manager's reach | A paired clone as a project's poster is designed (per-project-relay-clone §5.1) and unbuilt; §4.4 | W7 |
| Relay | One pairing, one owner identity per installation; owner tier, owner history and service tools are owner-only HTTP routes and agent tools gated by switches and by "only inside an owner run" | Agent tools reachable by owner-launched workers; owner-run transcripts readable as conversations; §4.5 | W6 |
| Memory | Scopes per role, project and machine; nothing per member or workspace | §3 | M4 |

### 4.2 Land slice (c): what PR #3415 needs

The PR's product content matches the 2026-10-20 decisions and §14 of the
workspaces document records its contract. What stands between it and main:
four red checks at `4e0bd2688` (`typecheck`, `build`, `bun-runtime`,
`runtime-gate`), a last fix that the review budget did not cover, and a base
that moved after the refresh lane's review of 2026-11-03 02:29 UTC. The next
step is the refresh lane's own: merge current main by merge commit, repair
the branch-only failures per the hook's selection run on branch and main
(the touched-test comparison of `CONTRIBUTING.md`), and one resolution
review. Nothing in this design changes (c)'s scope. One note for the
resolution reviewer: the fence's `leave_lesson` rule (member-bound callers
refused for `machine` and `rewrite`) is what §3.1 builds on; it must survive
the merge.

### 4.3 A member chooses a Claude or Codex subscription

What exists: a spawn names an engine, and an account or the engine's
installation default (`spawnCommand.ts:463-465`, `claude.ts:353`); (c) makes
the per-workspace pool the admission for a member's launch and refuses a named
account outside it. What the words add: the member's own choice, made once,
not per launch.

**Member preferences (slice W5).** In `team.sqlite`, beside `members`:

```
member_preferences  member_id PK, default_engine ('claude' | 'codex' | null),
                    default_account_claude TEXT NULL, default_account_codex TEXT NULL,
                    updated_at
```

- Read at every launch admission after the workspace pool: the launch's
  engine is the request's, else the member's default, else the installation's
  default; the account is the request's, else the member's default for that
  engine if it is in the workspace pool, else the pool's first allowed
  account, else the installation default when the pool is unrestricted. A
  default that fell out of the pool is ignored and the launch records
  `preference-not-allowed` in its attribution journal (the existing
  "attribution, not a gate" rule of #1279 at `spawnCommand.ts:1182-1190`).
- Written by the member on `GET`/`PUT /api/team/me/preferences` (decision
  `team`), shown in the engine chip (`src/components/EngineAccountSwitch.tsx`)
  as "your default" with the pool's accounts as the choices.
- The seat and pipeline stages the member launches inherit the member's
  engine default where the stage's preset leaves the engine open; a preset's
  pinned engine wins.

**A member's own login.** The operator says each person "chooses a Claude or
Codex subscription". Two readings: choose among the installation's accounts
(the pool), or bring their own. Bringing their own means a CLI login into an
account home that every agent on the machine can read (sign-in design, "below
the OS a member equals the operator"). Recommendation (Q5): members choose
among the pool; the owner adds accounts and marks which workspaces may use
them, as (c) already provides. If the operator wants members to add logins,
W5 adds a manager-level `POST /api/accounts/<engine>` that creates a managed
home tagged `ownerMemberId`, defaults it into that member's workspace pools,
and shows the level-2 caveat in the dialog.

### 4.4 Report destination through a paired clone

The 2026-11-02 design's Part 1 is the answer: `reportTelegram.poster` names
the clone, set through `seat_tick_settings.reportPoster` by the operator root
or the project's designated seat, resolved by the server from the reporting
seat's own project, with `clone_not_in_report_chat` and the other refusals
(per-project-relay-clone §5.1). #3602 makes a topic link into a chat a paired
clone posts in saveable. What this design adds for workspaces:

- A manager's report-chat choice is already fenced by (c)
  (`assertProjectReportDestination` in `workspaceDefaults.ts`): the chat must
  be one the bot catalog knows, and never another workspace's or the owner's
  private chat. The poster inherits that fence: a clone may be chosen only
  when the clone directory lists the project's chosen chat under it, which
  Part 1's `clone_not_in_report_chat` already requires, so no new check.
- Workspace defaults gain no poster field. The clone belongs to the report
  chat, and the report chat is per workspace default or per project override;
  a project's poster follows its own chat.

### 4.5 Members and the owner's private conversations: the paths to close

The audit lane had not run at reading time, so this table is from the code.
"Member-bound caller" is a conversation with a member principal under (c).
"Owner-launched worker" is an agent the owner spawned, or an installation seat,
in a project that a workspace also holds; such a caller keeps installation
reach under (c).

| # | Path | What it returns | Who can reach it on main | After (c) | Remaining gap and the close |
| --- | --- | --- | --- | --- | --- |
| P1 | MCP `relay_owner_history` | The operator's Telegram groups where Celestia or a clone is present and their messages; author ids excluded; the owner-tools switch defaults off (`server.ts:3984-3987`; `src/lib/externalRelay/ownerHistory.ts:12`) | Any agent while the switch is on (`bindings.ts:5618-5623` refuses only live relay answerers) | Refused for member-bound callers (not in the project tool list) | Owner-launched workers and seats in shared projects. Close: the tool admits only the operator root conversation and installation seats of projects in no workspace (W6) |
| P2 | MCP `relay_service_tools`, `relay_answer` | Celestia's chat service tools for the message being answered | Only inside a live owner run (`server.ts:3983`; relay-owner-tier §2.4) | Same | None beyond P3 |
| P3 | Owner-run conversations as transcripts | An owner run is an ordinary root conversation whose prompt carries the owner's message from the private chat with the clone (`ownerRun.ts:896-901`); its cwd is the target's project directory or the home folder (`:897`), so it groups under that project | `conversation_messages`, `search_transcripts`, `get_conversation` for any agent | Member-bound callers may read it when its project is in their workspace (the fence checks the project, `workspaceFence.ts` conversation keys) | Close: conversations get an `audience` on the registry record, `owner-private` for owner runs, the owner's root conversations and voice sessions; member-bound callers are refused those regardless of project, and collection answers drop them (W6) |
| P4 | The owner's own root conversations with a project seat, and the seat's conversation | The seat's conversation is the workspace's shared record (who-did-what is a design goal); the owner's root conversations in a shared project are the owner's | Any agent | A member's agent in that workspace can read both | The seat conversation stays shared (it is the team's board chat). The owner's root conversations are `owner-private` (P3's close). A one-action "make this conversation private" on the owner's conversations is deferred (§8) |
| P5 | MCP `telegram_bot_messages`, `telegram_bot_chats` | Messages the installation's bot received in any chat it knows; "reading is not limited to allowlisted chats" (`server.ts:3988-3990`), so the owner's private chat with the bot is readable | Any agent | Refused for member-bound callers (not in the list) | Owner-launched workers and seats in shared projects. Close: the tool admits a project-bound caller only for chats bound to its project or workspace (the report chat and the directive chats), never a private chat; the operator root keeps today's reach (W6) |
| P6 | HTTP routes for the relay, the bot and owner history | `/api/external-relay/*`, `/api/telegram/bot*` are owner-only (`workspaceRoutes.ts:48-60`, `:214-217`) | Owner only | Same | None |
| P7 | The filesystem: the relay store (`external-relay/runs.json` keeps the owner turn's raw request, `src/lib/externalRelay/store.ts:107`), the bot store's `messages` table (`src/lib/telegram/bot/store.ts:269-283`), `team.sqlite`, account homes with transcripts; files are mode 0600 but owned by the one OS user every agent runs as | Everything above, raw | Any agent's shell | Same | Level 2 cannot close this (workspaces design §6, level 2 "does not protect"). Only level 4 (an OS user per workspace) does. Q7 |
| P8 | The operator's personal Telegram MCP server configured for local sessions on this machine (named in task 5f5c4555) | The operator's own account | Any agent's shell that starts it | Same | Outside Delegatus; removing it from shared sessions or level 4 |
| P9 | Celestia's API through the pairing credential in state | H1–H3 are group history where the owner is a member and a bot or clone is present (relay-owner-group-history §1); whether any other endpoint of the pairing exposes the owner's private chats is what the audit must answer; this reading could not confirm it | Any agent's shell, with the credential from P7 | Same | Depends on P7 and on the audit's answer |

What the owner should hear from this table: inside the Viewer and the MCP,
(c) plus W6 close every path to the owner's private chats and conversations
for members and their agents. What stays open is the shell of any agent on
the machine, which can read state files and credentials because every agent
is the same OS user. That is the level-2 limit the operator chose on
2026-10-20 with the words "as now, or better". "Better" at the shell is level
4 (Q7).

### 4.6 Threats considered, and where each is refused

| Threat | Refused by |
| --- | --- |
| A member names a foreign project, task, pipeline, conversation, cwd or selected card in a request or a tool argument | Human routes: `workspaceRoute` resolves each to its project (#3255). MCP: the fence's identity resolution and `assertResult` before compaction ((c)) |
| A member's agent calls an installation tool (deploy, accounts, bot, relay, owner history) | Refused: not in the project tool list ((c)) |
| A member's agent writes a `machine` rule or rewrites an installation rule | Refused ((c) fence); member corrections land in the member scope (§3.1) |
| A member's correction becomes every team's rule | The curator promotes only on the criteria of §3.2, and the company step waits for the owner (Q4) |
| A manager routes reports to another workspace's chat or to the owner's private chat | `assertReportDestination` ((c)) |
| A member's launch names an account outside the workspace pool | Refused at admission ((c)); a stale member default is ignored and journaled (W5) |
| A revoked member's old conversation keeps its reach | The principal survives revocation and loses authority (`workspacePrincipal.ts`); streams end with the session (sign-in A24) |
| A member reads the owner's relay or root conversations through a shared project | `owner-private` audience (W6) |
| A shortened foreign project key collides with an allowed one | Full identities checked before display compaction ((c)) |
| A member's agent reads another workspace's checkout or the state files from its shell | Not refused at level 2; level 4 only |

## 5. Build plan

Slices are small enough for one review each. "Needs" names the slice that
must merge first; slices with no shared "needs" run in parallel. Memory
slices and workspace slices touch disjoint files except M4, which needs the
member principal from (c).

| Slice | What | Needs | Files (main) |
| --- | --- | --- | --- |
| **M1** Hard maximum on every delivery path | `renderLearnedRulesSelection` cut at 24 000 bytes for `whole` and fallback rows, protected set reserved first, cut order of layers design §5.1; the live Decisions path from lane d75de2eb reuses it. Skipped if d75de2eb ships it | d75de2eb | `roleRender.ts`, `roleLaunch.ts`, `roleSelect.ts` |
| **M2** Layers and the lineage view | `layer`, `parent`, the Layer check in the brief and in apply, principles first in the render, family view in the curator read and the window | 4dee5653 (same brief text) | `roleTypes.ts`, `curation/brief.ts`, `curation/apply.ts`, `curation/read.ts`, `roleRender.ts`, `LearnedRules.tsx` |
| **M3** Reserve and targets | Budget archives as selection candidates and search hits with a state filter; per-kind targets (20 000 / 30 000 / 15 000 / 15 000); the pool ceiling names active plus reserve; `pool-cut` reason | M1, d75de2eb | `roleConsolidate.ts`, `roleStore.ts`, `roleSelect.ts`, `roleSearch.ts`, `roleViewSource.ts`, `curation/brief.ts` |
| **M4** Member and workspace scopes | Two scope kinds, `source.member`, corrections from member-bound conversations into the member scope, delivery to member-bound stages and to seats, curator pass reads the workspace's member scopes, promotion criteria, `proposed` state and the owner's approve action | (c) merged; M2 | `roleScopes.ts`, `roleStore.ts`, `roleStage.ts`, `curation/store.ts`, `curation/brief.ts`, `curation/apply.ts`, `src/lib/mcp/bindings.ts` |
| **M5** Selection spend | Feature cap and per-launch ceiling per Q1 | Q1 | `roleSelectionSpend.ts`, settings UI |
| **W1** Land (c) | Merge main, repair branch-only failures, resolution review (§4.2) | – | PR #3415 |
| **W2** Usage grouping and worker share | Activity groups tokens and starts by workspace; `worker-limit.json` gains a per-workspace share under the machine cap, admission reads it | W1 | `src/lib/activity/report.ts`, `workerLimit.ts`, Activity UI |
| **W3** Per-workspace systemd slice | `delegatus-agents-<workspaceId>.slice` under `delegatus-agents.slice`, chosen from the launch profile's principal; CPU placement unchanged inside it | W1 | `agentMemory.ts`, `cpuPlacement.ts` |
| **W4** Rules window for members | Routes to `project` with the filtered view of §3.4 | M4 | `workspaceRoutes.ts`, `src/app/api/role-memory/*`, `LearnedRules.tsx` |
| **W5** Member preferences | `member_preferences`, `/api/team/me/preferences`, admission order of §4.3, engine chip | W1 | `team/store.ts`, new route, `spawnCommand.ts`, `EngineAccountSwitch.tsx` |
| **W6** Owner-private audience and owner-private tools | `audience` on conversation records for owner runs, owner root and voice conversations; fence refuses them to member-bound callers and drops them from collections; `relay_owner_history` and `telegram_bot_*` reads admit the operator root and installation seats of unassigned projects only, or project-bound chats | W1 | `src/lib/agent/registry.ts`, `workspaceFence.ts`, `bindings.ts` |
| **W7** Clone as the project's poster | Part 1 of per-project-relay-clone, as designed there | #3602 | per that design |

Parallel groups: {M1, M2} together with {W1}; then {M3, W2, W3, W5, W6, W7}
in parallel; then {M4}; then {W4}. M5 whenever Q1 is answered.

Each slice's acceptance, briefly: M1 renders no block above 24 000 bytes on
any row with the protected set whole in one- to four-byte text; M2's apply
refuses a cross-layer merge, a dangling parent and a principle over 200 code
points, and a child renders under its delivered parent; M3's search returns a
budget archive with its state and a launch's candidates include it, while a
`stale` archive appears in neither; M4 delivers a member scope only to that
member's conversations in an isolated two-member fixture, writes a member
correction into the member scope, and leaves a `proposed` company rule out of
every block until approved; W2 groups one synthetic day's usage by workspace
and refuses the share's overflow; W3 places a member launch in its workspace's
slice (observed through the unit's cgroup path) and an owner launch in the
parent slice; W5 admits the member default only inside the pool; W6 refuses a
member-bound `conversation_messages` on an owner-run conversation in a shared
project and still answers the same call from the operator root; W7 per its
design.

Every memory slice runs its tests against an isolated state directory
(`LLV_STATE_DIR`, HOME, XDG_CONFIG_HOME, TMPDIR), as AGENTS.md requires, and
none touches the runtime host.

## 6. Decision questions for the operator

One recommendation each. The form carries the same questions.

**Q1. Selection spend.** Decisions over the whole pool costs an estimated
$13 to $35 a month at today's volume (§2.3), against the $5 cap set for shadow
Jev.
- (a) **Recommended:** raise the learned-rules feature cap to $40 a month with
  a per-launch ceiling of $0.02; above the ceiling the launch cuts the oldest
  reserve rows from its pool and records it. Decisions stays the selector on
  every launch.
- (b) Keep $5 a month and let launches fall back to BM25 when it is spent.
- (c) Bound the pool to 120 candidates by BM25 before Decisions sees it, on
  every launch.

**Q2. Store bounds.** Lane 4dee5653 raises every scope to 15 000 now.
- (a) **Recommended:** keep 15 000 as the interim for all kinds, and move to
  the 2026-10-22 targets (20 000 role here, 30 000 role on every project,
  15 000 project and machine, 10 000 member, 15 000 workspace) in slice M3,
  after the hard maximum is enforced on every delivery path.
- (b) Move to the targets now, with the hard maximum in the same slice.
- (c) Stay at 15 000 for every kind.

**Q3. Graph.** The store already holds lineage edges; the decided shape is a
layer field and one parent link.
- (a) **Recommended:** keep layer plus parent, and show the existing lineage
  as a family view; consolidation adds a principle and keeps its children.
- (b) Build a typed multi-edge graph collection and expand selections along
  its edges at launch.

**Q4. Who approves a team rule becoming a company rule.** The curator writes
member and role rules into the workspace scope on its own; the step from a
workspace to the installation crosses teams.
- (a) **Recommended:** the curator proposes and the owner approves with one
  action in the rules window; until then the rule is delivered to nobody.
- (b) The curator writes it without approval, as it widens role rules today.
- (c) Any manager of the source workspace approves.

**Q5. A member's own subscription.** Members choose an engine and an account
for their launches.
- (a) **Recommended:** members choose among the accounts the owner put in
  their workspace pool; the owner adds logins.
- (b) Managers may also add a login of their own into a managed home, tagged
  to them and defaulted into their workspace pools, with the level-2 caveat
  shown.

**Q6. Owner-private conversations and tools.**
- (a) **Recommended:** mark owner runs, the owner's root conversations and
  voice sessions `owner-private`; refuse them to member-bound callers whatever
  their project; restrict `relay_owner_history` and the bot's message reads to
  the operator root and to chats bound to the caller's project (W6).
- (b) Rely on the project fence of (c) alone: a member's agent may read any
  conversation in a shared project, the owner's included.

**Q7. The shell.** Every path in §4.5 that stays open after W6 is an agent's
shell reading files of the one OS user.
- (a) **Recommended:** stay at level 2 for this installation; document the
  level-4 deployment (one OS user per workspace) as the answer for an
  installation whose members are not fully trusted, and build its split tool
  only when such an installation exists.
- (b) Design the level-4 deployment now as the next workspace slice.

## 7. Validation against the requirement

| Asked (paraphrased, 2026-11-03) | Where |
| --- | --- |
| Find the earlier work on limits, keeping and using all memory | §0, §0.2, §1.1 |
| Keep all memory | §2.1 reserve class, §2.2 bounds |
| Use all memory | §2.3 per-launch selection over every scope and the reserve, under 24 000 bytes |
| Consolidate, perhaps as a graph | §2.4 |
| Per-account rules, curator makes company rules | §3.1 member scope, §3.2 ladder and criteria, §3.4 window |
| Finish workspaces with isolation, as now or better | §4.1 boundary per layer, §4.2 land (c), §5 W2 to W6, Q7 |
| Each person sees only their workspaces | Shipped (b); §4.1 UI row; W4 for the rules window |
| Works only in their folders | HTTP and MCP resolve cwd to a project (shipped (b), (c)); the shell is the level-2 limit (§4.5 P7, Q7) |
| Does their own actions | Human routes (b), MCP fence (c), member principal on every launch (c) |
| Chooses a Claude or Codex subscription | §4.3 W5, Q5 |
| Per-workspace accounts and binding | Shipped per project; per workspace in (c); §4.3 |
| Report destination through a paired clone (10:55 update) | §4.4, W7, per-project-relay-clone §5.1 |
| Members never reach the owner's private conversations (10:55 update) | §4.5, W6, Q6, Q7 |
| Decisions, evaluated offline, no shadow (10:55 update) | §2.3, lane d75de2eb |

## Deferred — not currently justified

- **A general graph of typed edges and graph expansion at selection** (§2.4
  G1): the store's lineage plus one parent link answers "gathers upward".
- **A per-message member overlay for seats** (§3.3): the seat would re-render
  its rules per member message, breaking the frozen block and the prompt
  cache; member preferences reach the seat through promotion.
- **Member scopes per role** (`member:<m>:<role>`): a member's preferences
  are about how they want work done, across roles; a per-role split waits for
  evidence that one member's rules differ by role.
- **Workspace-scoped swarm candidates**: the pack takes installation rules
  only.
- **Level 4 deployment and the state split tool** (Q7): documented in the
  workspaces design §6; built only for an installation that needs it.
- **Members adding their own logins** (Q5 b).
- **A "make private" action on the owner's own conversations** (§4.5 P4): the
  audience of W6 is set by the conversation's kind; a manual toggle waits for
  a case.
- **Per-member interface language and time zone**: still sign-in design §14.
- **Per-workspace Telegram bot or relay pairing**: level 3 by the workspaces
  design; the 2026-10-20 answer is one bot.
- **Automatic promotion of principles into role prompts**: stays a reviewed
  change to shipped text (layers design §3.4).
- **Removing the per-scope bound**: the operator asked that some maximum
  stay; the bound stays as curation pressure and the hard maximum per launch.
- **Shadow runs, data-collection periods or a second Jev pilot**: withdrawn by
  the 10:55 UTC update.

## Notes

- The read-only audit of the owner's private paths (lane 57064780) had not
  started at reading time; §4.5 is this stage's own reading of the code and
  names what only the audit can confirm (P9).
- PR #3415's four red checks and its unreviewed last fix are the facts at
  `4e0bd2688`; the refresh lane that owns the PR (ead6dc6a) is the place to
  settle them.
- The cost figures in §2.3 are estimates from the price constants in the
  repository and the start and pool counts measured on 2026-10-21; no provider
  call was made by this stage.
- The curator's checklist text (`brief.ts:13`) still says "well below 10 000
  code points" and "16 000 bytes"; lane 4dee5653 and slice M3 both edit that
  line, so M3 lands after it.
- `search_memory` returned nothing on these subjects; the earlier answers
  came from transcripts and the design documents named in §0.
