# Memory in the conversation: Jev choosing, and the memories it chose

Status: design brief, the first stage of lane `ad47a676`. Written against
`main` at `28a9cd01e` (2026-10-02); file and line references are to that
commit. This stage wrote only this document. The next stage of the lane
builds the three prototypes and renders them; nothing in this lane merges.
The operator picks a variant from the frames, and the picked one is then
built onto shared-memory phase 3 (lane `69994fc5`).

## Originating requirement

Operator, 2026-10-02 21:28 Kyiv, by voice in the orchestrator chat. Verbatim
transcription (the recognizer wrote «Джефф» for Jev):

> Давай добавим визуальный эффект UX, чтобы было видно, что сейчас Джефф
> выбирает память и чтобы их эту память красиво показать, оформить в нашем
> контексте в разговоре.

In English: add a visual UX effect so that one can see Jev choosing memory
right now, and show the chosen memory beautifully, laid out in our context,
in the conversation.

Two minutes later the operator asked whether every request now carries a
small delay while Jev chooses (paraphrased). The selecting state designed
here is what makes that delay legible.

The pinned specification adds: selection takes up to about 1.5 s and ends in
one of four outcomes (N entries offered, nothing relevant, skipped, failed or
timed out); the chosen memories are collapsed to one quiet line by default
and expand to each memory with its engine badge, date, title, summary,
confidence and an «open» to the full entry; three clearly different
variants; desktop 1440 and phone 390; uk and en; light and dark; quiet
surfaces with no walls of rows; rendered through the existing drivers.

## 0. Prior work searched

| Query (2026-10-02) | Scope | What came back |
| --- | --- | --- |
| `Jev выбирает память визуальный эффект разговор` | project | The requirement above and this lane's brief. Nothing designed earlier. |
| `memory offered line conversation view phase 3 quiet line naming what was offered` | all | The phase 3 build brief. Its acceptance 6 asks for "one quiet line naming what was offered for that turn" and specifies nothing further. |
| `пам'ять в розмові показати під повідомленням варіанти дизайну` | all | Board traffic about the shared-memory card and other design picks; no design for memory in the feed. |
| `search_memory`: `memory selection conversation view quiet line design variants`; `design variants numbered screenshots phone 390 quiet surfaces` | all, project | No entries. |

Read in full or in the relevant part: `docs/design/agent-memory.md` §4.3–4.7
and §6 (the index, the ledger, the per-prompt step, phase 3);
`docs/design/viewer-design-system.md` §1 and §3.4 (tokens, motion, feed
items); `docs/design/send-latency-and-message-states.md` §6 (one message,
one row); `docs/design/skeletons-and-transitions.md` D8 (motion);
`docs/design/mobile-v2/README.md` §2, §4.2, §5 (the phone). The phase 3
worktree at `2d4264cb3` holds only an untracked hook probe
(`scripts/probe-memory-hooks.ts`) and no conversation-view code yet, so there
is no phase 3 UI to align with beyond its acceptance text.

## 1. What the conversation view is today

### 1.1 One feed, two surfaces

Both surfaces draw the conversation with the same `LogFeed`:

- **Desktop.** A conversation opens inside its kanban card
  (`src/components/kanban/KanbanReaders.tsx`), which mounts `BranchPane`,
  which mounts `LogFeed` with `compact` (`src/components/BranchPane.tsx:480`).
  The reader track is 420–460 px in a reading column and at least 440 px in
  the work column (`src/components/kanban/kanbanLayout.ts:50-54`); the
  reader's «full» toggle widens it. The compact feed pads `px-3 pb-3`
  (`src/components/LogFeed.tsx:1629`). The orchestrator's conversation mounts
  the same `LogFeed` (`src/components/orchestrator/OrchestratorConversation.tsx:50`).
- **Phone.** `MobileFocusView` mounts `BranchPane`
  (`src/components/mobile/MobileFocusView.tsx:626`), so the phone runs the
  same compact feed; `useIsMobile()` switches each row to its phone anatomy
  below 640 × 600.

Everything below is therefore one implementation with a phone anatomy and a
desktop anatomy, and the element appears wherever `LogFeed` runs: the board
reader, the full reader, the orchestrator dock, the phone conversation and
the phone seat.

### 1.2 The order of rows

`LogFeed` renders one keyed list (`LogFeed.tsx:1675-1753`): the launch row,
the transcript's rows, the operator's message rows, deputy blocks and the
live turn (`row.kind === "delta"`, `:1686`) as siblings. An operator message
is `row.kind === "message"` (`:1695`), drawn by `FeedMessageRow`, and keeps
one DOM node from submit to the transcript's record (send-latency slice 3).
A turn's chrome (tool lines, the live turn) follows it, then the agent's
prose, then `ResponseDuration` under the turn's last row.

### 1.3 The operator's message row

`src/components/feed/UserMessageRow.tsx` is the only renderer of an operator
message, shared by the outbox and the transcript.

- The row is a right-aligned column (`flex flex-col items-end`, `:80`).
- Bubble: desktop `max-w-[min(75%,68ch)] rounded-surface bg-user px-4
  py-2.5` (`BUBBLE_MEASURE`, `src/components/feed/measure.ts`); phone
  `max-w-[86%]`, 15 px at 1.45.
- Three slots, all public props: `bubbleFooter` inside the bubble under the
  text (`:60`), `action` for the gutter (`:62`), `below` under the bubble
  (`:64`, rendered at `:128`).
- The gutter holds Copy. On the desktop it sits left of the bubble
  (`:92`); on the phone it is a 44 px row under the bubble at its trailing
  edge, `-mr-3 -my-1.5 flex h-11` (`:127`), so it takes about 32 px of flow.

### 1.4 Attachment and status lines next to it

