# Role avatars in conversations

Status: research and prototypes, no product code. Variants are numbered for the
operator's choice; the frames live in `docs/design/role-avatars/frames/`.

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
| what | the shipped mark plus one accessory layer per role (hat, loupe, clipboard…) | an image model draws the character in twelve costumes; PNG/WebP files | the `EMBLEM` glyphs already shipped, on a role-coloured tile, or as a corner disc on the mark |
| cost | the twelve drawings exist as this prototype (`role-avatars/roleAvatarCostumes.ts`). Production is one SVG per role under `public/brand/roles/`, a ~40-line `RoleAvatar` component, and two slot changes in `FeedItem`. A new role costs one accessory layer | paid generation with the operator's confirmation for every round. Twelve consistent poses is the hard part: identity drift across prompts means several rounds and hand retouching | near zero: the art ships already |
| 16–32 px | 32 and 26 px read well. At 20 px the headgear reads mainly by colour and silhouette. At 16 px only colour is left, and the clipboard, set square and broom shrink to specks (frames `variant-1-sheet-2x-*`) | an illustrated raster blurs at 16–26 px, and the browser's downscale differs per DPR | crisp at every size: a 24-unit stroke icon is designed for 16 px |
| dark/light | one file serves both. Accessories in dark ink lose their outline on the dark surface, and two low-value tones (the grey fedora, the slate beanie) fade there (frames `variant-1-*-dark-*`). Fix: lighter accessory tones or a pale keyline | a raster has a baked background or halo, and one of the two schemes pays for it | follows the palette tokens; already contrast-checked |
| repository | text SVG, passes the publication gate like `public/brand/` | a committed PNG fails the privacy gate without a generator manifest (`delegatus-brand.md` §4); rasters cannot be rebuilt from source | no new files |
| maintenance | an accessory per new role; the mark changes in one place | regenerate the whole set to keep style when one role is added | add one lucide name to `EMBLEM` |

B is the most expensive option and the worst at the sizes the feed uses, so it
is not recommended and was not drawn: drawing it would itself be a paid
generation run.

## 4. The variants (numbered, rendered)

Each variant was rendered through the **production `FeedItem`**: a `git archive`
export of `87476d972` was patched (`role-avatars/render-frames.ts`) and drawn by
the existing conversation fixture
(`src/components/conversation/conversationWindowEvidence.fixture.tsx`, new
`role-avatars` case) through the existing evidence harness
(`serveEvidenceFixture`/`openFixture` in
`src/components/kanban/issue1695BrowserHarness.ts`). Every frame holds:

- a size sheet: all twelve registry roles and the neutral agent at 32/26/20/16 px
  (phone: 26/20/16);
- the orchestrator seat's feed: the operator's question, the orchestrator's
  answers, and one internal message from **each of the other eleven roles**, so
  all twelve appear in one message list;
- a builder's own conversation: the orchestrator's brief, then the builder's
  answers.

In all three variants the engine moves out of the avatar into the header
text («Білдер · Claude · 14:12»), so the comparison isolates the avatar.

**1 — Delegatus in the role's costume** (the operator's idea). Orchestrator:
headset. Reviewer: loupe over one eye. Verifier: green clipboard with a check.
Builder: yellow hard hat. Architect: blue set square and a pencil behind the ear.
Cleaner: green bandana and a broom. Prod auditor: headlamp. Deployer: flight
goggles and a launch flame. Merger: railway conductor's cap with a merge badge.
Maintainer: knit beanie. Issue reporter: fedora with a PRESS card. Visual
critic: violet beret. Neutral agent: the plain mark.

**2 — Delegatus with a role badge.** The plain mark and a disc in the role's
palette colour carrying the role's lucide emblem in the corner. Under 20 px the
disc carries the colour alone.

**3 — Role glyph tile.** The role's emblem tile the open-agents rail already
draws, used as the avatar. The character appears only in Delegatus's own relays.

