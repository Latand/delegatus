# Shared role memory across Delegatus installations (swarm lessons): research and options

Status: research and design, 2026-10-22. Read-only stage; this document is the
only file written. Code references are to `main` at `91e4dd841`. Live counts
come from a read-only copy of three state collections taken at
**2026-10-22 19:04:50 UTC** (the cutoff T). External documentation was fetched
between 19:07:58 and 19:12:55 UTC the same day. No rule text, rule id,
conversation id, account, host or path appears below; projects other than this
repository are counted, never named.

## Originating requirement

Operator, 2026-10-22, by voice in Russian, as the comment on the decision form
for the install-transfer design (`docs/design/install-memory-transfer.md`). The
task records the comment at about 17:35 UTC; the seat's conversation (title
«You are the Orchestrator. Mode: standard. Safety fences: …») received the
delivered form answer at 18:51:00 UTC. The pinned specification marks the words
for agents only, so this document gives a dated paraphrase:

1. Delegatus needs a collective memory for all of its installations, a
   "swarm", mostly of **role memory**, so that roles get better at their work.
2. It is **opt-in**: people who want to join tick a box.
3. **At most once a day**, an install checks which role memory was added or
   changed and sends its **proposals**. Proposals land as **pending** on a
   server, whose stored memory is **bounded**.
4. One machine cannot submit more than once in that period.
5. Periodically the team works through the pending proposals and updates the
   swarm's memory, which the participating installs **receive**.
6. Submissions are **anonymous**, in the way the existing install ping is.
7. Research first, then decide. Look for a different way that is simpler, more
   elegant and correct.

The same comment opened with a decision that frames this one: only Delegatus's
own memory should travel between installs; Claude Code and Codex memories are
imported into it once and curated there. The swarm is therefore about Delegatus
role memory.

The default answer to "should we build this" is no unless the requirement
demands it. The requirement does demand a collective role memory, so the
question here is which mechanism carries it at the least risk and cost. Cut
scope stays under "Deferred".

## 0. How this was researched

**Code.** Every `file:line` below was read at `91e4dd841`. The assigned
worktree was clean at the start.

**Open work on the same files.** Three open lanes touch nearby code, and none
writes this document:

- PR #3200 (every operator correction leaves a lesson) edits
  `src/lib/memory/roleStore.ts`, `roleTypes.ts`, `roleRender.ts`,
  `curation/brief.ts` and `src/lib/roles/defaults.ts`. Line numbers cited in
  those files will move when it merges.
- The install-transfer build lane (slices 1–2, no PR yet) writes the bundle
  that option B's voluntary export would reuse.
- The one-memory lane (slices 4 and 6) changes engine-memory import.

**Live state.** A scratch script opened the live `state.sqlite` read-only and
copied the rows of `role_memory`, `role_memory_selection` and
`role_memory_curation` (6 197 rows, one 169 ms read) into the stage's scratch
directory. Further scripts printed only counts. The copy lives only in that
scratch directory, which is removed when the stage settles.

**Earlier answers.** `search_transcripts` (project-scoped, then unscoped) with
"swarm memory all installations", the operator's own Russian phrasing for a
collective memory of all installs, "share learned rules between
installations", "default role memory shipped in release", "swarm builders
shared memory", "install ping opt-out on by default decision", "lessons from
other users community rules upload", and Russian phrasings for the anonymous
ping, role memory and a server; `search_memory` with "share role memory rules
between installations machines" (no hits). What was found is in §1.6.

**External facts.** Cloudflare documentation pages, fetched raw, tags
stripped, read whole (status 200 each): D1 limits (120 102 bytes, page dated
2026-04-21), D1 pricing (127 840 bytes, 2026-04-21), the Workers rate-limiting
binding (224 643 bytes, 2026-10-21), Analytics Engine limits (114 721 bytes,
2026-04-23) and Analytics Engine pricing (118 092 bytes, 2026-04-23).

**What could not be read.** The number of active installations. It is on the
landing Worker's private `/stats` page, which sits behind Cloudflare Access
(`landing/worker.ts:141`). This stage has no Access login, and no transcript
quotes a recent figure. The value of every option that collects from other
installs scales with that number (§2.6).

## 1. What exists today

### 1.1 Role memory: levels, store, writers and bounds

