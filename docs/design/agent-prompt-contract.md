# One prompt contract for every Delegatus agent

## Originating requirement

Operator, 2026-09-27, spoken in this repository's orchestrator conversation and
pinned by the seat as this lane's specification. Verbatim excerpts, in the
operator's words:

> «Меня интересует именно то, что пошло в реальные промпты, в реальных агентов. Потому что они пишутся под заказ, под каждую задачу, но при этом роль, промпт-роли, может отличаться: и мандат может быть через мандат.»
>
> «все нужно супрячности убирать» *(dictation of «суперечності»: contradictions)*
>
> «там, где мандат и все промты указывают что это TypeScript или JavaScript или какой угодно фреймворк, по идее, этого нигде ничего не должно быть. Никаких згадок про delegatus и его код и его деплой и всё, потому что delegatus должен быть исходным кодом для software factory ... Не должен диктовать, что именно используется. Но он должен диктовать практики.»
>
> «GitHub issue должен использоваться только если настроен GitHub ... он не должен быть обязательным. Это же просто должен быть желательным.»
>
> «pipeline уже должны быть доделаны так, что review flow вообще не должно использоваться. Поэтому если они доделаны, это надо проверить. То убрать просто из промта.»
>
> «review правок в pipeline, да, это действительно проблема ... желательно, чтобы агент назначал, имея матрицу. Если это больше frontend задача, то Sonnet может быть для фиксов, если ему сказать. Но ему нужно конкретно сказать, что и где фиксить. Точно так же с Luna ... нужна какая-то новая роль, эфемерная, которая позволит запускать любую модельку для любой задачи ... Или если у нас уже есть trivial, то тогда мы можем выбирать по матрице автоматически.»
>
> «Словник вердиктов точно нужно делать.»

Decisions the operator already made (from the pinned specification): remove
every contradiction; one verdict vocabulary everywhere; no language,
framework, tool or Delegatus-internal specifics in agent-facing text, only
practices, with a project's gates coming from that project; GitHub issues
recommended when the project has GitHub, never mandatory; review flows leave
the prompts once pipelines are verified to cover what the prompts use flows
for (flow code is removed by a separate task); every role searches prior
conversations and follows human-in-the-loop; "nothing changed → no report"
stands. The two questions the specification left open (how a fix round picks
its runtime, and file ownership) and the two this audit added (the worker cap,
the install's deployer override) were answered on 2026-09-28, in the operator's
words: «По поводу вопросов: всё как советуют.» ("On the questions: everything as
recommended."). Part 3 records each decision; Part 2 is written to them.

Scope: every text Delegatus composes into an agent's prompt. Out of scope: the
instruction files of other repositories and host-level agent configuration.

## Status and evidence

Audit 2026-09-27, finalized 2026-09-28 after the operator's decisions.
Architecture audit; the only file this lane writes is this document. Part 1
cites `803296a6` (main when the lane started), the code that rendered the
prompts it quotes. Part 2 is checked against main at `70ab3aa0` (2026-09-28):
the prompt sources it changes (`orchestrator/prompt.ts`, `roles/defaults.ts`,
`roles/registry.ts`, `roles/paramConfig.ts`, `roles/types.ts`,
`roles/equivalents.ts`, `roles/store.ts`, `pipelines/prompts.ts`,
`pipelines/roles.ts`, `pipelines/legacyReviewDefinition.ts`,
`agent/spawnPolicy.ts`, `agent/spawnCommand.ts`,
`orchestrator/handoffDigest.ts`) are byte-identical between the two; in
`mcp/server.ts` the instructions moved from `:3874` to `:3890`, `engine.ts`
lines moved, and Part 2 cites the `70ab3aa0` lines. Real prompts were read only through `search_transcripts` and
`conversation_messages`, never by opening transcript files. The window is
2026-09-20 to 2026-09-28, in this repository's project and in a second product
repository on the same machine. Samples below are labelled L (this
repository) and S (the second product repository); quotes are cut to the part
that matters, with people, handles, repository names and absolute paths
replaced by bracketed placeholders.

### Prior work

- The orchestrator seat's own audit, 2026-09-27 19:32 UTC, in this
  repository's seat conversation: it listed fourteen contradictions from the
  code, from which the spec's C1–C12 were drawn. This document checks each
  against real prompts.
- `docs/design/retire-flows.md` (2026-09-20): one mechanism for implement,
  review and fix, the pipeline graph; flows retire. Its §2 capability table is
  re-checked against the engine in §2.8 below.
- `docs/design/model-sizing-tiers.md` (2026-09-26): the `size` parameter, the
  variant rows and the sizing rules R1–R3. It chose on purpose that a fix
  stage copies the implementer's params, and it rejected new role ids ("role
  ids are frozen at eight and keyed in admission, pipelines and the board").
- `docs/design/opus-55-prompting-review.md` (2026-09-24): finish lines, "keep
  going", "how to show it fails". Those texts exist in code; §1.4 shows that
  most pipeline stages never received them.
- A search for an earlier verdict-vocabulary design (several phrasings,
  project-scoped and unscoped) found nothing beyond this lane's own prompt.
- Landed on main while this lane ran, and read for fit: #2271 (the MCP launcher
  follows the installed release, §1.4), #2282 (the controller commits a
  read-only stage's declared outputs, §2.9), #2283 (a rotation keeps the
  incumbent's mandate unless the caller names a replacement, §2.11), #2281
  (graph edits and stage-report bounds in the MCP schema) and #2288 (automatic
  merge of lanes whose reviews passed, §2.8). The later merges up to
  `70ab3aa0` (#2273, #2287, #2289, #2293, #2294, #2295, #2297) change no
  agent-facing text:
  the controller's commit identity, linked boards, seat-wake timing and
  account reads.

---

# Part 1 — What real agents received

## 1.1 Sample register

| label | when (UTC) | engine | kind | how launched |
| --- | --- | --- | --- | --- |
| L1 | 09-27 19:24 | Claude | orchestrator seat, rotation, mandate v29 | seat rotation |
| L2 | 09-26 04:46 | Claude | orchestrator seat, rotation | seat rotation |
| L3 | 09-23 15:07 | Claude | orchestrator seat, rotation (older core) | seat rotation |
| L4 | 09-27 19:45 | Codex | builder run stage (lane `8fe84695`) | pipeline via MCP |
| L5 | 09-26 12:06 | Codex | builder run stage (lane `f6cdfe4e`), later sent flow relays | pipeline via MCP |
| L6 | 09-26 12:24 | Codex | review-loop flow reviewer, round 1 of `f6cdfe4e` | flow, headless |
| L7 | 09-26 16:29 | Codex | review-loop flow reviewer, round 2 of `f6cdfe4e` | flow, headless |
| L8 | 09-27 | Claude | architect design stage (lane `d774ba3f`) and this stage | pipeline via MCP |
| L9 | 09-23 16:23 | Codex | spawned reviewer, role `reviewer` | spawn |
| L10 | 09-23 15:06 | Codex | spawned "read-only status check", role `cleaner` | spawn |
| S1 | 09-26 22:28 | Claude | orchestrator seat, rotation, mandate v29 | seat rotation |
| S2 | 09-25 19:43 | Claude | orchestrator seat, rotation (pre-merge-setting merge bar) | seat rotation |
| S3 | 09-24 07:31 | Claude | orchestrator seat, rotation | seat rotation |
| S4 | 09-27 19:18 | Codex | builder run stage | pipeline via MCP |
| S5 | 09-27 19:05 | Codex | builder run stage carrying a decision continuation | pipeline via MCP |
| S6 | 09-24 22:48 | Codex | builder "fix" run stage for human PR review, with a decision continuation and two flow relays | pipeline via MCP |
| S7 | 09-27 19:33 | Codex | review-loop flow reviewer | flow, headless |
| S8 | 09-27 19:36, 19:51 | Claude | flow relays into a pipeline builder whose stage had passed | flow relay |
| S9 | 09-26 19:30 | Claude | spawned architect | spawn |
| S10 | 09-24 22:28 | Claude | architect run stage, read-only, no declared output | pipeline via MCP |
| S11 | 09-25 | Claude | architect run stage with a declared output | pipeline via MCP |
| S12 | 09-27 09:02 | Claude | spawned prod-auditor | spawn |
| S13 | 09-26 07:53 | Codex | spawned prod-auditor | spawn |
| S14 | 09-27 16:48 | Codex | spawned verifier used as a code reviewer | spawn |
| S15 | 09-22 | Claude | spawned verifier | spawn |
| S16 | 09-22 10:31 | Claude | plain spawn, no role, hand-written reviewer brief | spawn |
| S17 | 09-27 17:59 | Claude | spawned builder (for the version comparison) | spawn |
| R1 | 09-27 19:24 | Codex | rotation-history compactor | internal |

Added on 2026-09-28, all composed after the install's MCP bundle was rebuilt
(§1.4):

| label | when (UTC) | engine | kind | how launched |
| --- | --- | --- | --- | --- |
| L11 | 09-27 21:00 | Codex | converted fix stage, runtime copied from a `gpt-6-sol` implementer | pipeline via MCP |
| L12 | 09-27 21:55 | Claude | reviewer run stage (role `reviewer`, fail edge) | pipeline via MCP |
| L13 | 09-27 20:47 | Claude | prod-auditor run stage (lane `90d7070f`) | pipeline via MCP |
| L14 | 09-27 21:46 | Claude | prod-auditor run stage (lane `85c5e007`) | pipeline via MCP |
| S18 | 09-27 22:33 | Claude | converted fix stage, runtime copied from a Sonnet implementer | pipeline via MCP |
| S19 | 09-27, ended 21:03 | Claude | builder run stage whose brief ends with REVIEW_READY | pipeline via MCP |
| S20 | 09-27 21:03 | Claude | reviewer run stage | pipeline via MCP |

Kinds the window does not contain, stated so nobody reads the tables as
complete: no fresh seat in either project (all eight seat deliveries were
rotations, so the fresh-seat text below is derived from code); no pipeline run
stage with role `verifier` or `cleaner`; no verifier in this repository. Up to
09-27 20:29 UTC every pipeline review was a review-loop flow (§1.4); after it,
reviews ran as reviewer run stages (L12, S20) with converted fix stages (L11,
S18). Earlier fix work is S6 (a seat-written fix stage) and the flow relays
into builder sessions (L5, S6, S8).

## 1.2 How a first message is assembled

| layer | what it is | source |
| --- | --- | --- |
| seat-written brief | the stage prompt, spawn prompt, or flow spec plus ready note | `pipelines/prompts.ts:35` (stage body), `agent/spawnCommand.ts:367-368` (spawn), `flows/prompts.ts:37-41` (flow) |
| role scaffold | per-role text with `{{param}}` substitution | `roles/defaults.ts:66, 86, 98, 112, 124, 134, 146, 159`; shared pieces at `:5-8, 16-17, 22-23, 28-29, 36-38`; substitution `roles/registry.ts:74-78`; frontend guidance `registry.ts:88-89` |
| safety fences | per-role bullet list | `roles/defaults.ts:67-71, 87, 99, 113, 125, 135, 147, 160`; block `registry.ts:95-98` |
| stage wrapper | pinned task and spec, role context, access, host, nesting, completion channel | `pipelines/prompts.ts:29-93` |
| relay | a predecessor's output, or a decision continuation, when the prompt did not place `{{prev.output}}` | `pipelines/prompts.ts:43-47`; engine passes the attempt input at `engine.ts:3490-3495` |
| decision continuation | question, answer, "continue" | `pipelines/prompts.ts:19-27`, written at `engine.ts:7013` |
| flow note (legacy review-loop) | stage prompt plus scaffold cut to fit 2 000 characters | `pipelines/engine.ts:3850-3869`; cap `flows/commands.ts:302` |
| flow reviewer and relay text | "Output exactly this format: VERDICT…", "respond FIXED or REJECTED … REVIEW_READY" | `flows/prompts.ts:29-50`, `reviewHistory/relayPrompt.ts:4-13` |
| Codex spawn fence | "Viewer spawn policy … POST …/api/spawn …" | `agent/spawnPolicy.ts:46`, applied at `agent/headless.ts:335` and `tmux.ts:1370` |
| mandate section | the orchestrator mandate core | `orchestrator/prompt.ts:317-379`; delivered directives `:112-116, 172-180, 271-296` |
| role table | registry rows plus sizing notes | `orchestrator/prompt.ts:384-427` |
| rotation handoff and history | predecessor, open tasks, compacted history | `orchestrator/seatCommand.ts:1250, 1342`; `orchestrator/handoffDigest.ts:36-38, 494-500` |
| MCP instructions and tool descriptions | read by every agent with the Viewer MCP | `mcp/server.ts:3874` (instructions), `:2987-3010` (create_pipeline, stage_report) |

## 1.3 Layer traces per kind

**Orchestrator seat (L1, S1; rotations).** Order as delivered: orchestrator
role scaffold with rendered params (`defaults.ts:66`) → its three fences
(`:67-71`) → mandate core v29 (`prompt.ts:317-379`) → handoff and rotation
history (`seatCommand.ts`, `handoffDigest.ts`) → role table (`prompt.ts:410-427`).
L1 opens with two identities in a row: "You are the Orchestrator. Drive work
through the production Delegatus MCP tools … Mode: standard / Maximum workers:
3 / Merge policy: pr / Completion policy: pr-opened …" and then "You are this
project's orchestrator in Delegatus — the agent that owns its board and runs
its work through Delegatus's own HTTP API and MCP tools". A fresh seat gets the
same text without the handoff (`orchestratorMandateForDelivery`,
`prompt.ts:476-499`).

**Builder run stage (S4, S5, L4, L5).** Seat brief (`prompts.ts:35`) → relay or
decision continuation when present (`:43-47`) → pinned task and spec (`:67-71`)
→ "Role preset: builder (codex/gpt-6-sol, high)" and the builder scaffold
(`:57-62`, `defaults.ts:112`) → fences (`defaults.ts:113`) → access and host
lines (`prompts.ts:49-56`) → nesting (`:77`) → completion block (`:83-92`). S4's
brief ends "End with REVIEW_READY: <PR url>."; four paragraphs later the
wrapper says "That call is the only way to complete this stage."

**Review-loop flow reviewer (S7, L6, L7).** Flow reviewer header
(`flows/prompts.ts:29-38`) → pinned flow spec → "Ready note:" carrying the
seat's review prompt, which ends "VERDICT: APPROVE|REQUEST_CHANGES." → "Reviewer
role scaffold (reviewer):" cut at the 2 000-character note cap
(`engine.ts:3865-3868`) → fences → read-only requirement → "Output exactly this
format: VERDICT: APPROVE | REQUEST_CHANGES | COMMENT" (`flows/prompts.ts:45-48`)
→ Codex spawn fence (`spawnPolicy.ts:46`). The scaffold text in S7 stops at
"Decide yourself whatever the code, the running system or one cheap
observation can settle; never " and in L6 at "cite what you found or sa".

**Fix work (S6, S8, L5).** S6 is a seat-composed builder stage whose brief
ends "Finish with REVIEW_READY: <PR url>", relayed a decision continuation,
then received two flow relays in the same session. S8 and L5 are flow relays
(`relayPrompt.ts:4-13`) landing in pipeline builder sessions after their stage
had passed. L11 and S18 are converted fix stages: `fixerPrompt`
(`legacyReviewDefinition.ts:140-149`) opening "Fix the findings the review
review reported for: …", the reviewer's summary and ranked findings placed
through `{{prev.output}}`, "Address every finding in this pipeline's worktree,
commit the fix" → pinned task and spec, unchanged from the implementer's →
"Role preset: builder (codex/gpt-6-sol, high)" in L11 and "(claude/sonnet,
high)" in S18, each its implementer's runtime, with the builder scaffold in
`plain` mode → builder fences → access, host, nesting, completion block.

