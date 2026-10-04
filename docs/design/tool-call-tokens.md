# Context tokens per tool call

Brief for the builder. Status: design, ready to implement.

## 0. Originating requirement

Operator, 2026-10-01, by voice, in Russian (verbatim):

> "Я бы хотел увидеть каким-то образом, сколько Tool Call съел, скажем,
> контекста в тысячах, наверное, если там такая информация. [...] можно, в
> принципе, сразу делать [...] числом вставить. Вот сейчас есть тайминг, там
> пишется, например, 352 миллисекунды. Возможно, можно вставить как раз сколько
> токенов сняло. Если я навожу на это число, [...] подсвечиваться, типа что это
> количество токенов. Ну и, соответственно, нужно какое-то ранжирование, чтобы
> оно подсвечивало, если какой-то Tool Call прям много занял токенов, то есть,
> например, [...] до 1000, потом до 10000 токенов, а потом до 20000 токенов и
> выше."

In English: show how much context each tool call used, in thousands, as a
number next to the existing duration ("352 ms"). Hovering the number explains
that it is a token count. Rank the numbers by size so that heavy calls stand
out: under 1 000, up to 10 000, up to 20 000, and 20 000 and above.

The pinned acceptance criteria (tooltip in en + uk, "approximately" for
estimates, four bands, no fake zero, nothing while running, the same meaning
everywhere, computed once during parsing) are restated where each is met.

## 1. Decisions in one screen

| Question | Decision |
|---|---|
| What the number means | Tokens by which this call's result grew the conversation's context. One definition for both engines. |
| Primary source | **Measured**: the provider's prompt size on the response after the call, minus the prompt size on the response that issued it, minus that response's own output tokens. |
| Parallel calls | The measured growth of the round is split among its calls in proportion to result size; each share is marked approximate. |
| Fallback | **Estimate** from the result's characters: Claude 2.4 chars/token, Codex 3.6 chars/token (calibrated below), marked approximate. |
| No number | Running call; result with a picture and no measurement; empty result with no measurement; engines other than Claude and Codex. |
| Where computed | `src/components/feed/contextTokens.ts` (new, pure) driven from `createFeedSession` in `src/components/feed/parse.ts`; stored on `ToolEvent.contextTokens` and `CmdGroupItem.contextTokens`. |
| Label | `352` / `9.8k` / `12.4k` / `123k` / `1.2M`, floored; `~` prefix when approximate. |
| Bands | `<1 000` muted · `1 000–9 999` `text-warning` · `10 000–19 999` new `text-caution` · `≥20 000` `text-danger` semibold. |
| Tooltip | Native `title` on the caption, en + uk, three wordings (measured, shared, estimate) plus a group wording. |

## 2. Observation: what the transcripts carry

Sources read on this machine on 2026-10-01: 600 Claude transcripts from the
shared Claude projects store (Opus 5.5, Sonnet 5.5, Fable 5.1, Opus 5,
Sonnet 5, Haiku 4.5; Claude Code 2.1.241–2.1.257) and 300 Codex rollouts from
`~/.codex/sessions` (CLI 0.142 through the September builds; gpt-5.5 and
gpt-6-astra). Only sizes and record types were extracted; no content is quoted
here.

### 2.1 Claude

- Each API response is written as **one JSONL line per content block**
  (`thinking`, `text`, `tool_use`), all lines sharing `message.id` and
  `requestId`. Every line carries the same `message.usage`; `output_tokens`
  was identical across the lines of one response in all 3 951 lines checked.
- `usage` has `input_tokens` (single digits once caching is warm),
  `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`.
  The prompt size of the response is the sum of the first three:
  `P = input + cache_read + cache_creation`. The cache split is irrelevant
  here; only the sum matters.
- **Parallel calls** are several `tool_use` lines under one `message.id`.
  Their `tool_result`s arrive in user records (one per result, or several in
  one record) before the next response.
- There is **no per-tool token field** anywhere. `toolUseResult` holds
  stdout/stderr/file metadata only. The `total_tokens_reminder` attachment
  (`<total_tokens>N tokens left`) is a session budget; its deltas mix input
  and output across whole requests and cannot be attributed to a call.
- `output_tokens` includes thinking. Within a tool loop the thinking stays in
  the next prompt: rounds with small results show it clearly (a response with
  1 680 output tokens followed by a 62-character result grew the next prompt by
  1 740, i.e. 60 beyond the output).
- Records between two responses besides tool results: bookkeeping lines
  (`last-prompt`, `atis-latch`, `file-history-snapshot`, `system` hook
  summaries) that are not sent to the model, and `attachment` records that
  are. Most attachments are small reminders. The ones that measurably inflate
  the growth are listed in §3.3.

### 2.2 Codex

