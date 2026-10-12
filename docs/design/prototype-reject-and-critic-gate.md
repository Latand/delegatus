# Prototype reviews: «Reject and redo», and a visual-critic gate before the operator

## Originating requirement

Operator, 2026-10-12 about 08:10, seat chat, Russian, verbatim:

> «Нужно придумать новое решение для отклонения. Прототипа, потому что мне
> приходится выбирать прототипы, даже если я хочу их отклонить. Я думаю, нужна
> кнопочка с отклонения их, и куда я могу записать вот это голосовое, или
> поправки, что я хочу переделать, и чтобы было понятно, что нам нужен новый
> раунд. И вообще нам нужно завести, как правило, что как только делается
> прототип, всегда он должен визуально проходить проверку, визуального критика,
> и там должно быть то, что вот мы обычно проверяем, то, что захламлённость
> интерфейса, непонятно, куда нажимать, миллион одинаковых элементов, типа там
> одинаковые карточки, или ещё что-то. Вот у нас может быть даже скилы какие-то
> уже есть, UI/UX, вот эти всякие. Можно их подключать … если у нас несколько
> прототипов, несколько разных вариантов, то критик должен пройти по всем, дать
> замечания по всем, все переделать потом после этого, фиксануть. И после этого
> только прототип можно показывать мне.»

The pinned task splits it in two. **Part A**: in the review (desktop and
phone) the operator rejects every variant without choosing one, through a clear
secondary action «Відхилити й переробити», with corrections typed or dictated,
recorded as a decision of kind «rejected» that makes the coming round obvious
and wakes whoever publishes round N+1. Choosing keeps working; rejecting needs
no tick. **Part B**: no review reaches the operator before a visual critic has
judged every variant and its findings are fixed, with a standing checklist kept
in the visual-critic role scaffold.

## What exists today (main at aaf82e179)

- **The review surface** is one component, `src/components/prototypeReview/PrototypeReview.tsx`:
  a dialog over the board on the desktop and a full `MobileSheet` on the phone.
  Its footer (`footer`, lines 798–861) holds the «Обрано:» line, the comment
  field with the composer's own microphone (`MicButtonView` over
  `useDictation`, lines 255–282 and 846), and the actions «Сховати» and
  «Зберегти вибір» (lines 849–856). The comment field and the dictation already
  exist; Part A needs no new input.
- **The decision** is saved by `decidePrototype` in
  `src/lib/prototypeReview/decision.ts`. It refuses a decision without a ticked
  variant unless the round only asks questions (lines 131–132: «choose one or more
  declared variants»). This refusal is exactly why the operator «has to choose
  prototypes even when wanting to reject them».
- **Delivery** is a message to the project's orchestrator seat, never to the
  publishing pipeline: `prototypeWorld.orchestrator(project)` names the seat
  (`world.ts`), `prototypeDecisionText` writes the message («Prototype review
  decision … Chosen: … Comment: …»), and `deliveryWorker.ts` sends it in the
  background with retries and an attention notice. The round records its
  publisher in `round.source` (`conversationId`, `pipelineId`, `stageId`,
  `attempt`), but nothing reads it on a decision.
- **Rounds** already chain: a newer round supersedes undecided older ones, the
  review draws round tabs (`roundTabs`), and the card button
  (`PrototypeReviewButton.tsx:118`) words the latest decision as «обрано {chosen}».
- **Publication** is `publishPOST` in `src/lib/prototypeReview/http.ts`. A
  pipeline caller is bound to its pipeline's task; nothing asks whether anyone
  looked at the frames before the operator does.
- **The visual critic** is a role (`visual-critic`, `src/lib/roles/defaults.ts:153–167`
  and `ROLE_DEFAULTS` line 325). Its scaffold produces its own frames from an
  export of the head through the existing drivers and reports two classes of
  finding, `VISUAL_CRITIC_CLASSES` (ugliness; information the operator need not
  see), pinned by `src/lib/roles/registry.test.ts:448–456`. It judges built
  changes; it has no prototype mode and no checklist for clutter, primary
  action or repetition.