| Line | Where | Anatomy |
| --- | --- | --- |
| Attachment caption | inside the bubble, `bubbleFooter` (`OutboxBubbles.tsx:331`) | `mt-1 text-caption font-semibold text-muted`. Its history matters here: it once vanished when the transcript adopted the row and shrank the message by 19 px on the phone, which the slice treats as a defect. |
| Delivery progress | the gutter, in Copy's box (`OutboxBubbles.tsx:154-174`) | a 12 px spinner (`animate-spin motion-reduce:animate-none`) swapping with Copy without moving a pixel. |
| Delivery failure | `below` (`OutboxBubbles.tsx:179`) | one line, `text-caption`, danger glyph and reason, one action. |
| Working status | desktop only, under the feed (`TurnStatusBar.tsx:74`, `:85`) | centred 12 px line with three bouncing dots and a 1 Hz timer. On the phone the bar's meta line carries the state phrase instead. |
| Turn duration | under the turn's last row (`ResponseDuration.tsx:5`) | `ml-9`, a 20 px hairline then `text-[11px] font-semibold text-muted`. |
| Collapsed deputy block | its own row (`DeputyBlock.tsx:264-266`) | one line, `text-label`, glyph, words, chips, chevron; `min-h-11` on the phone, `min-h-7` on the desktop; the whole line is the toggle. |
| Codex memory citations | assistant side (`feed/cards/MemCitationCard.tsx`) | a bordered `details` card, `ml-9`. The only memory surface in the feed today; it shows what Codex cited from its own store. |

Tool lines (design system §3.4): one quiet line, 12 px, 14 px glyph, status
only when not ok, time right-aligned at 10 px; a run folds into
`› N actions · Tool ×a`; expanded, the detail is a `--surface-sunken`
`--radius-surface` block. Chrome lines between two messages pack at 2 px in
the `ml-9` column on the desktop and at the gutter on the phone (no avatar
column there).

### 1.5 Motion conventions

- Durations 120 / 200 / 320 ms with `--ease-standard`
  (`viewer-design-system.md:215`). Loops use the product's two cadences:
  1.6 s (skeleton pulse `globals.css:327`, the phone's working dot) and
  3.4 s (attention orbit and breathe).
- A row that settles animates only when the change happens in view, never on
  first paint (`deputy-settle`, `globals.css:473-490`: opacity from 0 and
  `translateY(-4px)`, 200 ms).
- Under `prefers-reduced-motion` everything stops. Rules that matter carry
  both an unlayered `@media` rule and `motion-reduce:` on the element,
  because an unlayered rule outranks a utility (`globals.css:323-340`).
- At most one attention animation on screen. Nothing designed here is an
  attention animation.

### 1.6 What phase 3 will know, and when

From the phase 3 brief and `agent-memory.md` §4.4:

1. The operator sends; the outbox row appears at once.
2. The engine receives the prompt and its `UserPromptSubmit` hook asks the
   Viewer for memory. The prompt carries the `llv:structured-user` marker
   (`src/lib/runtime/codexStructuredUserText.ts`), whose handle names the
   delivery and its origin.
3. The gate skips messages under 40 characters, machine-written deliveries
   and projects whose switch is off.
4. Candidates: the top 30 index hits, minus entries the receiving engine
   wrote or already holds. Jev judges them; entries at or above 0.70 are
   offered, at most 15 and 10 000 characters, ordered by score.
5. Any error, a Jev answer later than 1.5 s, or an exhausted monthly cap
   ends in no block; the prompt goes through unchanged.
6. One `memory_offers` row per offered entry (`src/lib/memory/index.ts:80-84`:
   `memory_id`, `request_id`, `conversation_id`, `at`, `channel`, `score`,
   `outcome`, `outcome_at`), joined to `memory_entries` (`engine`, `kind`,
   `title`, `summary`, `writtenAt`, `sourcePath`).

The ledger records offers only. "Selecting", "nothing relevant", "skipped"
and "failed" leave no ledger row; section 8 states what the build needs for
them.

## 2. Decisions shared by all three variants

### 2.1 States

| State | When | Drawn |
| --- | --- | --- |
| selecting | the hook asked; no answer yet | the variant's selecting effect, only while the selection is live and the conversation is on screen |
| offered | 1–15 entries passed 0.70 | collapsed: one quiet line; expanded on demand |
| none | Jev ran; nothing reached 0.70 | one quiet line without a toggle |
| skipped · short | the operator's message is under 40 characters | one quiet line without a toggle |
| failed | `timeout` (past 1.5 s), `error`, `cap` (monthly Jev limit used up) | one quiet line with a warning glyph and no toggle; the reason in its words |
| skipped · machine | seat ticks, briefs, relays, tool results | nothing: these never render as the operator's bubble, so there is nothing to attach to |
| off | the project's switch is closed | nothing |

### 2.2 Data rules

- **Order.** Entries by score, highest first.
- **How many show expanded.** Variant 1 shows 5, variants 2 and 3 show 6,
  then a quiet «Show N more» that reveals the rest in place. Variant 3's
  phone sheet shows all, since the sheet scrolls.
- **Engine badge.** `claude` and `codex` use the existing `EngineBadge`
  (`src/components/EngineMark.tsx:122`): the engine mark and the engine's
  own word in its tint. `shared` entries are global instructions and
  single-fact skills, written by no engine; their badge names the kind in
  the interface language (Instructions / Skill), neutral tint
  (`bg-sunken text-secondary`), with lucide `BookText` (instruction) or
  `Sparkles` (skill) at 12 px.
- **Date.** `writtenAt` against a `now`: «today», «yesterday», up to 6 days
  through the existing `time.agoDay`, older as `Intl.DateTimeFormat`
  `{ day: "numeric", month: "short" }` (adding the year when it differs).
  Tabular numerals.
- **Confidence.** `score` as a whole percent through
  `Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })`,
  so uk gets its own spacing. The visible text is the number; the accessible
  name reads «confidence 92%».
- **Open.** «Open» opens the entry's `sourcePath` at its anchor line in the
  artifact preview the feed already uses for file links
  (`openArtifactPreview`, see `FileRef` in `feed/cards/shared.tsx:16-48`):
  the preview pane on the desktop, the full-screen preview on the phone. It
  must never go through `POST /api/search/memory`, which records an `opened`
  outcome (`src/app/api/search/memory/route.ts:28-40`); that outcome is the
  agent's usefulness signal, and an operator's click would pollute it.
- **Text.** Memory titles and summaries are content and stay in the
  language they were written in; only chrome is translated.

### 2.3 Geometry rules

1. **The bubble never moves.** Nothing is added inside the bubble. The
   operator's message keeps its width, padding, position and height in every
   state, as send-latency slice 3 requires.
2. **One height from first paint to settle.** The collapsed element has the
   same height in selecting, offered, none, skipped and failed, so the
   settle swaps words in place and nothing under it moves.
3. **It enters at the tail.** The element appears under the newest message,
   where the follow magnet keeps it in view; no row above it moves.
4. **One line.** The collapsed element never wraps. At 390 px and in a
   440 px desktop card it truncates with an ellipsis and carries the full
   text in its accessible name.
5. **Targets.** On a coarse pointer every control is at least 44 × 44 px and
   no two controls overlap (mobile-v2 §2, principle 7). On a fine pointer the line's
   target is at least 24 px tall.

### 2.4 Motion rules

1. The selecting effect plays only for a selection that is live while the
   conversation is on screen. A conversation opened later shows settled
   states, still.
2. The selecting state stays at least 600 ms from its first paint; a result
   that arrives sooner waits for that floor before it shows, so a quick
   answer never flashes. This delays the drawing only.
3. A selection that settled before the UI learned of it paints settled, with
   no selecting state and no motion.
4. Settle: the new words fade in over 200 ms in the same box, no transform.
5. Expand: the opened body enters with the `deputy-settle` motion (opacity
   from 0, `translateY(-4px)`, 200 ms, `--ease-standard`), only on the
   reader's own toggle. Collapse is instant. Chevrons turn over 120 ms.
6. Reduced motion: no loop, no fill, no fade, no settle, no chevron turn;
   each state is drawn static and swaps instantly. The selecting words end
   in «…» so the static form still reads as in progress.
7. Any new keyframes get both the unlayered `@media (prefers-reduced-motion:
   reduce)` rule and `motion-reduce:` on the element (§1.5).

### 2.5 Accessibility

- The collapsed line is a `button` with `aria-expanded` and
  `aria-controls` when it can expand; otherwise plain text.
- One polite announcement per selection, at settle, through the feed's
  existing live region pattern (`LogFeed.tsx:1754-1765`): «4 memories added
  to your message», «No memory was relevant», «Your message went without
  memory». Selecting is not announced; it lasts under 1.5 s.
- Each expanded entry is a list item; «Open» is a link-like button whose
  accessible name includes the title.

### 2.6 Special rows

- **A launch's first message** gets the element relative to its own bubble,
  exactly as any later message.
- **A deputy block**: the ask is drawn as an operator bubble in the block's
  head (`DeputyBlock.tsx:220-248`); the element attaches to that bubble the
  same way.
- **A team conversation**: a member's message gets the element under that
  member's bubble; the sender line above it is untouched.

## 3. The three variants

### Variant 1 — «Під повідомленням» / "Attached"

**Concept.** The memory rode along with the operator's words, so it belongs
to the operator's message: a caption on the operator's side, under the
bubble, in the bubble's own column, the way the attachment caption already
says what a message carried. What makes it distinct: it stays on the right;
on the phone it adds no row at all, sharing the action row with Copy; Jev's
choosing is a light sweep passing through the caption's words; expanded, the
memories stack under the bubble as small cards at the bubble's width, read
as what was attached to that message.

**Placement.**

- Desktop: in `UserMessageRow`'s `below` slot, right-aligned to the
  bubble's right edge, `mt-1`. Height 24 px (`min-h-6`,
  `[@media(pointer:coarse)]:min-h-11`). Max width: the row.