| Fact | Source |
| --- | --- |
| Lessons are records in one `state.sqlite` collection, `role_memory`, with three row kinds: rule, scope, lesson request. Rule rows are never deleted; removal archives. | `src/lib/memory/roleStore.ts:30-44` |
| Four levels a stage reads: its role on this project (`role:<project>:<role>`), its role on every project (`role:*:<role>`), the project, and the machine. | `roleStore.ts:119-121`, `src/lib/memory/roleScopes.ts:3-9` |
| Agents choose role, project or machine; only the curator widens a role rule to "every project" after checking other projects. | `src/lib/memory/roleRender.ts:107-111`; `docs/design/role-memory-layers.md` §7.3 decision 1 |
| One lesson per stage attempt; a rule is at most 300 code points; its `why` (what happened on the task) stays on the record and agents never read it. | `src/lib/memory/roleTypes.ts:14-20`; `roleRender.ts:113` |
| A scope's target is 10 000 code points; only rules a curator has seen leave for budget. | `roleTypes.ts:10-11`; `role-memory-layers.md` §4.1 |
| The curator runs from the seat tick: first for a project, under budget pressure, after 10 new lessons, or every 6 hours. | `roleTypes.ts:12-13`; `src/lib/memory/curation/store.ts:245` |
| Its checklist: task-specific, stale, readers, level, duplicates, contradictions, ranking. | `src/lib/memory/curation/brief.ts:6-12` |
| Promotion of a rule into a role's prompt template "is a separate explicit operator step". Scaffold text can be changed only in `src/lib/roles/defaults.ts` by a pull request; `PUT /api/roles` accepts `promptScaffold: null` only. | `curation/brief.ts:23`; `src/lib/roles/store.ts:230-237` |
| Reviewer, verifier, issue reporter and curator read no rules. | `curation/brief.ts:8`; `role-memory-layers.md` §7.3 |
| `LLV_ROLE_MEMORY=off`, or the memory source set to the engines, stops requests and delivery together. | `src/lib/memory/settings.ts:28-36` |
| Delivery is whole-scope, frozen per attempt; BM25 (and Jev, under its own $5 a month) select in shadow only. A 24 000-byte hard maximum per launch arrives with selected delivery in slice 4. | `src/lib/memory/roleSelection.ts:13-27,85-96`; `roleSelectionSpend.ts:5`; `roleSelect.ts:13-14`; `role-memory-layers.md` §4.3, §7.2 |

**Live counts at T** (one installation, the maintainers' busiest):

| Level | Scopes | Active rules | Code points of rule text |
| --- | ---: | ---: | ---: |
| Role on this project | 91 | 316 | 83 747 |
| Role on every project | 13 | 142 | 33 030 |
| Project | 7 | 3 | 797 |
| Machine | 1 | 20 | 4 283 |
| **Total** | 112 | **481** | 121 857 |

- Rule rows by state: 481 active, 213 merged, 824 archived, 1 443 earlier
  versions. Writers of non-version rows: 1 311 by stages, 207 by seats.
- New non-version rule rows per UTC day, 2026-10-10 to 2026-10-21: 53 to 219,
  median 128.
- Curator moves **into** a role-on-every-project scope, 2026-10-12 to 10-21:
  148 in total, median 15 a day, at most 37.
- Role-on-every-project rules hold a median of 248 code points (maximum 300)
  and come from 5 of the 7 projects, written for builder (41), orchestrator
  (37), architect (36), visual critic (13), prod-auditor (12), merger (2) and
  deployer (1).
- Write-time privacy hints (`rulePrivacyHints`, `roleStore.ts:236`; classes
  credential, home path, private network, resource identifier, transcript
  content, email): **0 of 481** active rules carry one. A broader
  heuristic scan found 2 role-here rules with a path-shaped token that the
  write-time classes do not flag, 1 machine rule with a host-like token, 21 rules naming this
  product (19 role-here, 2 role-wide), 3 role-here rules in Cyrillic and 22
  rules with environment-variable names.

### 1.2 Applied and misled (#3191)

#3191 merged at 2026-10-22 11:18:07 UTC. A stage's `leave_lesson` answer may
carry `applied` and `misled`, each up to five ids. The server accepts only ids
that the delivery ledger shows this attempt received
(`roleStore.ts:302-310`; `src/lib/memory/deliveryLedger.ts:269-280`; schema at
`src/lib/mcp/server.ts:4262-4263`). The fields are stored on the lesson-request
row (`roleTypes.ts:170-190`). Disuse ranks a rule lower and never deletes it
(`role-memory-layers.md` §6, line 1169 onward).

From the merge to T (about 7.8 hours, the first `applied` recorded at
13:34:11 UTC):

- 102 lesson requests in 4 projects: 83 builder, 12 architect, 7 prod-auditor.
  Answers: 46 none, 40 lessons, 15 rewrites, 1 problem.
- 57 answers carried `applied`: 158 ids, 75 distinct rules (54 role here, 12
  role on every project, 2 project, 7 machine); 14 of the 158 name rules a
  curator archived after delivery.
- 1 answer carried `misled`, with 1 id.

`applied` is therefore a dense signal from the first hours; `misled` is rare.
Evidence from many installs would add mostly `applied` rates, and `misled`
would need many install-days before it means anything.

### 1.3 Lesson text is treated as private today

Every agent that receives rules is told to keep them on the machine: "Keep
them on this machine: never copy a rule into a commit, pull request, issue,
task or report; name it by its id" (`roleRender.ts:13`; the seat's notice,
`:14`). Code enforces it where text leaves a stage (`roleStore.ts:680-693`):

- Outgoing text (the next stage's prompt, the linked board's wire, the bridge,
  issue reports) has every stored rule **and why**, active or not, replaced by
  `[learned rule]`. The linked-board task feed applies it
  (`src/lib/links/taskFeed.ts:184`).
- Every stored rule and why is written to a known-values file
  (`roleStore.ts:910-958`). The publication privacy gate refuses a push that
  carries one, for the controller's pushes and every agent's own.