Measured (`frames/geometry.json`): no frame scrolls sideways (0 px at 1280 and
390, both schemes, all variants). On the phone the 20 px avatar sits inside the
20 px header row (overflow 0). Every feed row in both panes carries its role's
avatar at 26 px (desktop and the phone's internal cards) or 20 px (phone answer
headers).

Frames (Ukrainian, light and dark):

- `docs/design/role-avatars/frames/variant-{1,2,3}-desktop-1280-{light,dark}-uk.png`
- `docs/design/role-avatars/frames/variant-{1,2,3}-phone-390-{light,dark}-uk.png` (2×)
- `docs/design/role-avatars/frames/variant-{1,2,3}-sheet-2x-{light,dark}-uk.png`

The frames are ignored by git (`role-avatars/.gitignore`): a browser render has
no generator provenance and the publication gate refuses committed rasters. The
costume SVGs (`role-avatars/svg/1-costume/*.svg`) are text and can be committed.

## 5. Recommendation

**Variant 1, limited to the places where the avatar is at least 20 px:** the
agent's answers in the feed (26 px desktop, 20 px phone header), the internal
card of a message another agent sent (26 px), and the conversation header.
Everything at 16–18 px keeps the lucide emblem it has today: the open-agents
rail, the needs-you rows, the frame mark and the stage graph. At those sizes a
costume is a red dot with a coloured cap, and the glyph is the clearer mark.

Why 1 over 2 and 3: the requirement asks for the character in role costume,
and only variant 1 delivers it. At 26 px the hard hat, headset and beret read at
a glance, and a seat feed of eleven reports becomes scannable by picture. Variant
3 is the cheapest and crispest, but it is the existing emblem moved into one more
place, which is not what was asked for. Variant 2 puts two identities in a 26 px
square, and its 14 px disc is too small for the glyph.

Implementation, if chosen:

1. `public/brand/roles/<role>.svg`, one per registry role, from
   `role-avatars/roleAvatarCostumes.ts`. Raise the two low-contrast tones (fedora,
   beanie) and add a pale keyline to dark-ink accessories so they hold on the
   dark surface. Re-check both schemes in the frames.
2. `RoleAvatar` beside `DelegatusMark` in `src/components/brand/BrandMark.tsx`:
   an `<img>` with an empty `alt`, as the mark is today. The role's name is
   always in the text beside it.
3. `FeedItem`: the answer avatar takes the conversation's frame role (already
   resolved for the frame) in place of the engine circle, and the engine's name
   joins the time in the header row. The internal card draws the sender's role
   avatar in place of the Delegatus tile. A `neutral` conversation keeps
   today's engine circle.
4. Tests: a DOM test that every `ROLE_IDS` entry resolves to a file, and a case
   in the existing kanban/phone browser drivers for one answer and one internal
   card per scheme.

## 6. Questions for the operator

1. Which direction? **1 — costume (recommended)** · 2 — badge · 3 — glyph tile ·
   1 at 20 px and up, 3 below.
2. Where does the engine (Claude/Codex) go once the avatar shows the role?
   **In the header text beside the role and time (recommended)** · a small engine
   mark in the avatar's corner · keep the engine circle and name the role in text
   only.
3. Which surfaces get the costume? **Feed answers, internal cards and the
   conversation header (recommended)** · also the rail, needs-you rows and the
   stage graph · feed answers only.
4. A conversation with no role (started by hand): **today's engine circle
   (recommended)** · the plain Delegatus mark.
5. The costumes as drawn: **accept, fix the two dark-theme tones (recommended)** ·
   change specific roles (name them in the comment).

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
  inherit those collisions; variant 1 tells them apart by costume.

## 8. Prototype sources

`docs/design/role-avatars/`: `roleAvatarCostumes.ts` (the drawings), `roleAvatarProto.tsx`
(the three variants), `roleAvatarsEvidence.tsx` (the fixture case),
`render-frames.ts` (the patch and the render loop over the existing harness).
These files exist only to render the frames. Delete them once the operator has
decided, keeping only the chosen SVGs.

## Deferred — not currently justified

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
- **Distinct colours for the four shared palette pairs.** Worth doing only if
  variant 2 or 3 is chosen.
