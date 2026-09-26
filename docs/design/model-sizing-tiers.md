# Size models to the task: a small-change tier and the sizing rule

## Originating requirement

Operator request, 2026-09-26, forwarded from another project's orchestrator
seat and pinned on this pipeline (paraphrased there, quoted here as pinned):

> model runtimes are not sized to the task. A trivial frontend tweak ran on the
> builder frontend variant at Opus xhigh with a GPT-6 Astra reviewer; a
> design/options issue went to Sonnet. Wanted:
> 1. A small-change tier (a few lines of UI, copy, one flag or label): a lighter
>    builder (Sonnet or GPT-6 Luna class) allowed ONLY for precisely specified
>    small fixes whose brief an Opus agent (orchestrator or architect) wrote, and
>    a lighter reviewer (Astra does not review trivial diffs).
> 2. An orchestrator rule: before launching, size the task as trivial / normal /
>    design and pick the tier from a model matrix; the launch summary states
>    which model runs and why.
> 3. A hard rule: Sonnet never for architecture, proposals, design options,
>    issues from design work, or reviews.
> 4. Operator preference (26.09): writing and documentation read better from
>    Claude, so prose-heavy lanes (README, docs, public text) stay on Claude.
> 5. Hosts with stale role-presets.json overrides (another install still carries
>    builder.variants.frontend = claude opus xhigh) should adopt the repo
>    defaults after updating; design how an install resets or migrates stale
>    preset overrides safely (the operator's own customisations must not be
>    silently lost).

## Prior work