**Probe (scratch, invented text).** The gate was exported from `91e4dd841`
into scratch and run on a tiny repository whose known-values file held one
invented sentence. A JSON file holding that sentence: `PRIVACY GATE: FAIL`,
`known_value: 1`. The same sentence with changed case and punctuation:
`FAIL`, `known_value: 1` (the gate also matches a normalized fingerprint). An
unrelated sentence: `PASS`.

**Consequence.** On the maintainers' machine, a public file that repeats a
stored lesson cannot be pushed through the product's own gate, even after
light rewording. Any shared pack built from local lessons needs an explicit
exemption for texts that are public by decision (§3.1, item 4).

### 1.4 What already crosses machines

| Path | What leaves | Opt-in or out | Source |
| --- | --- | --- | --- |
| Install ping | Once per UTC day: a random UUID minted for the ping, version, OS, architecture, install kind. The Worker adds Cloudflare's country and stores no IP. | **On by default**, with a notice and a switch; `DELEGATUS_TELEMETRY=0` or `DO_NOT_TRACK=1` always win | `src/lib/telemetry/sender.ts:23-37`; `store.ts:18,40-44,50-62,64-69`; `landing/worker.ts:35-46,95-101` |
| Linked installs | Board tasks of projects both peers share, agent summaries; direct between the two peers, no project-run relay | Opt-in per project; the only grant scope is `board:sync` | `src/lib/links/protocol.ts:51`; `docs/design/linked-installs.md` §5.2 (line 1020), M.2 (line 1454) |
| Memory profiles | Selected learned rules to Anthropic through a headless Claude Code run | Per use | `docs/guide/security-and-privacy.md:44` |
| Jev shadow selection | Rule texts and a redacted brief to OpenRouter | Only with an OpenRouter key, under $5 a month | `roleSelect.ts:123,147`; `role-memory-layers.md` §7.3 decision 2 |
| Install transfer (designed 2026-10-22; build lane open) | The whole store, `memory.role` included, as a bundle sealed by default, moved by the operator | Explicit export | `docs/design/install-memory-transfer.md:177`, §4.6, §8 |

Nothing sends lesson text to a server run by the Delegatus project.

**The linked-installs transport** pairs two installs with a one-time code; the
grant it mints carries scopes, and today the only scope is `board:sync`
(`src/lib/links/protocol.ts:51`). The machine that typed the code makes every
request, carrying `x-delegatus-peer: <grant>.<token>`
(`src/lib/links/client.ts:100`), so a home machine behind NAT needs no inbound
route (`linked-installs.md` M.1). Its originating requirement asks that any
stronger capability be "a separate, explicit grant per peer … never implied by
the read-only pairing" (`linked-installs.md:87-89`). Stored lessons are
withheld from what it carries (`taskFeed.ts:184`). It joins machines that one
or two operators pair on purpose; it has no notion of "every installation".

### 1.5 The install ping and the landing Worker

- **Sender.** Runs only in the production Viewer (`sender.ts:8-14`), one
  minute after boot, then checks every minute. An exclusive file per UTC day
  (`claimDay`, `store.ts:64-69`) makes it at most one attempt a day, failures
  and restarts included, with a 5-second timeout and no retry
  (`sender.ts:31-35`). The id is minted independently of the linked-install
  identity (`store.ts:49-62`).
- **Worker.** Answers `/api/*` before static assets
  (`landing/wrangler.jsonc:9`). `/api/ping` reads at most 512 bytes and accepts
  exactly five fields, then writes one Analytics Engine data point
  (`landing/worker.ts:85-101`). It reads the country from Cloudflare metadata
  and is written to "never inspect IP headers or cookies" (`:95`). The stats
  page queries three months of retained data (`:217`) behind Cloudflare Access
  (`:141-166`).
- **Consent surface.** The Settings → Install ping dialog holds the ping switch
  and the existing direct-subscription consent
  (`src/components/telemetry/TelemetrySettings.tsx:57-66`). It is the
  product's one place for "what leaves my machine".
