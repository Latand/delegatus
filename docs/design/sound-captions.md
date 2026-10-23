# Sound captions: a short toast for every event sound

Implementation brief for the frontend builder. Base: `main` at f3a19b3c.

## Requirement

Operator, 2026-10-22 about 23:40 UTC, seat chat, voice message. The words are
paraphrased here, because the operator asked that the original never be copied
into a published file:

> The sounds shipped recently, and it is now unclear what each one means. On the
> board, on the right side where «Потрібні ви» shows, small toasts should
> appear, styled about like the voice Delegatus popup message. Each toast says
> what is being announced, for example that a critic finished. A toast stays
> for about 2 seconds. Hovering keeps it open so it can be read, and a click may
> go to the agent it is about. Toasts stay in place wherever the operator
> scrolls or moves, for example after opening a task. On the phone they are
> probably not worth showing.

Acceptance, from the pinned task:

1. Each event sound that plays shows a small toast at the right of the
   desktop view, in the «Потрібні ви» area. The toast says in plain words what
   the sound announced and who or what it is about. Text in uk and en.
2. Close to the voice Delegatus popup message: reuse its component or its
   tokens, with no new design language.
3. Visible for about 2 s. Hover holds it. Leaving resumes the countdown. A click
   opens the agent or card it is about, when there is one. Several toasts stack
   without covering each other, and the stack is bounded: the oldest leave
   first.
4. Fixed to the viewport: it stays in place while the operator scrolls, opens a
   task or switches views.
5. Desktop only: nothing at phone widths. Muted means no captions.
6. Which sounds play, when they play and how loud stay unchanged.

## 1. What plays today, and where

| Sound | Requested at | Event data at that line | Caption | Click target |
|---|---|---|---|---|
| S1 typing | `src/hooks/useToolActivityCues.ts:70` (from `src/components/LogFeed.tsx:886`) | tool call in an on-screen feed | **none** (deferred) | — |
| S2 distant typing | `src/lib/audio/fleetCues.ts:165` | session, tool item | **none** (deferred) | — |
| S3 step | `src/lib/audio/workCues.ts:171` | `pipeline` (task, project, stages), `run.stageId`, attempt key | yes | the lane's card |
| S4 landed (merged) | `src/lib/audio/workCues.ts:174` | `pipeline`, `pipeline.merge.pr` | yes | the lane's card |
| S4 landed (completed, no merge) | `src/lib/audio/workCues.ts:176` | `pipeline` | yes | the lane's card |
| S7 merge blocked | `src/lib/audio/workCues.ts:179` | `pipeline` | yes | the lane's card |
| S6 / S7 needs-you entry | `src/lib/audio/workCues.ts:66` (conversation: `entry.item.reason.kind`, `entry.item.file`), `:69` (parked lane: `entry.row.task`, `entry.row.pipeline`), `:76` (prototype: `entry.notice.title`), `:78` (update) | `MobileAttentionEntry` (`src/components/attention/attentionQueue.ts:31`) | yes | that needs-you entry |
| S5 released | `src/lib/audio/workCues.ts:232` | `DoneItemV1` (`title`, `refs.sha`) | yes | none |
| S7 deploy failed / rolled back | `src/lib/audio/workCues.ts:233` | `DoneItemV1.refs.phase` | yes | none |
| S7 limit episode | `src/lib/audio/workCues.ts:236` | `DoneItemV1.refs.account` (`label`, `window`) | yes | none |
| S8 reply | `src/lib/audio/fleetCues.ts:93` | `session.conversationId` | yes | that conversation |
| S9 launched | `src/components/DraftAgentPane.tsx:650` | `outcome.conversationId`, `outcome.launchId`, `candidate.prompt` | yes | the launched conversation, when the receipt names one |
| S6 attention request (directed) | `src/components/attention/AttentionHost.tsx:340` | `request.reason` (one operator-safe sentence, `src/lib/attention/types.ts:239`) | yes | none (the handoff UI it opens is the target) |
| S6 attention request (offer) | `src/components/overlay/useAttentionOffers.ts:373` | `pending.request.reason` | yes | none |
| Settings preview (S3) | `src/components/SoundToggle.tsx:52` (`preview: true`) | — | **none**: the operator pressed it | — |
| Dictation warn / stop | `src/hooks/useDictation.ts:596`, `:243` → `src/lib/chime.ts:137` | — | **none** (deferred) | — |
| Voice call connect / disconnect | `src/lib/voiceCompanion/cues.ts:64` via `liveAdapter.ts` | — | **none**: fenced voice files (deferred) | — |

