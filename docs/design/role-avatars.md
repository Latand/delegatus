# Role avatars in conversations

Status: built (§10). The operator chose variant 1, costumes (§6), accepted the
round-2 drawings as drawn (§9), and added two decisions at build time: the model
stays everywhere it shows today, and the agent with no role wears sunglasses and
a tuxedo (§10). The prototype harnesses of both rounds (`docs/design/role-avatars/`,
`prototypes/role-avatars/`) stayed on the design branches; the drawings ship as
`src/components/brand/roleCostumes.ts`.

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
| dark/light | one file serves both. Dark-ink outlines vanish on a dark card, so every drawing was drawn with a pale keyline around its silhouette (an SVG filter): invisible on a light card, an edge on a dark one. The dark theme later dropped it again (§11). Hats keep mid-to-light tones (teal beanie, tan fedora, bright blue cap), so no two read alike on dark (frames `variant-1-*-dark-*`) | a raster has a baked background or halo, and one of the two schemes pays for it | follows the palette tokens; already contrast-checked |
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
mark. Each light drawing has a pale keyline; the dark theme draws none (§11).

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

Round 2: `prototypes/role-avatars/` (§9). Round 1, kept as the "before":
`docs/design/role-avatars/`: `roleAvatarCostumes.ts` (the drawings), `roleAvatarProto.tsx`
(the costume avatar), `roleAvatarsEvidence.tsx` (the fixture case, with a
`?drawings=1` sheet at 96 and 48 px), `render-frames.ts` (the patch and the
render loop over the existing harness). These files exist only to render the
frames. Delete them once the drawings are final, keeping only the SVGs, which
move to `public/brand/roles/` in the implementation.

## 9. Round 2 of the drawings

The operator asked for one more round on the pictures themselves (§6). A visual
critic wrote 28 numbered items (`role-avatars-critique-2.md`); this round
applies them to variant 1 and changes nothing about the decided layout.

Where it lives: `prototypes/role-avatars/` (the stage's declared prototype
output; round 1 stays in `docs/design/role-avatars/`). `roleAvatarCostumes.ts`
holds the drawings, `svg/1-costume/*.svg` the files they produce,
`render-frames.ts` the same render loop as round 1 plus a round 1 / round 2
sheet, and `measure-drawings.ts` the grid measurements below. The frames
(ignored by git) are in `prototypes/role-avatars/frames/`: desktop 1440 and
1000, phone 390, light and dark, the 32/26/20/16 px sheet, the 96/48 px
drawings, and `variant-1-compare-2x-*` with round 1 beside round 2 at 80 and
26 px.

### The rules every drawing now follows

- **Inside the canvas** (item 1). All ink sits in x 3–61, y 2–62, so the
  keyline never meets the edge. The one exception is the neutral agent, which
  stays the shipped mark exactly (item 28): its hair tip at y 1.0 leaves its
  keyline 0.2 units short of the edge, under a pixel even at 96 px. Costumes
  that keep the full hair (reviewer, prod auditor) draw that tip 1.4 units lower.