- **History.** The usage-metrics design recommended an opt-in ping,
  "asked once" (`docs/design/usage-metrics.md` §1.2, line 209). It shipped on
  by default with an opt-out on 2026-10-01 (#2382). The swarm is opt-in by the
  operator's own words.

Cloudflare facts for a server-side store (pages listed in §0):

- **Analytics Engine.** At most 20 blobs, 20 doubles and one index per data
  point; blobs total 16 KB per point; 250 points per Worker invocation; data
  kept three months. It is append-only, with no per-row deletion in the API.
  Free plan: 100 000 points written and 10 000 read queries a day. The page
  says billing has not started yet.
- **D1.** Free plan: 500 MB per database, 5 GB per account, 100 000 rows
  written and 5 million rows read a day. A row is at most 2 MB.
- **Rate-limiting binding.** Periods are 10 or 60 seconds only, counted
  approximately per location. For a strict limit the page points to Durable
  Objects. A once-a-day limit therefore needs stored state (D1 or a Durable
  Object).

### 1.6 How shared text reaches every install today, and earlier answers

- **The shipped role prompts are the one text every install shares.** That is
  stated in `docs/design/role-memory-to-prompts.md` §5.3 (line 764), which
  keeps promotion of a rule into a prompt as "a reviewed change to the shipped
  text". The scaffolds live in `src/lib/roles/defaults.ts` (working rules at
  `:41`, role table at `:228`). The variant-4 prompts (#2937, 2026-10-15)
  carried principles distilled from this installation's memory to every
  install.
- **Releases carry provenance.** npm publication uses trusted publishing
  (`.github/workflows/publish.yml:146`). Automatic updates are off by default
  (`src/lib/selfUpdate/auto.ts:75`), so an install receives new shipped text
  when its operator updates.
- **2026-10-07 11:41 UTC**, seat conversation «You are the Orchestrator. Mode:
  standard. In every mode, keep at most 3 workers running at once…»: the
  request that started role memory used "swarm of builders" for agents of one
  role sharing one memory **on one installation**
  (`docs/design/role-memory.md`, originating requirement).
- **2026-10-12**, `docs/design/orchestrator-role-memory.md:797`, under
  "Deferred": "Sharing rules between machines. Role memory is local to an
  installation."
- **2026-10-15 10:34 UTC**, seat conversation «You are the Orchestrator. Mode:
  standard. Process cleanup: …»: the request to update every role's prompt
  from memory, answered by `role-memory-to-prompts.md`.
- **2026-10-15 11:49 UTC**, same conversation: a report that one machine rule
  had been written and verified on **both** of the operator's installations.
  Today, cross-install sharing happens by hand.
- **2026-10-22**, `role-memory-layers.md` §7.3: role-wide writes stay
  curator-only, applied/misled measurement is authorized, rule quality is
  reviewed visually by the operator, and "automatic promotion into prompts"
  stays deferred.
- No earlier design, memory entry or conversation proposes sending lessons to
  a server.

### 1.7 Constraints the observations impose

- **K1. Lessons are private by contract** (§1.3). An upload, and a public pack
  built from local lessons, each change that contract, and each needs the
  egress and gate exemptions to say exactly which texts are public.
- **K2. `applied`/`misled` need delivery.** The server accepts only delivered
  ids (§1.2). A shared rule must therefore travel through the learned-rules
  block and the delivery ledger. Prompt text has no ids, so a rule promoted
  into a scaffold cannot be measured.
- **K3. A frozen block resolves its rules from the store.** On a resume,
  `withdrawn` (`roleSelection.ts:67-82`) drops any entry whose id and text hash
  it cannot find among `role_memory` rows. A shared rule that is not a stored
  row would vanish from a resumed attempt unless the resolver also knows it.
- **K4. "One per machine per day" cannot be enforced anonymously.** A client
  file (as `claimDay` does) binds an honest client only. A server-side daily
  limit needs an identity, or a key derived from the network address kept for
  a day (§1.5). The rate-limiting binding cannot count a day.
- **K5. Project keys identify repositories.** A `repo-` key hashes the
  remote's canonical host and path and is the same on every machine
  (`linked-installs.md` M.2). Guessing public remotes reverses it. No project
  key may leave.
- **K6. Prompt budget.** Shared text adds bytes to every start of its role.
  Builders already start with about 23 KB whole (`role-memory-layers.md`
  §4.1), under a 24 000-byte maximum once slice 4 ships.
- **K7. Thirteen shipped role ids**, four of them clean (§1.1). Unknown roles
  are refused (`src/lib/roles/store.ts:254`). Only shipped, memory-eligible
  role ids may label shared rules.
- **K8. Names collide.** "Shared memory" already names the cross-engine lookup
  in Settings and the guide (`docs/guide/memory.md`, "Shared memory"). The
  product name for this feature has to differ; this document says **swarm
  rules**.

## 2. Options

Each option is described by what leaves the machine, anonymity and scrubbing,
the daily limit, how a bad or poisoned lesson is caught, how evidence from
many installs ranks lessons, the storage bound, and how an install opts out and
removes what it gave.

### 2.1 Option A: anonymous daily proposals, central pending store, curated pack (as asked)

An opted-in install sends, once per UTC day, a batch of its new or changed
role-wide rules to `delegatus.org`. The Worker stores them as pending in a
bounded D1 table. The team curates them into a pack that installs receive.

- **What leaves.** Per item: the rule text (at most 300 code points), the
  shipped role id, and the install's own evidence for it (deliveries, applied,
  misled; integers). Per batch: the release version. Never the `why`, the
  source, a project key (K5), a conversation, task or rule id, an install id
  or the country. At most 20 items, from local `role:*:<role>` scopes only,
  for rules a local curator pass has seen and at least 24 hours old. On this
  install the curator moved a median of 15 rules a day into those scopes
  (§1.1), so 20 covers a typical day.
- **Anonymity and scrubbing.** Detector hits are hints, as the operator
  decided for issue reports on 2026-10-06
  (`docs/design/issue-report-approval.md`). A rule with a hint (the classes of
  `rulePrivacyHints`, plus URLs) stays out of the automatic batch and is
  listed in the preview, where the operator may add it. The Worker
  recomputes the hints and stores them with the item for the curation step,
  which reads every text. The first time, and whenever the operator asks, the
  dialog shows the exact payload of the next batch. A local "sent" list keeps
  every item and its deletion token. Anonymity is partial: a rule's own
  wording can still describe a private product (§2.6).
