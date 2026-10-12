# Prototype review: «Жоден не підходить», the critic gate, and the tile gallery

## Originating requirement

Operator, 2026-10-12 about 08:10Z, in the orchestrator chat (Russian, verbatim):

> «Нужно придумать новое решение для отклонения. Прототипа, потому что мне приходится выбирать прототипы, даже если я хочу их отклонить. Я думаю, нужна кнопочка с отклонения их, и куда я могу записать вот это голосовое, или поправки, что я хочу переделать, и чтобы было понятно, что нам нужен новый раунд. … как только делается прототип, всегда он должен визуально проходить проверку, визуального критика … критик должен пройти по всем, дать замечания по всем, все переделать потом после этого, фиксануть. И после этого только прототип можно показывать мне.»

Operator decision, 2026-10-12 14:50Z, on the prototype round «Відхилити всі варіанти й переробити: 3 варіанти після критика» of this task: variant 3 «"Жоден не підходить" у рядку вибору»; question 3 a) «Так, порожнє відхилення просить написати чи надиктувати правки»; question 4 a) «Так, вводимо ворота так» (publish_prototype_review refuses a review with variants until the visual critic has passed over its frames or its findings are fixed; prototype lane = prototype → critic → fix (2 rounds) → publish; the critic's checklist lives in its role). Comment on the same decision, verbatim:

> «Так, третий вариант хороший, хорошо. Единственное, что я теперь хочу в эту же задачу добавить ещё. Что это можешь. Дополнительного раунда прототипа, уже согласовываем и начинаем. Значит, сейчас, когда я вижу прототипы, у меня показывает это всё как одна картинка, крупная, и много маленьких, такой как... как он называется, не аккордеон, ну, короче, список внизу. Вот, картинок. А я бы хотел. Чтобы это был, наверное, была какая-то, знаешь, как вот компактная плитка из картинок, которую я бы мог кликать и приближать бы. То есть сразу были бы, и бы это был вертикальный скролл, не горизонтальный. То есть у нас нет одного крупного посередине, а я сразу выбираю из них, смотрю, какой мне больше подходит. Может быть, даже, если каждая картинка как-то подписана, чтобы, ну, чтобы это как-то выглядело. Я не знаю, как это лучше сделать, но приблизительно вот так.»

Three outcomes follow, and this document designs each against the code on `main` at the pipeline's base commit:

- **A.** Variant 3 exactly as framed: a «Жоден не підходить» choice in the «Обрано» row that clears the ticks, requires corrections (typed or dictated), and sends a decision the seat reads as a rejection that opens a new round.
- **B.** `publish_prototype_review` refuses a review with variants until a visual-critic pass over its lane is recorded as passed or its findings fixed, and the refusal names what is missing. The critic's checklist lives in its role. Prototype lanes the seat composes are prototype → critic → proto-fix (2 rounds) → publish.
- **C.** No hero picture with a strip under it: every frame is a captioned tile in a compact grid that scrolls vertically; a click opens the frame enlarged, with a way back. Desktop and 390 px.

## What the chosen frames show (variant 3)

Read from the decided round, 24 frames of variant 3 (1440 and 390, uk and en, light and dark): states *rest*, *picked*, *picked with text*, *armed* (none-fits ticked, corrections typed), *asks* (none-fits ticked, field empty, primary pressed), *rejected* (after saving). The build reproduces these states, with C's gallery in place of the stage and strip the frames still show:

| State | «Обрано» row | Field | Actions |
| --- | --- | --- | --- |
| rest | «Обрано · поки нічого» then an outlined check-chip «☐ Жоден не підходить» | placeholder «Що змінити або додати…» | «Сховати», accent «Зберегти вибір» disabled |
| picked | «Обрано» + chip «1 Компактний список» + the unticked none-fits chip | as rest | «Зберегти вибір» enabled |
| armed | «Обрано» + ticked chip «☑ Жоден не підходить» in caution colour + muted «далі раунд 2»; every variant tick cleared | caution outline, placeholder «Напишіть або надиктуйте, що переробити в раунді 2…», microphone as before | caution-filled «↻ Відхилити й переробити» replaces «Зберегти вибір» |
| asks | as armed | empty, caution outline, under it «Спершу напишіть або надиктуйте, що переробити» | nothing is sent |
| rejected | the decision block reads «↻ Відхилено» with the time | the corrections as the saved comment | delivery line «Поправки доставлено · оркестратор готує раунд 2» once delivered |

The last critic pass on that round (P3) said the redo row printed «none» twice («Обрано жоден» beside the ticked chip). The r5 frames the operator chose already fixed it: the label stays «Обрано», the chip says «Жоден не підходить», and the text beside it says only the consequence, «далі раунд 2». The same pass asked for the chip to be 44 px tall on the phone, like the actions under it.

Question 2 of the round (ticks travel with a rejection as «closest») matters only for variant 1, which was not chosen. Variant 3 clears the ticks by design, so nothing of question 2 is built.

## A. «Жоден не підходить» and the rejection decision

### Payload

`DecidePrototypeInput` (`src/lib/prototypeReview/types.ts`) gains one optional field:

```ts
export interface DecidePrototypeInput {
  reviewId: string;
  chosen: number[];
  comment: string;
  answers?: PrototypeAnswer[];
  skip?: true;
  /** None of the variants fits: no variant is chosen, the comment carries the corrections, and the seat opens a new round. */
  reject?: true;
}
```

A rejection on the wire, from the review form to `POST /api/tasks/:id/prototypes`:

```json
{ "reviewId": "pr_…", "chosen": [], "comment": "Усі чотири перевантажені. Потрібен один простий список…", "reject": true }
```

On a round that also carries questions, `answers` (or `skip: true`) rides along exactly as today; rejection concerns the variants only.

The stored `PrototypeDecision` gains `rejected?: true`. The public view (`PrototypeRoundView.decision`), the summary (`PrototypeReviewSummary.decision`) and `read_prototype_review` carry `rejected: true` beside `chosen: []`, so a reader never has to infer a rejection from an empty choice.

### Server rules (`decidePrototype` in `src/lib/prototypeReview/decision.ts`)

Checked in this order, each refusal a `PrototypeError` 400 whose message names the field:

1. `reject` is `true` or absent (`invalid reject`).
2. `reject` needs variants: a round without variants refuses `this round has no variants to reject`.
3. `reject` chooses nothing: a non-empty `chosen` refuses `a rejection chooses no variant`.
4. `reject` needs corrections: a comment that is empty after trim refuses `write or dictate what to redo`. The form never sends such a request (it shows the prompt instead); the server rule keeps any other caller to the same contract.
5. The existing rule `(!chosen.length && !round.questions?.length) → "choose one or more declared variants"` admits the empty choice when `reject` is set.

The «same decision again» comparison adds `rejected`, so a change from a choice to a rejection (or back) is a changed decision and goes as an amendment under a key of its own, as every changed decision does today. Revisions, the decision lock, the background delivery and the Telegram path stay as they are. The Telegram reply grammar does not learn a rejection (Deferred).

### What the seat receives

`prototypeDecisionText` writes the rejection so that no line names a variant as chosen. For a round without questions:

```
Prototype review decision
Task: <task id> — <task title>
Round: <round title>
Rejected: none of the variants fits. Publish a new prototype round on this task that applies the corrections below; build no variant of this round.

Corrections:
<comment>

End of prototype review decision.
```

For a questionnaire round with variants the text keeps its `Answers:` block and puts the `Rejected:` line where `Chosen: …` stands today. The amendment header is unchanged. The `Chosen:` line is never written for a rejection, and the `Comment:` heading becomes `Corrections:`. The instruction travels inside the message, so the orchestrator mandate needs no new sentence for it (the mandate sits a few bytes under its budget).

### Readers that must accept an empty choice

- `src/lib/prototypeReview/model.ts`: `prototypeRoundMetadata` and `prototypeReviewSummary` pass `rejected` through.
- `src/lib/prototypeReview/replica.ts`: both strict schemas gain `rejected: z.literal(true).optional()`. The summary check becomes `chosen.length > 0 || answered || rejected`, and `validQuestionDecision` admits a non-questionnaire decision with `chosen: []` only when `rejected` is set and the comment is non-empty. Without this, a linked installation would refuse the whole replica of a task whose latest round was rejected.
- `src/components/prototypeReview/PrototypeReviewButton.tsx`: a rejected latest round reads «відхилено» / «rejected» on the card's row (`proto.row.rejected`) and in its accessible name (`proto.button.aria.rejected`), instead of «обрано » with an empty list.
- `src/lib/done/frames.ts` already skips a round whose `chosen[0]` is undefined. `src/lib/externalRelay/prototypeAnswer.ts` cannot produce a rejection. Neither changes.

### The form (`src/components/prototypeReview/PrototypeReview.tsx`)

- `Draft` gains `reject: boolean`. Ticking the none-fits chip sets `reject` and clears `chosen`. Ticking any variant (click or digit key) clears `reject`.
- The «Обрано» row shows whenever the round has variants and is open, including on a questionnaire round with nothing ticked (today it hides there), because the chip lives in it.
- The chip is `role="checkbox"` with `data-prototype-reject`, the text «Жоден не підходить» / «None fits», 32 px on a fine pointer and 44 px on a coarse one (the action buttons' sizes). Ticked, it takes the caution colours, and a muted `data-prototype-next-round` span says «далі раунд {n}» / «round {n} comes next», where `n` is the task's round count plus one.
- With `reject` set, the primary button reads «Відхилити й переробити» / «Reject and redo» with a rotate icon and the caution fill, and the placeholder reads `proto.reject.placeholder`. `savable` becomes `open && canSend && (reject ? true : hasQuestions ? answersValid : chosen.length > 0)`: the button stays pressable while the field is empty so that the press can ask.
- A press (or Ctrl/Cmd+Enter) with `reject` and an empty comment sends nothing. It sets `rejectAsked`, which draws the field's caution outline with `aria-invalid="true"`, shows `data-prototype-reject-needs` «Спершу напишіть або надиктуйте, що переробити» under the field, and focuses the field. Typing or dictating clears it. Speech in flight blocks the save as it does today.
- The decided block reads `data-prototype-rejected` «Відхилено» with a rotate mark instead of the chosen chips, shows the comment, and words the delivered phase as `proto.saved.rejectedDelivered`. The other phases keep their existing words.
- The close guard counts a ticked none-fits chip with an empty field as nothing to lose (no words typed).

New i18n keys in `src/lib/i18n/uk.ts` and `src/lib/i18n/en.ts`: `proto.reject.none`, `proto.reject.nextRound`, `proto.reject.placeholder`, `proto.reject.needs`, `proto.reject.save`, `proto.reject.saveAria`, `proto.rejected`, `proto.saved.rejectedDelivered`, `proto.row.rejected`, `proto.button.aria.rejected`. Every step counter stays in sentence case («далі раунд 2»), never uppercased beside the digit.

## B. The critic gate at publication

### What counts as a pass

No new store. The pipeline record already holds what the operator's rule needs: the critic stage, its attempts and verdicts, and its fix stage. The gate reads it at the moment of publication.

A new pure module `src/lib/prototypeReview/criticGate.ts`:

```ts
export type PrototypeCriticPass = {
  pipelineId: string;
  stageId: string;          // the visual-critic stage
  attempt: number;          // its latest attempt
  outcome: "passed" | "fixed";
  fixStageId?: string;      // with "fixed": the critic's onFail target
  fixAttempt?: number;      // with "fixed": the passed fix attempt
};
export function prototypeCriticGate(pipeline: Pipeline | null, publishingStageId: string):
  { ok: true; pass: PrototypeCriticPass } | { ok: false; missing: string };
```

Rules, in order:

1. The caller must be a pipeline stage. A caller that is not (a seat, a spawned agent) gets `missing` = «this caller is not a stage of a prototype lane».
2. The lane must have a stage whose `effectiveRole.roleId` is `visual-critic`, other than the publishing stage. Otherwise `missing` = «this lane has no visual-critic stage».
3. For each such stage, its latest non-historical attempt decides:
   - `state === "passed"` → `outcome: "passed"`.
   - `state === "failed"` with verdict `fail` → the stage's `onFail.to` fix stage must have a non-historical attempt with `state === "passed"` whose `startedAt` is at or after the critic attempt's `completedAt` → `outcome: "fixed"`. This is the exhausted-budget path (`onExhausted: "advance"`), where the last fix takes the critic's last findings and the lane moves on without re-running the critic. It is what the earlier lane on this task did (critic attempt 2 failed, proto-fix passed after it, publish ran).
   - Anything else (not run yet, running, `needs_decision`, failed with no passed fix since, skipped) is missing, worded with the stage id and the attempt: «visual-critic stage `critic` has not passed: attempt 2 failed and fix stage `proto-fix` has not passed since» or «… asked for a decision».

Only reviews with variants are gated (`input.variants?.length > 0`). A questions-only form passes untouched, so seat decision forms keep working.

### Where it is checked

`publishPOST` in `src/lib/prototypeReview/http.ts`, after `parsePrototypeInput` and `publicationTarget`, before `publishPrototype`:

```ts
if (input.variants?.length) {
  const gate = prototypeCriticGate(stage?.source.pipelineId ? world.pipeline(stage.source.pipelineId) : null, stage?.source.stageId ?? "");
  if (!gate.ok) throw new PrototypeError(criticRefusal(gate.missing), 409);
  critic = gate.pass;
}
```

`PrototypeWorld` (`src/lib/prototypeReview/world.ts`) gains `pipeline(id): Pipeline | null`, which reads `loadPipelines()`. Test worlds get a fake.

The refusal names what is missing and how to proceed, and says nothing was published:

> publish_prototype_review refused: a review with variants reaches the operator only after the visual critic. {missing}. Run the lane as prototype → visual-critic (onFail proto-fix, maxRounds 2, onExhausted advance) → publish, and publish from the publish stage with a new clientRequestId. A form with questions only needs no critic. Nothing was published.

The «new clientRequestId» line is there because the MCP receipt layer replays a stored refusal under the same id.

### How the pass is recorded

`publishPrototype` takes the pass and stores it on the round as `critic: PrototypeCriticPass` (`PrototypeReviewRound` in `types.ts`). It is local provenance like `publicationKey`: `prototypeRoundMetadata` leaves it out, so it never crosses to a linked installation and the replica schema does not change for it. The publish answer echoes it (`critic: { stageId, attempt, outcome }`), so the publishing stage can quote it in its report. A replay of the same publication returns the stored round as today.

Binding the pass to the exact frame bytes was considered and rejected: under the operator's own rule a fix stage's frames (which no critic re-judged) are publishable once its pass follows the critic's last fail, so a byte binding would contradict «or its findings are fixed». The gate binds to the lane instead.

### The critic's checklist (`src/lib/roles/defaults.ts`)

`VISUAL_CRITIC_BODY` gains a prototype mode and the operator's checklist. `VISUAL_CRITIC_CLASSES` gains a third class:

> Unclear use: clutter, no clear place to click or no single main action, many identical elements side by side.

Step 1 gains, before the driver list:

> When the brief or your stage input names prototype frames (the directory a prototype or fix stage wrote for publish_prototype_review), judge exactly those frames and produce none yourself.

Step 3 gains:

> In a prototype review, judge every frame of every variant and give findings for each variant that has them; your summary names each variant with what holds. A variant you could not judge fails the stage.

The registry test pins (`src/lib/roles/registry.test.ts`) are updated to the new text. The unframed rule (`VISUAL_CRITIC_UNFRAMED`) stays for product frames.

### How lanes learn the shape

- Role table in the orchestrator mandate (`src/lib/orchestrator/prompt.ts`, beside the «UI lane» line), one short line: «- Prototype lane: architect prototype stage (names its frame directory), visual-critic with onFail proto-fix (architect, maxRounds 2, onExhausted advance), then an architect publish stage; publish_prototype_review refuses variants otherwise.» The mandate sits a few bytes under its envelope and rotation-history budgets, so run `src/lib/orchestrator/prompt.test.ts` and `src/lib/orchestrator/handoffDigest.test.ts` before keeping the line. If either fails, shorten the «UI lane» line or move the detail into the `publish_prototype_review` description and leave the pointer.
- `publish_prototype_review` description (`src/lib/mcp/server.ts`): one sentence on the gate.
- `PROTOTYPE_PUBLICATION_RULE` (`src/lib/roles/defaults.ts`) and the design-stage line in `src/lib/pipelines/prompts.ts`: a design stage renders numbered variants and names their frame directory in its report; it publishes only from a lane's publish stage after the critic. Without this, every architect stage that publishes directly (as design stages do today) meets the new refusal without having been told.

## C. The tile gallery

### Layout

The stage (`data-prototype-stage`), its step buttons and counter, the full-size button, the pair modes (side by side, slider) and the thumbnail strip (`data-prototype-strip`) are removed. In their place, `data-prototype-gallery`: one vertically scrolling region holding every frame and video of the round, in variant order, then frame order.

- **Groups.** One `section data-prototype-group={n}` per variant, `aria-label="{n} · {name}"`. Groups follow each other with a hairline divider and 16 px of space. On the desktop a group has no heading: the variant list on the left names the variants and holds the choice, and each tile carries the variant's number. On the phone, a group starts with that variant's description and its «Обрати» / «Обрано» button (today's `variantWords`), since the phone has no list.
- **Grid.** Desktop: `grid-template-columns: repeat(auto-fill, minmax(176px, 1fr))`, gap 12 px, padding 16 px. That gives 5 columns in the 1440 dialog (with or without the questions panel) and 3 at 1000. Phone (390): 2 columns, gap 8 px, inset 16 px, about 175 px each.
- **Tile.** A `button data-prototype-tile={key}` holding a square box (`aspect-square`, rounded, border, `bg-sunken`) with the image `object-contain` (`loading="lazy"`, `decoding="async"`). Square is the compromise for mixed frames: a 1440×900 frame fills its width, a 390-wide phone frame fills its height, nothing is cropped. A pair (frame with `original`) shows the changed picture with the existing pair mark in the corner. An unreadable picture shows `ImageOff`, as today.
- **Caption.** Under the box: the variant number in the small badge used by today's caption line (`data-prototype-tile-number`), then the frame's caption (`data-prototype-tile-caption`), then `· {width} · {lang}` muted when the frame carries them and the caption does not already say them. At most two lines (`line-clamp-2`, `overflow-wrap:anywhere`). The whole text is the tile's accessible name: «{n} · {name} — {caption}. Відкрити на повний розмір».
- **Video.** A tile with a `<video controls preload="metadata" playsInline>` filling the square box and the same caption. Its native fullscreen is its enlarged view. `Lightbox` shows images only, and video tiles are rare.
- **In view.** An `IntersectionObserver` rooted at the gallery tracks which group is in view. The desktop list frames that variant's row (today's «current» frame) and the phone chip row presses its chip (today's `aria-pressed`), keeping the existing scroll-into-row effect. Clicking a list row or a chip scrolls the gallery to that group (`scrollIntoView({ block: "start" })` inside the gallery). Without `IntersectionObserver` (jsdom), the first group counts as in view.
- **Keys.** Digits 1–9 still toggle variants. The arrow keys no longer step a stage: the gallery scrolls natively, and the enlarged view keeps its own arrows.

The desktop dialog keeps its size, header, round tabs, variant list (264 px), questions panel (360 px) and footer. On the phone the sheet keeps its sticky context (round line, round tabs, variant chips), and the gallery replaces the stage inside the sheet's own scroll, with no nested scroller.

### Enlarged view and the way back

A click on an image tile opens the existing `Lightbox` (`src/components/feed/Lightbox.tsx`, unchanged) through `ImageGalleryProvider`. Its gallery is every image frame of the round in tile order (`galleryOf` over all slides instead of one variant), so ←/→ and a swipe walk across variants. Its caption is «{n} · {name} — {caption}», its detail the round title, its counter `place` «k / N» over the round. A pair opens with the existing two-way switch, which replaces the removed side and slider modes.

The way back: Esc, the close button, a click on the backdrop or a vertical swipe at fit, as the viewer does today. `onShow` records the last picture shown. On close the review focuses that picture's tile and scrolls it into view (`block: "nearest"`), so the operator is where they stopped.

If #2758 lands first, it exports `roundGallery` built on `galleryOf` and `slidesOf`. Keep both helpers and that export working.

### States to render

| Surface | 1440 (and 1000) | 390 |
| --- | --- | --- |
| Gallery, rest | 4 variants in groups, list framed on the group in view | chips sticky, groups with description and choose button |
| Gallery, forty pictures in one variant (existing fixture) | scrolls vertically, no sideways scroll | same |
| Enlarged view open from a tile | Lightbox with the tile's picture, round counter | same, full screen |
| Back from the enlarged view | the last shown tile focused and in view | same |
| picked / picked with text | «Обрано» chip + unticked none-fits chip | same row, chips 44 px |
| armed | none-fits ticked, ticks cleared, caution field, «Відхилити й переробити» | same, actions on one row |
| asks | caution field, the needs line, no request sent | same |
| rejected | «Відхилено», time, corrections, delivery line | same |

Each in uk and en, light and dark.

## Rendered evidence: the existing drivers

No new driver. One new `describe` block, «prototype review: none fits and the tile gallery», goes at the end of `src/components/kanban/kanbanBoard.browser.test.tsx`, over the existing `?proto=1` review of `src/components/kanban/issue1695Evidence.fixture.tsx` (four variants, a pair, a video, forty pictures in one variant). It uses the block's own `SIZES` (1440, 1000, 390 with phone emulation), uk and en, light and dark. Frames go to `.artifacts/prototype-review/` (ignored) and readings to the committed `evidence/prototype-review/none-fits-gallery.json`.

The fixture's prototype `POST` answer accepts `reject: true`, records `rejected` on the decision, and keeps every body it receives in `protoPosts`.

Measured, and failing the run, on every frame:

- No `[data-prototype-stage]` or `[data-prototype-strip]` exists. The tile count equals the round's frames plus videos.
- The gallery has no sideways scroll: set `scrollLeft` large and read back 0, and every tile's fractional right edge stays within the gallery's. The forty-picture variant makes `scrollHeight > clientHeight`.
- Every tile in a grid has the same width and height (±0.5 px), and every tile's number badge equals its group's variant number.
- No caption is cut: a `Range` over each caption's text fits its box (two lines at most), checked as text and not as `scrollWidth`.
- A tile click opens the Lightbox with the tile's own `src`. Esc closes it, the review stays open, `document.activeElement` is that tile, and the tile lies inside the gallery's visible box.
- Footer: the none-fits chip and the action buttons share one height (44 px at 390 under phone emulation) and do not overlap. At 390 the actions stay on one row.
- armed: every `[data-prototype-variant]` reads `data-chosen="0"`, and the primary button reads the reject label.
- asks: the press adds nothing to `protoPosts`, the field has `aria-invalid="true"`, and `[data-prototype-reject-needs]` is visible inside the frame.
- rejected: the one new `protoPosts` body equals `{ reviewId, chosen: [], comment, reject: true }`, and the decided block holds `[data-prototype-rejected]` and the comment.

The existing prototype-review blocks in the same file and the phone driver's «prototype review on the phone» (`src/components/mobile/issue1671Evidence.browser.test.tsx`) read the stage, the strip and the pair modes. Update those cases to the gallery (frames now open full screen from tiles; pinch, pan, swipe and the pair switch live in the Lightbox as before). Do not add another file.

Run each through the slot, with a short Chrome TMPDIR and isolated state:

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=… bash scripts/gate-slot.sh bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "prototype review"
LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=… bash scripts/gate-slot.sh bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "prototype review on the phone"
```

## Files to change

| File | Change |
| --- | --- |
| `src/lib/prototypeReview/types.ts` | `reject` on the input; `rejected` on the decision, view and summary; `critic` on the stored round |
| `src/lib/prototypeReview/decision.ts` | rejection rules; rejection text for the seat |
| `src/lib/prototypeReview/model.ts` | pass `rejected` through; leave `critic` out of the metadata |
| `src/lib/prototypeReview/replica.ts` | admit a rejected decision |
| `src/lib/prototypeReview/criticGate.ts` (new) | the pure gate |
| `src/lib/prototypeReview/world.ts` | `pipeline(id)` |
| `src/lib/prototypeReview/http.ts` | gate in `publishPOST`; echo the pass |
| `src/lib/prototypeReview/store.ts` | store `critic` on the round |
| `src/components/prototypeReview/PrototypeReview.tsx` | none-fits chip, rejection draft and prompt, decided block; tile gallery replacing stage, strip and pair modes |
| `src/components/prototypeReview/PrototypeReviewButton.tsx` | rejected wording on the card |
| `src/lib/i18n/uk.ts`, `src/lib/i18n/en.ts` | the keys listed in A |
| `src/lib/roles/defaults.ts` | critic prototype mode and checklist; `PROTOTYPE_PUBLICATION_RULE` |
| `src/lib/pipelines/prompts.ts` | design-stage publication line |
| `src/lib/orchestrator/prompt.ts` | prototype lane line in the role table |
| `src/lib/mcp/server.ts` | one sentence in the `publish_prototype_review` description |
| `src/components/kanban/issue1695Evidence.fixture.tsx` | accept and record `reject` |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | the new block; update the old prototype blocks |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | update the phone prototype case |
| `evidence/prototype-review/none-fits-gallery.json` (new) | readings |

Tests, run by path through `bash scripts/gate-slot.sh bun test <file>` with private HOME, XDG, TMPDIR, `LLV_STATE_DIR` and a closed `LLV_VIEWER_CONTROL_URL`:

- `src/lib/prototypeReview/criticGate.test.ts` (new, pure): no pipeline; a lane without a critic; critic not run, running, `needs_decision`; critic passed; critic failed and fix passed after it (fixed); critic failed and fix passed before it (missing); the publishing stage is itself the critic (missing).
- `src/lib/prototypeReview/http.test.ts`: a publication with variants from a stage whose lane's critic has not passed is refused 409 with the missing reason, and nothing is stored; questions only passes; a passed lane publishes and the round stores `critic`.
- `src/lib/prototypeReview/decision.test.ts`: the rejection shape is stored as `chosen: []`, `rejected: true`, comment; the four refusals; the seat text has `Rejected:` and `Corrections:` and no `Chosen:`; choice → rejection is an amendment.
- `src/lib/prototypeReview/model.test.ts` and `src/lib/links/taskWire.test.ts` (the replica check `isPrototypeReplica`): summary and replica carry and admit `rejected`; `critic` stays local.
- `src/components/prototypeReview/PrototypeReview.dom.test.tsx`: ticking none-fits clears ticks and a digit clears none-fits; the empty press shows the prompt and sends nothing; the press with text sends the payload; tiles open the viewer and closing focuses the tile. Replace the stage, strip and pair-mode cases.
- `src/lib/roles/registry.test.ts`, `src/lib/orchestrator/prompt.test.ts`, `src/lib/orchestrator/handoffDigest.test.ts`, `src/lib/pipelines/prompts.test.ts`, and `src/lib/mcp/server.test.ts` if a description assertion moves.

## What not to touch

- The board header (#2782, merged) and its files: `ProjectDashboard.tsx`, `ProjectBar.tsx`, `BootShell.tsx`, `Viewer.tsx`, `KanbanBoard.tsx`, `scripts/capture-board-geometry.ts`.
- The old «Задачі» panel (lane a64c2c70) and the kanban ordering (lane dde55e2d): no file of either, `kanbanModel.ts` ordering included.
- `src/components/feed/Lightbox.tsx`, which is shared with the conversation feed. Use it as it is.
- The decision lock, revisions, background delivery, its retry and attention (`deliveryWorker.ts`, `attemptPrototypeDelivery`), the Telegram post and answer grammar, media storage and serving, publication limits.
- The MCP receipt layer.

**Order against #2758** («Рішення» as forms, open): it changes `PrototypeReview.tsx` (extracts `DecisionQuestions`, adds `roundGallery`), `decision.ts` (nullable task, seat rounds), `http.ts` (`publishPOST`, `decisionsGET`), `store.ts`, `types.ts`, `replica.ts`, `input.ts` and both i18n files. Before editing, read its current file list and hunks (`gh pr view 2758 --json files`, `gh pr diff 2758`). If it has merged, build on it. If not, keep this lane's hunks out of the question block it extracts, and expect to rebase.

## Options considered

- **Rejection payload.** A separate `reject: true` flag was chosen over a sentinel variant number (0) or an empty `chosen` alone. A sentinel would reach every reader of `chosen` as a bogus variant, and an empty choice alone is already a legal questionnaire answer, so it cannot mean «redo».
- **Gate record.** Reading the pipeline at publication was chosen over a new «critic pass» store that the critic writes through a tool. The pipeline record already holds the critic stage's attempts and its fix edge, and a second record could drift from it.
- **Tile shape.** Square tiles with `object-contain` were chosen over justified rows (tile width proportional to the frame) and over cropped `object-cover` tiles. Justified rows need each picture's size before it loads, or the grid jumps as pictures arrive. Cropping hides exactly the bottom of a phone frame, where this round's change lives.

## Deferred — not currently justified

- A rejection by Telegram reply (`· Жоден` in the reply grammar). The operator asked for it in the review form.
- Ticks travelling with a rejection as «closest» (question 2). It matters only for variant 1, which was not chosen.
- Binding the critic's pass to the exact frame bytes published. It contradicts «or its findings are fixed».
- An operator override that publishes past an unpassed critic. Nothing asked for it, and a skipped critic stage stays refused.
- Storing picture dimensions at publication for justified rows.
- Accent on the tiles of chosen variants, or choose controls on tiles. The choice stays in the list and the chips.
- A Lightbox mode for video.
