# Per-launch and per-stage Codex service tier, with a per-role default

## Originating requirement

Operator request, 2026-09-30 ~05:52 UTC, relayed to this repository's
orchestrator (Russian, verbatim):

> «Передай оркестратору Delegatus: нужен service_tier (ultrafast для GPT Astra)
> параметром запуска агента/стадии, чтобы включать для ревью.»

("Tell the Delegatus orchestrator: we need service_tier (ultrafast for GPT
Astra) as a launch parameter of an agent/stage, so it can be turned on for
reviews.")

The pinned acceptance reads it as: a `serviceTier` on `spawn_agent`, on
`create_pipeline` stages and on `pipeline_action` `override-stage`, Codex only;
it reaches every turn of that agent; it is validated against the chosen
account's model catalog and refused before launch, naming the offered tiers,
with no silent downgrade; the role table can carry a default per row, shown in
the `runtimeLine`; the existing `fast` flag keeps working as `priority`; the UI
shows the tier where it shows model and effort; the scanner recognizes the new
ids. The global `config.toml` `service_tier` of the operator's Codex home must
not change.

## Prior work

`search_transcripts` (project-scoped, then unscoped; phrasings "structured
Codex spawn does not support an explicit Codex service tier", "ultrafast
service_tier", "serviceTierForTurn fast priority structured Codex") finds only
this request being relayed through the orchestrators on 2026-09-30. Nothing was
designed or built before. The one relevant commit is #239 (945e9bd75,
2026-07-14), which added the structured transport and refused an explicit Codex
service tier on it, because the host had no way to pass one.

## Facts this design rests on (checked 2026-09-30)

**The protocol.** Codex CLI 0.159.0 is installed. Its app-server protocol was
generated with `codex app-server generate-ts` into a scratch directory, with an
empty `CODEX_HOME`:

- `ThreadStartParams.serviceTier?: string | null` and
  `ThreadResumeParams.serviceTier?: string | null` set the **thread's** tier.
  `ThreadStartResponse` and `ThreadResumeResponse` echo `serviceTier`.
- `TurnStartParams.serviceTier` means "for this turn and subsequent turns".
  `TurnStartParams.serviceTierForTurn` means "only when this request starts a new
  turn; use `"default"` for standard speed; omitted or null inherits the
  thread's tier; does not change the thread's tier or a turn being steered".
- `Model.serviceTiers: ModelServiceTier[]` (`{id, name, description}`),
  `Model.defaultServiceTier: string | null`, and
  `Model.additionalSpeedTiers: string[]`, which the protocol marks as
  "Deprecated: use `serviceTiers` instead".

So one tier set at thread start or resume covers every later `turn/start`, every
`turn/steer` and every start the native queue makes itself. That is why the
design sets the tier on the thread and sends nothing per turn.

**The catalogs.** These were read-only reads of each Codex account's
`models_cache.json`, all fetched 2026-09-30 by client 0.159.0. The file uses
snake_case: `models[].slug`, `models[].service_tiers[].id|name`,
`models[].additional_speed_tiers`.

| model | account A | account B | account C |
|---|---|---|---|
| gpt-6-astra | priority | priority | priority, **ultrafast** |
| gpt-6.1-sol, gpt-6-sol, gpt-6-luna | priority | priority | priority |

`additional_speed_tiers` uses a different vocabulary (`fast`, `ultrafast`) from
the tier ids (`priority`, `ultrafast`). Only `service_tiers[].id` is what
`serviceTier` takes. Every account's `config.toml` has
`service_tier = "default"`.

**The rollouts.** Codex rollouts record the applied tier as
`{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"default",…}}}`.
`turn_context` records carry no tier. A structured Codex conversation runs
`codex app-server`, whose argv carries no `service_tier`. So today the scanner
cannot see the tier of any structured Codex conversation, and it could read it
from the transcript instead.

**What exists today.**

- A boolean `fast` on `/api/spawn`: `reasoningFromBody`,
  `src/lib/agent/efforts.ts:139-148`. On the tmux path it becomes
  `-c service_tier=priority|standard`: `src/lib/agent/cli.ts:437` (fresh) and
  `cli.ts:576` (resume). It is recorded as `launchProfile.fast`: `cli.ts:450`,
  `cli.ts:588`.
- On the structured transport, which is the default whenever a runtime host is
  present, **an explicit `fast` on a Codex spawn is refused**:
  `src/lib/runtime/spawnTransport.ts:52-54`, "structured Codex spawn does not
  support an explicit Codex service tier". That is why a structured Codex agent
  runs on whatever tier its account's `config.toml` sets.
- Per-send turn settings carry `serviceTier`/`serviceTierForTurn`/`fast`:
  `src/lib/runtime/contracts.ts:328-334`, parsed at
  `src/lib/runtime/commands.ts:29-37`, and turned into `turn/start` fields by
  `src/lib/runtime/codexTurnProfile.ts:17-23`. That code hard-codes the
  allowlist `auto|default|flex|priority` and maps `fast` to
  `serviceTierForTurn` `priority|default`. It is applied only to `turn/start`
  (`codexAppServerHost.ts:1841`), never to the thread.
- The account-migration resume, `src/lib/accounts/codexAppServer.ts:402`, sends
  `serviceTier: fast ? "priority" : "standard"`.