Every event sound passes through one place before it is heard:
`playCue` (`src/lib/audio/app.ts:145`) → `createCuePlayer().play`
(`src/lib/audio/cuePlayer.ts:235`) → `lane.request` (`:254`) → window, gap and
cap in `createEventLane` (`src/lib/audio/eventLane.ts:248`) → `begin`
(`eventLane.ts:187`) → the player's `start` (`cuePlayer.ts:185`) →
`transport.startEvent` (`cuePlayer.ts:192`). A request can still end silent:
muted at play time (`:190`), quiet during a call (`:191`), transport `null`
(autoplay lock, no graph), dropped while busy (`eventLane.ts:219`), the queue
bound (`:238`), the S3 per-minute cap (`:145`), or a step superseded by its
lane's landing (`:135`, `:171`).

**So the caption fires where the sound starts.** That is `cuePlayer.ts:192–198`,
once `startEvent` has returned a non-null handle. Firing at request time would
caption sounds that never play.

## 2. Carrying the subject to the play

The lane coalesces: one play can stand for `n` requests (`batch`). The caption
data has to travel with each request through the lane.

1. **`CueRequest`** (`src/lib/audio/cues.ts:60`): add `caption?: CueCaption`.
2. **New `src/lib/audio/captions.ts`**: the types, the store and the countdown.
   It holds plain data with no i18n, so the pure planners can build it:

   ```ts
   export type CaptionWhat =
     | "step" | "merged" | "lane-done" | "merge-blocked"
     | "decision" | "question" | "plan" | "permission" | "lane-decision" | "prototype" | "update" | "attention"
     | "delivery" | "launch" | "memory"
     | "released" | "deploy-failed" | "deploy-rolled-back" | "limit"
     | "reply" | "launched";
   export type CaptionTarget =
     | { kind: "conversation"; path?: string; conversationId?: string }
     | { kind: "lane"; pipelineId: string; project: string }
     | { kind: "needs-you"; entryId: string; then: CaptionTarget | null };
   export interface CueCaption {
     what: CaptionWhat;
     /** Who or what it is about, already cut with cleanTitle(…, 90); null = resolve or omit. */
     subject: string | null;
     /** S3 only: the stage, named at render time with stageDisplayName. */
     stage?: Pick<PipelineStage, "id" | "kind" | "role">;
     pr?: number;
     target: CaptionTarget | null;
   }
   ```

3. **`eventLane.ts`**: `LaneRequest` gains `caption?`. `Batch` gains
   `captions: Array<{ pipeline: string | null; caption: CueCaption | null }>`,
   with one element per joined request, and `Queued` gains
   `captions: CueCaption[] | null`. Each place that changes `n` must change the
   captions the same way:
   - `join`/`fresh` (`:264–268`) push one element;
   - the step filter in `release` (`:135–139`) and `supersedeStep` (`:171–178`)
     drop the elements of the same pipelines;
   - the per-minute merge into `waiting` (`:146–148`) concatenates;
   - `enqueue` (`:199–203`) concatenates (`null` counts as `[]`);
   - a cut sound's replay (`:214`) is enqueued with `captions: null`: it
     already showed its toast and must not show a second.
   `EventLaneOptions.start` becomes `start(sound, batch, captions: CueCaption[] | null)`.
   Leave `n`, every window, gap, cap, the queue and the priority rules as they
   are.