- Phone: inside the existing action row (`data-mobile-message-actions`,
  44 px), to the left of Copy, as a 44 px tall button. No new row.

**Line anatomy.** `Brain` 12 px, then the words in `text-label` (11 px),
`text-muted`, the count in 600; a 12 px `ChevronDown` when it can expand,
turned 180° when open. Gap 4 px.

| State | Desktop and phone |
| --- | --- |
| selecting | `Brain` in `text-accent`, «Jev вибирає пам'ять…» with the sweep. Not interactive. |
| offered, collapsed | «Додано 4 записи пам'яті ⌄». |
| offered, expanded | Under the line, a right-aligned stack of cards, gap 6 px. Desktop width `min(75%, 68ch)`; phone `max-w-[86%]`. Card: `rounded-surface border border-border bg-card px-3 py-2`, no shadow. Row 1, 11 px muted: engine badge · date, confidence right-aligned. Row 2: title, 13/600 primary, one line on the desktop, two on the phone. Row 3: summary, 12 px secondary, two lines. Row 4: «Відкрити ↗», 11/600 accent, end-aligned (desktop `min-h-6`, phone `min-h-11`). Five cards, then «Показати ще 10». |
| none | `Brain` muted, «У пам'яті нічого доречного». |
| skipped | `Brain` muted, «Без пам'яті · коротке повідомлення». |
| failed | `TriangleAlert` 12 px `text-warning`, «Без пам'яті · вибір перевищив 1,5 с» in `text-secondary`; the technical detail in `title`. |

**Motion.** Selecting: a highlight sweeps through the caption's words from
its trailing edge to its leading edge (right to left), once per 1.6 s:

```css
@keyframes memory-sweep { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.memory-sweep {
  background: linear-gradient(90deg, var(--color-muted) 0 40%, var(--color-accent) 50%, var(--color-muted) 60% 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: memory-sweep 1.6s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .memory-sweep { animation: none; background: none; color: var(--color-muted); } }
```

Settle, expand and reduced motion follow §2.4.

**Risk.** Cards under the bubble can be read as the operator's own
attachments; the right side of the feed gets busier on desktop.

### Variant 2 — «Крок ходу» / "Turn step"