- Every model response produces an `event_msg` `token_count` with
  `info.last_token_usage` = `{ input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens, total_tokens }` and a running
  `info.total_token_usage`. `input_tokens` **includes** `cached_input_tokens`
  (e.g. 27 153 input, 25 984 cached), so `P = last_token_usage.input_tokens`.
  `output_tokens` includes reasoning.
- The `token_count` of response *k* is written **after** the outputs of the
  calls that response issued (it is flushed late), and always before the first
  item of response *k+1*. Newer rollouts also write a `token_usage_record`
  with a `response_id` right after the call item; its `usage` equals the later
  `token_count`'s `last_token_usage`. The parser already hides both as service
  records.
- A `token_count` can repeat for the same response (10 of 734 in one rollout).
  A repeat has the same `total_token_usage.total_tokens` as the previous one.
- **Parallel calls** (June–July rollouts, CLI 0.142): N `function_call` items,
  then N `function_call_output` items, then one `token_count`. In one rollout
  179 of 496 rounds were parallel.
- **Code mode** (September rollouts): parallel function calls are gone (0 of
  7 825 rounds). The model issues one `custom_tool_call` named `exec`; its
  nested operations appear as `event_msg` `item_completed` items with ids
  `exec-…` (`CommandExecution`, `McpToolCall`, `Extension`), then one
  `custom_tool_call_output` carries what the script returned to the model.
  The feed hides the outer `exec` when its nested items fully represent it
  (`representedExecs`, `parse.ts:2156`) and shows the nested items instead.
- `exec_command` outputs start with a preamble that includes
  `Original token count: N`. That count is taken **before** Codex truncates
  the output: one call reported 28 359 005 for an output of 40 170 characters
  that the model actually received. It is not what entered the context.
- Picture outputs are `input_image` parts carrying a base64 data URL. One
  result was 2.3 million characters of JSON and grew the next prompt by 2 250
  tokens.

### 2.3 Calibration of the estimate

Rounds with one call, a text-only result of at least 3 000 characters and no
user message, compaction or inflating attachment between the two responses.
Ratio = result characters / measured growth.

| Engine, models | Rounds | chars/token p10 | p25 | p50 | p75 | p90 |
|---|---:|---:|---:|---:|---:|---:|
| Claude, all recent | 5 070 | 1.98 | 2.21 | 2.37 | 2.51 | 2.66 |
| Claude Opus 5 | 1 325 | 2.12 | 2.27 | 2.41 | 2.54 | 2.68 |
| Claude Sonnet 5.5 | 407 | 1.96 | 2.13 | 2.33 | 2.48 | 2.68 |
| Claude Fable 5.1 | 369 | 1.95 | 2.16 | 2.34 | 2.49 | 2.62 |
| Claude Haiku 4.5 | 25 | 2.25 | 2.49 | 2.88 | 3.37 | 3.41 |
| Codex (gpt-5.5, gpt-6-astra) | 2 721 | 3.02 | 3.27 | 3.55 | 3.84 | 4.14 |

UTF-8 bytes per token spread no tighter than characters, so the estimate uses
the string length the parser already has. Constants: **Claude 2.4, Codex 3.6**.
Across p10–p90 the estimate is within about ±15 % of the measurement.

### 2.4 How often a measurement exists

| Engine | Tool rounds | Measurable (clean, positive growth, every result present) |
|---|---:|---:|
| Claude, 120 newest transcripts | 8 293 (1 391 parallel) | 7 986 (96.3 %) |
| Codex, 120 newest rollouts | 7 825 | 7 779 (99.4 %) |

So the estimate is a fallback for a few percent of settled rounds, plus the
newest round of a live conversation until the model's next response lands.

### 2.5 Prior work

`search_transcripts` for "tool call tokens context per tool call", "сколько
токенов съел tool call" and "tool result token estimate
cache_read_input_tokens growth", project-scoped and unscoped, found only this
task's own prompt and the orchestrator turn that relayed it. The repository has
no tokenizer (`tiktoken`, `gpt-tokenizer` and `@anthropic-ai/tokenizer` are
absent from `package.json`); the nearest precedent is the byte ceiling in
`src/lib/asks/jev.ts:93`, a cost ceiling of one token per UTF-8 byte.
`src/lib/scanner/context.ts` reads the same usage fields for the context meter
and stays untouched (§11).

## 3. Attribution method

### 3.1 Definitions

A **round** is one model response that issued at least one tool call,
together with the results of those calls. Its **members** are the ids of every
call the response issued (Claude `tool_use.id`; Codex `call_id` of
`function_call`, `custom_tool_call`, `local_shell_call`).

For a round *k* with prompt size `P_k` and output `O_k`, and the next
response's prompt size `P_{k+1}`:

```
growth_k = P_{k+1} − P_k − O_k
```

`growth_k` is what the round's results added to the context, measured by the
provider.

### 3.2 When each basis applies

Evaluated when the next response's usage arrives (resolution) and, for the
estimate, when a result attaches.