- The scanner, `src/lib/scanner/effort.ts:103-114` (`entryFast`), matches only
  `service_tier=(priority|standard)` in a live process's argv.

## Decision summary

1. **One field, `serviceTier`, holding the catalog tier id.** It is accepted on
   `spawn_agent`/`/api/spawn`, on a pipeline stage, on `override-stage` and on a
   role row. Codex only.
2. **The tier is a thread setting.** The launch profile carries it. The
   structured Codex host passes it on `thread/start` and on every
   `thread/resume`, so a restart, an adoption or a resume keeps it. Nothing is
   added per turn.
3. **An explicit tier (`serviceTier`, or `fast: true` read as `priority`) is a
   requirement.** Accounts whose catalog does not list the tier for that model
   are removed from the automatic pick. A named or pinned account that lacks it
   is refused. So is a pool in which no account offers it. Every refusal names
   the tiers that are offered. A tier-offering pool that is out of capacity is
   reported as exhausted, the way it is today. Nothing launches on a lower tier.
4. **A role-row default is a preference**, which is what "when the model offers
   it" says. It applies only when the launch runs the row's own engine and
   model. Accounts that offer it are preferred. When none of them can take the
   launch, the launch goes ahead on the account's own default, and the answer
   says so in words (§6). That is visible, so it is not a silent downgrade.
5. **`fast` stays.** `fast: true` means `serviceTier: "priority"`. `fast: false`
   asks for standard speed. When `fast` and `serviceTier` are both given they
   must agree, or the launch is refused. The structured-transport refusal of
   `fast` is removed, because the host can now carry it.
6. **The Viewer validates against the per-account `models_cache.json` before
   launch.** The host checks its own live `model/list` answer again before
   `thread/start`/`thread/resume`. A catalog that cannot answer means "not
   offered". Availability is never guessed from the model name.

## 1. Every path a launch's runtime settings travel, and where `serviceTier` joins

### 1.1 `spawn_agent` → `/api/spawn` → structured Codex host

| step | today | `serviceTier` joins |
|---|---|---|
| MCP schema | `src/lib/mcp/server.ts:3301-3330` (`spawn_agent`: engine/model/effort; `fast` and `accountId` pass through `.passthrough()` undocumented) | add `serviceTier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional()` beside `effort`, with a description: Codex only; a catalog tier id such as `priority` or `ultrafast`; refused when the chosen model and account do not offer it; `fast: true` equals `priority`. Also document `fast` there, because it is what the relation refers to. |
| MCP binding | `src/lib/mcp/bindings.ts:1334-1348` `spawnDispatchBody` forwards every argument except the three it strips | nothing: `serviceTier` rides the body as `effort` does |
| MCP sizing gate | `bindings.ts:1363` `refuseMcpSpawnSizing` | untouched (the tier does not change what model runs) |
| route body | `src/lib/agent/spawnCommand.ts:291` body type | add `serviceTier?: unknown` |
| role resolution | `spawnCommand.ts:348` → `resolveSpawnRole`, `src/lib/roles/registry.ts:195-215`; `explicitRuntime` at `registry.ts:213` | the role default is `role.value.config.serviceTier`. It applies only when `!explicitRuntime`, because the row's tier was chosen for the row's model. |
| reasoning/tier validation | `spawnCommand.ts:390-394` `reasoningFromBody` (effort, fast) | replace the `fast` half with `codexLaunchTier(...)` (§3.1), called in the same place. It returns `{tier, source: "explicit"|"fast"|"role-default"|null}` or a 400 error: wrong engine, bad shape, `fast` and `serviceTier` disagreeing, or a tier with no resolved model. |
| structured gate | `spawnCommand.ts:432-440` → `structuredSpawnGap`, `src/lib/runtime/spawnTransport.ts:52-54` | **delete** the `fast !== null` refusal and drop `fast` from the gap's request type |
| request digest | `spawnCommand.ts:668-675` `requestDigestForAccount` | add `serviceTier: tier` so a replay with a different tier is a conflict and never adopts the other launch |
| account selection | `spawnCommand.ts:817-828` → `resolveHealthySpawnAccount`, `src/lib/accounts/manager.ts:66-143` (the Codex branch uses `selectProjectAccount` at `manager.ts:112-127`) | new optional argument `serviceTier: {id, model, required}`, applied as in §4 |
| launch spec | `spawnCommand.ts:888-891` → `freshSpecFor`, `src/lib/agent/cli.ts:333`; `FreshSpecOptions.fast` at `cli.ts:178-180` | add `FreshSpecOptions.serviceTier?: string | null`. The Codex fresh spec writes `launchProfile.serviceTier` beside `fast` (`cli.ts:450`). The tmux command adds `-c service_tier=<id>` on the `cli.ts:437` line, replacing the `fast` mapping there when a tier is set. |
| durable profile | `LaunchProfile`, `src/lib/accounts/migration/contracts.ts:56-60` | add `serviceTier?: string | null`. It is optional, so every stored generation still parses. |
| host options | `src/lib/runtime/structuredSpawn.ts:1655-1672` (Codex branch of `defaultStartHost`) | add `serviceTier: launchServiceTier(profile)` (§3.2) |
| host start/resume | `src/lib/runtime/codexAppServerHost.ts:183-200` (`CodexAppServerHostOptions`), `1457-1466` (`model/list`), `1478-1491` (`thread/resume` / `thread/start`) | option `serviceTier?: string`. After the `model/list` try/catch, one line runs `assertCatalogOffersTier(provisional.modelCatalog, options.model, options.serviceTier)`. `serviceTier` is added to both the `resumeThreadTolerantly` params and the `thread/start` params. See §8 for the lane coordination. |
| first and later turns | `codexAppServerHost.ts:1841` `turn/start` with `codexTurnProfile`; `1753` and `1824` `turn/steer`; native queue `1656` | unchanged. Every one of them inherits the thread tier. |
| answer | `spawnCommand.ts:1047-1054` → `launchRuntimeLabel`, `src/lib/roles/paramConfig.ts:78-88` | the label gains the tier (§6). A non-role launch that names a tier now also gets a `runtime` line, so the caller sees it. |