**Concept.** Choosing memory is the first thing that happens in the agent's
turn, so it is drawn as the turn's first step, in the grammar the feed
already uses for steps: a quiet tool line in the agent's column with a glyph,
a summary with counts and a duration at the right edge, which expands into
the same sunken block an expanded tool run uses. What makes it distinct: it
sits on the agent's side; it shows the funnel (how many Jev weighed and how
many it kept) and how long Jev took; selecting is three dots scanning in the
glyph's place; expanded, the memories are dense list rows, the most compact
form for fifteen entries.

**Placement.**

- Desktop: its own feed row right after the operator's message row and
  before the turn's first row, in the chrome column (`ml-9`), packed with the
  turn's chrome (`my-0.5`). Height 24 px (`min-h-6`), coarse pointer 44 px.
- Phone: the same row at the feed gutter, no indent, `min-h-11`.

**Line anatomy.** `ChevronRight` 12 px (turns 90° open) when it can expand;
the glyph slot 14 px (`Brain`, or the scan dots while selecting); «Пам'ять»
in 600 secondary, then ` · ` and the summary in `text-ui` (12 px) secondary;
the duration right-aligned, `text-caption` muted, tabular.

| State | Desktop and phone |
| --- | --- |
| selecting | scan dots, «Пам'ять · Jev зважує 30 записів…». No duration yet. Not interactive. |
| offered, collapsed | «› Пам'ять · 4 з 30 · Codex ×3 · Інструкції ×1», right: «1,1 с». |
| offered, expanded | A `bg-sunken rounded-surface px-3 py-1` block under the line, at `READING_MEASURE` width in the chrome column (phone: full width). Rows divided by hairlines (`divide-y divide-border`), each at least 36 px (phone 44 px). Line 1: `EngineMark` 14 px in its tint, the title 12/600 primary truncated, the confidence right-aligned tabular secondary, then the open control as an icon button labelled «Відкрити» (`ExternalLink` 12 px; 22 px fine, 44 px coarse; `MESSAGE_ACTION` opacity at rest). Line 2, 11 px muted: the date (or the kind for a shared entry) · the summary, one line on the desktop, two on the phone. Six rows, then «Показати ще 9». |
| none | «Пам'ять · серед 30 записів нічого доречного», right: «0,8 с». |
| skipped | «Пам'ять · пропущено, коротке повідомлення». |
| failed | `TriangleAlert` `text-warning` in the glyph slot, «Пам'ять · перевищено 1,5 с, пішло без пам'яті», right: «1,5 с». |

**Motion.** Selecting: three 4 px accent dots in the 14 px glyph slot light
in turn left to right (opacity 0.3 → 1 → 0.3), one sweep per 1.6 s, the same
three-dot vocabulary the desktop working bar uses. On settle the dots give
way to `Brain` and the words fade in (200 ms). Reduced motion: three static
dots at full opacity, instant swaps.

**Risk.** It reads as one of the agent's own actions, and a reader skimming
tool lines may pass it by. It is the quietest of the three and the least
decorative.

### Variant 3 — «Між вами» / "Between you"

**Concept.** Jev is a third participant, neither the operator nor the agent,
so it speaks from the centre of the conversation the way chat products draw
a system event: a centred caption between two hairlines, sitting between the
operator's message and the answer. While Jev chooses, the hairlines fill
toward the caption over its 1.5 s budget, so the wait reads as a bounded
countdown. The chosen memories open as a set of cards: a two-column panel
under the divider on the desktop, a bottom sheet on the phone, which is
where the phone keeps detail. What makes it distinct: centred; the only
determinate motion of the three; the collapsed caption carries a small
overlapping cluster of the engine marks it drew from; the most expressive
expanded state.

**Placement.**

- Desktop: its own feed row after the operator's message row and before the
  turn's first row, `my-2`, centred on the feed, at most 720 px wide
  (`mx-auto max-w-[min(100%,720px)]`). Height 28 px; coarse pointer 44 px.
- Phone: the same row at the feed gutter, full width, `min-h-11`.

**Line anatomy.** `flex items-center gap-2`: a hairline (`h-px flex-1
bg-border`), the caption, a hairline. Caption, `text-label` muted: the mark
cluster (up to three 12 px engine marks or shared-kind glyphs, each
overlapping the previous by 4 px, with a 1.5 px ring in the feed's surface
colour), then «Jev · 4 записи пам'яті», then `ChevronRight` 12 px when it can
expand. The whole caption is the button; the hairlines are decoration.

| State | Desktop | Phone |
| --- | --- | --- |
| selecting | `Brain` 12 px accent, «Jev вибирає пам'ять…»; both hairlines fill with accent from their outer ends toward the caption. Not interactive. | same |
| offered, collapsed | mark cluster, «Jev · 4 записи пам'яті ›», hairlines in border colour. | same |
| offered, expanded | A panel under the divider, `rounded-surface border border-border bg-card p-2`, centred, at most 760 px. Header: «Пам'ять до «Подивись, чому реліз…»» (the message's head through `quoteHead`), 11 px muted, and «згорнути» at the end. Cards in `grid grid-cols-2 gap-2` (one column under 560 px of panel width), the card anatomy of variant 1. Six cards, then «Показати ще 9». | A bottom sheet, the production `MobileSheet` anatomy: handle, title «Пам'ять до повідомлення», the message's head under it, the cards stacked full width (all 15 when there are 15; the sheet scrolls), × and scrim to close, the back gesture closes it. |
| none | «Jev · нічого доречного», without a toggle. | same |
| skipped | «Jev · пропущено, коротке повідомлення». | same |
| failed | hairlines in `warning` (static), `TriangleAlert` warning, «Jev · перевищено 1,5 с, без пам'яті». | same |

**Motion.** Selecting: each hairline carries an accent fill drawn with
`transform: scaleX(0 → 1)`, origin at its outer end, linear over 1500 ms,
`forwards`, no loop; `animation-delay` is set to minus the time already
elapsed since `startedAt`, so a late paint starts mid-way and the fill
always reaches the caption at the deadline. Settling early: the fill
completes over 120 ms, then fades to the border colour over 200 ms, and the
words fade in. Timing out: the fill reaches the caption and the hairlines
turn warning. The panel opens with `deputy-settle`; the phone sheet uses the
existing sheet motion (320 ms rise). Reduced motion: hairlines static in the
border colour, instant swaps.