1. **measured** — the round has exactly one member, and the round is
   *eligible* (§3.3). `contextTokens = { n: growth_k, basis: "measured" }`.
2. **shared** — the round has two or more members and is eligible. `growth_k`
   is split by the largest-remainder method over weights = each member's result
   characters, a picture counting as `1 600 × chars-per-token` characters, and
   each share is floored at 1. `contextTokens = { n: share, basis: "shared",
   round: { total: growth_k, calls: members } }`.
3. **estimate** — no eligible measurement for this call (yet or ever), the
   result has at least one character of text and no picture, and the engine
   has a ratio. `n = round(chars / ratio)`, floored at 1.
   `contextTokens = { n, basis: "estimate" }`.
4. **none** — anything else: the call is running; the result carries a
   picture and no measurement exists; the result is empty and no measurement
   exists; the engine is neither Claude nor Codex. The field stays absent and
   nothing renders. A zero is never stored.

An estimate is replaced by measured or shared when the round resolves. A
measured or shared value is never replaced by an estimate.

### 3.3 Eligibility

A round is eligible only when all of these hold:

- **Growth is positive.** `growth_k ≤ 0` (a Claude context edit, a thinking
  drop the parser did not see) makes the round ineligible.
- **Every member has a result and a card.** Each member id has had a result
  attached and `calls.get(id)` exists. A hidden member (Claude `ToolSearch` or
  another schema loader in `schemaLoaderCalls`, a `SendMessage` rendered as a
  `tmsg`, a Codex `web_search_call` with no output item) makes the whole round
  fall back to estimates, because its cost would otherwise land on a visible
  sibling. Observed: `ToolSearch` + `Bash` grew the prompt by 5 380 tokens for
  a 933-character Bash result, because the loaded tool schemas entered the
  context.
- **Nothing else entered the prompt between the two responses.** The round is
  marked *contaminated* by:
  - Claude: a `user` record whose content is a string or holds any part other
    than `tool_result` (typed text, an interruption notice, a pasted image,
    `isMeta` skill text); an `attachment` whose `attachment.type` is one of
    `queued_command`, `edited_text_file`, `environment`, `file`,
    `nested_memory`, `hook_additional_context`, `deferred_tools_delta`,
    `mcp_instructions_delta`, `agent_listing_delta`, `skill_listing`,
    `instructions`, `compact_file_reference`, `thinking_drop`; a
    `system` record with `subtype: "compact_boundary"`; a record with
    `isCompactSummary: true`.
  - Codex: a `response_item` `message` whose role is not `assistant`; an
    `event_msg` `user_message` or `context_compacted`; a `compacted` record.

  Contamination marks the most recent unresolved round that has members. For
  Codex this is the in-progress group when its `token_count` has not arrived
  yet, which is why the flag must travel with the group.

  The attachment list comes from measurement: over 5 070 clean rounds the
  median ratio was 2.37; rounds carrying `queued_command` showed 1.99 (p10
  1.02), `edited_text_file` 1.91, `environment` 2.07, while
  `prompt_snapshot` (2.35) and `async_hook_response` (2.46) did not move it.
  The remaining listed types add prompt content by construction. An unknown
  future attachment type counts as benign: the everyday reminders did not
  shift the ratio, and a stale list degrades to a slightly high number, which
  the next calibration catches.
- **The round opened inside this parse.** The first round the ledger opens
  after a `reset()` is never eligible, because a paginated window can start in
  the middle of a Claude response's lines or between a Codex group's calls
  and its `token_count`.

### 3.4 Engine specifics

**Claude**
- Skip lines with `isSidechain: true` and assistant lines whose
  `message.model` is `<synthetic>`.
- A response is identified by `message.id`, falling back to `requestId`.
  `P` is read from its first line; `O` is the maximum `output_tokens` across
  its lines.
- An assistant line with usage and a new id **resolves** the open round with
  its `P` as `P_{k+1}`, then opens a new round for its own id. Members are
  added from each `tool_use` part of that id's lines.

**Codex**
- Calls registered since the last accepted `token_count` belong to the
  response that the next accepted `token_count` describes.
- On a `token_count` with `info.last_token_usage`: skip it when
  `info.total_token_usage.total_tokens` equals the previous accepted one.
  Otherwise resolve the previous round (if any) with this `input_tokens` as
  `P_{k+1}`, then turn the accumulated calls into a new round with
  `P = input_tokens`, `O = output_tokens`. A response with no calls (a final
  message) still resolves the previous round and opens nothing.
- **Code mode.** When the outer `exec` is represented by nested items, its
  value (measured, shared or estimate) is split over those nested items with
  the same largest-remainder rule, weighted by each nested item's output
  characters, basis `shared` with `round.calls` = the nested count; one
  nested item takes the value unchanged. The parser records the nested ids at
  the point it adds the outer id to `representedExecs` (`execWindow.seen`).
  Nested `exec-…` items of an outer `exec` that stays visible get no number,
  since the outer card already shows it.