**Reviewer run stage (L12, S20).** Seat brief → relay of the builder's summary
→ pinned spec → "Role preset: reviewer (claude/opus, high)" and the full
reviewer scaffold, no longer cut, since the 2 000-character cap applies only to
flow notes → review fences → "Access: read-only" → completion block.

**Architect (L8, S9, S10, S11).** Pipeline form: seat brief → pinned spec →
architect scaffold (`defaults.ts:124`) → fences (`:125`) → "Access: read-only …
You may write only these declared worktree outputs" when outputs exist
(`prompts.ts:50-51`, S11, L8) or "Do not edit, stage, commit, push, or otherwise
mutate the repository" when none exist (`:52`, S10) → completion block. Spawn
form (S9): scaffold → fences → brief; no completion text at all.

**Prod-auditor (S12, S13), verifier (S14, S15), cleaner (L10), spawned reviewer
(L9).** Spawn form: scaffold with parameters substituted into mid-sentence
slots → fences → the seat's brief (`spawnCommand.ts:368`). No completion
channel is stated by Delegatus; seats add their own endings. The pipeline form
of the prod-auditor (L13, L14) is the builder order above with the
prod-auditor scaffold, its `questions` parameter spliced into the first
sentence the same way (N9).

**Plain spawn (S16).** Only the seat's text. The seat re-wrote pieces of the
reviewer scaffold by hand ("READ-ONLY … Every finding carries file:line
evidence. Report the reviewed SHA … stop only processes you started … End with
exactly one line: `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`") and asked for
"a non-blocking notes section".

**Rotation compactor (R1).** `DIGEST_INSTRUCTIONS` (`handoffDigest.ts:494-500`)
plus prior history and handoffs. Its "Decisions:" output reached L1.

## 1.4 Two texts on the same day: pipelines carried a four-day-old bundle

Code of the day versus what arrived:

| text | on main since (UTC) | pipeline stages 09-26/27 (S4, S5, S7, L4, L8) | spawns 09-26/27 (S9, S17) |
| --- | --- | --- | --- |
| builder "You are done when every acceptance criterion … holds" | 09-23 22:34 (`0c2621af`) | absent | present (S17) |
| reviewer "how to show it fails (a command, an input or a test that goes red)" | 09-23 22:34 | absent (S7) | — |
| "When a step needs nothing from the operator, keep going … settles the stage" | 09-23 22:34 | absent (L8, this stage) | present (S9) |
| rendered-evidence export "under $TMPDIR, the stage's own scratch directory" | 09-25 05:01 (`806f04af`) | absent (L8) | present (S9) |
| new review-loop stages become a reviewer plus a fix stage | 09-25 05:36 (`4784d282`) | not converted: S7's lane and this lane's own `review` stage are stored as `kind: review-loop` | — |
| sizing rules R1–R3 and `size=trivial` | 09-26 08:49 (`b01beca1`) | L4's brief records the seat's `size=trivial` refused as an unknown parameter | — |

Cause, verified on the host: MCP `create_pipeline` composes stages inside the
MCP server process (`mcp/bindings.ts:1651-1661` calls `createPipelineFromRequest`
in-process), and the MCP launcher prefers a prebuilt bundle over source
(`bin/mcp-server.mjs:129-135`: `entry: existsSync(bundled) ? bundled : source`).
With no managed release target it runs the install checkout's
`dist/mcp-server.mjs`, built 2026-09-23 06:20 UTC, while the Viewer itself runs
a self-updated release at `803296a6`. The MCP server answering this stage
reports `defaultPromptVersion: 22` in `get_orchestrator`, while the seats it
serves were delivered v29. Spawns go through the Viewer's `/api/spawn` and get
current text; pipelines get the bundle's.

**Resolved on this install since 2026-09-27 20:29 UTC.** #2271 (lane
`8fe84695`) made the launcher follow the installed release, the install
checkout moved to `58221bd5`, and its `dist/mcp-server.mjs` was rebuilt at
20:29 UTC. On 2026-09-28 the MCP server reports `defaultPromptVersion: 29`, and
every stage composed after the rebuild carries the text of the day: L12 and
S20 have "keep going" and the `$TMPDIR` export rule, and new review-loop
stages arrive converted (L11, S18). What remains is by design and matters for
the build: a pipeline binds each stage's role scaffold when the pipeline is
created (`pipelines/roles.ts:135-148`), so a lane keeps the text it was
composed with. This lane's own audit attempt 2, on 2026-09-28, still carries
the 2026-09-23 architect scaffold. When the contract ships, open lanes finish
on the old text and new lanes get the new one.

The role table shows the same drift from the other side: it is rendered by the
Viewer from current code and advertises `size=trivial` and "Sonnet … nor a
hand-set builder", while the MCP bundle that creates the pipelines neither
accepts the parameter nor enforces the rule. S2 (09-25 19:43) carried the
merge bar "merge only on an APPROVE verdict with green gates (tsc + tests)"
eleven hours after the merge-setting text reached main; whether that was
release lag or a carried core cannot be told from the transcript.

## 1.5 C1–C12 against real prompts

**C1 — four completion contracts. Confirmed.** One S7 prompt carries four
vocabularies: the seat's ready note "VERDICT: APPROVE|REQUEST_CHANGES.", the
scaffold's "exactly NO FINDINGS when the diff is clean" and "A fixable defect
is a fail verdict … needs_decision is for a choice only a human can make", and
the flow's "VERDICT: APPROVE | REQUEST_CHANGES | COMMENT". S14 adds a fifth,
the verifier's "Return CONFIRMED or WRONG for every claim", next to the fence
"Clean work earns a clear NO FINDINGS verdict" and the seat's "End with
VERDICT: APPROVE or VERDICT: REQUEST_CHANGES". Seats keep writing endings into
stage briefs: S4 "End with REVIEW_READY: <PR url>.", S5 the same, S6 "Finish
with REVIEW_READY: <PR url>", and one 09-26 stage "then pass verdict
{"status":"pass"} so the review runs", which promotes the fallback block to
the primary channel. The rebuild changed none of this: S19's brief, composed
on current text, ends "End with REVIEW_READY: <PR url>", and its agent ended
"The stage is reported as pass. REVIEW_READY …", obeying both; L13's brief
repeats the wrapper ("Finish with stage_report: pass with …"); every stage's
fallback line still teaches the old markers ("APPROVE=pass,
REQUEST_CHANGES=fail, COMMENT=needs_decision, NO FINDINGS agrees with pass",
L12). Sources: `prompt.ts:361-362`, `defaults.ts:7, 86, 98`,
`flows/prompts.ts:46-48`, `prompts.ts:83-92`.

**C2 — COMMENT means two things; pass carries no findings. Confirmed, with
the incident.** Lane `f6cdfe4e`, review attempt 1, 2026-09-26: the reviewer's
final answer was "VERDICT: COMMENT / NO FINDINGS … PR-body acceptance remains
unchecked: GitHub was reachable, but no PR exists for this branch."; the
engine recorded "Review flow round 1 returned COMMENT; open the round artifact
for details." as `needs_decision` and the lane parked (`verdict.ts:47`,
`engine.ts:4491-4520`). The flow's own text defines COMMENT as "non-blocking
notes" (`flows/prompts.ts:48`). S16's seat asked for "a non-blocking notes
section" because no channel for notes exists.

