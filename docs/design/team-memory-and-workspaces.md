# Team memory and workspaces: every rule kept and in use, company rules from each person's rules, and what a member still lacks

Status: design, written anew on 2026-11-11 against `main` at `ec82e477f`
(unchanged when the document was finished). File and line references are to
that commit. It replaces the earlier attempt of 2026-11-03 (PR #3606), which
is input about what went wrong and was not edited into this text. Live
records of one installation were read read-only on 2026-11-11 between 01:02
and 02:10 UTC: the learned-rule store, the per-start delivery ledger and the
pipeline briefs. Only counts appear here. No rule text, rule id, person,
account or path is given, and projects are named by kind.

This stage wrote one file. Nothing is built.

## Originating requirement

Operator, 2026-11-03 about 10:40 UTC, by voice in Russian, to the project's
orchestrator. The words are private operator speech, so this is a dated
paraphrase:

1. Find the earlier work on memory. Raise the character limits, be able to
   **keep all memory** and to **use all of it**. Consolidate it somehow,
   perhaps as a graph, so that it assembles. This was thought about before:
   find those records and decide what is best.
2. In team work, **each person's account gets rules of its own**, and the
   curator builds **rules for the whole company** from them.
3. **Finish workspaces**, with isolation, so that Delegatus can be installed
   for a company and each person gets an account that is isolated in some
   way, as it is now or better. Each person signs in, sees only their
   workspaces, works only in their folders and does their own actions, can
   choose a Claude or a Codex subscription, and each workspace has its own
   account bindings (which probably exist already, and are still required).

Operator decision, 2026-11-11 00:25 UTC, on the stalled first design: write
the design again from the request and the current code, with one critique.

Two earlier requests stand behind this one and are paraphrased in the
documents that answered them: team workspaces with some isolation
(2026-10-20, `docs/design/workspaces.md` §0) and a larger, layered memory
(2026-10-21, `docs/design/role-memory-layers.md`, "Originating requirement").

## 0. What changes for a person

**For whoever runs agents (memory).**

- A rule that no longer fits a scope's limit stops disappearing from use.
  Today it is archived for budget and no start and no search ever sees it
  again until a curator brings it back. On the installation measured here
  that is 570 rules beside 1 087 active ones. They become a **reserve**:
  scored at every start, given a bounded share of the start's rules,
  found by `search_memory`, and shown as a reserve in the rules window.
- Starts get the rules that match their task. Today 48 % of starts fall
  back to the first 24 000 bytes of each scope in curator order because the
  selector runs out of its three seconds, 48 % get a word-match selection
  capped at about 9 700 bytes, and 3 % get the model's choice (§2). The
  design makes the selector finish, lets the word-match path use the room
  under the 24 000-byte maximum, and sends the model a short list.
- Rules gain the decided levels (principle, practice, specific) and a link
  from a rule to the more general rule it serves. The curator uses the link
  to keep a class of rules represented when the details move to the reserve.
  A wider graph is weighed in §3.3 and deferred.

**For a team member.**

- You get **rules of your own**: how you want work done (language, reports,
  what to ask before acting). Agents working for you read them, agents
  working for a colleague do not receive them. You can read and edit them.
- When several people hold the same rule, the curator **proposes it as a
  company rule**, written anew without anyone's name. A person approves it
  before any agent receives it.
- You can **see and pick the accounts** your workspace allows, with their
  remaining limits. Today the account list is the owner's alone.
- A few everyday controls that are still owner-only (attaching a file in the
  composer, voice input, a pipeline's changes and checks, search) get a
  deliberate answer each (§5.2).

**For the owner.**

- Revoking a person also stops the agents that are running for them.
- Usage is shown by workspace, and a workspace can have a share of the
  worker limit.
- What a workspace inside one installation promises is stated per layer
  (§5.1): it keeps a trusted team's attention, defaults and mistakes apart.
  It does not keep secrets between people whose agents have a shell.
  Confidentiality between people takes one installation under one OS user
  for each of them, which is a deployment choice outside this design.

Six questions for the operator are in §7.

## 1. Earlier answers this design starts from

Each record was read. None is reopened unless the request changes it, and
§1.1 says where.

| Record | What it settled | State on main |
| --- | --- | --- |
| `docs/design/role-memory.md` (2026-10-07), `docs/design/role-memory-curation.md` (2026-10-11) | Stage-end lessons, four levels, a bound per scope, a curator on the seat tick, nothing deleted for disuse, reviewers stay clean | Built |
| `docs/design/role-memory-layers.md` §7.3, operator form of 2026-10-22 (research #3180) | (1) role-on-every-project is written by the curator only; (2) a model selector only if a second pilot beats BM25 by 10 points at equal budget, else BM25; (3) one hard maximum of 24 000 bytes per launch; (4) store targets 20 000 role here, 30 000 role on every project, 15 000 project and machine; (5) a layer field and a parent link, principles always-on up to 3 000; (6) own per-feature spend caps; (7) the operator checks quality by eye | Slice 1 built (#3191). Selected delivery is live (#3611, 2026-11-04). Layers and per-scope targets are unbuilt (§2.1) |
| #3607 (2026-11-03) | The curator rewrites compressed rules as plain sentences, and archives for budget where it used to compress. One interim bound of 15 000 for every scope | Built: `src/lib/memory/roleTypes.ts:11`, `src/lib/memory/curation/brief.ts:14` |
| #3340 (2026-10-25) | A new lesson never evicts another; the curator integrates and restores budget archives | Built: `src/lib/memory/roleConsolidate.ts:69-92` |
| #3611 and `docs/design/role-memory-selector-observations.md` (2026-11-04) | Selected delivery on a Decisions provider chosen by the connected key, BM25 when it fails, whole delivery when BM25 fails; shadow mode retired | Built. §2.2 measures what it delivers |
| `docs/research/memory-selection.md` (2026-10-02, after the pilot on PR #2475) | A graph was tried as a gate on memory offers and lost the one useful offer; graph evidence should not be a mandatory gate | Stands. §3.3 builds on it |
| `docs/design/swarm-role-memory.md` (2026-10-22), operator form of 2026-10-23 | Opt-in public role rules shipped with releases, 4 000 code points per role, read-only | Receiving is built with an empty pack (`src/lib/memory/swarmPack.ts:9-10`, `src/lib/memory/swarmRules.json`) |
| `docs/design/sign-in-and-team.md` (#2243, 2026-09-26) | Members, revocable sessions, authorship on messages, who-did-what | Built |
| `docs/design/workspaces.md` §12, operator form of 2026-10-20 | Level 2: views and permissions, an agent fence through the Delegatus tools, per-workspace defaults. The owner creates workspaces, a manager adds projects and invites, an Unassigned group, a shared account pool with a per-workspace allow-list and usage by workspace, one Telegram bot with per-workspace chats | Slices (a) #3133, (b) #3255 and (c) #3415 are merged. Slice (d) is unbuilt (§2.6, §5.4) |
| `docs/design/workspaces.md` §6 | Level 2 separates attention, defaults and mistakes. Containing an agent's shell takes one OS user per workspace (level 4) | Stands, and §5.1 restates it per layer |

### 1.1 Where this design departs from an earlier answer

- **Decision 4 of 2026-10-22 (store targets) is put back to the operator as
  Q1.** A measurement that did not exist then shows that more candidates in
  one ranking lower the share of applied rules a block of fixed size holds
  (§2.3). The measured case doubled the pool; a first rank one third larger
  was not measured by itself. The recorded targets remain option (b).
- **The 9 000-code-point selected budget is put to the operator as Q2 for
  the word-match path only.** It was sized for a model selector that answers
  with probabilities. The model decides 3 % of starts (§2.2).
- **Slice (d) of workspaces is put to the operator as Q6.** The approved
  wording promises that a runaway workspace's agents are the ones the kernel
  stops (`docs/design/workspaces.md:237-244`). §5.4 recommends usage by
  workspace and a worker share, and defers the kernel slice. Only the
  operator can narrow an approved promise.
- **The earlier attempt's per-person confidentiality inside one installation
  is dropped.** §9 lists each premise its critique found wrong, what main
  shows, and what this design does.
- Nothing else is reopened: the 24 000-byte maximum, curator-only widening,
  the layer field with a parent link, level 2 and every workspace answer.

### 1.2 Records searched

`search_transcripts`, project-scoped and then unscoped, in Russian and
English phrasings (memory graph consolidation, keep all memory, per-member
rules into company rules, workspace isolation and subscription choice), and
`search_memory` for the same subjects (no hits). The transcript hits led to
the designs and pull requests in the table above, which are cited in place
of the conversations. GitHub issues were searched for memory graph, swarm
and workspace: #3818 (a seat's form tools answer `workspace_forbidden`) and
#3131 (relay allow-list after workspaces) are open and touch §5; no issue
proposes a rule graph. The "graph" the request remembers is the 2026-10-02
study.

## 2. Inventory: shipped, open, missing

### 2.1 Memory

| Piece | State | Evidence |
| --- | --- | --- |
| Rules are never deleted: every rewrite keeps the earlier version, every archive keeps the text and its reason | Shipped | `src/lib/memory/roleStore.ts:310` (`versionedRule`), `src/lib/memory/roleTypes.ts:111-116` (`RuleDeparture`), `:37-39` (states and reasons) |
| Four scopes a start reads (role here, role on every project, project, machine) plus the opt-in swarm scope | Shipped | `roleStore.ts:156-158`, `src/lib/memory/roleScopes.ts:13-15` |
| One bound of 15 000 code points per scope; over 125 % of it rules leave only when no curator can run | Shipped (#3607, #3340) | `roleTypes.ts:11`, `roleConsolidate.ts:69-92` |
| The curator archives for budget after integrating, with a note of the lost coverage, and considers every budget archive on every pass | Shipped | `curation/brief.ts:14` (check 7), `src/lib/memory/curation/apply.ts:176-181` (restore) |
| **A budget archive is out of use**: a start's candidates are the active rules of its scopes; `search_memory` reads active rules only | Shipped behaviour, the gap of §3.1 | `roleStore.ts:255-256`, `:267`; `src/lib/memory/roleSearch.ts:6-18`, `src/lib/memory/roleViewSource.ts:769-791` |
| Selected delivery: operator-kept rules always-on up to 3 000 code points, selected rules up to 9 000, every block under 24 000 bytes, three-second deadline, block frozen per attempt | Shipped (#3191, #3611) | `src/lib/memory/roleSelect.ts:10-12`, `:22-30`, `:75-78`; `src/lib/memory/roleSelection.ts:116-146`; `src/lib/memory/roleRender.ts:50-66` |
| Local BM25 scoring and the pack yield to the event loop every 16 rules | Shipped; the cause of half the fallbacks (§2.2) | `roleSelect.ts:37`, `:59`, `:71`; `src/lib/cooperative.ts:11-13` |
| Model selection through a Decisions provider, a pool above 120 000 code points skips it, spend reserved against 5 USD a month | Shipped | `roleSelect.ts:134`, `:147-152`; `src/lib/memory/roleSelectionSpend.ts:5`, `:26` |
| The delivery ledger: one row per engine start with delivered ids, reason, timings and cost; the last 10 000 starts | Shipped | `src/lib/memory/deliveryLedger.ts:15`, `:229` |
| `applied` and `misled` on `leave_lesson`, accepted only for ids the attempt received | Shipped (#3191) | `roleTypes.ts:221-222`, `deliveryLedger.ts:271-284` |
| Lineage links on rules: merged from and into, moved from, split from, versions | Shipped | `roleTypes.ts:129`, `:139-140`, `:147-153` |
| `layer` and `parent` | **Missing** (decision 5 of 2026-10-22) | no such field in `roleTypes.ts:118-158`; `roleSelect.ts:65` notes "Layers arrive in slice 3" |
| Per-scope store targets | **Missing** (decision 4); one constant serves every scope | `roleTypes.ts:11` |
| A first selection reads the whole rule collection | Shipped; grows with everything kept | `roleStore.ts:118-120`, `:250` |
| Open pull requests on the same files | #3834 and #3841 move a scope's history into rows of its own (`roleStore.ts`, scope rows); #3838 touches the memory import host and the curator engine | read 2026-11-11; slices M2 and T1 start after #3834 and #3841 land |

### 2.2 What a start receives today (measured)

Delivery ledger rows from 2026-11-05 00:00 UTC to 2026-11-11 01:01 UTC. The
last block above 24 000 bytes is dated 2026-11-04 17:52 UTC, so the whole
window ran the selected delivery of #3611. 1 082 first selections and 20
resumed starts that reused their frozen block.

| Outcome | Starts | Share | Block, median bytes |
| --- | ---: | ---: | ---: |
| The selector ran out of its three seconds; whole scopes in curator order, cut at the byte ceiling (`selector-timeout`) | 523 | 48 % | 23 881 |
| Word-match (BM25) selection after the provider timed out (211), the monthly allowance was spent (245) or the answer was malformed (68) | 524 | 48 % | 9 709 |
| The model's selection | 35 | 3 % | 9 600 |

- **Where the three seconds go.** Of the 523 timeouts, 451 ended inside
  local scoring and 72 inside local packing. Local scoring took a median
  852 ms and 2 116 ms at p90 when it finished, and a median 3 401 ms when it
  did not. The same arithmetic, run in one piece on synthetic rules in a
  scratch process on the same machine, took about 10 ms for 250 rules and a
  1 200-term brief, and 37 ms for 900 rules. The scoring loop gives up its
  turn every 16 rules (`roleSelect.ts:37`, `:59`), and a start's pool holds a
  median 101 candidates and 226 at p90. The inference: the time is spent
  waiting for turns on a busy server loop. It was not confirmed with a
  profile of the serving process.
- **The allowance.** 4.54 USD of selection spend falls in the window and the
  month stands at 4.996 of 5 USD, so from about the fifth day every start
  takes the word-match path. A request that times out keeps its whole
  reserved ceiling (`roleSelect.ts:176-184`). The 211 timeouts account for
  3.67 USD (a median 0.019 USD each, with a median 191 candidates), the 68
  malformed answers for 0.77 USD, and the 35 answered selections for 0.10 USD
  (a median 0.002 USD each, with a median 88 candidates). So 98 % of the
  spend bought no selection.
- **The provider's time.** In the answered selections the provider phase
  took a median 1.8 s and 2.6 s at p90. The requests that timed out held a
  median 191 candidates, the answered ones 88.
- **The committed evaluation** (`evals/role-selection/README.md`) has 24
  cases with four candidates each. On it the model kept 49 of 64 applied
  rules and BM25 kept all 64, with the threshold tuned on the same cases.
  It does not show that the model selects better.

### 2.3 Which rules agents report using (offline replay)

Each stage answer may name rules it applied (`roleTypes.ts:221`). 2 090
attempts in the ledger carry 6 458 such marks. For each, the replay took the
brief the selector uses (`src/lib/memory/roleLaunch.ts:107`: task up to
2 000, specification up to 8 000, stage prompt up to 3 000 characters), the
pool the attempt had, and the shipped BM25 arithmetic, and asked whether
each applied rule would be inside a pack of a given size. No provider was
called.

| Rule lines packed by BM25 score | 9 000 | 12 000 | 14 000 | 18 000 | 21 000 code points |
| --- | ---: | ---: | ---: | ---: | ---: |
| Applied rules kept, the attempt's own pool | 63.5 % | 72.1 % | 77.6 % | 85.5 % | 90.6 % |
| Applied rules kept, with today's budget archives of the same scopes mixed into one ranking | 52.4 % | 59.5 % | 63.2 % | 70.5 % | 74.7 % |

Pools held a median 106 rules (175 at p90); with the archives, 227 (559 at
p90, 652 at most).

What limits these figures. Marks are self-reported and sparse. Until
2026-11-04 every pool rule was delivered, so any could be marked; afterwards
only delivered rules could, which favours whatever the selector chose. The
replay scores a rule's current text, which the curator may have rewritten
since. A missing mark does not show a rule was useless.

Two consequences the design uses:

1. The word-match path at 9 000 code points keeps under two thirds of what
   agents report applying. The whole delivery it replaced kept all of it.
2. Adding candidates to one ranking costs 11 to 16 points at every size. A
   larger pool has to enter through a share of its own.

### 2.4 The store (measured)

Read 2026-11-11 01:02 UTC.

| Fact | Count |
| --- | ---: |
| Current rules (5 015 earlier versions are retained beside them) | 3 797 |
| Active | 1 087, 290 730 code points of rendered lines |
| Archived for budget | 570, 154 888 code points: 546 in role-here scopes, 19 in role-on-every-project, 5 in machine |
| ...of which reported applied at least once, at least twice | 47, 20 |
| ...of which last changed on 2026-11-10 | 498 |
| Rules that ever left for budget, and are active again | 1 028, 93 |
| Merged as duplicates; archived as task-specific; as already in instructions | 1 000; 730; 163 |
| Scopes holding rules: role here, role on every project, project, machine | 46, 9, 12, 1 |
| Rules the operator kept | 0 |
| A reader's four scopes together, active rules: median, largest | 31 848, 60 267 code points |
| The largest reader with its budget archives | 177 131 code points: 220 active rules and 432 archived |
| The scope with the most budget archives | 422 rules, 114 590 code points, beside a 15 000 front |

Since #3607 raised the bound and told the curator to write plain sentences
and archive what no longer fits, the store has kept everything and used two
thirds of it by size.

### 2.5 Team memory

| Piece | State | Evidence |
| --- | --- | --- |
| A notion of a person in memory | **Missing.** A lesson's source names a project, a role and a conversation. No scope kind is a person's | `roleTypes.ts:35`, `:56-106` |
| Who a launch works for | Shipped for workspaces, as a member principal on the launch profile, from the launch, a bound seat or the latest message author. It is absent for the active owner | `src/lib/team/workspacePrincipal.ts:16-50` (`:38`, `:43`) |
| The owner's browser messages carry the owner as author | Shipped: authorship is recorded for any signed-in member, the owner included | `src/lib/team/authorship.ts:42-50`, `src/lib/team/contract.ts:13` |
| A member's agent may leave `role` and `project` lessons; `machine` lessons and rewrites are refused | Shipped (#3415) | `src/lib/mcp/workspaceFence.ts:73` |
| The rules window and its API | Owner-only | `src/lib/team/workspaceRoutes.ts:142-144`, `src/lib/team/gate.ts:199-202` |
| Learned rules are delivered while the memory source is unchosen or Delegatus; the engines' own memory is off only when the source is Delegatus | Shipped | `src/lib/memory/settings.ts:45-47`, `src/lib/memory/source.ts:81-85`, `src/lib/agent/cli.ts:472-473`, `:550` |
| The curator's pass reads every role scope of its project, every role-on-every-project scope, the project and the machine, and other projects' same-role rules as evidence; one pass runs at a time on the installation | Shipped | `src/lib/memory/curation/store.ts:301`, `:234`; `src/lib/memory/curation/read.ts:68` |
| The curator widens by move, split and merge inside one call under scope revisions | Shipped | `curation/apply.ts:82-85`, `:150`, `:188-227` |

### 2.6 Workspaces

| Piece | State | Evidence |
| --- | --- | --- |
| Sign-in, sessions, revocation of sessions, authorship | Shipped (#2243) | `src/lib/team/members.ts:544-557`, `authorship.ts:42-50` |
| The record: workspaces, members with a role (manager or member), a project in at most one workspace, defaults | Shipped (#3133, #3415) | `src/lib/team/store.ts:356-385` |
| What a person reaches: the owner everything; a manager their workspaces and every Unassigned project; a member their workspaces | Shipped (#3255) | `src/lib/team/workspaceAccess.ts:10-51` (`:21`) |
| One decision per API route, unknown routes owner-only; a member is refused every `owner` route | Shipped (#3255) | `workspaceRoutes.ts:1-2`, `:264-273`; `gate.ts:189-202` |
| A launch directory must resolve to a permitted project, by its written path and by its real path | Shipped | `src/lib/team/workspaceRoute.ts:104-120`; `src/lib/agent/spawnCommand.ts:605-607` |
| Agent tool calls of a member-bound launch: a closed tool list, every identity in the call resolved to a permitted project, answers filtered | Shipped (#3415) | `workspaceFence.ts:28-35`, `:72`, `:104-134`, `:164-176` |
| A launch with no member principal passes the fence untouched | Shipped, by design | `workspaceFence.ts:70` |
| Per-workspace account pool, report chat and directive chats, set by a manager; a project reads them through its workspace | Shipped (#3415) | `src/lib/team/workspaceDefaultsRead.ts:5-9`, `:41-46`; `src/lib/team/workspaceDefaults.ts:36-56`; `src/lib/projects/settings.ts:387`; `src/lib/telegram/bot/reportReplies.ts:123` |
| The pool is enforced: automatic choice stays inside it, a member-bound launch or tool call on an account outside it is refused | Shipped (#3415) | `src/lib/accounts/projectBindings.ts:440-453`; `spawnCommand.ts:608-612`; `workspaceFence.ts:151-155` |
| **A member choosing an account** | **Missing.** The account list, the limits and every account route are owner-only, and the composer's account hook treats a refusal as a failed read | `workspaceRoutes.ts:7-26`, `:76`; `src/hooks/useEngineAccounts.ts:784-785` |
| **Everyday routes that answer 403 to a member** | Composer upload (`:46`), task attachments (`:187`), voice input (`:236`) and speech (`:245`), transcript and memory search (`:164-165`), a pipeline's changes, checks and review (`:116-118`), flows (`:64`), the rules window (`:142-144`), attention and inbox (`:37`, `:68`) | `workspaceRoutes.ts`, lines as given |
| **Revocation and running work** | Sessions and sign-in codes end. A member-bound agent's authority is read live, so its tool calls are refused afterwards. Its process keeps running. An artifact frame capability lives 12 hours | `members.ts:544-557`; `workspacePrincipal.ts:75-80`; `src/lib/artifact/frameScope.ts:21` |
| **Usage by workspace** | Missing. A member's activity view is filtered to their projects; nothing groups by workspace | `src/lib/activity/report.ts:134`, `:282` |
| **Resource limits per workspace** | Missing. One memory scope per agent, one work slice for the installation, a worker limit per machine and per project | `src/lib/runtime/agentMemory.ts:84-87`; `src/lib/runtime/cpuPlacement.ts:24-25`, `:68-70`; `src/lib/operator/workerLimit.ts:8-11` |
| Native engine memory in `search_memory` | Entries indexed as `global` are returned under any project filter | `src/lib/memory/index.ts:282`, `:313`, `:322` |
| Open defect | A designated seat's form tools answer `workspace_forbidden` after a refused read | issue #3818 |

## 3. Memory: keep all of it, use all of it

### 3.1 What "keep" and "use" have to mean

Keeping is done: no path deletes a rule's text. What is lost is use. A rule
archived for budget is absent from every start and every search, for as long
as the curator finds nothing weaker to exchange it for. In the largest scope
that is 422 rules behind a front of about 57.

A start cannot read everything: the largest reader holds 177 131 code points
against a 24 000-byte block. So "use all of it" is defined as four
properties, each testable:

1. **Scored at every start.** Every active rule and every reserve rule of the
   reader's scopes is ranked against the brief.
2. **A share of the block.** Reserve rules can enter the block within a
   bounded share, and they cannot push out first-rank rules.
3. **Found on demand.** `search_memory` returns reserve rules, marked as
   such.
4. **Reachable from what was delivered.** Once parent links exist, a
   delivered rule that has reserve children says so, and an agent can open
   them.

### 3.2 The reserve

**No new state and no migration.** The reserve of a scope is exactly its
rules with `state: "archived"` and `reason: "budget"`. Those rows already
keep their text, their curation mark and their departure log, and the curator
already reads them on every pass. Rules archived for any other reason
(task-specific, stale, contradicted, in code, in instructions, no reader,
duplicate, deleted) left because they should not be read, and stay out.

A scope then has two tiers:

| Tier | What it is | Bound | Who reads it |
| --- | --- | --- | --- |
| Front | Today's active list, in curator order | The scope bound (Q1) | Every start. It is the whole of a start that cannot be selected |
| Reserve | Rules archived for budget | None. The curator's checks remove what is stale or duplicated | The selector, within the reserve share; `search_memory`; the curator |

What changes in code, by reader and writer (slice M2):

| Path | Today | With the reserve |
| --- | --- | --- |
| Start candidates (`roleStore.ts:248-267`) | Active rules of the reader's scopes, from a snapshot of the whole collection | Front and reserve of the reader's scopes, read by scope. Each scope row lists its reserve ids, written by the same writers that archive and restore for budget |
| Selection (`roleSelect.ts`) | One pool, one ranking | Two tiers, packed in turn (§3.4) |
| Whole fallback and starts with no selection | Active rules, cut from the end at the ceiling | Unchanged: the front only |
| Frozen block (`roleSelection.ts:90-112`) | Withdraws a rule only when the operator deleted it or its exact text is gone | Unchanged. A reserve rule's text resolves the same way |
| `applied`, `misled` | Accepted for delivered ids | Unchanged, so a reserve rule earns evidence when it is used |
| Agent rewrite of a delivered rule (`roleStore.ts:389-415`) | The rule is active | Accepted for a delivered reserve rule too. It keeps its tier and gets a new version |
| `search_memory` (`roleSearch.ts`) | Active rules | Front and reserve, the reserve marked in the hit |
| Emergency eviction (`roleConsolidate.ts:69-92`) | Moves rules to the budget archive when no curator can run | Unchanged, and now it moves them to a tier that is still in use |
| Rules window | "Left" lists every archive together | A "Reserve" group with its count, apart from rules that left for a reason |
| Ledger row | Delivered ids | Also which delivered ids came from the reserve |
| Install transfer, weekly report, swarm evidence | Read rule rows by state | Unchanged; they already carry budget archives as archived rows |

### 3.3 A graph, or the decided layer with a parent link

| Option | Shape | For | Against |
| --- | --- | --- | --- |
| G0. Flat with a reserve | §3.2 alone | Nothing more to build | The front of a full scope is whatever the curator ranked highest. A whole class of detail can sit in the reserve with nothing in the front that names it |
| G1. Layer and one parent (decision 5 of 2026-10-22) | Each rule is a principle, a practice or a specific, and may name the one more general rule it serves | The curator sees a class with its instances. A class stays represented in the front while its details wait in the reserve. Rendering and expansion follow one link. Lineage links (merged, moved, split, versions) already record where a rule came from | One field and one link to keep right on merge and split |
| G2. A general graph | Typed links, many to many (serves, refines, contradicts, same class), selection by walking from the best matches | Could reach a relevant rule that shares no word with the brief | No measurement supports it. A reader's pool is a few hundred rules and is scored whole in tens of milliseconds, so a walk finds nothing a scan misses. The 2026-10-02 study used a graph as a gate and it removed the one useful offer. Every link type is another thing the curator must repair on each merge, split and move, where five lineage fields are already maintained |

**Recommendation: G1, the decision as recorded, with three uses of the
link.** It is a graph with the two kinds of edge that pay: "serves" (parent)
and "came from" (the existing lineage). G2 is deferred with the measurement
that would reopen it (§8).

The data model, all additions optional so existing rows decode unchanged:

```ts
interface RoleMemoryRule {
  // ...existing fields
  layer?: "principle" | "practice" | "specific"; // absent reads as practice
  parent?: string;        // id of one rule in a layer above
  derivedFrom?: string[]; // T2: the personal rules behind a company rule
}
interface RoleMemoryScopeRow {
  // ...existing fields
  reserve?: string[];     // ids archived for budget, newest last
}
// every RuleSource variant
memberId?: string;        // T1: the person the writing launch worked for
```

Layer definitions are those of `role-memory-layers.md` §3.2: a principle
names no tool, file or project and fits 200 code points; a practice is a
trigger and a check; a specific is a fact a practice needs in one project or
tool. One change: a specific's parent may be a practice, because that is
what a specific serves. The parent's layer always stands above its
child's, so a chain has at most three rules and cannot loop.

Server checks in `apply` (beside `curation/apply.ts:82-85`): the parent
exists and is in the front; its layer stands above the child's in the
order principle, practice, specific;
every reader of the child's scope reads the parent's scope (the existing
`reaches` test); a principle fits 200 code points. A parent that later
leaves the front leaves its children's links in place: they render alone
until the curator relinks them. No change cascades.

The three uses:

1. **Rendering.** A delivered child is listed under its delivered parent
   (decided in `role-memory-layers.md` §3.2).
2. **Expansion at selection.** When a child is packed and its parent is not
   in the block, the parent is added if it fits. Expansion only adds rules.
   The 2026-10-02 study rejected a gate, which removes them.
3. **A pointer to the reserve.** A delivered parent with reserve children
   ends with their count, and `search_memory` opened on the parent's id
   lists them. This is property 4 of §3.1.

### 3.4 Selection: how a start's block is filled

One pipeline, with the model as an optional last step.

1. **Always-on** (unchanged): rules the operator kept, then principles of
   the role's every-project scope and the machine once layers exist, within
   3 000 code points (`roleSelect.ts:22-30`).
2. **Score.** Front and reserve rules of the reader's scopes are scored
   against the brief with the shipped BM25, each tier ranked on its own.
   The scoring and the pack run in a few large pieces, or in a worker when
   the pool is large, so they finish in a handful of loop turns (slice M0).
3. **Model step, when a key, the provider's admission and the allowance
   permit.** The model receives a short list: the 72 best front candidates
   and the 24 best reserve candidates by word match, three requests of 32,
   sent together where the provider's adapter allows. It never receives the
   whole pool, so what a start costs and how long the provider takes stop
   growing with the store. Front rules it scores above the threshold are
   packed up to 9 000 code points as today, reserve rules up to the reserve
   share.
4. **Word-match path, whenever step 3 did not answer.** Front rules are
   packed by score up to the front budget of Q2; reserve rules by score up
   to the reserve share.
5. **Reserve share: 3 000 code points**, about eleven rules at today's mean
   length of 243. Only reserve rules that share a term with the brief are
   packed, so an unrelated start spends none of it.
6. **Expansion** (§3.3) for packed children.
7. **The byte test** at 24 000 bytes after every addition, as today
   (`roleSelect.ts:77-78`), computed incrementally.
8. **If scoring itself fails**, whole delivery of the front, cut at the
   ceiling, as today.

Where each number stands:

| Number | Value | Source |
| --- | --- | --- |
| Hard maximum per start | 24 000 bytes | Decision 3 of 2026-10-22. Unchanged |
| Always-on | 3 000 code points | Decision 5. Unchanged |
| Selected, model path | 9 000 code points | `role-memory-layers.md` §4.3. Unchanged |
| Selected, word-match path | Q2: 16 000 recommended | §2.3: 9 000 keeps 63.5 % of applied rules, 14 000 keeps 77.6 %, 18 000 keeps 85.5 % |
| Reserve share | 3 000 code points | New. Sized to fit beside the rest under 24 000 bytes |
| Candidates sent to the model | 72 front, 24 reserve | New. §2.3: the best 64 front candidates by BM25 hold 85.1 % of applied rules and the best 96 hold 96.5 %, so 72 holds somewhat under 90 % by interpolation. §2.2: answered selections had a median 88 candidates, timeouts 191. The value is fixed from the replay and the ledger before M1 ships |

At the recommended values a word-match start is at most 3 000 + 16 000 +
3 000 code points of rule lines, about 23 KB with headings in one-byte text.
A person's always-on share (§4.2, up to 2 000) comes out of the same
24 000 bytes: the byte test ends the front's turn earlier.
That is the size the whole delivery had before selection (22.9 KB for a
builder, `role-memory-layers.md` §4.4) and the size half of today's starts
already have through the timeout fallback. Here the rules in the block are
the ones that match the task. In two-byte text the byte test stops the pack
earlier.

Cost, from the same table of `role-memory-layers.md` §4.4 (API-equivalent,
per stage): a block at the hard maximum is about 0.113 to 0.131 USD on
Claude Opus and 0.064 USD on Codex standard; a block of about 12.7 KB is
0.060 to 0.070 and 0.034. Q2 is that difference against the recall of §2.3.
No claim is made about latency or cache effects beyond those figures.

What this design does not claim: that the model step selects better than
BM25. Only 35 starts in the window were decided by the model. Slice M1
records, for the same start, which rules each path would have packed, so a
month of ledger rows answers it with applied marks (decision 2 of 2026-10-22
asked for exactly this comparison).

### 3.5 The curator

The pass and its checklist stay (`curation/brief.ts:8-14`). Four additions.

1. **Layer check** (decided, `role-memory-layers.md` §3.3): every rule the
   pass reads gets a layer; a practice or specific gets a parent where one
   rule in the reader's scopes states its class. Until a rule has a layer it
   reads as a practice.
2. **Fold before the front overflows.** After integration, when a front is
   over its bound, rules move to the reserve in this order: specifics whose
   parent stays in the front; then rules with the fewest backing tasks, the
   fewest applications, the oldest unapplied (today's order, check 7). Never
   a rule the operator kept and never a correction awaiting review (the
   existing guards, `roleConsolidate.ts:58-60`, `:78`). Each move keeps its
   note of lost coverage. Where several details share a class and nothing in
   the front names it, the curator first writes or keeps one practice for
   the class and links the details to it.
3. **Return on evidence.** A reserve rule reported applied since it left the
   front is first in line to return, in exchange for the front rule with the
   least evidence. This extends the existing restore step with a signal the
   reserve can now earn.
4. **Reserve hygiene.** Each pass reads one page (24 KB, `curation/read.ts:18`)
   of each scope's reserve under checks 1 to 6. A reserve rule that is
   stale, in code, duplicated or contradicted is archived under that reason
   and leaves the reserve. This is what bounds the reserve.

Curator-only widening to role-on-every-project (decision 1 of 2026-10-22)
stays as it is.

### 3.6 The bound

The front bound stays as curation pressure and as the size of a start that
could not be selected. Q1 asks its value. The operator's 2026-10-21 request
that some maximum remain is met twice: the front bound per scope and the
24 000-byte maximum per start.

## 4. Team memory: a person's rules, and company rules from them

### 4.1 The model in one paragraph

A person gets one scope, `member:<member id>`. Agents working for that
person read it at start, in any project and any role. Company rules are the
scopes that already reach everyone on the installation: a role on every
project (`role:*:<role>`) and the machine scope. The curator finds classes
that several people's rules share and proposes a company rule for each,
written anew. A person approves a proposal before it is delivered to anyone.
Approval adds a rule and changes no one's personal rule.

### 4.2 A person's scope

| Aspect | Design |
| --- | --- |
| Key | `member:<member id>`, a fifth scope kind beside role, project, machine and swarm (`roleScopes.ts:13-15`) |
| What belongs there | How this person wants work done: language and form of reports, when to ask and when to proceed, review habits, taste. Never a fact about a project |
| Bound | 4 000 code points of front, the swarm's per-role size. The reserve applies as for any scope |
| Who the person of a launch is | A resolver beside `conversationWorkspacePrincipal` (`workspacePrincipal.ts:16-50`) that walks the same chain (the launch's own principal, a bound seat, the latest message author, the parent conversation) and also answers for the owner, whose messages carry authorship (`authorship.ts:42-50`). A launch with no person on its chain (a scheduled seat pass, the curator, maintenance) reads no personal scope |
| Stamped where | On the launch profile's rule marker beside project and role, so resumed and migrated generations keep the same person and the block stays frozen per attempt |
| Delivery | First in the block, under its own heading. Its first 2 000 code points are always-on in the scope's order, because a preference such as a report language shares no word with a task brief and word matching would never select it. The rest are candidates like any rule. Both always-on sets together are at most 5 000 code points, 20 000 bytes at four bytes each, so with headings they still fit under 24 000 bytes in any text |
| Condition | Delivered only to a start whose engine memory is off, which holds when the installation's memory source is Delegatus (`source.ts:81-85`). Otherwise an engine could save a delivered personal rule into its own per-project memory, which colleagues' agents load |
| Writers | (1) An agent of a launch that has a person: `leave_lesson` with scope `member`, and a rewrite of a rule in that same scope. The fence keeps refusing machine lessons and every other rewrite for member-bound callers (`workspaceFence.ts:73`). (2) The person, in a "My rules" view: add, edit, delete, keep. (3) The curator, inside the scope only: duplicates, stale rules, contradictions, plain sentences |
| Provenance | Every new lesson, in any scope, records the person its launch worked for (`memberId` on the source). The curator's read gains "backed by N people" beside today's count of tasks |
| A shared seat | A project's seat that several people write to starts with the personal rules of whoever its chain resolves to at that start. It is stated here because it will surprise someone |

**Old releases.** `scopeKind` reads an unknown prefix as a project
(`roleScopes.ts:13-15`). After a rollback a `member:` scope would be listed
as a project of that name that no real project matches, so it is never
delivered and nothing is lost.

### 4.3 From personal rules to company rules

The curator's pass gains a team step. It runs only when the installation has
more than one active member.

1. **Inside each personal scope**: the usual checks.
2. **Classes across people.** The pass reads all personal scopes (small by
   their bound) and groups rules that state one class, as check 5 already
   does for rules from different tasks.
3. **A class qualifies** when all of these hold:
   - at least two people hold a rule of the class, or one person asked for
     it with "Suggest for the team" on their own rule;
   - no person holds a rule that contradicts it. A contradiction means the
     class is a preference, and it stays personal;
   - it can be written so that every reader of the target scope acts on it
     (the existing level check 4), with no person, account or project named;
   - the text raises no privacy hint (`roleTypes.ts:3`,
     `curation/apply.ts:80`).
4. **The curator writes a proposal**, through a new `curate_rules` action:
   target scope, layer, rule text, why, the source rule ids each with the
   hash of the version read, and the number of people behind it. A proposal
   is a row in a collection of its own, so the `role_memory` collection keeps
   its three row kinds. **Nothing is delivered from a proposal.**
5. **A person decides** (Q4: the owner). The rules window lists proposals
   with the text, who will read it in plain words ("every builder, in every
   project"), and how many people's rules stand behind it. The approver may
   edit the text. Declining keeps a reason, and the curator does not propose
   the same sources again.
6. **Approval is one insert.** In one transaction the server checks the
   proposal is open, checks that the text hash is the one shown, and adds
   one active rule to the target scope with `derivedFrom` set to the
   sources. The rule arrives as a lesson no curator has seen, so the next
   pass integrates it with that scope's existing rules. Approving the same
   proposal twice answers with the same rule. **No source rule is moved,
   rewritten or archived by an approval.**
7. **Afterwards**, an ordinary pass may archive a person's copy as a
   duplicate of the company rule, inside that person's scope and under its
   revision check, with the existing reason and `against` field.

**Why approval cannot act on a stale text.** The earlier attempt completed a
move at approval time, so approving an old proposal could archive a rule its
owner had since corrected. Here approval never touches a source. The
proposal still pins each source's version: when a source changed or left
after the proposal was written, the window says so and shows the current
sources, and the server refuses the approval until the approver has seen
that state. The text that becomes active is always the text the approver
read.

**Every path into a company scope, and what the member scope does to it.**
The guard ships in the same slice as the scope (T1), before any curator can
read a personal rule.

| Path into `role:*` or `machine` | Today | With personal scopes |
| --- | --- | --- |
| Curator move, split part or merge (`curation/apply.ts:188-227`) | Allowed within the reach test | Refused whenever a source or a target is a personal scope and the other side is a different scope. Inside one personal scope they work as usual |
| Agent `leave_lesson` to machine | Refused for member-bound callers (`workspaceFence.ts:73`) | Unchanged |
| Agent lesson to `role` or `project` | Allowed | Unchanged. This is project knowledge and reaches the workspace that holds the project |
| The operator's own edits in the rules window | Owner-only | Unchanged for shared scopes. A person edits only their own scope |
| Engine memory import (`src/lib/memory/curation/importApply.ts`) | Curator adopts into shared scopes | Unchanged. Imported text is the installation's and has no person |
| Install transfer | Carries rule rows | Carries personal scopes as they are, keyed by member id. A target without that member keeps them undelivered |
| Promotion into shipped prompts (#3790) | From shared scopes | Unchanged. A personal rule is never a candidate |
| Swarm contribution | From role-on-every-project rules, with the owner's approval | Unchanged. A personal rule is never a candidate |
| Approved proposal | None | The only path from a personal rule to a company rule |

### 4.4 Privacy between people: what is kept and what is not

| | |
| --- | --- |
| Kept | A person's rules are delivered only to starts that work for that person. The "My rules" view shows a person their own scope (Q5). A company rule is new text; people who are not the owner see how many people stand behind it and no names. A personal rule never enters a prompt promotion or the swarm |
| The curator | It is an agent on the installation's own account. It reads every personal scope during a pass, as it reads every project's rules today, and its role forbids quoting rule text outside its tool calls |
| Not kept | Secrecy. All rules are rows of one store that every agent's shell can read, because all agents run as one OS user. An agent working for one person can also repeat a personal rule in a message to a shared seat; the block's notice asks it not to (`roleRender.ts:13`), and nothing enforces that. Selection sends rule text to the selection provider, as it does for every rule today (`docs/design/role-memory-selector-observations.md`) |
| What secrecy would take | One installation under one OS user for each person. Each installation's whole store is then that person's memory, and company rules travel between installations as a read-only pack (§4.5). That is a deployment choice outside this design |

The earlier attempt promised more and each promise became a finding (§9).
This design promises what one store under one OS user can hold.

### 4.5 Relation to the swarm

| | Swarm rules | Company rules |
| --- | --- | --- |
| Readers | Every installation that opted in | One installation |
| Text | Public, shipped with releases, read-only (`swarmPack.ts`) | Private to the installation, in its ordinary shared scopes, curated like any rule |
| Source | Role-on-every-project rules an owner approved for publication | Classes shared by several people's personal rules, approved by the owner |
| Order in a block | After the role's own rules | Personal rules first, then the shared scopes as today |

The two never mix: a personal rule can become a company rule, and only a
shared rule can be offered to the swarm, each through its own approval. One
link is worth noting for later. A company that runs one installation per
person needs company rules to cross installations, and the swarm's receiving
path (a validated read-only pack loaded as a scope) is the mechanism that
would carry a private company pack. It is deferred (§8).

## 5. Workspaces: what is left

### 5.1 The boundary, layer by layer

| Layer | What holds today | What it cannot promise |
| --- | --- | --- |
| Sign-in | A session per person, revocable; with an active owner, nothing but the sign-in page answers without one (`gate.ts:107-122`) | A person's agents outlive their session (§5.3) |
| Browser and API | A member reads and acts only on projects of their workspaces; unknown routes are the owner's (`workspaceRoutes.ts`, `gate.ts:189-202`) | Routes still marked owner-only refuse ordinary work (§5.2) |
| Folders | A launch directory must resolve to a permitted project, by written and real path (`workspaceRoute.ts:104-120`, `spawnCommand.ts:605-607`) | What the launched agent's shell opens afterwards |
| Agent tools | A member-bound agent has a closed tool list and every identity it names must resolve inside its workspace (`workspaceFence.ts`) | A launch with no member principal has installation reach (`:70`): the owner's own, seats nobody bound, scheduled work |
| Accounts | A workspace's pool bounds automatic choice and refuses a member-bound launch outside it (`projectBindings.ts:440-453`) | Every account's login file sits under the same OS user |
| Memory | Scopes decide what a start receives (§4.4) | One store; `global` engine memory is returned under any project filter (`index.ts:282`) |
| Telegram | A report chat and directive chats per workspace (`workspaceDefaults.ts:36-56`) | One bot token for the installation |
| Resources | A memory ceiling per agent and one budget for all (`agentMemory.ts:84-87`, `:163-165`); CPU weights for operator and work hosts (`cpuPlacement.ts:24-25`) | A ceiling per workspace (§5.4) |
| Operating system | Nothing: one user, one home, one set of sockets | Everything above is a rule the Delegatus server applies to its own surfaces |

**The statement for the product.** A workspace inside one installation is a
boundary for a trusted team: each person sees their own boards, starts work
only in their workspace's folders, uses their workspace's accounts and
chats, and cannot act on a colleague's work by mistake. It does not keep
information from a person whose agents have a shell. Separation that holds
against a shell is one installation under one OS user per person or per
team (`docs/design/workspaces.md` §6, level 4). This answers "isolated as it
is now, or better": slices W1 to W4 finish "as it is now"; "better" is that
deployment, and nothing here blocks it.

### 5.2 A member's working day: accounts and the owner-only routes

**W1. Choosing a Claude or Codex subscription.** Per-workspace bindings
exist and are enforced. What is missing is the member's view of them.

- A read for any member: for a project they may act on, the accounts of its
  pool per engine, each with its label, whether it is signed in, and its
  remaining limit windows. No login action, no credential path, no account
  outside the pool. It is a `team` route that checks membership itself, as
  the workspace routes do (`workspaceRoutes.ts:224-227`).
- The composer's engine and account chip reads it for a member and keeps
  reading the full account list for the owner.
- The server-side check does not move: `spawnCommand.ts:608-612` and
  `workspaceFence.ts:151-155` already refuse an account outside the pool.
- Signing an account in, removing it and assigning pools stay with the
  owner and the workspace's manager.
- Whether a provider's plan allows several people to work through one login
  is the owner's check. Provider terms were not examined here.

**W2. One decision for each owner-only route a member's work touches.** Each
row is a small change with its own threat cases; none is opened without one.

| Route | Recommended | Why |
| --- | --- | --- |
| Composer upload, task attachments | Open by project: the upload names a conversation or task, which resolves to a project | A member cannot attach a file today |
| Voice input and speech | Open to any member; they use the installation's keys and carry no project data of others | Voice is how the operator works; a member has none |
| A pipeline's changes and checks | Open by project, read-only | A member can start a pipeline and cannot see what it changed |
| A pipeline's review | Open by project | Same |
| Transcript and memory search in the browser | Open with the project filter forced to the member's projects, as the agent fence does (`workspaceFence.ts:183-188`) | |
| Rules window | A member's own scope only (T1) | |
| Attention and inbox | Open, filtered by project | The "needs you" list already is (`workspaceRoutes.ts:41`) |
| Flows | Keep closed until asked for | No request names them |
| Accounts, keys, updates, deploys, relay, Telegram bot, settings | Stay owner-only | Installation administration |

### 5.3 Revocation reaches running work (W3)

Revoking a person ends their sessions and sign-in codes in one transaction
(`members.ts:544-557`). Two things survive it:

- **Their agents.** Tool calls are refused from that moment, because
  authority is read live (`workspacePrincipal.ts:75-80`), and the processes
  keep running with a shell. Revocation should also interrupt every host
  whose person is the revoked member and hold their queued launches, through
  the existing interrupt path, and record how many it stopped on the same
  team event.
- **Artifact frame capabilities**, valid for 12 hours (`frameScope.ts:21`).
  They should be bound to the session that minted them and die with it.

### 5.4 Resources and usage per workspace (W4, the rest of slice d)

The approved text gives each workspace a systemd slice so that its runaway
agents are the ones the kernel stops. What main has: host placement depends
only on whether a host belongs to a pipeline or a flow
(`cpuPlacement.ts:68-70`), so a member's ordinary conversations are operator
hosts with the highest weight and no ceiling of their own class.

| Option | What it gives | What it costs |
| --- | --- | --- |
| (a) Usage by workspace and a worker share per workspace | The owner sees which workspace spends accounts and worker slots. A workspace cannot occupy more than its share of running workers. Each agent keeps its own memory ceiling and the installation its total | Several open conversations of one workspace can still load the machine. Works on every platform |
| (b) Also a kernel slice per workspace | Every host of a workspace's projects, interactive ones included, sits under that workspace's CPU and memory ceiling. The placement is chosen by the project's workspace for every kind of host. The earlier attempt placed by host kind and left interactive hosts out | Linux with a systemd user manager only; off in a container (`cpuPlacement.ts` header). The installation-wide work quota is one slice today, and per-workspace slices need it re-divided. It changes how every agent host is launched, which is this repository's high-risk area with three review rounds |

Recommendation: (a) now. (b) answers a trusted team's mistakes with a
mechanism sized for an adversary, and where containment is the goal the
per-person installation gives it by construction, since a whole user manager
sits under one slice. Q6 asks, because (a) alone narrows what was approved
on 2026-10-20.

### 5.5 Smaller items

- **Issue #3818** (a seat's form tools refused after a refused read) is an
  open defect of the shipped fence and gets its own repair lane.
- **`global` engine memory in search** stays as it is: with the memory
  source set to Delegatus the engines write none, and with it set to the
  engines an installation has chosen shared engine memory. A note for the
  owner in the workspace guide.
- **Per-person interface language and time zone** stay deferred
  (`sign-in-and-team.md` §14).

## 6. Build plan

Each slice ships alone. A slice that changes a start's block carries its
before and after from the ledger.

| Slice | Content | Depends on | Acceptance, on isolated state unless it says ledger |
| --- | --- | --- | --- |
| **M0** Selector finishes | Scoring and pack in a few large pieces or a worker; incremental byte count. `roleSelect.ts`, `roleLaunch.ts` | Nothing | A test drives selection while the loop is kept busy and gets a selection inside the deadline. Ledger, one week after deploy: `selector-timeout` under 1 % of first selections (48 % before), local phases under 300 ms at p90 (2 116 ms before), no new loop-gap report under the `memory.select` label |
| **M1** Short list for the model; word-match budget | Top candidates to the model (§3.4 step 3); Q2's budget on the word-match path; the ledger row records what the other path would have packed | M0, Q2, Q3 | Every row of the reason table gives one output; no block over 24 000 bytes in one- to four-byte text; a start never sends the model more than the short list, in requests of at most 32; a request that times out is charged as today and counted on the ledger; the allowance cannot be exceeded. Ledger, one month: applied marks per path compared |
| **M2** Reserve in use | §3.2: candidates by scope with the reserve list, two-tier pack, reserve share, search, rules window group, ledger mark | M1; #3834 and #3841 merged | A budget archive is scored, packed within the share, found by search and opened; a rule archived for another reason is none of these; a reserve rule cannot displace a front rule; whole fallback holds front rules only; a start reads rows of its own scopes only; frozen blocks resume byte for byte |
| **M3** Layers and parents | §3.3 and §3.5: fields, server checks, curator checks, rendering, expansion, reserve pointer | M2 | The server refuses a parent outside the reader's scopes, a parent whose layer does not stand above the child's, and a principle over 200 code points; a child renders under its parent and alone without it; expansion adds a parent and removes nothing; replay of §2.3 repeated with links to measure expansion |
| **M4** Front bounds | Q1's answer, as per-scope targets if (b) | M2 | Bounds per scope kind are read from one table; a pass cannot leave a front over its bound |
| **T1** Personal scope, with its guards | §4.2 and the guard rows of §4.3 in one slice: scope kind, person resolver, launch marker, delivery condition, `leave_lesson` scope, fence, apply refusals, `memberId` on sources, "My rules" | M2 | A personal rule reaches a start for its person and no other; no start with engine memory on receives one; every row of the path table is tried with a canary rule and none reaches a shared scope; a member reads and edits only their own scope; the owner's launches resolve to the owner; after a rollback fixture the scope is undelivered |
| **T2** Proposals and approval | §4.3 steps 2 to 7: proposal collection, curator action, window, approve and decline | T1, Q4, Q5 | Nothing is delivered from an open proposal; approval adds exactly the shown text; a second approval answers the same rule; an approval after a source was rewritten, deleted or moved is refused until re-read and changes no source; a declined class is not proposed again |
| **W1** Member's accounts | §5.2 | Nothing | A member sees exactly the pool of a project they may act on, with limits and no login action; a member of another workspace is refused; the chip offers both engines when the pool holds both. Rendered through the existing kanban and phone drivers in en and uk, light and dark |
| **W2** Owner-only routes | §5.2, one row at a time | Nothing | For each opened route: a member succeeds inside their workspace and is refused outside it, by id, by path and by a moved project |
| **W3** Revocation | §5.3 | Nothing | After revocation no host of that person is running, queued launches are held, a frame capability minted before it is refused |
| **W4** Usage and worker share | §5.4 (a); (b) only if chosen | Q6 | Activity groups by workspace and sums match the ungrouped view; a workspace at its share queues its next worker while another workspace still starts one |

Order: M0 first, because every other memory slice changes what the selector
is handed. W1 to W3 are independent of memory and can run beside it. T1
follows M2 because both rewrite how a start's scopes are read.

Slices that touch how hosts are launched (W3's interrupt, W4 (b)) follow the
runtime-host rules of this repository.

## 7. Questions for the operator

**Q1. How large is the first-rank set of each scope?**
What changes: rules inside the limit compete for a start's block first;
rules beyond it wait in the reserve and get only the reserve share.
Example: the builder scope of the largest project has about 57 rules inside
its 15 000 limit and 422 in the reserve. At 20 000 about 20 more would move
up, and every start of that builder would rank about 20 more candidates for
the same block. The replay measured a doubled pool: 11 to 16 points fewer of
the rules agents report using got in. A first rank one third larger was not
measured by itself, and the direction is the same.
- (a) Keep 15 000 for every scope. **Recommended**: the reserve now keeps
  the rest in use, and the measurement argues against a wider first rank.
- (b) Apply the targets recorded on 2026-10-22: 20 000 role here, 30 000
  role on every project, 15 000 project and machine.
- (c) Raise to those targets after slice M3, if the repeated replay shows
  parent links hold the recall.

**Q2. When the model selector does not answer, how much of the 24 000 bytes
may word matching fill?**
What changes: how many matching rules an agent starts with on 48 % of starts
today, and on nearly all of them after the allowance runs out each month.
Example: a builder stage whose pool holds 106 rules gets about 33 of them
today. In the replay that set holds 63.5 % of the rules agents later
reported applying. At 16 000 code points it gets about 60 and holds about
82 % (between the measured 77.6 % at 14 000 and 85.5 % at 18 000). The block
grows from about 10 KB to about 20 KB, roughly 0.05 USD more per Claude Opus
stage and 0.03 USD per Codex stage at API prices.
- (a) Up to 16 000 code points. **Recommended.**
- (b) Keep 9 000.
- (c) 12 000, about 72 %.

**Q3. What should the paid model selector do, given its 5 USD a month ran
out on about the fifth day?**
What changes: whether a model or word matching picks rules for most of the
month.
Example: in six days the model decided 35 of 1 082 starts, and 98 % of the
money went to requests that timed out or came back malformed. An answered
selection cost about 0.002 USD. After M0 and the short list most requests
should answer in time, and at today's volume of about 180 first selections a
day 5 USD then covers roughly the first ten to fourteen days of a month;
about 15 USD would cover all of it. Nothing measured so far shows the model
picking better than word matching.
- (a) Keep 5 USD, send the model the short list, and compare the two paths
  on the ledger for a month before spending more. **Recommended**: it
  follows the 2026-10-22 rule that the model has to beat word matching
  first.
- (b) Raise the allowance to 15 USD now, so the model decides all month.
- (c) Turn the model step off and use word matching alone.

**Q4. Who approves a company rule made from people's personal rules?**
What changes: whether a rule can start reaching every person's agents
without someone having read it.
Example: two people each have "report in short bullet points". The curator
proposes "Reports use short bullet points" for every role in every project.
- (a) The owner approves each proposal in the rules window. **Recommended.**
- (b) As (a), and add a workspace level: a workspace's manager approves
  rules for that workspace's projects, the owner approves company rules.
  This adds a sixth scope and is otherwise deferred.
- (c) The curator promotes by itself when two people share a rule; the owner
  sees it afterwards and can undo.

**Q5. Who can open a person's own rules?**
What changes: whether colleagues can read how you told your agents to work.
Example: a person's rule says to always ask before sending anything to a
client.
- (a) That person and the owner. **Recommended.** It is a view, and it gives
  no secrecy from someone whose agents have a shell (§4.4).
- (b) Everyone in the same workspace, so good rules can be copied by hand.

**Q6. Does a workspace need a hard resource ceiling inside one
installation?**
What changes: whether one workspace's many open conversations can slow the
machine for the others.
Example: one workspace has twelve conversations open while another starts a
build.
- (a) Usage by workspace and a share of the worker limit. Each agent keeps
  its own memory ceiling. **Recommended.** This narrows what was approved
  on 2026-10-20, which named a kernel slice per workspace.
- (b) Also a kernel slice per workspace that covers every host of its
  projects. Linux with systemd only, and a change to how every agent host
  starts.

## 8. Deferred — not currently justified

- **A general rule graph** (typed many-to-many links, selection by walking).
  Reopen when the replay of §2.3, repeated after M3, shows applied rules
  that neither word matching, parent expansion nor the model short list
  reaches.
- **An embedding selector.** No local embedding model runs here
  (`role-memory-layers.md`, deferred list).
- **Per-person secrecy inside one installation**: audiences on
  conversations, origin tracking after project moves, a backfill of who may
  read old records. Every automatic flow across such a boundary in the
  earlier attempt became a finding (§9), and one OS user cannot enforce it.
- **A workspace level of rules**, unless Q4 (b). Project and role-here
  scopes already stay inside the workspace that holds the project, and no
  observed rule holds for all projects of one workspace only.
- **A company pack between installations**, loaded read-only like the swarm
  scope, for a company that runs one installation per person.
- **A kernel slice per workspace**, unless Q6 (b).
- **Returning rules archived for a reason** (task-specific, stale,
  contradicted, in code) to use. They left because they should not be read.
- **Removing the front bound or raising the 24 000-byte maximum.**
- **Per-person interface language and time zone**, and several owners
  (`sign-in-and-team.md` §14).
- **Member rules for the roles that take no rules** (reviewer, verifier,
  curator). The 2026-10-07 rule stands.
- **Flows for members.**
- **An agent-enforced ban on repeating a personal rule in a message.** It
  would need output inspection on every tool call and still not cover
  paraphrase.

## 9. The earlier critique, premise by premise

The third critique of the earlier attempt left six P1 findings and one P2.
Each names a premise that was wrong. Each was observed again on `ec82e477f`.

| Premise the earlier design relied on | Observed on main | In this design |
| --- | --- | --- |
| Checking what an agent reads keeps a private text from a wider audience | Still false. A member-bound agent may send a message, create and update tasks (`workspaceFence.ts:28-35`), and text is forwarded as written | No private audience exists inside an installation. A personal scope decides delivery and promises no secrecy (§4.4) |
| The server's own checks govern all memory a start loads | Still false. The engines load their own per-project memory unless the source is Delegatus (`source.ts:81-85`, `cli.ts:472-473`, `:550`), and rules are delivered while the source is unchosen too (`settings.ts:45-47`) | Personal rules are delivered only to a start whose engine memory is off (§4.2), tested in T1 |
| The owner's messages carry no member author, so old owner records can be recognised by that | Still false. Authorship is recorded for every signed-in member, the owner included (`authorship.ts:42-50`), and the workspace principal is absent for the owner (`workspacePrincipal.ts:38`) | Nothing is relabelled or backfilled. The person resolver answers for the owner on purpose (§4.2) |
| A record's original workspace is enough to decide who may read it after projects move | Not applicable. Placement moves all of a project's history at once (`src/lib/team/workspaces.ts:246-268`) and access follows the current placement (`workspaceAccess.ts:43-48`) | No origin is recorded. A personal scope is keyed by the person and does not move with a project |
| Slices can ship in an order where team text is readable before the approval gate exists | The widening paths are move, split and merge in one synchronous call (`curation/apply.ts:188-227`) | The refusals for personal scopes ship in the same slice as the scope (T1). T2 adds the only path upward. At every intermediate state a personal rule has no route into a shared scope (§4.3 table) |
| Placing hosts by pipeline or flow membership covers a workspace's load | Still false. Any other host is an operator host (`cpuPlacement.ts:68-70`), which is every ordinary member conversation | No per-workspace ceiling is claimed. Q6 asks the operator whether to narrow the approved promise; option (b) places by the project's workspace for every host kind (§5.4) |
| A delayed approval can complete a move decided earlier | Today's curation is safe because it is synchronous under scope revisions (`curation/apply.ts:150`), which cannot be held across a wait | Approval inserts one new rule with the exact text shown and never changes a source. Stale sources block approval until re-read; a repeated approval answers the same rule (§4.3) |

## 10. Validation against the requirement

| The request (paraphrased, 2026-11-03) | Where answered |
| --- | --- |
| Find the earlier work | §1, §1.2 |
| Raise the character limits | Q1 for the first rank; the reserve has no limit (§3.2, §3.6); Q2 for what a start receives |
| Keep all memory | Already true for text (§2.1); §3.2 keeps what leaves the first rank in use |
| Use all memory | §3.1 defines it as four testable properties; §3.4 fills the block; §2.2 and §2.3 show why the selector has to finish first |
| Consolidate, perhaps as a graph, so that it assembles | §3.3 weighs a graph against the decided layer and parent link and keeps the decision with three uses of the link; §3.5 gives the curator's steps |
| Each person's account has its own rules | §4.2 |
| The curator builds company rules from them | §4.3, with criteria, provenance and approval; §4.5 for the swarm |
| Finish workspaces with isolation, as now or better | §5.1 states what "as now" holds per layer and what "better" takes; W1 to W4 finish it |
| Each person signs in and sees only their workspaces | Shipped (#3255); §2.6 |
| Works only in their folders, does their own actions | Shipped for launches and tools (§2.6); W2 opens the everyday routes still refused; W3 for revocation |
| Chooses a Claude or Codex subscription | W1 |
| Per-workspace account bindings | Shipped (#3415); W1 shows them to the member |

## 11. What could not be confirmed, and where I looked

- **What a signed-in member sees in the composer.** No browser was driven in
  this stage. The claim that a member has no account list rests on the route
  table (`workspaceRoutes.ts:7-26`), the gate (`gate.ts:199-202`) and the
  hook that treats a refusal as a failed read (`useEngineAccounts.ts:784-785`).
  W1 starts by rendering it.
- **Why local scoring waits.** The phase timings are observed and the
  arithmetic was timed in isolation; the serving process was not profiled.
- **Whether the model selects better than word matching.** 35 model-decided
  starts and an in-sample evaluation of 24 cases cannot say. M1 records what
  will.
- **How much parent expansion adds.** No rule has a layer or a parent yet.
- **The replay's labels.** Self-reported, sparse, and after 2026-11-04
  possible only for delivered rules. Rule text is today's.
- **Team behaviour on a real team.** The measured installation has one
  person. Every team figure in §4 is a design value with no data behind it:
  the 4 000 bound, the 2 000 always-on share, "two people".
- **Provider terms** for several people using one subscription login.
- **A systemd slice per workspace** was not probed; §5.4 (b) describes it
  from the placement code.
- **Issue #3818** was read and not reproduced.

## Notes

- The earlier attempt's pull request #3606 holds a file of the same name on
  its own branch. This document is a new file on a branch from `main`; that
  pull request is to be closed as superseded.
- Open pull requests that touch files named in the build plan were listed
  on 2026-11-11: #3834 and #3841 (scope history rows), #3838 (import host and
  curator engine). No open pull request changes the selector, the fence or
  the route table.
- The probes behind §2 ran in a stage scratch directory and were removed
  with it. Each is a read-only query that a later stage can repeat: counts
  of rule rows by state and reason; ledger rows grouped by reason with their
  phase timings; and the replay of §2.3, which joins applied marks, ledger
  pools and pipeline briefs.