- Thread-item tools that are no model call (the camelCase
  `commandExecution`/`mcpToolCall` shapes of the 0.151 fixtures) are never
  round members and get the estimate only.

## 4. Worked examples (real transcripts, sizes only)

### Example 1 — Claude, one call (Sonnet 5.5, `Bash`)

| | input | cache read | cache creation | P | output |
|---|---:|---:|---:|---:|---:|
| Response that issued the call | 2 | 49 018 | 1 465 | 50 485 | 286 |
| Next response | 2 | 50 483 | 10 094 | 60 579 | |

Result: 26 024 characters of text. Nothing else between the responses except
a `total_tokens_reminder`.

- growth = 60 579 − 50 485 − 286 = **9 808**, basis measured.
- Caption **`9.8k`**, band 1 000–9 999 (amber). Tooltip: "9,808 tokens added
  to the context by this call".
- The estimate would be 26 024 / 2.4 = 10 843 (`~10.8k`, orange). This round
  is why the measurement comes first: near a band edge the estimate's ±15 %
  changes the colour.

### Example 2 — Claude, three parallel calls (Opus 5.5, three Viewer MCP reads)

| | input | cache read | cache creation | P | output |
|---|---:|---:|---:|---:|---:|
| Response that issued the calls | 2 | 45 940 | 11 596 | 57 538 | 446 |
| Next response | | | | 79 886 | |

growth = 79 886 − 57 538 − 446 = **21 902**, shared by result size:

| Call | Result chars | Share | Caption | Band | Estimate alone |
|---|---:|---:|---|---|---:|
| `seat_tick_settings` | 6 411 | 2 911 | `~2.9k` | amber | 2 671 |
| `conversation_messages` | 36 232 | 16 451 | `~16.4k` | orange | 15 097 |
| `list_pipelines` | 5 593 | 2 540 | `~2.5k` | amber | 2 330 |

Tooltip on the middle one: "Approximately 16,451 tokens added to the context
by this call: its share, by result size, of 21,902 measured for 3 parallel
calls".

### Example 3 — Codex, four parallel `exec_command` calls (gpt-5.5, CLI 0.142)

| | input (incl. cached) | cached | P | output (incl. reasoning) |
|---|---:|---:|---:|---:|
| Response that issued the calls | 27 153 | 25 984 | 27 153 | 699 (134) |
| Next response | 59 848 | 27 008 | 59 848 | |

growth = 59 848 − 27 153 − 699 = **31 996**, shared:

| Call | Output chars | Share | Caption | Band | Estimate alone | `Original token count` |
|---|---:|---:|---|---|---:|---:|
| 1 | 5 710 | 1 914 | `~1.9k` | amber | 1 586 | 1 402 |
| 2 | 33 970 | 11 389 | `~11.3k` | orange | 9 436 | 8 467 |
| 3 | 15 584 | 5 225 | `~5.2k` | amber | 4 329 | 3 870 |
| 4 | 40 170 | 13 468 | `~13.4k` | orange | 11 158 | 28 359 005 |

The last column shows why the preamble count is unusable: call 4's command
printed far more than the model received.

### Example 4 — Codex code mode with a picture (gpt-6-astra)

One `exec` with a single nested `CommandExecution`. The output held 1 194
characters of text plus one `input_image` (2.3 million characters of
base64). P 50 150, output 131, next P 52 531: growth **2 250**, measured,
caption `2.2k` on the nested row when the feed represents the `exec` by it,
on the `exec` row otherwise. With no measurement this result would show
nothing: a text estimate (332) would understate it sevenfold.

## 5. Implementation

### 5.1 Types (`src/components/feed/parse.ts`)

Add to `ToolEvent` (after `endTs`, `parse.ts:~137`):

```ts
/** Tokens this call's result added to the conversation's context
    (docs/design/tool-call-tokens.md). Absent while the call runs and
    whenever the transcript gives no basis; never zero. */
contextTokens?: ContextTokens;
```

Add `contextTokens?: ContextTokens` to `CmdGroupItem` (`parse.ts:241`).

Extend `ToolOutput` (`parse.ts:722`) with `rasters?: number`: the count of
`image`/`input_image` parts `toolOutputFromBlocks` saw, drawable or not
(an undrawable one still becomes a text placeholder, and still costs tokens).

### 5.2 New module `src/components/feed/contextTokens.ts`

Pure, no React, no i18n imports except the tooltip helper at the end.