- **Two line weights** (item 4). Every accessory outline is 2.6; the glasses
  keep 3.6. A strap or rim (headset band, loupe rim, prod auditor's strap) is a
  colour band with a 1.3 ink edge each side, the same edge an outlined shape
  shows. Nothing inside an accessory is thinner than 2 units (ruler ticks,
  merge mark, beanie ribs and the broom's binding are 2-unit strokes or filled
  shapes).
- **No highlights** (item 5). The beret's sheen and the loupe's and goggles'
  glints are gone, so every hat is flat colour like the body. The hard hat keeps
  its ridge as part of its shape, in the brim's darker yellow.
- **No grey fin** (item 3). A hat covers the hair; no sideburns were added,
  because the strip between a brim and the glasses is about two units.
- **Keyline** (item 6): radius 1.7 → 1.2, opacity 70 % → 55 %. At 96/48 px on
  the dark card it is an edge instead of a sticker border; at 26 px it still
  parts the dark ink from the card (`variant-1-drawings-2x-dark`,
  `variant-1-desktop-1440-dark`).

Measured on the 64 grid (`measure-drawings.ts`, keyline off), round 1 → round 2:

| role | ink box x / y | centre of mass x | edge |
| --- | --- | --- | --- |
| orchestrator | 1.3–62.7 / 1–60 → 3.2–60.8 / 2.2–60 | 32.1 → 31.9 | clear |
| reviewer | 10–64 / 1–60 → 10–57.4 / 2.6–60 | 35.9 → 33.2 | clear |
| verifier | 10–64 / 2–60 → 10–59.5 / 2.2–60 | 33.0 → 32.5 | clear |
| builder | 5.3–59.5 / 2.3–60 → 5.2–58.8 / 2.2–60 | 32.1 → 32.0 | clear |
| architect | 10–64 / 0–60 → 10–59.5 / 2.7–60 | 32.1 → 33.4 | clear |
| cleaner | 6.2–64 / 3.8–64 → 3.7–60.9 / 3.7–60 | 35.1 → 31.0 | clear |
| prod auditor | 8.3–58 / 1–60 → 3.5–57.4 / 2.5–60 | 33.2 → 31.8 | clear |
| deployer | 6.2–58 / 1–64 → 9.6–54.4 / 2.7–60 | 32.9 → 32.0 | clear |
| merger | 10–59.5 / 2.1–60 → 10–54 / 2–60 | 32.4 → 32.0 | clear |
| maintainer | 10–59.5 / 0–60 → 10–54 / 2.1–60 | 32.3 → 32.0 | clear |
| issue reporter | 5.3–59.5 / 2.6–60 → 5.2–58.8 / 2.5–60 | 32.2 → 32.0 | clear |
| visual critic | 9–59.5 / 0–60 → 8.9–57.1 / 2.1–60 | 32.7 → 32.4 | clear |
| neutral | 10–58 / 1–60 (unchanged) | 33.2 | 0.2 short (kept) |

The reviewer's 33.2 is the mark's own: the swept hair puts the plain neutral
agent at 33.2 too, so the loupe now adds nothing to the lean (item 2 asked for
32 ± 1; the remaining 0.2 is the brand mark, not the costume). The architect's
33.4 is the pencil behind the right ear, which item 15 places there.

### What changed, per role

- **Orchestrator** (8, 9, 10): the hair is trimmed to the band, so no tip pokes
  past it; the band and cups are a lighter indigo (`#818CF8`) that holds on the
  dark accent card; the boom ends at the mouth corner in an indigo capsule with
  an ink edge, so no black dot sits on the cheek.
- **Reviewer** (11): loupe radius 13 → 10.5, centred on the right eye at
  (41, 30); the rim is a 3-unit sky-blue band with ink edges (5.6 overall
  instead of 7.4); the handle runs down-right and ends inside the head's width
  at (49, 52). The magnified eye stays; the glint is gone.
- **Verifier** (12): the side peak ends by x 60 and sits a unit higher, its
  ink 1.5 units above the right lens frame; the crown button (under 2 units) is gone; the
  white check stays.
- **Builder** (13): the grey fin is gone; proportions unchanged; the ridge is
  now drawn in the brim's darker yellow.
- **Architect** (14, 15): a 45° set square standing centred on the crown, its
  long edge on the hairline (x 15–49), apex at (32, 4), a pale cut-out and four
  2-unit ruler ticks. The pencil is behind the right ear, point down; at the
  lenses' height only its point remains, right of x 53.4, while the lens frame
  ends at 52.8, so nothing crosses the glasses.
- **Cleaner** (7, 16, 17): the bandana is pink (`#F472B6`) with five white dots,
  a hue no other role wears, so the three "green heads" are now green, teal and
  pink; the knot tails are larger. The broom is whole and leans at the left
  side, outside the glasses. Item 16 suggested holding it in front at the lower
  right; drawn there, its handle crossed the right lens at y 25–35 (first pass
  of this round), so it moved to the free left side, which also brings the
  centre from 35.1 to 31.0. Question 3 asks whether to keep it at all.
- **Prod auditor** (18, 19): a rose strap in place of the ink one, a lamp of
  radius 8 with a white-yellow face, and a yellow beam wedge that leaves the
  head past its top left; the halo is gone. At 16 px it now reads as a yellow
  wedge on the head, not the plain agent.
- **Deployer** (20, 21): an orange flight cap covers the hair (orange is no
  other role's hue), a brown strap across it, and two small dark-teal tinted
  goggles on the cap, with no pupils, so they no longer read as a second pair
  of eyes. The flame is gone; no badge replaces it.
- **Merger** (22, 23): the crown is 3 units shorter at the bottom and the peak
  is dark blue with an ink outline; it ends at y 21.5 (round 1: about 26),
  1.7 units above the glasses' frame; the crown
  flares toward the top; the badge is a gold disc of radius 4 with the
  two-into-one mark in ink.
- **Maintainer** (24): pompom radius 4.4 → 3.6, lowered, inside the canvas;
  the 1.4-unit rib lines became 2-unit filled ribs. Colours unchanged.
- **Issue reporter** (25, 26): an upright white card (10 × 11) at the front of
  the band with one red «!»; the thin crown pinch line is gone. Text: on cards
  that draw the costume the sender label is the role's name alone, and on the
  phone the card's clock drops its seconds, as the answer rows' clock already
  does (and as `FeedItem` already does for another phone clock,
  `isMobile ? mobileClock(…) : hhmm(…)`). Dropping «Агент · » alone was not
  enough: the label was still cut to «Автор звітів про помил…» at 390 px.
  Now the tightest card header has 23 px to spare at 390 px and no label is
  cut (`frames/geometry.json`, `truncatedLabels: []`, `labelSlack: 23.3`).
  Question 2 asks for the operator's word on this text change.
- **Visual critic** (27): the beret sits a unit lower and the stalk is shorter,
  both inside the canvas; the sheen is gone; shape and colour unchanged.
- **Neutral agent** (28): unchanged.

Geometry of the round-2 frames (`frames/geometry.json`): no frame scrolls
sideways at 1440, 1000 or 390; every answer avatar is 26×26 four pixels below
its header row top on the desktop and 20×20 inside the phone's header row
(overflow 0); every internal card header is 34 px high.

### Questions for the operator (round 2)

Published as a prototype review round on
2026-10-11: variant 1 as redrawn, with the round 1 / round 2 sheet carrying the
per-role list above.

1. The redrawn costumes: **accept round 2 as drawn (recommended)** · change
   specific roles (name them in the comment).
2. The internal card's sender label where the costume is drawn: **the role's
   name alone, and on the phone the card clock without seconds (recommended)** ·
   keep «Агент · <роль>» and shorten the Ukrainian name to «Автор звітів» ·
   keep it as it was and accept the cut label on the phone.
3. The cleaner's broom: **keep it, leaning at the left side (recommended)** ·
   drop it and let the pink bandana carry the role.

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

## 10. The build

The drawings are product code: `src/components/brand/roleCostumes.ts` holds the
shipped mark (body, belly, hair, glasses, keyline) and one costume per role over
it, and `RoleAvatar` (`src/components/brand/RoleAvatar.tsx`) draws a role as an
`<img>` on a data URI built once per role, so every copy keeps its clip-path and
filter ids to itself and one decoded picture serves every row of a role. No file
under `public/` is needed, and nothing can drift between a source and a copy.

### Operator decisions at build time (2026-10-11)

> «Аватарки супер... только... там, где у меня модельки идут. Сол, сол, астра,
> вот эти все. Клод — это мне нужно. Видеть... Как оно сейчас есть. Вот роль,
> где вот роли показать, как так, чтобы оно не перемешивалось... Но можешь
> полностью строить уже.»

This replaces question 2 of §6 («engine only in the window header»). Every place
that shows the engine or the model keeps showing it: the reader's engine and
model chips, the seat's incumbent row, the phone answer header's engine glyph
and name. The avatar adds the role beside them and never merges with them:

- **Desktop answer.** The 26 px costume takes the avatar column. The engine's
  circle had been the only engine sign on the row, so the engine moves beside
  the time in the form the phone header already uses: its 16 px glyph and its
  name, then «· time». The picture is the role, the text is the engine.
- **Phone answer.** The 20 px costume leads the 20 px header row; the engine
  glyph, its name and the time follow, exactly as before.
- **Conversation header.** The reader's head draws the costume at 26 px after
  the frame mark (20 px in a Stages pane's identity row), beside the engine and
  model chips it already had. The seat's head and the dock draw the
  orchestrator's costume where the engine-tinted robot tile was; the engine and
  model keep their chips in the incumbent row. On the phone the bar's role mark
  becomes the 26 px costume, where the frame's emblem ribbon (32 px under the
  default `ribbon`) stood. Drawn beside the ribbon it cost the title cell 32 px
  more, and the state line that carries the model («Готово · 70 хв тому ·
  Opus 5.5») was cut by 43 px at 390 px where today's bar cuts it by 13 px. In
  the ribbon's place the line is cut by 7 px, the seat's by 19 px (today 25),
  so the model shows at least as much of itself as before. Elsewhere the frame
  mark keeps its glyph, as §5 decided.
- **Internal card.** The sender's costume at 26 px in place of the Delegatus
  tile; the label is the role's name alone, cut on one line; the phone's clock
  drops its seconds (§9, question 2). A relay by Delegatus itself (controller,
  pipeline, gateway) keeps the product's mark and «Agent · Delegatus».

> «агента треба у чорних окулярах і у смокінгу»

The agent with no role (the `neutral` frame role: a conversation started by
hand, a card from an agent that names none) is no longer the engine circle or
the plain mark: Delegatus in black sunglasses and a tuxedo. The lenses are
filled dark (`#262B35`) inside the same 3.6 ink frames, without pupils; the
cream belly gives way to a charcoal jacket (`#5A6479`, about 2.9:1 against the
dark page) outlined in ink along its shoulders and lapels, which open into a
white shirt front with a black bow tie at its top. The first build used a
jacket of the ink colour itself and its body vanished on the dark theme; the
lighter charcoal keeps a whole silhouette on both. The hair is the trimmed hair the other
full-hair costumes use, so the drawing stays inside x 3–61, y 2–62 like every
costume (`roleCostumes.test.ts` measures each drawing's ink box with `sharp`).

A feed draws costumes on its answers only where the surface resolved the
conversation's role (`ConversationRoleScope`: the reader, the seat and dock,
the phone's conversation screen). Elsewhere (a relay chat, a preview sheet) the
answers keep today's engine circle. The open-agents rail, the needs-you rows and
the stage graph keep their glyphs; no further surface draws a costume.

Rendered evidence: the kanban driver's «role avatars» block
(`src/components/kanban/kanbanBoard.browser.test.tsx`) over
`issue1695Evidence.fixture.tsx?scenario=role-avatars`, readings in
`evidence/role-avatars/rendered.json`.

## 11. Dark theme: no keyline

> «На тёмной теме подсветка делегатусов какая-то вокруг иконок, лишняя, мне кажется.»
> (operator, 2026-10-16)

The keyline of §9 (dilate the drawing's alpha by 1.2, flood `#FFF6EE` at 0.55)
read on the dark card as a pale halo round every figure, in the conversation
header, on feed answers, internal cards, kanban readers and the phone. The dark
theme now draws each costume without it; the light theme keeps the drawing as it
was, keyline included (on a light card the ring is the card's own colour).

- `costumeSvg(role, "dark")` (`src/components/brand/roleCostumes.ts`) is the
  light drawing minus the filter and the `filter` attribute; nothing else
  differs, so the drawing keeps its ink box.
- A `RoleAvatar` is still one `<img>` on the light data URI built once per role;
  theme CSS cannot reach inside it. `src/components/brand/roleAvatarDarkCss.ts`
  builds one stylesheet, emitted once by the root layout: the 13 dark pictures as
  custom properties `--ra-<role>` on `:root`, and one `content: var(--ra-<role>)`
  rule per role on `img[data-role-avatar]` in the two dark scopes of
  `tokens.css` (the OS asks for dark and the app is not pinned light, or
  `data-theme="dark"`). The light theme matches no rule. A row builds no SVG.
- The dark ink outlines (hat brims, glasses frames, bow tie) now sit straight on
  the dark card. The costumes already keep mid-to-light hats and the tuxedo's
  lifted charcoal (§9), and the glasses frames and the body's red edge are the
  figure's own shape.