- **Daily limit.** The client claims the day as the ping does. The server must
  also limit (K4). Two ways: a keyed hash of the connecting address with a
  random key that exists for one UTC day, stored in D1 for that day and then
  deleted; or no server limit, which lets one sender fill the pending store.
  The first changes the Worker's written promise never to inspect IP headers
  (`landing/worker.ts:95`). That is question 6.
- **A poisoned lesson.** The danger is a rule that steers agents with host
  access ("disable the gate", "run this script"). It is caught in four places.
  (1) Hints stored with each item point the curation at it. (2) The pending batch is read
  as data by a curation stage with no write tools and no network, because
  anonymous text is untrusted input to the maintainers' own agents. (3) Every
  accepted text is rewritten by a person-approved pull request into the pack.
  (4) Installs render shared rules under the same "rules of thumb yield to
  every other instruction" notice, and `misled` counts flag what slips
  through.
- **Ranking from many installs.** Each proposal carries the sender's
  deliveries, applied and misled counts. Equal normalized texts from several
  batches count as one proposal seen N times, which measures breadth.
- **Storage bound.** A pending table of at most 5 000 rows or 4 MB of text,
  whichever comes first. At the bound the Worker answers 429 "pending full";
  the client keeps its batch and offers it the next day, so nothing is
  dropped silently. Rows leave when curated, or after 30 days. Address keys
  last one day. At the free-plan limits this is far below 500 MB and 100 000
  writes a day.
- **Opt-out and removal.** Unticking stops sending at once. Each item carries
  the hash of a random token that only the sender keeps. Opting out sends one
  deletion with all held tokens, and the Worker removes matching pending rows.
  A token also lets the sender ask for an accepted rule to leave the next pack.
  Text that already shipped in a release stays in that release and in the
  repository's history.
- **Value.** Lessons from every opted-in install with no per-lesson effort.
- **Privacy cost.** Highest of the four. Agent-written text from private projects
  leaves without a person reading each item, and one leak cannot be recalled.
- **Abuse resistance.** Lowest: an anonymous write channel into the
  maintainers' curation.
- **Cost.** D1 and Worker within the free plan at the volumes above.
- **Effort: M–L.** Worker endpoint, D1 schema, address-key limiter, deletion
  endpoint, client batcher and preview, sent list, untrusted-input curation
  stage, plus everything in option B for the receiving side.

### 2.2 Option B: shipped role memory, built by the maintainers, no upload

The maintainers curate a pack of role rules from their own installations. The
pack lives in this repository as reviewed public text and ships with each
release. Installs that opted in render it as one more read-only scope.