```ts
export type ContextTokens = {
  n: number;                                   // integer ≥ 1
  basis: "measured" | "shared" | "estimate";
  round?: { total: number; calls: number };    // shared only
};
export const CHARS_PER_TOKEN: Partial<Record<FeedEngine, number>> = { claude: 2.4, codex: 3.6 };
export const PICTURE_TOKENS = 1_600;           // split weight only, never shown alone
export function estimateContextTokens(engine: FeedEngine, chars: number, rasters: number): ContextTokens | undefined;
export function splitRound(total: number, weights: readonly number[]): number[];   // largest remainder, each ≥ 1
export function formatContextTokens(t: Pick<ContextTokens, "n" | "basis">): string; // §6
export function contextTokenBand(n: number): 0 | 1 | 2 | 3;                         // §7
export function sumContextTokens(events: readonly Pick<ToolEvent, "status" | "contextTokens">[]): ContextTokens | undefined; // §9
export function contextTokensTitle(t: ContextTokens, scope: "call" | "calls", locale: Locale): string;                    // §8
export function createContextLedger(engine: FeedEngine, apply: (id: string, value: ContextTokens) => void): ContextLedger;
```

`ContextLedger` holds the §3 state and exposes:

- `claudeResponse(id: string, prompt: number, output: number)` — call on every
  Claude assistant line with usage; resolves and opens rounds per §3.4.
- `codexUsage(prompt: number, output: number, totalTokens: number)` — call on
  every `token_count` with `info.last_token_usage`.
- `member(id: string)` — a call the current response issued.
- `result(id: string, chars: number, rasters: number)` — a result attached.
- `contaminate()` — §3.3 records.
- `represent(outerId: string, nestedIds: string[])` — code mode.
- `reset()`.

The ledger calls `apply(id, value)` for every value it settles (the estimate
at `result`, the measured or shared value at resolution). It keeps result
sizes in a `Map<string, { chars; rasters }>` and discards a round once
resolved, so memory stays bounded by one open round plus the represented map
entries of rows still in `entries`.

### 5.3 Wiring in `createFeedSession` (`parse.ts:1528`)

- Create the ledger once per session with the feed's engine; `apply` patches
  the event copy-on-write exactly as `patchWakeupEvent` does
  (`parse.ts:~1905`): new `ToolEvent` with `contextTokens`, `callRec.event`
  updated, `entries[idx]` replaced, `snapshot = null`. If the value equals the
  stored one (same `n` and `basis`), do nothing, so no row changes identity for
  nothing.
- `reset()` (`parse.ts:3388`) calls `ledger.reset()`.
- `renderClaude` (`parse.ts:3013`): in the `assistant` branch, before the
  content loop, read `message.id`/`requestId`, `usage`, `isSidechain`, model
  and call `ledger.claudeResponse`; call `ledger.member(id)` for every
  `tool_use` part, including `SendMessage`, `ScheduleWakeup` and schema
  loaders. In the `user` branch call `ledger.contaminate()` for a string
  content or any non-`tool_result` part, and for `isCompactSummary`. Handle
  `attachment` records with a listed type and `system`
  `compact_boundary` by calling `ledger.contaminate()` before their existing
  handling.
- `renderCodex` (`parse.ts:2818`): in the `event_msg` branch, before the
  `token_count` line is sent to `addSvc`, call `ledger.codexUsage`. Call
  `ledger.member` for `function_call`, `custom_tool_call` (including
  `apply_patch`) and `local_shell_call` ids. Call `ledger.contaminate()` for
  the §3.3 Codex records (next to their existing handlers:
  `addCodexResponseUser`, `addCodexEventUser`, `context_compacted`,
  `compacted`).
- `attach()` (`parse.ts:2008`) takes one more optional argument
  `measure?: { chars: number; rasters: number }` and, after the event is
  written, calls `ledger.result(event.id, …)`. `addOutput` passes
  `{ chars: output.length, rasters: toolOutput.rasters ?? 0 }` from the raw,
  uncapped output string it already receives, before `cleanOutputText` and the
  preview cap. `emitCodexThreadTool` and the `mcp_tool_call_end` path pass the
  same from `toolOutput(...)`. Claude's string branch passes
  `part.content.length`, `0`.
- Where `representedExecs.add(callId)` runs (`parse.ts:2156`), call
  `ledger.represent(callId, [...execWindow.seen])` before `execWindow` is
  cleared.
- Group build in `buildSnapshot` (`parse.ts:~3565`, the branch that builds a
  fresh `CmdGroupItem`): set `contextTokens: sumContextTokens(grouped items)`
  when defined. The existing reuse check compares call identity, so a patched
  member rebuilds its group.
- `coalesceFollowUps` (`toolBlocks.ts:82`): in the loop that already sums
  `elapsedMs`, collect the poll events; `PollRow` receives
  `contextTokens = sumContextTokens(events)` computed there. Add
  `contextTokens?: ContextTokens` to the `polls` variant of `ToolChild`.

Nothing is computed at render time beyond formatting a label and picking a
class from `n`.

## 6. Formatting rule

`formatContextTokens` builds the caption. Floors, so a label never claims a
band the count has not reached:

| n | Label |
|---|---|
| 1 – 999 | the integer: `352` |
| 1 000 – 99 999 | `floor(n / 100) / 10` + `k`, trailing `.0` dropped: `1k`, `9.8k`, `9.9k` (for 9 999), `10k`, `12.4k`, `16.4k` |
| 100 000 – 999 999 | `floor(n / 1 000)` + `k`: `123k` |
| ≥ 1 000 000 | `floor(n / 100 000) / 10` + `M`: `1.2M` |

`~` prefixes the label when the basis is `shared` or `estimate` (`~12.4k`,
`~352`). The separator `.` and the suffix `k`/`M` are the same in both
locales, like the duration caption (`1.5s` / `1.5 с`), which also prints a
plain number. The tooltip carries the full localized count.

## 7. Bands and colour

`contextTokenBand(n)` uses the raw `n`:

| Band | Range | Class | Light | Dark | Min. contrast over the 6 surfaces |
|---|---|---|---|---|---|
| 0 | < 1 000 | `text-muted` (same as the duration) | `#6c6c79` | `#8b8b98` | 4.51 / 5.11 |
| 1 | 1 000 – 9 999 | `text-warning` | `#8a5f00` | `#e0ae45` | 4.92 / 8.43 |
| 2 | 10 000 – 19 999 | `text-caution font-medium` (**new token**) | `#b24a0a` | `#f08a4b` | 4.72 / 6.91 |
| 3 | ≥ 20 000 | `text-danger font-semibold` | `#c62828` | `#f07171` | 4.90 / 5.98 |

Surfaces: canvas, card, sunken, board, well, quiet, as pinned by
`src/styles/tokens.contrast.test.ts`.

The new token `--color-caution` goes into `src/styles/tokens.css` in all
three places a colour role lives: the `@theme static` block (light, next to
`--color-warning`), the `prefers-color-scheme: dark` block and the
`[data-theme="dark"]` block. No `-soft` companion: the caption has no fill.
Add a `caution` row to the §1.5 table in `docs/design/viewer-design-system.md`
and add `caution` to the floors and the documented-rows check in
`tokens.contrast.test.ts`.

Band 3 reuses the danger red. The chrome reserves red for failure, and here it
marks a heavy call; the weight (semibold) and the absence of the danger edge
and soft fill keep it apart from an error row. The operator asked for red at
20 000 and above.

The caption carries `data-context-band="0|1|2|3"` and
`data-context-basis="measured|shared|estimate"` for tests.

## 8. Tooltip text

Rendered as the caption's native `title`, the same mechanism the row already
uses for the summary. `{n}` and `{total}` are formatted with
`Intl.NumberFormat("en-US" | "uk-UA")`; `count` (the raw `n`) selects the
plural form.

**en** (`src/lib/i18n/en.ts`, next to `tools.durationMs`)

| Key | Text |
|---|---|
| `tools.contextTokens.measured` | one: `{n} token added to the context by this call`; other: `{n} tokens added to the context by this call` |
| `tools.contextTokens.shared` | `Approximately {n} tokens added to the context by this call: its share, by result size, of {total} measured for {calls} parallel calls` |
| `tools.contextTokens.estimate` | one: `Approximately {n} token added to the context by this call, estimated from the size of its result`; other: `Approximately {n} tokens added to the context by this call, estimated from the size of its result` |
| `tools.contextTokens.groupMeasured` | `{n} tokens added to the context by these calls` |
| `tools.contextTokens.groupEstimate` | `Approximately {n} tokens added to the context by these calls` |

**uk** (`src/lib/i18n/uk.ts`)

| Key | one | few | many / other |
|---|---|---|---|
| `tools.contextTokens.measured` | `Цей виклик додав до контексту {n} токен` | `… {n} токени` | `… {n} токенів` |
| `tools.contextTokens.shared` | `Цей виклик додав до контексту приблизно {n} токен: його частка за розміром результату з {total}, виміряних для паралельних викликів ({calls})` | `… приблизно {n} токени: …` | `… приблизно {n} токенів: …` |
| `tools.contextTokens.estimate` | `Цей виклик додав до контексту приблизно {n} токен, оцінка за розміром результату` | `… приблизно {n} токени, …` | `… приблизно {n} токенів, …` |
| `tools.contextTokens.groupMeasured` | `Ці виклики додали до контексту {n} токен` | `… {n} токени` | `… {n} токенів` |
| `tools.contextTokens.groupEstimate` | `Ці виклики додали до контексту приблизно {n} токен` | `… приблизно {n} токени` | `… приблизно {n} токенів` |

"…" stands for the unchanged start of the same sentence; write the full
strings in the dictionary. The en `shared`, `groupMeasured` and
`groupEstimate` entries are plural objects too (`one` never occurs in
practice for them but the key shape stays uniform).

## 9. Where it shows

Every surface that renders a tool duration today, each placing the caption
**immediately after the duration** and before the clock time:

| Surface | File | Placement |
|---|---|---|
| `ToolLine` (every standalone tool row, desktop and phone) | `src/components/feed/cards/ToolCard.tsx:344` | own `shrink-0` span after the duration span |
| `ToolBlockRow` (rows inside an open group) | `ToolCard.tsx:302` | same |
| `MobileRunRow` (phone run block) | `ToolCard.tsx:444` | inside the trailing meta span: `exit · time · duration · ~12.4k`, the token part its own coloured child span |
| `PollRow` (coalesced polls) | `ToolCard.tsx:281` | own `shrink-0` span after the truncating detail span; value = sum of the polls |
| `DesktopCmdGroup` header | `src/components/feed/cards/CmdGroupCard.tsx:165` | after the duration, before the time range; value = `item.contextTokens` |
| `McpCallCard` | `src/components/runtime/McpCallCard.tsx:128` | after the duration, before the time |

A shared `ContextTokensCaption({ value, scope })` component in
`src/components/feed/cards/ContextTokensCaption.tsx` renders
`<span class="shrink-0 whitespace-nowrap text-caption tabular-nums …band">`
with the `title` and data attributes. When a duration precedes it on the same
row, it starts with a muted `·` (`aria-hidden`, `mx-1`), so the pair reads
`352ms · 12.4k` as the operator described. Without a duration it renders the
label alone. `MobileRunRow` passes the dot through its existing ` · ` join and
uses the component for the value only.

**Group sums** (`sumContextTokens`): add the `n` of every member that has one.
Undefined when no member has one. Basis `measured` only when every settled
member is `measured`; otherwise `estimate`, which selects the group
wording with "approximately". Running members are skipped. The band applies to
the sum.

Not touched: `LiveTurnRows` (the structured live overlay renders
`ToolLine`/`McpCallCard` with events built from runtime frames; they carry no
`contextTokens`, so nothing shows until the transcript row replaces them),
`MobileCmdGroup`'s collapsed header (it shows a time range and no duration),
`ResponseDuration`, `WakeupCard`.

## 10. States

| State | What renders |
|---|---|
| Running (`status === "run"`) | nothing; the field is never set before a result attaches |
| Result attached, round not resolved yet (live tail) | estimate `~…` in its band, or nothing when the result has a picture or is empty |
| Round resolved, one call | measured, no `~` |
| Round resolved, parallel calls or nested code-mode items | shared `~…` |
| Round ineligible (§3.3) | the estimate stays |
| Engine other than Claude/Codex, or no basis | nothing |
| Error result | same rules; an error's text also enters the context |

The switch from `~10.8k` to `9.8k` when the next response lands is expected
and happens once per round.

## 11. Layout: 390 px and desktop

- The caption is `shrink-0 whitespace-nowrap`; it never wraps and never
  truncates. The summary span stays `min-w-0 flex-1 truncate` and gives up
  the width, as it already does for the duration and the time.
- Widest label: `~123.4k` cannot occur (≥ 100 000 prints `123k`), so the
  widest is `~99.9k` or `~123k`, about 40 px at `text-caption` tabular.
- At 390 px, worst-case row (error status chip `exit 127`, duration `59s`,
  `~99.9k`, time): the title keeps at least 96 px (6rem) and the row's height
  equals the same row without the caption.
- Desktop (1440 px): same order, no change in row height.
- `McpCallCard`'s title keeps its `min-w-[6rem]` floor; entity chips give way
  first as they do today.
- Hover works on desktop. Phones have no hover; the caption is readable
  without the tooltip, and the tooltip is deferred there (§14).

## 12. What not to touch

- Fenced lanes: board maintenance, the seat-tick settings UI, `src/lib/monitor`
  (lane d56a3158); install ping, telemetry, the Settings telemetry toggle,
  `README` (lane 8ad423ea).
- `AGENTS.md`, `CLAUDE.md`.
- The context meter (`src/lib/scanner/context.ts`, `CtxUsage`), the session
  reader and the MCP `conversation_messages` output.
- Duration computation (`duration.ts`, `toolDurationMs`, the `durationMs`
  fields).
- `LiveTurnRows` and the runtime overlay.
- No tokenizer dependency, no server route, no persisted state.

## 13. Tests

Run each file by path with `bun test <file>`; run `tsc` under
`flock /var/tmp/llv-heavy-gate.lock`. No directory sweeps.

1. `src/components/feed/contextTokens.test.ts` (new, pure):
   `formatContextTokens` table of §6 including 999, 1 000, 9 999, 10 000,
   99 999, 100 000, 1 234 567 and the `~` prefix; `contextTokenBand` at
   999/1 000/9 999/10 000/19 999/20 000; `splitRound` reproduces Examples 2
   and 3 exactly and floors shares at 1; `estimateContextTokens` returns
   undefined for 0 chars, for any raster and for `openclaw`/`copilot`.