4. **`cuePlayer.ts`**: `CuePlayerOptions` gains
   `onPlayed?(sound, batch, captions: CueCaption[] | null)`. Call it inside
   `start` only after `handle` is non-null (`:192–198`), with
   `prefs.cueVolume > 0` as well, because a sound at volume 0 is not heard.
   Do not call it on the preview path (`:244–247`). An event request that
   carries no `caption` still gets a toast: pass `[]`, and the stack shows the
   sound's generic line (§5, the paragraph after the batch table).
5. **`app.ts`**: wire `onPlayed` into the store's `pushSoundCaption` when the
   player is created (`:132–138`). In `watchPrefs` (`:72`), next to
   `player?.clearQueue()`, call `clearSoundCaptions()` when `cuesEnabled`
   turns false, so a mute clears what is on screen too.
6. **Call sites fill `caption`**, from the data in the table in §1:
   - `planPipelineCues`: S3 `{ what: "step", subject: cleanTitle(pipeline.task, 90), stage, target: lane }`. S4 `merged` (with `pr`) or `lane-done`. S7 `merge-blocked`. The lane target is `{ kind: "lane", pipelineId: pipeline.id, project: pipeline.project }`.
   - `needsYouRequest`: `what` comes from the reason kind, or from `lane-decision`, `prototype` or `update`. The subject is `file.title`, `row.task`, `notice.title`, or null for an update. The target is `{ kind: "needs-you", entryId: entry.id, then }`, where `then` is the conversation `{ path: file.path, conversationId }` or the lane.
   - `doneRequest`: `released` with subject `item.title || refs.sha?.slice(0, 7) || null`; `deploy-failed` or `deploy-rolled-back`; `limit` with subject `${account.label ?? account.accountId} · ${window}`. Target null.
   - `createAwaitingReplies().settle` (`fleetCues.ts:93`): `{ what: "reply", subject: null, target: { kind: "conversation", conversationId } }`. The stack resolves the title.
   - `DraftAgentPane.tsx:650`: `{ what: "launched", subject: cleanTitle(firstLine(candidate.prompt), 90), target: outcome.conversationId ? { kind: "conversation", conversationId } : null }`.
   - `AttentionHost.tsx:340` and `useAttentionOffers.ts:373`: `{ what: "attention", subject: request.reason, target: null }`.

## 3. The store: `src/lib/audio/captions.ts`

A module singleton, the same pattern as the player in `app.ts`, read with
`useSyncExternalStore`. The countdown lives in the store, so a remount of the
stack (project switch, island moving between bar and corner) loses nothing.

- `VISIBLE_MS = 2000`; `RESUME_MIN_MS = 1000`; `MAX_CAPTIONS = 4`.
- `pushSoundCaption({ sound, batch, captions })` appends one item (one play =
  one toast) with id, sound, `n = batch`, its captions and a deadline of
  now + 2000. A fifth item removes the oldest at once.
- `holdSoundCaptions(held)`: holding freezes every item's remaining time.
  Releasing sets each deadline to now + max(remaining, 1000), so a toast does
  not vanish the instant the pointer leaves.
- Hold while `document.hidden`, using the same hold. Event sounds still play in
  a hidden desktop tab (`cuePlayer.ts:204` gates only typing), and the toast
  should still be there when the operator looks back.
- `clearSoundCaptions()`, `subscribe`, `snapshot`, and
  `resetSoundCaptionsForTests()`. Use one timer for the nearest deadline, and
  use injectable timers like `LaneTimers` (`eventLane.ts:16`), so the tests run
  on `fakeTimers.fixture.ts`.

## 4. Where the stack mounts

The «Потрібні ви» chip is `AttentionIsland` (`src/components/attention/AttentionIsland.tsx:40`),
placed by the Viewer's bar-island callback (`src/components/Viewer.tsx:1844–1894`):
- inside a project's bar it is the row's last item, and the question toast
  (`AttentionToast`) hangs under it in a column `fixed top-14 z-50` at
  `right: panelDocked ? PANEL_WIDTH + 16 : 16` (`Viewer.tsx:1875`);
- on the Overview and in chats it is a fixed corner column (`:1887–1893`).
  The needs-you panel docks on the right (`panelDocked`, `:1153`) or floats
  under the chip (`panelFloating`, `:1154`). The orchestrator dock is on the
  left (`:1820`), so it does not collide.

