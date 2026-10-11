# Role avatars in conversations

Status: direction decided by the operator on 2026-10-11 (variant 1, costumes;
see §6). No product code. The next round iterates on the drawings themselves
after a visual critique of their elements; the frames live in
`docs/design/role-avatars/frames/`.

## The requirement

Operator request, 2026-10-11 about 11:08Z, by voice (relayed):

> «Прошу изучить идею: генерировать разные красивые иконки для разных ролей
> агентов в интерфейсе сообщений. Например, для билдера использовать образ
> Делегатуса в строительной каске; аналогично подобрать визуальные варианты для
> архитектора, разработчика и других ролей. Оценить подход и предложить, как это
> реализовать.»

The request is to study the idea, evaluate it and propose an implementation.
Its centre is the **message interface** and **the Delegatus character dressed
for the role**, with the builder in a hard hat as the example. This note checks
every option against that.

## 1. Where role identity shows today

The product already knows each conversation's role
(`conversationFrameRole`, `src/lib/roleFrames.ts`: seat designation → review-loop
side → pipeline stage `role.roleId` → spawn lineage → `neutral`). It draws that
role in six places, but **not on the messages themselves**:

| # | surface | what shows now | code |
| --- | --- | --- | --- |
| 1 | the feed: an agent's own answer | a 26 px circle in the **engine's** colour with the engine's mark (Claude/Codex/OpenClaw). Nothing says the role | `src/components/feed/FeedItem.tsx:247` |
| 2 | the feed on the phone | no avatar column; a 16 px engine glyph and the engine's name in the one-line header | `FeedItem.tsx:202`, `:225` |
| 3 | the feed: a message another agent sent (internal card) | the Delegatus mark (20 px in a 26 px accent tile), then «Агент · <role>» in text | `FeedItem.tsx:341`, label from `agentRoleLabel` `:117` |
| 4 | conversation frames: seat, dock, reader in a card, phone screen | a lucide emblem and the role's name, drawn by the chosen frame variant (default `ribbon`) | `src/components/RoleFrameMark.tsx:10`, `src/styles/roleFrames.css`, `DEFAULT_ROLE_FRAME` `src/lib/roleFrames.ts:35` |
| 5 | the open-agents rail; the needs-you rows (desktop panel, phone sheet) | the same lucide emblem on an 18–22 px role-coloured tile | `src/components/kanban/AgentWindow.tsx:172`, `RoleTag` in `src/components/attention/AttentionPanel.tsx:303`, `MobileAttentionSheet.tsx:346` |
| 6 | the pipeline graph on a board card; the phone's stages sheet | a **second, hand-drawn glyph set** `ROLE_GLYPH` with only five roles | `src/components/kanban/PipelineSection.tsx:42`, `StagesSheet.tsx:369` |

So the role is everywhere except the message column, where the operator reads.
In a seat feed full of relayed stage reports, every report carries the same
Delegatus tile, and only the small purple text tells a deployer from a reviewer.

## 2. Brand assets to build on

All emblem art is plain SVG under `public/brand/` (`docs/design/delegatus-brand.md`):
`delegatus-mark.svg` (64-unit grid: red round body, cream belly, swept grey
hair, bold glasses), `delegatus-mark-16.svg` (the same redrawn on a 16 px grid),
`delegatus-badge.svg` (head and shoulders in a slate ring), and the lockups.
`src/components/brand/BrandMark.tsx` loads them as `<img>`, so each file keeps
its own clip-path ids. The role palette is in `src/styles/roleFrames.css`
(`--rf-<role>`, `-ink`, `-fill`); the lucide emblems are the `EMBLEM` map in
`RoleFrameMark.tsx`.

The mark suits costumes. Its top (hair) and sides are free, the glasses give a
dark ink the accessories can share, and the body stays the same red in both
schemes.

## 3. Production approaches

