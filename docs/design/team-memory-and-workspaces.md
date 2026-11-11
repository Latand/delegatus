# Team memory and workspaces: every rule kept and in use, company rules from each person's rules, and what a member still lacks

Status: design, second revision of 2026-11-11, after one critique of the
first (§12 says how each finding was answered). Written against `main` at
`ec82e477f`; `main` has since gained #3837, which touches no file named here.
File and line references are to that commit. It replaces the earlier attempt
of 2026-11-03 (PR #3606), which is input about what went wrong.

Live records of one installation were read read-only on 2026-11-11 at 01:48
UTC: the learned-rule store, the per-start delivery ledger and the pipeline
briefs, each copied or exported to a scratch directory first. Every count in
§2 comes from that one reading. Only counts appear here: no rule text, rule
id, person, account or path, and projects are named by kind.

This stage wrote one file. Nothing is built.

## Originating requirement

Operator, 2026-11-03, by voice to the project's orchestrator. The words are
private speech and are kept out of this repository. What was asked for, in
this document's own words and grouped by area:

**Memory**

- Learned rules stop being lost to size limits: the limits go up, nothing is
  dropped, and what is kept stays usable by agents.
- Decide how rules are organised so that related ones come together, and
  weigh a graph for that. Earlier work on this exists and is to be found
  before anything is designed.

**Team**

- Each person on a team has rules of their own.
- The curator derives company-wide rules from them.

**Workspaces**

- Workspaces are completed so that one installation can serve a company:
  a sign-in per person, and each person limited to their own workspaces,
  folders and actions.
- A person can pick a Claude or a Codex subscription.
- Accounts are bound per workspace.
- The separation between people is no weaker than today's.

Operator decision, 2026-11-11, on the stalled first design: write the design
again from the request and the current code, with one critique.

Two earlier requests stand behind this one and are paraphrased in the
documents that answered them: team workspaces with some isolation
(2026-10-20, `docs/design/workspaces.md` §0) and a larger, layered memory
(2026-10-21, `docs/design/role-memory-layers.md`, "Originating requirement").

## 0. What changes for a person

**For whoever runs agents (memory).**

- Rule selection stops holding up agent starts. Today the selector takes a
  median 3.1 seconds per start, and on 49 % of starts it runs out of its
  three seconds and hands over whole scopes in curator order, cut at the
  byte ceiling (§2.2). After slice M0 the selection is finished in the turn
  it starts in.
- A rule that no longer fits a scope's limit stays in use. Today it is
  archived for budget, and no start and no search sees it again until a
  curator brings it back: 570 rules beside 1 097 active ones on the
  installation measured here. They become a **reserve**: scored at every
  start, given a bounded share of the start's rules, found by
  `search_memory`, and shown as a reserve in the rules window.
- The limits go up as already decided on 2026-10-22: 20 000 code points for
  a role in one project, 30 000 for a role on every project, 15 000 for a
  project and for the machine. Word matching may fill more of a start's
  24 000 bytes (Q1).
- Rules gain the decided levels (principle, practice, specific) and a link
  from a rule to the more general rule it serves. The curator uses the link
  to keep a class of rules represented when its details move to the reserve.
  A wider graph is weighed in §3.3 and deferred.

**For a team member.**

- You get **rules of your own**: how you want work done (language, form of
  reports, what to ask before acting). They reach the agents you start
  yourself: your conversations, the agents those spawn and the pipelines you
  create. A project's shared seat reads none of them, because it serves
  several people. You can read and edit them.
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
  It keeps no secret from a person whose agents have a shell.
  Confidentiality between people takes one installation under one OS user
  for each of them, which is a deployment choice outside this design.

Five questions for the operator are in §7.

## 1. Earlier answers this design starts from

Each record was read. None is reopened unless the request or a new
measurement changes it, and §1.1 says where.

| Record | What it settled | State on main |
| --- | --- | --- |
| `docs/design/role-memory.md` (2026-10-07), `docs/design/role-memory-curation.md` (2026-10-11) | Stage-end lessons, four levels, a bound per scope, a curator on the seat tick, nothing deleted for disuse, reviewers stay clean | Built |
| `docs/design/role-memory-layers.md` §7.3, operator form of 2026-10-22 (research #3180) | (1) role-on-every-project is written by the curator only; (2) a model selector only if a second pilot beats BM25 by 10 points at equal budget, else BM25; (3) one hard maximum of 24 000 bytes per launch; (4) store targets 20 000 role here, 30 000 role on every project, 15 000 project and machine, raised together with selected delivery; (5) a layer field and a parent link, principles always-on up to 3 000; (6) own per-feature spend caps; (7) the operator checks quality by eye | Slice 1 built (#3191). Selected delivery is live (#3611). Layers and per-scope targets are unbuilt (§2.1) |
| #3607 (2026-11-03) | The curator rewrites compressed rules as plain sentences, and archives for budget where it used to compress. One interim bound of 15 000 for every scope | Built: `src/lib/memory/roleTypes.ts:11`, `src/lib/memory/curation/brief.ts:14` |
| #3340 (2026-10-25) | A new lesson never evicts another; the curator integrates and restores budget archives | Built: `src/lib/memory/roleConsolidate.ts:69-92` |
| #3611 (merged 2026-11-04) and `docs/design/role-memory-selector-observations.md` | Selected delivery went live on a model provider chosen by the connected key, with BM25 when the provider fails and whole delivery when BM25 fails; shadow mode retired. Its committed evaluation shows no ten-point lead over BM25, so the bar of decision 2 above is still unmet | Built. §2.2 measures its first week |
| `docs/research/memory-selection.md` (2026-10-02, after the pilot on PR #2475) | A graph was tried as a gate on memory offers and lost the one useful offer; graph evidence should not be a mandatory gate | Stands. §3.3 builds on it |
| `docs/design/swarm-role-memory.md` (2026-10-22), operator form of 2026-10-23 | Opt-in public role rules shipped with releases, 4 000 code points per role, read-only | Receiving is built with an empty pack (`src/lib/memory/swarmPack.ts:9-10`, `src/lib/memory/swarmRules.json`) |
| `docs/design/sign-in-and-team.md` (#2243, 2026-09-26) | Members, revocable sessions, authorship on messages, who-did-what | Built |
| `docs/design/workspaces.md` §12, operator form of 2026-10-20 | Level 2: views and permissions, an agent fence through the Delegatus tools, per-workspace defaults. The owner creates workspaces, a manager adds projects and invites, an Unassigned group, a shared account pool with a per-workspace allow-list and usage by workspace, one Telegram bot with per-workspace chats | Slices (a) #3133, (b) #3255 and (c) #3415 are merged. Slice (d) is unbuilt (§2.6, §5.4) |
| `docs/design/workspaces.md` §6 | Level 2 separates attention, defaults and mistakes. Containing an agent's shell takes one OS user per workspace (level 4) | Stands, and §5.1 restates it per layer |

### 1.1 Where this design departs from an earlier answer

- **The scope bounds are applied as recorded, and are asked about no more.**
  Decision 4 of 2026-10-22 raises them, and the request of 2026-11-03 asks
  for higher limits again. Slice M4 applies the recorded targets. The first
  revision of this document put them back to the operator on a measurement
  that could not show what it claimed (§2.3); that question is withdrawn.
- **The 9 000-code-point selected budget is put to the operator as Q1, for
  the word-match path.** It was sized for a model selector that answers with
  probabilities. Word matching decides 48 % of starts today and would decide
  nearly all of them once the selector finishes (§2.2).
- **The live model step is put to the operator as Q2.** Its first week is
  new information: it decided 3 % of starts and 98 % of its spend bought no
  selection (§2.2).
- **Slice (d) of workspaces is put to the operator as Q5.** The approved
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
English phrasings (memory graph consolidation, keep all memory, a person's
rules into company rules, personal rules and seats, workspace isolation and
subscription choice), and `search_memory` for the same subjects (no hits).
The transcript hits led to the designs and pull requests in the table above,
which are cited in place of the conversations. GitHub issues were searched
for memory graph, swarm and workspace: #3818 (a seat's form tools answer
`workspace_forbidden`) and #3131 (relay allow-list after workspaces) are
open and touch §5; no issue proposes a rule graph. The "graph" the request
remembers is the 2026-10-02 study.

## 2. Inventory: shipped, open, missing

### 2.1 Memory

| Piece | State | Evidence |
| --- | --- | --- |
| Rules are never deleted: every rewrite keeps the earlier version, every archive keeps the text and its reason | Shipped | `src/lib/memory/roleStore.ts:310` (`versionedRule`), `src/lib/memory/roleTypes.ts:111-116` (`RuleDeparture`), `:37-39` (states and reasons) |
| Four scopes a start reads (role here, role on every project, project, machine) plus the opt-in swarm scope | Shipped | `roleStore.ts:156-158`, `src/lib/memory/roleScopes.ts:13-15` |
| One bound of 15 000 code points per scope; over 125 % of it rules leave only when no curator can run | Shipped (#3607, #3340) | `roleTypes.ts:11`, `roleConsolidate.ts:69-92` |
| The curator archives for budget after integrating, with a note of the lost coverage, and reads every budget archive on every pass | Shipped | `curation/brief.ts:14` (check 7), `src/lib/memory/curation/read.ts:65`, `src/lib/memory/curation/apply.ts:176-181` (restore) |
| The curator's brief also aims at 16 000 bytes across a reader's four scopes | Shipped; written for whole delivery | `curation/brief.ts:14`, `:22-24` |
| **A budget archive is out of use**: a start's candidates are the active rules of its scopes; `search_memory` reads active rules only | Shipped behaviour, the gap of §3.1 | `roleStore.ts:255-256`; `src/lib/memory/roleSearch.ts:6-18`, `src/lib/memory/roleViewSource.ts:769-791` |
| Selected delivery: operator-kept rules always-on up to 3 000 code points, selected rules up to 9 000, every block under 24 000 bytes, three-second deadline, block frozen per attempt | Shipped (#3191, #3611) | `src/lib/memory/roleSelect.ts:10-12`, `:22-30`, `:75-78`; `src/lib/memory/roleSelection.ts:116-146`; `src/lib/memory/roleRender.ts:50-66` |
| Local BM25 scoring and the pack give up the event loop every 16 rules, and the pack renders the whole block again for each rule it adds | Shipped; each yield waits for a loop turn (§2.2) | `roleSelect.ts:37`, `:59`, `:71`, `:77`; `src/lib/cooperative.ts:11-13` |
| A first selection copies the whole rule collection before it picks its scopes | Shipped; measured in §2.2 | `roleStore.ts:118-120`, `:250`; `src/lib/state/sqliteStateStore.ts:1901-1903`; `src/lib/memory/roleLaunch.ts:97` |
| Model selection through a provider chosen by the connected key; a pool above 120 000 code points skips it; spend reserved against 5 USD a month. No saved choice selects word matching alone | Shipped | `roleSelect.ts:134`, `:147-152`; `src/lib/memory/roleSelectionSpend.ts:5`, `:26`; `src/lib/openaiServices/policy.ts:37` |
| The delivery ledger: one row per engine start with delivered ids, reason, timings and cost; the last 10 000 starts | Shipped | `src/lib/memory/deliveryLedger.ts:15`, `:238` |
| `applied` and `misled` on `leave_lesson`, accepted only for ids the attempt received | Shipped (#3191) | `roleTypes.ts:221-222`, `deliveryLedger.ts:271-284` |
| Lineage links on rules: merged from and into, moved from, split from, versions | Shipped | `roleTypes.ts:129`, `:139-140`, `:147-153` |
| `layer` and `parent` | **Missing** (decision 5 of 2026-10-22) | no such field in `roleTypes.ts:118-158`; `roleSelect.ts:65` notes "Layers arrive in slice 3" |
| Per-scope store targets | **Missing** (decision 4); one constant serves every scope | `roleTypes.ts:11` |
| Open pull requests on the same files | #3834 (a scope's history digest reads its row once) and #3841 (a scope's history moves into rows of its own, shipped switched off) change `roleStore.ts`, `roleViewSource.ts`, `curation/apply.ts` and `curation/store.ts`; #3838 touches the memory import host and `curation/run.ts` | read 2026-11-11; M0, M2 and T1a start after #3834 and #3841 land |

### 2.2 What a start receives today (measured)

Delivery ledger rows from 2026-11-05 00:00 UTC to 2026-11-11 01:48 UTC. The
last block above 24 000 bytes is dated 2026-11-04 17:52 UTC, so the whole
window ran the selected delivery of #3611. The window holds 2 323 engine
starts: 1 214 with no rule block (roles that read none, or no role), 1 088
first selections and 21 resumed starts that reused their frozen block.

| Outcome of a first selection | Starts | Share | Block, median |
| --- | ---: | ---: | ---: |
| The selector ran out of its three seconds; whole scopes in curator order, cut at the byte ceiling from the tail of the largest scope (`selector-timeout`, `roleRender.ts:54-63`) | 528 | 49 % | 23 881 bytes, 88 rules |
| Word-match (BM25) selection after the provider timed out (211), the monthly allowance was spent (246) or the answer was malformed (68) | 525 | 48 % | 9 709 bytes, 33 rules |
| The model's selection | 35 | 3 % | 9 600 bytes |

**The wait.** Selection took a median 3 074 ms and 4 785 ms at p90 over the
1 088 first selections. Every start of a role that reads rules pays it.

**Where the three seconds go.** Of the 528 timeouts, 456 ended inside local
scoring and 72 inside local packing. When local scoring finished (560
starts) it took a median 860 ms and 2 116 ms at p90; when it did not, the
phase had run a median 3 407 ms. The same arithmetic, run in one piece in a
scratch process under the pinned Bun on the real briefs and pools of 2 095
recorded attempts (pools up to 245 rules), took a median 2.6 ms, 5.5 ms at
p90 and 19.4 ms at most. So the work is milliseconds and the time is spent
waiting: the loop gives up its turn every 16 rules (`roleSelect.ts:37`,
`:59`), a pool of 193 rules (the median where scoring finished; 234 at p90)
needs about 25 turns, and each turn cost a median 40 ms and 100 ms at p90
where scoring finished, and at least 287 ms at the median where it timed
out.

**What holds the loop is an inference.** The serving process was not
profiled. Two measured candidates:

- The start's own read. Before a first selection picks its scopes it copies
  every row of the rule collection (`roleStore.ts:250`,
  `sqliteStateStore.ts:1901-1903`). On a scratch copy of the same rows
  (14 626 rows, 274 MB of JSON, of which 256 MB is scope history) that copy
  took 1.5 to 1.8 seconds in five runs under the pinned Bun, with nothing
  else running. It happens before the three-second clock starts
  (`roleLaunch.ts:97`, `:101-102`), so it blocks every other selection in
  flight and is not counted in its own.
- Other readers of the same oversized scope rows. #3834 reports loop stalls
  of ten to seventy-four seconds from a digest that re-read each scope row once
  per history entry.

**The allowance.** 4.54 USD of selection spend falls in the window and the
month stands at 4.996 of 5 USD. The first refusal for a spent allowance is
dated 2026-11-08 09:19 UTC, the fourth day of live use; every later start
took the word-match path. A request that times out keeps its whole reserved
ceiling (`roleSelect.ts:176-184`). Of the 314 starts whose selection went to
the provider, 35 got a usable answer. The 211 timeouts account for 3.67 USD
(a median 0.019 USD each, with a median 191 candidates), the 68 malformed
answers for 0.77 USD, and the 35 answered selections for 0.10 USD (a median
0.002 USD each, with a median 88 candidates). So 98 % of the spend bought no
selection.

**The provider's time.** 313 of those starts reached the request itself and
waited a median 1 476 ms there and 2 859 ms at p90. The 35 answered ones
took a median 1 775 ms and 2 570 ms at p90.

**The committed evaluation** (`evals/role-selection/README.md`) has 24 cases
with four candidates each. On it the model kept 49 of 64 applied rules and
BM25 kept all 64, with the threshold tuned on the same cases. It does not
show that the model selects better.

### 2.3 Which rules agents report using (offline replay, run again)

Each stage answer may name rules it applied (`roleTypes.ts:221`). 2 095
attempts carry 6 475 such marks. For each, the replay took the brief the
selector uses (`roleLaunch.ts:107`: task up to 2 000, specification up to
8 000, stage prompt up to 3 000 characters), the attempt's pool from the
ledger (every rule its starts delivered or scored, each in the exact text
version whose hash the ledger recorded), and the shipped BM25 arithmetic and
pack rule (`roleSelect.ts:32-80`), and asked whether each applied rule would
be inside a pack of a given size. No provider was called.

A mark is possible only for a rule the attempt received
(`deliveryLedger.ts:271-284`). That splits the attempts into three groups
with different meaning:

| Applied rules kept in a BM25 pack of | 9 000 | 12 000 | 14 000 | 16 000 | 18 000 | 21 000 code points |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before selection went live: every pool rule was delivered and could be marked (1 712 attempts, 5 380 marks, pool median 105 rules) | 66.8 % | 75.0 % | 79.1 % | 82.7 % | 86.2 % | 90.6 % |
| After, starts that fell back to whole delivery (179 attempts, 513 marks; the pool is known only as the rules that fitted under the ceiling) | 61.0 % | 70.8 % | 75.8 % | 79.7 % | 85.0 % | 93.0 % |
| After, selected starts: only the selector's own choice could be marked (204 attempts, 582 marks) | 87.6 % | 96.6 % | 97.9 % | 98.3 % | 98.5 % | 98.8 % |

The third row shows the bias plainly: a selector looks good on labels that
only its own choices can earn. The design uses the first row and nothing
else.

What these figures cannot show:

- Marks are self-reported and sparse. A missing mark does not show a rule
  was useless.
- **Nothing here measures a rule that was not delivered.** A budget archive
  is delivered to nobody (`roleStore.ts:255-256`), so it has no marks by
  construction: 47 of the 570 were ever marked, each while it was still
  being delivered. Any
  ranking that mixes unlabelled rules into a pack of fixed size lowers the
  measured share of the labelled ones, whatever the unlabelled ones are
  worth. The first revision read such a row as evidence that more candidates
  harm selection. It is not evidence either way, and no recommendation in
  this document rests on it.
- The reserve share of §3.4 is how that evidence comes to exist: a reserve
  rule that is delivered can be marked.

The one consequence the design uses: the word-match path at 9 000 code
points keeps two thirds of what agents report applying, where whole delivery
kept all of it. Q1 asks how much room it gets.

### 2.4 The store (measured)

Read 2026-11-11 01:48 UTC.

| Fact | Count |
| --- | ---: |
| Current rules (5 015 earlier versions are retained beside them) | 3 807 |
| Active | 1 097, 292 361 code points of rendered lines, a mean 267 per line |
| Archived for budget | 570, 154 318 code points: 546 in role-here scopes, 19 in role-on-every-project, 5 in machine |
| ...of which reported applied at least once, at least twice | 47, 20 |
| ...of which last changed on 2026-11-10 | 498 |
| Rules that ever left for budget, and are active again | 1 028, 93 |
| Merged as duplicates; archived as task-specific; as already in instructions | 1 000; 730; 163 |
| Rules the operator kept | 1 |
| Rules with a layer or a parent | 0 |
| Scopes whose active list is over 15 000 code points (lessons no pass has seen yet) | 6, the largest 17 818 |
| The largest reader with its budget archives | 177 939 code points: 223 active rules and 432 archived |
| The scope with the most budget archives | 422 rules, 114 589 code points, beside a front of 57 rules |
| Scope rows, and the bytes of history they retain | 178, 256 MB |

Since #3607 raised the bound and told the curator to write plain sentences
and archive what no longer fits, the store has kept everything and used two
thirds of it by size.

### 2.5 Team memory

| Piece | State | Evidence |
| --- | --- | --- |
| A notion of a person in memory | **Missing.** A lesson's source names a project, a role and a conversation. No scope kind is a person's | `roleTypes.ts:35`, `:56-106` |
| A member's own launches carry that member | Shipped: the launch profile holds a member principal, set at admission from the signed-in person or from the calling conversation, and a pipeline carries its creator's. It is absent for the active owner | `src/lib/accounts/migration/contracts.ts:60`; `src/lib/agent/spawnCommand.ts:707-711`, `:1078`; `src/lib/pipelines/engine.ts:15651-15657`; `src/lib/team/workspacePrincipal.ts:38`, `:43` |
| Who a conversation is fenced as | Shipped: its own launch principal, else the principal stored on a seat, else the latest message author, else its parent. A seat stores the principal of whoever designated it | `workspacePrincipal.ts:35`, `:40`, `:47`; `src/lib/orchestrator/seats.ts:84`, `:1064` |
| The owner's browser messages carry the owner as author | Shipped: authorship is recorded for any signed-in member, the owner included | `src/lib/team/authorship.ts:42-50`, `src/lib/team/contract.ts:13` |
| A root conversation a person launched reads project and machine rules, only while the engines' own memory is off | Shipped | `src/lib/memory/operatorMemory.ts:24-26`, `:35-40`; `roleLaunch.ts:66` |
| A member's agent may leave `role` and `project` lessons; `machine` lessons and rewrites are refused | Shipped (#3415) | `src/lib/mcp/workspaceFence.ts:73` |
| Rule search without a project reads every scope key; a rule whose scope has no project is answered as global; open-by-id reads any active rule | Shipped | `roleViewSource.ts:772`; `roleSearch.ts:8-12`; `src/lib/memory/index.ts:320-321` |
| The rules window and its API | Owner-only | `src/lib/team/workspaceRoutes.ts:142-144`, `src/lib/team/gate.ts:199-202` |
| Learned rules are delivered while the memory source is unchosen or Delegatus; the engines' own memory is off only once the source is Delegatus and its import has finished | Shipped. On the measured installation the source is Delegatus with the import still running, and 269 of 536 Claude starts in the window loaded the engine's own memory index | `src/lib/memory/settings.ts:45-47`, `src/lib/memory/source.ts:81-85`, `src/lib/agent/cli.ts:472-473`, `:550`; ledger |
| The curator's pass covers the role scopes of its project, every role-on-every-project scope, the project and the machine, found by key prefix; it reads other projects' same-role rules as evidence. Its conversation is launched in the pass's project | Shipped | `src/lib/memory/curation/store.ts:240-257`, `:298-301`; `curation/read.ts:68`; `src/lib/memory/curation/run.ts:77` |
| The curator authors text in any scope of its pass: rewrite, merge text, split parts, import parts, restore, move | Shipped | `curation/apply.ts:117`, `:147`, `:175-226` |

### 2.6 Workspaces

| Piece | State | Evidence |
| --- | --- | --- |
| Sign-in, sessions, revocation of sessions, authorship | Shipped (#2243) | `src/lib/team/members.ts:544-557`, `authorship.ts:42-50` |
| The record: workspaces, members with a role (manager or member), a project in at most one workspace, defaults | Shipped (#3133, #3415) | `src/lib/team/store.ts:356-385` |
| What a person reaches: the owner everything; a manager their workspaces and every Unassigned project; a member their workspaces | Shipped (#3255) | `src/lib/team/workspaceAccess.ts:10-51` (`:21`) |
| One decision per API route, unknown routes owner-only; a member is refused every `owner` route | Shipped (#3255) | `workspaceRoutes.ts:1-2`, `:264-273`; `gate.ts:189-202` |
| A launch directory must resolve to a permitted project, by its written path and by its real path | Shipped | `src/lib/team/workspaceRoute.ts:104-120`; `spawnCommand.ts:605-607` |
| Agent tool calls of a member-bound launch: a closed tool list, every identity in the call resolved to a permitted project, collection reads forced to the caller's project, answers filtered | Shipped (#3415) | `workspaceFence.ts:28-35`, `:72`, `:87`, `:104-134`, `:164-176` |
| A launch with no member principal passes the fence untouched | Shipped, by design | `workspaceFence.ts:70` |
| Per-workspace account pool, report chat and directive chats, set by a manager; a project reads them through its workspace | Shipped (#3415) | `src/lib/team/workspaceDefaultsRead.ts:5-9`, `:41-46`; `src/lib/team/workspaceDefaults.ts:36-56`; `src/lib/projects/settings.ts:387`; `src/lib/telegram/bot/reportReplies.ts:123` |
| The pool is enforced: automatic choice stays inside it, a member-bound launch or tool call on an account outside it is refused. A project with no pool allows every account | Shipped (#3415) | `src/lib/accounts/projectBindings.ts:430-453`; `spawnCommand.ts:608-612`; `workspaceFence.ts:151-155` |
| **A member choosing an account** | **Missing.** The account list, the limits and every account route are owner-only, and the composer's account hook treats a refusal as a failed read | `workspaceRoutes.ts:7-26`, `:76`; `src/hooks/useEngineAccounts.ts:784-785` |
| **Everyday routes that answer 403 to a member** | Composer upload (`:46`), task attachments (`:187`), voice input (`:236`) and speech (`:245`), transcript and memory search (`:164-165`), a pipeline's changes, checks and review (`:116-118`), flows (`:64`), the rules window (`:142-144`), attention and inbox (`:37`, `:68`) | `workspaceRoutes.ts`, lines as given |
| **Revocation and running work** | Sessions and sign-in codes end. A member-bound agent's authority is read live, so its tool calls are refused afterwards. Its process keeps running. An artifact frame capability lives 12 hours | `members.ts:544-557`; `workspacePrincipal.ts:75-80`; `src/lib/artifact/frameScope.ts:21` |
| **Usage by workspace** | Missing. A member's activity view is filtered to their projects; nothing groups by workspace | `src/lib/activity/report.ts:134`, `:282` |
| **Resource limits per workspace** | Missing. One memory scope per agent, one work slice for the installation, a worker limit per machine and per project | `src/lib/runtime/agentMemory.ts:84-87`; `src/lib/runtime/cpuPlacement.ts:24-25`, `:68-70`; `src/lib/operator/workerLimit.ts:8-11` |
| The engines' own memory in `search_memory` | Entries indexed as `global` (the owner's global instructions and preference sections) are returned under any project filter, to a member's agent too | `index.ts:282`, `:313`, `:322`; `src/lib/memory/parsers.ts:119-127` |
| Open defect | A designated seat's form tools answer `workspace_forbidden` after a refused read | issue #3818 |
| Open pull requests on the same files | #3841 adds a route to `workspaceRoutes.ts`; #3731 and #3795 restructure `workspaceFence.ts`, including the lines around the `leave_lesson` refusal at `:73`; #3710 adds a tool to the fence's lists and changes `spawnCommand.ts` and `seats.ts`; #2926 changes `agentMemory.ts` | read 2026-11-11; T1a and W2 start after #3731, #3795 and #3710 land, W4 after #2926 |

## 3. Memory: keep all of it, use all of it

### 3.1 What "keep" and "use" have to mean

Keeping is done: no path deletes a rule's text. What is lost is use. A rule
archived for budget is absent from every start and every search, for as long
as the curator finds nothing weaker to exchange it for. In the largest scope
that is 422 rules behind a front of 57.

A start cannot read everything: the largest reader holds 177 939 code points
against a 24 000-byte block. So "use all of it" is defined as four
properties, each testable:

1. **Scored at every start.** Every active rule and every reserve rule of the
   reader's scopes is ranked against the brief.
2. **A share of the block.** Reserve rules that match the brief enter the
   block within a bounded share that is set aside before the front is
   packed.
3. **Found on demand.** `search_memory` returns reserve rules, marked as
   such.
4. **Reachable from what was delivered.** Once parent links exist, a
   delivered rule that has reserve children says so, and an agent can open
   them.

### 3.2 The reserve

**No new stored state.** The reserve of a scope is, by definition, its rules
with `state: "archived"` and `reason: "budget"`. Every reader computes it
from that definition, so there is no list to keep in step and nothing to
backfill: the 570 budget archives that exist today are the reserve the day
the slice ships. Those rows already keep their text, their curation mark and
their departure log. Rules archived for any other reason (task-specific,
stale, contradicted, in code, in instructions, no reader, duplicate,
deleted) left because they should not be read, and stay out.

A scope then has two tiers:

| Tier | What it is | Bound | Who reads it |
| --- | --- | --- | --- |
| Front | Today's active list, in curator order | The scope bound (§3.6) | Every start. It is the whole of a start whose selection failed |
| Reserve | Rules archived for budget | None. The curator's checks remove what is stale or duplicated | The selector, within the reserve share; `search_memory`; the curator |

What changes in code, by reader and writer (slice M2):

| Path | Today | With the reserve |
| --- | --- | --- |
| Start candidates (`roleStore.ts:248-267`) | Active rules of the reader's scopes, picked out of a copy of the whole collection | After M0 the front is read by key. The reserve is one range query over the rule rows, filtered to the reader's scope keys (aliases included), the archived state, the budget reason and no version parent: the pattern `roleViewSource.ts:79-84` already uses. On a scratch copy of today's rows it took 25 to 44 ms for the largest reader (432 reserve rules out of 8 822 rule rows). It runs once per attempt, because a block is frozen |
| Selection (`roleSelect.ts`) | One pool, one ranking | Two tiers (§3.4) |
| Whole fallback and starts with no selection | Active rules, cut from the tail of the largest scope at the ceiling | Unchanged: the front only |
| Frozen block (`roleSelection.ts:90-112`) | Withdraws a rule only when the operator deleted it or its exact text is gone | Unchanged. A reserve rule's text resolves the same way |
| `applied`, `misled` | Accepted for delivered ids | Unchanged, so a reserve rule earns evidence when it is used |
| Agent rewrite (`roleStore.ts:389-394`) | Any active rule of the attempt's readable scopes, delivered or not | Unchanged for active rules. New: a reserve rule may be rewritten by an attempt that received it. It keeps its tier and gets a new version. This is a new, narrower condition and is stated as one |
| `search_memory` (`roleSearch.ts`) | Active rules | Front and reserve, the reserve marked in the hit |
| Rules window | "Left" lists every archive together | A "Reserve" group with its count, apart from rules that left for a reason |
| Ledger row | Delivered ids | Also which delivered ids came from the reserve |

Because the reserve is a definition, the paths that change a rule's state or
scope need no bookkeeping. They are still the cases the slice's tests walk,
each followed by "the reserve read equals the definition": a curator archive
for budget, a curator restore, a merge as duplicate, an archive for another
reason, the operator's delete and return in the rules window, an agent
rewrite, the emergency eviction of `roleConsolidate.ts:69-92`, an install
transfer, a scope joined after its project key moved, and the history move
of #3841.

If the rule rows grow until the range query matters, a declared index on
scope, state and reason is the next step. It is not needed at today's size.

### 3.3 A graph, or the decided layer with a parent link

| Option | Shape | For | Against |
| --- | --- | --- | --- |
| G0. Flat with a reserve | §3.2 alone | Nothing more to build | The front of a full scope is whatever the curator ranked highest. A whole class of detail can sit in the reserve with nothing in the front that names it |
| G1. Layer and one parent (decision 5 of 2026-10-22) | Each rule is a principle, a practice or a specific, and may name the one more general rule it serves | The curator sees a class with its instances. A class stays represented in the front while its details wait in the reserve. Rendering and expansion follow one link. Lineage links (merged, moved, split, versions) already record where a rule came from | One field and one link to keep right on merge and split |
| G2. A general graph | Typed links, many to many (serves, refines, contradicts, same class), selection by walking from the best matches | Could reach a relevant rule that shares no word with the brief | No measurement supports it. A reader's pool is a few hundred rules and is scored whole in milliseconds (§2.2), so a walk finds nothing a scan misses. The 2026-10-02 study used a graph as a gate and it removed the one useful offer. Every link type is another thing the curator must repair on each merge, split and move, where five lineage fields are already maintained |

**Recommendation: G1, the decision as recorded, with three uses of the
link.** It is a graph with the two kinds of edge that pay: "serves" (parent)
and "came from" (the existing lineage). G2 is deferred with the measurement
that would reopen it (§8).

The data model, all additions optional so existing rows decode unchanged:

```ts
interface RoleMemoryRule {
  // ...existing fields
  layer?: "principle" | "practice" | "specific"; // absent reads as practice
  parent?: string;    // id of one rule in a layer above
  proposal?: string;  // T2: the approved proposal this company rule came from
}
// every RuleSource variant
memberId?: string;    // T1c: the person the writing launch worked for
```

Layer definitions are those of `role-memory-layers.md` §3.2: a principle
names no tool, file or project and fits 200 code points; a practice is a
trigger and a check; a specific is a fact a practice needs in one project or
tool. One change: a specific's parent may be a practice, because that is
what a specific serves. The parent's layer always stands above its child's,
so a chain has at most three rules and cannot loop.

Server checks in `apply` (beside `curation/apply.ts:82-85`): the parent
exists and is in the front; its layer stands above the child's in the order
principle, practice, specific; every reader of the child's scope reads the
parent's scope (the existing `reaches` test); a principle fits 200 code
points. A parent that later leaves the front leaves its children's links in
place: they render alone until the curator relinks them. No change cascades.

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

One pipeline. Word matching is the path every start can take; the model
step is optional and its future is Q2.

1. **Always-on** (unchanged): rules the operator kept, then principles of
   the role's every-project scope and the machine once layers exist, within
   3 000 code points (`roleSelect.ts:22-30`). A person's always-on share
   (§4.2, up to 2 000) follows.
2. **Score.** Front and reserve rules of the reader's scopes are scored
   against the brief with the shipped BM25, each tier ranked on its own, in
   one piece (slice M0).
3. **The reserve share is set aside first.** The best-scoring reserve rules
   that share at least one term with the brief are taken up to 3 000 code
   points, about eleven rules at today's mean line of 267. Their bytes are
   counted before the front is packed.
4. **The front fills what remains.** Front rules are packed by score up to
   the front budget of Q1, or up to what is left under 24 000 bytes when
   that is less.
5. **Expansion** (§3.3) for packed children, once layers exist.
6. **The byte test** at 24 000 bytes after every addition, as today
   (`roleSelect.ts:77-78`), from a running byte count.
7. **The model step, if Q2 keeps it.** It receives a short list (the best
   candidates of each tier by word match) and its scores replace the word
   scores for those rules; steps 3 to 6 then run on its scores. When it does
   not answer in time, the word-match result of steps 3 to 6 stands.
8. **If scoring itself fails**, whole delivery of the front, cut at the
   ceiling, as today.

With briefs of thousands of characters nearly every rule shares some word
with the brief, so in practice step 3 fills its share on most starts with
the eleven best-matching reserve rules. That is the intent: each start
spends a fixed, small part of its block on rules that would otherwise never
be read, and the applied marks they earn are what lets the curator bring the
useful ones back (§3.5).

Where each number stands:

| Number | Value | Source |
| --- | --- | --- |
| Hard maximum per start | 24 000 bytes | Decision 3 of 2026-10-22. Unchanged |
| Always-on | 3 000 code points | Decision 5. Unchanged |
| Reserve share | 3 000 code points, set aside before the front | New. A design value with no measurement behind it (§2.3 says why none exists yet); one eighth of the block |
| Front, word-match path | Q1: 16 000 recommended | §2.3, first row: 9 000 keeps 66.8 % of applied rules, 12 000 keeps 75.0 %, 16 000 keeps 82.7 %, 18 000 keeps 86.2 % |
| Selected, model path | 9 000 code points | `role-memory-layers.md` §4.3. Unchanged, if Q2 keeps the model |

How the pieces fit under the ceiling. In one-byte text with no always-on
rules, 3 000 + 16 000 code points of rule lines and about 1.5 KB of headings
and notices come to about 20.5 KB. With both always-on sets full (5 000) the
front's turn ends near 14 500. In two-byte text with both always-on sets
full, the always-on rules take 10 000 bytes and the reserve share 6 000, and
the front gets the roughly 6 500 bytes that remain. The reserve share holds
in every case, because it is counted first.

Cost, from the table of `role-memory-layers.md` §4.4 (API-equivalent, per
stage): a block at the hard maximum is about 0.113 to 0.131 USD on Claude
Opus and 0.064 USD on Codex standard; a block of about 12.7 KB is 0.060 to
0.070 and 0.034. Q1 is that difference against the recall of §2.3. No claim
is made about latency or cache effects beyond those figures.

### 3.5 The curator

The pass and its checklist stay (`curation/brief.ts:8-14`). It already reads
every budget archive of its scopes on every pass (`curation/read.ts:65`),
which is the hygiene the reserve needs: a reserve rule that is stale, in
code, duplicated or contradicted is archived under that reason and leaves
the reserve. Three additions.

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

The largest reserve today is 114 589 code points, about five of the
curator's 24 KB pages on every pass (`curation/read.ts:18`). If passes grow
too long, reading the reserve in rotation is the next step; no pass length
was measured here, so nothing is changed.

Curator-only widening to role-on-every-project (decision 1 of 2026-10-22)
stays as it is.

### 3.6 The bound

Both the decision of 2026-10-22 and the request of 2026-11-03 raise the
scope bounds, so they are raised: 20 000 code points for a role in one
project, 30 000 for a role on every project, 15 000 for a project and for
the machine (slice M4). In the largest scope about twenty reserve rules
return to the front on the next passes, through the curator's existing
restore step.

M4 follows M0 for one reason. While half the starts fall back to whole
delivery, a larger scope only means more of it is cut at the ceiling from
the tail of the largest scope. Once the selector finishes, a larger front is
simply more candidates ranked on equal terms.

The brief's aim of 16 000 bytes across a reader's four scopes
(`curation/brief.ts:14`, `:22-24`) was written when a start received whole
scopes. With selected delivery the start is capped by the 24 000-byte
maximum whatever the scopes hold, so M4 removes that aim from the brief.

The operator's 2026-10-21 request that some maximum remain is met twice: the
front bound per scope and the 24 000-byte maximum per start. The reserve has
no bound.

## 4. Team memory: a person's rules, and company rules from them

### 4.1 The model in one paragraph

A person gets one scope, `member:<member id>`. The agents that person starts
read it, in any project and any role. Company rules are the scopes that
already reach everyone on the installation: a role on every project
(`role:*:<role>`) and the machine scope. A curator pass of its own kind,
which only the owner can read, finds classes that several people's rules
share and proposes a company rule for each, written anew. A person approves
a proposal before it is delivered to anyone. Approval adds a rule and
changes no one's personal rule.

Personal scopes exist only where sign-in is on and the installation has an
owner. A solo installation is unchanged.

### 4.2 A person's scope

| Aspect | Design |
| --- | --- |
| Key | `member:<member id>`, a fifth scope kind beside role, project, machine and swarm (`roleScopes.ts:13-15`) |
| What belongs there | How this person wants work done: language and form of reports, when to ask and when to proceed, review habits, taste. Never a fact about a project |
| Bound | 4 000 code points of front, the swarm's per-role size. The reserve applies as for any scope |
| The person of a launch | One stamp on the launch profile, set once at admission beside the member principal (`contracts.ts:60`, `spawnCommand.ts:707-711`): the signed-in person who made the request, the owner included; otherwise the stamp of the agent conversation that made the call, so a spawned agent and the stages of a pipeline inherit their creator's (`engine.ts:15651-15657`). It is never taken from a seat's stored principal, from the latest message author or from further up the parent chain |
| Launches with no person | A designated seat and everything it launches; scheduled passes; the curator; maintenance. **Seats work without personal rules**, whoever designated them and whoever is writing to them |
| Delivery, all three conditions | (1) The start's own stamp names the person. (2) The engine's own memory is off at this start (`source.ts:81-85`); otherwise the engine could save a delivered personal rule into its per-project memory, which colleagues' agents load. (3) Every recorded message author of the conversation is that person (`src/lib/team/store.ts:818-823` holds the authors). Condition 3 is checked at each start; once another person has written, the scope is withheld from that start on and withdrawn from the attempt's frozen block through the existing withdrawal path (`roleSelection.ts:90-112`) |
| Where in the block | First, under its own heading. Its first 2 000 code points are always-on in the scope's order, because a preference such as a report language shares no word with a task brief and word matching would never select it. The rest are candidates like any rule |
| Search and open | `search_memory` and open-by-id return a member-scope rule only to a caller whose stamp is that person, and to the rules window as Q4 decides. Every other caller is refused it: a colleague's fenced agent, a seat, an agent with installation reach, the owner's own agent |
| Writers | (1) An agent whose launch carries a stamp: `leave_lesson` with scope `member` writes to that person's scope, and it may rewrite a rule of that scope it received. The fence keeps refusing machine lessons and every other rewrite for member-bound callers (`workspaceFence.ts:73`). (2) The person, in a "My rules" view: add, edit, delete, keep. No curator pass edits a personal scope |
| Over the bound | No curator runs inside a personal scope, so the existing emergency rule applies: past 125 % of the bound the rules with the least evidence move to the reserve (`roleConsolidate.ts:69-92`), where they stay scored and searchable. The person tidies their own list |
| Provenance | Every new lesson, in any scope, records the person its launch worked for (`memberId` on the source). The curator's read gains "backed by N people" beside today's count of tasks |

**What this means on the measured installation.** Its memory source is
Delegatus with the import still running, so the engines' memory is still on
(§2.5) and condition 2 would deliver no personal rule there today. Personal
rules start reaching agents when that import completes.

**What a person should expect.** Someone who works mostly through a
project's shared seat will see their rules applied only in the
conversations and pipelines they start themselves. The seat's answers stay
without them. A per-message note for seats is deferred (§8).

**Old releases.** `scopeKind` reads an unknown prefix as a project
(`roleScopes.ts:13-15`). After a rollback a `member:` scope is listed by no
start (`roleStore.ts:156-158`), so it is never delivered and nothing is
lost. One exposure exists and is stated here: an older release's unscoped
rule search reads every scope key (`roleViewSource.ts:772`), so an agent
with installation reach could find a personal rule by search until the
release is rolled forward again.

### 4.3 From personal rules to company rules

**A team pass, apart from every project pass.** It runs only when the
installation has more than one active member.

| | Project pass (today) | Team pass (new) |
| --- | --- | --- |
| Where its conversation lives | The pass's project (`curation/run.ts:77`), so that project's workspace can read its transcript | A reserved installation project that only the owner reaches: it is in no workspace, cannot be placed in one, and is absent from the projects a manager sees as Unassigned (`workspaceAccess.ts:21`, `src/lib/team/workspaces.ts:335-341`). Its working directory is an empty private folder with no repository |
| What it reads | Its project's role scopes, role-on-every-project, project, machine | Every personal scope's front, and the role-on-every-project and machine scopes read-only, so it does not propose what already exists |
| What it may write | Any scope of the pass (`curation/apply.ts:117`, `:147`) | **Nothing in the rule store.** Its pass names no scope, so `apply` refuses every rewrite, move, split, merge, archive, restore and import. Its one write is `propose` |
| Personal scopes | Never named: scopes are found by the prefixes `project:`, `machine` and `role:` (`curation/store.ts:240-257`). T1a adds an explicit refusal for a `member:` scope in a project pass's read and apply | Read only |

Why a pass of its own. A project pass can author new text in
role-on-every-project and machine through rewrite, merge, split and import
(`curation/apply.ts:175-226`), and its transcript is readable by the
project's workspace. If it could read a personal rule, that rule's content
could reach every builder as a rewritten shared rule with no approval, and
the workspace would read it in the transcript. So no pass that can write a
shared scope ever reads a personal one, and the one pass that reads them can
write only proposals.

The steps:

1. **Classes across people.** The pass reads all personal fronts (small by
   their bound) and groups rules that state one class, as check 5 already
   does for rules from different tasks.
2. **A class qualifies** when all of these hold:
   - at least two people hold a rule of the class, or one person asked for
     it with "Suggest for the team" on their own rule;
   - no person holds a rule that contradicts it. A contradiction means the
     class is a preference, and it stays personal;
   - it can be written so that every reader of the target scope acts on it
     (the existing level check 4), with no person, account or project named;
   - the text raises no privacy hint (`roleTypes.ts:3`,
     `curation/apply.ts:80`).
3. **The pass writes a proposal** through the new `propose` action. A
   proposal is a row in a collection of its own, so the `role_memory`
   collection keeps its three row kinds:

   ```ts
   interface CompanyRuleProposal {
     id: string;
     state: "open" | "approved" | "declined";
     target: string;        // role:*:<role> or machine
     layer: "principle" | "practice" | "specific";
     rule: string; why: string; textHash: string;
     sources: { id: string; versionHash: string }[]; // personal rules read
     people: number;        // distinct persons behind the sources
     pass: string; createdAt: string;
     decidedBy?: string; decidedAt?: string; reason?: string;
     ruleId?: string;       // the company rule an approval created
   }
   ```

   **Nothing is delivered from a proposal.**
4. **A person decides** (Q3: the owner). The rules window lists proposals
   with the text, who will read it in plain words ("every builder, in every
   project"), and how many people's rules stand behind it. The approver may
   edit the text. Declining keeps a reason, and the pass does not propose
   the same sources again.
5. **Approval is one insert.** In one transaction the server checks the
   proposal is open, checks that the text hash is the one shown, and adds
   one active rule to the target scope with `proposal` set. The rule arrives
   as a lesson no curator has seen, so the next project pass integrates it
   with that scope's existing rules. Approving the same proposal twice
   answers with the same rule. **No source rule is moved, rewritten or
   archived by an approval.**
6. **Afterwards**, the "My rules" view marks a personal rule that a company
   rule now covers, and its owner may delete it. Nothing removes it for
   them.

**Why approval cannot act on a stale text.** The earlier attempt completed a
move at approval time, so approving an old proposal could archive a rule its
owner had since corrected. Here approval never touches a source. The
proposal still pins each source's version: when a source changed or left
after the proposal was written, the window says so and shows the current
sources, and the server refuses the approval until the approver has seen
that state. The text that becomes active is always the text the approver
read.

**Every path into a company scope, and what the member scope does to it.**
The refusals ship in the same slice as the scope (T1a), before any pass can
read a personal rule.

| Path into `role:*` or `machine` | Today | With personal scopes |
| --- | --- | --- |
| Project pass: rewrite, merge text, split parts, move, restore, import parts (`curation/apply.ts:175-226`) | Allowed within the reach test | Unchanged for shared scopes. The pass cannot read or name a personal scope, so it has no personal text to carry |
| Team pass: any of the above | None | Refused: the pass names no scope |
| Agent `leave_lesson` to machine | Refused for member-bound callers (`workspaceFence.ts:73`) | Unchanged |
| Agent lesson to `role` or `project` | Allowed | Unchanged. This is project knowledge and reaches the workspace that holds the project |
| The operator's own edits in the rules window | Owner-only | Unchanged for shared scopes. A person edits only their own scope |
| Engine memory import (`src/lib/memory/curation/importApply.ts`) | A project pass adopts into shared scopes | Unchanged. Imported text is the installation's and has no person |
| Install transfer | Carries rule rows | Carries personal scopes as they are, keyed by member id. A target without that member keeps them undelivered |
| Promotion into shipped prompts (#3790) | From shared scopes | Unchanged. A personal rule is never a candidate |
| Swarm contribution | From role-on-every-project rules, with the owner's approval | Unchanged. A personal rule is never a candidate |
| Approved proposal | None | The only path from a personal rule to a company rule |

### 4.4 Privacy between people: what is kept and what is not

| | |
| --- | --- |
| Kept | A person's rules are delivered only to starts that person made (§4.2), and found by search only from those. Seats receive none. The "My rules" view shows a person their own scope (Q4). A company rule is new text that names no person, and the count of people behind a proposal is shown to its approver alone. A personal rule never enters a prompt promotion or the swarm |
| The curator | Only the team pass reads personal scopes. It is an agent on the installation's own account, it can write nothing but proposals, and its transcript sits in a project only the owner reaches |
| Not kept | Secrecy. All rules are rows of one store that every agent's shell can read, because all agents run as one OS user; the team pass's transcript is a file under the same user. An agent working for one person can also repeat a personal rule in a message to a shared seat. The block's notice asks agents to keep rule text out of commits, pull requests, issues, tasks and reports (`roleRender.ts:13`), the seat's and the root conversation's notices add messages (`:14`, `:20`), and nothing enforces any of it. Selection sends rule text to the selection provider when the model step is on, as it does for every rule today (`docs/design/role-memory-selector-observations.md`) |
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
| Agent tools | A member-bound agent has a closed tool list and every identity it names must resolve inside its workspace (`workspaceFence.ts`) | A launch with no member principal has installation reach (`:70`): the owner's own launches, a seat the owner designated while the owner is the last person to have written to it, and scheduled work that no member started |
| Accounts | A workspace's pool bounds automatic choice and refuses a member-bound launch outside it (`projectBindings.ts:430-453`) | Every account's login file sits under the same OS user |
| Memory | Scopes decide what a start receives (§4.4) | One store; `global` engine memory is returned under any project filter (`index.ts:282`) until W2 |
| Telegram | A report chat and directive chats per workspace (`workspaceDefaults.ts:36-56`) | One bot token for the installation |
| Resources | A memory ceiling per agent and one budget for all (`agentMemory.ts:84-87`, `:163-165`); CPU weights for operator and work hosts (`cpuPlacement.ts:24-25`) | A ceiling per workspace (§5.4) |
| Operating system | Nothing: one user, one home, one set of sockets | Everything above is a rule the Delegatus server applies to its own surfaces |

**The statement for the product.** A workspace inside one installation is a
boundary for a trusted team: each person sees their own boards, starts work
only in their workspace's folders, uses their workspace's accounts and
chats, and cannot act on a colleague's work by mistake. It keeps no
information from a person whose agents have a shell. Separation that holds
against a shell is one installation under one OS user per person or per
team (`docs/design/workspaces.md` §6, level 4). Slices W1 to W4 finish the
separation that exists today, which is what the request sets as the floor.
Anything stronger is that deployment, and nothing here blocks it.

### 5.2 A member's working day: accounts and the owner-only routes

**W1. Choosing a Claude or Codex subscription.** Per-workspace bindings
exist and are enforced. What is missing is the member's view of them.

- A read for any member: for a project they may act on, the accounts of its
  pool per engine, each with its label, whether it is signed in, and its
  remaining limit windows. No login action, no credential path, no account
  outside the pool. It is a `team` route that checks membership itself, as
  the workspace routes do (`workspaceRoutes.ts:224-227`).
- **When no pool is set.** A project with no binding and a workspace with no
  allow-list means every account today (`projectBindings.ts:430-453`). For a
  member that would list every account on the installation. Recommended:
  the member's read then answers with the engines that have a signed-in
  account and no account rows, the chip offers the engine with automatic
  account choice, and a member-bound launch that names an account for a
  project with no pool is refused. The workspace page tells the owner and
  the manager that members cannot pick until a list is set. So a member
  sees exactly what the server will accept, in both directions.
- The composer's engine and account chip reads the member's route for a
  member and keeps reading the full account list for the owner.
- The server-side check for a set pool does not move: `spawnCommand.ts:608-612`
  and `workspaceFence.ts:151-155` already refuse an account outside it.
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
| Transcript and memory search in the browser | Open with the project filter forced to the member's projects, as the agent fence forces it (`workspaceFence.ts:87`, with the result check for transcript search at `:183-188`). **Entries indexed as `global` are left out of a member's results**, in the browser and for a member-bound agent alike: they are the owner's global instructions and preference sections (`parsers.ts:119-127`), and today they pass any filter (`index.ts:282`, `:313`, `:322`). Machine and role-on-every-project rules stay in: every agent receives them anyway | |
| Rules window | A member's own scope only (T1b) | |
| Attention and inbox | Open, filtered by project | The "needs you" list already is (`workspaceRoutes.ts:41`) |
| Flows | Keep closed until asked for | No request names them |
| Accounts, keys, updates, deploys, relay, Telegram bot, settings | Stay owner-only | Installation administration |

### 5.3 Revocation reaches running work (W3)

Revoking a person ends their sessions and sign-in codes in one transaction
(`members.ts:544-557`). Two things survive it:

- **Their agents.** Tool calls are refused from that moment, because
  authority is read live (`workspacePrincipal.ts:75-80`), and the processes
  keep running with a shell. Revocation should also interrupt every host
  whose launch principal is the revoked member and hold their queued
  launches, through the existing interrupt path, and record how many it
  stopped on the same team event.
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
sits under one slice. Q5 asks, because (a) alone narrows what was approved
on 2026-10-20.

### 5.5 Smaller items

- **Issue #3818** (a seat's form tools refused after a refused read) is an
  open defect of the shipped fence and gets its own repair lane.
- **Per-person interface language and time zone** stay deferred
  (`sign-in-and-team.md` §14).

## 6. Build plan

Each slice ships alone. A slice that changes a start's block carries its
before and after from the ledger.

| Slice | Content | Depends on | Acceptance, on isolated state unless it says ledger |
| --- | --- | --- | --- |
| **M0** Selector finishes | (1) A profile first: what holds the serving loop while selections run, on isolated state with a store of the measured shape (178 scope rows holding about 250 MB of history), reported under the `memory.select` label. A blocker outside the selector gets its own task. (2) The start reads its own scope rows and their active rules by key and copies no other row (`roleStore.ts:250`). (3) Scoring and the pack run in one piece and give up the loop by elapsed time, the 32 ms budget `cooperative.ts:15-33` already has. (4) The pack keeps a running byte count in place of a render per added rule (`roleSelect.ts:77`) | #3834 and #3841 merged | With the turn function injected, a word-match selection over pools of 100, 250 and 650 rules takes no loop turn between entry and its packed result, and one per 32 ms of work beyond that. A start's read touches the same number of rows whether the collection holds a thousand foreign rows or a hundred thousand. Ledger, one week after deploy: `selector-timeout` under 1 % of first selections (49 % before); local scoring and packing together under 50 ms at p90 (2 116 ms and 420 ms before); no new loop-gap report under `memory.select` |
| **M1** Word-match budget and the model step's setting | Q1's budget on the word-match path. Q2 (a): a third saved choice for the `rules` feature that selects word matching alone (`policy.ts:37` admits two providers today). Q2 (b): the short list of §3.4 step 7 | M0, Q1, Q2 | Every row of the reason table gives one output; no block over 24 000 bytes in one- to four-byte text; with word matching chosen no provider is called and no allowance is reserved; with the short list a start never sends the model more than the list, in requests of at most 32, and a request that times out is charged as today |
| **M2** Reserve in use | §3.2 and §3.4 steps 2 to 4: the reserve read by its definition, the share set aside before the front, search, the rules window group, the ledger mark | M1 | A store written before the upgrade, with budget archives and no other preparation, shows them as reserve after it. A budget archive is scored, packed within the share, found by search and opened; a rule archived for another reason is none of these. In two-byte text with both always-on sets full, a start whose brief matches reserve rules still delivers them within the share, under 24 000 bytes. After each writer listed in §3.2 the reserve read equals the definition. Whole fallback holds front rules only. Frozen blocks resume byte for byte |
| **M3** Layers and parents | §3.3 and §3.5: fields, server checks, curator checks, rendering, expansion, reserve pointer | M2 | The server refuses a parent outside the reader's scopes, a parent whose layer does not stand above the child's, and a principle over 200 code points; a child renders under its parent and alone without it; expansion adds a parent and removes nothing; the replay of §2.3 is repeated with links to measure expansion |
| **M4** Recorded bounds | Decision 4 of 2026-10-22: 20 000, 30 000, 15 000, 15 000, read from one table by scope kind. The four-scope aim leaves the brief (§3.6) | M0 | A pass cannot leave a front over its kind's bound; a role scope restores budget archives up to 20 000 on its next pass; ledger: no rise in `selector-timeout` after the bounds change |
| **T1a** Personal scope, with every guard | §4.2 and the refusals of §4.3: the scope kind, the person stamp, the three delivery conditions, `leave_lesson` scope `member`, the search and open rule, the refusal of a `member:` scope in a project pass | M2; #3731, #3795 and #3710 merged | With a canary rule in person A's scope: it reaches A's own conversation, an agent that conversation spawns and a stage of a pipeline A created. It reaches none of: person B's conversation; a seat A designated, answering B or running a scheduled pass; a pipeline that seat created; A's conversation after B wrote to it, on a new start and on a resumed frozen block; any start with the engine's memory on. Search and open-by-id succeed from A's launch and fail from B's fenced launch, from a seat and from the owner's own agent. A project pass that names the scope in a read or an apply is refused. Each reader of rule rows that takes no scope list (search, the rules window's project view, other-project evidence, the weekly report, prompt promotion, swarm evidence, install transfer, the known-values refresh) is tried with the canary and either leaves it out or answers the owner alone. The owner's launches carry the owner's stamp. A rollback fixture leaves the scope undelivered |
| **T1b** "My rules" | The view of §4.2 for a member's own scope: read, add, edit, delete, keep, "Suggest for the team" | T1a, Q4 | A member reads and edits only their own scope and is refused every other. Rendered through the kanban board driver and the phone driver in en and uk, light and dark, with real rules in every field |
| **T1c** Who is behind a lesson | `memberId` on every source variant; "backed by N people" in the curator's read | T1a | A lesson from a stamped launch records the person in every scope kind; a lesson from a seat records none; older rows decode unchanged |
| **T2** Team pass, proposals and approval | §4.3: the reserved installation project, the pass kind with no scope, `propose`, the proposal collection, the window, approve and decline | T1a, T1c, Q3 | With a canary in A's scope, after a team pass: no shared-scope rule carries it without an approval; every rewrite, move, split, merge, archive, restore and import from the team pass is refused; no member and no manager of any workspace can list, open, search or place the pass's project or read its conversation through the log route, `conversation_messages` or `search_transcripts`. Nothing is delivered from an open proposal; approval adds exactly the shown text; a second approval answers the same rule; an approval after a source was rewritten, deleted or moved is refused until re-read and changes no source; a declined class is not proposed again |
| **W1** Member's accounts | §5.2 | Nothing | A member sees exactly the pool of a project they may act on, with limits and no login action; with no pool set they see engines and no accounts, and a launch naming an account is refused; a member of another workspace is refused; the chip offers both engines when the pool holds both. Rendered through the conversation-window driver and the phone driver in en and uk, light and dark |
| **W2** Owner-only routes | §5.2, one row at a time | #3731, #3795 and #3710 merged, for the search row | For each opened route: a member succeeds inside their workspace and is refused outside it, by id, by path and by a moved project. A member's memory search, in the browser and through a member-bound agent, returns no `global` entry of the engines' memory |
| **W3** Revocation | §5.3 | Nothing | After revocation no host of that person is running, queued launches are held, a frame capability minted before it is refused |
| **W4** Usage and worker share | §5.4 (a); (b) only if chosen | Q5; #2926 merged | Activity groups by workspace and sums match the ungrouped view; a workspace at its share queues its next worker while another workspace still starts one |

Order: M0 first, because every other memory slice changes what the selector
is handed, and M4 right after it. W1 to W3 are independent of memory and can
run beside it. T1a follows M2 because both rewrite how a start's scopes are
read.

Slices that touch how hosts are launched (W3's interrupt, W4 (b)) follow the
runtime-host rules of this repository.

## 7. Questions for the operator

**Q1. When word matching picks an agent's rules, how much of the 24 000
bytes may it fill?**
What changes: how many matching rules an agent starts with. Word matching
decides half of the starts today and would decide nearly all of them once
the selector stops timing out.
Example: a builder stage whose pool holds about 190 rules gets about 33 of
them today, in a block of about 10 KB. In the replay over starts where every
rule could be marked, a set of that size holds 66.8 % of the rules agents
later reported applying. At 16 000 code points the stage gets about 60 rules
and the set holds 82.7 %. The block grows to about 18 KB, and to about 20 KB
once the reserve share is added: roughly 0.04 to 0.06 USD more per Claude
Opus stage and 0.02 to 0.03 USD per Codex stage at API-equivalent prices.
- (a) Up to 16 000 code points. **Recommended.**
- (b) Up to 12 000, which holds 75.0 %.
- (c) Keep 9 000.

**Q2. Should a paid model keep choosing rules, after a week in which it
decided 3 % of starts?**
What changes: whether each agent start waits for a model's answer, and
whether the monthly 5 USD is spent.
Example: in six days 314 starts asked the model and 35 got a usable answer.
The starts that asked waited a median 1.5 seconds and up to the full three.
98 % of the money went to requests that timed out or came back malformed,
and the month's 5 USD was gone on the fourth day. Nothing measured so far
shows the model choosing better than word matching.
- (a) Word matching chooses, and the model step is switched off until a
  comparison on recorded starts shows it choosing better by ten points at
  the same size, which is the bar recorded on 2026-10-22. **Recommended**:
  starts stop waiting and nothing is spent each month. The comparison runs
  offline once: at the request ceiling of §2.2, about 0.02 USD per recorded
  start, a few hundred starts cost a few dollars.
- (b) Keep the model and send it a short list of the best word matches, so
  that its requests answer in time. Each start then waits about two seconds
  for it, and at today's volume of about 180 first selections a day the
  spend is roughly 11 to 16 USD a month.
- (c) Leave it as it is: the model decides a few percent of starts in the
  first days of each month.

**Q3. Who approves a company rule made from people's personal rules?**
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

**Q4. Who can open a person's own rules?**
What changes: whether colleagues can read how you told your agents to work.
Example: a person's rule says to always ask before sending anything to a
client.
- (a) That person and the owner. **Recommended.** It is a view, and it gives
  no secrecy from someone whose agents have a shell (§4.4).
- (b) Everyone in the same workspace, so good rules can be copied by hand.

**Q5. Does a workspace need a hard resource ceiling inside one
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
  that neither word matching nor parent expansion reaches.
- **A short list for the model step**, unless Q2 (b).
- **An embedding selector.** No local embedding model runs here
  (`role-memory-layers.md`, deferred list).
- **Bounds above the recorded targets.** The reserve keeps what does not fit
  in use, so nothing measured asks for more.
- **Reading the reserve in rotation** during curator passes, until a pass
  length shows the need (§3.5).
- **A declared index for the reserve read**, until the rule rows outgrow the
  range query (§3.2).
- **A curator inside personal scopes.** The person keeps their own list; the
  team pass only reads.
- **A per-message note that gives a shared seat the rules of whoever is
  writing to it.** It would put one person's rules into a transcript the
  next person's turn reads.
- **Per-person secrecy inside one installation**: audiences on
  conversations, origin tracking after project moves, a backfill of who may
  read old records. Every automatic flow across such a boundary in the
  earlier attempt became a finding (§9), and one OS user cannot enforce it.
- **A workspace level of rules**, unless Q3 (b). Project and role-here
  scopes already stay inside the workspace that holds the project, and no
  observed rule holds for all projects of one workspace only.
- **A company pack between installations**, loaded read-only like the swarm
  scope, for a company that runs one installation per person.
- **A kernel slice per workspace**, unless Q5 (b).
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

## 9. The earlier attempt's critique, premise by premise

The third critique of the 2026-11-03 attempt left six P1 findings and one
P2. Each names a premise that was wrong. Each was observed again on
`ec82e477f`.

| Premise the earlier design relied on | Observed on main | In this design |
| --- | --- | --- |
| Checking what an agent reads keeps a private text from a wider audience | Still false. A member-bound agent may send a message, create and update tasks (`workspaceFence.ts:28-35`), and text is forwarded as written | No private audience exists inside an installation. A personal scope decides delivery and promises no secrecy (§4.4) |
| The server's own checks govern all memory a start loads | Still false. The engines load their own per-project memory unless the source is Delegatus with its import finished (`source.ts:81-85`, `cli.ts:472-473`, `:550`), and rules are delivered while the source is unchosen too (`settings.ts:45-47`). On the measured installation half the Claude starts loaded it | Personal rules are delivered only to a start whose engine memory is off (§4.2), tested in T1a |
| The owner's messages carry no member author, so old owner records can be recognised by that | Still false. Authorship is recorded for every signed-in member, the owner included (`authorship.ts:42-50`), and the workspace principal is absent for the owner (`workspacePrincipal.ts:38`) | Nothing is relabelled or backfilled. The person stamp is written for the owner on purpose (§4.2) |
| A record's original workspace is enough to decide who may read it after projects move | Not applicable. Placement moves all of a project's history at once (`src/lib/team/workspaces.ts:246-268`) and access follows the current placement (`workspaceAccess.ts:43-48`) | No origin is recorded. A personal scope is keyed by the person and does not move with a project |
| Slices can ship in an order where team text is readable before the approval gate exists | A project pass authors text in shared scopes through rewrite, merge, split, move, restore and import in one call (`curation/apply.ts:175-226`), and its transcript is readable by its project's workspace (`curation/run.ts:77`) | No pass that can write a shared scope reads a personal one, and that refusal ships with the scope (T1a). The team pass of T2 reads them and can write only proposals. At every intermediate state a personal rule has no route into a shared scope (§4.3) |
| Placing hosts by pipeline or flow membership covers a workspace's load | Still false. Any other host is an operator host (`cpuPlacement.ts:68-70`), which is every ordinary member conversation | No per-workspace ceiling is claimed. Q5 asks the operator whether to narrow the approved promise; option (b) places by the project's workspace for every host kind (§5.4) |
| A delayed approval can complete a move decided earlier | Today's curation is safe because it is synchronous under scope revisions (`curation/apply.ts:147`), which cannot be held across a wait | Approval inserts one new rule with the exact text shown and never changes a source. Stale sources block approval until re-read; a repeated approval answers the same rule (§4.3) |

## 10. Validation against the requirement

| The request, as restated at the top | Where answered |
| --- | --- |
| Find the earlier work | §1, §1.2 |
| The limits go up | §3.6 and M4 apply the recorded targets; the reserve has no limit (§3.2); Q1 for what a start receives |
| Nothing is dropped | Already true for text (§2.1); §3.2 keeps what leaves the front in use |
| What is kept stays usable | §3.1 defines it as four testable properties; §3.4 fills the block; M0 comes first because half the starts get no selection today (§2.2) |
| Related rules come together; weigh a graph | §3.3 weighs a graph against the decided layer and parent link and keeps the decision with three uses of the link; §3.5 gives the curator's steps |
| Each person has rules of their own | §4.2 |
| The curator derives company rules from them | §4.3, with criteria, provenance and approval; §4.5 for the swarm |
| One installation serves a company, with separation no weaker than today's | §5.1 states what today's separation holds per layer and what anything stronger takes; W1 to W4 finish it |
| A sign-in per person; each person sees only their workspaces | Shipped (#3255); §2.6 |
| Each person works only in their folders and does their own actions | Shipped for launches and tools (§2.6); W2 opens the everyday routes still refused; W3 for revocation |
| A person picks a Claude or Codex subscription | W1 |
| Accounts are bound per workspace | Shipped (#3415); W1 shows them to the member |

## 11. What could not be confirmed, and where I looked

- **What holds the serving loop.** The phase timings come from the ledger
  and the arithmetic and the whole-collection copy were timed on scratch
  copies; the serving process was not profiled. M0 starts with that profile.
- **What M0 gains in production.** The by-key read was timed only through
  SQLite on a scratch copy: 0.24 seconds for the largest reader today,
  nearly all of it parsing scope rows of 11 to 53 MB that #3841 shrinks. The
  slice claims its gain from the ledger after deploy, and nothing before.
- **What a signed-in member sees in the composer.** No browser was driven in
  this stage. The claim that a member has no account list rests on the route
  table (`workspaceRoutes.ts:7-26`), the gate (`gate.ts:199-202`) and the
  hook that treats a refusal as a failed read (`useEngineAccounts.ts:784-785`).
  W1 starts by rendering it.
- **Whether the model selects better than word matching.** 35 model-decided
  starts and an in-sample evaluation of 24 cases cannot say. Q2 (a) names
  the comparison that would.
- **What the reserve share is worth.** No reserve rule has been delivered,
  so none has a mark (§2.3). The 3 000 is a design value.
- **How much parent expansion adds.** No rule has a layer or a parent yet.
- **The replay's labels.** Self-reported and sparse. The figures the design
  uses come from starts before 2026-11-04, when every pool rule was
  delivered.
- **Team behaviour on a real team.** The measured installation has one
  person. Every team figure in §4 is a design value with no data behind it:
  the 4 000 bound, the 2 000 always-on share, "two people".
- **The key of the reserved installation project** and how a conversation
  with no repository is listed for the owner. T2 settles both against the
  catalog code; its acceptance states what must hold.
- **Provider terms** for several people using one subscription login.
- **A systemd slice per workspace** was not probed; §5.4 (b) describes it
  from the placement code.
- **Issue #3818** was read. No reproduction was attempted.

## 12. How this revision answers its critique

One critique of the first revision returned two P1, four P2 and six P3
findings. Each claim it made about the code was opened again before the
text changed.

| Finding | Resolved by |
| --- | --- |
| P1. Personal text could reach shared scopes and other workspaces through a curator pass | No pass that can write a shared scope reads a personal one; a team pass of its own kind reads them, names no scope, and writes only proposals, in a project only the owner reaches (§4.3). Curation inside personal scopes is cut (§4.2, §8). Canary acceptance in T1a and T2 |
| P1. The recommendation on scope bounds rested on a row that could not show harm | The row and its consequence are gone, and §2.3 states the label bias, shown by a selected-starts row of its own. The bounds question is withdrawn: §1.1 and §3.6 say that both the 2026-10-22 decision and the 2026-11-03 request raise them, and M4 applies the recorded targets |
| P2. A seat bound to a person would carry that person's rules to colleagues | The person is a stamp on the launch itself, never read from a seat or from message authors; seats and what they launch have none; a conversation another person wrote to stops receiving the scope (§4.2). T1a tests each case |
| P2. `search_memory` would hand personal rules to other people's agents | Search and open return a member-scope rule only to its person's own stamped launch (§4.2), with the four refused callers in T1a. The rollback exposure is stated |
| P2. The reserve list contradicted "no new state" and left today's archives out | The list is removed. The reserve is read by its definition, timed at 25 to 44 ms on a copy, with an upgrade case and a writer walk in M2 (§3.2) |
| P2. The requirement section translated private speech | Restated as a list of needs in this document's words, in its own order, with no quoted phrase; §5.1 and §10 follow it |
| P3. The reserve share was not guaranteed by the pack order | The share is counted before the front is packed, with the two-byte case worked in §3.4 and tested in M2 |
| P3. M0 rested on an unconfirmed cause and a wall-clock test | §2.2 separates what was measured from the inference and adds a measured candidate (the whole-collection copy); M0 starts with a profile and is tested by counting loop turns through an injected turn function; the ledger target stays as the production check |
| P3. Four statements about current behaviour | Corrected: the fallback's cut (§0, §2.2, §3.2), the fence's forced project filter at `:87` (§2.6, §5.2), the rewrite condition and the new restriction (§3.2), the notices (§4.4) |
| P3. The open-change list | §2.1 and §2.6 list #3834, #3841, #3838, #3731, #3795, #3710 and #2926 with what each moves, and the build plan names them as dependencies |
| P3. Two member views undefined | W1 answers the no-pool case with one recommendation; W2 leaves `global` engine-memory entries out of a member's results (§5.2) |
| P3. T1 was not small | Split into T1a (scope and every guard), T1b ("My rules", with rendered evidence in both languages and themes) and T1c (provenance) |

The critique's notes were taken too. The replay was run again, from scripts
kept in the stage's scratch directory, and now resolves each rule to the
text version the ledger recorded. The short list for the model is built only
if Q2 keeps the model.

## Notes

- The earlier attempt's pull request #3606 holds a file of the same name on
  its own branch. This document is a new file on a branch from `main`; that
  pull request is to be closed as superseded.
- The probes behind §2 ran in a stage scratch directory on copies and were
  removed with it. Each is a read-only query that a later stage can repeat:
  counts of rule rows by state and reason; ledger rows grouped by reason
  with their phase timings and cost; the copy of every collection row timed
  under the pinned Bun; the range query for one reader's reserve; and the
  replay of §2.3, which joins applied marks, ledger pools with their
  recorded text hashes, and pipeline briefs.
