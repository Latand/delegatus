# Memory profile

Approved 2026-10-11: variant 2, “Profile: summary, slices below”. The profile
belongs to this project and covers everything its agents start with. The
operator chose generation only on “Підсумувати” / “Оновити”, with a “застарів”
line when rules change; export gets a fixed shape now and is built later.
The accompanying instruction was “все ок, роби, але зроби щоб швидко генерилося дуже”.
This implements the request for a readable, localized account of what agents
encountered, separately for each memory slice and overall.

## Scope and presentation

The existing learned-rules entry opens its existing window on the profile.
The overall headline, prose and “What the agents ran into” come first. Below
are cards for each active role scope in this project, each active role scope
across projects, project memory, and machine memory. Empty scopes add no card.
The profile uses existing components and colors at desktop and phone widths.
Topic pills have a maximum width and ellipsis; their full title is available
on hover. Topics open the active rules behind them. Each slice also opens its
full rule list. The All rules view retains removal, Undo, history and Return,
and a rule link from a stage still opens that view on the referenced rule.

## Generation and speed

One button action starts independent direct Messages calls for all changed
slices and the overall summary in parallel. The overall reads the source rules,
with their scope labels, independently of the slice answers. There are no tools
or agent loop. Each completed part is stored and streamed as a complete snapshot
to the page. Closing the window leaves generation running; reopening reads it.

The target on this machine is a first visible result around 3 seconds and a
whole profile around 10 seconds. Measure the real project’s rules and report
cold and cached timings in the PR. Each slice is cached by a hash of its rule
content and short why lines, plus model, prompt version and locale. Unchanged
slices return immediately on Refresh; only changed slices and the overall
regenerate. A failed part retains its previous summary and can be retried.

One model constant selects the catalogue’s Claude Haiku 5.5 entry, now available
on main; before that entry it selects `haiku`. The Messages API rejected the bare `haiku` alias,
so that alias maps to the verified Haiku 4.5 API target. A project Claude account
is selected through the existing account admission policy. Its current OAuth
credential stays inside the direct caller. Provider accounts and expired
credentials are excluded. Unavailable capacity or no eligible credential
produces the account error. No API-key fallback.
Each call has a 30-second deadline and a small maximum output token budget.
Haiku 5.5 uses low effort. The caller reads text blocks and discards thinking
and redacted-thinking blocks; tool calls and incomplete responses still fail.
This follows the [Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide).

## Input, answer and validation

Only active rules enter the compact request: short local number, rule text,
and a short why line. Metadata and persistent ids stay out. Rules are treated
as data. The server owns the number-to-rule map and rejects foreign, zero,
negative or fractional numbers. All prose is requested in the interface locale
at button time (`uk` or `en`). `proseLanguage` checks every prose field; a wrong
language gets exactly one retry. A second mismatch fails that part. Technical
or short text that the detector cannot classify is admitted.

Each slice has a headline of at most 80 Unicode characters, prose of at most
400, and up to five theme titles of at most 60. The overall has a headline of
at most 80, prose of at most 700, and three to six encountered topics with a
title of at most 60 and one sentence of at most 160. Text beyond the limit is
cut at a sentence when possible. The prompt aims for shorter text and two slice themes / three overall
topics so the result stays quick. The structured answer is:

```ts
{ headline: string; text: string;
  topics: { title: string; text?: string; rules: number[] }[] }
```

The aggregate source limit is 120 000 Unicode characters of rules and why
lines. Above it, omit why lines and say so in the prompt. Above it even without
why lines, refuse generation and retain readable raw rules.

## Storage, states and routes

`memory_profile` is a separate collection in `state.sqlite`; `role_memory`
remains unchanged. One row per canonical project and locale stores parts
(scope, content hash, rule ids with changedAt, model, prompt version, answer,
createdAt and duration) and run state. A part retains its own model and prompt
version so a failed upgrade cannot mark old results fresh. Changed-rule counts
use each part's basis and count each rule once per change kind. A fresh overall
keeps the counts of a slice whose refresh failed. Removed rules disappear from
topic links immediately, while the old prose stays until Refresh.

GET `/api/role-memory/profile?project=&locale=` only reads. POST with
`{ project, locale }` requires same origin and operator authority and starts or
joins a run. Its NDJSON stream sends the initial state and each finished part.
The client polls while a reopened run is active and otherwise at the existing
rules refresh cadence. A restarted process reports an interrupted run and
allows retry. Shared running work is held on `globalThis` across route bundles.

The window covers no summary, summarizing, failed, stale and no-rules states.
Generation stays disabled when memory is off or has no active rules. Locale
changes select a separate cached profile and never translate another summary.
The summary’s model, timestamp, language and elapsed time appear in a muted line.

## Privacy

The rules already reach the same provider in agent prompts. The profile stays
in local storage and the window. It is not injected into agents or relayed to
other installations, GitHub, Telegram or MCP. The prompt forbids identities,
paths and secrets in the answer, which the UI renders as plain text. Public
UI fixtures and screenshots contain invented examples. Timing evidence contains
measurement metadata.