| | A. Hand-made SVG layers on the mark | B. Generated raster set | C. Lucide glyph badges/tiles |
| --- | --- | --- | --- |
| what | the shipped mark plus one accessory layer per role (hat, cap, magnifier…) | an image model draws the character in twelve costumes; PNG/WebP files | the `EMBLEM` glyphs already shipped, on a role-coloured tile, or as a corner disc on the mark |
| cost | the twelve drawings exist as this prototype (`role-avatars/roleAvatarCostumes.ts`). Production is one SVG per role under `public/brand/roles/`, a ~40-line `RoleAvatar` component, and two slot changes in `FeedItem`. A new role costs one accessory layer | paid generation with the operator's confirmation for every round. Twelve consistent poses is the hard part: identity drift across prompts means several rounds and hand retouching | near zero: the art ships already |
| 16–32 px | 32 and 26 px read well. At 20 px the headgear reads mainly by colour and silhouette. At 16 px colour and the hat shape are left: builder, cleaner, critic and orchestrator stay distinct, the rest blur into each other (frames `variant-1-sheet-2x-*`) | an illustrated raster blurs at 16–26 px, and the browser's downscale differs per DPR | crisp at every size: a 24-unit stroke icon is designed for 16 px |
| dark/light | one file serves both. Dark-ink outlines vanish on a dark card, so every drawing carries a pale keyline around its silhouette (an SVG filter): invisible on a light card, an edge on a dark one. Hats keep mid-to-light tones (teal beanie, tan fedora, bright blue cap), so no two read alike on dark (frames `variant-1-*-dark-*`) | a raster has a baked background or halo, and one of the two schemes pays for it | follows the palette tokens; already contrast-checked |
| repository | text SVG, passes the publication gate like `public/brand/` | a committed PNG fails the privacy gate without a generator manifest (`delegatus-brand.md` §4); rasters cannot be rebuilt from source | no new files |
| maintenance | an accessory per new role; the mark changes in one place | regenerate the whole set to keep style when one role is added | add one lucide name to `EMBLEM` |

B is the most expensive option and the worst at the sizes the feed uses, so it
is not recommended and was not drawn: drawing it would itself be a paid
generation run.

## 4. The chosen variant (rendered)

Three directions were drawn and shown in the first round: 1 costume, 2 badge,
3 glyph tile. The operator chose 1; 2 and 3 are kept, described, under
"Deferred". The prototype now draws variant 1 only, at every size and in both
schemes.

It was rendered through the **production `FeedItem`**: a `git archive`
export of `87476d972` was patched (`role-avatars/render-frames.ts`) and drawn by
the existing conversation fixture
(`src/components/conversation/conversationWindowEvidence.fixture.tsx`, new
`role-avatars` case) through the existing evidence harness
(`serveEvidenceFixture`/`openFixture` in
`src/components/kanban/issue1695BrowserHarness.ts`). Every page frame holds:

- a size sheet: all twelve registry roles and the neutral agent at 32/26/20/16 px
  (phone: 26/20/16);
- the orchestrator seat's feed: the operator's question, the orchestrator's
  answers, and one internal message from **each of the other eleven roles**, so
  all twelve appear in one message list;
- a builder's own conversation: the orchestrator's brief, then the builder's
  answers.

An answer row in an agent's own feed carries the avatar
and the time only. The window header right above it already names the role and
the engine («Оркестратор · Delegatus», «Claude · Opus»), so the row repeats
neither. The internal card, where speakers mix, keeps the sender's role in text
(«Агент · Рев'юер») on one line, cut with an ellipsis when it is long.

**1 — Delegatus in the role's costume** (the operator's idea and choice). Every role
changes the silhouette at the head, as the builder's hard hat does.
Orchestrator: indigo headset. Reviewer: a large magnifier with a sky-blue rim
over the right eye, jutting past the head. Verifier: a green inspector's cap
worn with the peak to the side, a white check on the crown. Builder: yellow hard
hat. Architect: a blue set square worn on the head and a pencil behind the ear.
Cleaner: green bandana and a broom. Prod auditor: headlamp. Deployer: flight
goggles and a launch flame. Merger: a bright blue conductor's cap with a gold
band and merge badge. Maintainer: a teal knit beanie. Issue reporter: a tan
fedora with a PRESS card. Visual critic: violet beret. Neutral agent: the plain
mark. Each drawing has a pale keyline for the dark card.