- A Codex design session of 2026-09-20 ("Підбирати моделі й перевірки під
  задачу", pipeline `1edce1dc`) proposed a conditional selection policy: a
  per-field precedence (explicit > saved > conditional > shipped), a
  five-axis work classification, and review budgets by risk. Nothing of it
  shipped (no commit on main touches selection since; checked
  `git log --since=2026-09-19` over `src/lib/roles`). This design takes a
  much smaller cut of the same idea: one parameter, three variants and one
  admission check, with no classifier.
- #2174 (`772338007`, 2026-09-25) put the per-lane effort rules into the role
  descriptions and moved this machine's mapping off `builder.frontend =
  claude/opus/xhigh` with an explicit mapping patch
  (`src/lib/roles/store.test.ts`, "the model-landscape mapping patch"). Other
  installs never got that patch, which is requirement 5.
- Standing operator rules on this project, all still current: presets decide
  the runtime and seats omit engine/model/effort; frontend lanes are never
  reviewed on Astra; the effort ladder of 2026-09-18 (low for text and one-line
  fixes, medium for small well-specified changes and their reviews); writing
  lanes run on Claude/Opus including their fix stages (2026-09-26).

## Current behaviour (main at `4b8a30002`)

**Registry.** Eight frozen role ids (`src/lib/roles/types.ts:1-10`). Each role
has one `config`; only the builder has variants, and exactly two:
`BUILDER_VARIANT_IDS = ["frontend", "apply-fixes"]`
(`src/lib/roles/types.ts:77`), with shipped runtimes
`frontend = claude/opus/high` and `apply-fixes = codex/gpt-5.6-terra/low`
(`src/lib/roles/paramConfig.ts:9-10`). The builder's parameters are `mode` and
`domain ∈ {general, frontend}` (`src/lib/roles/defaults.ts:97`); the reviewer
has `diffSource`, `lens`, `mode`, `parallelN` and no size or domain
(`src/lib/roles/defaults.ts:64-74`). Shipped reviewer runtime is
`codex/gpt-6-astra/xhigh` (`defaults.ts:68`).

**Variant selection.** `configForParams` picks `domain=frontend` first, then
`mode=apply-fixes`, else the base config (`src/lib/roles/registry.ts:96-101`).
The draft pane duplicates that precedence by hand
(`src/components/DraftAgentPane.tsx:474-495`), and so does the role table
(`src/lib/orchestrator/prompt.ts:391-397`).

**Explicit runtime.** `resolveConfig` merges explicit engine/model/effort over
the variant and validates only that the model is in the engine's catalog and
the effort on its scale (`registry.ts:103-112`). Nothing refuses Sonnet for any
role, and nothing ties a light model to a kind of work.

**Pipelines.** `pipelineRoleLookup` renders the scaffold and returns
`configForParams(...)` (`src/lib/pipelines/roles.ts:36-63`);
`resolvePipelineRole` lays stage overrides over it (`roles.ts:86-151`). It is
called from `normalizeStages` for create and add-stage
(`src/lib/pipelines/engine.ts:5578`) and from override-stage
(`engine.ts:7855`). A review-loop stage becomes a reviewer plus a fix stage
whose role, params and runtime are copied from the implementer
(`src/lib/pipelines/legacyReviewDefinition.ts:254-270`). Create resolves the
creator conversation from `src` (`engine.ts:6093-6097`,
`resolvePipelineCreatorLineage` at `engine.ts:5950-5968`) and already runs
create-time refusals over the normalized stages: `stageAccountRefusal`
(`engine.ts:6138`) and `stageEngineRefusal` (`engine.ts:6142-6145`).

**Caller identity.** The HTTP create route knows whether the request is
agent-initiated and authenticates the calling conversation from its spawn
capability (`src/app/api/pipelines/route.ts:81-112`,
`src/app/api/spawn/admission.ts:86-117`). MCP `create_pipeline` calls
`createPipelineFromRequest` directly (`src/lib/mcp/bindings.ts:1540-1545`) and
has the caller's attribution at hand (`attributionOf`, `bindings.ts:880-893`).
Graph edits carry a `PauseResumeActor` (`src/lib/pauseResumeActor.ts:1-3`)
through `patchPipeline` (`engine.ts:7227`). The spawn route resolves the role
at `src/lib/agent/spawnCommand.ts:306` right after it has established
`authenticatedCaller` (`spawnCommand.ts:280-290`). A registry conversation
carries its `engine` and, per generation, `launchProfile.model`
(`src/lib/agent/registry.ts:246, 279`).

**What a launch answers.** `create_pipeline` answers each stage's resolved
engine, model and effort with no role and no reason
(`src/lib/mcp/compactAnswers.ts:32-50`). `spawn_agent` answers no runtime at
all (`bindings.ts:1314-1336`).

**What the seat reads.** The role table is rendered from the registry at
mandate delivery (`prompt.ts:399-418`); the conveyor rule says "role per the
role table" (`prompt.ts:360`). Its only sizing guidance is one bullet: "low or
medium for routine … work" (`prompt.ts:414`). Delivered tables are not
refreshed for a seat that already holds one.

**Presets file.** `state/role-presets.json`, schema 1, or 2 when a builder
variant is present (`src/lib/roles/store.ts:13-17, 127-129`). Load validates
every row and throws on anything unknown; callers that must stay up fall back
to shipped defaults (`store.ts:99-125, 273-294`). The mapping writer drops a
row equal to the shipped value, "so a later change to the shipped defaults
reaches every role nobody touched" (`store.ts:183-214`). Rows written any other
way stay pinned: this machine's live file carries `orchestrator` and
`architect` rows equal to today's shipped `claude/opus/high`, which would keep
those roles on Opus high if the repo default moved. A row that differs from
shipped is indistinguishable from an operator's choice; the file records no
provenance. `builder.frontend = claude/opus/xhigh` was never a shipped value
(`BUILDER_FRONTEND_CONFIG` has been `opus/high` since `e0f418e3b`); it exists
only as a written row. The file's existence is also the onboarding marker
(`src/app/api/onboarding/route.ts:22`).

**Cost classes.** `modelSizeClass`: haiku and both Lunas 1, Sonnet and Terra 2,
Opus, Fable, both Sols and Astra 3; an uncatalogued id counts as 3
(`src/lib/roles/costHints.ts:13-28`). A dated Claude id such as
`claude-sonnet-5` is uncatalogued there, so it reads as 3.
`normalizeClaudeLaunchModel` maps any Claude id to its family
(`src/lib/agent/models.ts:110-118`).

## Decisions

### 1. The tier model

One new role parameter, `size`, on the **builder** and the **reviewer** only:
`{ key: "size", kind: "select", options: ["normal", "trivial"] }`, default
`normal`. No other role gets it, so `architect`, `orchestrator` and `verifier`
refuse `size=trivial` as an unknown parameter by the existing
`validateRoleParams` rule (`registry.ts:34-41`).

Builder `domain` gains a third option, `docs` (README, docs, public text).

Variants become per role (the type widens from builder-only to a
`RoleVariantId` per role):

| row | selected when | shipped runtime | why |
| --- | --- | --- | --- |
| builder (base) | otherwise | codex/gpt-6-astra/medium (unchanged) | |
| builder · `trivial` (new) | `size=trivial` | claude/sonnet/high | "Sonnet or Luna class"; the items named (UI, copy, a label) are mostly writing and UI, which the operator prefers from Claude; high because the model is small and the brief is exact |
| builder · `frontend` | `domain=frontend` | claude/opus/high (unchanged) | |
| builder · `docs` (new) | `domain=docs` | claude/opus/medium | requirement 4; medium per the effort ladder for well-specified work |
| builder · `apply-fixes` | `mode=apply-fixes` | codex/gpt-5.6-terra/low (unchanged) | |
| reviewer (base) | otherwise | codex/gpt-6-astra/xhigh (unchanged) | |
| reviewer · `trivial` (new) | `size=trivial` | codex/gpt-6-luna/high | "Astra does not review trivial diffs"; Sonnet may not review (rule 3); Luna is the Codex reviewer of the Sonnet class, so the reviewer is never weaker than the builder it checks |

Builder precedence: `trivial` > `frontend` > `docs` > `apply-fixes` > base.
`trivial` wins over the domain, so a trivial UI tweak runs the light variant
and still gets the frontend scaffold guidance, which is keyed on `domain`
(`registry.ts:77-82`). `docs` wins over `apply-fixes`, so a writing lane's fix
stage stays on Claude (the fix stage copies the implementer's params; see
`legacyReviewDefinition.ts:254-270`). A trivial lane's fix stage is trivial for
the same reason, and its reviewer is trivial when the review stage names
`size=trivial`.

The precedence lives once, as a pure client-safe function in
`src/lib/roles/paramConfig.ts`:

```ts
export function variantForParams(roleId: RoleId, params: RoleParamValues): RoleVariantId | null
```

`configForParams`, `DraftAgentPane`, the role table and the launch line all
call it; the three hand copies go.

Every new variant row is mappable in the agent mapping exactly like the two
existing ones, so an install that prefers GPT-6 Luna for trivial builders sets
that row once.

**Rejected alternatives.** A new role id (`small-builder`): role ids are frozen
at eight and keyed in admission, pipelines and the board. The status quo
(explicit `model: "sonnet"` on a stage): it is prose, and it is how a design
issue reached Sonnet.

### 2. How a launch selects the tier, and where "briefed by Opus" is enforced

A seat selects the tier with role params only: `role: { roleId: "builder",
params: { size: "trivial" } }` and the same on the review stage. It still
names no runtime, which keeps the presets-decide rule intact.

Enforcement is one pure function, `src/lib/roles/sizing.ts`:

```ts
export type Briefer =
  | { kind: "operator" }
  | { kind: "agent"; runtime: { engine: string; model: string | null } | null };

export function launchSizingRefusal(input: {
  roleId: RoleId | null;          // null = role-less stage, judged as builder
  params: RoleParamValues;
  config: RoleConfig;             // the resolved runtime, overrides applied
  explicitRuntime: boolean;       // the caller set engine or model itself
  briefer: Briefer;
}): string | null
```

Two helpers beside it, both client-safe:

- `isLightRuntime(config)`: Claude, and `normalizeClaudeLaunchModel` is
  `sonnet` or `haiku`; or Codex, and `modelSizeClass(model) < 3`. Claude goes
  through the family normalizer so `claude-sonnet-5` cannot pass as large.
- `isOpusClass(runtime)`: Claude, and the family (a null model counts as the
  engine default, `opus`) is `opus` or `fable`; or Codex, and
  `modelSizeClass(model ?? gpt-6-astra) === 3`. Copilot is never Opus class.
  Astra and Sol count: moved off Claude, the orchestrator seat lands on Astra
  (`src/lib/roles/equivalents.ts:48-66`), and the operator ranks Codex at
  least level with Opus.

The rules, applied only when `briefer.kind === "agent"`; the operator's own
launches (UI drafts, operator capability) are the authority and pass:

- **R1, the deny list (requirement 3).** `orchestrator`, `architect`,
  `reviewer` and `verifier` never resolve to Claude Sonnet or Haiku, whether
  the runtime came from the mapping or from an explicit override. Message:
  "Sonnet and Haiku do not run orchestrator, architect, reviewer or verifier
  work; name an Opus-class model or use the role's row."
- **R2, the brief (requirement 1).** `size=trivial` is admitted only when the
  briefer is Opus class. An agent whose runtime cannot be read is not.
  Message names the briefer's runtime: "size=trivial runs a light model and
  needs a brief written by an Opus-class agent; this brief comes from
  claude/sonnet."
- **R3, no side door.** A builder (or a role-less run stage) that resolves to a
  light runtime *because of an explicit engine/model override* is refused
  unless `size=trivial` (and then R2 applies). A light runtime that came from
  the mapping (the fix-round variant, or an install that mapped its base
  builder to Luna) passes: that is the operator's own choice. R3 is what makes
  the lighter builder available "ONLY" through the small-change tier.
  *Built:* "explicit" is judged on the resolved values, not on which input
  fields are present: a stage's runtime is explicit when its engine or model
  differs from what the install's row gives that role and those params
  (`stageRuntimeIsExplicit`, `src/lib/pipelines/roles.ts`). override-stage
  mirrors every resolution onto the stage's input fields, so field presence
  would read every overridden stage as explicit, and a fix stage that copied
  its implementer's runtime reads the same as its implementer. A spawn reads it
  the same way (`resolveSpawnRole` answers `explicitRuntime`). A role-less
  spawn that names its own engine and model is judged as a hand-set builder,
  as a role-less stage is.

Call sites, each with the caller it already knows:

| seat | file | briefer |
| --- | --- | --- |
| pipeline create | `engine.ts`, beside `stageAccountRefusal` (`:6138`), over `normalized.stages` | new `CreatePipelineOptions.briefer`: the HTTP route passes `operator` when `!isAgentInitiatedSpawn(req)` and the authenticated conversation otherwise; MCP passes `attributionOf(...).conversationId`, falling back to the resolved `srcConversationId` |
| add-stage, override-stage | `patchPipeline` (`engine.ts:7227`), after `resolvePipelineRole` | the `actor`: `operator`, or the agent's `conversationId`, falling back to `pipeline.srcConversationId` |
| spawn | `spawnCommand.ts:306`, after `resolveSpawnRole`; the same check in `/api/spawn/validate` (`spawnAdmissionValidation.ts`) so the validator never admits what the route refuses | `authenticatedCaller` (`operator` when absent or operator-capability) |
| MCP `spawn_agent` (*built*) | `bindings.ts`, before dispatch | the attributed conversation, else `parentConversationId`. MCP dispatches reach `/api/spawn` same-origin on the **operator** capability, so the route alone would read every seat's spawn as the operator's; the binding knows the caller and judges it before anything is dispatched |
| mapping write | `parseRoleMappingPatch` / `saveRoleMapping` (`store.ts:155-221`) | R1 only, for every writer: a mapping row is a standing default that agents then launch |

The engine reads the briefer's runtime through one new optional port,
`conversationRuntime(conversationId) → { engine, model } | null`, backed by the
registry conversation's `engine` and its newest generation's
`launchProfile.model` (`src/lib/agent/conversationRuntime.ts`, shared with the
spawn route and the MCP binding). A create without a `briefer` option is the
Viewer's own (task assignment, the health check) and is not judged. The HTTP
`PATCH /api/pipelines/:id` stays operator-attributed as it already is for
pause and resume; agents edit graphs through MCP, which carries the actor. A pipeline refusal is a normal create violation
(`field: "stages[i].role"`), so the caller reads it the way it reads an engine
refusal today. Stage attempts launched later by the controller are not
re-checked; they run the `effectiveRole` admitted at create.

`loadRoleOverrides` does not apply R1: a legacy file carrying `reviewer →
sonnet` must not throw the whole registry into degraded mode. Such a row is
refused at launch for agents (R1) and can only be rewritten to a legal value.

**Rejected alternatives.** A `briefedBy` field the caller asserts: spoofable
and prose. Requiring an architect stage before any trivial builder: heavier
than the problem, and the seat itself is the Opus brief-writer the requirement
names.

### 3. Launch summary line (requirement 2)

The server states which model runs and where it came from; the seat adds why
it sized the lane that way.

- `pipelineAcknowledgement` (`compactAnswers.ts:32-50`) gains, per stage,
  `role` and `variant` (from `variantForParams`), and one top-level
  `runtimeLine`, e.g.
  `build: builder·trivial claude/sonnet/high · review: reviewer·trivial codex/gpt-6-luna/high · review-fix: builder·trivial claude/sonnet/high`.
  A stage whose engine or model the request named is marked `(explicit)`; at
  create those input fields are present only when the caller sent them.
  *Built:* the stage id is followed by a colon, which reads as a label and
  keeps a stage id from running into its role.
- `/api/spawn` answers `runtime` in the same one-stage form
  (`builder·trivial claude/sonnet/high`) for a role launch, and `spawn_agent`
  passes it through. A role-less launch answers as before, so its replay
  answers stay byte for byte.

### 4. What the seat receives

`orchestratorRoleTable` (`prompt.ts:399-418`) changes in two ways. Both live
inside the table block, which runs to the first blank line, so no blank lines.

- The builder row lists its four variants and the reviewer row its trivial
  variant, both through `variantForParams`, from the install's mapping.
- The bullet at `prompt.ts:414` is replaced by these (the text as designed; see
*Built* below for what shipped):

```
- Size every lane before you launch it. trivial: a few lines of UI, copy, one flag or label, with the exact change and its acceptance written in your brief — builder and reviewer with size=trivial, one review round. normal: the rows as they are. design: options, architecture, proposals, or issues that come out of design work — an architect stage first, whose output briefs the builders.
- size=trivial is admitted only on a brief from an Opus-class agent. Sonnet and Haiku are refused for orchestrator, architect, reviewer and verifier, and a builder reaches a light model only through size=trivial.
- README, docs and public text: builder domain=docs, which stays on Claude.
- Your launch message says the size you chose and why in one clause, and quotes runtimeLine from create_pipeline (runtime from spawn_agent).
```

A seat that already holds a delivered table sees the new text at its next
delivery (rotation or handoff); the refusals and the launch line work for it
from the deploy on.

*Built:* the four bullets as designed took the delivered mandate ~970 bytes
past the room the envelope tests leave for a rotation's history. What shipped
is the same rules in fewer words, merged with the two existing bullets they
overlap (runtime overrides, and reading back create_pipeline's answer), and
the effort guidance the old bullet carried is kept inside `normal`, so the
2026-09-18 effort ladder is not lost:

```
- Runtime overrides go on the stage beside role. override-stage binds from the NEXT attempt: a running one keeps its runtime.
- Size each lane first. trivial (a few lines of UI, copy, one flag or label; your brief states the exact change and its acceptance): builder and reviewer size=trivial, one review round. normal: the rows, effort low or medium for routine work. design (options, architecture, proposals, issues from design work): an architect stage first.
- Only an Opus-class agent's brief admits size=trivial. Sonnet and Haiku never run orchestrator, architect, reviewer or verifier, nor a hand-set builder. README, docs, public text: builder domain=docs.
- create_pipeline answers each stage's runtime and a runtimeLine (spawn_agent: runtime): fix a wrong one before attempt 1 (draft, or pause, override-stage, start), and quote it with the size you chose and why.
```

Variant runtimes read `size=trivial: claude/sonnet/high; domain=frontend: …`.
Even so the table grew by ~300 bytes: the section bound in
`prompt.test.ts` is 3 300 bytes (was 3 000), the room left beside the
delivered default is 7 800 bytes (was 8 000), and the delivered-directive
budget in `handoffDigest.test.ts` is 12 500 bytes (was 12 000; main already
measured 12 080 before this change). A rotation trims its history to what is
left, and 19 500 bytes still hold two history budgets.

### 5. Stale preset overrides (requirement 5)

Two steps, one Viewer-boot pass, journaled in the presets file itself.

**Step 1: normalize.** A row equal to the value shipped *now* is dropped. The
effective runtime does not change, so nothing is lost; it removes the pin, so
the next change to a shipped default reaches the row. This is the semantics
the mapping writer already defines (`store.ts:183-188`) applied to rows written
before it existed or by hand.

**Step 2: retirements.** The repo carries a short, explicit list of values it
has retired:

```ts
// src/lib/roles/retirements.ts
export const ROLE_MAPPING_RETIREMENTS = [
  { id: "2026-09-builder-frontend-opus-xhigh", row: "builder:frontend",
    config: { engine: "claude", model: "opus", effort: "xhigh" } },
] as const;
```

For each id not yet applied: if the row equals `config` exactly, it is removed
(the row falls back to the shipped value) and the previous value is recorded;
a row with any other value is left untouched. The id is recorded as applied
either way, so a retirement runs once per install and never again, which is
what lets the operator restore the old value and keep it.

The journal is a new top-level key the store reads and preserves:

```json
"retirements": {
  "2026-09-builder-frontend-opus-xhigh": {
    "at": "2026-09-27T08:00:00.000Z",
    "reset": { "row": "builder:frontend", "from": { "engine": "claude", "model": "opus", "effort": "xhigh" } }
  }
}
```

**Not silent.** A `reset` entry is shown until the operator touches that row:

- `GET /api/roles` answers `resets: [{ id, row, from, at }]`.
- The agent mapping table shows it on the row, in the existing row-state line:
  "Set to the default when Delegatus updated (was Opus · xhigh). Restore".
  Restore sends the old config through the normal `PUT /api/roles`.
- The role table's registry-status bullet lists each reset, so the seat can
  tell the operator.
- Any mapping write to that row deletes its `reset` (keeping the id applied).
- *Built:* the journal is read leniently: a malformed entry is dropped rather
  than failing the whole registry into degraded mode, since it only drives a
  notice. The boot pass logs the rows it reset.

**Safety.**

- The pass runs in `startCurrentReleaseControllers`
  (`src/lib/viewerInstrumentation.ts:383`), so only the serving release
  performs it, behind `assertStateStartupMutation(stateDir, "role mapping
  retirement")` (`src/lib/stateOwnership.ts:331`).
- It reads, edits and writes in one synchronous step through the existing
  atomic write (`store.ts:38-43`). It never creates the file when it is
  absent and never deletes it, even if every row goes (the file is the
  onboarding marker). A file that fails validation is left alone.
- `promptScaffold` overrides are never touched.
- An older release sharing the directory ignores the `retirements` key on
  read (`store.ts:113-124` reads only `schemaVersion` and `overrides`). If
  that older release writes the mapping, it drops the journal; the only
  consequence is that a retirement could apply a second time to a value the
  operator restored through the old release. Accepted.
- A file that carries a new variant key (builder `trivial`/`docs`, reviewer
  `trivial`) is written as `schemaVersion: 3`, so an older build answers
  "unsupported role override schema: 3" and degrades to shipped defaults, the
  path it already takes for a file it cannot read. The shipped values of the
  new variants are never written, so an install that does not map them keeps
  schema 1 or 2.

**Rejected alternatives.** Resetting every override on update loses the
operator's choices. Only marking rows that differ from shipped leaves the
stale value in force. Recording, per row, the shipped value at write time and
flagging rows whose default has since moved is the general form; it is
deferred below.

### 6. Engine-flip table

`ROW_TARGETS` (`equivalents.ts:48-66`) gains the new rows so moving a row
between engines never lands on a refused runtime: to Claude,
`reviewer:trivial → opus/medium` (never Sonnet), `builder:trivial →
sonnet/high`, `builder:docs → opus/medium`; to Codex, `builder:trivial →
gpt-6-luna/high`, `builder:docs → gpt-6-astra/medium`, and (*built*, so a
round trip lands back on the shipped value) `reviewer:trivial →
gpt-6-luna/high`. The mapping table's model select omits Sonnet and Haiku on
the four denied rows.

## Tests

- `src/lib/roles/sizing.test.ts` (new): R1–R3 over the role × runtime ×
  briefer matrix; the operator passes every case; `claude-sonnet-5` and
  `sonnet` are both light and not Opus class; a null Claude model is Opus
  class; an unreadable agent runtime fails R2; a mapping-derived light builder
  passes R3 and the same runtime set explicitly does not.
- `src/lib/roles/registry.test.ts`: `variantForParams` precedence (trivial >
  frontend > docs > apply-fixes); reviewer `size=trivial`; `architect` refuses
  `size`; the shipped runtime of each new variant.
- `src/lib/roles/store.test.ts`: reviewer variants load and save; schema 3
  only when a new variant key is stored; a mapping patch putting `reviewer`,
  `architect`, `orchestrator` or `verifier` on Sonnet or Haiku is refused;
  normalize drops rows equal to shipped and keeps the rest and every scaffold;
  a retirement resets only an exact match, records it once, is not re-applied
  after a restore, never creates or deletes the file; a non-owner process is
  refused by the startup-mutation fence; a mapping write to the row clears its
  `reset`.
- `src/lib/roles/equivalents.test.ts`: the new rows; no denied row lands on
  Sonnet.
- `src/lib/pipelines/stageSizing.test.ts` (new, beside
  `engineConnectionRefusal.test.ts`): create by a Sonnet-run agent with a
  trivial builder is refused; by an Opus-run agent it is admitted and the
  review-loop's fix stage inherits `size=trivial`; an operator draft is
  admitted; an explicit `model: "sonnet"` on a builder without `size=trivial`
  is refused; an explicit Sonnet reviewer is refused; override-stage by an
  agent actor is checked and by the operator it is not.
- `src/app/api/spawn/route.test.ts`: an agent caller on Sonnet spawning
  `builder size=trivial` gets 400; the answer carries `runtime`.
- `src/instrumentation.test.ts` (*built*): the boot pass runs with the serving
  release, before the pipeline controller, and its failure stops nothing.
- `src/lib/mcp/compactAnswers.test.ts`: `role`, `variant` and `runtimeLine`.
- `src/lib/orchestrator/prompt.test.ts`: the sizing bullets, the variant
  listing, a reset in the status bullet, and still no blank line in the table.
- `src/app/api/roles/route.test.ts`: `resets` in GET; the refusal text on PUT.
- `src/components/onboarding/OnboardingDialog.dom.test.tsx`: the three new
  rows, the reset line and Restore.
- Rendered evidence: the onboarding case of `scripts/capture-board-geometry.ts`
  gains the new rows and the reset line, at the viewports it already captures.

Run each file by path, never a directory sweep (AGENTS.md).

## Files for the build lane

- `src/lib/roles/types.ts` — `size` parameter type, `RoleVariantId` per role,
  `variants` on builder and reviewer, schema `1 | 2 | 3`, `retirements`.
- `src/lib/roles/paramConfig.ts` — shipped configs of the new variants,
  `variantForParams`.
- `src/lib/roles/defaults.ts` — `size` on builder and reviewer, `docs` domain.
- `src/lib/roles/registry.ts` — `configForParams` through `variantForParams`.
- `src/lib/roles/sizing.ts` (new) — `launchSizingRefusal`, `isLightRuntime`,
  `isOpusClass`.
- `src/lib/roles/retirements.ts` (new) — the list and the boot pass.
- `src/lib/roles/store.ts` — per-role variants, schema 3, R1 on mapping
  writes, preserve `retirements`, clear `reset` on write.
- `src/lib/roles/equivalents.ts` — new rows.
- `src/lib/pipelines/roles.ts` — nothing beyond what `configForParams` gives.
- `src/lib/pipelines/engine.ts` — `briefer` option, `conversationRuntime`
  port, the create and graph-edit call sites.
- `src/app/api/pipelines/route.ts`, `src/lib/mcp/bindings.ts` — pass the
  briefer; pass spawn `runtime` through.
- `src/lib/agent/spawnCommand.ts` — the spawn call site and `runtime` in the
  answer; `src/lib/agent/spawnResponse.ts` — the `runtime` field;
  `src/lib/agent/spawnAdmissionValidation.ts` — the same refusal in
  `/api/spawn/validate`; `src/lib/agent/conversationRuntime.ts` (new) — the
  briefer's runtime from the registry.
- `src/lib/mcp/compactAnswers.ts` — `role`, `variant`, `runtimeLine`.
- `src/lib/orchestrator/prompt.ts` — role table rows and bullets, resets.
- `src/app/api/roles/route.ts` — `shipped` variants for every role, `resets`.
- `src/lib/viewerInstrumentation.ts` — run the boot pass.
- `src/components/onboarding/AgentMappingTable.tsx`,
  `src/components/DraftAgentPane.tsx`, `src/lib/i18n/en.ts`,
  `src/lib/i18n/uk.ts` — rows, reset line, Restore, model filter,
  `variantForParams`.
- The tests above and the capture case.

## Validation against the requirement

1. Small-change tier: `size=trivial` on builder (Sonnet) and reviewer (Luna,
   not Astra); admitted only on an Opus-class brief (R2), and the only way a
   builder reaches a light model on an agent's say (R3).
2. Sizing rule: the role table tells the seat to size trivial / normal /
   design and maps each size to roles; the launch answers carry the runtime
   line the seat quotes with its reason.
3. Sonnet deny list: R1 at every launch seam and at the mapping writer.
4. Prose on Claude: `domain=docs` ships on Claude Opus, and wins over the fix
   round so fix stages stay on Claude.
5. Stale overrides: normalize plus a once-per-install retirement of the named
   `builder.frontend = claude/opus/xhigh`, journaled, shown on the row and in
   the role table, restorable in one click.

The two original incidents: the trivial frontend tweak now runs
`builder size=trivial` on Sonnet with a Luna review, and on the other install
its non-trivial frontend lanes return to Opus high after the update. The
design issue on Sonnet is refused (R1 when it is an architect stage, R3 when a
builder stage was pointed at Sonnet by hand).

## Deferred — not currently justified

- The 2026-09-20 conditional policy: per-field source tracking, a work
  classifier, required evidence per class. One parameter covers the stated
  need.
- Review round budgets by size enforced by the server (trivial → one round).
  The role table says it; the existing `maxRounds` is the control.
- A reviewer `domain=frontend` variant for the standing "frontend lanes are
  never reviewed on Astra" rule. Adjacent, not asked for here; the variant
  mechanism above makes it a one-row follow-up.
- Per-row provenance (the shipped value at write time) and a general "the
  default moved since you set this row" notice.
- Storing the seat's sizing reason on the pipeline record.
- Docs-specific scaffold guidance for `domain=docs`.
- R1 on orchestrator seat designation (`src/lib/orchestrator/seatCommand.ts:941`)
  and on Copilot runtimes. Seats are designated from the operator's own
  controls, which R1 exempts anyway.