**Risk.** A centred row under every long message is the loudest of the
three; the phone needs one extra step (the sheet) to see the memories.

### 3.4 Side by side

| | 1 · Attached | 2 · Turn step | 3 · Between you |
| --- | --- | --- | --- |
| Side | operator (right) | agent column (left) | centre |
| Added height at rest, desktop | 24 px under the bubble | a 24 px row | a 28 px row |
| Added height at rest, phone | 0 (shares Copy's row) | a 44 px row | a 44 px row |
| Selecting effect | light sweep through the words, 1.6 s loop | three dots scanning, with the candidate count | hairlines fill toward the caption over the 1.5 s budget |
| Expanded, desktop | cards stacked under the bubble | dense rows in a sunken block | two-column card panel |
| Expanded, phone | cards stacked under the bubble | dense rows in a sunken block | bottom sheet |
| Shows Jev's time | no | yes | as the fill |
| Shows how many were weighed | no | yes | no |

## 4. Copy

Keys are namespaced per variant for the prototype; the build keeps the
picked variant's keys and the shared ones. Plural entries use the
dictionary's `Intl.LDMLPluralRule` forms (`src/lib/i18n/core.ts:5`); uk
lists `one / few / many / other`. Proper nouns (Jev, Claude, Codex) stay as
written. Ukrainian keeps the ASCII apostrophe the dictionary already uses.

### 4.1 Shared

| Key | en | uk |
| --- | --- | --- |
| `memory.open` | Open | Відкрити |
| `memory.openAria` | Open “{title}” | Відкрити «{title}» |
| `memory.confidence` | confidence {value} | впевненість {value} |
| `memory.showMore` | one: Show {count} more · other: Show {count} more | Показати ще {count} |
| `memory.today` | today | сьогодні |
| `memory.yesterday` | yesterday | вчора |
| `memory.seconds` | {n} s | {n} с |
| `memory.shared.instruction` | Instructions | Інструкції |
| `memory.shared.skill` | Skill | Навичка |
| `memory.toggleShow` | Show the memory added to this message | Показати пам'ять, додану до повідомлення |
| `memory.toggleHide` | Hide the memory | Сховати пам'ять |
| `memory.announce.offered` | one: {count} memory added to your message · other: {count} memories added to your message | one: До повідомлення додано {count} запис пам'яті · few: … {count} записи пам'яті · many: … {count} записів пам'яті · other: … {count} запису пам'яті |
| `memory.announce.none` | No memory was relevant to your message | Для повідомлення не знайшлося доречної пам'яті |
| `memory.announce.failed` | Your message went without memory | Повідомлення пішло без пам'яті |

### 4.2 Variant 1

| Key | en | uk |
| --- | --- | --- |
| `memory.v1.selecting` | Jev is choosing memory… | Jev вибирає пам'ять… |
| `memory.v1.added` | one: {count} memory added · other: {count} memories added | one: Додано {count} запис пам'яті · few: Додано {count} записи пам'яті · many: Додано {count} записів пам'яті · other: Додано {count} запису пам'яті |
| `memory.v1.none` | Nothing relevant in memory | У пам'яті нічого доречного |
| `memory.v1.skipped` | No memory · short message | Без пам'яті · коротке повідомлення |
| `memory.v1.failed.timeout` | No memory · selection ran past 1.5 s | Без пам'яті · вибір перевищив 1,5 с |
| `memory.v1.failed.error` | No memory · selection failed | Без пам'яті · вибір не вдався |
| `memory.v1.failed.cap` | No memory · Jev's monthly limit is used up | Без пам'яті · місячний ліміт Jev вичерпано |

### 4.3 Variant 2

| Key | en | uk |
| --- | --- | --- |
| `memory.v2.label` | Memory | Пам'ять |
| `memory.v2.selecting` | one: Jev is weighing {count} memory… · other: Jev is weighing {count} memories… | one: Jev зважує {count} запис… · few: Jev зважує {count} записи… · many: Jev зважує {count} записів… · other: Jev зважує {count} запису… |
| `memory.v2.selectingPlain` | Jev is choosing… | Jev вибирає… |
| `memory.v2.offered` | {count} of {considered} | {count} з {considered} |
| `memory.v2.offeredPlain` | one: {count} memory · other: {count} memories | one: {count} запис · few: {count} записи · many: {count} записів · other: {count} запису |
| `memory.v2.none` | one: nothing relevant among {count} · other: nothing relevant among {count} | one: серед {count} запису нічого доречного · few/many/other: серед {count} записів нічого доречного |
| `memory.v2.nonePlain` | nothing relevant | нічого доречного |
| `memory.v2.skipped` | skipped, short message | пропущено, коротке повідомлення |
| `memory.v2.failed.timeout` | ran past 1.5 s, sent without memory | перевищено 1,5 с, пішло без пам'яті |
| `memory.v2.failed.error` | selection failed, sent without memory | вибір не вдався, пішло без пам'яті |
| `memory.v2.failed.cap` | Jev's monthly limit is used up, sent without memory | місячний ліміт Jev вичерпано, пішло без пам'яті |

The engine counts in the offered line («Codex ×3 · Інструкції ×1») are built
from `ENGINE_LABEL` and `memory.shared.*`, in score order of first
appearance.

### 4.4 Variant 3

| Key | en | uk |
| --- | --- | --- |
| `memory.v3.selecting` | Jev is choosing memory… | Jev вибирає пам'ять… |
| `memory.v3.offered` | one: Jev · {count} memory · other: Jev · {count} memories | one: Jev · {count} запис пам'яті · few: Jev · {count} записи пам'яті · many: Jev · {count} записів пам'яті · other: Jev · {count} запису пам'яті |
| `memory.v3.none` | Jev · nothing relevant | Jev · нічого доречного |
| `memory.v3.skipped` | Jev · skipped, short message | Jev · пропущено, коротке повідомлення |
| `memory.v3.failed.timeout` | Jev · ran past 1.5 s, no memory | Jev · перевищено 1,5 с, без пам'яті |
| `memory.v3.failed.error` | Jev · selection failed, no memory | Jev · вибір не вдався, без пам'яті |
| `memory.v3.failed.cap` | Jev · monthly limit used up, no memory | Jev · місячний ліміт вичерпано, без пам'яті |
| `memory.v3.panelTitle` | Memory for «{quote}» | Пам'ять до «{quote}» |
| `memory.v3.sheetTitle` | Memory for this message | Пам'ять до повідомлення |

Every past-tense verb in the uk copy has a grammatical subject that is a
thing («вибір», the impersonal «додано», «вичерпано»), so no line assigns a
gender to anyone.

## 5. Fixture shape

The prototype reads one object per operator message, shaped like the ledger
offer joined to its index entry. It lives in the fixture; no production
module exports it in this lane.

```ts
/** One memory Jev offered: a `memory_offers` row (channel "inject") joined
    to its `memory_entries` row. */
export interface MemoryOfferFixture {
  /** memory_offers.memory_id = memory_entries.id; the search_memory id. */
  memoryId: `m_${string}`;
  /** memory_entries.engine: who wrote the entry. */
  engine: "claude" | "codex" | "shared";
  /** memory_entries.kind; drawn only to name a shared entry. */
  kind: "preference" | "project_fact" | "reference" | "failure" | "instruction" | "skill";
  /** memory_entries.writtenAt, ISO 8601. */
  writtenAt: string;
  title: string;
  summary: string;
  /** memory_offers.score: Jev's probability; offered entries are 0.70–1. */
  score: number;
  /** Characters this entry took in the injected block (≤ 10 000 per message). */
  chars: number;
  /** Where «Open» goes: memory_entries.sourcePath and the anchor's line. */
  source: { path: string; line?: number };
  /** memory_offers.outcome / outcome_at. Carried for the build; no variant draws it (Deferred). */
  outcome: null | { kind: "opened" | "cited"; at: string };
}

export type MemorySelectionState = "selecting" | "offered" | "none" | "skipped" | "failed";

export interface MemorySelectionFixture {
  /** memory_offers.request_id: one selection per operator message. */
  requestId: string;
  /** memory_offers.conversation_id. */
  conversationId: string;
  /** The operator message's row key in the feed (its delivery identity). */
  messageKey: string;
  state: MemorySelectionState;
  /** When the hook asked. Drives variant 3's fill and the 600 ms floor. */
  startedAt: string;
  /** Absent while selecting. */
  settledAt?: string;
  /** Candidates Jev weighed; absent when unknown and when skipped. */
  considered?: number;
  /** skipped: why the gate closed; failed: what failed. */
  reason?: "short" | "machine" | "timeout" | "error" | "cap";
  /** offered only: 1–15 entries, highest score first, Σ chars ≤ 10 000. */
  offers: MemoryOfferFixture[];
}
```

Fixture rules. Everything is invented; no real memory text, account, handle
or absolute path. Source paths are `$HOME`-relative
(`$HOME/.codex/memories/MEMORY.md`, line 214). The clock is frozen at
`2026-10-02T18:30:00Z`, passed to the component as `now`, so relative dates
render the same in every run. Memory text is English in both locales;
operator messages are in the frame's locale.

**The standard selection** (a Claude conversation, so it is offered Codex and
shared entries; `considered: 30`; settled 1 100 ms after start):

| # | engine · kind | written | score | title | summary |
| --- | --- | --- | --- | --- | --- |
| 1 | codex · failure | 2026-09-30 | 0.93 | Release smoke suite needs an isolated state directory | Run it with LLV_STATE_DIR pointed at a temp directory; against live state it stops the host that owns the session. |
| 2 | codex · project_fact | 2026-09-23 | 0.86 | The release lane owns promotion; the seat only reports | A promotion stuck at verify-candidate belongs to the release lane. The seat reports it and restarts nothing. |
| 3 | shared · instruction | 2026-08-30 | 0.78 | Stop only processes you started | Stop by the PID you recorded; a port already in use is a reason to pick another port. |
| 4 | codex · reference | 2026-08-12 | 0.71 | Where release notes are drafted before a tag, and which headings the publish workflow expects in them so that the changelog step renders every section | Drafts live beside the workflow; a heading that does not match makes the changelog step skip that section without an error. |

**The full selection** (`chosen-max`): a Codex conversation, so it is offered
Claude and shared entries. 15 entries: claude × 9, shared × 6 (instruction
× 4, skill × 2); scores evenly from 0.97 down to 0.70; `writtenAt` from
today back to 2026-06-14; one title over 140 characters; one summary over
300 characters containing a long path-like token; Σ chars between 9 400 and
10 000; `considered: 30`.

**Operator messages** (uk / en):

| Use | uk | en |
| --- | --- | --- |
| main (offered, selecting) | Подивись, чому реліз застряг на verify-candidate, і скажи, яка лінія за це відповідає. Якщо це знову хост, нічого не перезапускай без мене. | Look at why the release is stuck on verify-candidate and tell me which lane owns it. If it's the host again, don't restart anything without me. |
| skipped | ок, давай | ok, go ahead |
| none (`considered: 30`, 800 ms) | Перейменуй картку на «Перевірка хоста перед релізом». | Rename the card to “Host check before release”. |
| failed (`timeout`, 1 500 ms) | Збери одним списком усе, що ми вже знаємо про таймаути збірки на CI. | Collect everything we already know about CI build timeouts into one list. |
| story tail (selecting) | А тепер перевір, чи той самий збій є на попередньому тезі. | Now check whether the same failure exists on the previous tag. |

Each frame shows the previous exchange above the message (an agent prose
row), the message, the element, and, for settled states, the start of the
agent's turn under it (one folded tool line and two lines of prose), all
drawn by the production renderers.

## 6. Prototype and evidence (the variants stage)

### 6.1 Files

The prototype touches only these paths:

| Path | Change |
| --- | --- |
| `src/components/conversation/MemorySelection.tsx` | new: `MemorySelection({ selection, variant, now, phaseMs?, placement })`, the three variants behind one prop, exposing the data attributes in 6.4. |
| `src/components/conversation/conversationWindowEvidence.fixture.tsx` | a new case `memory-selection` added to `ConversationWindowCase`, with the fixtures of section 5. |
| `src/components/conversation/conversationWindow.browser.test.tsx` | one new `describe("memory selection: three variants")` block. |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | the keys of section 4, appended (the dictionary is append-only per lane). |
| `src/app/globals.css` | one marked block with the prototype keyframes and their reduced-motion rules. |
| `evidence/memory-selection/variants.json` | the driver's readings. |

The fixture composes production renderers and inserts the prototype at the
variant's position, so no production component changes:

- operator messages through `UserMessageRow`; variant 1 passes its line
  through `below` on the desktop, and on the phone through `action` as the
  line followed by the default Copy control;
- agent rows through `FeedItem` over `buildFeed` of invented Claude JSONL
  lines, as the `agent-images` case does;
- variants 2 and 3 as their own rows between the message and the turn;
- variant 3's phone sheet through the production `MobileSheet`, with
  `"memory" as MobileSheetName` (the build registers the name in
  `mobileNav.ts`);
- containers exactly as `LogFeed` compact draws them (`px-3 pb-3 text-body`
  inside a `py-3` scroller), on `bg-canvas`.

Including the production `TmuxComposer` under the feed is welcome on the
phone frames when the lifecycle case's test seams make it cheap
(`mountLifecycle`, fixture `:922-959`); the element never touches it.

### 6.2 Query string

`?case=memory-selection&variant=1|2|3&state=<state>&lang=uk|en&phase=600`,
where `<state>` is one of `selecting`, `chosen`, `chosen-open`,
`chosen-max`, `nothing`, `skipped`, `failed`, `story`. `phase` freezes the
selecting animation at that many milliseconds by setting a negative
`animation-delay` and `animation-play-state: paused`, so each frame is
deterministic. `story` is one conversation of five exchanges carrying, in
order, offered (collapsed), skipped, none, failed and, at the tail,
selecting: the frame for judging how noisy a variant is across a real
conversation.

Every frame starts with a fixed 32 px strip at the top of the page
(`bg-raised`, hairline under it), outside the feed so it covers nothing:
the variant number in a 20 px numeral pill, then «Варіант 1 · Під
повідомленням · selecting · uk · dark» in 13/600. This is the variant number
printed on every frame.

### 6.3 Frames

| Axis | Values |
| --- | --- |
| variant | 1, 2, 3 |
| surface | `desktop-light`, `desktop-dark` (1440 × 900, fine pointer), `phone-light`, `phone-dark` (390 × 844, touch) |
| state | `selecting`, `selecting-reduced` (the `selecting` page under `reducedMotion: "reduce"`), `chosen`, `chosen-open`, `chosen-max` (expanded), `nothing`, `skipped`, `failed`, `story` |
| locale | `uk`, `en` |

That is 216 full-page PNGs named `v<N>-<surface>-<state>-<locale>.png`, for
example `v2-phone-dark-chosen-open-uk.png`. The colour scheme rides in the
surface name, which keeps the requested `v<N>-<surface>-<state>-<locale>`
pattern. Six more at the narrow desktop card width (a 440 px compact feed
on a 1440 canvas, light, `chosen-open`): `v<N>-card-light-chosen-open-<locale>.png`.

Optional and worth it: one `recordVideo` webm per variant of the live
sequence (send, selecting, settle, expand) at `desktop-dark` and
`phone-dark`, uk, named `v<N>-<surface>-live-uk.webm`, beside the PNGs. A
still frame shows the selecting effect's look; only a clip shows its motion.

Frames go to `LLV_MEMORY_SELECTION_OUT` (default
`.artifacts/memory-selection/`, kept out of git); the stage then copies them to
`$HOME/Pictures/delegatus-review/memory-selection/`. The driver itself names
no home path.

### 6.4 What the driver measures and gates

The prototype exposes `data-memory-selection=<state>`,
`data-memory-variant=<n>`, `data-memory-line`, `data-memory-toggle`,
`data-memory-list`, and per entry `data-memory-offer=<id>` with
`data-memory-engine`, `data-memory-date`, `data-memory-title`,
`data-memory-summary`, `data-memory-score` and `data-memory-open`. The block
fails when any of these does not hold, and writes every reading to
`evidence/memory-selection/variants.json`:

1. No page errors; no horizontal overflow at any width.
2. The variant strip is present and names the frame's variant.
3. For one variant, surface and locale, the operator bubble's rect is the
   same (±0.5 px) in `selecting`, `chosen`, `nothing`, `skipped` and
   `failed`, and so is the collapsed element's height: the settle moves
   nothing.
4. The collapsed element is one line at 390 px and at the 440 px card width,
   in both locales.
5. Phone: every visible control in the element is at least 44 × 44 px, and
   no two visible controls (Copy included) intersect. Desktop: the line's
   target is at least 24 px tall.
6. Every expanded entry carries an engine badge, a date, a title, a summary,
   a confidence and an open control; `chosen-max` shows the variant's count
   and a «show more» with the right remainder (variant 3's phone sheet shows
   all 15).
7. Under reduced motion, `getAnimations()` on the element is empty in every
   state. With motion, the `selecting` element runs exactly one animation
   family, and settled states run none.

Run it as:

```
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
  bun test src/components/conversation/conversationWindow.browser.test.tsx -t "memory selection"
```

The block closes its browser and its fixture server in `finally`, as the
existing blocks do. Any other browser or server the stage starts is stopped
by the PID recorded when it started.

### 6.5 Before pushing

- Read the PNGs, at least every `phone-*` frame and every `story` frame, and
  critique them in the stage report (overflow, clipping, overlap, contrast,
  noise across the story).
- Type-check the touched files and run the browser block above. Run nothing
  that sweeps runtime or registry directories.
- `bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD origin/main) --check-commits`.
- Push `pipeline/memory-in-the-conversation-show-jev-choo-ad47a676`. Open no
  pull request.

## 7. What not to touch

- **Lane `69994fc5` (phase 3).** `src/lib/memory/**`,
  `src/app/api/search/memory/**`, `src/lib/asks/**` (the Jev client, its
  settings and spend cap), the engine hook command and the managed engine
  configuration it adds (the Claude hook file, Codex `hooks.json` and
  `additionalContextLimit`), the per-project memory switch in Settings,
  `scripts/probe-memory-hooks.ts`, `docs/research/memory-selection*`,
  `docs/design/agent-memory.md`, and whatever "one quiet line" phase 3 adds
  to the conversation view. The prototype reads only its fixture and calls
  no memory route.
- **Production conversation components.** `LogFeed.tsx`,
  `feed/UserMessageRow.tsx`, `feed/FeedItem.tsx`, `feed/parse.ts`,
  `conversation/OutboxBubbles.tsx`, `conversation/outbox.ts`,
  `conversation/messageRow.ts`, `conversation/LiveTurnRows.tsx`,
  `TurnStatusBar.tsx`, `feed/cards/MemCitationCard.tsx`, `BranchPane.tsx`,
  `mobile/MobileFocusView.tsx`, `mobile/MobileSheet.tsx`,
  `mobile/mobileNav.ts`, `kanban/KanbanReaders.tsx`. The fixture composes
  them through their existing props.
- **The delivery vocabulary.** The outbox's progress affordance, its
  failure line and their words stay as they are. A memory state never
  claims anything about delivery.
- **The ledger.** Nothing in the UI writes an outcome.
- **Areas other open lanes are changing** (named in the phase 3 brief): the
  privacy gate, Telegram inbound, runtime-host access, MCP tool descriptions
  (PR #2478), the board UI.

## 8. For the build onto phase 3, after the pick

Not this lane's work; recorded so the picked variant can be built without
re-deriving it.

1. **A record for every selection.** The ledger records offers only, so
   after a reload the UI could draw "offered" and nothing else. Persist one
   row per request beside `memory_offers` (request id, conversation id,
   message identity, state, reason, considered, started and settled times);
   without it, "none", "skipped" and "failed" exist only while the
   conversation is open.
2. **Joining to the message.** The hook sees the prompt with its
   `llv:structured-user` marker, whose handle names the delivery the feed's
   message row is keyed to; the selection carries that identity. A prompt
   typed into a terminal inside a Delegatus-launched session has no marker
   and joins the transcript's user record nearest after `startedAt`.
3. **Live state.** The Viewer publishes the start and the settle on the
   event stream the feed already reads (`src/hooks/runtimeBus.ts`); the feed
   keeps the latest selection per message key.
4. **Where it lands.** The phase 3 "one quiet line" (its acceptance 6) is the
   slot the picked variant replaces. Variant 1 needs a dedicated slot in
   `UserMessageRow` (its phone half shares the action row); variants 2 and 3
   are a new row kind in `LogFeed`'s list, keyed `memory:<messageKey>`, placed
   right after the message row.
5. **Open.** Through the artifact preview of `sourcePath`, never through the
   ledger's open route (§2.2).
6. **Variant 3 on the phone** registers a `memory` sheet in `SHEET_NAMES`
   (`src/components/mobile/mobileNav.ts:45`), so Back closes it under the
   navigation contract.

## Deferred — not currently justified

- **Outcomes on entries** («the agent opened it», «cited»). The fixture
  carries them; the requirement asks to show the chosen memories, and
  usefulness is phase 4's review list.
- **The memory kind on every entry** (preference, project fact, lesson).
  Shown only where it names a shared entry.
- **Feedback controls on an entry** (wrong, outdated, never again). Retiring
  is phase 4's and needs its own design.
- **The candidates Jev rejected** and their scores.
- **The injected block verbatim** (what the agent literally received).
- **A selecting indicator outside the feed**: the phone bar's meta line or
  the desktop working bar. The requirement places it in the conversation.
- **Hiding "skipped" and "none"** at rest. Every variant draws them quietly
  so the operator can see that every message was considered; whether to hide
  them is a question at pick time.
- **Sound or haptics.**

## Validation against the requirement

| The requirement says | Where it is answered |
| --- | --- |
| «визуальный эффект UX» | A selecting effect per variant: a sweep (1), scanning dots with the candidate count (2), a deadline fill (3); §2.4 for its floor and reduced motion. |
| «чтобы было видно, что сейчас Jev выбирает память» | The selecting state names Jev and plays while the selection is live (§2.1, §2.4.1). |
| «эту память красиво показать, оформить» | The offered state, collapsed and expanded, in three forms: cards under the bubble, dense rows, a card panel or sheet; each entry with engine badge, date, title, summary, confidence and «open» (§2.2, §3). |
| «в нашем контексте в разговоре» | In the feed, next to the operator's message, on both surfaces, wherever `LogFeed` runs (§1.1, §3). |
| Pinned: four outcomes | §2.1 draws offered, none, skipped and failed (three reasons). |
| Pinned: collapsed to one quiet line | §2.3 rules 2 and 4; gates 3 and 4 in §6.4. |
| Pinned: 1440 / 390, uk / en, light / dark, variant number on every frame | §6.3, §6.2. |
| Pinned: existing drivers, no new driver | §6.1: a case in the conversation window's fixture and driver. |
| Pinned: do not touch phase 3 files; read a ledger-shaped fixture | §7, §5. |

## Questions for the operator at pick time

None blocks the next stage; they come with the frames.

1. **Which variant?** Recommendation: variant 1. It answers «в разговоре,
   рядом с моим сообщением» most directly, adds no row on the phone, and its
   expanded cards are the most readable at 390 px. Variant 3 if the effect
   should be unmistakable.
2. **Should "skipped" and "none" show at rest?** Recommendation: keep them
   for the first weeks, while trust in the selection builds, then decide on
   what the story frames show.
3. **Mixing is possible**, for example variant 1's line with variant 3's
   phone sheet. Recommendation: pick one whole variant first.