- **Prior art**: the seat already composes prototype lanes as prototype →
  visual-critic → proto-fix → publish by hand since this morning (this lane is
  one); the product does not enforce it. Searching transcripts and memory for
  an earlier reject design found nothing beyond this task.

## Part A — «Відхилити й переробити»

### What is common to every variant

**Data.** `PrototypeDecision` gains `rejected?: true`; `DecidePrototypeInput`
gains `reject?: true`. A rejected decision keeps `chosen` (empty, or the
variants the operator ticked as closest, see question 2) and `comment`.
`PrototypeRoundView`, the summary (`prototypeReviewSummary`) and the replica
carry the flag, so the card and a linked installation read it.

**Server.** In `decidePrototype`, `reject: true` takes the place of the
variant check:

- the round must have variants (a questions-only round has nothing to reject);
- `comment.trim()` must be non-empty: «write or dictate what to redo». A
  rejection is a request for work, and the next round is made from these words;
- answers and skip are not required with `reject` (a round with questions and
  variants may be rejected as a whole);
- everything else is unchanged: one decision per round from the review, the
  same lock, the same background delivery, revisions and amendments.

**The message.** `prototypeDecisionText` writes, for a rejected round:

```
Prototype review decision
Task: <id> — <first line>
Round: <title> (round <N> of this task)
Rejected: no variant is taken. Make round <N+1> from the corrections below,
on this task, and publish it after a visual critic (see the gate).
Closest: 2 — Two columns            (only when ticked)
Published by: pipeline <id>, stage <id>

Comment:
<corrections>

End of prototype review decision.
```

The message carries its own instruction, so the seat's mandate needs no new
sentence (the mandate sits a few bytes under its budget). It names the
publishing pipeline so the seat can rerun or copy its stages.

**Who is woken.** The seat, through the existing delivery. The publishing
pipeline has ended by the time the operator decides (its publish stage is its
last), so there is no live pipeline to wake; the seat is the one agent that
owns the task and composes lanes. Waking the seat is what the delivery already
does, with retries, the «waits for a seat» state and the attention notice. See
«Options considered» for the two alternatives.