### 1.2 `create_pipeline` stage → stage attempt → structured Codex host

| step | today | `serviceTier` joins |
|---|---|---|
| MCP schema | `pipelineStageSchema`, `src/lib/mcp/server.ts:3193-3230` | `serviceTier: z.string().nullable().optional()`: "Codex stage tier override, or null to inherit the role default…" |
| input type | `PipelineStageInput`, `src/lib/pipelines/types.ts:88-95` | `serviceTier?: string | null`. This is the explicit field. |
| effective role | `EffectivePipelineRole = RoleConfig & …`, `types.ts:57-61` | gains `serviceTier?` through `RoleConfig` (§5). This is the resolved field, explicit or role default. |
| create validation | shape checks at `src/lib/pipelines/engine.ts:5967-5971`; input built at `6022-6035`; `resolvePipelineRole`, `src/lib/pipelines/roles.ts:92-157` | shape check beside `effort`. The input copies `stage.serviceTier`. `resolvePipelineRole` resolves `serviceTier = stage value ?? (row engine/model unchanged ? row default : undefined)`, refuses a tier on a Claude stage, and sets `effectiveRole.serviceTier` plus `effectiveRole.serviceTierSource: "explicit" | "role-default"`. **An explicit stage tier is checked against the pool at create** (§4.3), so a create that can never launch is refused with the offered tiers named. |
| draft snapshot | `draftStageInputs`, `engine.ts:6110-6125` | copy `serviceTier` like `effort` |
| store | `isEffectiveRole` `src/lib/pipelines/store.ts:61-74`; `isStage` `store.ts:437-473` | accept an optional string `serviceTier` and `serviceTierSource`. `isStage` requires `stage.serviceTier === undefined || stage.serviceTier === effective.serviceTier ?? null`, the same consistency rule `effort` has at `store.ts:468`. |
| launch | `spawnPipelineAgent`, `engine.ts:513-575`: `resolveProjectSpawnAfterLiveRead` at `522-531`, `freshSpecFor` at `540-549`, request digest at `567-575` | the tier-lacking accounts join `unavailableIds` (§4.2). A pinned `requestedAccountId` that lacks the tier refuses an explicit tier and drops a default one. `freshSpecFor(..., serviceTier)`. The digest adds `serviceTier`. |
| host | same as §1.1 from "host options" on | same |
| answer | `pipelineAcknowledgement` / `stageRuntime`, `src/lib/mcp/compactAnswers.ts:33-71` | `stageRuntime` returns `serviceTier` and `serviceTierSource`; the `stages[]` rows gain `serviceTier`; `runtimeLine` uses the label of §6 |

A stage's refusal at launch goes where every account refusal already goes: the
throw from `spawnPipelineAgent` parks the stage with the reason on its record
(`engine.ts:532-534`).

### 1.3 `pipeline_action` `override-stage`

| step | today | `serviceTier` joins |
|---|---|---|
| MCP schema | `src/lib/mcp/server.ts:3460-3465` | `serviceTier: pipelineStageSchema.shape.serviceTier.describe("override-stage: Codex service tier, or null to inherit the role default.")` |
| action type | `PipelineActionRequest`, `src/lib/pipelines/types.ts:1053-1061` | `serviceTier?: string | null` |
| handler | `engine.ts:8288-8345` | count it in `changesRoleOrRuntime` (`8289`); type-check it like `effort` (`8297`); pass `serviceTier: req.serviceTier !== undefined ? req.serviceTier : resetRuntime ? undefined : target.serviceTier` into `resolvePipelineRole`; mirror it onto `target.serviceTier` with the other runtime fields. A changed engine or model with no explicit tier drops an explicit tier that the new model does not offer anywhere, the way a new role resets unpinned fields: it is refused with the offered tiers named, so the operator re-sends. |

The existing guards (`stageDigestRefusal`, `unboundLiveAttemptRefusal`) already
make the override reach only the next unbound attempt.

### 1.4 Role registry defaults

