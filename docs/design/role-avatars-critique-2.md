# Role avatars, critique 2: the variant-1 drawings

Input for the redraw of `role-avatars/roleAvatarCostumes.ts` (design note:
`role-avatars.md`, operator decision in §6). The layout questions are decided
and stay closed; this list is about the drawings: where each costume element
sits, its proportion, line weight, keyline, legibility at 26/20/16 px, how the
roles differ from each other, contrast in both schemes, and centring.

## How the frames were made

The prototype's own render loop (`role-avatars/render-frames.ts`) over the
existing conversation fixture and evidence harness, run from a `git archive`
export of `4d70d3598` in a private HOME, TMPDIR and state directory with the
Viewer control URL on a closed port. Frames: desktop 1440×900 and 1000×700,
phone 390 (2×), light and dark, `uk` and `en`; the `sheet-2x` (32/26/20/16 px)
and `drawings-2x` (96/48 px) sheets in both schemes. Each SVG was also
rasterised at 96/26/20/16 px on the light card (`#fffdfa`) and the dark card
(`#191b23`), enlarged 3× without smoothing, and measured for its ink bounding
box and centre of mass on the 64-unit grid (keyline excluded).

Frame names below are the renderer's: `drawings` = `variant-1-drawings-2x-*`,
`sheet` = `variant-1-sheet-2x-*`, `feed 1440/1000` = `variant-1-desktop-*`,
`phone` = `variant-1-phone-390-*`. The drawings do not change with the
language, so each item holds for `uk` and `en`.

Measured on the 64 grid (ink, no keyline):

| role | ink box x / y | centre of mass x | touches the canvas edge |
| --- | --- | --- | --- |
| orchestrator | 1.3–62.8 / 1.0–60 | 32.0 | – |
| reviewer | 10–64 / 1–60 | **35.8** | right (handle cut) |
| verifier | 10–64 / 2–60 | 32.9 | right (peak cut) |
| builder | 5.3–59.5 / 2.3–60 | 31.9 | – |
| architect | 10–64 / 0–60 | 32.0 | top, right (square and pencil cut) |
| cleaner | 6–64 / 3.8–64 | **35.0** | right, bottom (broom head cut) |
| prod auditor | 8.3–58 / 1–60 | 33.0 | – |
| deployer | 6.3–58 / 1–64 | 32.8 | bottom (flame cut) |
| merger | 10–59.5 / 2–60 | 32.3 | – |
| maintainer | 10–59.5 / 0–60 | 32.2 | top (pompom) |
| issue reporter | 5.3–59.5 / 2.5–60 | 32.1 | – |
| visual critic | 9–59.5 / 0–60 | 32.6 | top (stalk) |
| neutral | 10–58 / 1–60 | 33.1 | – |

## The previous critic's open notes, checked again

- **Dark tones of the maintainer's and issue reporter's hats**: closed. The teal
  beanie and the tan fedora read as two different hats on the dark card at
  26 px (feed 1440/1000 dark, phone dark), and neither looks like the merger's
  blue cap.
- **Roles whose attribute sat in a corner (architect, verifier, reviewer)**:
  partly closed. All three now change the head. The architect's square still
  leans into the top-left corner and its pencil crosses the right lens, and
  the reviewer's loupe is cut by the right edge (items 1, 2, 11, 14, 15 below).
- **The desktop answer row repeated role and engine**: closed. Every answer
  row at 1440 and 1000, light and dark, shows the avatar and the time only;
  the role and the engine are in the window header alone.
- **Uneven gaps around «·» on the phone**: closed. The phone answer row has
  the avatar and the time and no separator; «Агент · <роль>» on an internal
  card is one string with even gaps.
- **Two-line issue-reporter card header at 390 px**: the header is one line
  now (every internal card header measures 34 px), but the label is cut to
  «Агент · Автор звітів пр…», so the role's name is lost in `uk`. Item 26.

## Numbered improvements

### Every role

1. **All roles, every size, both themes — edges of the canvas.** Seven
   drawings run into the 64-unit canvas edge (table above), so the keyline,
   and in four of them the ink itself, is cut flat: the reviewer's handle, the
   verifier's peak and the cleaner's broom head on the right, the deployer's
   flame at the bottom, the architect's square, the maintainer's pompom and the
   critic's stalk at the top. On the dark card the cut keyline shows as a
   straight grey edge (drawings dark, sheet dark). Change: keep all ink inside
   x 3–61, y 2–62, so the keyline (1.7 units) never touches the edge.
2. **Reviewer and cleaner, 26 and 20 px — centring.** Their centre of mass sits
   3–4 units right of the head's axis (35.8 and 35.0 against 32), about 1.5 px
   at 26 px. Next to the other cards' avatars in the orchestrator feed
   (feed 1440/1000, phone) they look shifted toward the label. Change: balance
   them as items 11 and 16 describe so the centre of mass lands within 1 unit
   of x = 32.