**Do not put the stack in that `z-50` column.** An opened task's agent window
draws at `z-index: 64` (`src/components/kanban/kanbanBoard.css:937–939`, `LAYER.reader`),
which is above `z-50`, so captions there would disappear behind the task (the
fourth acceptance point). Also, `layers.test.ts` pins the exact raw `z-50`
count in `Viewer.tsx`.

Mount a new component, `src/components/SoundCaptions.tsx`, once at the Viewer
root next to `<AttentionHost>` (`Viewer.tsx:1974`), following the precedent of
`DeploymentStatusPill`, which is fixed at `Z.toast` from the same root:

```tsx
{isMobile ? null : (
  <SoundCaptions
    right={panelDocked ? PANEL_WIDTH + 16 : 16}
    hidden={panelFloating}
    suppressPath={toastFile && !panelFloating ? toastFile.path : null}
    titleOf={conversationTitle}   /* conversationId → cleanTitle(file.title, 90) from allFiles */
    onOpen={openCaptionTarget}
  />
)}
```

- `isMobile` is `useIsMobile()` (`Viewer.tsx:341`): either axis under 640 × 600,
  the same rule that hides the island. Nothing mounts at phone widths.
- **Layer**: `position: fixed`, `LAYER.toast` (84, `src/components/layers.ts:66`)
  through `Z.toast` or `${LAYER.toast}` in the stylesheet. Never use a raw number.