**C3 — missing access: note or needs_decision. Confirmed in the scaffold;
corrected for the incident.** The reviewer scaffold says "Classify any gate
blocked by sandbox limits as an environmental note" and, later in the same
text, "Stop and ask when the work rests on … access you lack … report
needs_decision" (`defaults.ts:86`, `:29`). In the 09-26 park the second half
never reached the reviewer: the 2 000-character note cap cut the scaffold
before it (L6 ends at "cite what you found or sa"). The park came through
COMMENT (C2), triggered by an acceptance item about a PR that the lane's own
settings (publication disabled) meant would not exist yet. Reviewer run stages
now receive both halves whole, eight sentences apart (L12: "Classify any gate
blocked by sandbox limits as an environmental note" … "Stop and ask when the
work rests on … access you lack").

**C4 — WRONG-PREMISE and OVER-BUILT called verdicts. Confirmed.** "WRONG-PREMISE
… is an expected verdict", "OVER-BUILT is a first-class verdict"
(`defaults.ts:17`), reaching reviewers (L9) and architects (L8, S9, this stage);
nothing maps either to pass, fail or needs_decision.

**C5 — fix stages copy the implementer. Confirmed, and partly by design.** The
conversion copies the implementer's role, params and explicit runtime
(`legacyReviewDefinition.ts:254-269`); `model-sizing-tiers.md` §1 chose that so
trivial and docs lanes keep their rows. The consequence stands: the
`mode=apply-fixes` row the role table advertises ("mode=apply-fixes:
codex/gpt-6-luna/high" in S1) is reachable in a pipeline only when a seat
names it on a hand-built fix stage. Flows reach it only through the seeded
preset whose implementer runs that row for the whole lane (`flows/store.ts:43-48`);
flows never ran a separate fix agent. The first converted fix stages show it
in practice: L11 ran on `codex/gpt-6-sol` and S18 on `claude/sonnet`, each its
implementer's runtime, both in `plain` mode, while this install maps
`mode=apply-fixes` to `codex/gpt-6-luna/high`.

**C6 — "Inspect  with lens". Confirmed.** Every flow reviewer sampled (S7, L6,
L7) and every reviewer run stage (L12, S20) reads "You are a fresh-context
Reviewer. Inspect  with lens correctness."
Spawns that pass `diffSource` render it (L9: "Inspect <pull request URL> with
lens correctness"). Source: `defaults.ts:86`, empty substitution at
`registry.ts:76`.

**C7 — stack-specific and Delegatus-internal text. Confirmed, and wider.** All
eight seat deliveries carry "green gates (tsc + tests)" (`prompt.ts:363`);
every reviewer carries "Run TypeScript checks with bunx tsc --noEmit
--incremental false", including S7 in a repository whose backend is not
TypeScript. Beyond the spec: the frontend builder guidance demands
"English/Ukrainian parity" (`registry.ts:89`), this repository's own locale
pair; the orchestrator and deployer scaffolds say "preserve the
external-worker deployment barrier" and "Before a Delegatus replacement"
(`defaults.ts:66, 159`); the deployer defaults to "blue/green"
(`:159-160`), a topology the project may not have; the mandate fence names
"a delegatus-conveyor skill (llv-conveyor in older checkouts)"
(`prompt.ts:377`); the Codex fence names the install's port and the old
product name ("Viewer spawn policy … POST http://127.0.0.1:8898/api/spawn",
`spawnPolicy.ts:46`); the deny message beside it contains a stray Russian word
("Spawn через POST", `spawnPolicy.ts:45`); the stage wrapper names "GitHub
CLI" as a host capability (`prompts.ts:56`).

**C8 — three launch paths, issue mandatory. Confirmed in text; practice has
already moved.** The conveyor says "GitHub issue -> worktree lane ->
implementer agent -> review flow" and "Spawn implementers via POST /api/spawn"
(`prompt.ts:359-361`); the task section says `create_pipeline` with `taskIds`
(`:283`); start-by-default says "POST /api/pipelines with autoStart: true"
(`:373`). In the window both seats ran their work as pipelines (43 lanes in the
second product since 09-20, 4 here); the seat's own audit of 2026-09-27 notes
that sessions take the pipeline path and do not open issues for it.

**C9 — file ownership nobody assigns. Confirmed.** "Keep changes within the
assigned file ownership" (`defaults.ts:112`), "One owner holds a file at a time
across active worktrees" (`:70`), "one owner per file across active
worktrees" (`prompt.ts:360`). No stage, spawn or pipeline field carries an
owner. Seats assign by hand in the brief instead: every second-product builder
brief sampled on 09-27 (S4, S5, S7's lane) has a line such as "Fences: do not
touch the … files owned by in-flight [PR] work".

**C10 — read-only architect told to deliver a document. Confirmed when no
output is declared.** S10 ran with "deliver a design document" and "Do not
edit, stage, commit, push, or otherwise mutate the repository". S11 and L8
declared outputs and the same scaffold worked. Seats also route documents
outside the repository ("DELIVER [home]/handoff/…/DESIGN.md", S9).

**C11 — "report state changes" against "nothing changed: no report".
Confirmed.** Both lines sit in every v29 mandate: "Report state changes as
bridge reports." (`prompt.ts:364`) and "Verdicts inside a lane are not owed …
Nothing changed: no report." (`:327-328`).

**C12 — shared rules missing; "Opus-class". Confirmed.** Search is absent
from verifier, prod-auditor, cleaner and deployer; human-in-the-loop from
prod-auditor, cleaner and deployer (`defaults.ts:98, 134, 146, 159`); S12, S13
and L10 show it. The role table's "Only an Opus-class agent's brief admits
size=trivial" (`prompt.ts:424`) reads as Claude Opus, while `isOpusClass`
admits Claude Opus or Fable and any large Codex model (`roles/sizing.ts:57-65`).

## 1.6 Beyond C1–C12

**N1 — pipelines rendered a stale bundle.** §1.4. The largest single cause of
text drift in the window: up to 2026-09-27 20:29 UTC every pipeline stage got
the 2026-09-23 scaffolds, and review-loop stages kept creating flows after
main stopped doing so. Resolved on this install by #2271 and a rebuild; the
residue is that a lane keeps the scaffolds it was created with.

**N2 — the flow note cuts the reviewer scaffold mid-word.** `reviewNote` keeps
the seat's directive and the fences whole and trims the scaffold body to the
2 000-character cap (`engine.ts:3850-3869`). What falls off is the
human-in-the-loop rule, the three frame rules and process cleanup, so flow
reviewers never got WRONG-PREMISE, OVER-BUILT or the rendered-evidence rule
from Delegatus.

**N3 — flow reviewers are told to use tools they do not have.** They run
headless without the Viewer MCP and without a spawn capability, yet the
scaffold says "run a few search_transcripts queries" and the Codex fence says
"Spawn every helper through POST … Send header x-llv-spawn-capability". What
came back: "No transcript search tools were available, so I couldn't check
prior discussions." (S8 relay); "Transcript-search tools were unavailable; the
viewer endpoint returned HTTP 403." (S6 relay); "Historical transcript
searches were blocked by the Viewer's HTTP 403 access-key requirement." (L6).

**N4 — flow relays land in settled pipeline builders.** After the builder's
stage passed, its session receives "Review round findings are below. Address
every finding before the next review marker. … When the work is reviewable
again, end your final assistant message with: REVIEW_READY: <one-line note>"
(S8, S6, L5). The same text wraps approvals: "Address every finding before the
next review marker. VERDICT: APPROVE No findings." (S8 19:51) and "VERDICT:
APPROVE NO FINDINGS" (L5 16:31).

**N5 — the decision continuation is mislabelled and loses to the spec.** S5
reads "Previous stage output (relayed by the controller; the prompt above did
not place {{prev.output}}): Decision continuation for stage build, settled
attempt 1". The answer said it "replaces spec item 3" with a "hard cap 100
messages", while the pinned specification rendered below it still says "hard
cap 20 messages"; nothing tells the agent which wins (`prompts.ts:19-27, 43-47`).

**N6 — backlog-campaign parameters read as standing rules.** In standard mode
the orchestrator scaffold still renders "Maximum workers: 3 / Merge policy:
pr / Completion policy: pr-opened" (`defaults.ts:66`, stripped only for empty
repository, issue query and urgent lines at `registry.ts:77`). The merge policy
line contradicts the mandate's merge setting. The L1 seat treats the worker
line as a cap: "Зараз працює три воркери, це максимум" ("three workers are
running, that is the maximum").

**N7 — the MCP instructions tell every agent to rename its task.** "Your
conversation is already linked to a board task. If that task still carries
its placeholder title, make your first Delegatus action update_task with
refine" (`mcp/server.ts:3874`) reaches read-only reviewers and architects,
whom the mandate describes as "told not to mutate state" (`prompt.ts:276`).
For this stage the claim is false: the refine answered `TASK_NOT_FOUND`
("the calling conversation is not linked to a task").

**N8 — no role fits, so seats pick one and fight its scaffold.** L10: a status
check launched as `cleaner`, whose scaffold says "preserve recoverable evidence
before each destructive operation" and fence "Create a backup before each
destructive operation", under the brief "READ-ONLY. Don't edit, delete, move,
commit, push, restart or clean anything". S14: a merged-PR review plus a
rollout analysis launched as `verifier`, with the brief's opening paragraph
pasted into `{{claims}}` and repeated in the body below it. L9: the reviewer scaffold says "Run
TypeScript checks with bunx tsc" and the seat's brief says "do not … build,
run test suites".

**N9 — parameters spliced into sentences.** S12: "You are a Prod-auditor.
Investigate Read-only production investigation for [second product].
[Operator] asked for this on Opus. Do not change code, config, or data. Do
not restart anything. through the production read wrapper only." S13: "You are
a Prod-auditor. Investigate Read and follow [path]/BRIEF.md…". "The production
read wrapper" is defined nowhere; one seat's follow-up had to say "The ssh
commands in BRIEF §1 ARE the approved production read wrappers". Pipeline
stages splice the same way: "You are a Prod-auditor. Investigate Answer the
four questions in the pinned spec. through the production read wrapper only."
(L13, and L14 with "three"). The deployer has the same shape ("(PR {{pr}})"
with an optional `pr`).

**N10 — spawned agents have no completion channel.** Human-in-the-loop tells
every role to "report needs_decision", and the reviewer scaffold speaks of
"a fail verdict"; a spawned agent has no stage to report to (`stage_report`
refuses "a conversation that holds no live attempt"). Seats fill the gap with
their own endings (L9, S14, S16: "End with exactly one line: VERDICT: APPROVE
or VERDICT: REQUEST_CHANGES").

**N11 — seat briefs require what the lane's settings rule out.** `f6cdfe4e`'s
spec required PR-body notes while the lane published nothing, so no PR existed
when the reviewer looked, and the review parked on it (C2). The contract's
missing-access rule (§2.4) makes such an item a note about a later step.

**N12 — the rotation digest carries process rules forward as "decisions".**
R1 wrote, and L1 received under "Rotation history → Decisions": "Spawn helpers
through the local viewer API with the required capability header; avoid
native sub-agent …". A mandate change to how agents are run is undone at the
next rotation by the history (`handoffDigest.ts:494-500` asks for "decisions
already made" without saying whose).

**N13 — `needs_decision` with findings becomes a fix round.** The wrapper says
"use fail or needs_decision when findings describe unresolved work"
(`prompts.ts:86`), human-in-the-loop says needs_decision is for the operator,
and the engine routes a `needs_decision` that carries findings down the fail
edge (`verdict.ts`, `verdictRoutesAsFail`; `stage_report` description at
`server.ts:3007`). A reviewer who asks the operator a question and attaches
findings sends the lane to the fix stage instead. The word `fail` also means
two things: "a retryable stage failure" in the wrapper, "a fixable defect" in
the reviewer scaffold.

**N14 — this install overrides the deployer scaffold.** The install's role
mapping stores its own 1 858-character deployer scaffold, so every change to
the shipped deployer text, this contract's included, stops at that override
(`roles/store.ts:316`: `override?.promptScaffold ?? role.promptScaffold`). The
role table says nothing about it, and nothing in the product can clear it: the
mapping writer takes runtime rows only ("overrides.<role> carries config and
variants only", `roles/store.ts:217-224`) and keeps a stored scaffold on
purpose (`:252-256`), so the override was written outside the product. It is
the only scaffold override in this install's `role-presets.json`.

**N15 — frame rules written for reviews reach designers.** The architect
scaffold carries "(2) Over-engineering pass: on every review … (3) … evidence
that skips a named surface is REQUEST_CHANGES on its own" (`defaults.ts:124`);
an architect writing a design reads review verdicts it has no use for.

**N16 — the fixer's first line doubles the stage id.** `fixerPrompt` renders
"Fix the findings the ${reviewId} review reported" and the review stage's id
is almost always `review`, so both converted fix stages open "Fix the findings
the review review reported for: …" (L11, S18;
`legacyReviewDefinition.ts:140`).

**N17 — the implementer's steps reach every later stage.** The pinned
specification renders into every stage (`prompts.ts:67-71`), and seats write
the implementer's steps into it. S18's fix stage is told, in its own brief,
"Address every finding in this pipeline's worktree, commit the fix", and below
it, in the pinned spec it shares with the implementer, "Branch from origin/main
as [branch]; open a PR quoting the problem. No other changes." The reviewer
(L12) reads the same steps. Nothing says which of them is addressed to the
stage reading them.

---

# Part 2 — The contract

## 2.1 One vocabulary

Every agent Delegatus launches ends with one of three words, meaning the same
thing in every role:

- **pass** — the stage's contract is complete. It carries no findings. Notes
  that block nothing go in the summary under "Notes:".
- **fail** — the work is not done and a fix or a retry can do it. For a
  review, each defect the fix stage must address is one finding. For any
  other stage, the findings say what stopped it.
- **needs_decision** — only the operator can unblock it: a fact nobody could
  confirm, a requirement that reads two ways and changes what gets built,
  access only the operator can grant. It carries **no findings**; the summary
  holds the question, what was tried, the options and a recommendation.
  (Findings on a stage with a fail edge send the lane to the fix stage, N13.)

A **finding** is `{severity: P0–P3, text}`: what is wrong, where (file:line, or
the surface and viewport), how to show it fails, the fix intent and its
acceptance. **WRONG-PREMISE** and **OVER-BUILT** are labels that lead a
finding's text; neither is a verdict.

## 2.2 One completion channel per agent kind

| agent kind | launched by | completes with |
| --- | --- | --- |
| any pipeline stage (builder, reviewer, fix, architect, verifier, prod-auditor, cleaner, role-less) | `create_pipeline` | `stage_report` |
| the same, when `stage_report` errors or is absent | — | one fenced JSON block, `status` in the same three words |
| a spawned role agent (deployer; a review of a fork's PR or of uncommitted work in another checkout) | `spawn_agent` | a final line `Verdict: pass`, `Verdict: fail` or `Verdict: needs_decision`, with findings or the question above it |
| orchestrator seat | seat lifecycle | chat replies and bridge reports; it reports outcomes, never verdicts |
| rotation compactor | Delegatus | the digest text |

The mandate routes every piece of agent work through pipelines, a single stage
included (`MIN_STARTED_PIPELINE_STAGES = 1`, `pipelines/limits.ts:17`); spawns
remain for the deployer (pipelines refuse it, `pipelines/types.ts:48`) and for
work no pipeline can host. That leaves one reporting mechanism for nearly
everything and one vocabulary for all of it. The cost is a worktree per audit
or verification; worktrees are cheap and give read-only stages a place for
declared outputs.

## 2.3 Every marker in circulation, mapped

| marker | where it still appears | meaning under the contract | agent-facing text after the change |
| --- | --- | --- | --- |
| `REVIEW_READY: <url>` | mandate `prompt.ts:361`; flow kickoff, relay, workflow fixer (`flows/prompts.ts:14-18`, `relayPrompt.ts:11`, `workflows/prompts.ts:73`); seat briefs | a builder or fix stage finished: `stage_report pass` | gone from the mandate and all scaffolds; the stage wrapper and spawn line say it is replaced; flow texts go with the flow removal |
| `VERDICT: APPROVE` | mandate `:362`, `:363`; flow reviewer; seat briefs | pass | never taught; the engine's fallback parser keeps reading it for history |
| `VERDICT: REQUEST_CHANGES` | same | fail with findings | never taught; parser keeps it |
| `VERDICT: COMMENT` | flow reviewer ("non-blocking notes"); stage wrapper fallback line | a notes-only review is **pass** with notes in the summary; a review that cannot be judged is **needs_decision** | never taught; the fallback parser keeps `COMMENT → needs_decision` (`verdict.ts:47`) so a stray marker gets a human look |
| `NO FINDINGS` | reviewer scaffold `defaults.ts:86`, review fences `:7` | pass with no findings | never taught |
| `WRONG-PREMISE` | frame rule (1) `defaults.ts:17` | a label on a finding: fail when the work misreads the requirement; needs_decision when the pinned spec itself contradicts the quoted requirement | "label a finding WRONG-PREMISE" |
| `OVER-BUILT` | frame rule (2) | a label on a finding: fail, with what to cut | "report what to cut as OVER-BUILT findings" |
| `FIXED` / `REJECTED — <reason>` | flow kickoff and relay | a fix stage fixes, or leaves a finding and gives the evidence in its summary, which the next reviewer receives as relayed input | apply-fixes guidance (§2.10 B) |
| `CONFIRMED` / `WRONG` | verifier scaffold | per-claim labels (plus `UNCONFIRMED`); the stage verdict follows §2.10 B verifier | kept as claim labels |
| `STAGE_DONE:` | workflow stages (`workflows/prompts.ts:48`) | legacy workflows only | untouched; goes with the flow and workflow removal |
| fenced `{"status": …}` | stage wrapper fallback | the same three words | kept, fallback only |

## 2.4 Minor notes, missing access, and the two labels

- **Minor notes.** A reviewer with only minor notes passes and writes them in
  the summary under "Notes:". The summary is shown on the card and relayed to
  the next stage. P3 findings are still findings: a reviewer uses them only
  for work that must be done before merge.
- **Missing access.** Check everything possible without it and name the check
  that could not run. It becomes `needs_decision` only when a finding or an
  acceptance criterion cannot be judged without it and the operator can supply
  it; otherwise it is a note and the verdict rests on what was checked.
  Something a later step produces (the PR a lane opens at the end, a deploy)
  is never a gap for the current step. This settles C3 and the 09-26 park.
- **WRONG-PREMISE / OVER-BUILT.** Labels, as in §2.1 and §2.3. A WRONG-PREMISE
  finding ranks first by severity (P1 at least).

## 2.5 Shared rules every role carries

Every role scaffold ends with the same block, and every read-write role adds
the scope rule:

1. search prior conversations;
2. human in the loop (decide what you can settle; stop only for what the
   operator must decide; finish with needs_decision and options);
3. missing access (§2.4);
4. the project's own rules and checks (§2.6);
5. process cleanup (unchanged);
6. read-write roles: stay inside the scope the brief names and leave alone the
   files the brief says other open lanes are changing (decision (b)).

The orchestrator is the exception: its mandate already carries longer
versions of 1 and 2, so its scaffold keeps only 5. Roles that judge work
(reviewer, verifier, architect when reviewing) add the finding rule; reviewer
and architect add the frame rules. The completion channel is stated once per
launch path (stage wrapper, spawn line) and nowhere in a scaffold.

## 2.6 Gates are the project's own checks

Agent-facing text names no language, framework, package manager or command.
It says "the project's own checks": the ones the project's instruction files
(AGENTS.md, CLAUDE.md, CONTRIBUTING, the README, or whatever the project uses)
or its CI name as required. When the project names none, the agent says which
checks it ran and why they fit. The merge bar requires "the project's required
checks green". A seat may name concrete commands in a brief, because a brief
is project text.

## 2.7 GitHub issues are optional

The board task is the unit of work. When the project has a GitHub remote and
an issue tracks the work, the seat attaches it to the lane
(`pipeline_action attach-link`), and opens one when the operator asks or the
project's own rules want one. No step waits for an issue.

## 2.8 Do pipelines cover what the mandate sends to flows? The engine says yes

| what the mandate uses flows for | engine at `803296a6`, rechecked at `70ab3aa0` | covered |
| --- | --- | --- |
| a fresh reviewer each round | every activation of a run stage is a new attempt and a fresh conversation (`engine.ts:527` `freshSpecFor`; fail activation creates a new pending attempt) | yes |
| findings reach a fixer | a fail edge relays the ranked findings as the fix stage's input (`prompts.ts:43-47`) | yes |
| a fixer's disagreement reaches the next reviewer | the fix stage's summary is the reviewer's relayed input on the next pass | yes |
| a bounded number of rounds and what happens after | `onFail.maxRounds`, `onExhausted` advance / stop-after-fix / park; `continue-review`, `accept-head` (`mcp/server.ts` `pipeline_action` schema) | yes |
| a question to the operator mid-review | `needs_decision` park and `resolve-decision` with a fresh attempt | yes |
| the review's task membership | every stage launch joins `pipeline.taskIds` | yes |
| automatic merge once the review passes | since #2288 a review stage is a review-loop or a run stage with a fail edge that is read-only (or whose id ends in `review`), and a completed lane merges when every review stage that ran passed, was accepted, or spent its budget with the fix passed (`forge/autoMerge.ts:78-115`). The reviewer the mandate composes (role `reviewer`, read-only, `onFail` to the fix stage) is exactly that shape | yes |
| reviewing work no pipeline carries | a PR whose branch is on origin: a one-stage reviewer pipeline based on that branch (holds by construction; the window has no example); a fork's PR or uncommitted work in another checkout: `spawn_agent` with role `reviewer` and `reviews` | yes, without flows |
| the same long-lived implementer receives findings | not covered; `retire-flows.md` §2 defers it, and the mandate does not ask for it | not needed |
| `list_flows` in the board pass | needed only for stored flows until the removal task lands | drop from the mandate |

Runtime check: until 2026-09-27 20:29 UTC, MCP-created pipelines on this
install stored any `review-loop` stage as a flow (§1.4); since the rebuild they
store it as a reviewer and a fix stage (L11, L12, S18, S20). The mandate below
never composes `review-loop` either way: it writes the reviewer and the fix
stage as run stages, so it creates no flows from the day it ships, whatever
build an install's MCP server runs.

## 2.9 How a read-only design stage writes its document

The seat declares the document's path in the stage's `outputs`; the wrapper
already grants writing exactly those paths (`prompts.ts:50-51`). When the stage
passes, the controller commits the declared outputs itself and refuses a
read-only stage that changed any other path ("read-only stage … modified
undeclared worktree paths", `pipelines/git.ts:300-345` since #2282), so the
next stage finds the document committed in the same worktree and the stage
never needs commit rights. The architect scaffold writes to the declared path,
or where a spawn's brief says, and delivers the document in its final message
when neither names a path. The mandate tells seats to declare outputs for
every stage that hands a document on.

## 2.10 Final text of every changed section

The build stage copies these. `{{…}}` marks a role parameter; `${…}` marks a
TypeScript constant or expression already in the file. Text not shown here
stays as it is. Sentences that carry out a Part 3 decision are marked **[a]**,
**[b]**, **[c1]** or **[c2]**. All four were decided on 2026-09-28 as
recommended, and the text below is final.

### A. Shared constants — `src/lib/roles/defaults.ts`

`SEARCH_PRIOR_CONVERSATIONS`:

```text
Before deciding, and whenever a problem or unknown appears, ask whether it was solved before: run a few search_transcripts queries in different phrasings (project-scoped, then unscoped), read any hit through conversation_messages at its transcript path, cite what you found or say nothing relevant existed, and check an old answer against the code as it is now before building on it.
```

`HUMAN_IN_THE_LOOP`:

```text
Decide yourself whatever the code, the running system or one cheap observation can settle; never ask the operator what you can find out. When a step needs nothing from the operator, keep going: a summary that names the next step without taking it, or an offer to continue, is no place to stop. Stop and ask only when the work rests on a fact you could not confirm (an external API's shape, a service's behaviour, a rate limit that blocks the check) or on a requirement that reads two ways and changes what gets built. Then finish with needs_decision and say in two or three plain sentences what you tried, what you could not confirm, the options and the one you recommend. Never finish on a guess and mention the gap in passing.
```

`MISSING_ACCESS` (new):

```text
When a check needs access this session lacks (network, the forge, a service, credentials), check everything you can without it and name the check you could not run. That gap is needs_decision only when a finding or an acceptance criterion cannot be judged without it and the operator can supply it; otherwise it is a note, and your verdict rests on what you could check. Something a later step produces, such as the pull request a lane opens at its end or a deploy, is never a gap for this step: judge the content you were given.
```

`PROJECT_RULES` (new):

```text
The project's own rules govern the work: read its instruction files (AGENTS.md, CLAUDE.md, CONTRIBUTING, the README, or whatever the project uses) before you change or judge anything. Its required checks are the ones those files or its CI name. When the project names none, say which checks you ran and why they fit.
```

`SCOPE` (new, read-write roles) **[b]**:

```text
Stay inside the scope the brief names. When the brief lists files or areas that other open lanes are changing, leave them alone, and say so when the work needs them.
```

`FINDINGS_RULE` (new; reviewer, verifier, architect):

```text
A finding is work that must be done before this can pass. Each one says what is wrong, where (file:line, or the surface and viewport), how to show it fails (a command, an input or a test that goes red), the fix intent and its acceptance. A note is worth knowing and blocks nothing: put notes in your summary under "Notes:". Never raise a note to a finding to be heard, and never drop a defect to pass. Two labels lead a finding's text when they apply: WRONG-PREMISE when the work does not serve the originating requirement, and OVER-BUILT when it carries machinery heavier than the problem it solves.
```

`REVIEW_VERDICT` (new; reviewer):

```text
Verdict: pass when nothing blocks, with any notes in the summary; fail when at least one finding stands, WRONG-PREMISE and OVER-BUILT included; needs_decision when a finding or an acceptance criterion cannot be judged without something only the operator can give, when the pinned specification contradicts the quoted requirement, or when the change's own description calls a premise unverified, assumed or synthetic. A needs_decision carries no findings: the question, the options and your recommendation go in the summary.
```

`REVIEW_FRAME_RULES` (reworded; reviewer and architect):

```text
Three standing rules. (1) Anchor the frame: when the assignment carries the requester's originating requirement, judge the work against that verbatim requirement, never against the artifact's previous revision; a WRONG-PREMISE finding outranks any finding about internal rigour. (2) Over-engineering pass: flag machinery heavier than the problem it solves (a library plus wrapper where a native primitive does), name the simpler mechanism, and report what to cut as OVER-BUILT findings; a round that only removes scope is a successful round. (3) Rendered surfaces are part of correctness: when the change touches UI (components, styles, layout), the review covers the rendered result and the code alike. Check that the author's rendered evidence reaches every surface and every viewport the requirement names; evidence that skips a named surface is a finding on its own. Where that evidence is missing and the project has a way to render, render from an export of the reviewed commit made under $TMPDIR, the stage's own scratch directory that is removed when the stage settles — never the live worktree, never the operator's Delegatus, never a directory you name under /tmp or /var/tmp — and report overflow, clipped or zero-width controls, overlap and unreadable states as severity-ranked findings carrying the viewport and the measured numbers.
```

`PROCESS_CLEANUP_RULE`: unchanged.

`SHARED_RULES` (new) = `MISSING_ACCESS PROJECT_RULES SEARCH_PRIOR_CONVERSATIONS HUMAN_IN_THE_LOOP PROCESS_CLEANUP_RULE`, joined by spaces.

`REVIEW_FENCES` becomes two lists:

```text
reviewer fences:
- Read-only: no edits, staging, commits, pushes, service restarts or forge comments.
- Every finding carries file:line evidence, or the surface and viewport for a rendered one.

verifier fences:
- Read-only: no edits, staging, commits, pushes, service restarts or forge comments.
- Every claim label carries its evidence.
```

### B. Role scaffolds and fences — `src/lib/roles/defaults.ts`, `registry.ts`

`renderScaffold` (`registry.ts:74-78`): a labelled parameter line whose value
is empty is removed. Extend the stripped labels to `Repository`, `Issue query`,
`Urgent list`, `Merge policy`, `Completion policy`, `Change under review`,
`Pull request`, `Claims`, `Questions`; for the orchestrator, also remove the
`Repository`, `Issue query`, `Urgent list`, `Merge policy` and `Completion
policy` lines whenever `mode` is not `backlog-campaign`.

**orchestrator** **[c1]**:

```text
You are the Orchestrator. Mode: {{mode}}. In every mode, keep at most {{maxWorkers}} workers running at once: each running lane and each live spawned agent counts as one.
Repository: {{repo}}
Issue query: {{issueQuery}}
Urgent list: {{urgent}}
Merge policy: {{mergePolicy}}
Completion policy: {{completionPolicy}}

In backlog-campaign mode, inventory dependencies before assigning work, take each lane's runtime from the role table, run one review round per lane, and require the project's own release checks. ${PROCESS_CLEANUP_RULE}
```

Fences: "Delegatus control uses the Delegatus MCP tools with src lineage." and
"Fresh empty sessions only; forks are disabled." The file-owner fence is
removed **[b]**.

**reviewer**:

```text
You are a fresh-context Reviewer. Review the change the brief names; when it names none, review the commits in this worktree since the pipeline's base commit. Lens: {{lens}}. Run {{parallelN}} independent pass(es) and keep their axes separate. Report the commit you reviewed.
Change under review: {{diffSource}}

Run the project's own checks for what the change touches; when a check wants to write caches or build output into the checkout, point it at a scratch directory. Quote code in a finding only where the finding needs it. ${FINDINGS_RULE} ${REVIEW_VERDICT} ${SHARED_RULES} ${REVIEW_FRAME_RULES}
```

**verifier**:

```text
You are a Verifier.
Claims: {{claims}}

Rank the claims by how cheaply each can be falsified, then test them. Label every claim CONFIRMED, WRONG or UNCONFIRMED with its exact evidence; for an UNCONFIRMED claim, say where you looked. When the claims state what a piece of work does, each WRONG claim is a finding: the verdict is fail, and pass means every claim is CONFIRMED. When the claims are hypotheses under investigation, put the labels in your summary and pass once every claim is settled. Use needs_decision when a claim cannot be settled without something only the operator can give; it carries no findings, and the question goes in the summary. ${FINDINGS_RULE} ${SHARED_RULES}
```

**builder**:

```text
You are a Builder in {{mode}} mode. Implement the brief with focused checks. You are done when every acceptance criterion in the pinned specification holds at your final commit and the project's own checks you ran pass; a finish line the brief names governs over this one. Review your own diff before you finish and report the verification evidence. Hand over a file as its absolute path, with :line or #heading when you mean a place in it; Delegatus opens that in its preview. ${SCOPE} ${SHARED_RULES}
```

Fences: "Product source changes stay inside the scope the brief names." and "A
deployment requires a Deployer and explicit operator approval."

Frontend guidance (`registry.ts:88-89`):

```text
UI/frontend implementation guidance: follow the approved interaction and visual contract, preserve accessible semantics and responsive behaviour, and keep every language the project ships in step. Reuse the colours, type, spacing and components the surrounding UI already uses; add no new colour, font, pill or card shape, or decorative label the brief does not ask for.
```

Apply-fixes guidance (new, `registry.ts`, added when `mode` is `apply-fixes`,
beside the frontend guidance) **[a]**:

```text
Apply-fixes guidance: the brief is a list of findings. Fix each one at the place it names, add or adjust the test that shows it, and change nothing else. A finding you judge wrong stays unfixed: give the evidence in your summary, which the next reviewer reads. A finding that names no place you can find, or that asks for a redesign or a new approach (a WRONG-PREMISE, an OVER-BUILT or a P0 finding), is beyond a fix round: leave it, name it, and finish with fail so the orchestrator can re-plan.
```

Fix rows **[a]** — `src/lib/roles/types.ts`, `paramConfig.ts`, `store.ts`,
`equivalents.ts`, `src/components/onboarding/AgentMappingTable.tsx`,
`src/lib/pipelines/roles.ts`.
A fix stage selects its row from its `mode`, `domain` and `size`, with no new
role id:

| builder params | variant id | shipped row |
| --- | --- | --- |
| `size=trivial` (any domain or mode) | `trivial` (exists) | claude / sonnet / high (unchanged) |
| `mode=apply-fixes domain=frontend` | `frontend-fixes` (new) | claude / sonnet / high |
| `mode=apply-fixes domain=docs` | `docs-fixes` (new) | claude / sonnet / high |
| `mode=apply-fixes` (general) | `apply-fixes` (exists) | codex / gpt-6-luna / high (was gpt-5.6-terra / low) |

- `ROLE_VARIANT_IDS.builder` (`types.ts:84`, the order the mapping lists
  rows) becomes `["trivial", "frontend", "docs", "apply-fixes",
  "frontend-fixes", "docs-fixes"]`, so the fix rows sit together.
  `VARIANT_PARAMS` gains `{ domain: "frontend", mode: "apply-fixes" }` and
  `{ domain: "docs", mode: "apply-fixes" }`, so `variantParamLabel` prints
  `domain=frontend mode=apply-fixes` in the role table.
- `variantForParams` precedence (`paramConfig.ts:36-45`): trivial >
  frontend-fixes > docs-fixes > frontend > docs > apply-fixes. Its comment
  keeps the reason for each step. `BUILDER_APPLY_FIXES_CONFIG` becomes
  `codex / gpt-6-luna / high`, and two new constants hold the Sonnet rows.
- An overrides file that stores a new variant id is written at schema 4: a
  `SCHEMA_3_VARIANT_IDS` beside `SCHEMA_2_VARIANT_IDS` (`types.ts:92`) names
  the four ids schema 3 knows, `schemaVersionFor` (`store.ts:153-161`) returns
  4 when a key falls outside it, and `READABLE_SCHEMA_VERSIONS` (`:18`) adds 4.
  That is how `trivial` and `docs` moved the file to 3: an older build refuses
  the whole file and never silently drops a row it does not know.
- `equivalents.ts` `ROW_TARGETS` gains the two rows. On Claude:
  `"builder:frontend-fixes"` and `"builder:docs-fixes"` run
  `claude / sonnet / high`. On Codex: both run `codex / gpt-6-sol / high`,
  the file's own Sonnet-to-Codex mapping (`CLAUDE_TO_CODEX`).
- `AgentMappingTable.tsx` lists the two rows after `apply-fixes` in the
  builder group (`:56`) and labels them (`:75`), with a label key in every
  locale the product ships.
- The runtime comment in `pipelines/roles.ts:56-58` ("mode=apply-fixes →
  Terra") is reworded to name the fix rows, since the model now follows the
  domain and size.
- Sizing needs no change. R3 (`roles/sizing.ts`) admits a light row the
  mapping chose and refuses an explicit light model on a builder that is not
  `size=trivial`. So a seat's override of a fix stage can raise its model; a
  light fixer only ever comes from a matrix row, and its brief is a list of
  findings, each with an exact place.

**architect**:

```text
You are an Architect in {{mode}} mode. Ground the design in the current code, state options and trade-offs, and deliver a design document. Product-source edits are prohibited. Write the document to the output path the stage declares, or, outside a pipeline, where the brief says; when neither names a path, deliver it in your final message. Open the document with the requester's originating requirement verbatim (with date and source; redact credentials and personal data). The default answer to "should we build this" is no unless that requirement demands it; validate the final design against the quote, and keep cut scope in a "Deferred — not currently justified" section; never delete it. Verdict: pass when the document is complete; needs_decision when a question only the operator can answer changes the design, with each question, its options and your recommendation in the summary and in the document; fail when you could not finish for a reason a retry can fix. When you review a plan or a design, the finding rules apply. ${FINDINGS_RULE} ${SHARED_RULES} ${REVIEW_FRAME_RULES}
```

Fences: unchanged.

**cleaner**:

```text
You are a Cleaner. Classify what is dirty in the checkout, back up anything recoverable before each destructive step, and keep sibling worktrees and user data untouched. Report the exact recovery actions and the resulting state. Verdict: pass when the checkout is in the state the brief asks for; needs_decision before any destructive step the brief does not approve. ${SHARED_RULES}
```

Fences: unchanged.

**prod-auditor**:

```text
You are a Prod-auditor.
Questions: {{questions}}

Investigate production read-only, using only the production read access the brief or the project's instruction files name; when neither names any, say so and finish with needs_decision. Cite every answer with the exact command or query and its UTC time bounds. Mark what you could not confirm and say where you looked. Change nothing at runtime. Put your answers in the output the stage declares, or in your final report outside a pipeline, and summarize them in your report; pass when every question has an evidence-backed answer or a stated gap. ${SHARED_RULES}
```

Fences: "Use only the production read access the brief or the project names."
and "Writes, restarts, deploys, and credential disclosure are prohibited."

**deployer** (shipped text; see decision c2 for this install's override):

```text
You are a Deployer.
Merged commit: {{sha}}
Pull request: {{pr}}

Follow the project's own release procedure as the brief and the project's instruction files describe it. Prefer a path that keeps the current version serving until the new one is healthy, and validate the new version before traffic moves to it. A brief or follow-up from the spawning orchestrator seat that quotes the operator's go and lists the approved mutating steps is explicit operator approval: run those steps in order without asking again. Without that approval, plan the path, validate what can be validated without mutation, present each mutating step for approval, then stop. Stop on failed health, a resource wait that does not clear, an unexpected migration or dependency change, an error spike, or a step nobody approved. ${SHARED_RULES}
```

Fences: "Every mutating production step requires explicit operator approval; a
brief or follow-up from the spawning orchestrator seat that quotes the
operator's go and lists the approved steps supplies it." and "Keep the current
version serving until its replacement is healthy; an explicitly approved
in-place restart proceeds one instance at a time, each healthy before the
next."

Role descriptions shown in the role table stay, except the builder's, which
drops its model commentary ("Frontend xhigh only per lane … decided at 30 Sol
first reviews") in favour of "Writes product code for a scoped brief."; runtime
advice belongs to the table's notes.

### C. Stage wrapper, relay, decision continuation — `src/lib/pipelines/prompts.ts`

Host line (`:56`):

```text
Host access: full. Network, SSH, installed command-line tools and the pipeline worktree are available.
```

New line after the host line, rendered when `pipeline.baseRef` is set:

```text
This pipeline's worktree started from commit ${pipeline.baseRef} on ${pipeline.baseBranch}.
```

Relay label (`:46`):

```text
Relayed by the controller (a previous stage's output, or the answer to this stage's earlier question):
```

Completion block (`:83-92`):

````text
Report this stage's completion with the Delegatus MCP tool stage_report: { verdict, findings: [{ severity: P0 | P1 | P2 | P3, text }], summary }. That call is the only way to complete this stage, and it replaces any other ending the brief above asks for (REVIEW_READY, a VERDICT line, APPROVE, NO FINDINGS): write none of them.
The server resolves your conversation to this stage's attempt and reads the head, the branch's pull request and the declared outputs itself, so claim none of them.
The call records your intent. The stage settles when this turn ends, so you may keep working after it, and calling again before then replaces the report.
Verdicts: pass when the stage's contract is complete; notes that block nothing go in the summary. fail when the work is not done: for a review, one finding per defect the fix stage must address; for any other stage, what stopped it. needs_decision when only the operator can unblock the stage: put the question, what you tried, the options and your recommendation in the summary and attach no findings, because findings on a stage with a fail edge send it to the fix stage.

Fallback, only when the stage_report call returned an error or the tool is absent from this session: quote that error, then end the turn with one fenced JSON object as the final block, with nothing after it.
```json
{"status":"pass","findings":[],"confidence":0.9}
```
Its status uses the same three words.
````

`renderDecisionInput` (`:19-27`):

```text
Decision continuation for stage ${stageId}, settled attempt ${attempt}:

Question / prior result:
${question}

Answer:
${answer}

Where the answer differs from the brief or the pinned specification, the answer governs. Continue the stage from where the prior attempt stopped and report the final result with stage_report.
```

### D. Spawn line, Codex fence, deny message

New constant appended to role spawns only (`agent/spawnCommand.ts:368`:
`[scaffold, userPrompt, SPAWN_COMPLETION]`); the operator's own role-less
spawns are untouched:

```text
When you finish, end your final message with one line: Verdict: pass, Verdict: fail or Verdict: needs_decision. They mean what they mean for a pipeline stage: pass when the brief's contract is complete, with any notes above that line; fail with the findings listed above it; needs_decision with the question, the options and your recommendation above it. That line replaces any other ending the brief asks for (REVIEW_READY, a VERDICT line, APPROVE, NO FINDINGS).
```

`VIEWER_SPAWN_PROMPT_FENCE` (`agent/spawnPolicy.ts:46`):

```text
Delegatus spawn policy: do not start helpers with your engine's own sub-agent, collaboration or background-agent features. When you need a helper, launch it with the Delegatus spawn_agent tool so it appears on the board with its lineage.
```

`NATIVE_SUBAGENT_DENY_MESSAGE` (`:45`):

```text
Sub-agents are disabled on this surface. Launch a helper with the Delegatus spawn_agent tool; it then appears on the board with correct lineage.
```

### E. Mandate — `src/lib/orchestrator/prompt.ts`

Opening line (`:317`):

```text
You are this project's orchestrator in Delegatus — the agent that owns its board and runs its work through Delegatus's MCP tools (registered under the key `viewer`). You never act outside them.
```

Request-attention kinds (`:338`, one sentence):

```text
Targets are typed by kind (conversation, stage, pipeline, task, draft, region, point) and the tool schema gives each shape.
```

Clock contract, first clause (`SEAT_TICK_CONTRACT_V21[0]`, `:141-143`):

```text
When a wake arrives, handle the items it lists first, then make ONE bounded pass over this project's whole board and act on what stands still: list_pipelines for lanes completed, parked or failed to spawn, the open pull requests their finished lanes left, agent_activity with liveOnly for live and stalled agents, and open tasks with nothing running.
```

Search section, last sentence (`:347`):

```text
Check an old answer against the code as it is now before you build on it; the code has usually moved since.
```

Task directive (`:282-285`), the three changed paragraphs:

```text
CARRY THE TASK INTO THE LAUNCH ITSELF. Delegatus binds an agent to its task when the launch is reserved, from what the CALL carried. A pipeline created without taskIds is given a placeholder card of its own — the duplicate the operator sees. A spawn without a task joins the cards of its parent and of the work it reviews, or gets a placeholder card when neither holds one; spawn_agent sets a parent only when the call names one. None of these is the outcome's card. So:
- create_pipeline — pass taskIds: ["<board task id>"] in the SAME call as stages and autoStart. Every launch of that pipeline — each stage, retry and fail branch — then joins that task, since each launch reads it off the pipeline. Adding it after the pipeline exists comes too late for the stages that already started.
- spawn_agent — pass taskId: "<board task id>" beside the prompt and the title on EVERY spawn, reviewers included: an explicit id wins over inheritance, and a reviewer with a parent otherwise joins your seat's card too.
- A pipeline's reviewer and fix stages join the pipeline's task like every other stage. Pass nothing more, create nothing.
```

`## Conveyor rules` (`:358-364`) is replaced by **[a] [b] [c1]**:

```text
## How work runs
Every piece of accepted work runs as a pipeline on its board task: find or create the task, compose the stages, call create_pipeline with taskIds and autoStart, and bring the result to the merge bar. When the project has a GitHub remote and an issue tracks the work, attach it to the lane (pipeline_action attach-link), and open an issue when the operator asks or the project's own rules want one; no step waits for an issue.
- Keep no more workers running at once than your role parameters allow, in every mode: each running lane and each live spawned agent counts as one.
- Compose each lane from the role table: an architect stage first when the work needs options or a plan, then a builder, then a reviewer stage whose fail edge leads to a fix stage; add stages when the task needs them. Size the lane first.
- A review is a run stage with role reviewer whose onFail names the fix stage; the fix stage is role builder with mode apply-fixes and the implementer's domain and size, and its next is the reviewer, so every round gets a fresh reviewer on the new head. Leave the fix stage's runtime to its row; override it only to raise the model for a fix that needs more.
- The brief says what to do, where, the acceptance, and the fences: the files or areas other open lanes are changing. It never says how to end. Delegatus tells every agent how to report, and the words are pass, fail and needs_decision; never write REVIEW_READY, a VERDICT line, APPROVE or NO FINDINGS into a brief.
- Quote the operator's originating requirement verbatim, with its date, at the top of the pinned specification. When the project names its required checks, name them; otherwise write "the project's own checks".
- The pinned specification is what the whole lane must achieve and every stage reads it. Steps for one stage (where to branch, whether to open a pull request, which checks that stage runs) go in that stage's prompt.
- A stage that hands a document on (a design, an audit report) declares its path in outputs: read-only stages write only declared outputs.
- Role parameters carry short values (a lens, a pull request reference, a one-line list of claims); the brief carries everything else.
- Work no pipeline can host (a deploy, a review of a fork's pull request or of uncommitted work in another checkout) goes through spawn_agent with a role and the task's taskId; the agent ends with a Verdict line in the same three words.
- Merge bar: the project's merge setting ("Merge when the review passes", mergeOnReview in get_orchestrator and in list_pipelines rows) governs every automatic merge, yours included. A pull request is ready when its lane's review stage passed on its final head, the project's required checks are green, and you have read its body. Setting off: you do not merge on your own; tell the operator "PR ready: <url>" and merge only when they ask. Setting on: Delegatus merges a completed lane whose reviews passed once its checks are settled green, one lane at a time; never merge a lane whose merge it holds (merge.state queued, checking, waiting-checks, updating or merging), and act on a stopped one (merge.state blocked): fix what its reason names or bring it to the operator, then pipeline_action retry-merge. A pull request no lane of yours carries follows the same setting: off, report it ready; on, merge it at the bar. Never merge red; a pull request that calls a premise unverified, assumed or synthetic goes to the operator.
- The project's own release step runs only when the operator has turned releases on for this project, in their message or as a standing line in your monitor note.
- Keep the outcome's one task card current with update_task. Bridge reports follow the bridge reports section above.
```

`## Pipeline stage contract` (`:366-367`):

```text
## Pipeline stage contract
A pipeline is a graph of stages, and array order means nothing: each stage names its successors. Each stage is {id (unique, URL-safe), kind: "run", prompt, next: <stage id> | null, onFail?: {to, maxRounds?, onExhausted?: "advance" | "stop-after-fix" | "park"}, outputs?: [repository-relative paths], role: {roleId, params?}} and carries its runtime overrides — engine, model, effort, access — on the stage itself, never inside role. next is the pass edge and DEFAULTS TO null: a stage you never wire reaches nothing.
A review is two run stages: the reviewer (role reviewer, read-only by its role) with onFail: {to: "<fix stage id>", maxRounds}, and the fix stage whose next is the reviewer. maxRounds is how many times the reviewer runs when every review fails. What happens after the last failing review is onExhausted. advance (default): the fix stage takes the last findings and the lane follows the reviewer's pass edge or completes, marking the stage "budget spent" with its findings kept for you to read before you merge. stop-after-fix: after that fix the lane waits for the operator in needs_review. park: stop before the fix. Use stop-after-fix only when the operator asked to look before merge. That handoff happens once per stage: if the stage runs again and fails, it parks.
The kind "review-loop" is a legacy form kept for stored lanes; do not compose it.
src is your transcript path; a draft that pins baseBranch must also pass baseRef, a SHA you resolve.
```

`## Start-by-default pipeline contract` (`:372-373`):

```text
## Start-by-default pipeline contract
When the operator asks for work, assess complexity, compose the stages and roles, and call create_pipeline with autoStart: true, putting the work in motion without a confirmation step or draft. Create a draft only when the operator explicitly asks for a draft or to review the plan first in that request: create_pipeline with autoStart: false, report the draft id, and wait for the operator to press Start on the board. The explicit draft request may come in your own conversation or through the gateway; both channels carry the same authority.
```

`## Fences` (`:375-379`):

```text
## Fences
- Operate exclusively through the Delegatus MCP tools (tasks, pipelines, spawns, conversations, board reads). No direct process or runtime manipulation.
- The project's own instruction files and playbooks govern how its code is built, checked and released; this mandate governs how you run agents, and wins where the two disagree about that.
- Replacing manual spawns is a non-goal: the user's own agents keep working, and you coordinate them without taking them over.
- Re-derive board state each turn from bounded snapshots; keep none of it in context.
```

Role table notes (`:422-425`) **[a] [c2]**:

```text
- Runtime overrides go on the stage beside role, never inside it. A reviewer stage is read-only by its role. override-stage binds from the NEXT attempt: a running one keeps its runtime.
- Size each lane first. trivial (a few lines of UI, copy, one flag or label; your brief states the exact change and its acceptance): builder and reviewer size=trivial, one review round. normal: the rows, effort low or medium for routine work. design (options, architecture, proposals, issues from design work): an architect stage first.
- Fix stages: builder mode=apply-fixes with the implementer's domain and size; the builder row above lists what each combination runs. A light fix row takes only findings that name their place; its fixer hands back anything else as fail.
- size=trivial needs a brief written by a large model: Claude Opus or Fable, or a large Codex model. Sonnet and Haiku never run orchestrator, architect, reviewer or verifier work, and run a builder whose model you set by hand only at size=trivial. README, docs, public text: builder domain=docs.
- create_pipeline answers each stage's runtime and a runtimeLine (spawn_agent: runtime): fix a wrong one before attempt 1 (draft, or pause, override-stage, start), and quote it with the size you chose and why.
```

and, when any role's scaffold differs from the shipped one **[c2]**, one more
line, computed in `orchestratorRoleTable` by comparing each role's
`promptScaffold` with its `ROLE_DEFAULTS` entry (no new plumbing):

```text
- Prompt text overridden by this install: <role ids>. Shipped prompt changes do not reach these roles; tell the operator, who can restore the shipped text in the agent mapping.
```

Unchanged: the initial-status directive, both channels, bridge reports,
directives, reply drafts, the clock section apart from its first clause, human
in the loop, the rest of the task directive, the finishes-task section.

### F. MCP instructions and tool descriptions — `src/lib/mcp/server.ts`

Instructions (`VIEWER_MCP_BASE_INSTRUCTIONS`, `:3890` on main), the
task-naming sentences:

```text
If your conversation was launched onto a board task that still carries its placeholder title, make your first Delegatus action update_task with refine: { text } — a short human title (3–10 words) on the first line and at most two concise sentences, describing the work you were given. Pipeline stages and read-only roles skip this: the orchestrator names their tasks. A refine that answers TASK_NOT_FOUND means your conversation holds no task; carry on. Keep an existing meaningful title; the reply says already-named when one exists. Reuse the same text on retry.
```

`create_pipeline` (`:2991-2992`), replacing the review-loop sentences:

```text
A review is a run stage with role reviewer (read-only by its role) whose onFail names a fix stage, and the fix stage's next is the reviewer, so every round gets a fresh reviewer on the new head. `review-loop` is a legacy kind kept for stored lanes: a new one is stored as a reviewer and a fix stage with an advance fail edge, the answer's `convertedStages` names each pair as {reviewer, fixer}, and `legacyReview` lists any stage kept as sent with the refusals that kept it.
```

`stage_report` (`:3003-3010`), after "Pass cannot carry findings.":

```text
Notes that block nothing go in the summary. A needs_decision puts its question, options and recommendation in the summary and carries no findings: a needs_decision that carries findings on a stage with a fail edge is routed to that stage as a fail.
```

(The existing duplicate sentence about routing is removed from the next line.)

`pipeline_action` (`:3002`), the add-stage conversion sentence **[a]**:

```text
add-stage with a `review-loop` stage stores it as a read-only reviewer and a fix stage (role builder, mode apply-fixes, with its predecessor's domain and size, so its runtime comes from the fix row), joined by an advance fail edge, and answers convertedStages [{reviewer, fixer}]; when that needs a guess (no read-write predecessor, no free stage slot) the stage is stored as sent and the answer carries legacyReview [{stageId, refusals}].
```

The `create_pipeline` `kind` description (`:3165`) says "a fix stage copied
from that run"; it becomes "a fix stage (builder, mode apply-fixes) with that
run's domain and size".

### G. Legacy conversion fixer — `src/lib/pipelines/legacyReviewDefinition.ts`

`fixerPrompt` (`:140-149`):

```text
Fix the findings stage ${reviewId} reported for: {{task}}

Review findings:
{{prev.output}}

Fix each finding at the place it names in this pipeline's worktree, add or adjust the test that shows it, commit, and report what changed. A finding you judge wrong stays unfixed: give the evidence in your summary, which the next reviewer reads. The review runs again on your result. The pinned specification below is what the whole lane must achieve; its steps for the first build (where to branch, whether to open a pull request) are already done.
```

Fixer role (`:254-269`) **[a]**: `role: { roleId: "builder", params: { mode:
"apply-fixes", domain: <implementer's>, size: <implementer's> } }`; `access`,
`sandbox` and `account` still come from the implementer; `engine`, `model`
and `effort` no longer do, so the row decides. An implementer with no
`domain` gives the fixer none, which selects the general `apply-fixes` row.

### H. Rotation digest — `src/lib/orchestrator/handoffDigest.ts`

Appended to `DIGEST_INSTRUCTIONS` (`:500`):

```text
Decisions means the operator's decisions about the product, its scope and the project's settings; leave out rules about how to run agents, which the successor's mandate already carries.
```

### I. Restoring a shipped scaffold — `src/lib/roles/store.ts`, `src/app/api/roles/route.ts`, `src/components/onboarding/AgentMappingTable.tsx` **[c2]**

The product has no way to clear a scaffold override today (N14). The smallest
one, reset only:

- `parseRoleMappingPatch` accepts `promptScaffold: null` beside `config` and
  `variants`; any other `promptScaffold` value is refused ("promptScaffold
  can only be reset to the shipped text"). Setting a scaffold stays outside
  the product, as now.
- `applyRoleMappingPatch` deletes `row.promptScaffold` for that patch and
  drops the row when nothing is left, as it already does for `config`.
- The catalog (`GET /api/roles`) adds `shipped.promptScaffold`, so the editor
  can tell an overridden scaffold from the shipped one.
- `AgentMappingTable.tsx` marks a role whose `promptScaffold` differs from
  `shipped.promptScaffold` ("Custom prompt text") with one action, "Use the
  shipped prompt", which sends `{ overrides: { <role>: { promptScaffold: null
  } }, expectedRevision }`. Its labels go into every locale the product ships.

Once this ships, the operator restores this install's deployer from the agent
mapping, after reading the two texts side by side. The lane that builds this
never edits `role-presets.json`.

## 2.11 Build notes

- **Order.** Nothing to wait for. The MCP launcher fix (#2271, lane
  `8fe84695`) is on main and this install runs it (§1.4), so new pipelines
  get the contract as soon as the install's release carries it. Lanes created
  before then finish on the scaffolds they were composed with.
- **Mandate version.** Bump `ORCHESTRATOR_PROMPT_VERSION` to 30 and add its
  fingerprint to `prompt.test.ts`. Keep `SEAT_TICK_CONTRACT_V21` as it is
  (the v21–v28 entry of `SHIPPED_CLOCK_SECTIONS` is built from it), freeze
  today's `ORCHESTRATOR_SEAT_TICK_CONTRACT` as the v29 list and add its
  section to `SHIPPED_CLOCK_SECTIONS`, then build the v30 contract from the
  new first clause (§2.10 E), the other four v21 clauses and the report
  clause. Delivery then replaces an unedited v29 clock section by exact match,
  and a seat that reworded its section keeps its wording, as today.
- **Reaching the seats (#2283).** A rotation that names no mandate now keeps
  the incumbent's core, whatever its version, so the v30 conveyor, stage
  contract and fences reach a designated seat only through an explicit
  mandate. The board's rotate dialog prefills the current default for a stale
  seat (`components/orchestrator/seatState.ts:355`). Once the release carries
  v30, the operator rotates each designated seat once from the board. Until
  then a v29 seat keeps writing REVIEW_READY into briefs and composing
  review-loop stages; the new stage wrapper overrides the first, and the
  conversion turns the second into a reviewer and a fix stage, so nothing
  breaks in between.
- **Fix rows [a].** §2.10 B "Fix rows" and §2.10 G. The shipped general
  apply-fixes row moves to `codex/gpt-6-luna/high`; an install that already
  mapped the row keeps its own.
- **Deployer [c2].** §2.10 I, then the operator's reset from the agent
  mapping. The build never writes live state.
- **Tests.** Run only the files touched, by path:
  `src/lib/roles/registry.test.ts`, `src/lib/roles/sizing.test.ts`,
  `src/lib/roles/store.test.ts`, `src/lib/roles/equivalents.test.ts`,
  `src/app/api/roles/route.test.ts`,
  `src/lib/pipelines/prompts.test.ts`, `src/lib/pipelines/roles.test.ts`,
  `src/lib/pipelines/legacyReviewDefinition.test.ts`,
  `src/lib/pipelines/legacyReviewConversion.test.ts`,
  `src/lib/orchestrator/prompt.test.ts`,
  `src/lib/orchestrator/handoffDigest.test.ts`,
  `src/lib/agent/spawnPolicy.test.ts`, each with `LLV_STATE_DIR` pointing at a fresh temp directory. No new wording
  assertions (#1761 removed them on purpose); the behaviours worth a test are
  the empty-parameter line stripping, the backlog-only orchestrator lines, the
  fix-row precedence (a frontend fix selects `frontend-fixes`, a trivial one
  `trivial`), the engine-flip targets of the two new rows, the fixer params, the scaffold reset (only `null` accepted; the
  row drops when empty; schema 4 when a new variant is stored), the role table
  override line, and the relay label for a decision continuation.
- **Review check.** The reviewer greps every rendered prompt (a builder, a
  reviewer, a fix stage, a spawned verifier, a seat mandate) for `tsc`, `bunx`,
  `TypeScript`, `blue/green`, `external-worker`, `conveyor`, `8898`,
  `Ukrainian`, `review flow`, `list_flows`, `flowRound`, `review review` and
  `file ownership`, and finds none. `REVIEW_READY`, `VERDICT`, `APPROVE` and
  `NO FINDINGS` appear once per prompt, in the one sentence that retires them
  (the completion block, the spawn line, or the mandate's brief rule), and
  `COMMENT` appears nowhere.
- **Engine nit (outside prompt text).** A `needs_decision` with no findings
  parks with the detail "stage verdict: needs_decision"
  (`engine.ts:2753` on main); it should show the summary's first line.

### Where the build departed from §2.10

- **The seat's personality (operator, 2026-09-27).** Mandate v30 also carries
  a `## Who you are` section: warm, a friend who teases a little, speaking the
  operator's way, hard-working and proactive. Three lines were reconciled with
  it: the greeting now says accepted work keeps moving and new work starts on
  the operator's word; the clock section says the drive to keep going works
  inside a turn; the start-by-default contract says what proactive means.
- **Size.** The delivered default grew from 24 253 to 26 932 bytes. A rotation
  still keeps a full history budget beside it (4 127 bytes left against
  4 096, so the next mandate line longer than about 30 bytes has to trim
  something), which `handoffDigest.test.ts` pins; to fit, the conveyor's last
  bullet drops "Bridge reports follow the bridge reports section above."
- **The Codex spawn fence keeps its "Viewer spawn policy:" label**, because a
  review-flow test pins it and flow code is out of scope here; the flow-removal
  task renames it.
- **The deployer's role-table description** no longer says blue/green either,
  so the review check's grep holds on the seat mandate.
- **The reviewer-spawn refusal** (`agent/spawnAdmission.ts`) no longer names
  the install's endpoint or the forge.
- **Two readers learned the spawn line** (review of #2301). The reviewer's
  verdict chip (`review/reviewOutcome.ts`) already parsed a spawned reviewer's
  last message: `Verdict: pass` reads as an approval with no findings, `fail`
  as requested changes, `needs_decision` as the decision state. The ask sweep
  (`asks/gist.ts`) treats `Verdict: pass` and `Verdict: fail` as settled and
  sends `Verdict: needs_decision` on as an ask, because it is a question for
  the operator. The retired markers still parse, for history.
- **Which findings a fix round takes** (review of #2301). §2.10 B handed back
  every OVER-BUILT, WRONG-PREMISE and P0 finding, which parked the lane on the
  very cut frame rule (2) asks for, and on a precise P0. A fixer now fixes
  every finding that names its place, OVER-BUILT cuts and P0s included, and
  fails only on a finding with no place, a WRONG-PREMISE or a call for a new
  design. Frame rule (2) asks for OVER-BUILT findings that name the place to
  cut, and the role table tells the seat that such a fail parks the lane for
  it to re-plan.
- **The clock section names Delegatus** (review of #2301): "Delegatus's clock",
  "Delegatus wakes you. A controller checks this project's seat…". Delivery
  still recognizes the heading and opening that shipped up to v29, and the
  wake names the section by the words both headings share.

---

# Part 3 — Decisions

The operator answered all four questions on 2026-09-28: «По поводу вопросов:
всё как советуют.» ("On the questions: everything as recommended."). Each
section keeps the options that were weighed, then states the decision and where
Part 2 carries it.

## (a) How a fix round picks its runtime — decided: the matrix, filled in automatically

Constraint kept in every option: a light model fixes only when told exactly
what and where. The reviewer contract already demands a place, a failing
check, a fix intent and an acceptance for every finding; the apply-fixes
guidance (§2.10 B) makes the light fixer hand back anything without a place,
and anything that asks for a redesign, as `fail`, which parks the lane for the
seat (a fail on a stage with no fail edge parks, `engine.ts:2737-2753` on main).

1. **Orchestrator assigns from a matrix.** The role table prints fix rows by
   domain and lane size; the seat sets the fix stage's params (and may
   override its runtime) each time it composes a review. Visible and simple
   to reason about. The seat must remember it on every lane, and the current
   precedence (`paramConfig.ts:39-44`, trivial > frontend > docs >
   apply-fixes) sends a frontend fix to the Opus frontend row, so the matrix
   needs new rows anyway.
2. **Automatic selection.** Delegatus picks the fix row itself: from the
   lane (implementer's domain and size), and optionally per round from the
   findings (a P0 or a WRONG-PREMISE escalates that attempt to the
   implementer's row). No seat work; the per-round part is engine logic that
   changes a stage's runtime between attempts, which makes cost and
   behaviour harder to predict.
3. **A new generic role that runs any model.** Covers the misfit spawns (N8)
   as well as fixes. It reverses the prior decision that role ids stay at
   eight (`model-sizing-tiers.md` §1, rejected alternatives), carries no
   role guidance, and invites hand-picked light models where the sizing
   rules exist to stop them.

**Decided: option 1, filled in automatically, with no per-round escalation
and no new role.** A fix stage runs as builder `mode=apply-fixes` with the
lane's domain and size. The conversion and the mandate's composition rule set
those params, and the row decides the runtime (§2.10 B "Fix rows", §2.10 G).
The seat may override a fix stage's runtime; R3 refuses an explicit light
model on a builder that is not `size=trivial`, so in practice an override
raises the model. Shipped rows, each editable in the agent mapping:

| lane | fix stage runs |
| --- | --- |
| general, normal | codex / gpt-6-luna / high (this install's current apply-fixes row) |
| frontend, normal | claude / sonnet / high |
| docs, normal | claude / sonnet / high |
| any domain, trivial | the builder·trivial row (claude / sonnet / high) |

**Against the operator's runtime preference.** The operator's standing
preference (2026-09-27, as the seat relayed it): GPT-6 Astra as little as
possible; Opus for most work; Sol for performance or detail-exact work; Luna
or Sonnet only for simple, precisely briefed work. The matrix sits inside it.
Its light rows run only fix rounds, whose brief is a list of findings each
with an exact place, and trivial lanes, whose brief states the exact change;
anything else goes back to the seat. The preference is this operator's, so it
belongs in this install's agent mapping, and shipped prompt text names no
preferred model beyond the rows. Two rows of this install's mapping sit
against it on 2026-09-28: the reviewer row is `codex/gpt-6-astra/medium`, so
every review that is not trivial runs on Astra, and the builder base row is
`codex/gpt-6-sol/high`, where the preference puts most work on Opus and keeps
Sol for performance or detail-exact work. Moving them (Opus satisfies both the
preference and R1) is a change the operator makes in the agent mapping. It is
outside this build and leaves the matrix as it is.

For the misfit spawns, no new role: once scaffolds are stack-neutral, a
merged-PR review fits `reviewer`, a rollout question fits `prod-auditor` or
`verifier`, and a status check fits a role-less spawn.

## (b) File ownership across lanes — decided: drop the wording

1. **Keep the wording.** Costs nothing and asserts a rule nothing implements;
   builders read "assigned file ownership" that was never assigned.
2. **Make it enforceable.** A stage declares the paths it may change; the
   engine refuses to settle a stage whose diff leaves them, and refuses a
   lane whose paths overlap an open lane's. Real protection; a new field,
   a settlement check and an overlap check, plus seats predicting paths
   before the work is understood.
3. **Drop the wording and keep what seats already do.** The brief's fences
   list the files other open lanes are changing (every sampled second-product
   brief on 09-27 does), and the builder is told to respect them. No engine
   work; protection depends on the seat's brief.

**Decided: option 3.** Part 2 removes "Keep changes within the assigned file
ownership", "One owner holds a file at a time across active worktrees" and
"one owner per file across active worktrees". The builder's `SCOPE` rule and
the mandate's brief rule carry the practice seats already follow: each brief
lists the files other open lanes are changing. Enforcement stays deferred
until a real collision between lanes is seen.

## (c1) Is "Maximum workers" a cap in every mode? — decided: yes

The code means backlog-campaign only (`defaults.ts:62`); the seat renders it
in standard mode and obeys it (N6). Options weighed: an explicit cap in every
mode, from the same parameter; backlog-campaign only, so standard mode has no
cap; or no number, leaving it to account limits and admission.

**Decided: an explicit cap in every mode.** The orchestrator scaffold and the
mandate's "How work runs" state it in matching words, and both define a
worker: each running lane and each live spawned agent counts as one (§2.10 B,
§2.10 E). The other backlog-campaign lines (repository, issue query, urgent
list, merge policy, completion policy) render only in that mode.

## (c2) This install's deployer override — decided: restore the shipped text, flag overrides

N14. Options weighed: restore the shipped text once this contract lands; keep
the override and have the role table flag it; keep it and merge the shared
rules into it by hand.

**Decided: restore it through the product, and flag any override in the role
table.** The product has no restore path today, so §2.10 I adds the smallest
one: the mapping writer accepts `promptScaffold: null`, and the mapping editor
offers "Use the shipped prompt". §2.10 E adds the role-table line. After the
release the operator reads the two deployer texts side by side and restores
the shipped one from the agent mapping. No lane edits live state.

## Settled without the operator

The code or the requirement settles these: pass carries notes in the summary
(no P3-on-pass engine change); the fallback parser keeps `COMMENT →
needs_decision`; seats never write verdict markers into briefs; every agent's
work runs as a pipeline except the deployer and work no pipeline can host;
frame rules stay with reviewer and architect; the pinned specification states
what the lane must achieve and one stage's steps go in that stage's prompt
(N17); the stale MCP bundle is fixed on main (#2271), so the build waits for
nothing; a v29 seat reaches v30 through one rotation from the board, because
#2283 keeps a seat's core otherwise.

No question in this document remains for the operator.

---

## Deferred — not currently justified

- Enforced file ownership (option (b)2).
- Per-round escalation of the fix runtime by findings (option (a)2).
- A new generic role id (option (a)3).
- P3 findings allowed on pass.
- Text changes to the flow and workflow prompts (`flows/prompts.ts`,
  `reviewHistory/relayPrompt.ts`, `workflows/prompts.ts`): flow code is
  removed by the separate task, and until then the contract stops new flows
  from being created.
- This repository's own agent skills (`review-loop`, `delegatus-conveyor`,
  `delegatus-orchestration`) still teach flows and `REVIEW_READY`; they are
  this project's playbook and belong to the flow-removal task.
- A persistent implementer that receives findings across rounds
  (`retire-flows.md` §2).
- Replacing an unedited v29 core by exact match at delivery, so seats reach
  v30 without a rotation. One rotation per seat from the board does it, and
  #2283 chose on purpose to keep a seat's core otherwise.
- Setting a scaffold override through the product. §2.10 I adds reset only.
- Moving this install's reviewer row off Astra and its builder row to Opus:
  an operator change in the agent mapping (Part 3 (a)), outside this build.
- Moving the shipped base rows off Astra. The preference is one operator's,
  and the shipped rows are the product default for every install
  (`model-sizing-tiers.md`); an install that prefers otherwise maps its rows.

## Validation against the requirement

| operator's words | where the contract answers |
| --- | --- |
| "what went into the real prompts, into real agents" | Part 1 reads first messages from both projects, before and after the 09-27 rebuild, and traces each layer to code; §1.4 shows where the text that arrived differed from main and why |
| "remove the contradictions" | C1–C12 and N5–N17 resolved by a §2.10 text or a Part 3 decision; N1 by #2271, already on main; N2–N4 by the mandate no longer creating flows, and finally by the flow-removal task |
| no TypeScript, framework or Delegatus code and deploy in the prompts; "practices" | §2.6; §2.10 removes `tsc`, `bunx`, "English/Ukrainian", "external-worker deployment barrier", blue/green, the conveyor skill name, the port |
| GitHub issue only when GitHub is set up, never mandatory | §2.7; "How work runs" |
| check that pipelines are finished, then remove review flows from the prompt | §2.8 checks the engine; §2.10 E composes reviews as run stages and never names flows |
| fix-round runtime by a matrix, automatic, or a new role; light models only when told exactly what and where | Part 3 (a), decided: the matrix, filled in automatically; §2.10 B fix rows and apply-fixes guidance; §2.10 G |
| "the verdict vocabulary must be done" | §2.1–§2.4 |