| step | today | `serviceTier` joins |
|---|---|---|
| type | `RoleConfig`, `src/lib/roles/types.ts:16-20` | `serviceTier?: string` (absent means unset) |
| store read/validate | `isPartialConfig` `src/lib/roles/store.ts:49-57`; `isCompatibleConfig` `86-95`; `schemaVersionFor` `154-165`; `sameConfig` `213-215` | allow the key (a string of the shape above, Codex rows only); compare it in `sameConfig`; **schema 5** whenever any row or variant carries it (§9) |
| write | `parseRoleMappingPatch` `store.ts:222-262`; `applyRoleMappingPatch` `270-296` (copies only engine/model/effort) | copy `serviceTier` when present |
| MCP write | `role_presets`, `src/lib/mcp/server.ts:3876-3882`; `roleMappingViolations`, `src/lib/roles/mcpMapping.ts:57-66` | `config` and `variants` objects gain `serviceTier` (optional). A violation is raised when no Codex account on this machine lists that tier for the row's model, naming what is offered. |
| settings UI | `src/components/onboarding/AgentMappingTable.tsx:226` (row label), `:263` (model change rebuilds the config) | the label shows `· ultrafast`. An effort edit keeps `serviceTier`; a model or engine change drops it. There is no tier picker in this change (Deferred). |

### 1.5 Account selection

| seam | file:line | `serviceTier` joins |
|---|---|---|
| direct launch | `resolveHealthySpawnAccount`, `src/lib/accounts/manager.ts:66-143` | the new `serviceTier` argument. For Codex, the accounts that lack the tier go into `selectionInput.unavailableIds`, and a `named` account is checked separately (§4.1). |
| project-owned launch | `accountManager.resolveProjectSpawn`, `manager.ts:601-630`; `ProjectSpawnRequest.unavailableIds`, `src/lib/accounts/contracts.ts:108-110` | nothing new: the caller (`spawnPipelineAgent`) adds the lacking accounts to `unavailableIds`, which is what that field is for ("accounts with terminal evidence that they cannot accept this launch") |
| rule | `selectProjectAccount`, `src/lib/accounts/projectSelection.ts:186-229` | untouched. A non-empty `unavailableIds` already moves an unbound project from "engine default" to a capacity pick among the rest (`projectSelection.ts:201-203`), and that is exactly what a tier needs. |
| catalog read | new `src/lib/accounts/codexServiceTiers.ts` | §3.1 |

### 1.6 Structured Codex host: thread and turn start, and later turns

- **Fresh start**: `thread/start` at `codexAppServerHost.ts:1484-1491` gains
  `serviceTier`.
- **Adoption, restart, resume, migration successor**: `thread/resume` at
  `codexAppServerHost.ts:1478-1482` gains `serviceTier`. The value comes from
  the generation's `launchProfile`, which `mergeResumeLaunchProfile`
  (`src/lib/agent/registry.ts:1133-1142`) must carry:
  `serviceTier: requested.serviceTier ?? current.serviceTier`.
- **First message**: the first-message delivery reaches `turn/start` at
  `codexAppServerHost.ts:1841`. It adds no tier and inherits the thread's.
- **Later turns and steers from agents** (`send_message`, launcher notices): no
  runtime settings, so they inherit.
- **Later turns from the operator's composer**: `sendRuntimeFrom`,
  `src/components/runtimeProfile.ts:204-213`, sends `fast` on every send once a
  runtime profile has been applied. `codexTurnProfile.ts:23` turns that into
  `serviceTierForTurn: "priority"|"default"`, so an operator who only changed
  effort would pull an `ultrafast` reviewer down to `priority` or `default` on
  every later turn. The fix is one line: send `fast` only when
  `profile.fast !== (file.fast ?? null)`, that is, when the operator actually
  changed speed. For every existing conversation this changes nothing, because
  an omitted `fast` inherits the same thread tier the sent one named.
- **Structured reconfigure from the pill**: `RuntimePill.tsx:327` always sends
  `fast` for Codex, and `src/lib/agent/reconfigure.ts:35` requires it. The patch
  lands in `updateConversationLaunchProfile`
  (`src/lib/agent/registry.ts:7370-7380`). The rule there: keep
  `launchProfile.serviceTier` when `patch.fast === isFastTier(current tier)`;
  otherwise set it to `null`. So an operator who picks Standard gets standard,
  and an effort or model change keeps `ultrafast`. After a model change, the
  host-start check (§3.2) refuses a kept tier the new model does not offer, and
  the reconfigure reports that failure. It does not quietly run on a lower tier.