Measured (`frames/geometry.json`, both schemes): no frame
scrolls sideways (0 px at 1440, 1000 and 390). Every answer avatar is a
26×26 box on the desktop, its top 4 px below the top of its header row
whatever the answer's length, and 20×20 inside the phone's 20 px header row
(overflow 0). Every internal card header is 34 px high, the issue reporter's
included.

Frames (Ukrainian, light and dark):

- `docs/design/role-avatars/frames/variant-1-desktop-{1440,1000}-{light,dark}-uk.png`
- `docs/design/role-avatars/frames/variant-1-phone-390-{light,dark}-uk.png` (2×)
- `docs/design/role-avatars/frames/variant-1-sheet-2x-{light,dark}-uk.png`: every
  role at 32/26/20/16 px
- `docs/design/role-avatars/frames/variant-1-drawings-2x-{light,dark}-uk.png`: every
  role at 96 and 48 px, so the placement and rendering of each costume element
  can be judged

The frames are ignored by git (`role-avatars/.gitignore`): a browser render has
no generator provenance and the publication gate refuses committed rasters. The
costume SVGs (`role-avatars/svg/1-costume/*.svg`) are text and can be committed.

## 5. The design (recommended, then chosen)

**Variant 1, limited to the places where the avatar is at least 20 px:** the
agent's answers in the feed (26 px desktop, 20 px phone header), the internal
card of a message another agent sent (26 px), and the conversation header.
Everything at 16–18 px keeps the lucide emblem it has today: the open-agents
rail, the needs-you rows, the frame mark and the stage graph. At those sizes a
costume is a red dot with a coloured cap, and the glyph is the clearer mark.

Why 1 over 2 and 3 (the case made in the first round): the requirement asks for the character in role costume,
and only variant 1 delivers it. At 26 px the hard hat, headset and beret read at
a glance, and a seat feed of eleven reports becomes scannable by picture. Variant
3 is the cheapest and crispest, but it is the existing emblem moved into one more
place, which is not what was asked for. Variant 2 puts two identities in a 26 px
square, and its 14 px disc is too small for the glyph.

Implementation:

1. `public/brand/roles/<role>.svg`, one per registry role, from
   `role-avatars/svg/1-costume/` as drawn (keyline included).
2. `RoleAvatar` beside `DelegatusMark` in `src/components/brand/BrandMark.tsx`:
   an `<img>` with an empty `alt`, as the mark is today. The role's name is
   always in the text beside it.
3. `FeedItem`: the answer avatar takes the conversation's frame role (already
   resolved for the frame) in place of the engine circle, as a fixed 26×26 box
   at the top of the row; the row keeps the time only, and the engine stays in
   the window header. On the phone the 20 px avatar replaces the engine glyph
   and name. The internal card draws the sender's role avatar in place of the
   Delegatus tile, and its role label truncates on one line. A `neutral`
   conversation keeps today's engine circle and name.
4. Tests: a DOM test that every `ROLE_IDS` entry resolves to a file, and a case
   in the existing kanban/phone browser drivers for one answer and one internal
   card per scheme.

## 6. Questions and the operator's answers

The operator answered the prototype review on 2026-10-11 and took the
recommended option every time:

1. Direction: **1, Delegatus in the role's costume.**
2. Engine: **only in the window header**; an answer row keeps the avatar and the
   time.
3. Surfaces: **feed answers, internal cards and the conversation header.** The
   rail, needs-you rows, frame mark and stage graph keep their glyphs.
4. A conversation with no role: **today's engine circle.**
5. Costumes: **accepted as drawn**, with one more design round on the drawings.

Their comment, verbatim:

> «Вышло офигенно. Я бы хотел ещё один раунд, пусть критик покритикует сами
> картинки, что улучшить на них, как расположение и отрисовку элементов. А в
> остальном всё супер: вот первый вариант отличный. Просто новый итерацию
> дизайна сделали.»

So the design above stands, and the next iteration changes only the drawings in
`role-avatars/roleAvatarCostumes.ts`: a visual critic reviews the placement and
rendering of each costume's elements (the `drawings-2x` and `sheet-2x` frames
first), the drawings are redrawn from those findings, and the iterated variant 1
goes back to the operator as a new round.