3. **Every hat role, 26 and 20 px — the grey "tuft".** The swept back of the
   hair shows as a grey fin sticking up-right behind the builder's brim, the
   merger's cap, the maintainer's beanie, the fedora and the beret (drawings,
   sheet, both themes). At 26 px it reads as a stray grey shard beside the hat,
   and it differs from hat to hat. Change: drop the fin; if hair should show
   under a hat, draw one short sideburn below the hat line at each temple,
   the same shape for every hat.
4. **All accessories — line weight.** The outlines run from 1.3 to 7.4 units:
   the glasses 3.6, hat outlines 2.4, the headset band 5, the loupe rim 7.4,
   the press card 1.4, the broom bristles 1.5, the beanie ribs 1.4, the ruler
   ticks 1.3. At 26 px one unit is 0.4 px, so anything under 2 units turns into
   a faint smear and the loupe's 3 px rim is the heaviest line on the screen
   (sheet, feed 1440 light). Change: two weights only, an outer outline of
   2.6–2.8 units on every accessory and the glasses' 3.6 for the face; drop
   interior details thinner than 2 units, or draw them as filled shapes of at
   least 2 units.
5. **All accessories — highlights.** The builder's hat has a ridge highlight,
   the beret a sheen stroke, the loupe and the goggles a glint, the other
   hats none (drawings, both themes). Change: one rule for every hat, either a
   single highlight in the same place (upper left of the crown) or none.
6. **All roles, dark theme — keyline.** The pale keyline is a 1.7-unit cream
   ring at 70 % opacity. On the dark card at 96 and 48 px it is a thick grey
   sticker border around every drawing, heavier than the glasses' line
   (drawings dark); at 26 px it is a 1 px grey rim, which is about right
   (feed 1440 dark). Change: radius about 1.2 units and opacity about 55 %, so
   it still separates dark ink from the dark card at 26 px without a visible
   border at the larger sizes.
7. **Cleaner, verifier, maintainer, 20 and 16 px — three green heads.** Olive
   bandana, green cap and teal beanie collapse into "green on top" at 16 px
   and are only told apart by small details at 20 px (sheet, both themes;
   phone sheet). Change: move the cleaner off green (item 17), which leaves
   green to the verifier and teal to the maintainer.

### Orchestrator

8. **26 and 20 px, both themes — hair through the headset.** The tip of the
   swept hair pokes out above and right of the band as a grey spike (drawings,
   sheet, phone header 26 px). Change: keep the hair inside the band (trim the
   tip or widen the band arc by a unit or two).
9. **20 and 26 px — the microphone.** The boom ends in a black ball at the lower
   left of the face, on the edge of the cream belly; at 20 px (phone answer
   row) it reads as a dark hole in the cheek. Change: end the boom at the
   mouth corner, around (24, 45), with a small capsule in the cup's indigo and
   an ink outline, so it reads as a microphone and no dark dot sits on the
   belly.
10. **Dark theme, internal card in the builder's feed (feed 1440/1000 dark,
    phone dark) — cups on indigo.** The cups (`#4F46E5`) sit on the dark
    internal card (`#262347`, also indigo) and are held only by the keyline.
    Change: lighten the cups a step (toward `#6366F1`/`#818CF8`) so they hold
    on the dark accent card.

### Reviewer

11. **All sizes — the loupe's size and placement.** The loupe (rim radius 13,
    ink 7.4) covers the right half of the face, its handle runs out of the
    canvas at the bottom right, and the drawing leans right (items 1, 2).
    Change: rim radius about 11 centred near (43, 30), the handle down-right
    ending inside x 61, y 58; rim drawn as a 2.6 ink outline around a coloured
    band of about 3 units. The magnified eye stays; keep the left lens of the
    glasses visible as now.

### Verifier

12. **All sizes — the side peak.** The peak runs to x 63.5 and is cut on the
    right (drawings, both themes). Change: shorten it to end by x 60 and lift
    it a unit so it stays clear of the right lens frame. The white check on the
    crown reads well at 26 and 20 px; keep it.

### Builder

13. **26 and 20 px — tuft above the brim.** The grey fin shows above the right
    end of the brim (item 3). Otherwise the hard hat is the strongest drawing
    of the set at every size; keep its proportions.

### Architect

14. **All sizes — the set square leans into the corner.** The square is a
    right triangle with its upright leg at the left edge and its point at the
    top-left canvas corner; it reads as a blue sail stuck on the left of the
    head, and at 16 px as a blue scratch (sheet, both themes). Change: a 45°
    set square standing centred on the crown, its long edge along the hairline
    (about x 12–52 at y 21) and its right angle up near (32, 3), with the
    cut-out and two or three ruler ticks (filled, item 4). That gives a
    triangle silhouette no other role has.
15. **All sizes — the pencil crosses the right lens.** The pencil's point runs
    into the right lens and touches the pupil, which reads as a pencil in the
    eye (drawings 96/48 px, feed 1440 26 px). Change: put the pencil behind the
    right ear, outside the glasses: roughly from (53, 12) to (61, 25), point
    down, with nothing crossing x < 54 at the height of the lenses.