**After the rejection** the review says what happens next (the common half of
every variant's «after rejection» frames):

- the decided footer reads «↺ Відхилено», with the time, the
  corrections in the comment box and the delivery line «Поправки доставлено ·
  оркестратор готує раунд 2» (saved/delivering/attention keep today's
  phases);
- the round tab of a rejected round carries ↺ (a chosen round keeps ✓) once
  a second round exists;
- the card button's row reads «відхилено, далі раунд 2»; today's word
  «обрано {chosen}» would print «обрано » with nothing after it;
- when round N+1 is published it supersedes nothing (round N is decided) and
  becomes the waiting round, as today.

**Pressing reject with an empty field** keeps the button enabled, focuses the
field, outlines it in the caution tone and says «Спершу напишіть або
надиктуйте, що переробити» directly under it, above the actions on the phone
(the «asks» frames). A disabled button would leave the operator guessing why.

**Shared by the three variants** (after the critic's round):

- The rejection has its own kind, the caution tone the hint already uses:
  tinted while it is one action among others, filled once it is the action.
  The accent stays with «Зберегти вибір». One filled button per state.
- While the field is the corrections field its placeholder reads «Напишіть
  або надиктуйте, що переробити в раунді 2…» and the microphone takes the
  text's contrast, so dictation is visible before any error.
- The decided footer says «Відхилено» with the time, the corrections, and one
  line about the coming round («Поправки доставлено · оркестратор готує
  раунд 2»).

### Variant 1 — «Окрема кнопка»

A button «↺ Відхилити й переробити» in the footer beside «Зберегти вибір»,
tinted in the caution tone so it never reads as «Сховати». The comment field
is the corrections field, as it is today; while no variant is ticked it
carries the corrections placeholder. Ticks are optional: ticked variants go
along as «closest».

- While no variant is ticked «Зберегти вибір» cannot be pressed, so it is an
  outline with no fill: it never outshines the rejection, at rest or when the
  rejection asks for words. Once corrections are written with no tick, the
  rejection is filled.
- Desktop: «Сховати · ↺ Відхилити й переробити · Зберегти вибір», one row.
- Phone: one row as well. «Сховати» is a plain word with no box, the
  rejection is labelled «↺ Переробити» (its accessible name stays the full
  «Відхилити й переробити»), then «Зберегти вибір».
- Cost: one button, no new state. The footer has three actions.

### Variant 2 — «Перемикач «Обрати / Переробити»»

A two-way switch heads the footer: «✓ Беру варіант | ↺ Переробити все». It
replaces the «Обрано» hint line: nothing stands beside it until a variant is
ticked, then «Обрано» with the chips. In «Переробити все» the variants cannot
be ticked (the list's numbers fade on the desktop, the phone's «Обрати» button
leaves), the desktop line reads «Жоден варіант не береться. Раунд 2 зроблять
за вашими поправками.», the field becomes the corrections field and the one
filled button becomes «↺ Відхилити й переробити» in the caution tone.

- The intent is stated before the operator writes, and the filled button is
  always the one action of the chosen mode.
- Cost: a new control that is present on every review, mostly unused. It takes
  the row the hint had, so the default state adds no row.

### Variant 3 — «Жоден не підходить» у рядку вибору

The «Обрано» line gains a toggle, «☐ Жоден не підходить», drawn as a control
(text and border at full contrast): after the hint while nothing is ticked,
after the chips once a variant is. Ticking it clears the variant ticks and the
line reads «Обрано ☑ Жоден не підходить далі раунд 2» («none» is said once, by
the ticked toggle; the words after it give only the consequence), the
variants cannot be ticked until it is unticked, the field becomes the
corrections field and the one filled button becomes «↺ Відхилити й
переробити» in the caution tone.

- «None fits» sits where the operator already chooses, as one more answer to
  the same question, on the same line at both widths and in both languages
  (on the phone the hint shortens to «поки нічого» to leave it room).
- Cost: a small toggle on the «Обрано» line.

### Recommendation

**Variant 3.** It answers the operator's own framing («мне приходится выбирать
прототипы, даже если я хочу их отклонить») by adding «none fits» to the choice
itself, keeps one primary action, and adds the least chrome (the standing
operator rule: no new control where an existing one can carry the
behaviour). Variant 1 is the literal reading of «кнопочка» and the simplest to
build; choose it if a visible button matters more than one primary. Variant 2
adds a permanent mode switch for an occasional action and is the heaviest.

### Build scope (for the build lane after the operator's pick)

1. `types.ts`, `model.ts`: the flag through the decision, view, summary, replica.
2. `decision.ts`: the reject branch of the validation and the message text;
   `decision.test.ts` cases: reject with an empty comment refused; reject on a
   questions-only round refused; reject without ticks admitted; the message
   names round N+1 and the publishing pipeline.
3. `PrototypeReview.tsx`: the chosen variant's control, the rejected decided
   footer, the round-tab mark; `en.ts`/`uk.ts` keys; `PrototypeReviewButton.tsx`
   row word. DOM tests beside the existing `PrototypeReview.dom.test.tsx`.
4. Rendered evidence through the existing drivers: a `?proto=1` case in the
   kanban fixture (the patch in `docs/design/prototype-reject-prototype/patch.ts`
   shows the two lines it needs) and the phone block «prototype review on the
   phone» in `issue1671Evidence.browser.test.tsx`.

## Part B — the visual-critic gate

### Where it is enforced: `publish_prototype_review` refuses

The one place every review passes on its way to the operator is
`publishPOST`. It refuses a publication **with variants** unless the caller is
a pipeline stage whose pipeline cleared a visual critic over the current
frames. The rule, read from the pipeline record the publication already loads
(`prototypeWorld.stage` resolves the caller's pipeline and stage):

1. The pipeline has a stage with role `visual-critic`, and its latest attempt
   has settled.
2. That attempt passed, **or** it failed and the stage its fail edge names
   (the fix) has an attempt that passed after it. This is what «findings fixed»
   means in the engine: with `onExhausted: "advance"` the lane goes on from the
   critic's pass edge after the last fix without a second critic run.
3. No other stage, the publishing stage aside, completed an attempt after that
   critic attempt, so frames re-rendered after the critic (a retried prototype
   stage) are not shown unjudged.

A refusal publishes nothing and says what to do, in one sentence: «Nothing was
published: a review with variants reaches the operator only after a visual
critic passed over its frames, or its findings were fixed. Compose the lane as
prototype (frames, no publish) → visual-critic → fix (the critic's fail edge,
2 rounds, advance) → publish.»

Out of the gate: a questions-only review (no frames to judge), and the same
`clientRequestId` replayed after a successful publication (it returns the round
already recorded). A seat or a bare agent outside a pipeline cannot publish
variants at all; it starts a prototype lane.

**Why here.** The gate sits where the review is shown: a lane composed wrongly,
a seat that publishes by hand, or a future composer all meet it. It reads only
state the server already holds. It costs one function beside
`publicationTarget` and its tests in `http.test.ts`.

### Composition: the seat composes it right the first time

A gate alone would let a wrongly composed lane run its prototype stage and
then fail at publication. The refusal text names the shape, and the
`create_pipeline` tool description (not the mandate, which is at its budget)
gets one line: «A prototype lane is prototype (frames, no publish) →
visual-critic → fix (onFail of the critic, maxRounds 2, advance) → publish.»
The composer does not insert stages by itself (see «Options considered»).

### The critic's standing checklist (in the role scaffold)

`VISUAL_CRITIC_CLASSES` in `src/lib/roles/defaults.ts` stays the one place the
checklist lives; the test in `registry.test.ts` pins its words. It becomes:

> Clutter: more controls, chips, cards or words than the task needs, or a new
> control where an existing one could carry the behaviour. Where to press: one
> obvious primary action per screen, every other action visibly secondary.
> Repetition: rows of identical cards, buttons or badges that read as noise.
> Overlap and truncation: controls that overlap, labels cut or ellipsised, text
> leaving its box, a page that scrolls sideways. Affordances: what can be
> pressed looks pressable, phone targets at least 44 px, chosen, disabled and
> focused states told apart. Hierarchy: the most important thing is the most
> prominent, and weight, size and spacing agree with it. Consistency: the
> product's own components, tokens, spacing and icons; the same thing looks
> the same in every variant, viewport, language and theme. No liquid glass: no
> translucent blurred panels, glossy gradients or glows. Ugliness:
> misalignment, clipping, cramped or uneven spacing, wrong emphasis,
> inconsistent colours or sizes, visual noise. Information the operator does
> not need to see: technical text, ids, paths, counters, debug detail, a fact
> shown twice.

The existing words of the test (misalignment, clipping, overlap, cramped or
uneven spacing, wrong emphasis, inconsistent colours or sizes, visual noise,
ids, paths, counters, debug detail) all stay.

The scaffold body gains a prototype mode, two sentences:

> When the brief names prototype frames (a directory of `variant-N-…` files),
> judge those frames and render more through the existing drivers only where a
> named surface, viewport, language or theme is missing. Report on every
> variant, each finding naming its variant; the verdict passes only when no
> variant has a finding.

**UI/UX skills.** `ui-ux-pro-max` is installed for Codex and under
`~/.agents/skills`; the Claude account homes that run the critic list
`impeccable-frontend-design` and not `ui-ux-pro-max`. The scaffold therefore
carries the checklist in its own words (the skill's priority table supplied
«one primary action», «44 px targets» and «no horizontal scroll») and adds:
«If a UI/UX review skill is available in your session, apply its review
checklist as well.» Nothing depends on a skill being present.

### Options considered

| Option | For | Against | Verdict |
|---|---|---|---|
| A1. Deliver the rejection to the seat (today's path) | Retries, attention, seat rotation already handled; the seat owns the task | The seat must compose round N+1 itself | **Chosen** |
| A2. Reopen the publishing pipeline | Same stages, same prompts | The pipeline has completed; reopening a completed lane is a new engine feature, and a new attempt still needs a fresh prompt with the corrections | Rejected: heavier than the problem |
| A3. Server creates round N+1's pipeline itself | No seat turn | Spends money on a lane nobody judged; duplicates the seat's composition rules | Rejected: OVER-BUILT |
| B1. `publish_prototype_review` refuses without a cleared critic | One enforcement point every path meets; reads existing state | A wrongly composed lane learns at the end | **Chosen**, with B3 |
| B2. The composer inserts critic → fix → publish after a «prototype stage» | Right shape from the start | Nothing marks a stage as a prototype stage; detection by role or prompt guesses | Rejected |
| B3. Tool description names the lane shape | Seats compose it right | Advisory only | **Chosen**, as B1's companion |
| B4. Bind the critic to frame digests | Proves which bytes were judged | The critic would have to report digests; agents are not adversaries here; ordering by completion time covers re-renders | Deferred |

## Questions for the operator

1. **Which variant of the reject answer?** 1 «Окрема кнопка», 2 «Перемикач
   Обрати / Переробити», 3 «Жоден не підходить» у рядку вибору.
   Recommendation: **3**.
2. **May a rejection carry ticked variants as «closest»?** a) yes, ticks go
   along as a hint for round N+1; b) no, a rejection always clears the ticks.
   Recommendation: **a** for variant 1 (ticks stay usable beside the button);
   variants 2 and 3 clear the ticks by design, so the question only matters
   if you pick 1.
3. **Must a rejection carry corrections?** a) yes, the field is required and
   an empty press asks for words; b) no, an empty rejection is allowed.
   Recommendation: **a**: round N+1 is made from those words.