- **Account migration**: `src/lib/accounts/codexAppServer.ts:380-402` (the
  successor's `thread/resume`) and `migration/coordinator.ts:345` carry only
  `fast`. The successor host resumes with the generation's `serviceTier`, and the
  host-start check refuses it on a target account that lacks the tier. The
  migration then fails with the tier named, and the conversation stays on its
  source account. To move it, the operator picks Standard or Fast in the pill
  (which clears the tier) and migrates again. Choosing tier-offering migration
  targets automatically is Deferred.

## 2. Semantics

**Value.** A `serviceTier` is a catalog tier id: lowercase, matching
`^[a-z][a-z0-9_-]{0,31}$` (the bound `commands.ts:33` already uses). `"default"`
is refused as a value, with "use `fast: false` for the standard tier", because no
catalog lists it and one way to ask for standard is enough. `null` on a stage or
on override-stage means "inherit the role default"; on `spawn_agent`, `null` is
the same as omitting it.

**Resolution order, per launch** (first match wins):

1. `serviceTier` from the call or the stage. **Required.**
2. `fast: true` from the call, read as `priority`. **Required.** `fast: false`
   means standard: no tier is sent to the thread on the structured path, and the
   tmux flag stays as it is today.
3. The role row's `serviceTier`, when the launch runs the row's own engine and
   model (`!explicitRuntime` for spawns, and the same test on the resolved stage
   role for stages). **Preferred.**
4. Nothing: today's behaviour, the account's `config.toml` default.

**`fast` and `serviceTier` together.** `fast: true` with `serviceTier:
"priority"` is accepted. `fast: true` with any other tier, or `fast: false` with
any tier, is refused with 400: "fast and serviceTier disagree: fast:true is
serviceTier priority; send one of them". A call-level `fast` of either value
replaces a role default.

**`launchProfile.fast` stays meaningful.** It is written as the resolved tier's
"fast-ness", `isFastTier(t) = t !== null && t !== "default"`, or as the caller's
`fast` when no tier is set. Readers that compare `fast` (`structuredControls.ts:130-133`,
the reconfigure `previousProfile` at `registry.ts:7433-7438`) keep working
unchanged.

**Model required.** A tier needs a resolved model: the call's, the stage's or
the role's. A tier with no model is refused with "serviceTier needs a model: the
account's default model is only known after launch". This never comes up for a
role launch.

## 3. Validation

### 3.1 Before launch, in the Viewer: `src/lib/accounts/codexServiceTiers.ts` (new, ~60 lines)

```ts
export type CodexTierOffer = { id: string; name: string };
/** The tiers one account's catalog lists for one model; null when the catalog
    cannot answer (file missing or unparsable, model absent). Never inferred. */
export function codexModelServiceTiers(home: string, model: string): CodexTierOffer[] | null;
/** Which accounts offer the tier for the model, and what each one offers. */
export function tierOffers(accounts: readonly { id: string; home: string }[], model: string, tier: string):
  { offering: string[]; lacking: string[]; offered: string[] /* union of ids seen, for messages */ };
/** Resolution order §2 plus the shape, engine and fast checks. */
export function codexLaunchTier(input: {
  engine: AgentEngine; model: string | null; fast: unknown; serviceTier: unknown;
  roleDefault?: string | null; roleDefaultApplies: boolean;
}): { tier: string | null; required: boolean; source: "explicit" | "fast" | "role-default" | null } | { error: string };
```

`codexModelServiceTiers` reads `<home>/models_cache.json`: `models[]` where
`slug === model`, then `service_tiers[].id`/`name`. It uses the file's mtime
and size as a cache key, the way the scanner caches work. It does not read
`additional_speed_tiers`, which is deprecated and uses different words. Account
homes come from `listCodexAccounts()` (`src/lib/accounts/codex.ts:380`). The
module is imported by the Viewer's spawn and pipeline paths and by the role
mapping validation. It is never imported by the runtime host.

A missing or stale cache counts as "does not offer". A Codex process refreshes
the file whenever it runs in that home. An account nobody has run since a tier
appeared therefore reads as lacking it until it is next used. That errs toward
refusing, which is what "never guess" asks for.

### 3.2 At host start, in the runtime host: `src/lib/runtime/codexTurnProfile.ts`

The file gains two pure exports. The existing `codexTurnProfile` is untouched.

```ts
/** The thread tier a launch profile asks for. */
export function launchServiceTier(profile: { serviceTier?: string | null; fast: boolean | null }): string | undefined;
  // serviceTier ?? (fast === true ? "priority" : undefined)
/** Refuses a tier the live model/list answer does not list for the model. */
export function assertCatalogOffersTier(catalog: unknown, model: string | undefined, tier: string | undefined): void;
```

`assertCatalogOffersTier` selects the row with the same rule as
`codexTurnProfile.ts:9-10`, reads `serviceTiers[].id`, and throws
`requested Codex service tier <id> is not offered for <model> on this account;
offered: <ids>` when the row, its `serviceTiers` or the whole catalog is
missing. It fails closed: a failed `model/list` means the tier cannot be
confirmed. This is the second check. It catches a catalog that changed between
the Viewer's read and the launch, and it catches a migration or resume onto an
account without the tier (§1.6). The Viewer's check (§3.1) is what refuses a
launch before a receipt exists.

`launchServiceTier` does not map `fast: false` to `"default"` on the thread.
Today a structured launch with `fast: false` sends no tier at all, and that
stays so. The tmux path keeps its own `standard` flag exactly as it is (see
Notes).

## 4. Account selection when only some accounts offer the tier

### 4.1 Direct launch (`spawn_agent`, the board, seats)

In `resolveHealthySpawnAccount` (Codex branch, `manager.ts:112-165`), when a
tier is set:

1. `const { lacking, offering, offered } = tierOffers(listCodexAccounts(), model, tier)`.
2. **Named account** (`requested` given):
   - it offers the tier → proceed as today;
   - it lacks it, and the tier is **required** → throw a 409 refusal: `account
     <label> does not offer serviceTier <tier> for <model> (it offers:
     <ids>); accounts that offer it: <labels>, or omit accountId`;
   - it lacks it, and the tier is **preferred** → proceed without the tier (§6
     reports it).
3. **Nothing named**: `selectionInput.unavailableIds = lacking`.
   - `offering` is empty and the tier is **required** → throw a 409 refusal
     before the pick: `no Codex account offers serviceTier <tier> for <model>;
     offered: <union ids>`;
   - the pick answers `exhausted`/`unavailable` and the tier is **required** →
     the existing `ProjectAccountRefusedError`, with ` (serviceTier <tier> is
     offered by: <labels>)` appended to its detail;
   - the pick answers `exhausted`/`unavailable` and the tier is **preferred** →
     pick again without `unavailableIds`, and launch without the tier;
   - `available` → launch with the tier.
4. The stale-exhaustion live read at `manager.ts:130-132` keeps working. It is
   handed the same narrowed candidate set, so it reads only accounts that offer
   the tier.

The route maps the new refusals to 409 with `code: "service_tier_unavailable"`
and puts no account id in `details`: labels only, the same as other account
refusals.

### 4.2 Pipeline stage

In `spawnPipelineAgent` (`engine.ts:522-531`), `unavailableIds` becomes
`[...input.unavailableAccountIds ?? [], ...lacking]`. An explicit tier with an
empty `offering` set, or a pinned `requestedAccountId` in `lacking`, throws the
same words as §4.1. The stage parks with the reason, and the operator either
repins the account or changes the tier with override-stage. A preferred tier
that finds no account picks again without the extra ids and launches without
the tier.

Choosing inside the pool keeps the #1279 fence as it is. `unavailableIds` only
narrows the candidates and never widens the set. A tier offered only outside a
bound project's pool is therefore "no account in this project's pool offers
it", and the refusal says that.

### 4.3 At `create_pipeline` time

For an **explicit** stage tier, `resolvePipelineRole` (or a check beside it at
`engine.ts:6037`) runs `tierOffers` over the accounts the project allows
(`allowedAccountIdsForProject`), or over the stage's pinned account. When none
offers the tier, it pushes a violation on `stages[i].serviceTier` naming the
offered tiers, and the whole create is refused as it is for a bad effort. A
role-default tier is not refused at create.

### 4.4 The trade-off, stated

Every tier-requiring launch lands on the accounts that offer the tier: today,
`ultrafast` on gpt-6-astra means account C for every reviewer. That account's
quota runs out sooner. When it is exhausted, required-tier reviews refuse until
it resets, and default-tier reviews fall back to the other accounts at their
default speed. This is what the requirement asks for ("prefer an account that
offers it, else refuse"). It is also the reason the reviewer row's default is a
preference and never a requirement: an unattended pipeline keeps moving.

## 5. The role table default

`RoleConfig.serviceTier?` (§1.4). The shipped defaults (`src/lib/roles/defaults.ts`)
set none, so a fresh install behaves exactly as it does today. The operator, or
an orchestrator through `role_presets`, sets it on a row:

```json
{ "overrides": { "reviewer": { "config": { "engine": "codex", "model": "gpt-6-astra", "effort": "high", "serviceTier": "ultrafast" } } } }
```

It is used when the call names no tier and no `fast`, and when the launch runs
the row's engine and model (§2). It is written to a stage's
`effectiveRole.serviceTier` at create, with `serviceTierSource:
"role-default"`, so a later edit of the row does not change a lane that already
exists. This is the same immutability `effectiveRole` has for model and effort.

## 6. Display

**`runtimeLine` and the spawn answer's `runtime`.** `launchRuntimeLabel`
(`src/lib/roles/paramConfig.ts:78-88`) gains two optional inputs,
`serviceTier` and `serviceTierSource`:

- explicit: `reviewer codex/gpt-6-astra/high/ultrafast`
- role default at create: `reviewer codex/gpt-6-astra/high/ultrafast (role default, if offered)`
- spawn, role default applied: `reviewer codex/gpt-6-astra/high/ultrafast`
- spawn, role default not offered by any account that can take it: `reviewer codex/gpt-6-astra/high/default (role default ultrafast not offered by an available account)`
- unset: unchanged, as today

The spawn answer's `runtime` is computed after account selection
(`spawnCommand.ts:1047`), so it reports what the thread really gets. A non-role
spawn that names a tier gets a `runtime` too. The orchestrator prompt line that
already tells seats to quote the runtime (`src/lib/orchestrator/prompt.ts:516`)
needs no change.

**Conversation UI.** The surface exists: `RuntimePill`. Its face is
`src/components/RuntimePill.tsx:709-711` (`{faceModelShort} · {faceTier}`), and
its speed row is `RuntimePill.tsx:1162-1167`.

- `FileEntry` gains `serviceTier?: string | null` (`src/lib/types.ts:255-256`,
  beside `fast`).
- The face appends ` · <tier>` when `file.serviceTier` is set and is not
  `default`. For example: `6-Astra · High · Ultrafast` (desktop). On mobile, the
  chip (`RuntimePill.tsx:655-657`) is unchanged; the tier shows in its sheet.
- The speed submenu `detail` shows the tier's word: `priority` → the existing
  `composer.speedFastTier`; `default` → `composer.speedStandard`; any other id →
  the new key `composer.speedTierNamed` ("{tier} tier"), with the id
  title-cased, in `src/lib/i18n/en.ts` and `uk.ts`.
- `face.fast` is `isFastTier(file.serviceTier)` when the tier is known, so an
  `ultrafast` conversation shows Fast checked, and choosing Standard clears the
  tier (§1.6).

**Scanner.** `src/lib/scanner/effort.ts:103-114` becomes
`entryServiceTier(entry): string | null`:

1. argv: `-c service_tier=<id>`, matched against `^[a-z][a-z0-9_-]{0,31}$` (so
   `ultrafast` is recognized), for tmux Codex;
2. otherwise, the newest `event_msg`/`thread_settings_applied`
   `thread_settings.service_tier` in the transcript tail, then the head. This
   uses the same `tailRecordsResult`/`headRecordsResult` reads and cache pattern
   as `entryEffortResult`, with its own `globalCache("serviceTier")`.

`entryFast` stays, derived as `isFastTier(entryServiceTier(entry))` or `null`.
The call sites `src/lib/scanner/index.ts:350` and
`src/lib/scanner/observe.ts:94` also set `entry.serviceTier`. `standard` in
argv, written by today's tmux `fast: false`, is treated as `default`.

## 7. Tests (each file run by path, under fresh `mktemp -d /tmp/…` `LLV_STATE_DIR`, `XDG_CONFIG_HOME`, `TMPDIR` and `CODEX_HOME`)

Catalog fixtures are written as `models_cache.json` into temp account homes,
with the three-account shape from the facts table: A and B `priority`, C
`priority` and `ultrafast` for gpt-6-astra.

| file | cases |
|---|---|
| `src/lib/accounts/codexServiceTiers.test.ts` (new) | reads `service_tiers[].id`; ignores `additional_speed_tiers`; missing file, bad JSON or absent model → `null`; `tierOffers` splits A/B/C correctly; `codexLaunchTier`: explicit, `fast: true` → priority, `fast: true`+`ultrafast` → error, `fast: false`+tier → error, `"default"` → error, Claude + tier → error, tier with no model → error, role default applied only when `roleDefaultApplies` |
| `src/lib/accounts/managerProjectBinding.test.ts` | direct launch, unbound project, required `ultrafast` → C even when routing points at A; named A + required → refusal naming C and `priority`; named A + preferred → A without the tier; C exhausted + required → exhausted refusal naming C; C exhausted + preferred → A or B without the tier; bound pool {A, B} + required → "no account in this project's pool offers" |
| `src/lib/accounts/projectSelection.test.ts` | `unavailableIds` on an unbound `engine-default` project switches to a capacity pick among the rest (this pins the behaviour the design relies on) |
| `src/app/api/spawn/route.test.ts` | `serviceTier` reaches `launchProfile.serviceTier` on the receipt; the request digest differs by tier; `fast: true` on the structured transport is admitted (the #239 refusal is gone) and records `priority`; 409 `service_tier_unavailable` before any receipt when the tier is not offered; the answer's `runtime` carries the tier |
| `src/lib/runtime/spawnTransport.test.ts` | the gap no longer refuses `fast` |
| `src/lib/runtime/codexTurnProfile.test.ts` | `launchServiceTier`; `assertCatalogOffersTier` accepts a listed id, refuses an unlisted one naming the offered ids, and refuses on a null catalog |
| `src/lib/runtime/codexAppServerHost.test.ts` | with the fixture app-server, `serviceTier: "ultrafast"` appears in `thread/start` params; it appears in `thread/resume` params on adoption; a later `turn/start` and `turn/steer` carry no tier (they inherit); a catalog row without the tier refuses start before `thread/start` is sent |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | the Codex host options carry `launchServiceTier(profile)`, for fresh and resumed launches |
| `src/lib/pipelines/roles.test.ts` | explicit stage tier → `effectiveRole.serviceTier` with source `explicit`; role default applies only on the row's engine/model; Claude stage + tier → error |
| `src/lib/pipelines/stageAccountBinding.test.ts` | stage launch: lacking accounts join `unavailableIds`; a pinned account without the tier parks the stage with the offered tiers named; a preferred tier falls back and launches without it |
| `src/lib/pipelines/engine.test.ts` | create refuses an explicit tier that no account in the pool offers (violation on `stages[i].serviceTier`); override-stage sets it, clears it with `null`, and is refused on a stage that already ran an attempt |
| `src/lib/pipelines/store.test.ts` or the existing store suite | `isStage` accepts a consistent `serviceTier` and refuses one that disagrees with `effectiveRole` |
| `src/lib/mcp/schemaParity.test.ts` | the `create_pipeline` stage property list (`:685`) includes `serviceTier`; `spawn_agent` and `pipeline_action` publish `serviceTier`; a `spawn_agent` call with `serviceTier` reaches the binding unchanged |
| `src/lib/mcp/compactAnswers.test.ts` | `runtimeLine` shows `/ultrafast` and the `(role default, if offered)` form |
| `src/lib/roles/store.test.ts` | a row with `serviceTier` round-trips and writes schema 5; an effort-only patch keeps it; `sameConfig` distinguishes it; a schema-4 file still loads |
| `src/lib/roles/registry.test.ts` | `resolveSpawnRole` exposes the row tier |
| `src/lib/scanner/effort.test.ts` | argv `service_tier=ultrafast`; `thread_settings_applied` in the tail; `standard` → `default` |
| `src/components/RuntimePill.dom.test.tsx` | the face shows `· Ultrafast`; the speed row detail shows the tier word; choosing Standard sends `fast: false` |
| `src/components/runtimeProfile` (the existing test beside it, or `RuntimePill.persistence.dom.test.tsx`) | `sendRuntimeFrom` omits `fast` when it equals the observed `file.fast` |
| `src/lib/agent/registry` tests touching `updateConversationLaunchProfile` (by file path) | an equal fast-ness keeps the tier; a different one clears it; `mergeResumeLaunchProfile` keeps it |

Also required: `bunx tsc --noEmit`, and
`bun scripts/privacy-publication-gate.ts --base <merge-base>`. Fixtures name
accounts `account-a/b/c`, never real labels.

## 8. What not to touch

- **The operator's global and per-account `config.toml` `service_tier`.** It is
  never written. The tier travels only as a thread parameter or as a
  per-process `-c` flag.
- **The operator's Codex homes.** Code reads `models_cache.json` only. No test
  or tool ever points at a real home.
- **`selectProjectAccount` and the #1279 fence.** The design uses the
  `unavailableIds` input the rule already has.
- **`codexTurnProfile`'s existing function and its `auto|default|flex|priority`
  allowlist**, and the per-send `serviceTier`/`serviceTierForTurn` contract. No
  send carries a tier as a result of this change.
- **The native queue** (`src/lib/runtime/nativeCodexQueue*`) and
  `turn/start`/`turn/steer` in the host. They inherit the thread tier.
- **`codexAppServerHost.ts` beyond four spots**, because lane c391d641 edits
  this file (its hunks, measured against this base: `1499-1512`, `1665-1695`,
  `3189-3197`). This change touches only:
  1. `CodexAppServerHostOptions`, around `:187`: add `serviceTier?: string;`
  2. after the `model/list` try/catch, around `:1466`: one line,
     `if (options.serviceTier) assertCatalogOffersTier(provisional.modelCatalog, options.model, options.serviceTier);`
  3. the `resumeThreadTolerantly` params at `:1479-1482`: `...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),`
  4. the `thread/start` params at `:1484-1491`: the same line.

  None of them overlaps the lane's hunks. Hunks 3 and 4 end 8 lines above its
  first hunk, so whichever lane merges second rebases cleanly.
- **The account-migration resume** (`src/lib/accounts/codexAppServer.ts:380-402`).
  It keeps sending `fast` only. The successor host carries the tier (§1.6).
- **Workflows, the orchestrator seat create/rotate fields**
  (`src/lib/orchestrator/seatCommand.ts:1048`), **and review flows.** They are
  not named by the requirement. A seat's `fast` starts working on the
  structured transport as a side effect of removing the gap, with no code there.
- **The live runtime host, port 8898, and live conversations.** No suite under
  `src/lib/agent/` or `src/app/api/runtime/` is swept.

## 9. Compatibility and rollback

- `LaunchProfile.serviceTier` and the stage fields are optional. An older build
  reading a newer receipt or pipeline ignores the field (the pipeline store's
  `isStage` does not refuse extra keys). A lane that rolls back therefore loses
  only the tier, and the next launch runs at the account default.
- The role store refuses unknown keys (`store.ts:51`). Following the #1876
  precedent, a file carrying `serviceTier` is written as **schema 5**, so an
  older build refuses it with "unsupported role override schema: 5" and does not
  misread it. That older build then runs on the shipped role defaults until the
  operator removes the tier or upgrades again. This is the same cost schemas 3
  and 4 already carry.

## Deferred — not currently justified

- **A tier picker** in the role-mapping settings table, in the board's launch
  draft and in the pill. The requirement is satisfied by the MCP, API and
  `role_presets` writes plus the display. A picker needs the per-account
  catalog in the browser.
- **Refreshing a stale `models_cache.json`** by asking the account's app-server
  (`model/list`) from the Viewer. A cache goes stale only for an unused account,
  and the refusal names what to do.
- **Automatic migration that prefers tier-offering targets.** Today a migration
  onto an account without the tier fails loudly (§1.6).
- **Per-turn tiers from the composer** (`serviceTierForTurn` other than
  `priority`/`default`). No surface asks for it.
- **Tiers on workflows, review flows and the seat create/rotate forms.**
- **Replacing `fast` everywhere with `serviceTier`.** `fast` keeps its
  meaning, and nothing is migrated.

## Notes

- **Not verified: what the app-server does with a tier the account lacks.**
  Finding out needs a live thread on an operator account, which is outside this
  stage's fences. The design does not depend on the answer, because the tier is
  refused before `thread/start` by both checks.
- **Vocabulary mismatch in today's `fast: false`.** The tmux path (`cli.ts:437`,
  `cli.ts:576`) and the migration resume (`codexAppServer.ts:402`) write
  `standard`. The protocol documents `"default"` for standard speed, and every
  `config.toml` here says `"default"`. This change leaves those lines alone; the
  scanner reads `standard` as `default`. It is worth a separate small fix after
  someone confirms how Codex 0.159 treats `standard`.
- **What the thread applied is observable.** `thread/start` and `thread/resume`
  responses echo `serviceTier`, and the rollout's `thread_settings_applied`
  records it. The UI reads the rollout (§6), so the pill shows what the engine
  applied rather than what was asked for.