### Cleaner

16. **All sizes — the broom in two pieces.** The broom is drawn behind the
    head, so only a brown stub at the top left and a bristle block at the
    bottom right show; the block, cut by the canvas edge, reads as a yellow
    comb or the letter E (drawings, sheet, feed 26 px). Change: draw the broom
    in front, held diagonally at the lower right (handle from about (40, 40)
    to (58, 16), bristles at the lower end inside the canvas), or drop it and
    let the bandana carry the role.
17. **20 and 16 px — colour.** See item 7. Change: a bandana in a hue no other
    role uses and that separates from the red head by lightness, for example
    a light pink (`#F472B6`) with white dots; keep the knot tails at the right
    and make them big enough to show at 26 px.

### Prod auditor

18. **20 and 16 px — reads as the plain agent.** The full grey hair stays, the
    strap is the glasses' ink, and the lamp is a small red-and-yellow target;
    at 16 px it is the neutral agent with an orange dot, and at 20 px close to
    the deployer (sheet, both themes). Change: give the light a shape that
    leaves the silhouette: a pale-yellow beam wedge from the lamp out past the
    top left of the head, a larger lamp (radius about 8) with a white-yellow
    face, and a coloured strap instead of an ink one.
19. **All sizes — the glow halo.** The glow is a 75 %-opacity pale disc that
    overlaps the hair and the top of the glasses frame; on the light card it is
    a muddy beige ring, on the dark card a dull tan one (drawings, feed 26 px).
    Change: remove the halo; the beam in item 18 carries the light.

### Deployer

20. **26, 20 and 16 px — four eyes.** The goggles pushed up on the hair are two
    round pale-blue lenses directly above the glasses; at 26 px and below they
    read as a second pair of glasses (feed 1440/1000, phone, sheet), and the
    full grey hair keeps the head close to the plain agent. Change: put the
    goggles on an orange flight cap that covers the hair (orange is no other
    role's hue), with the strap across the cap and the lenses smaller and
    tinted, so the silhouette and the colour change and the goggles read as
    gear.
21. **All sizes — the flame under the chin.** The flame sits below the body,
    is cut by the canvas bottom, and at 26 px is an orange smear that reads as
    feet or a beard (feed 1440 26 px, phone 26 px). Change: drop it; if the
    launch should stay, a small flame badge on the cap's front.

### Merger

22. **26 and 20 px — the peak on the glasses.** The cap's black peak spans y
    19–27 and lies on the glasses' top frame, so cap and glasses merge into one
    heavy black band across the face (feed 1440/1000 both themes, phone).
    Change: raise the cap about 3 units so the peak ends above y 23, and draw
    the peak in a dark blue with the ink outline in place of solid ink.
23. **All sizes — the cap's shape and badge.** The crown is straight-sided and
    reads as a box; the badge is a pale-yellow «Y» about 2 px wide at 26 px.
    Change: let the crown flare slightly toward the top, as a conductor's cap
    does, and draw the merge badge as a filled gold disc with the two-into-one
    mark in ink, large enough to show as a gold dot at 20 px.

### Maintainer

24. **All sizes — the pompom.** The pompom touches the canvas top (y 0.2) and
    its keyline is cut (drawings, sheet). Change: lower the beanie a unit or
    shrink the pompom to radius about 3.6. The teal beanie now holds on the
    dark card; keep the colours. The rib lines (1.4) vanish at 26 px: make them
    a filled ribbed band or drop them (item 4).

### Issue reporter

25. **26 and 20 px — the press card.** The card is a white rectangle with two
    thin red lines, tilted on the crown; at 26 px it is a pink-white speck that
    reads as a stain on the hat (feed 1440/1000, phone, both themes). Change: a
    larger upright white card tucked in the band at the front, carrying one
    bold red mark that survives 26 px (a red «!» or a single thick bar), so
    the card reads as "report".
26. **Phone 390, `uk`, light and dark — the cut label.** The internal card's
    label is cut to «Агент · Автор звітів пр…», so the role's name is gone in
    text; `en` («Agent · Issue reporter») fits. Change (text, not the
    drawing): give the role a shorter `uk` label on this card, or drop the
    «Агент · » prefix on internal cards where the avatar is drawn, so
    «Автор звітів про помилки» fits on one line at 390 px.

### Visual critic

27. **All sizes — the stalk.** The beret's stalk touches the canvas top and its
    keyline is cut (drawings, sheet). Change: lower the beret a unit or shorten
    the stalk. The beret is otherwise one of the clearest silhouettes at 16 px;
    keep its shape and colour, and keep its sheen consistent with item 5.

### Neutral agent

28. No change to the drawing. It is the plain mark the costumes are measured
    against; after items 18 and 20 the prod auditor and the deployer no longer
    resemble it at 16 px.

## Not part of the redraw

- The internal cards show the time with seconds («14:10:00») while the phone's
  answer rows show «14:09» (phone, both themes). That is today's `FeedItem`
  format, outside this prototype's scope; noted only.
