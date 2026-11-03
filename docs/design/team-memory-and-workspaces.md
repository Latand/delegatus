# Team memory and workspaces: keep all memory, use all of it per launch, per-member rules that become team rules, and the isolation left to build

Status: design, 2026-11-03, read-only stage, revised twice after critiques.
Every code claim was checked against `main` at `6eb1901b5`, fetched at
13:07 UTC. Since this lane started at `ead78b894`, five pull requests merged;
two touch files cited here: #3602 (merged 12:13:29 UTC as `22c452ac2`) and
#3607 (12:47:40 UTC as `bd6bc5343`), and §1 records what each changed. Line
numbers below are main's at `6eb1901b5`. Open pull requests were read at their heads: #3415 at
`4e0bd2688`, and #3611 at `1c41c75f`, re-read at 13:25 UTC at `6bae40c7d`,
whose one new commit rechecks withdrawn rules on seat starts and changes no
cited file besides `roleLaunch.ts` (its line numbers here are the new
head's). What an open pull request proposes is
labelled open, never shipped. Nothing here is built. The operator's decision
form follows this document. Projects other than this repository are named by
letter; no person, account, chat, path or rule text appears here.

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

Two later operator updates in the same conversation change parts of the
earlier decisions:

- **About 10:55 UTC** (task ebbf8f15, lane d75de2eb): memory selection runs
  live on Decisions with a prompt checked by offline evaluations; no shadow
  run and no data-collection period; BM25 only when selection fails. For
  workspaces: a project's report destination should be able to use a paired
  relay clone when one is installed, and members must never reach the owner's
  private conversations through the relay or a clone.
- **10:58 UTC** (the operator's message in the seat conversation at 10:58:27
  UTC; recorded on task ebbf8f15 at about 11:00 UTC): the Decisions provider
  follows the key that is connected. An explicitly saved per-feature choice
  wins; otherwise an OpenAI key selects OpenAI Decisions, else an OpenRouter
  key selects OpenRouter's decisions endpoint, and with neither key the
  launch uses BM25. Lane d75de2eb built and evaluated both providers; its
  PR #3611 is open (§1.1).

The default answer to "should we build this" is no unless the requirement
demands it. It asks to finish two features whose halves are already shipped,
and to extend memory in one new direction (per-member rules). Everything that
only the new words justify is built; everything else stays under "Deferred".

## 0. Earlier answers this design starts from

The pinned specification names the decisions below. Each record was read.
None is reopened unless the 2026-11-03 words change it, and §0.1 says where.

| Decision record | What it settled | Status on main |
| --- | --- | --- |
| `docs/design/role-memory-layers.md` §7.3, operator form of 2026-10-22 (task a6d8a8a0) | (1) Role-on-every-project written by the curator only; (2) Jev only if a second pilot beats BM25 by 10 points, else BM25; (3) one hard maximum per launch of 24 000 bytes; (4) store targets role here 20 000, role on every project 30 000, project and machine 15 000 code points, raised together with selected delivery; (5) layer field plus parent link, principles always-on up to 3 000, the curator decides the layer; (6) Delegatus keeps its own per-feature caps; (7) the operator checks quality visually | Slice 1 shipped (#3191: frozen block, shadow selection, applied and misled). Slices 3 (layers), 4 (selected delivery under the hard maximum) and 5 (targets) are unbuilt (§1.1) |
| Task ebbf8f15, 2026-10-29 analysis and #3570 (deployed 2026-11-02) | Jev had 0 successes in shadow until the admission fix; BM25 median 32 of 103 rules, applied recall 71.7 %; a week of shadow data was to be collected | Superseded by the 10:55 and 10:58 updates; lane d75de2eb opened PR #3611 (created 12:35:47 UTC; every check green at `1c41c75f` at 13:07 UTC; head `6bae40c7d` at 13:25 UTC; open) with live selection for both providers (§1.1) |
| Operator decision of 2026-11-03 about 10:30 UTC (task 88398512, lane 4dee5653) | Compressed rules are rewritten as plain sentences, the curator archives where it used to compress, and the per-scope bound rises; the seat chose 15 000 as the interim value | Shipped: #3607 merged at 12:47:40 UTC as `bd6bc5343`; `ROLE_MEMORY_BOUND = 15_000` for every scope (`src/lib/memory/roleTypes.ts:11`) and the plain-sentence check 7 (`src/lib/memory/curation/brief.ts:14`) (§2.2) |
| `docs/design/swarm-role-memory.md` and task 48d60ffc, operator form of 2026-10-23 | Opt-in shared role rules shipped with releases, 4 000 code points per role, weekly; anonymous counts; proposals through the owner's approval | Slice 1 shipped (`src/lib/memory/swarmPack.ts`, empty pack); slices 2 to 4 open |
| `docs/design/workspaces.md` §12, operator form of 2026-10-20 (task 7e042e15) | Level 2 isolation; owner creates workspaces, manager adds projects and invites; Unassigned bucket; shared account pool with a per-workspace allow-list and usage by workspace; one Telegram bot with per-workspace chats; build order (a) record and switcher, (b) human-route gate and invites, (c) MCP fence and defaults, (d) slice and usage grouping | (a) #3133 and (b) #3255 merged; (c) is PR #3415, open; (d) unstarted (§1.2) |
| `docs/design/sign-in-and-team.md` (#2243) | Members, sessions, authorship stamped on messages, who-did-what; the perimeter key is the operator's; below the OS a member equals the operator | Built; message authors are kept for a year (`src/lib/team/store.ts:52`, `:349-355`); §14 defers per-member locale, the capability matrix and several owners |
| `docs/design/per-project-relay-clone.md` (2026-11-02) | Part 1: a project's report destination names which paired clone posts its reports (`reportTelegram.poster`), set by the operator root or the designated seat | Designed, unbuilt; the 10:55 words restate its Part 1, so this document links to it and adds only the workspace fence (§4.4) |

### 0.1 Where the new words change an earlier decision

- **Selection provider (decision 2 of 2026-10-22).** Replaced by the 10:55
  and 10:58 updates: a Decisions provider chosen by the connected key, an
  explicit saved choice first, BM25 with neither key and on any failure. This
  document designs on that basis (§2.3) and does not re-ask it.
- **Curator-only widening (decision 1 of 2026-10-22), in team installations
  only.** Decision 1 lets the curator write role-on-every-project rules by
  itself. In an installation with workspaces, a company scope (`role:*`,
  `machine`) is read by every workspace, so text learned in one workspace
  would reach the others without anyone seeing it. The new requirement
  ("each account isolated") is what justifies a change: §3.5 makes every
  activation of a company-scope rule in a team installation a proposal the
  owner approves. A solo installation keeps decision 1 exactly. Q4 lets the
  operator keep decision 1 for teams too.
- **The 10:55 "never" at level 2 (Q6).** An agent's shell on one OS user can
  read the owner's private records whatever the Viewer does (§4.5). The
  design does not quietly narrow the words: Q6 asks whether "never" covers
  Delegatus's surfaces only (recommended for trusted members) or needs the
  owner's private state under its own OS user.
- **What a moved project takes along (shipped behaviour, no recorded
  decision).** Today all of a project's history follows it to a new
  workspace (`workspaceAccess.ts:43-48`). Transcripts launched inside a
  workspace now keep that workspace as their origin (§4.6), because they
  carry its members' and team's rules; history from before workspaces
  existed still follows the project. The 2026-10-20 form chose «Move to…»
  and did not settle this; the requirement "each account isolated" decides
  it.
- **Teammates seeing each other's work (only if Q3 b is chosen).** Option (b)
  hides members' agent transcripts from teammates, which narrows the
  2026-10-20 level-2 picture; the recommended (a) keeps it.
- **Nothing else is reopened.** The hard maximum, the store targets, the
  layer-plus-parent shape, level 2 and every workspace answer stand. Where
  "perhaps as a graph" could read as reopening decision 5, §2.4 weighs it and
  keeps the decision with two small additions (an `overrides` link and the
  lineage view). Who may read a member's own rules is new and has no earlier
  answer (Q3).

### 0.2 Earlier conversations

`search_transcripts`, project-scoped first and then unscoped, in six
phrasings (Russian: memory, graph, consolidate, layers, rules, connected key;
English: memory graph consolidate layers abstraction; workspace isolation
member account subscription; per-account rules and company rules; relay
clone owner private conversations audit), and `search_memory` for role memory
layers, graph, workspaces and team rules (no hits). Hits opened:

| Conversation (title, date) | What it settles |
| --- | --- |
| Seat conversation of this repository, "You are the Orchestrator. Mode: standard. Safety fences…", 2026-11-03 10:39–11:00 UTC | The requests above, the 10:58:27 UTC provider-by-key message, and the seat's lesson that no shadow runs or data-collection periods are wanted |
| Same seat line, 2026-11-03 10:34–10:35 UTC | The compressed-rules decision and the seat's interim choice of 15 000 |
| Seat conversation of this repository, 2026-10-11 about 13:38 UTC | The operator asked whether the curator deletes old rules or consolidates them into more abstract ones; the curation design answered with four levels and merge-preserving-conditions, which §2.4 builds on |
| Codex research sessions of 2026-10-22 (lane 27902c33) | The layers research behind §7.3 of the layers document; no graph beyond parent links was proposed there |
| Audit lane 57064780 (task 5f5c4555), audit stage 2026-11-03 11:23–11:41 UTC and verify stage 11:41–12:02 UTC | Which sessions can read the owner's private Telegram conversations. The verify stage confirmed the main conclusion and listed paths the audit report missed; the lane waits for a decision. §4.5 uses both stages' confirmed paths |

### 0.3 What the revisions changed

A second read-only critique raised ten findings against the first revision.
Each is resolved in the section named here.

| Second critique finding | Resolution |
| --- | --- |
| Native engine memory (installation-global instructions, Codex memories, skills) is searchable and openable under any project filter | Native entries get an audience at indexing, every existing global entry fails closed to the owner, authorization runs in SQL before ranking, counting and short-id resolution, and member-bound or project-audience launches in workspace projects start with the engines' own memory off unless the owner shared that home's memory (§3.10, slice N1) |
| Delivered member and workspace memory followed a project into another workspace | A conversation launched in a placed project is stamped with its origin workspace; reading it needs both access to its current project and membership of the origin; history from before a workspace existed follows the project (§4.6) |
| Q3 (b) leaked a member's rules through recall and delegation | Every read an agent makes is authorized against its own transcript's audience, so a tool result never reaches a wider audience than the rule it came from; under (b) every member-bound conversation is private from launch, and children, forks, resumes and migration successors take the narrower audience (§3.2, §4.6) |
| Scope keys alone could not separate owner-only rows, and the view cache could serve them to a member | The predicate decides by scope and by row state; the view cache stays actor-independent and every read passes a per-request authorization step after the cache, never cached per actor (§3.3) |
| Workspace work slices escaped the aggregate work CPU quota | Workspace work slices nest under the existing work slice, whose quota caps their sum by the cgroup hierarchy; operator hosts and gates keep today's placement (§4.7) |
| Q6 (a) presented removing one credential as enough | Q6 now names each option's remaining shell access (P7, P8) and says that option (a) narrows the 10:55 words to Delegatus's own surfaces (§4.5, Q6) |
| Inherited always-on overrides could exceed the protected bound and the 24 000-byte cap | The always-on set is recomputed after overrides under the same 3 000 code points; an override that does not fit becomes an ordinary candidate, and the rule it overrides stays removed (§3.6) |
| Active rows filled the pool before any matching reserve row | On overflow, active and reserve rows are admitted together by score against the brief, with every exclusion recorded (§2.3) |
| W2 was an epic | Split into W2a to W2d with bounded file and contract lists, refusal tests per surface, and a fail-closed default that lands first (§5) |
| Inventory stale | Re-read at `6eb1901b5`; #3602 and #3607 recorded as merged; #3611's proposed behaviour kept apart from what shipped; slice ownership reconciled with its diff (§1, §5) |

The first critique raised sixteen findings against the first version:

| Critique finding | Resolution |
| --- | --- |
| Ordinary member lessons went to shared scopes | Every lesson from a member-bound conversation, and every correction a member authored, lands in that member's own scope with its project and role kept as tags; sharing is a curator promotion (§3.1) |
| Curator transcripts exposed private rules | Each process that reads rules has a named audience; a project's curator pass reads only its own workspace's material, and the cross-workspace pass runs in the owner's audience (§3.4) |
| No rule-level authorization | One server-side predicate for reading and changing a rule, used by search, open-by-id, family traversal, histories, selection, every mutation and the view cache; foreign provenance is redacted (§3.3) |
| Company gate bypassed by old curation paths | Every write that would make a company-scope rule active in a team installation becomes a proposal, whatever path produced it (§3.5) |
| HTTP and stream paths left open to owner-private conversations | One conversation-audience check on HTTP reads and actions, collection projections, streams, MCP and search, with a default for existing records (§4.6) |
| Oldest reserve rows could be excluded forever | The pool bound admits reserve rows by relevance to the brief, never by age; an explicit recall path enters the attempt's delivered set (§2.1, §2.3) |
| Provider premise missed the 10:58 clarification | Provider by connected key, carried through selection, failure, spend and evaluation (§0, §2.3) |
| Parent model and algorithm disagreed | One validator with the allowed edge kinds and the reader-superset table, which every algorithm step satisfies (§2.4) |
| $0.02 per-launch ceiling could not admit the active pool | Ceiling removed; the pool bound makes the reservation bounded by construction, measured for both providers; admission has one terminating outcome (§2.3) |
| Slices grouped by member and lacked containment | Resource workspace comes from the admitted project for every launch origin; aggregate limits, fallback, resume and project moves specified (§4.7) |
| Preferences table invented, account catalog missing | Preferences cut; a member-readable account projection filtered by the workspace pool feeds the existing selector (§4.3) |
| Plan slices too large, parallelism wrong | Twenty slices, each one verifiable behaviour with negative cases, with shared-file serialization listed (§5) |
| Questions re-asked settled decisions | Bounds question removed (sequencing is engineering); the owner-private fence is built without a question; six questions remain, each naming any decision it would change (§6) |
| Privacy claim false at the provider boundary | Inventory now separates publication protection from intentional disclosure to the engine and selection providers, field by field (§1.1, §3.3) |
| Account bindings overstated as a hard fence | Inventory separates default routing, the `account` pin, the `accountId` override, resume and member-bound refusal (§4.1) |
| Member-first render order claimed to override | An `overrides` link and a reader-specific precedence step before scoring, always-on and packing (§3.6) |

## 1. Inventory: shipped, open, missing

### 1.1 Memory

| Piece | State | Evidence |
| --- | --- | --- |
| One store, three row kinds, rules never deleted; archives and versions keep every text | Shipped | `src/lib/memory/roleStore.ts:84-87` (`keepHistory`), `:305-316` (`versionedRule`), `:384-409` (rewrite path) |
| Four scopes a stage reads: role here, role on every project, project, machine; plus the opt-in swarm scope | Shipped | `roleStore.ts:154-156` (`readableScopes`), `src/lib/memory/roleScopes.ts:13-15` |
| Per-scope target 15 000 code points (the 2026-11-03 interim), rules kept as plain sentences, compression forbidden, budget archive instead | Shipped (#3607, `bd6bc5343`) | `src/lib/memory/roleTypes.ts:11`; check 7 `curation/brief.ts:14`; advisory `readabilityHint` on curator reads `curation/read.ts:70-74`, `src/lib/memory/curation/readability.ts` |
| Emergency eviction only when curation is unavailable and the scope exceeds 125 % of its target; a new lesson never evicts; the curator integrates and restores budget archives | Shipped (#3340) | `src/lib/memory/roleConsolidate.ts:67-92`, `roleStore.ts:50-78` (`retentionPolicy.canCurate`), `src/lib/memory/curation/brief.ts:14` (check 7) |
| Whole-scope delivery, block frozen per attempt, 120 000-byte argument guard | Shipped (#3191) | `src/lib/memory/roleLaunch.ts:19`, `:58-104`; `src/lib/memory/roleSelection.ts:72-119` |
| Selection brief: task text up to 2 000, specification up to 8 000, stage prompt up to 3 000 characters | Shipped | `roleLaunch.ts:86` |
| Shadow selection per attempt: BM25 always, a provider when a key, its admission and the cap allow; always-on operator-kept rules up to 3 000 code points; pack to 9 000 code points and 24 000 bytes; 3 000 ms deadline | Shipped, shadow only | `src/lib/memory/roleSelect.ts:10-11`, `:20-28`, `:64-81`, `:111-125` |
| Provider adapters: OpenAI Decisions (batches sent one after another) and OpenRouter (batches sent together); per-feature provider choice | Shipped (#3508) | `src/lib/memory/roleSelectionProvider.ts:83-92`, `:117-133` (sequential), `:174-189` (concurrent); `src/lib/openaiServices/decisions.ts:4-6` |
| Spend: the whole byte ceiling of every batch is reserved before dispatch against a $5 monthly cap, then settled to the observed bill | Shipped | `src/lib/memory/roleSelectionSpend.ts:5`, `:17-30`, `:34-43`; `decisions.ts:6`, `:21-23`; Jev price `src/lib/asks/jev.ts:19` |
| Live selection on the provider chosen by key, evaluated prompt, BM25 on failure | Open: PR #3611 (lane d75de2eb), head `6bae40c7d`. It delivers the selected block on stage and seat starts with no shadow (PR `roleLaunch.ts:76-129`), threshold 0.10 (PR `roleSelect.ts:12`), and on any brief or provider failure runs BM25 without a key and then the whole cut (PR `roleLaunch.ts:116-123`). Its description reports, on 24 evaluation cases: applied 58/64 whole, 49/64 OpenAI v2, 44/64 BM25; OpenRouter refused every cell, so its rows are BM25; OpenAI latency p95 2.9 to 3.5 s against the unchanged 3 000 ms live deadline | PR #3611 diff and description, read 13:07 UTC |
| Hard maximum of 24 000 bytes on every delivery path | On main, missing on the live path: only the shadow pack applies it (`roleSelect.ts:11`); the delivered whole block is cut at 120 000 bytes (`roleLaunch.ts:19`, `src/lib/memory/roleRender.ts:51-65`). Open in #3611: every start renders through `selectedSnapshot` at 24 000 bytes with the operator-kept set protected (PR `roleSelection.ts:76-86`, `roleRender.ts:50-64`), and a frozen row above 24 000 bytes is re-rendered on resume (PR `roleSelection.ts:123-131`) | layers design §4.3 (slice 4) |
| Pool bound on the live path | #3611 keeps today's rule: a candidate pool above 120 000 code points skips the provider and packs BM25 (`jev-pool`, PR `roleSelect.ts:134`); reserve rows are not candidates | §2.3, slice M2 |
| Layer field and parent link | Missing: lineage fields exist (`mergedFrom`, `mergedInto`, `splitFrom`, `splitChildren`, `movedFrom`, `versions`, `against`), no `layer` or `parent` | `roleTypes.ts:118-158` |
| Store targets 20 000 / 30 000 / 15 000 / 15 000 | Missing | layers design §7.3 decision 4 |
| applied and misled on `leave_lesson`, accepted only for ids the attempt received | Shipped | `roleStore.ts:366-373`; `src/lib/memory/deliveryLedger.ts:269` |
| Curator pass per project over its role scopes, the role-wide scopes, the project and the machine; launched as role `curator` in the project's repository directory; its scope read returns raw rule text, why and usage, plus other projects' same-role rules as evidence | Shipped | `src/lib/memory/curation/store.ts:153-170`, `:207-211`; `src/lib/memory/curation/run.ts:31`; `src/lib/memory/curation/read.ts:63-68`; `src/lib/memory/roleViewSource.ts:351` |
| Curator checklist: task, current, readers, level (including direct widening to `role:*`), duplicates, contradictions (no opposing active pair), integration before budget | Shipped | `curation/brief.ts:8-14` (check 4 at `:11`, check 6 at `:13`); apply's move and split into named targets `curation/apply.ts:125-141`, merge reach check `:160` |
| Search of rules: active rules only, filtered by project, no member authority | Shipped | `src/lib/memory/roleSearch.ts:6-14`, `roleViewSource.ts:366-369` |
| Native engine memory in `search_memory`: account-home instruction files and rules, Codex `AGENTS.md`, Codex memories and rollout summaries, and skills are indexed as `global`; Claude project memory (`sources.ts:59-76`) as `project`. Search and open-by-id admit every `global` entry whatever project is asked for, including short-id resolution | Shipped, no audience | `src/lib/memory/sources.ts:57-58`, `:78-86`; `src/lib/memory/index.ts:282` (search), `:313` (short id), `:322` (open). #3415 leaves it as it is (its description: global `search_memory` visibility unchanged) |
| The engines' own memory at launch: Claude auto memory and Codex memories are switched off only for clean-memory launches or when the installation chose Delegatus as its memory source | Shipped | `src/lib/memory/source.ts:81-85`; Claude `src/lib/agent/cli.ts:472-473`, Codex `:550` |
| Rules window projection: text, why, versions, lineage and source per rule | Shipped, owner-only | `roleStore.ts:592-610`; `src/lib/team/workspaceRoutes.ts:133-135`; POST acts on a rule id whatever project it names (`src/app/api/role-memory/route.ts:29-35`) |
| Where rule text goes | Publication: every rule and why is a known value of the publication gate, so it cannot be pushed (`roleStore.ts:780`, `:794-806`). Execution: the block goes to the agent's engine provider with its instructions (Claude's appended system prompt, Codex developer instructions; on 2026-11-03, 5 of the 20 newest Codex transcripts of the day on this machine held the block in a developer-role record). Selection: the brief and each candidate's text go to the selection provider after credential lines are replaced and `redactForClassifier` runs; the project is sent as "A" and rule ids as hashes (`roleSelectionProvider.ts:68`, `:73`, `:76`, sent at `:123` and `:178`). The earlier role-memory design corrected the same promise (`docs/design/role-memory.md:1296`) | Shipped |
| Swarm scope: public pack shipped with releases, 4 000 code points per role; the pack is empty | Shipped, slice 1 | `src/lib/memory/swarmPack.ts:9-11`, `src/lib/memory/settings.ts:12-15` |
| Any notion of a member in memory | Missing: a lesson's source names the conversation, stage and role (`roleTypes.ts:56-77`), never a member; no member or workspace scope kind (`roleTypes.ts:34`) | §3 |

The measurements of 2026-10-21 still frame the problem: scopes sat at 93 to
100 % of the bound, a quarter of a week's lessons left for budget, and a
builder start carried about 23 KB whole (layers design §1.2 to §1.4). #3340
moved the loss from the write path to the curator's budget archive, which is
reversible.

### 1.2 Workspaces

| Piece | State | Evidence |
| --- | --- | --- |
| Record: `workspaces`, `workspace_members` (manager or member), `workspace_projects` (a project in at most one workspace) | Shipped, slice (a) #3133 | `src/lib/team/store.ts:356-378`, `:692-756` |
| Owner's workspace page, rail switcher, «Move to…», Unassigned group | Shipped, slice (a) | `src/components/team/WorkspaceSwitch.tsx:16-20`, `src/components/team/TeamPage.tsx:13-20` |
| Per-request scope: owner sees all; manager sees own workspaces plus Unassigned; member sees own workspaces | Shipped, slice (b) #3255 | `src/lib/team/workspaceAccess.ts:10-58` |
| One decision per API route; unknown routes owner-only; `project` routes resolve every identity in the request to a project; files and runtime streams projected by project | Shipped, slice (b) | `src/lib/team/workspaceRoutes.ts:2`, `src/lib/team/workspaceRoute.ts:170-245`; `src/lib/team/workspaceProjection.ts:9-69` |
| Spawn, preflight and pipeline creation require authority for every project the request resolves to | Shipped, slice (b) | #3255; `src/app/api/spawn/route.ts:1-25` |
| Invite into a workspace | Shipped, slice (b) | `workspaceAccess.ts:60-72` |
| MCP fence: closed list of project tools for member-bound callers; identities resolved before receipts; collections default to the caller's project; `leave_lesson` with `machine` or `rewrite` refused for member-bound callers | Open: PR #3415 | PR file `src/lib/mcp/workspaceFence.ts:28-36`, `:69-87`, `:114-133` |
| Member principal on the launch profile, from a spawn's member, a bound seat or the latest recorded message author; an active owner has none | Open: PR #3415 | PR file `src/lib/team/workspacePrincipal.ts:16-50` |
| Per-workspace defaults: account pools per engine, report chat, directive chats | Open: PR #3415 | PR file `src/lib/team/workspaceDefaults.ts:14-93` |
| Checks on #3415's head | Red at `4e0bd2688` (unchanged at 13:07 UTC): `build`, `bun-runtime`, `runtime-gate` fail; privacy, scope, native Codex and macOS pass | `gh pr checks 3415`, lane ead6dc6a |
| Which conversations a person may read | By the project the conversation resolves to now, through one resolver shared by HTTP identities, projections and both streams; the log stream and runtime events re-read the person's scope per batch or event, so a move takes effect on open subscriptions. #3415's fence resolves conversations with its own copy of that resolver | `workspaceAccess.ts:43-48`; `src/lib/team/workspaceRoute.ts:34-56`; `src/app/api/logs/stream/route.ts:14-20`; `workspaceProjection.ts:62-68`; PR file `workspaceFence.ts:74-77` |
| Moving a project between workspaces | The owner, or a manager of both the source and the target, moves it in one call; access to all its history follows the new placement | `src/lib/team/workspaces.ts:246-267` (manager rule `:255-262`) |
| Slice (d): per-workspace slice, usage grouped by workspace, per-workspace worker share | Missing. One transient scope per agent with `MemoryMax`; operator hosts in `delegatus-agents.slice`, work in `delegatus-agents-work.slice` with an aggregate CPU quota; worker limits per machine and per project | `src/lib/runtime/agentMemory.ts:81-91`, `src/lib/runtime/cpuPlacement.ts:10-40`; `src/lib/operator/workerLimit.ts:37-56`; `src/lib/activity/report.ts:134`, `:282` |
| A member choosing an account | Missing: the engine chip reads `useEngineAccounts`, which fetches `/api/accounts` (`src/components/EngineAccountSwitch.tsx:43`, `src/hooks/useEngineAccounts.ts:733`), an owner-only route (`workspaceRoutes.ts:7-24`) | §4.3 |
| Per-member interface language and time zone | Deferred since sign-in design §14 | `src/lib/operator/settings.ts:42-57` |
| Report destination per project | Shipped. Since #3602 (merged 12:13:29 UTC) a topic link to a chat a paired bot posts in saves with its topic, and writing a chat through the project settings route needs operator authority | `src/lib/projects/settings.ts:320-367`; `src/app/api/projects/settings/route.ts:228-230` |
| Which paired clone posts a project's reports | Designed 2026-11-02, unbuilt | `docs/design/per-project-relay-clone.md` §5.1 |
| Owner's private conversations reachable by members | Partly closed; §4.5 lists the paths with the audit's evidence | §4.5 |

## 2. Memory: keep all of it, use all of it

### 2.1 What "keep all" has to mean

Nothing is deleted for disuse (the 2026-10-02 rule). The store already keeps
every text. What is lost is reach, in three places:

1. A budget archive leaves the delivered block and the selection pool; only
   the curator reads it.
2. An archived rule leaves search (`roleViewSource.ts:366-369`).
3. A merge archives its sources; their conditions survive only in the
   survivor's words.

"Keep all memory" therefore means: every stored rule that is still true stays
a candidate for delivery and a hit for search, whatever its budget state.

- **The reserve.** A rule the curator archives for `budget` stays the same
  row (`state: "archived"`, `reason: "budget"`) and is called a reserve row.
  Reserve rows are selection candidates (§2.3) and search hits
  (`activeRoleRuleRows` gains a `states` filter defaulting to active plus
  reserve, the state on each hit). They are never delivered whole: only the
  selector, with a brief, brings one into a block.
- **Every other archive reason stays out of delivery**: task-specific, stale,
  in-code, in-instructions, no-reader, contradicted, duplicate, problem,
  deleted (`roleTypes.ts:37-38`). Those are judgements that the text should
  not reach an agent; `budget` says only "no room". Search reaches them with
  `states: ["archived"]` for the operator.
- **Merges keep their sources reachable.** A merged source stays a search
  hit through the survivor's family view (§2.4).
- **No age cut.** A reserve row never leaves the pool because it is old. When
  a reader's pool would exceed the pool bound, reserve rows are admitted by
  relevance to the brief (§2.3), so an old rule that matches the work is
  asked about on that launch.

The curator's check 7 is unchanged (integrate, restore when it fits, archive
the least valuable). One addition: a budget archive's note says what the
reserve row still covers.

### 2.2 The bounds, reconciled

| Step | Role here | Role on every project | Project | Machine | Member (§3) | Workspace (§3) | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Today | 10 000 | 10 000 | 10 000 | 10 000 | – | – | – |
| Interim (#3607, shipped 12:47 UTC) | 15 000 | 15 000 | 15 000 | 15 000 | – | – | One constant for every kind |
| Decided targets (slice M3) | 20 000 | 30 000 | 15 000 | 15 000 | 10 000 | 15 000 | After the 24 000-byte hard maximum holds on every delivery path (#3611) |

The interim value needs no reversal: M3 keeps 15 000 for project and machine
and raises the two role kinds. The member and workspace targets are new
engineering defaults (no earlier answer exists); they sit in the same
per-kind map (`roleTypes.ts:11` becomes `ROLE_MEMORY_TARGETS[kind]`).

One consequence the operator should know: on main today delivery is whole,
so the 15 000 per scope that shipped at 12:47 UTC lets a four-scope block grow
toward 60 000 code points, over the 24 000-byte maximum of decision 3, until
#3611 merges. #3611 renders every start, every fallback and every resumed
frozen row through the 24 000-byte renderer (§1.1), which is what the first
revision's slice M1 asked for; M1 is therefore no longer a separate slice,
and its acceptance (one- to four-byte text at 60 000 code points renders at
or under 24 000 bytes with the protected set whole, on stage, seat, fallback
and resume) is a review item for #3611. The decided targets wait for it.

### 2.3 Use all of it: selection per launch under 24 000 bytes

The delivery policy of the layers design §5.1 stands, with the provider set
by the 10:55 and 10:58 updates.

**Provider.** One resolution per launch, read at admission: an explicit
saved per-feature choice for `rules` wins; otherwise an OpenAI key selects
OpenAI Decisions, else an OpenRouter key selects OpenRouter's decisions
endpoint, else BM25 with reason `no-key`. On main `configuredRoleSelectionProvider`
defaults to OpenRouter whenever OpenAI is not the effective choice
(`roleSelectionProvider.ts:85-86`); #3611 changes that order to OpenAI first
(its description and its `src/lib/openaiServices/policy.ts` change). Both
adapters keep their protocol, pricing and admission
(`roleSelectionProvider.ts:59-60`).

**Candidates (the pool).**

1. Every active row of every scope the reader reads (§3.7 adds the member and
   workspace scopes), with the reader's precedence step applied (§3.6),
   minus the always-on set.
2. Reserve rows of the same scopes.
3. The pool has two bounds: 120 000 code points of rule lines (today's
   `jev-pool` check, `roleSelect.ts:125`, kept by #3611 at its `:134`) and
   480 rules (15 batches). The count bound is new; without it, many short
   rules would multiply the batches, and every batch repeats the brief. At
   the decided targets the active rows of one reader come to at most about
   109 000 code points (20 000 + 30 000 + 15 000 + 15 000 + 15 000 workspace
   + 10 000 member + 4 000 swarm), about 430 rules at the measured mean of
   252 code points, so the active rows usually fit.
4. **Admission when the pool would overflow.** When active plus reserve rows
   exceed either bound, they are admitted together, in one order: BM25 score
   against the brief, highest first (the score is already computed on every
   launch, `roleSelect.ts:117`); on equal scores an active row before a
   reserve row, then curator order. Rows are taken until the next one would
   break a bound. Then, while room remains, active rows with a zero score
   follow. A reserve row with a zero score is never admitted to an
   overflowing pool. Every row left out is recorded on the delivery ledger
   with its reason: `pool-bound` (it scored, or it was active, and there was
   no room) or `reserve-unmatched` (a reserve row with a zero score). One
   pass, no loop. Today's whole-pool BM25 fallback (`jev-pool`) is replaced
   by this admission, so an overflowing pool still reaches the provider.

The fixture the critique gave shows the order: 480 short active rows that
share no word with the brief and one budget archive that matches it. The
archive scores above zero and is admitted first; 479 active rows follow; one
active row is recorded `pool-bound`. Lexical scores only choose which rows
are asked about when the pool overflows; the provider still makes every
delivery decision. A row that shares no word with a brief is asked about
only on launches whose pool has room, or reached by recall (below); that is
the limit of this bound, and the ledger counts show how often it binds. The
bounds and their ordering are engineering limits under the operator's spend
cap; no question is needed.

**Always-on** (reserved first, never cut): rules the operator kept, then the
principles of the reader's role-on-every-project scope, workspace and machine
in curator order, within 3 000 code points; the precedence step can replace
one of them for one reader (§3.6).

**Selected.** The provider scores each candidate (one predicate per rule,
batches of 32, the brief as state, the rubric of
`roleSelectionProvider.ts:73`); rules at or above the evaluated threshold are
packed by score to 9 000 code points of lines and 24 000 bytes of block.
Prompt and threshold come from the offline evaluation in #3611 (threshold
0.10, prompt v2). A dependency on that pull request: the OpenAI adapter sends
its batches one after another (`:119-132`) inside a 3 000 ms selection
deadline (`roleSelect.ts:10`), and #3611's own evaluation reports an OpenAI
p95 of 2.9 to 3.5 s on today's pools; ten batches at the target pool will not
fit unless the batches run concurrently as OpenRouter's do (`:175`). Slice M3
(the larger targets) therefore also needs a full-pool launch inside the
deadline, or launches will fall back to BM25 with reason `jev-timeout`.

**Failure.** Missing key, provider admission refusal, spent cap, shape error,
timeout or HTTP error: the launch packs the BM25 order (`result(reason)`
rows, `roleSelect.ts:124`), reserve rows included after M2, under the same
24 000 bytes. A brief or selector exception runs BM25 without a key, and a
BM25 failure delivers the `whole` row cut to 24 000 bytes (#3611,
`roleLaunch.ts:116-123` and its `bm25-error` reason). The reason is on the
delivery ledger row; nothing claims Decisions ran when it did not.

**Explicit recall.** An agent that finds a reserve rule through
`search_memory` during its run has it appended to its attempt's ledger as
`recalled` (up to 20 ids per attempt). `deliveredRuleIds`
(`deliveryLedger.ts:269`) includes recalled ids, so `applied` and `misled`
may name them. The frozen block does not change; a resume renders the same
block and keeps the recalled list. The curator's scope read shows recalled
and applied counts, which is its signal to restore the row. What a recall may
return is decided by the caller's transcript audience (§3.3), so a recalled
line never reaches a reader the rule's own audience excludes.

**Frozen per attempt**, operator deletion the one permitted change
(`roleSelection.ts:72-95`).

**Rendering**: principles first with their delivered children under them; a
child whose parent was not delivered renders alone; reserve rows render like
any line.

**Spend, measured.** The local cap reserves every batch's full ceiling before
dispatch and settles to the bill afterwards
(`roleSelectionSpend.ts:15-43`). OpenAI's ceiling is (request bytes + 4 096)
× $0.1375 per million bytes per batch (`decisions.ts:6`, `:21-23`);
OpenRouter's is (request bytes + 462) × $0.042 per million bytes
(`roleSelectionProvider.ts:149`, `jev.ts:19`). This stage called `prepare`
on both real adapters with synthetic rules of 250 code points each, in a
scratch export of this lane's head with isolated state: no key was read and
no request was sent (2026-11-03, about 12:15 UTC).

| Pool (rules × 250 code points) | Brief (characters) | Text | Batches | OpenAI reservation | OpenRouter reservation |
| --- | ---: | --- | ---: | ---: | ---: |
| 160 (one reader today, 40 000) | 13 000 | English | 5 | $0.0211 | $0.0056 |
| 160 | 13 000 | Ukrainian | 5 | $0.0333 | $0.0093 |
| 320 (decided targets, 80 000) | 13 000 | English | 10 | $0.0422 | $0.0111 |
| 320 | 13 000 | Ukrainian | 10 | $0.0665 | $0.0185 |
| 320 | 4 000 | English | 10 | $0.0298 | $0.0073 |
| 320 | 4 000 | Ukrainian | 10 | $0.0435 | $0.0115 |
| 480 (pool bound, 120 000) | 13 000 | Ukrainian | 15 | $0.0997 | $0.0278 |
| 480 | 4 000 | Ukrainian | 15 | $0.0652 | $0.0173 |

The reservation is an upper bound. OpenAI bills tokens ($0.10 per million
uncached, $0.01 cached, `decisions.ts:31`); at about 4 bytes per token for
English and 5 to 6 for Ukrainian, the target-pool rows bill about $0.007 to
$0.008 uncached and about $0.004 with the repeated brief cached. These are
estimates from byte counts; no live bill was observed. OpenRouter's bill is
whatever its usage reports, at most the reservation. At the 2026-10-21 volume
of about 1 540 starts with rules a week (about 6 600 a month), OpenAI
selection would cost roughly $26 to $53 a month and OpenRouter at most $73 to
$122. The $5 cap (`roleSelectionSpend.ts:5`) would be spent within the first
days of a month, after which launches fall back to BM25 (Q1).

**Admission, one terminating outcome.** The two pool bounds and the brief's
13 000 characters bound every reservation: about $0.10 (OpenAI) or $0.03
(OpenRouter) for two-byte text, as the last rows of the table show, and about
twice that if every character were four bytes. A launch reserves once; when the reservation does not fit
the month's remaining cap, the launch takes BM25 with reason `cap` and
records it. There is no per-launch ceiling, no retry and no shrinking loop.
The rules window shows the month's share of Decisions and fallback launches
from the ledger reasons, so the operator sees when the cap binds.

### 2.4 Graph or layers

The operator asks whether memory should consolidate "as a graph, so that it
gathers". Decision 5 of 2026-10-22 is a layer field and a parent link. What
the store already holds:

| Edge | Exists today | Field | Used by |
| --- | --- | --- | --- |
| merged into / merged from | yes | `mergedInto`, `mergedFrom` (`roleTypes.ts:129`, `:147`) | task counting, import undo |
| split from / split children | yes | `splitFrom`, `splitChildren` (`:149-151`) | import undo, attribution |
| moved from | yes | `movedFrom` (`:148`) | history |
| earlier text | yes | `versions`, `versionOf` (`:139-140`) | frozen-block resolution, revert |
| contradicts / duplicates (archived side) | yes | `against` (`:146`) | curator apply check |
| serves a more general rule | no | `parent` (decided) | rendering, always-on, budget order |
| layer | no | `layer` (decided) | always-on, curator checks |
| narrower rule replaces a wider one for its readers | no | `overrides` (new, §3.6) | selection precedence |
| promoted from | no | `derivedFrom` (new, §3.5) | provenance |

| Option | What it adds | For | Against |
| --- | --- | --- | --- |
| G0. Layer plus parent, as decided, with the lineage view | `layer`, `parent`; the existing lineage edges shown as a family | One field and one link; rendering stays a tree; check 7's "derive a more abstract rule" gets a place to put the result without losing the children | One parent per rule; a specific serving two principles is linked to one and found from the other by search |
| G1. Typed multi-edge graph | A `role_memory_edges` collection with any fan-in and fan-out, graph expansion at selection | Expresses every relation the curator reasons about | A second collection whose consistency must follow every merge, split, move and archive (today each rewrites the rule row in one transaction); expansion adds rules the brief did not ask for, which the 2026-10-02 study found unhelpful (layers design, Deferred) |
| G2. Replace scopes by a graph | Scopes become edges from rules to readers | Uniformity | Every reader, bound, curator pass and privacy path is keyed by scope; a rewrite for no asked-for behaviour |

**Recommendation: G0 with the lineage view** (Q2). "Gathers" is upward
consolidation, which a tree does; a general graph adds machinery the problem
does not need. The two new links (`overrides`, `derivedFrom`) are single
fields with one meaning each; neither is traversed at selection beyond one
step.

**Data model (slices M4 and T2).** On `RoleMemoryRule`, optional fields,
schema version unchanged:

```
layer?:       "principle" | "practice" | "specific"   // absent = practice
parent?:      string     // rule id, validated below
overrides?:   string[]   // ids of wider rules this rule replaces for its readers (§3.6)
derivedFrom?: string[]   // source ids at promotion (§3.5)
tags?:        { project?: string; role?: string }      // member rows only (§3.1)
```

**Edge validator** (one function in `curation/apply.ts`, also called by the
lesson write path for `overrides`):

| Edge | Allowed when |
| --- | --- |
| `parent` | child `specific` → parent `practice` or `principle`; child `practice` → parent `principle`; a `principle` has no parent. The parent is active and every conversation that reads the child also reads the parent (table below) |
| `overrides` | the target is active, every reader of the overriding rule reads the target, and the target's readers are a strict superset (a wider audience) |
| `derivedFrom` | written only by a promotion (§3.5); ids may name rows the reader cannot read, which the projection redacts (§3.3) |

Since the layer strictly rises along `parent`, a chain has at most two links
and cannot cycle. Reader-superset table for `parent` and `overrides` targets:

| Child scope | Parent may sit in |
| --- | --- |
| `role:<p>:<r>` | `role:<p>:<r>`, `role:*:<r>`, `project:<p>`, `workspace:<w(p)>` when p is in a workspace, `machine` |
| `role:*:<r>` | `role:*:<r>`, `machine` |
| `project:<p>` | `project:<p>`, `workspace:<w(p)>`, `machine` |
| `workspace:<w>` | `workspace:<w>`, `machine` |
| `member:<m>:<w>` with tags {p, r} | a row of the same member scope whose tags are a subset of {p, r}; `role:<p>:<r>`; `role:*:<r>`; `project:<p>`; `workspace:<w>`; `machine` |
| `member:<m>:<w>` with tags {p} | same member scope with tags ⊆ {p}; `project:<p>`; `workspace:<w>`; `machine` |
| `member:<m>:<w>` with no tags | same member scope with no tags; `workspace:<w>`; `machine` |
| `machine` | `machine` |
| `swarm:<r>` | none (public release text) |

Refused, each with its own code: a parent in another role's scope
(`role:<p>:builder` under `role:*:reviewer`), in another workspace, in another
member's scope, a dangling id, a non-principle parent of a practice, and any
parent on a principle. Merge stays within one layer (`CURATE_LAYER`, beside
the existing `CURATE_NARROWS` at `apply.ts:160`). Archiving a practice
re-parents its specifics to that practice's principle when the table allows,
else clears them; archiving a principle clears its children's `parent`; the
apply refuses a call that would leave a dangling link. Undo restores all
five fields with the other prior fields. A principle fits 200 code points
and names no tool, product, file or project term, by the curator's judgement
(no detector refuses it).

**Curator algorithm** (the Layer check, between Level and Duplicates):

1. Label every unlabelled active and reserve row: a rule naming a project's
   file, command, gate budget or tool version is `specific`; a rule with a
   trigger and a check is `practice`; one sentence under 200 code points
   naming no tool, product or project is `principle`.
2. When two or more practices state one class (across projects, or across
   members of one workspace, §3.5), write a principle in the widest scope
   every one of their readers shares (the table above), link each practice's
   `parent` to it, and keep the practices. The principle adds a line; the
   children keep theirs.
3. A specific's `parent` is the practice or principle it instantiates, when
   one exists in an allowed scope; otherwise none.
4. Budget order within a scope (check 7, refined): specifics with the fewest
   tasks and applications first, then practices whose principle is active,
   then practices without a parent; principles last, and a principle with
   any child delivered in the last 30 days never leaves for budget.
5. The final message lists new principles by id with their children's count.

Every link these steps write passes the validator: step 2 picks the scope
from the table, step 3 picks a practice or principle, step 4 writes none.
Existing rules get a layer in the first pass after deploy; until then every
rule is a practice (selectable, never always-on).

### 2.5 Where the interim 15 000 fits

The interim raise is the first step of decision 4 and shipped at 12:47 UTC
(#3607). #3607 also forbids compression, asks the curator to rewrite
compressed rules and to archive for budget instead (check 7,
`curation/brief.ts:14`), and attaches an advisory readability hint to
shorthand-heavy rules on the curator's reads (`curation/read.ts:70-74`)
that never refuses a write. §2.4's rule that consolidation adds a principle and keeps the children
is the structural form of the same instruction. M3 and M4 edit the brief
text #3607 left, so they start from its check 7 rather than the older one.
The 15 000 stays the project and machine target at M3; only the two role
kinds rise, and only after #3611 holds the 24 000-byte cap.

### 2.6 Validation of the memory part against the words

| Asked (2026-11-03) | Where |
| --- | --- |
| Raise the character limits | §2.2 interim and targets, under the hard maximum |
| Keep all memory | §2.1 reserve class: budget archives stay searchable and selectable, never cut by age |
| Use all memory | §2.3 selection over active and reserve rows of every readable scope, per launch, within 24 000 bytes, with explicit recall |
| Consolidate, perhaps as a graph | §2.4 G0 with lineage view; principles gather practices without compressing them |
| Decisions, evaluated offline, no shadow; provider by key; BM25 on failure (10:55, 10:58) | §2.3; the evaluation and prompt are in PR #3611 (lane d75de2eb), open |

## 3. Team memory: per-member rules into team and company rules

### 3.1 A member's own rules

**Who counts as a member's agent.** A conversation whose launch profile
carries a member principal (#3415, `workspacePrincipal.ts:16-50`): a launch by
a signed-in member, a pipeline a member created, a seat bound to a member,
their children and resumes. An active owner has no principal and keeps
today's behaviour. Installation launches (owner's work, unbound seats, the
curator) have no principal.

**Scope.** One new scope kind, one scope per member per workspace:
`member:<memberId>:<workspaceId>` (`unassigned` for a member-bound launch in
an Unassigned project, which only managers can make). Keying by workspace
keeps one member's rules learned in workspace A out of workspace B, where
their teammates are other people. Target 10 000 code points.

Each member row keeps where it was learned as tags: `{ project, role }` for a
role lesson, `{ project }` for a project lesson, none for a member-wide one.
Tags decide delivery inside the member's own work (§3.7); the curator widens
a member rule by removing tags, exactly as it widens role-here to
role-everywhere today.

**Where lessons land.**

| Writer | Agent asked for | Lands in |
| --- | --- | --- |
| Installation conversation (owner's stage, unbound seat, operator root) | `role`, `project`, `machine` | Today's scopes, unchanged (`roleStore.ts:355-359`); in a team installation a `machine` lesson from a workspace project becomes a proposal (§3.5) |
| Member-bound conversation | `role` | `member:<m>:<w>` with tags {project, role} |
| Member-bound conversation | `project` | `member:<m>:<w>` with tags {project} |
| Member-bound conversation | `machine` | `member:<m>:<w>` with no tags (the member's preference across their work in w). #3415 refuses `machine` from member-bound callers today; T2 turns that refusal into this routing |
| Member-bound conversation | `rewrite` of a readable rule | Refused for shared rules as #3415 does; allowed for rows of the caller's own member scope |
| Any conversation | `correction: true`, where the latest human message in that conversation before the call has a member author (`message_authors`, `store.ts:349-355`, kept a year) who is not an active owner | `member:<author>:<w(project)>` with tags {project}; `source.member` records the author and the message id |
| Any conversation | `correction: true` with an owner author, or no member author (bridge, relay, a Telegram directive without sign-in) | Today's path |

So a member's ordinary lesson and a member's correction enter that member's
scope and reach that member's later eligible tasks; another member's agents
receive them only after a promotion (§3.5). A seat that answers member A's
message records A's correction under A, because attribution comes from the
message author and never from the seat's own launch principal.

`StageRuleSource` and `SeatRuleSource` gain
`member?: { memberId: string; workspaceId: string | null; messageId?: string }`
(`roleTypes.ts:56-77`), filled by the server at write time, never rendered
into a block, never sent to a selection provider.

The installation-wide scopes (`role:*:<role>`, `machine`) are the company
scopes: in a team installation the installation is the company.

### 3.2 Who may see a member's rules

"Own rules" is settled by delivery: a member's rules go only to that
member's agents. Whether teammates may read them is not settled anywhere, and
the level-2 decision constrains the answer: members of one workspace already
read each other's conversations in shared projects (who-did-what is a goal of
the sign-in design), and a delivered block is inside the agent's transcript
for Codex (§1.1). Two coherent choices:

- **(a) Owned, visible to the workspace (recommended, Q3).** Delivered only
  to the member's agents; readable by everyone in that workspace and the
  owner, in the rules window and wherever their conversations show it; never
  delivered, shown or searchable in another workspace, including after the
  project moves (§4.6). The project curator pass may run in the project's
  audience.
- **(b) Private to the member and the owner.** A rule can reach a transcript
  in three ways: the frozen block, a recall through `search_memory`, and a
  parent passing text to a child. Stamping only conversations whose block
  carried member rows misses the other two (the second critique showed
  both). Under (b) the audience is therefore fixed at launch: every
  member-bound conversation is `member:<m>` from its first byte, and its
  children, forks, resume and migration successors inherit it (§4.6). A
  teammate then sees none of that member's agent transcripts in shared
  projects (cards, tasks, pipeline states and events stay). That narrows the
  2026-10-20 level-2 picture, in which members of a workspace see each
  other's work there; Q3 (b) says so. The curator's member-reading passes run
  in the owner's audience. Acceptance under (b): a teammate's log
  subscription to the member's conversation is refused from its start, so a
  rule the member's agent recalls later never reaches it; a clean-memory
  child that agent launches with the recalled text in its prompt is refused
  to the teammate by id, in transcript search and in the export.

Both options rest on one invariant, which §3.3 and §4.6 enforce: **an agent's
read is authorized against the audience of the transcript it writes into,
never against the person who launched it.** A tool result, a recalled rule or
a child's prompt therefore never reaches a reader that the source's own
audience excludes. The predicate of §3.3 and the audiences of §3.4 take
either answer as one setting; everything else in this document is the same
under both.

### 3.3 One rule-access predicate

Today the window and its routes are owner-only, search filters by project
only (`roleSearch.ts:6-14`), the projection carries why, versions and lineage
(`roleStore.ts:592-611`), and the route's POST acts on any rule id
(`route.ts:29-35`). Opening any of this to members needs one server-side
predicate, `ruleAccess(actor, rule)`, in a new module beside `roleStore.ts`,
returning `none | read | write`. It decides by the rule's scope **and** by
the row's state; scope keys alone cannot separate an owner-only proposal from
an active row in the same scope.

**Actors.** People act as themselves. An agent acts as the narrowest reader
of the transcript it writes into (its audience, §4.6), so whatever it reads
is already readable by everyone who can read its transcript:

| Actor | Reads as |
| --- | --- |
| Owner session; agent whose audience is `owner` | the owner |
| Manager or member session | that person |
| Agent with audience `member:<m>` (Q3 b) | member m, limited to the conversation's origin workspace |
| Agent with audience `project` and origin workspace w | any member of w: only rows every reader of its transcript may read; member scopes of w only under Q3 (a) |
| Agent with audience `project` and no origin (history that follows its project, §4.6) | only rows that follow the project: its role and project scopes and the company scopes |

Agents never use the window's mutations; their writes go through the lesson
routing of §3.1 and the curator's apply. In an installation with no workspace
every actor reads as today, so a solo installation sees no change.

**Scope and state.**

| Rule's scope | Read (active and reserve rows) | Write (keep, return, delete, restore, revert) |
| --- | --- | --- |
| `role:<p>:*`, `project:<p>` | people with `access(p) ≠ none` (`workspaceAccess.ts:43-48`) | owner; managers of w(p) |
| `workspace:<w>` | members of w; owner | owner; managers of w |
| `member:<m>:<w>` | (a) members of w and owner; (b) m and owner | owner; m for delete and return of their own rows |
| `role:*:<r>`, `machine`, `swarm:<r>` | every active member (their agents receive them) | owner |

| Row state | Read | Write |
| --- | --- | --- |
| active, reserve (archived for `budget`) | as its scope | as its scope |
| version, archive for any other curator reason | as its scope | as its scope |
| archived as `deleted` by a person, `rejected` | owner only | owner only |
| `proposed` (§3.5) | owner only | owner (approve, reject) |

**Where it runs.**

- Search (`search_memory`, the window's search) and open by id: the SQL that
  already filters by scope keys (`roleViewSource.ts:366-369`) also filters by
  the states the actor may read, so ranking, the result limit and the
  `truncated` flag see only readable rows. An unreadable id answers as
  unknown, so existence is not revealed.
- Family traversal and histories: each linked id (`parent`, children,
  `derivedFrom`, `mergedFrom`, `splitFrom`, `movedFrom`, `overrides`,
  `versions`) passes the predicate, or is shown only as a count of rules the
  reader cannot open, with no text, why or member. The `why` of a promoted
  rule is the curator's own text; sources' why stays with the sources.
- Selection candidate assembly (§3.7) and recall (§2.3), as the agent actor.
- Every mutation: the route resolves the rule, requires `write`, and requires
  the rule's scope to be readable through the project the request names;
  `revert-pass` stays owner-only.
- **The view cache.** The memo keeps one rendered view per project
  (`roleStore.ts:624-686`, keyed by state file and project at `:649`), and the
  view builder includes non-active rows (`:710-713`). The memo stays
  actor-independent. Every read, cold or warm, passes the cached view through
  `authorizeView(actor, view)`, a pure filter that applies the two tables
  above to every scope, row, version and link and replaces hidden links by
  counts. Nothing per actor is cached, so no warming order can serve one
  actor's view to another. Its cost is one pass over the project's rows per
  request; slice T1 measures it before and after on the same state copy.
- Acceptance: an owner and a member of one workspace in a single-workspace
  installation, with a proposed machine row and a deleted archive as
  canaries, request the rules window cold, owner first then member, and
  member first then owner. The member's answers never carry either canary;
  the owner's always carry both.

What leaves the machine is unchanged in kind: member rows go to the engine
provider in their member's own agents' instructions and to the selection
provider as redacted candidate text for that member's launches; the member id
and tags are never sent. Members are covered by the owner's provider choice
in Settings; no separate consent exists or is added.

### 3.4 Every process that reads rules, and its audience

| Process | Reads | Transcript and output audience |
| --- | --- | --- |
| A member-bound stage or seat | its own scopes (§3.7) | its conversation's audience (§4.6): `project` with its origin workspace under Q3 (a); `member:<m>` from launch under Q3 (b) |
| Project curator pass (`run.ts:31`, launched in the project's directory) | today's scopes of the project; plus `workspace:<w(p)>` and the member scopes of w; other-project evidence (`read.ts:68`, `roleViewSource.ts:351`) restricted to projects of the same workspace (the Unassigned group counts as one) | `project` under Q3 (a); `owner` under Q3 (b). Its final message names ids only (`brief.ts`), and its reports carry counts |
| Company pass (new, one per installation per curation cycle, team installations only) | workspace scopes of every workspace, `role:*`, `machine`, and other-project evidence across workspaces; proposes company rows (§3.5) | `owner`; it starts from the installation's own directory, never a project's |
| Swarm pack pass (maintainers) | approved installation rows only | unchanged |

Today's other-project evidence is already a cross-workspace path: a pass for a
project in workspace A reads same-role rules of projects in workspace B, and
after #3415 its transcript is readable by A's members by project. T4 closes it
with the restriction above. The curator's scope read (`read.ts:63-68`) also
applies the pass's audience the way §3.3 applies an actor's: links from
company rows (`derivedFrom`, `movedFrom`, `mergedFrom`) to rows outside the
pass's workspace come back as counts. Acceptance: a canary in a workspace-B rule is
absent from every transcript, search result, report and artifact readable by
a workspace-A member after a curation cycle; under Q3 (b), a canary in member
A's rule is also absent from everything readable by teammate B.

### 3.5 How the curator synthesizes upward, and the widening gate

The ladder; each step writes a rule in the wider scope with `derivedFrom`
naming its sources, links sources as children through `parent` where §2.4
allows, and keeps the sources:

```
member:<m>:<w>  ──┐
member:<m2>:<w> ──┼──►  role:<p>:<r> / project:<p> / workspace:<w>  ──►  role:*:<r> / machine  ──►  swarm pack
                  ┘          (the workspace's team)                      (company)                 (every installation)
```

| From | To | Criterion | Approval |
| --- | --- | --- | --- |
| Member scopes of two or more members of w | a project or role-here scope of w, or `workspace:<w>` | One class, each source applied on at least one request or a correction; the target is the widest scope all readers act on (check 4, applied inside w) | The curator, as it widens rules today |
| One member's rule | the same targets | Applied on two or more tasks, never misled, and nothing in it is personal to the member | The curator |
| Role-here rules of two or more projects of w | `workspace:<w>` | One class, every role in w acts on it | The curator |
| `workspace:<w>` rules of two or more workspaces, or a workspace rule naming no workspace, project or member term and applied on two or more tasks | `role:*:<r>` or `machine` | Company pass only | **Proposal; the owner approves** (Q4) |
| Installation rules | swarm pack | Swarm design §3.1 item 7, from approved rows only | Maintainers and the operator, unchanged |

**The gate is on the result.** In a team installation (any workspace
exists), no write may make a company-scope row active by itself, whatever
path produced it. In `curation/apply.ts` and the lesson write path, a write
whose result would be an active row in `role:*` or `machine` becomes a
`proposed` row instead:

| Path | Becomes |
| --- | --- |
| A new principle or promoted rule in a company scope | proposed row |
| `move` into a company scope (`apply.ts:125-129`) | proposed copy; the source stays active where it is until approval |
| A `split` part targeting a company scope (`:130-145`) | proposed part; the other parts apply |
| A `merge` whose survivor is a company row and any source is not | proposed new survivor text; the existing survivor and sources stay |
| A `rewrite` of an active company row | proposed version; the active text stays |
| A `restore` of a company row never approved | proposed row; a row active before (approved, or older than the team) restores as today |
| A `machine` lesson from an installation conversation in a workspace project (§3.1) | proposed row |
| The operator's own root conversation | applies directly (the owner is the approver) |

Approval activates the proposal and completes the operation it stands for
(the move archives its source as moved, the merge archives the old survivor
as merged, the rewrite becomes the new version). Rejection archives it with
reason `rejected`; its sources are untouched. `RuleState` gains `proposed`;
a proposed row is in no scope's active list, so selection, whole delivery,
swarm eligibility and every count ignore it without new checks. A solo
installation creates no proposals and keeps decision 1 exactly.

Acceptance: in a two-workspace fixture, every path in the table, starting
from member or workspace material, leaves no active company row and no
delivered line until the owner approves; the same paths on a solo fixture
apply as today.

### 3.6 Conflicts between a member and the team

The first version rendered member rules first and claimed that settles a
conflict. It does not: render order does not decide which of two opposing
lines an agent follows, and packing can drop the member's line while an
always-on team principle stays (`roleRender.ts:51-78` only concatenates and
trims). Check 6 also forbids opposing active pairs (`brief.ts:13`), which
would archive a team rule that is right for everyone else.

The policy is reader-specific precedence through `overrides`:

- A narrower rule may override a wider one its readers also read (validator,
  §2.4). In check 6 the curator links the two and archives neither when
  they are in different audiences; opposing rules in one audience are
  resolved as today.
- A correction may name the delivered rule it corrects (a new `corrects:
  <id>` argument on `leave_lesson`); the server validates that the caller's attempt received
  it and stores `overrides` at once, so the precedence holds before the next
  curator pass.
- **Before scoring**, for each reader, every candidate overridden by another
  candidate of that reader is removed, from the always-on set and from the
  pool alike. It stays removed on every path, so an overridden wider rule
  never comes back through a fallback.
- **The always-on set is then recomputed** for that reader, under the same
  3 000 code points of rendered lines (`alwaysOn`, `roleSelect.ts:20-28`):
  the walk runs in curator order, and an overriding rule takes the position
  of the rule it replaced. An override is protected only if its line still
  fits the 3 000 code points left at its position; one that does not fit
  becomes an ordinary candidate, scored and packed like any other row, or
  left out. The protected set therefore never exceeds 3 000 code points,
  which is at most 12 000 bytes even for four-byte text, so it always fits
  under the 24 000-byte cap with its headings, and the renderer never has to
  cut a protected line or refuse a launch (#3611's renderer throws only when
  the protected lines alone exceed the cap, PR `roleRender.ts:58`).
- Then scoring, BM25 fallback, whole fallback and packing run as in §2.3.
- Frozen per attempt, as everything else: a resume delivers the same
  resolution.

Acceptance: (1) with a member rule overriding an always-on workspace
principle and a pool under byte pressure, member A receives the member rule
and not the principle; member B receives the principle; a resume of A's
attempt renders the same block. (2) The critique's expansion case: forty
short machine principles fill the always-on set (about 2 800 code points)
and forty 300-character Cyrillic project practices override them for one
reader, which made a 24 059-byte block under the first revision's rule. On
the provider path, the BM25 path, the whole fallback and a resume, the block
is at most 24 000 bytes, the protected lines total at most 3 000 code points,
no overridden principle appears, and the overrides that did not fit are
recorded as scored or `pool-bound`.

### 3.7 Delivery to stages and seats

- A **member-bound conversation** reads its role here, role on every
  project, project, machine, `workspace:<w(p)>`, the swarm scope when on, and
  the rows of `member:<m>:<w(p)>` whose tags match (project equal or absent,
  role equal or absent).
- An **installation seat** of a workspace project reads its role scopes, the
  project, the machine and `workspace:<w(p)>`. Its block is frozen per start,
  so member rules reach it only through promotion. A seat bound to a member
  (#3415's seat principal) reads that member's scope.
- An **owner** conversation reads what it reads today plus the workspace
  scope of its project.
- A project in no workspace reads exactly today's scopes.

### 3.8 What the rules window shows

The window's routes move from `owner` to `project` (`workspaceRoutes.ts:133-135`)
with the predicate of §3.3 deciding every row and action. A member sees, for
a project they can act in: the role and project scopes, the workspace scope,
the member scopes the predicate allows (Q3), and the company scopes read-only
with redacted provenance. The owner additionally sees proposals with approve
and reject.

### 3.9 Relation to swarm

The swarm pack is the top rung of the same ladder and stays as built; its
slices 2 to 4 are untouched. A pack candidate comes from approved installation
rows only, so neither member nor workspace text reaches it without first
passing the owner's gate.

### 3.10 Native engine memory: the same fence

`search_memory` returns the engines' own memory beside the learned rules
(§1.1): account-home instruction files and rules, Codex `AGENTS.md`, Codex
memories and rollout summaries, and skills, all indexed as `global`, plus
Claude project memory as `project`. Search, short-id resolution and open by
id admit every `global` entry whatever project the caller names
(`index.ts:282`, `:313`, `:322`), and #3415 leaves that unchanged. The second
critique reproduced it in an isolated export: an owner-only synthetic Codex
preference was found and opened under another project's filter. None of the
rule guards above touches this path, so it gets its own.

1. **An audience per native entry, set at indexing.** `memory_entries` gains
   `audience`:
   - `project` for Claude project memory (`sources.ts:59-76`). It follows its
     project like the project's rules (§4.6 lists what moves with a project).
   - `owner` for every `global` entry (`sources.ts:57-58`, `:78-86`).
     Codex memories and rollout summaries summarize the sessions run on that
     home, which can include owner runs.
   - `shared` for a global source the owner chose to share, by source path,
     in the memory settings. Nothing is shared by default.
   - Existing rows: the index migration sets `owner` on every global row and
     `project` on project rows before the first search after upgrade, and a
     row it cannot classify is `owner`.
2. **Authorization before ranking, counting and opening.** The search SQL
   replaces `OR e.scope = 'global'` by an audience clause computed from the
   actor of §3.3: the owner reads all; any other actor reads `shared` rows and
   `project` rows of projects it may read. In an installation with no
   workspace the clause stays today's, so a solo installation's agents keep
   their present search. The same clause goes into
   short-id resolution, so an ambiguity answer counts only readable rows, and
   into open, so an unreadable id answers as unknown and no `memory_offers`
   row is written for it. The result limit and `truncated` flag are computed
   after the clause. The learned-rule half of the search
   (`searchRoleRules`, `index.ts:288`) already goes through §3.3.
3. **The engines' own loading.** Search is one path; the engines also load a
   home's memory into the agent themselves. In a workspace project:
   - a member-bound launch, and any launch whose audience is `project`,
     starts Codex with its memories off through the existing switch
     (`engineMemoryOff`, `source.ts:81-85`, applied as
     `features.memories=false` at `cli.ts:550` and `:712`), unless the owner
     shared that home's memory. Claude's auto memory is project memory and
     stays on;
   - a launch whose audience is `owner` (owner runs, voice sessions, the
     operator's root conversations) starts with the engines' memory off, so
     it writes nothing of the owner's private messages into the project's
     memory, which the project's members' agents load.
   Instruction files (`CLAUDE.md`, `AGENTS.md`) and skills are configuration
   the engine loads whatever the switch says. An account in a workspace pool
   therefore gives that workspace's agents its home's instruction files and
   skills; the pool editor says so (§4.3). Delegatus's own role memory is not
   affected by any of this.

Residual, named: the files of the account homes stay readable from any
agent's shell (P7 in §4.5). What an owner-audience agent writes into the
repository itself is project content; this fence does not cover it.

Acceptance: an owner-audience canary in a Codex memory file and in a home
instruction file of an account home is absent from a member's project-scoped
`search_memory`, from a project-audience agent's search, from the result
count and `truncated` flag, and answers as unknown by full id and by short
id, while a source the owner shared answers both; a member-bound Codex launch
in a workspace project starts with `features.memories=false`; an owner run in
a workspace project starts with the engines' memory off.

## 4. Workspaces: what is left to give each member their own fenced seat

### 4.1 The boundary at each layer

"Exists" means on `main` at `6eb1901b5`; "(c)" means in PR #3415.

| Layer | Boundary today | Gap | Closes in |
| --- | --- | --- | --- |
| Sign-in | A member session cookie; no key handed to a teammate (`src/lib/team/gate.ts:107-120`) | None for this requirement | – |
| UI | Rail, phone sheet, Team page and `/api/files` projected to the member's workspaces (`workspaceProjection.ts:9-38`) | Rules window owner-only (§3.8); no member-readable account list for the engine chip (§4.3) | T6, W4 |
| HTTP routes | Every route has a decision; `project` routes resolve every identity (`workspaceRoute.ts:170-245`) | The check is by the conversation's current project only, so an owner-private conversation in a shared project answers `/api/log` (`src/app/api/log/route.ts:34-49`), the log stream and the runtime projections (`workspaceProjection.ts:40-69`), and a moved project's whole history follows it | W2a to W2c (§4.6) |
| MCP | On main: tools take `project` freely. In (c): closed tool list, identities resolved, installation tools refused for member-bound callers | Conversation tools check by project only, through the fence's own resolver copy (PR `workspaceFence.ts:74-77`, `:125`); `search_memory` admits installation-global native entries (§3.10); owner-launched workers keep installation reach | W1, W2a, W2d, W3, N1 |
| Filesystem | HTTP and MCP resolve `cwd` to a project | The agent's shell runs as the installation's OS user (workspaces design §6) | Level 4 only (§4.5, Q6) |
| Process | One transient scope per agent with `MemoryMax`; operator and work slices; worker limit per machine and per project | No per-workspace grouping, aggregate limit or worker share | W5, W6 (§4.7) |
| Accounts | Installation pool. Per-project bindings steer automatic selection and the one-click reseat (`allowedAccountIdsForProject`, `src/lib/accounts/projectBindings.ts:439-451`) and refuse an `account` pin outside the pool (`src/lib/agent/spawnCommand.ts:944-952`). A deliberate `accountId` override is classified and journaled, never refused (`projectBindings.ts:460-469`, `spawnCommand.ts:1182-1190`, #1279), and a resume keeps its recorded account (`spawnCommand.ts:956-957`). On main, then, a binding steers defaults and refuses only the `account` pin. (c) adds per-workspace pools and refuses any account outside the allowed list for a member-bound launch | No member-readable account list (§4.3); the owner's deliberate choice stays unrefused by decision | W4 |
| Telegram | One bot; per-project report chat; (c) adds per-workspace report and directive chats and keeps another workspace's chat and the owner's private chat out of a manager's reach | Paired clone as a project's poster unbuilt (§4.4) | W7 |
| Relay | One pairing, one owner identity per installation; owner tools behind a switch | §4.5 | W3, Q6 |
| Memory | Scopes per role, project, machine; native entries without an audience | §3, §3.10 | T1–T6, N1 |

### 4.2 Land slice (c): what PR #3415 needs

The PR's content matches the 2026-10-20 decisions. What stands between it and
main: four red checks at `4e0bd2688`, a last fix the review budget did not
cover, and a base that moved after the refresh lane's review of 2026-11-03
02:29 UTC. The next step is the refresh lane's: merge current main by merge
commit, repair branch-only failures per the hook's selection run on branch
and main, one resolution review. Nothing here changes (c)'s scope. Two notes
for the resolution reviewer: the fence's `leave_lesson` refusal is what T2
turns into member routing, and the principal resolution of
`workspacePrincipal.ts` is what every T slice reads.

### 4.3 A member chooses a Claude or Codex subscription

What exists: a spawn names an engine and optionally an account; (c) admits
a member-bound launch only on an account in the workspace's allowed list.
What is missing is the list a member chooses from: the engine chip fetches
`/api/accounts`, an owner-only route that also carries login and management
state.

**Slice W4.**

- `GET /api/team/accounts?project=<p>` with decision `project`: for each
  engine, the accounts allowed for that project for this actor (the
  workspace pool after (c), the project binding, else the installation
  pool), each with id, the owner-set label, plan tier and an
  available/limited state from the existing limit windows. No login,
  terminal, policy, credit or home field. Labels are the owner's names for
  accounts; the owner is told in the pool editor that members see them, and
  that the engines give every agent on an account its home's instruction
  files and skills (§3.10).
- The engine chip and the new-agent form use this projection when the
  session is a member's; the owner's chip keeps `/api/accounts`.
- Launch: the request's engine and account, as today. The server check is
  (c)'s refusal; the projection is a convenience and never the gate.
- Acceptance: a member picks an allowed Claude or Codex account for a launch
  and the launch runs on it; a request naming another account is refused by
  the server; the member's session gets 403 from every `/api/accounts*`
  route and cannot change an installation default.

A saved per-member default engine or account was in the first version; the
requirement asks for the choice, which the per-launch picker gives, so the
preferences table is deferred.

**Members' own logins.** Bringing their own subscription means a CLI login
into an account home every agent on the machine can read (sign-in design,
level-2 limit). Q5 asks; the recommendation is pool-only.

### 4.4 Report destination through a paired clone

The 2026-11-02 design's Part 1 is the answer: `reportTelegram.poster` names
the clone, set through `seat_tick_settings.reportPoster` by the operator root
or the project's designated seat, resolved from the reporting seat's own
project, with `clone_not_in_report_chat` and the other refusals
(per-project-relay-clone §5.1). For workspaces: a manager's report chat is
already fenced by (c) (`assertProjectReportDestination`,
`workspaceDefaults.ts:58`); a clone may be chosen only when the clone
directory lists that chat under it, which Part 1 already requires. Workspace
defaults gain no poster field; the poster follows the project's chat.

### 4.5 Members and the owner's private conversations: the paths

Sources: the code, and the audit lane's two stages of 2026-11-03 (§0.2).
"Member-bound caller" is a conversation with a member principal under (c).
"Owner-launched worker" is an agent the owner spawned, or an installation
seat, in a project a workspace also holds.

| # | Path | What it returns | Who reaches it on main | After (c) | Close |
| --- | --- | --- | --- | --- | --- |
| P1 | MCP `relay_owner_history` | The owner's groups where the relay bot or a clone is present, with messages, while the owner-tools switch is on. The audit read 50 group records and one message through it | Root, seats, stages and member agents (route guard `src/lib/externalRelay/routeGuard.ts:46`) | Refused for member-bound callers | W3: admit only the operator root conversation and conversations in the owner audience |
| P2 | MCP `relay_service_tools`, `relay_answer` | Service tools for the message being answered | Only inside a live owner run | Same | None beyond P3 |
| P3 | Owner runs, the owner's root conversations, voice sessions, and the private owner-to-clone relay, as transcripts | An owner run is a root conversation whose prompt carries the owner's private message (`src/lib/externalRelay/ownerRun.ts:896-901`), grouped under the target project | Anyone with the project: `/api/log`, the log stream, runtime projections, `conversation_messages`, `search_transcripts`, exports | Member-bound callers may read it when the project is in their workspace | W2a to W2d: the owner audience on these records, checked on every path (§4.6) |
| P4 | The project seat's conversation | The workspace's shared board chat | Anyone with the project | Same | Stays shared by design; the owner's own root conversations are P3 |
| P5 | MCP `telegram_bot_messages`, `telegram_bot_chats` | Messages the bot received in any chat it knows, its private chats included (`src/lib/mcp/server.ts:3988-3990`; audit: root, stages, owner relay and member agents) | Any agent | Refused for member-bound callers | W3: a project-bound caller reads only its project's and workspace's report and directive chats; the operator root keeps today's reach |
| P6 | HTTP relay, bot and owner-history routes | Owner-only (`workspaceRoutes.ts:48-60`, `:214-217`) | Owner | Same | None |
| P7 | The shell: relay store with raw owner turns (`src/lib/externalRelay/store.ts:107`), bot store (`src/lib/telegram/bot/store.ts:270-284`), `team.sqlite`, account homes, transcripts, and the pairing credential, which lets any process call the relay's owner-history and clone-catalog APIs directly (verify stage: 50 group records without the Viewer route) | Everything above, raw | Any agent's shell (one OS user) | Same | Level 2 cannot close it; level 4 does (Q6) |
| P8 | A personal Telegram transport configured on this machine for the operator's own account | The operator's personal dialogs: the audit read one personal message through it from a stage's shell | Any agent's shell; a seat can also grant its MCP form to a child (`src/lib/agent/spawnCommand.ts:702-728`) | Same; (c) does not cover a shell | Outside Delegatus's fence. Removing this transport's credential from this OS user closes P8 only; P7 stays (Q6) |
| P9 | Child-agent delegation | A worker launched from an owner-audience conversation can carry the owner's message in its prompt | Anyone with the child's project | Same | W2a: a child, fork or successor of an owner-audience conversation inherits the owner audience (§4.6) |

The verify stage also named the scheduled report's MCP grant
(`mcpServersForScheduledReport`, `src/lib/agent/mcpAllowlist.ts:185`) as missing from the audit's report; this design adds
no reach to it, and its content is left to that lane's corrected report.

What the owner should hear: inside the Viewer, MCP and Telegram surfaces,
(c) plus W2a to W2d, W3 and N1 close every path from members and their
agents to the owner's private conversations. Outside them, any agent's shell
on this machine runs as the installation's one OS user, and that user can
read P7 (the relay store's raw owner turns, the bot store, owner-run
transcripts in the shared account homes, `team.sqlite`) and can call the
relay's owner-history API with the pairing credential, which the verify stage
did (50 group records, no Viewer route involved). P8 adds the operator's
personal dialogs. Removing P8's credential closes P8 and nothing else.
Members' agents can therefore disclose the owner's private conversations
through an ordinary request to read a file, with no exploit. At level 2 the
10:55 words "never through the relay or a clone" hold for Delegatus's
surfaces only; holding them against an agent's shell needs the owner's
private state and credentials under a different OS user from the members'
agents. Q6 asks which the operator wants, and names each option's remaining
access.

### 4.6 The conversation audience

One field on the registry's conversation record, beside its durable project
authority (`projectOwnership`, `src/lib/agent/registry.ts:707`), stamped
when the launch receipt is created (`registry.ts:322-341`) and never
recomputed from current state:

```
audience: {
  kind: "owner" | "project" | "member";   // "member" only under Q3 (b)
  member?: string;                         // kind "member"
  origin: string | "unassigned" | null;    // workspace at launch; null = follows its project
}
```

**Kind at launch.**

- `owner`: owner runs and the private owner-to-clone relay, voice sessions,
  the operator's root conversations, the company curator pass.
- `member`: under Q3 (b), every member-bound conversation.
- `project`: everything else (stages, seats, member launches under Q3 (a),
  project curator passes).

**Origin at launch.** The workspace of the conversation's project when it is
placed in one; `unassigned` for a member-bound launch in an Unassigned
project (only managers can make one); `null` for any other launch in an
Unassigned project or in an installation with no workspace. A `null` origin
means the record carries nothing bound to a workspace: no workspace or
member rows are delivered there (§3.7), and its reads are limited to what
follows the project (§3.3 actor table).

**Inheritance.** A child (`parentConversationId`), a fork (provider fork
paths stay on the same record), a resume successor and a migration successor
(`purpose`, `supersedes`, `registry.ts:322-327`) take the narrower of the
parent's or predecessor's audience and the one their own launch would get:
`owner` wins over everything; `member:<m>` wins over `project`; two
different origins, or a `null` parent origin launching into another project,
give `owner`. So nothing a parent passes a child reaches a wider readership,
whatever the child's own block holds. A new generation of an existing record
(a seat's restart, a resume in place) narrows the record's audience the same
way before its block is built: a `null`-origin seat whose project is now in w
becomes origin w before it receives any `workspace:<w>` row. An audience may
narrow; nothing ever widens it.

**Who may read a record.** `conversationReadable(actor, record)`:

| Kind | A person may read it when | An agent may read it when |
| --- | --- | --- |
| `owner` | they are the owner | its own audience is `owner` |
| `member` | they are the owner, or they are member m and pass the `project` row below for the record's origin | its own audience is `owner`, or `member:<m>` with the same origin |
| `project`, origin w | they are the owner, or they have access to the current project and belong to w (a manager of w counts; for origin `unassigned`, a manager) | its audience is `owner`, or it is a `project` or `member` conversation with origin w |
| `project`, origin `null` | they have access to the current project (today's rule) | its audience is `owner`, or it is a `null`-origin conversation of the same project |

**Moves.** After a project moves from workspace A to B, its records with
origin A are readable by the owner and by people in both A and B; B's other
members see the project's history from the move on, plus every `null`-origin
record, which follows the project as all history does today. The legacy
records of an installation that only now creates workspaces have `null`
origin (below), so moving existing projects into new workspaces keeps their
history visible there. What moves with a project, and is therefore visible to
its new workspace, is everything the project owns: its repository and files,
its rules (`role:<p>:*`, `project:<p>`), its Claude project memory, its
tasks, cards and pipeline records. Transcripts with an origin, workspace rows
and member rows stay. Handing earlier transcripts over to the new workspace
is deferred.

**Existing records.** The first read after upgrade computes the audience
once from facts already stored and writes it: `owner` for the relay store's
owner-run records, voice sessions and root conversations with no parent, no
pipeline attempt, no seat role and no member message author; `project` with
origin `null` for the rest, since no workspace or member rows existed before
these slices. A record whose facts cannot be read is `owner`. The owner keeps
access to everything.

**One resolver, fail closed first.** Today HTTP identities, projections and
both streams resolve a conversation to its project through one function
(`workspaceConversationResolver` and `workspaceConversationProject`,
`workspaceRoute.ts:34-56`), and #3415's fence has its own copy (PR
`workspaceFence.ts:74-77`). Slice W2a makes both call one resolver that
takes the actor and returns the project together with the audience, and
answers "no project" to every non-owner actor for `owner` and `member`
records. Every surface that already denies a conversation without a project
then refuses those records, from the first slice on. The origin check needs
the person or the caller's own audience, so W2b to W2d add it, with what a
resolver cannot do alone, surface by surface:

| Surface | What it needs beyond the resolver | Slice |
| --- | --- | --- |
| HTTP reads and actions: `/api/log` (tail, history), `/api/log/provenance`, `/api/log/preflight`, `/api/log` DELETE, `/api/log/project-delete`, `/api/logs`, `/api/artifact`, conversation actions (send, answer, resume, migrate, kill) | the identity check (`workspaceRoute.ts:178`, `:212`) calls `conversationReadable` with the person, so a manager of A who is not in B is refused an origin-B record in a project now in A; refusal looks like an unknown conversation | W2b |
| Projections and streams: files rows, runtime sessions, attentions, recent operations, the log stream, runtime events | `workspaceProjection.ts:9-69` and `src/app/api/logs/stream/route.ts:14-20` filter rows by `conversationReadable`; both already re-read the person's scope per batch or event (`:17-20`, `workspaceProjection.ts:62-68`), so a move or a revoked membership takes effect on an open subscription | W2c |
| MCP and search: every conversation key the fence resolves, `list_conversations`, `conversation_messages`, `get_conversation`, `search_transcripts` (filtered in `src/lib/search/projectScope.ts` before ranking and counting), `get_pipeline` full transcripts | the agent column of the table above, from the caller's own audience | W2d |
| Exports: activity transcript export | `src/lib/activity/transcriptExport.ts` filters by `conversationReadable` | W2d |

Acceptance, per slice, with three canaries: an owner-run record, an origin-A
record in a project moved to B, and (under Q3 b) a member-audience record.
Each surface refuses each canary to a member session and to a member-bound
or project-audience agent that may not read it, answers the owner, and
answers a person in both A and B for the origin-A record; search hit lists,
result counts and `truncated` flags are identical with and without the
canaries; an open log stream subscribed before the move stops delivering the
origin-A record's lines to a B-only member at the next batch; a resume of
the origin-A record by the owner keeps origin A.

### 4.7 Resource containment per workspace (slice d)

The approved level 2 puts a runaway workspace's agents inside its own
resource boundary (workspaces design, level 2 row). The resource workspace
is the workspace of the admitted project at launch, for every origin: a
member's, the owner's, a seat's, a stage's, the curator's. Human authority
does not enter.

What exists, and must keep holding (`src/lib/runtime/cpuPlacement.ts`):
operator hosts (every host that is not a pipeline or flow member,
`:67-70`) run in `delegatus-agents.slice` with a high weight and no quota;
pipeline and flow hosts, headless runs and gates run in
`delegatus-agents-work.slice` (`:24-25`), each scope with its own quota, and
that slice carries the one aggregate work quota, three quarters of the
online CPUs by default (`:37-39`, set by `systemctl set-property` at
`:224-235` with `workSliceProperties`, `:121-124`). Gates set the same slice
and quota from `scripts/gate-slot.sh:107-110`.

- **Slices.** A workspace's work goes to `delegatus-agents-work-<w>.slice`.
  systemd names nest by dash (`systemd.slice(5)`: `foo-bar.slice` lies
  within `foo.slice`), so this slice is a child of
  `delegatus-agents-work.slice`, and the aggregate quota on that parent caps
  the sum of every workspace's work by the cgroup hierarchy. `<w>` is the
  workspace id escaped with `systemd-escape`, so a dash in it adds no level.
  Work in an Unassigned project, gates and headless runs stay directly in
  `delegatus-agents-work.slice`, under the same quota.
- **Per-workspace properties.** `CPUWeight` from the workspace's share, and
  `MemoryMax` from its memory share. An optional `CPUQuota` per workspace is
  its share of the aggregate, never above it; any value, and any sum of
  shares above 100 %, is still capped by the parent. Per-agent scopes keep
  their own `MemoryMax` and quota (`agentMemory.ts:84-89`).
- **Operator hosts are unchanged.** They stay in `delegatus-agents.slice`,
  uncapped and with the high weight, whoever launched them, as the existing
  operator workload policy says. A member's interactive conversation is such
  a host; it is bounded by its own scope's `MemoryMax` and counted by the
  worker share at admission, and it is outside the workspace's CPU and
  memory ceiling. Moving interactive hosts under a workspace ceiling would
  change that policy for the owner's own sessions too, so it is deferred.
- **Shares.** Workspace defaults (from (c)) gain `share: { workers,
  cpuPercent, memoryPercent }` set by the owner. Worker admission
  (`src/lib/operator/workerLimit.ts:37-56`) counts running workers per
  resource workspace against `workers`.
- **Platform fallback.** Where per-agent scopes are unavailable (macOS,
  Windows, a container, no user manager), there are no slices; the worker
  share still applies at admission, and the Activity panel shows workspace
  containment off with the reason. A launch is never refused for a missing
  workspace slice (operator decision of 2026-10-20 on boundaries); work keeps
  today's refusal when CPU placement itself is missing (`cpuPlacement.ts:215-219`).
- **Adoption, resume, moves.** A running process stays in the slice it
  started in (systemd does not move scopes between slices); a resume or a
  new generation starts in its project's current workspace slice. Moving a
  project to another workspace affects its next process only, and the
  Activity panel attributes usage by the slice the process ran in.
- Acceptance, on a real user manager in an isolated test: (1) the cgroup path
  of a workspace's stage scope has `delegatus-agents-work.slice` as an
  ancestor, and that ancestor's `cpu.max` equals the configured aggregate
  quota; (2) two workspaces each with a 100 % share run CPU burners, while
  Unassigned work and a gate run beside them, and the parent's `cpu.stat`
  `usage_usec` over a 10 s window stays within the aggregate quota (with the
  measurement tolerance stated); (3) an operator host launched during the
  test still runs in `delegatus-agents.slice` with no quota; (4) a synthetic
  process exceeding one workspace slice's `MemoryMax` is killed inside that
  slice while a process in another workspace's slice keeps running.

### 4.8 Threats considered, and where each is refused

| Threat | Refused by |
| --- | --- |
| A member names a foreign project, task, pipeline, conversation, cwd or selected card | Human routes resolve each to its project (#3255); MCP fence resolves identities before receipts ((c)) |
| A member's agent calls an installation tool | Not in the project tool list ((c)) |
| A member's lesson or correction reaches teammates' agents without review | Member scope (§3.1); sharing only by promotion (§3.5) |
| A member opens a foreign rule by id through a permitted project, or walks to it through a shared rule's family | `ruleAccess` (§3.3) |
| Text from one workspace becomes a company rule | Proposal and owner approval on every path (§3.5) |
| A curator transcript carries another workspace's rules | Evidence restricted to the workspace; company pass in the owner audience (§3.4) |
| A member reads the owner's relay, root or voice conversations through a shared project | Conversation audience on every surface (§4.6) |
| A project moves from A to B and B's members read A's transcripts, which carry A's member and workspace rows | Origin workspace on the record (§4.6) |
| A member's private rule (Q3 b) reaches a teammate through a recall result or a child agent | Reads authorized against the caller's transcript audience; member audience from launch, inherited by children, forks and successors (§3.2, §3.3, §4.6) |
| An owner's native engine memory (Codex memories, home instructions, skills) is searched or opened from a member's project, or loaded into a member's agent | Native entry audience in SQL before ranking and short-id resolution; Codex memories off for project-audience launches in workspace projects (§3.10) |
| A cached rules view warmed by the owner is served to a member | Actor-independent memo, per-read authorization by scope and row state (§3.3) |
| Two workspaces with full shares exceed the machine's aggregate work CPU | Workspace work slices nest under the aggregate work slice (§4.7) |
| A member's agent reads owner history or bot messages | (c) for member-bound callers; W3 for owner-launched workers in shared projects |
| A member's launch names an account outside the workspace pool | Refused at admission ((c)) |
| A revoked member's old conversation keeps reach | The principal survives revocation and loses authority (`workspacePrincipal.ts:13-15`) |
| One workspace's runaway agents starve another | Workspace slice and worker share (§4.7) |
| A member's agent reads state files, credentials or another checkout from its shell, calls the relay with the pairing credential, or runs the personal transport | Not refused at level 2 (P7, P8); only a separate OS user for the owner's private state refuses it (Q6) |

## 5. Build plan

Each slice is one verifiable behaviour with its negative cases. "Needs" lists
what must merge first; "Files" lists what the slice changes, so two slices
that share a file are serialized even without a logical dependency. Every
memory and team slice runs its tests with isolated `LLV_STATE_DIR`, HOME,
XDG_CONFIG_HOME and TMPDIR, as AGENTS.md requires; none touches the runtime
host.

The first revision's slice M1 (the hard maximum on every delivery path) is
no longer in this plan: PR #3611 does it (§1.1, §2.2), and lane d75de2eb owns
that pull request. M1's acceptance becomes a review item there. Every memory
slice below that touches `roleSelect.ts`, `roleSelection.ts`, `roleLaunch.ts`,
`roleRender.ts` or `deliveryLedger.ts` starts after #3611 merges, because
#3611 rewrites those files.

| Slice | Behaviour | Needs | Files | Acceptance (negative cases in italics) |
| --- | --- | --- | --- | --- |
| **M2** Pool admission, search states, recall | §2.1 and §2.3: joint admission of active and reserve rows under both bounds, `pool-bound` and `reserve-unmatched` on the ledger, reserve rows in search, `recalled` ledger ids | #3611 | `roleSelect.ts`, `roleSearch.ts`, `roleViewSource.ts`, `deliveryLedger.ts` | The 481-row fixture admits the matching archive and records one active row `pool-bound`; a recalled id is accepted by `applied`; *a `stale` archive is neither candidate nor default search hit; 1 000 short rules make at most 15 batches; an overflowing pool no longer skips the provider (`jev-pool`)* |
| **M3** Per-kind targets | §2.2 targets map and brief text; OpenAI batches sent concurrently so a full pool fits the deadline | #3611 | `roleTypes.ts`, `roleConsolidate.ts`, `curation/brief.ts`, `curation/read.ts`, `roleSelectionProvider.ts` | Each kind evicts at 125 % of its own target; a 430-rule pool at the decided targets completes Decisions inside 3 000 ms against a provider stub with the latency #3611 measured; *project stays at 15 000* |
| **M4** Layer, parent and the validator | §2.4 fields, validator, Layer check, undo | M3 (same `roleTypes.ts`, `brief.ts`) | `roleTypes.ts`, `curation/apply.ts`, `curation/brief.ts` | Every algorithm-produced link passes; *cross-role, cross-workspace, cyclic, dangling, non-principle-parent and principle-with-parent links are refused* |
| **M5** Layer delivery | Principles always-on within 3 000, children rendered under parents | M4, M2 (same `roleSelect.ts`) | `roleSelect.ts`, `roleRender.ts` | A child renders under its delivered parent; *a principle beyond 3 000 code points is not always-on* |
| **M6** Family view | Lineage in the curator read and the window | M4, T2 (same `roleStore.ts`) | `curation/read.ts`, `roleStore.ts` (view), `LearnedRules.tsx` | The family shows parent, children, merged, split, moved; rendered in en and uk, light and dark, through the existing drivers |
| **M7** Spend cap | Q1's cap; month share of Decisions and fallback in the window | Q1, #3611, M6 (same `LearnedRules.tsx`) | `roleSelectionSpend.ts`, `LearnedRules.tsx` | *A reservation larger than the remaining cap takes BM25 `cap` once and records it* |
| **W1** Land (c) | §4.2 | – | PR #3415 | The PR's own tests and required checks |
| **W2a** Audience record and one fail-closed resolver | §4.6 field, stamping at receipt creation, inheritance, legacy classification; one resolver used by `workspaceRoute.ts` and the fence; `owner` and `member` records resolve to no project for every non-owner | W1 (same `workspaceFence.ts`) | `src/lib/agent/registry.ts`, new `src/lib/team/conversationAudience.ts`, `workspaceRoute.ts` (`:34-56` only), `workspaceFence.ts` (`:74-77` only) | Driven through the real launch builders: spawn, pipeline stage, seat, owner run, voice session, resume, migration successor, fork and child each stamp the expected kind and origin; a copy of a fixture registry classifies legacy rows; *an owner-run canary is refused by `/api/log`, the log stream, the runtime snapshot and `get_conversation` to a member and a member-bound agent; a child of an owner parent is `owner`; a child crossing workspaces is `owner`* |
| **W2b** Person check on HTTP reads and actions | §4.6 surface table, first row | W2a (same `workspaceRoute.ts`) | `workspaceRoute.ts` (identity check `:170-245`) | For each route in the row: the three canaries are refused to members and answered to the owner and to a person in both A and B; *refusal is indistinguishable from an unknown id; send, resume and kill on a canary change nothing* |
| **W2c** Projections and streams | §4.6 surface table, second row | W2a | `workspaceProjection.ts`, `src/app/api/logs/stream/route.ts`, `src/app/api/runtime/stream/route.ts` | Snapshot rows and counts are identical with and without the canaries; *a log stream opened before a move stops delivering origin-A lines to a B-only member at the next batch* |
| **W2d** MCP, search and exports, plus the coverage gate | §4.6 surface table, last two rows; a test that lists every `project` route of `workspaceRoutes.ts` and every fence tool that takes a conversation identity or returns transcript text, and refuses each the owner-run canary | W2a (same `workspaceFence.ts`) | `workspaceFence.ts` (result filter), `src/lib/search/projectScope.ts`, `src/lib/activity/transcriptExport.ts`, the coverage test | Agent-column rules of §4.6 hold for every listed tool and every caller, member-bound or launched by the owner; *search hits, counts and `truncated` are unchanged by the canaries; a route or tool added without the check turns the coverage test red* |
| **W3** Owner tools for owner-launched workers | P1 and P5 closes | W2a (caller audience) | `src/lib/mcp/bindings.ts`, `src/lib/mcp/server.ts`, `src/lib/externalRelay/routeGuard.ts` | *An owner-launched stage in a shared project cannot read owner history or the bot's private chats*; the operator root still can |
| **W4** Member account picker | §4.3 | W1 | new route, `workspaceRoutes.ts`, `useEngineAccounts.ts`, `EngineAccountSwitch.tsx` | Member launches on an allowed account; *named foreign account refused; `/api/accounts*` 403 for the member* |
| **W5** Usage and worker share by workspace | §4.7 shares, Activity grouping | W1 | `src/lib/activity/report.ts`, `workerLimit.ts`, `workspaceDefaults.ts` | Usage grouped by resource workspace for every origin; *the share's overflow waits at admission* |
| **W6** Workspace work slices | §4.7 slices under the aggregate work slice, fallback, resume | W5 | `agentMemory.ts`, `cpuPlacement.ts` | §4.7 acceptance (1) to (4) on a real user manager in an isolated test; *combined workspace work never exceeds the aggregate quota; operator hosts keep no quota* |
| **W7** Clone as poster | Per-project-relay-clone Part 1 | W1 | per that design | per that design |
| **N1** Native memory audience in search | §3.10 items 1 and 2 | W2a (agent actors) | `src/lib/memory/index.ts`, `src/lib/memory/sources.ts`, `src/lib/memory/settings.ts` | §3.10 acceptance for search, open and short ids; *a legacy global row is owner-only after upgrade; a shared source answers members* |
| **N2** Engines' own memory at launch | §3.10 item 3 | W2a (launch audience) | `src/lib/memory/source.ts`, `src/lib/agent/cli.ts`, `src/lib/runtime/claudeStreamBrokerHost.ts`, `src/lib/agent/codexSpawnPolicy.ts` | A member-bound Codex launch in a workspace project starts with `features.memories=false`; an owner run there starts with the engines' memory off; *a launch in a project in no workspace keeps today's switch* |
| **T1** Rule-access predicate | §3.3 actors, scope and state tables, search, open-by-id, family, histories, mutations, `authorizeView` after the memo | W2a, M2 (same `roleSearch.ts`) | new `ruleAccess.ts`, `roleSearch.ts`, `roleViewSource.ts`, `roleStore.ts`, `src/app/api/role-memory/route.ts` | §3.3 cache acceptance in both warming orders; *a permitted project plus a foreign rule id, or a walk from a shared parent, reveals and changes nothing* |
| **T2** Member scope and lesson routing | §3.1 scope, tags, routing table, correction attribution, `overrides` on corrections | T1, M4 (same `roleTypes.ts`), W3 (same `bindings.ts`), W2b, W2c, W2d | `roleTypes.ts`, `roleScopes.ts`, `roleStore.ts` (write path), `src/lib/mcp/bindings.ts` (`leave_lesson`) | Member A's lesson and correction land in A's scope with tags; *member B's conversations and installation launches do not receive them* |
| **T3** Member delivery and precedence | §3.6 and §3.7: readable scopes per principal, tag filter, override removal, always-on recomputed under 3 000 | T2, M5 (same `roleSelect.ts`), M6 (same `roleStore.ts`) | `roleStore.ts` (`readableScopes`), `roleSelect.ts`, `roleSelection.ts`, `roleLaunch.ts`, `roleStage.ts` | §3.6 acceptance (1) and (2) on provider, BM25, whole fallback and resume; *B keeps the workspace rule* |
| **T4** Workspace scope and the project pass | `workspace:<w>`; pass reads the workspace's member scopes; other-project evidence restricted to the workspace; member-to-team promotion | T2, M6 (same `curation/read.ts`) | `curation/store.ts`, `curation/read.ts`, `curation/brief.ts`, `roleViewSource.ts` | Promotion writes a team row with `derivedFrom`; *a workspace-B canary is absent from a workspace-A pass and everything A members can read* |
| **T5** Company gate and company pass | §3.5 proposals on every path; owner-audience company pass | T4, T3 (same `roleStore.ts`), M4 (same `apply.ts`) | `curation/apply.ts`, `roleStore.ts`, `roleTypes.ts`, `curation/run.ts` | *Every path of §3.5 leaves no active company row before approval*; solo fixture unchanged |
| **T6** Rules window for members and approvals | §3.8 routes to `project`, predicate-driven rows and actions, approve and reject | T1, T5, M7 (same `LearnedRules.tsx`), W4 (same `workspaceRoutes.ts`) | `workspaceRoutes.ts`, `src/app/api/role-memory/*`, `LearnedRules.tsx` | Rendered member and owner views in en and uk, light and dark, desktop and phone; *member sees no foreign member scope (Q3 b), no other workspace's rows, no proposal* |

**What keeps a partly fenced rollout safe.** Members can already sign in and
read their workspaces' projects on main, so every W2 slice narrows what they
see today; none widens it. W2a closes the owner-private records to member
sessions and member-bound agents on every surface that goes through the
resolver (HTTP, projections, streams, the fence's identities and results) in
one change. Until W2d merges, transcript search and the activity export
still answer owner records by project, and agents the owner launched in a
shared project still reach them through MCP, because #3415's fence applies
to member-bound callers only; that is why W2d is first in its group. Workspace-bound memory, the content the
origin protects, is first written by T2, and T2 needs W2b, W2c and W2d, so
no member or workspace row exists before every surface enforces the origin.
The coverage test in W2d then keeps a later route or tool from skipping the
check. The owner is told not to invite members into a workspace holding
owner conversations before W2d and W3 merge; that sentence goes into the
release note of W2a.

**Order and parallelism.** Every shared-file edge is part of "Needs" above,
so no two slices inside one group change the same file:

1. #3611 (lane d75de2eb), W1.
2. M2 and M3 (after #3611); W2a, W4, W5 and W7 (after W1).
3. W2d first, then W2b, W2c, W3, N1 and N2 (after W2a); T1 (after W2a and
   M2); M4 (after M3); W6 (after W5).
4. M5 (after M4 and M2); T2 (after T1, M4, W3, W2b, W2c and W2d).
5. M6 (after M4 and T2).
6. T3 (after T2, M5 and M6), T4 (after T2 and M6), M7 (after Q1, #3611 and
   M6).
7. T5 (after T4, T3 and M4).
8. T6 (after T1, T5, M7 and W4).

Files changed by more than one slice, in order: `roleStore.ts` T1 → T2 → M6 →
T3 → T5; `roleTypes.ts` M3 → M4 → T2 → T5; `curation/brief.ts` M3 → M4 → T4;
`curation/read.ts` M3 → M6 → T4; `roleSelect.ts` #3611 → M2 → M5 → T3;
`roleSelection.ts` #3611 → T3; `roleRender.ts` #3611 → M5; `roleLaunch.ts`
#3611 → T3; `deliveryLedger.ts` #3611 → M2; `roleSelectionProvider.ts` #3611
→ M3; `roleSearch.ts` and `roleViewSource.ts` M2 → T1 → T4;
`curation/apply.ts` M4 → T5; `LearnedRules.tsx` M6 → M7 → T6;
`workspaceFence.ts` W1 → W2a → W2d; `workspaceRoute.ts` W2a → W2b;
`workspaceRoutes.ts` W4 → T6; `src/lib/mcp/bindings.ts` W3 → T2;
`src/app/api/role-memory/route.ts` T1 → T6.

## 6. Decision questions for the operator

One recommendation each. None revokes a recorded decision unless it says so.

**Q1. Monthly spend for memory selection.** Selection over the whole pool is
estimated at $26 to $53 a month on OpenAI and up to $73 to $122 on
OpenRouter at today's volume (§2.3), against the $5 cap set in October for
shadow Jev. #3611 turns live selection on under that same cap.
- (a) **Recommended:** raise the learned-rules cap to $60 a month; when a
  month's cap is reached, launches fall back to BM25 and the window shows
  it. Revisit after the first month of real bills.
- (b) Keep $5; most launches fall back to BM25 after the first days of each
  month.

**Q2. Graph.** The store already holds lineage links; decision 5 is a layer
field and one parent link.
- (a) **Recommended:** keep layer plus parent, add the `overrides` and
  `derivedFrom` links this design needs, and show the lineage as a family
  view. Keeps decision 5.
- (b) Build a typed multi-edge graph and expand selections along its edges.
  Reopens decision 5.

**Q3. Who may read a member's own rules.** Only that member's agents receive
them in both options.
- (a) **Recommended:** everyone in the same workspace and the owner may read
  them, as they read each other's conversations today; another workspace
  never sees them, including after a project moves.
- (b) Only the member and the owner. Every conversation a member's agents run
  is then private to that member and the owner from its start, children and
  successors included, because a rule can also reach a transcript through a
  recall or a child's prompt. Teammates keep seeing cards, tasks and
  pipeline states but no transcripts of each other's agents. This narrows
  the 2026-10-20 level-2 picture, in which members of a workspace see each
  other's work there.

**Q4. Who approves a company rule in a team installation.** Company rules
reach every workspace.
- (a) **Recommended:** the curator proposes, the owner approves in the rules
  window; until then nobody receives it. Narrows decision 1 for team
  installations only (§0.1).
- (b) The curator writes company rules itself, as on a solo installation.
  Keeps decision 1 everywhere.

**Q5. Members' own subscriptions.**
- (a) **Recommended:** members choose among the accounts the owner put in
  their workspace pool; the owner adds logins.
- (b) Managers may add a login of their own into a managed home tagged to
  them and defaulted into their workspace pools, with the level-2 caveat
  that every agent's shell can read it.

**Q6. The shell, and what "never" covers.** After W2a to W2d, W3, N1 and
N2, every remaining path in §4.5 runs through an agent's shell, which acts as
the installation's one OS user. The 10:55 words ask that members never reach
the owner's private conversations through the relay or a clone.
- (a) **Recommended for members the owner trusts not to direct their agents
  at the owner's files:** stay at level 2 and accept that "never" holds for
  Delegatus's surfaces (Viewer, MCP, Telegram) only. This narrows the 10:55
  words. Remaining access for any agent's shell, members' included: P7 (the
  relay store's raw owner turns, the bot store, owner-run transcripts and
  native memory in the shared account homes, `team.sqlite`, and the pairing
  credential, which calls the relay's owner-history API directly), and P8
  while its credential stays on this OS user. Removing P8's credential is
  recommended in any case and closes P8 only.
- (b) Separate the owner's private state before any member's agent runs
  here: the relay, its pairing credential, the personal transport, owner
  runs and their account homes run under a second OS user that members'
  agents cannot read, with the Viewer reaching them over a socket. Remaining
  access for members' agents: none of P7's owner records or P8; what is left
  is what the Viewer serves them, fenced as above. This is a new deployment
  shape (the level-4 split applied to the owner first); members wait for it.
- (c) Level 4 for every workspace (one OS user per workspace, workspaces
  design §6). Remaining access: none across workspaces at the OS level; the
  largest build, and the one the 2026-10-20 form did not pick.

## 7. Validation against the requirement

| Asked (paraphrased, 2026-11-03) | Where |
| --- | --- |
| Find the earlier work on limits, keeping and using all memory | §0, §0.2, §1.1 |
| Keep all memory | §2.1 reserve class, no age cut, §2.2 bounds; §2.3 joint admission so a matching archive is never starved by active rows |
| Use all memory | §2.3 selection over every scope and the reserve, under 24 000 bytes (#3611), with recall; §3.10 native memory stays usable by the owner and anything the owner shares |
| Consolidate, perhaps as a graph | §2.4 |
| Each account's own rules | §3.1 member scope and routing, §3.2 and §3.3 who may read them, §3.6 precedence, §3.7 delivery |
| The curator makes company rules from them | §3.4 passes, §3.5 ladder and gate |
| Finish workspaces with isolation, as now or better | §4.1, §4.2, §4.6, §4.7, §5 W slices, Q6 |
| Each person sees only their workspaces | Shipped (b); §4.6 audience and origin workspace, including after a project moves; §3.10 native memory; T6 for the rules window |
| Works only in their folders | HTTP and MCP resolve cwd to a project ((b), (c)); the shell is the level-2 limit (P7, P8, Q6) |
| Does their own actions | Human routes (b), MCP fence (c), principal on every launch (c), rule writes by predicate (§3.3) |
| Chooses a Claude or Codex subscription | §4.3 W4, Q5 |
| Per-workspace accounts and binding | Main: per-project routing; (c): workspace pools enforced for members (§4.1) |
| Report destination through a paired clone (10:55) | §4.4, W7 |
| Members never reach the owner's private conversations (10:55) | §4.5, §4.6, §3.10, W2a to W2d, W3, N1, N2; at level 2 only on Delegatus's surfaces, which Q6 puts to the operator |
| Decisions by key, evaluated offline, no shadow (10:55, 10:58) | §2.3; PR #3611 (lane d75de2eb), open |

## Deferred — not currently justified

- **A general graph of typed edges and graph expansion at selection** (§2.4
  G1): lineage plus parent answers "gathers upward".
- **A saved per-member default engine and account** (first version's
  `member_preferences`): the requirement asks for the choice, which the
  per-launch picker gives (§4.3).
- **A per-message member overlay for seats** (§3.7): it would re-render a
  seat's block per message, breaking the frozen block and the prompt cache.
- **Member scopes per role** beyond the tags: tags already keep the role.
- **Workspace-scoped swarm candidates**: the pack takes approved
  installation rows only.
- **A mount mask over owner files for member-bound agents** inside the
  existing per-agent Bubblewrap namespace (`docs/design/agent-signal-sandbox.md`):
  the Viewer MCP server runs inside that namespace and needs the state
  directory, and the systemd user manager stays reachable from every domain
  (that design's accepted gap), so the mask would stop accidents only.
- **Separating the owner's private state under its own OS user, or level 4
  per workspace** (Q6 b, c), unless the operator chooses one.
- **Handing a moved project's earlier transcripts to its new workspace**
  (§4.6): the safe default keeps them with their origin; an owner action to
  hand them over can follow a request.
- **Interactive hosts under a workspace's CPU and memory ceiling** (§4.7):
  it would change the operator workload policy for the owner's own
  sessions.
- **Members adding their own logins** (Q5 b).
- **A manual "make private" toggle on conversations** (§4.6 sets the
  audience by kind).
- **Per-member interface language and time zone**: sign-in design §14.
- **Per-workspace Telegram bot or relay pairing**: level 3; the 2026-10-20
  answer is one bot.
- **Automatic promotion of principles into role prompts**: a reviewed change
  to shipped text (layers design §3.4).
- **Removing the per-scope bound**: the operator asked that some maximum
  stay.
- **Shadow runs, data-collection periods or a second Jev pilot**: withdrawn
  by the 10:55 update.
- **A per-launch spend ceiling** (first version's $0.02): the pool bound
  already bounds every reservation (§2.3).

## Notes

- The audit lane (57064780) waits for a decision on its own report; §4.5
  cites only paths its audit and verify stages both state, plus the code.
- PR #3415's red checks and unreviewed last fix are the facts at
  `4e0bd2688` (unchanged at 13:07 UTC); the lane that owns the PR settles
  them.
- PR #3611's figures (applied counts, OpenRouter refusals, latency) are its
  own description's; this stage did not rerun its evaluation.
- The reservation table in §2.3 comes from prepare-only calls with no key
  and no network; the bill and monthly figures are estimates from byte
  counts and the 2026-10-21 start volume.
- The OpenAI adapter's sequential batches against the 3 000 ms deadline
  (§2.3): at today's pools #3611 reports a p95 of 2.9 to 3.5 s; at the
  target pool they decide whether Decisions runs at all, which is why M3
  carries the concurrency change.
- The native-memory reproduction (§3.10) and the 24 059-byte override
  expansion (§3.6) are the second critique's isolated probes; this revision
  designs against them and did not repeat them.
- `search_memory` returned nothing on these subjects; earlier answers came
  from transcripts, task records and the design documents named in §0.