- **What leaves.** Nothing. An optional voluntary export (the transfer
  bundle's `memory.role` section, filtered to role-wide rule texts) lets an
  operator hand rules to the maintainers however they like. Option C turns
  that into a product path.
- **Anonymity and scrubbing.** Nothing is uploaded. The pack is written by a
  maintainers' pass and checked by the hosted privacy gate on its pull request,
  like any public file.
- **Daily limit.** None needed.
- **A poisoned lesson.** Pull-request review; releases carry provenance
  (§1.6). A bad shipped rule is dropped in the next release.
- **Ranking from many installs.** None without option D's counts.
- **Storage bound.** The pack file: proposed at most 4 000 code points of
  rendered lines per memory-eligible role and 36 000 in total (question 3).
  A unit test enforces it.
- **Opt-out and removal.** One switch hides the shipped scope. There is
  nothing to remove, since nothing was sent.
- **Value.** Every opted-in install starts with the maintainers' tested
  role-wide practice. The source is about 142 rules from 5 projects (§1.1)
  before curation for any operator. Lessons from other installs arrive only by
  hand.
- **Privacy cost.** None for users. The maintainers publish rewritten texts they
  chose.
- **Abuse resistance.** As for code.
- **Cost.** None.
- **Effort: S.**

### 2.3 Option C: proposals as public, attributed submissions reviewed on GitHub

An install's seat offers its operator, at most once a week, the local
role-wide rules that a curator has seen and that earned `applied` marks. The
operator ticks some. The existing issue reporter writes one issue with those
texts and their local counts. The operator approves the exact text, and it is
published to the Delegatus repository through the existing issue-report flow
(`src/lib/issueReports/publish.ts:27-34`): through the Delegatus GitHub App
where an install declared that, otherwise through the operator's own `gh`. The
maintainers' pack pass reads labelled issues.

- **What leaves.** Only the texts the operator approved, the shipped role ids
  and the counts, in a public issue under the operator's GitHub account.
- **Anonymity and scrubbing.** Not anonymous. Scrubbing is the issue
  reporter's existing judgement with detector hints, then the operator's
  approval of the exact text (`docs/design/issue-report-approval.md`).
- **Daily limit.** The weekly offer, plus GitHub's own limits.
- **A poisoned lesson.** It is public and attributed, read by maintainers, and
  rewritten into the pack by pull request.
- **Ranking from many installs.** Counts in the issue body; the same text
  proposed by several issues.
- **Storage bound.** GitHub issues; the pack bound as in B.
- **Opt-out and removal.** Stop proposing. The author can edit or close the
  issue; deleting it needs a maintainer. Shipped text stays in history, as in A.
- **Value.** Fewer proposals than A, each one read and approved by the person
  whose project it came from.
- **Privacy cost.** Low and visible: nothing leaves without its operator's
  approval, and the author is named.
- **Abuse resistance.** High.
- **Cost.** None.
- **Effort: S–M.** A proposal mode for the issue reporter, a weekly line in the
  seat's offer, and a label.

### 2.4 Option D (simpler, recommended): text down through releases, numbers up

B for the content, plus one upward channel that carries **no text**. Once per
UTC day an opted-in install sends, for each shipped rule delivered the day
before, three integers: deliveries, applied and misled. The pack is public, so
its ids name public texts, and the counts reveal only how busy an install is.
New lesson text reaches the pack through C, or through A once question 2
allows it.

- **What leaves.** `{ day, v, rules: [[shippedRuleId, delivered, applied,
  misled], …] }`: shipped ids only, at most 250 entries, each count capped at
  10 000. No install id, no country, no project, no local rule.
- **Anonymity and scrubbing.** No text to scrub. No stable identifier, so days
  cannot be linked to one install.
- **Daily limit.** The client claims the day as the ping does and sends the
  previous complete UTC day. Without an id the server cannot deduplicate, so a
  dishonest client can inflate counts. Counts only rank; people decide.
- **A poisoned lesson.** Content arrives only through reviewed releases, as in
  B. `misled` counts from many installs point the maintainers at a bad shipped
  rule.
- **Ranking from many installs.** Per shipped rule over 30 days:
  install-days reporting, deliveries, applied rate, misled count. A rule with
  `misled` on three or more install-days, or an applied rate in the lowest
  tenth after 50 deliveries, is put in front of the pack pass to rewrite or
  drop. Nothing enters or leaves the pack automatically, and the 2026-10-02
  rule (disuse ranks lower, it never deletes) stays in force for local memory.
- **Storage bound.** Analytics Engine, one data point per entry: index = rule
  id, doubles = the three counts, one blob = the version. Three months'
  retention bounds it. For example, 100 installs × 150 entries a day is
  15 000 points, under the free plan's 100 000.
- **Opt-out and removal.** Unticking stops counts and the shipped scope
  together. There is nothing to remove: no point carries an identifier.
- **Value.** All of B's value, plus evidence from every opted-in install about
  which shared rules help, which the requirement's "roles get better" needs.
- **Privacy cost.** Activity levels only.
- **Abuse resistance.** Inflated counts, read by people.
- **Cost.** None at these volumes.
- **Effort: S + S.** The pack slice and one strict Worker route plus a daily
  sender.

### 2.5 Also considered and set aside

- **Promotion into scaffolds only (today's path).** Reaches every install and
  needs no new code. It cannot be measured (K2) or switched off per install,
  and it grows every start of every role. It stays the path for **clean
  roles**, which read no memory, and for principles that every role needs.
- **Peer sharing over linked installs.** Reaches only machines one operator
  pairs, and the install-transfer design already moves role memory between
  them (`install-memory-transfer.md` §4.4, §4.6). It does not reach "all
  installations".
- **A pack pulled daily from the server between releases.** Reaches installs
  that do not update, at the price of a second channel into every agent's
  prompt, which would need its own signing key, rotation and rollback. A
  shipped rule may also name a tool or behaviour that changes with the
  release, so the pack stays consistent when it ships with the code it
  describes.

### 2.6 Comparison

| | A: anonymous upload | B: shipped pack | C: public proposals | D: B + counts (+ C) |
| --- | --- | --- | --- | --- |
| Text leaving an install | agent-written, unreviewed per item | none | operator-approved | none (C: approved) |
| Identity | none (address key for a day, if chosen) | none | the operator's GitHub account | none |
| Daily limit holds against a hostile sender | only with the address key | n/a | GitHub's | no, counts only rank |
| Poisoning reaches | maintainers' curation stage | review only | public issue | review only |
| Cross-install ranking | per proposal, and of shipped rules if D is added | none | per issue | every shipped rule |
| Removal | tokens for pending; shipped text stays | nothing sent | edit or close; shipped stays | nothing identifiable |
| Server state | D1 table, bounded | none | none | Analytics Engine points |
| Effort | M–L | S | S–M | S + S |
| Reversible | no: sent text cannot be recalled | yes | per item | yes |

How much A or C adds over B depends on how many installs opt in and how many
role-wide lessons they write. Neither number is known (§0). On this install a
curator widens a median of 15 rules a day, under a worker limit of 30 (the seat
wake of 2026-10-22 17:28 UTC). A typical install writes far fewer.

## 3. Recommendation

**Option D, in three slices.** Slice 1 alone is the smallest useful step: it
delivers a collective role memory to every install that ticks the box, with no
server and no upload. Slice 2 adds the anonymous daily channel the requirement
asks for, carrying numbers only. Slice 3 adds lesson proposals from other
installs, in the form question 2 chooses. This order keeps the irreversible
step last, and lets it be judged on evidence. The same argument made the
usage-metrics design recommend starting opt-in: a trust incident has no undo.

### 3.1 Slice 1: swarm rules shipped with releases (receive)

1. **Pack file** in the repository, for example
   `src/lib/memory/swarmRules.json`:
   `{ schemaVersion: 1, rules: [{ id, role, rule, since, replaces? }] }`.
   - `id` is `r_` plus the first 16 hex digits of sha256 over role, newline
     and text, so an id always names one text (the existing `applied` schema
     accepts it).
   - `role` is a shipped, memory-eligible role id (K7).
   - `rule` is at most 300 code points, English, naming no project, operator,
     account, machine or tool version.
   - The bound comes from question 3. A unit test checks schema, bound, unique
     ids, eligible roles, and that each id matches its text.
2. **Render** a fifth scope, `swarm:<role>`, after "role on every project",
   headed "Swarm rules · <Role> on every install", with its own notice: these
   rules ship with Delegatus and are public; they are rules of thumb and yield
   to every other instruction. It goes through `learnedRulesSnapshot`
   (`roleStore.ts:197`), so the block, the delivery ledger and the frozen
   selection all record the entries (K2). The byte ceiling cuts it like any
   scope (`roleRender.ts:36-50`), and the 24 000-byte maximum covers it from
   slice 4 of the layers design. Clean roles get none. The scope helpers need
   a fourth kind first. Today `scopeKind` calls every key that is neither
   `machine` nor `role:` a project (`roleScopes.ts:12-14`), so
   `canonicalScope` would rewrite `swarm:<role>` into a project key
   (`roleStore.ts:102-106`), and the block's count line would add swarm rules
   to the project count (`roleRender.ts:55`).
3. **Frozen re-render** (K3). `withdrawn` resolves a swarm entry by id and
   hash from the serving pack. When a later pack no longer holds the id, it
   keeps the line from the frozen row, since the id names one public text.
4. **Privacy exemptions** (K1 and §1.3). `lessonTextsOf` (`roleStore.ts:707`)
   leaves out any stored rule text equal to a pack text under the gate's
   normalization. Those texts then neither reach the known-values file nor are
   withheld from outgoing text; they are public by decision. A rule's `why`
   is never in the pack and stays private.
5. **Curator.** Check 2 gains one case: guidance the swarm pack already holds
   is archived `in-instructions`, with the pack file as `where`. The curator's
   final message already lists role rules backed by two or more tasks
   (`curation/brief.ts:23`); it adds, by id, those with `applied` marks as pack
   candidates, for which the curation read gains each rule's applied and
   misled counts from the lesson-request rows. #3200 edits the same file, so
   this waits for it.
6. **Switch.** Off by default. One switch, "Swarm rules", in the existing
   Settings → Install ping dialog beside the subscription consent
   (`TelemetrySettings.tsx:65`). It turns on receiving now and the daily counts
   once slice 2 ships, and the dialog says both in en and uk.
   `DELEGATUS_TELEMETRY=0` or `DO_NOT_TRACK=1` stop the counts. The shipped
   scope follows the existing memory off-switches (`settings.ts:28-36`). The
   Learned rules window lists the swarm scope read-only.
7. **The maintainers' pack pass.** A pipeline on this repository reads the
   curator's candidate ids from the maintainers' installs, writes each rule
   anew for any operator and project, checks it against the code at that
   commit, and opens a pull request. The operator approves the pull request,
   and the pack ships with the next release (questions 4 and 5). The first
   pack comes from today's role-wide rules.

**Acceptance for slice 1, each with the input that would break it:**

- A pack entry over the role bound, with a clean role, a duplicate id, or an
  id that does not match its text fails the unit test.
- With the switch off, a builder start's block has no swarm scope; with it on,
  the block has the scope and the ledger row lists the swarm ids.
- `leave_lesson` with `applied` naming a delivered swarm id is accepted. A
  swarm id the attempt did not receive is refused with `RULE_NOT_DELIVERED`.
- A resume after the pack drops a delivered id keeps the frozen block byte for
  byte.
- In an isolated state directory, a stored rule whose text equals a pack text
  leaves the known-values file, and the gate passes the pack file. That
  rule's `why` stays a known value: a file carrying it is refused. A stored
  rule that differs from every pack text is still refused, reworded or not
  (the probe of §1.3).
- A reviewer, verifier, issue reporter or curator start gets no swarm scope.
- `LLV_ROLE_MEMORY=off`, or the memory source set to the engines, removes the
  swarm scope with the rest of the block.

### 3.2 Slice 2: daily anonymous counts (numbers up)

- **Client.** In the production Viewer only, off the main loop and under a
  loop-monitor label. It reads the delivery-ledger rows after its stored
  sequence cursor, with the existing paged read (`memoryDeliveries`,
  `deliveryLedger.ts:256`), and
  only the lesson-request rows of the attempts those rows name, by key. It
  counts swarm ids only, for the previous complete UTC day, and sends once with
  a 5-second timeout after claiming the day in its own file.
- **Worker.** `POST /api/swarm/usage`: body at most 16 KB, the exact schema of
  §2.4 (any other field answers 400 and writes nothing), and one data point
  per entry into a new dataset. No country, no IP.
- **Stats.** The Access-protected `/stats` page gains a table per swarm id over
  30 days.
- **Acceptance.** An unknown field, a non-swarm id, a count over 10 000 or
  more than 250 entries answers 400 and writes nothing. Two days of use send
  two requests, neither carrying a stable identifier. The environment
  opt-outs send nothing.

### 3.3 Slice 3: lesson proposals from other installs

Slice 3 is built as option C or option A, by question 2. Either feeds the same
pack pass. If A is chosen, §2.1 is its design, with the server limit of
question 6, and the curation stage that reads pending text runs with no write
tools and no network.

## 4. Questions for the operator

1. **Who receives the swarm rules?**
   (a) Only installs that tick the swarm box, as the requirement says; the box
   also turns on the anonymous daily counts. *(recommended)*
   (b) Every install that updates, with a switch to turn them off.
2. **How do lessons from other installs reach the swarm rules?**
   (a) Anonymous automatic daily batches to delegatus.org once the box is
   ticked, as asked (option A).
   (b) Now: a weekly offer of the install's best role-wide rules, which its
   operator approves and which go out as a public GitHub issue (option C).
   The anonymous upload is decided after four weeks of counts, by a rule
   fixed now: build it when opted-in installs report on at least 20
   install-days a week and swarm rules there are applied at least half as
   often per delivery as on the maintainers' installs. *(recommended)*
   (c) Not yet: only the maintainers' installs feed the swarm rules.
3. **Size of the swarm rules per role** (rendered lines; the whole pack is at
   most nine times that, one share per memory-eligible role):
   (a) 2 000 code points.
   (b) 4 000 code points, about 1 000 tokens per start. *(recommended)*
   (c) 8 000 code points.
4. **How often the swarm rules change:**
   (a) Weekly, in a release. *(recommended)*
   (b) In every release.
   (c) Monthly.
5. **Who curates:**
   (a) A pack pipeline drafts the pull request, and the operator approves it.
   *(recommended)*
   (b) The operator writes the pack by hand.
   (c) A reviewer stage approves, and it merges without the operator.
6. **Only if anonymous uploads are built: how is "one per machine per day"
   held against a hostile sender?**
   (a) A keyed hash of the network address, whose key exists for one UTC day
   and is deleted with it. This changes the Worker's promise never to read
   the address. *(recommended)*
   (b) The client's own daily limit only, accepting that one sender can fill
   the pending store.
   (c) Proof of work on every batch.

## Deferred — not currently justified

- **Anonymous text upload (option A)** until question 2 chooses it; §2.1 keeps
  its design.
- **A pack pulled from the server between releases** (§2.5).
- **Hiding one swarm rule on one install.** The switch hides the scope; a bad
  rule is fixed for everyone by the next release.
- **Project and machine rules in the pack.** They describe one repository or
  one machine; the pack takes role-wide rules only.
- **Swarm rules for clean roles.** Their path stays promotion into prompts.
- **Translating rules.** The pack stays in English, like all rules.
- **Distinct-install counts, version or country breakdowns.** Each needs an
  identifier or extra fields that ranking does not use.
- **Automatic entry or exit from the pack on counts.** People decide.
- **A public dashboard of rule usage.**
- **Peer sharing over linked installs** (§2.5).

## Validation against the requirement

| Requirement (paraphrased, 2026-10-22) | Where answered |
| --- | --- |
| A collective memory for all installations, mainly role memory, so roles get better | Swarm rules rendered as a role scope on every opted-in install (§3.1), measured by `applied`/`misled` across installs (§3.2) |
| Opt-in, by ticking a box | One switch, off by default, in the existing consent dialog (§3.1 item 6; question 1) |
| At most once a day, anonymous, like the ping | Slice 2 sends once per UTC day with no identifier (§3.2); option A has the same cadence (§2.1) |
| Proposals of changes land as pending on a server with bounded memory | On the recommended path, proposals wait as open, labelled GitHub issues (option C); option A's bounded pending store is designed in §2.1 for when question 2 chooses it |
| No more than one submission per machine | Client day claim; the server-side limit for anonymous text is question 6 (§1.7 K4) |
| The team periodically curates proposals into an update that installs receive | The pack pass and pull request, shipped with releases (§3.1 item 7; questions 4–5) |
| Research first, then decide; a simpler, more elegant and correct way | §1 observations, four options compared (§2), and D, which moves no private text and adds one text-free channel (§2.4) |

**Where the recommendation departs from the words.** The requirement asks for
anonymous, automatic daily proposals of lesson text. The recommendation sends
numbers anonymously every day and sends lesson text only with its operator's
approval, under that operator's GitHub account, until question 2's evidence
rule says otherwise. The reasons are observed: lessons are private by
contract in today's product (§1.3, K1), text that has left cannot be
recalled, and an anonymous text channel cannot hold "one per machine per day"
against a hostile sender without reading the network address (K4). Option A
remains fully designed, and choosing it in question 2 restores the requested
mechanism.

## Notes

- The install count behind every value estimate is unknown to this stage
  (§0). The operator can read it on `/stats`.
- The applied/misled evidence covers about 7.8 hours on one installation
  (§1.2). It shows the signal exists; it measures nothing about other
  installs.
- Live counts come from the maintainers' busiest installation. Other installs
  write fewer lessons, and with other projects' wording.
- "Shared memory" is taken (K8). "Swarm rules" is a working name for the
  prototype stage to settle in en and uk.