## Verification record

The shared browser case in `kanbanBoard.browser.test.tsx` renders the real
window at 1440 and 390 pixels, in light/dark and Ukrainian/English. It also
checks the empty, summarizing, error, stale and no-rules states. All eight
layout combinations have zero horizontal overflow, stay inside the viewport,
and truncate long pills at 240 pixels. See `evidence/memory-profile/geometry.json`.
Screenshots use synthetic rules and were visually inspected; every browser
and fixture server was closed by its owner.

The opt-in timing case uses a private, read-only snapshot of 106 active rules
across six slices, the direct model caller, the profile service, NDJSON and the
real client window. It measures from the button click to a generated headline
intersecting the scroller's visible area, then to the terminal profile state.
Only timing metadata is retained in `evidence/memory-profile/timings.json`.

| Locale | Application cache | First visible | Complete |
| --- | --- | ---: | ---: |
| Ukrainian | Cold | 2.602 s | 6.918 s |
| English | Cold | 2.347 s | 5.151 s |
| Ukrainian | Cached | 0.043 s | 0.053 s |
| English | Cached | 0.019 s | 0.044 s |

The measured model is the `haiku` fallback, mapped to Haiku 4.5. Cold means an
empty application profile cache; the provider's schema cache may already be
warm. The harness supplies a current credential directly and uses an in-memory
storage port; production account admission and SQLite persistence are covered
separately by focused tests. The measurements are observations from this
machine, with seven independent summary jobs per cold locale.

The continuation merged the current catalogue and repeated the rendered checks:
all eight layouts and the five phone states passed. The final focused run
passed 27 tests across seven explicit paths, including pinned model selection
and responses containing thinking blocks. Full TypeScript checking passed
with the repository's standard invocation under isolated state.

**Haiku 5.5 timing verification is blocked.** Direct requests returned HTTP 429
(`rate_limit_error`) on both eligible project accounts with current credentials,
including a minimal request without rules or a schema. An older-target
comparison request returned HTTP 200. A delayed retry through the final
adapter still returned 429. The provider supplied no retry time.
The Haiku 5.5 browser benchmark timed out waiting for a generated headline;
its first-result and completion targets remain unverified. The table above
records the predecessor's Haiku 4.5 observations and establishes no Haiku 5.5
timing claim. See `evidence/memory-profile/haiku-verification.json`.

Focused tests cover scope slicing, number binding, locale retry, cache/stale
behavior, persistence isolation, structured requests, route authority and stream
decoding. They run by explicit path through the owned gate with isolated state.

## 7. Export: the shape for later

The operator: these are abstract rules that could help other people, so the
profile may be exported some day. This section fixes what such a file holds
and what never leaves, so nothing built now has to change for it.

### 7.1 The file

```json
{
  "format": "delegatus.memory-profile",
  "version": 1,
  "exported": "2026-10",
  "language": "en",
  "levels": [
    { "level": "machine",
      "summary": "Readable summary of selected rules",
      "rules": ["Synthetic example rule"] },
    { "level": "role", "role": "architect", "scope": "this-project",
      "summary": "Preparing prototypes and decisions…",
      "rules": ["…"] }
  ]
}
```

- `level` is `machine`, `project` or `role`; a role level names the role id
  and whether it was this project's or every project's.
- `summary` is that slice's stored summary in the stored locale, only when
  it is fresh; the whole's summary is not exported, because it was written
  over levels the file may leave out.
- `rules` are the active rule texts, nothing else.
- `exported` is the month only.

### 7.2 What goes in by default

Machine and roles on every project are checked: they cover general tools and
kinds of work. Roles on this project are unchecked
and can be ticked. The project level is unchecked and says why: it is about
this repository.

### 7.3 The privacy pass

Before the file is offered, every selected rule goes through:

1. its stored `hints` (`staticSensitiveClasses`, `roleStore.ts:199`); a rule
   with a hint stays out unless the operator ticks it after reading it;
2. the publication gate's detectors with this machine's known-value
   fingerprints (`scripts/privacy-publication-gate.ts`, the same check a
   push runs), which catch account names, emails, paths, hosts and tokens;
3. a check that no project key, repository name or remote of this
   installation appears in it.

A rule caught by 2 or 3 stays out and is listed with the reason. The file
is written by the browser to the operator's disk; nothing is sent anywhere.

### 7.4 What never leaves the machine

Rule ids and version ids; why lines; `source` (project key, pipeline,
stage, attempt, conversation, the writer's role, fix round); every
timestamp but the month; merged, archived and rewritten rules and their
history; scope keys with project keys; the whole's summary; staleness and
run records; any rule the pass in 7.3 holds back.

One consequence to know: every rule text is a known value of the
publication gate on this machine (`roleStore.ts:512-545`), so an exported
file committed to a repository from this machine is refused by the hooks.
That is the gate working; a file meant for a public place is shared from
outside it.