## Deferred — not currently justified

- Rejecting from Telegram (a «· Переробити» segment in the copy line parsed by
  `telegramAnswer.ts`). The requirement names the review on desktop and phone.
- Rejecting from the voice companion and the external relay answer path.
- Binding the critic's pass to frame digests (B4).
- Reopening or cloning the publishing pipeline automatically (A2, A3).
- A per-variant comment field. One corrections field covers «what to redo».
- An operator override that publishes variants without a critic. The
  requirement says the operator sees prototypes only after the critic.

## Prototype evidence

Built on the real `PrototypeReview` in an export of 69ad5cf84, patched by
`docs/design/prototype-reject-prototype/patch.ts` (variant chosen in the page;
0 draws today) and rendered by `render.ts` through the kanban fixture
`issue1695Evidence.fixture.tsx?proto=1` and the shared harness
(`serveEvidenceFixture`, `openFixture`). The task is the fixture's
«Search results layout» round with four variants; the patch gives its task
line a Ukrainian reading in the uk frames. Measured geometry is in
`docs/design/prototype-reject-prototype/geometry.json`.

Frames: `variant-N-<1440|390>-<uk|en>-<light|dark>-<state>`, states `rest`
(opened), `picked` (variant 1 ticked, the field empty), `pickedtext` (variant 1
ticked, a comment written), `armed` (corrections written), `asks` (reject
pressed with no words), `rejected` (after the rejection). `rest` and `armed`
come in `-original` (today, unchanged) / `-changed` pairs. Each frame carries a
printed band naming its variant, viewport, language, theme and state. 3
variants × 2 widths × 2 languages × 2 themes × 6 states = 144 frames, plus 48
originals.
`REJECT_ONLY=<pattern>` renders a subset and merges its geometry.