- **Horizontal**: `right` as passed, which is the same edge as the question toast.
- **Vertical**: the column starts no higher than 8 px under the lowest of
  these that is on screen: the island (`[data-attention-island]`), the question
  toast (`[data-attention-toast]`), and an open agent window's header
  (`.kb .agent-window .aw-head`). With none of them, 56 px (`top-14`). From
  there it takes the first place, searched downward in 4 px steps for at most
  320 px, that covers no line of text, no small control (up to 6000 px², an icon
  button, a chip) and no icon, keeping 4 px from each: the places the voice popup
  keeps to (`src/lib/voiceCompanion/placement.ts`'s `Occupancy` grid, read only).
  A control wider than that (a card's title row, a tab) counts by its text and
  icons, since a toast over its blank part hides nothing. What a person cannot
  see (under a window's scrim, in a skipped card) does not count, and the toasts
  themselves never do. The geometry is `placeStack` and the page reading is
  `readObstacles` in `src/components/soundCaptionPlacement.ts`.
- **Where no place holds the whole stack** the oldest toasts fold, newest kept
  (an old caption is the one whose sound was heard longest ago): a folded toast
  stays in the store and counts down, but is drawn off the column
  (`data-folded`, `visibility: hidden`), so it takes no space, no pointer and no
  focus. Folding stops at two toasts in a window 1100 px wide or more, and at one
  below it. With no free place for those, the stack takes the place that hides
  the fewest lines (a control counts eight lines, and a line half hidden counts
  as hidden) anywhere down the window, the nearest to the first line on a tie; the column says so in
  `data-placement="covers"` (`"free"` otherwise). The place is read when the set
  of toasts, their sizes, the window or the first line change, and never while a
  held stack sits under a feed that scrolls.
- Below 1100 px the toast is at most 240 px wide, not 300.
- `hidden` (the floating needs-you panel hangs in the same spot and lists the
  same things): render nothing. The store keeps counting down.
- `suppressPath`: skip a caption whose target conversation is the one the
  question toast already shows, so the same fact is not shown twice.
- Column: `pointer-events: none`, flex column, `align-items: flex-end`, gap 8 px.
  **The newest goes at the bottom**, so an arriving toast never moves the one
  under the pointer, and the oldest at the top leaves first.
  `aria-live="polite"` on the column.
- Hover or focus on any toast holds the whole stack (`onPointerEnter`/`Leave`,
  `onFocus`/`onBlur` on the column wrapper, which has `pointer-events: auto` only on the toasts).
- `onOpen(target)` in the Viewer:
  - `needs-you`: if `needsYou.find(e => e.id === entryId)` exists, call
    `jumpToEntry(entry)` (`Viewer.tsx:1537`). Otherwise open `then`.
  - `lane`: `selectProject(project)` when it differs, then
    `setFocusRequest({ path: laneFocusPath(pipelineId), … })`. Extract this from
    the tail of `openAttentionEntry` (`Viewer.tsx:1471–1475`) into one
    `focusLane(pipelineId, project)` and call it from both places.
  - `conversation`: find the file in `allFiles` by `path` or `conversationId`,
    then call `openFile(file)` (`Viewer.tsx:839`), the same thing the question
    toast's click does. If no file is found yet, do nothing.
  - After opening, remove that caption.

## 5. The toast: the voice popup's look

The voice Delegatus message is the companion bubble. Its markup is
`src/components/voiceCompanion/VoiceCompanion.tsx:1163`
(`<p class="vc-bubble" data-speaker="companion">`, bold `.vc-who` + `.vc-text`).
Its styles are `src/components/voiceCompanion/voiceCompanionStyles.ts:166–192`.
It is not an exported component, and `VOICE_COMPANION_CSS` is one sheet scoped to
the companion's lane. **Reuse its tokens and do not edit either file** (lanes
667909d7/#3218 and 220bf125 own the voice UI). In a `SOUND_CAPTION_CSS`
string beside the component, written the same way `voiceCompanionStyles.ts`
is, with a comment that points back at those lines:

- surface: `background: color-mix(in srgb, var(--color-raised) 92%, transparent)`;
  `border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border))`;
  `border-radius: 14px`; `box-shadow: 0 6px 18px color-mix(in srgb, var(--color-warning) 16%, transparent)`;
  `backdrop-filter: blur(8px)`; `padding: 8px 12px`; `max-width: 300px`.
  No tail, because there is no character to point at.
- line 1, what happened: 14 px / 20 px, weight 600, `--color-primary`,
  `text-wrap: pretty`. The stage name in an S3 headline is wrapped in `.vc-who`'s
  weight 700.
- line 2, about whom: 12 px / 16 px, `--color-secondary`, one line, ellipsis,
  with the full text in `title`. In a batch: «{first} · і ще {n−1}»
  (`done.group.more`). No subject means no line 2.
- With a target the whole toast is a `<button type="button">` (focus ring
  `outline: 2px solid var(--color-accent)`, as `voiceCompanionStyles.ts:66–67`).
  Without one it is a `<div>`. No × button.
- Motion is opacity and transform only: in, 180 ms from `translateY(-4px)`, with
  the bubble's `cubic-bezier(0.22, 1, 0.36, 1)`; out, a 140 ms fade. Under
  `prefers-reduced-motion`, opacity only.
- `data-sound-caption=<sound>` on each toast and `data-sound-captions` on the
  column, for the driver.

### Caption text (new keys `soundCaption.*` in `src/lib/i18n/uk.ts` and `en.ts`)

Line 1 for a single event. Plural objects follow the `uk.ts` form
(`one/few/many/other`).

| `what` | uk | en |
|---|---|---|
| step | «{stage} — пройдено» | "{stage} passed" |
| merged | «Злито» / with PR «Злито · PR #{pr}» | "Merged" / "Merged · PR #{pr}" |
| lane-done | «Лінію завершено» | "Lane finished" |
| merge-blocked | «Злиття заблоковано» | "Merge blocked" |
| decision | «Оркестратор питає вас» | "The orchestrator asks you" |
| question | «Агент питає вас» | "An agent asks you" |
| plan | «Агент чекає на схвалення плану» | "An agent waits for plan approval" |
| permission | «Агент просить дозволу» | "An agent asks for permission" |
| lane-decision | «Лінія чекає вашого рішення» | "A lane waits for your decision" |
| prototype | «Прототип чекає вашого вибору» | "A prototype waits for your choice" |
| update | «Оновлення чекає вашого рішення» | "An update waits for your decision" |
| attention | «Агент кличе вас подивитися» | "An agent asks you to look" |
| delivery | «Повідомлення не доставлено» | "A message was not delivered" |
| launch | «Агент не запустився» | "An agent failed to start" |
| memory | «Агента зупинено: забракло пам'яті» | "An agent was stopped: out of memory" |
| released | reuse `done.deploy.succeeded` «Delegatus оновлено» | "Delegatus was updated" |
| deploy-failed | reuse `done.deploy.failed` | (same key) |
| deploy-rolled-back | reuse `done.deploy.rolledBack` | (same key) |
| limit | «Вичерпано ліміт» | "A limit ran out" |
| reply | «Агент відповів» | "An agent replied" |
| launched | «Агента запущено» | "Agent launched" |

`{stage}` is `stageDisplayName(t, stage)` (`src/components/pipelines/pipelineModel.ts:753`):
«Критик вигляду», «Рев'юер», `Fix`. That gives the operator's own example: a
visual critic passing reads «**Критик вигляду** — пройдено» over the task title.

Line 1 when one play stands for `n > 1` events:

| sound | uk | en |
|---|---|---|
| S3 | `{one: "Пройдено {count} етап", few: "Пройдено {count} етапи", many: "Пройдено {count} етапів", other: "Пройдено {count} етапу"}` | `{one: "{count} stage passed", other: "{count} stages passed"}` |
| S4 | `{one: "Завершено {count} лінію", few: "Завершено {count} лінії", many: "Завершено {count} ліній", other: "Завершено {count} лінії"}` | `{one: "{count} lane landed", other: "{count} lanes landed"}` |
| S6 | «Потрібні ви: {count}» (the chip's own word) | "Needs you: {count}" |
| S7 | `{one: "{count} збій", few: "{count} збої", many: "{count} збоїв", other: "{count} збою"}` | `{one: "{count} fault", other: "{count} faults"}` |

A batch's click goes to the first caption's target. No subject at all (a
request without `caption`): line 1 uses the sound's single-event line with the
most generic `what` of its class (S3 «Етап пройдено» / "A stage passed",
S4 `lane-done`, S6 `question`, S7 «Щось зламалося» / "Something broke",
S8 `reply`, S9 `launched`, S5 `released`). Two extra keys: `soundCaption.stepGeneric`
and `soundCaption.faultGeneric`.

## 6. States the builder renders and the critic checks

Render through the existing driver only:
`src/components/kanban/kanbanBoard.browser.test.tsx`, one new `describe("sound
captions", …)` block over `issue1695Evidence.fixture.tsx`, gated by
`LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`. Readings go to
`evidence/sound-captions/rendered.json` and frames to `.artifacts/sound-captions/`
(not committed). The fixture pushes captions with `pushSoundCaption` from a
`?scenario=sound-captions` timer for the layout states. Two states go through
the real path, with a stage attempt that turns `passed` on the fixture's second
pipelines poll, Chrome started with `--autoplay-policy=no-user-gesture-required`,
and one click on the page first:

| State | How | Pass when |
|---|---|---|
| single | real path: one S3 | one `[data-sound-caption="step"]` reading «Критик вигляду — пройдено» (uk), the task title on line 2, under the island, inside the viewport |
| stacked | seam: 5 pushes 300 ms apart | the store holds 4, newest last, the first push gone; the toasts on show are the newest ones, no two boxes intersect, none intersect the island or the question toast; on a free place none covers a line of text, a small control or an icon; on a `covers` place at most two toasts (one under 1100 px) are on show and no control is under them |
| expiry | seam: 1 push, wait 2.3 s, no pointer | gone |
| hover-held | seam: 1 push, hover at 0.5 s, read at 3.5 s, leave, read at +0.8 s and +1.3 s | present at 3.5 s and at +0.8 s, gone by +1.3 s |
| click | seam: a lane target | the lane's card has the focus ring, the caption is gone |
| muted | real path with sound off (the ⋯ Sound levels switch) | the stage passes and no `[data-sound-captions]` child appears; turning sound off with one toast visible removes it |
| task open | seam push with an agent window open | the stack is above the window (`elementFromPoint` at its centre is the toast), its top is ≥ the window header's bottom + 8, the place is free: no line of the conversation, no control and no icon is under a toast, at 1440, 1000 and 640 |
| panel docked | seam with the needs-you panel docked | the stack's right edge is at `innerWidth − 336` |
| phone 390 × 844 | seam push | no `[data-sound-captions]` in the DOM |

Widths: 1440 × 900 and 1000 × 700 (the shortest desktop window, as the «Agent
typing» block uses), 640 × 700 (the desktop minimum, the width between phone and
desktop), and 390 × 844. Render en and uk, light and dark. For the long-text
check, use the longest uk line («Агента зупинено: забракло пам'яті») with a
90-character subject: line 1 wraps inside 300 px and no text range is cut.

## 7. What must not change

- Which sounds play, their timing and loudness: `LANE_RULES`, the windows, gaps,
  caps, queue bound and priority in `eventLane.ts`, every `n`, staleness and
  dedupe in `cuePlayer.ts`, the synthesis in `synth.ts`, and the transport. The
  existing `eventLane.test.ts`, `cuePlayer.test.ts`, `workCues.test.ts` and
  `fleetCues.test.ts` cases stay as they are and stay green. Only new cases are
  added.
- The question toast (`AttentionToast`), the island, the panel, and their
  positions and z classes in `Viewer.tsx:1844–1894`.
- Voice files: `src/components/voiceCompanion/**` and `src/lib/voiceCompanion/**`
  are read only. Open PR #3218 (lane 667909d7, merge queued) also edits
  `kanbanBoard.browser.test.tsx`, `issue1695Evidence.fixture.tsx`, `en.ts` and
  `uk.ts`. Rebase on main once it lands, and add your block and keys after
  theirs. Lane 220bf125 changes only `src/lib/voiceCompanion/liveSession.ts`
  and docs, so nothing here overlaps it.
- The phone: no new element, no new listener.

## 8. Tests and checks

New unit cases, run by path with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`,
`LLV_STATE_DIR` and `LLV_VIEWER_CONTROL_URL` on a closed port, through
`gate-remote -- bun test <file>` or `scripts/gate-slot.sh`:

- `src/lib/audio/eventLane.test.ts`: captions reach `start` in batch order; a
  superseded step's caption leaves with it; a per-minute wait and a queue merge
  concatenate; a cut sound's replay passes `null`.
- `src/lib/audio/cuePlayer.test.ts`: `onPlayed` fires only after a non-null
  handle; never when muted, at volume 0, quiet during a call, on the preview, or
  for a transport `null`.
- `src/lib/audio/captions.test.ts` (new): 2000 ms expiry, the bound of 4 with
  the oldest out, hold and resume with the 1000 ms floor, hidden-document hold,
  clear.
- `src/lib/audio/workCues.test.ts`, `fleetCues.test.ts`: each planner attaches
  the `what`, subject and target from the §1 table.
- `src/components/SoundCaptions.dom.test.tsx` (new): uk and en text from §5, a
  button only with a target, `onOpen` receives the target, `suppressPath` and
  `hidden` render nothing.
- `src/lib/i18n/i18n.test.ts` (key parity), `src/components/layers.test.ts`.

Then `tsc` through `gate-remote`, ESLint on the touched files, and the browser
block in §6 through `scripts/gate-slot.sh` (it needs its own 8 GB scope).

## Deferred: not currently justified

- **Captions for S1 and S2 typing.** They run at about 1,600 tool calls an hour
  (`docs/design/sound-redesign.md` §3). A toast for each would bury the event
  toasts, and typing needs no explanation.
- **Captions for the dictation pings and the voice call connect/disconnect pair.**
  Each answers the operator's own action on a control already in front of them,
  and the call cues live in fenced voice files.
- **A per-toast close button, a history of past captions, a setting to turn
  captions off separately from sound.** None was asked for. The mute switch
  already turns them off.
- **Captions on the phone.** The operator doubted their use there, and acceptance
  point 5 rules them out.