The questions as they were asked:

1. Which direction? **1 — costume (recommended)** · 2 — badge · 3 — glyph tile ·
   1 at 20 px and up, 3 below.
2. Where does the engine (Claude/Codex) show once the avatar shows the role?
   **Only in the window header; an answer row keeps the avatar and the time
   (recommended)** · also as text beside the time in every row · a small engine
   mark in the avatar's corner.
3. Which surfaces get the costume? **Feed answers, internal cards and the
   conversation header (recommended)** · also the rail, needs-you rows and the
   stage graph · feed answers only.
4. A conversation with no role (started by hand): **today's engine circle
   (recommended)** · the plain Delegatus mark.
5. The costumes as drawn: **accept as drawn (recommended)** · change specific
   roles (name them in the comment).

## 7. Notes found on the way (not part of this design)

- `ROLE_GLYPH` (`PipelineSection.tsx:42`) draws five roles. The deployer,
  merger, orchestrator, prod auditor, maintainer, issue reporter and visual
  critic stages all fall back to the builder's pencil in the pipeline graph,
  while `EMBLEM` in `RoleFrameMark.tsx` has all twelve. One source of glyphs
  would remove the second set.
- `agentRoleLabel` (`FeedItem.tsx:117`) translates three roles. An internal card
  from a verifier reads «Агент · Verifier» in Ukrainian. Its builder word
  («Розробник») differs from the registry's («Білдер»). `roleNameById` already
  has all twelve; the prototype uses it.
- The role palette pairs four roles: reviewer/visual critic, prod
  auditor/issue reporter, deployer/merger, maintainer/neutral. Variants 2 and 3
  inherited those collisions (the reviewer's and the critic's reports sat next
  to each other in one blue). Variant 1 tells them apart by costume, so the
  chosen design does not need the palette changed.
- On the phone the internal card's sender label («Агент · <role>») wraps today
  when the role name is long, and the card header grows by a line. The
  prototype truncates it, and the implementation (§5, step 3) does the same.

## 8. Prototype sources

`docs/design/role-avatars/`: `roleAvatarCostumes.ts` (the drawings), `roleAvatarProto.tsx`
(the costume avatar), `roleAvatarsEvidence.tsx` (the fixture case, with a
`?drawings=1` sheet at 96 and 48 px), `render-frames.ts` (the patch and the
render loop over the existing harness). These files exist only to render the
frames. Delete them once the drawings are final, keeping only the SVGs, which
move to `public/brand/roles/` in the implementation.

## Deferred — not currently justified

- **Variant 2, Delegatus with a role badge** (shown in round one, not chosen).
  The plain mark at 85 % of the box and a disc of 46 % at the bottom right in
  the role's palette colour, carrying the role's lucide emblem under the
  glasses. At 26 px the disc's glyph was about 8 px and read as a colour dot;
  under 20 px the disc carried the colour alone.
- **Variant 3, role glyph tile** (shown in round one, not chosen). The emblem
  tile the open-agents rail already draws, used as the avatar; the cheapest and
  crispest, and the existing emblem moved into one more place. It stays the mark
  on the 16–22 px surfaces (§5).

- **Generated raster set (B).** Paid, inconsistent across roles, blurry at feed
  sizes, and refused by the publication gate without a manifest.
- **Dedicated 16 px redraws of each costume** (as `delegatus-mark-16.svg` was
  for the mark). Needed only if a costume goes on a 16 px surface. The
  recommendation keeps those surfaces on glyphs.
- **Costumes in the rail, needs-you rows, frame mark and stage graph.** All are
  16–22 px; see §5.
- **Poses, animation and per-state expressions** (a working builder
  hammering, a failed stage frowning). Nothing in the requirement asks for them,
  and each one multiplies the art.
- **A settings toggle between variants.** Pick one; `?roleFrame=` already shows
  how a device-local switch would work if it were ever needed.
- **Distinct colours for the four shared palette pairs.** Needed only by
  variants 2 and 3, which were not chosen; the costumes tell those roles apart.