**Measured** (geometry.json, every frame, zero failures): no two footer
controls overlap, no label is cut, nothing leaves the screen, the footer never
scrolls sideways, each open state has exactly one save button, and the actions
take one row. The critic's findings are checks of the same run: no English
word in the task line of a uk frame; the «write first» words start within
12 px under the field and, on the phone, end above the actions; the
corrections placeholder names dictation and the microphone has the text's
colour; in variant 1 the unavailable save is never filled; no variant can be
ticked in the redo mode of variants 2 and 3; variant 3's toggle stands 12 px
after the words before it, on the «Обрано» row, at both widths and in both
languages. With a variant ticked (`picked`, `pickedtext`) the save is the one
filled action and can be pressed, variant 1's rejection has another fill than
the save, the footer lists exactly one ticked variant and its name is not cut.
In variant 3's redo mode the words beside the ticked toggle hold no «жоден» or
"none". On the phone the switch's sides and the toggle are as tall as the
actions under them (44 px).

The footer's height against today's (uk, light):

| | 1440, corrections written | 390, opened | 390, corrections written |
|---|---|---|---|
| today | 111 px | 148 px | 176 px |
| Variant 1 | 111 px | 152 px (+4) | 176 px |
| Variant 2 | 121 px (+10) | 174 px (+26) | 202 px (+26) |
| Variant 3 | 115 px (+4) | 168 px (+20) | 196 px (+20) |