2. `src/components/feed/contextTokens.parse.test.ts` (new): synthetic JSONL
   built from the sizes in §4 (results are `"x".repeat(chars)`), fed through
   `buildFeed`:
   - Example 1 → `9 808`, measured; before the next response is appended the
     same call holds the estimate `10 843`.
   - Example 2 → `2 911 / 16 451 / 2 540`, shared, `round.total 21 902`.
   - Example 3 → `1 914 / 11 389 / 5 225 / 13 468`, shared, including the late
     `token_count` order and a duplicate `token_count`.
   - Example 4 → `2 250` on the nested item, outer `exec` hidden; the same
     rollout without the next `token_count` shows nothing on it (picture).
   - Contamination: a `queued_command` attachment, a typed user record, a
     `compact_boundary`, a Codex `user_message` → estimate.
   - A hidden `ToolSearch` member → estimate on the `Bash` sibling.
   - Growth ≤ 0 → estimate.
   - A window starting mid-round (`createFeedSession().feed(lines, start)`
     with `start` inside Example 2's lines) → estimate for that round.
   - A running call (no result) → `contextTokens` undefined.
   - Identity: after the next response arrives, only the round's rows change
     identity; a repeated `feed()` with no new lines returns the same item
     objects.
3. `src/components/feed/toolBlocks.test.ts`: `coalesceFollowUps` sums
   `contextTokens` for polls; the basis rule of §9.
4. `src/components/feed/cards/toolCards.render.test.tsx` and
   `toolRowParity.dom.test.tsx`: the caption appears after the duration in
   `ToolLine`, `ToolBlockRow`, `MobileRunRow`, `PollRow`, the desktop group
   header; absent when the field is absent; `title` text in en and uk for
   each basis; `data-context-band` per band.
5. `src/components/runtime/McpCallCard.dom.test.tsx`: same for the MCP card.
6. `src/components/feed/cards/CmdGroupCard.mobile.dom.test.tsx`: the phone run
   row shows `… · ~12.4k` with the band class on the value only.
7. `src/styles/tokens.contrast.test.ts`: `color-caution` clears 4.5:1 on all
   six surfaces in both schemes, the two dark blocks agree, and §1.5
   documents it.
8. `src/lib/i18n/i18n.test.ts`: the new keys exist in both dictionaries with
   the uk plural forms.
9. Rendered evidence: add a `describe("tool call context tokens")` block to
   `src/components/mobile/issue1671Evidence.browser.test.tsx` (gated by
   `LLV_SWIPE_BROWSER_TEST=1` and `CHROME_BIN`) that renders one row per band
   plus the worst-case row of §11 at 390 and 1440 px, en and uk, light and
   dark, and asserts: caption on one line, row height unchanged, title width
   ≥ 96 px at 390, caption box inside the row. No new driver file.

## 14. Options considered

| Option | Verdict |
|---|---|
| A. Measured prompt growth, split by size for parallel calls, estimate as fallback | **Chosen.** Exact for 96–99 % of settled rounds, catches costs text cannot see (pictures, loaded schemas). |
| B. Estimate from result text only | Rejected as the primary: ±15 % moves calls across band edges (Example 1), zero for pictures, and blind to schema loads. Kept as the fallback. |
| C. Bundle a tokenizer (o200k for Codex) | Rejected: a client dependency for a count the provider already reports; no public tokenizer exists for the current Claude models. |
| D. Codex `Original token count` preamble | Rejected: counted before truncation (28 359 005 for a 40 170-character result). |
| E. Show nothing until measured | Rejected: the live tail would stay blank for every call until the next response, and 4 % of Claude rounds would never show. The requirement allows a marked estimate. |
| F. Styled `Hint` bubble for the tooltip | Rejected for now: a stateful component per tool row on a long feed, and `Hint` expects an interactive child. Native `title` matches the row's existing summary tooltip. |

## 15. Deferred — not currently justified

- Numbers for Copilot and OpenClaw conversations (the requirement names Claude
  and Codex; their transcripts were not calibrated).
- A tap-to-explain tooltip on phones.
- Per-turn or per-conversation totals, sorting or filtering by tokens, a
  heatmap on the scrollbar.
- The model's own output tokens per response.
- Numbers on live overlay rows before the transcript row lands.
- Numbers on nested `exec-…` items when their outer `exec` stays visible.
- Recalibrating the ratios per model family (Haiku 4.5 sits near 2.9).

## 16. Check against the requirement

| Operator asked | Where met |
|---|---|
| How much context each tool call used, in thousands | §3, §6 (`12.4k`) |
| As a number next to the timing (`352 ms`) | §9, placement after the duration |
| Hover explains it is a token count | §8 |
| Ranking: up to 1 000, up to 10 000, up to 20 000, and above | §7 |
| Only if the information exists | §3.2 rule 4, §10 |
| Claude and Codex | §2, §3.4 |
| Approximate marked as such | §6 `~`, §8 wording |
| No per-render cost | §5.3 |