On the phone the footer is the space the stage loses. Variant 1 now costs
none; variants 2 and 3 cost the 44 px touch row their control needs. With a
variant ticked, variant 2 lists it on a row of its own under the switch at 390
(200 px); variants 1 and 3 keep their opened height (152 and 168 px).

**After the visual critic** (round 1 judged the 144 frames of the first
render and failed all three variants; every finding is fixed in this render):

- The task line reads Ukrainian in uk frames.
- Variant 1: the rejection is tinted in the caution tone and filled once
  corrections are written with no tick; while no variant is ticked the
  unavailable save is an outline with no fill; the phone footer is one row («Сховати» as a plain word, «↺
  Переробити», «Зберегти вибір»).
- The «write first» words sit directly under the outlined field, above the
  actions on the phone.
- The corrections placeholder is the same in the three variants and names
  dictation; the microphone has the text's contrast there.
- Variants 2 and 3: no variant can be ticked in the redo mode (faded numbers
  on the desktop, no «Обрати» button on the phone); the rejection is filled
  in the caution tone, the save in the accent.
- Variant 2: the switch replaces the «Обрано» hint; its first side reads
  «Беру варіант», so «Обрати» appears once on the phone.
- Variant 3: the toggle follows the «Обрано» words at the left at both widths
  and in both languages, drawn at full contrast in both themes.
- The rejected footer names round 2 once.

Round 4 of the critic passed those and asked for three more, fixed in the
current render:

- Every variant is framed with a variant ticked, with an empty field and with
  a comment (`picked`, `pickedtext`). Variant 1: «Зберегти вибір» in the accent
  beside the tinted «Відхилити й переробити» (the state question 2 is about).
  Variant 2: «Обрано» with the chip beside the switch on the desktop, under it
  on the phone. Variant 3: «Обрано», the chip and the unticked toggle on one
  row at 390.
- Variant 3 says «none» once in the redo mode: the ticked toggle, then «далі
  раунд 2».
- On the phone the switch's sides and the toggle are 44 px tall, as the
  actions are; the actions keep one row.

Notes that remain: in variant 1 the corrections placeholder shows before the
operator has decided anything, because without a tick the field can only feed
a rejection; in the choose mode of variants 2 and 3 the microphone keeps
today's muted look; the phone sheet keeps today's empty band between the
thumbnails and the footer. No liquid glass, no technical text added.

## Validation against the requirement

- «кнопочка … отклонения»: every variant gives «Відхилити й переробити»
  without a tick (variant 1 as its own button, 2 and 3 as the primary of a
  reject choice).
- «куда я могу записать вот это голосовое, или поправки»: the review's comment
  field with the composer's microphone, required for a rejection.
- «чтобы было понятно, что нам нужен новый раунд»: «Відхилено» with «оркестратор
  готує раунд 2» in the review, a mark on the round tab and the card's row; the message tells the seat
  to make round N+1.
- «как только делается прототип, всегда он должен … проходить … визуального
  критика»: `publish_prototype_review` refuses variants without a cleared
  critic.
- «захламлённость … непонятно, куда нажимать, миллион одинаковых элементов»,
  «скилы … UI/UX»: the checklist in `VISUAL_CRITIC_CLASSES`, with the skill
  applied when present.
- «критик должен пройти по всем … все переделать … И после этого только …
  показывать мне»: the prototype mode reports on every variant; the gate admits
  a publication only after a pass or a passed fix of the critic's findings.
