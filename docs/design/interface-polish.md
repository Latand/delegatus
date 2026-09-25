# Interface polish: the jakubkrehel skills applied to Delegatus

Issue #2148. Research only: nothing here changes product code. Each change
below is a patch under `docs/design/interface-polish/`; the operator picks
which ones get built.

## Originating requirement

> Operator request: research how Delegatus's interface would improve under the
> approaches in https://github.com/jakubkrehel/make-interfaces-feel-better and
> https://github.com/jakubkrehel/skills (better-interface, better-layout,
> better-typography, better-colors, better-ui, better-writing,
> interface-review, variant, ...), and show the difference.
>
> Deliverable: an audit of the main screens (board, task card, conversation,
> pipeline, orchestrator panel; desktop and phone) against those skills, a
> prioritized list of changes, and before/after renders for the most valuable
> ones from a seeded demo home. Research only: no product change until the
> operator picks.
> Scope: interaction and visible controls; screen-reader accessibility is out
> of scope.

Source: issue #2148, filed 2026-09-24 (the operator's request, recorded in
English on the issue). The lane's spec adds the method: read every skill,
capture the five screens at 1440×900 and 390×844 from a seeded demo home on a
production build, audit with file:line, then prototype the 6–10 changes with
the biggest visible gain for the least code.

Prior work: `search_transcripts` found no earlier session on these skills,
`text-wrap`, or an interface-polish pass; the nearest hits were the README
screenshot lanes, whose seeded home (`scripts/readme-demo-state.ts`) this
research reuses.

## How the renders were made

- The lane HEAD was exported with `git archive` into a scratch directory under
  `/var/tmp`, installed, and built with `next build` against a throw-away
  config root (`XDG_CONFIG_HOME`, `LLV_STATE_DIR` under `/var/tmp`). The
  operator's state and port 8898 were never touched.
- A scratch driver (not committed) seeds the README demo home through
  `seedDemoHome` / `seedDemoAccounts` (`scripts/readme-demo-state.ts`) in the
  environment `buildCaptureEnvironment` (`scripts/capture-readme-media.ts`)
  builds, adds an orchestrator seat for the
  invented `harbor-api` project, serves the build on a port the OS assigns,
  and captures with Chrome through playwright-core at device scale 2, dark
  scheme. Everything on screen is invented.
- Each patch was built in a second scratch checkout. Its before and after
  frames were captured back to back from two servers, each seeded fresh, so
  relative times ("31m ago") match. Live timers can differ by a few seconds
  between the two frames; that is not the patch.
- `scripts/capture-readme-media.ts` itself could not be used unchanged: its
  capture directory refuses a repository that lives under `/var/tmp`, which
  is where the disk-backed scratch export lived.

## Step one: what each skill asks for

**make-interfaces-feel-better** (the older single skill; `better-ui` and
`better-typography` now carry its rules). Concentric radii (outer = inner +
padding); optical over geometric alignment; shadows for elevation, borders
only for structure; interruptible CSS transitions for state, keyframes only
for one-off sequences; subtle exits; icon swaps by opacity/scale/blur;
`antialiased` on the root; `tabular-nums` on changing numbers; `balance` on
headings and `pretty` on short prose; 1px neutral outlines on images;
`scale(0.96)` on press; no `transition: all`; `will-change` only on
compositable properties; 40–44px hit areas; icon stroke matched to text
weight; motion restraint on high-frequency interactions.

**better-interface.** An orchestrator: resolve the scope, run the six domain
skills in a fixed order (accessibility, layout, writing, typography, colors,
ui), rank by user impact with a fixed list of escalation triggers, prefer the
cheapest fix (delete, then use the platform, then reuse a project token, then
correct a value, and only then add), and consolidate one root cause into one
finding. Evidence over taste: a deliberate project choice stays out of the report.

**better-layout.** Group with space before lines; gaps between groups at
least twice the gap within one; controls visibly distinct from content;
shared alignment edges; importance top and leading; visible cues for hidden
content (a 16–32px peek or a disclosure); 12px between filled controls and
24px around borderless ones as a start; content bleeds, controls stay inside
margins; collapse late; no fixed widths on text.

**better-typography.** Few fonts, sizes and weights; a named type scale;
line-height by role (about 1.1 headings, 1.5 body, 1.4+ for anything wrapping
to three lines), unitless; `balance` for headings, `pretty` for descriptions,
`overflow-wrap` for long tokens, `nowrap` for labels; `tabular-nums` on
changing values; truncation keeps the full value reachable; real ellipsis and
dash characters; 16px inputs on mobile; `antialiased` once on the root.

**better-colors.** A small system of ramps named by role; components use
semantic tokens only; a token only in its role; one hue, one meaning across
the interface (the accent means interactive); one filled primary action per
view, while fills that encode distinct states are allowed; measure contrast
on the rendered pair and report a failing pair while leaving the colors alone.

**better-ui.** The polish reference with exact values: concentric radius,
optical alignment, shadow-as-border recipes (dark mode: one 1px white ring at
8%), stagger at about 100ms for rare entrances only, exits softer than
enters, icon cross-fades with `cubic-bezier(0.2, 0, 0, 1)`, `scale(0.96)` on
press, suppress transitions during a theme switch, no `transition: all`,
outline icons by default and fill for the active state, one icon library per
surface, motion never the only cue.

**better-writing.** One voice, tone by stakes; address the reader as "you";
plain words, delete words that do no work; verb-first buttons; one flow
vocabulary; links name their destination; one capitalization policy per
element type (sentence case the safe default); toggles named for the ON
state; errors say how to fix; empty states point forward; placeholders are
examples and never the only label.

**better-accessibility** (visible interaction only; the screen-reader half is
out of scope here). Native elements first; a visible `:focus-visible` ring;
every pointer path has a keyboard path; 24px floor and 40–44px targets,
extended by pseudo-elements that never overlap; hover styling gated to
`(hover: hover)`; color never the only carrier of state; honor
`prefers-reduced-motion`; survive 200% zoom and a 320px width.

**interface-review.** Scopes a change (a diff) where better-interface scopes a screen: resolve the diff
against the merge base, expand one hop to consumers, read the removed lines
for lost focus, motion or text signals, and label each finding Introduced,
Regression or Pre-existing. It hands severity and the verdict to
better-interface. It becomes useful once one of the patches below is built;
this audit is a screen review.

**variant.** Builds three versions of one piece that differ along one axis
(structure, density, emphasis, type or voice), hosts them in the real page
behind a `?variant=` picker, clears the same accessibility floor in each, and
leaves the choice to the user without marking a favourite.

**break.** Renders one real component on a throw-away page under every
scenario its props can reach (content length and shape, quantity, container
width, state, environment), looks once, and reports only what visibly broke,
naming the skill that owns each fix.

**explain-interface.** Explains how an existing site or effect was built:
the layer stack in paint order, each claim tagged measured, derived or
inferred, and a closing recipe in words instead of a copied snippet.

Only better-interface and its six domain skills drive this audit. variant,
break and explain-interface serve other jobs, and they come back in the
deferred list where one of them fits a follow-up.

## Step two: the audit

Scope: the five screens the issue names, each at 1440×900 and 390×844, dark
scheme, on a production build. Stack: Next.js with React, Tailwind 4 utilities
plus component CSS files (`kanbanBoard.css`, `pipelineBlock.css`), and design
tokens in `src/styles/tokens.css`. That file documents its own rules, which
this audit reads as project conventions: a 10/11/12/13/15px type scale, two
radii (8px controls, 12px surfaces), and role-named color tokens with a
contrast test. Line numbers refer to the lane HEAD (`77a97449e`).

Already met, so these are not findings: `antialiased` on the root
(`src/app/layout.tsx:29`); `tabular-nums` on every timer, count and duration
in the feed and the stage rows (`ToolCard.tsx:104,306,395`,
`McpCallCard.tsx:193`, `pipelineBlock.css:80`); real `…` and `—` characters in
the English catalog (`en.ts:517`, `en.ts:3592`); `:focus-visible` rings on
board controls (`kanbanBoard.css:33`, `pipelineBlock.css:96`); 44px touch
targets under `(pointer: coarse)` (`CopyButton.tsx:74`,
`pipelineBlock.css:151`); semantic color tokens throughout, with the raw-hex
sweep the tokens file describes.

Severity follows better-interface: HIGH blocks, misleads, or hides; MEDIUM
harms comprehension or consistency; LOW is isolated polish. Rows marked with
a patch number are prototyped in step three.

### Board (desktop `board-desktop`, phone `board-phone`)

| Sev | Domain | Location | Observed | Rule | Patch |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | colors | `kanbanBoard.css:285-294` | Every card carries a filled status pill that repeats its column's name ("Assigned" inside Assigned). Assigned is tinted with `--color-accent`, the same violet as the send button, the Graph button and "+ Agent". Four fills per screen compete with the one real action. | One color, one meaning; fill one action per view | 01 |
| MEDIUM | layout | `KanbanBoard.tsx:2365`, `kanbanBoard.css:200` | The jump tabs "Inbox 1 · Assigned 3 · Blocked 1 · Done 1" sit directly above column heads that say the same thing with the same counts. | Delete before adding; don't overload the entry point | deferred |
| LOW | ui | `kanbanBoard.css:142`, `:212` | Columns and the cards inside them share the 12px surface radius with about 10px between them, so the corners are not concentric (concentric would be about 22px). | Concentric radius | deferred |
| LOW | typography | `kanbanBoard.css:233` | Card titles set `line-height: 18px`, a fixed value where the skill asks for a unitless one. `text-wrap: balance` was tried on these titles and changed 0.03% of the board's pixels (timer digits), so it was dropped from patch 03: the seeded titles already break evenly. | Unitless line-height | rejected |
| LOW | layout | `KanbanCard.tsx:466` onward | A card with a pipeline stacks two chevrons and two "⋯" menus at the same trailing edge (the card's and the pipeline's), with nothing but position telling them apart. | Controls distinct from content; one entry point | deferred |

### Task card with a pipeline (desktop `card-desktop`, phone `card-phone`)

| Sev | Domain | Location | Observed | Rule | Patch |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | layout | `pipelineBlock.css:55`, `:255-258` | On the phone task screen the pipeline's head button and the empty `.pb-grow` spacer share the row, so the head's chevron floats in the middle of the card ("5m ago … › … ⋯") instead of ending the row like the Description and agent rows below it. | Align to shared edges | 05 |
| LOW | writing | `PipelineSection.tsx:621-625` | "Past attempts · 1 — last: Build · attempt 1 · passed · pass · 5m ago": the state and the verdict say the same word twice. | Delete every word that does no work | 06 |
| LOW | colors | `kanbanBoard.css:293` | The status pill on this card is accent-violet (same root cause as patch 01). | One color, one meaning | 01 |

### Conversation with tool calls (desktop `conversation-desktop`, phone `conversation-phone`)

| Sev | Domain | Location | Observed | Rule | Patch |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | ui | `CopyButton.tsx:74` | The component calls itself a "ghost icon button" but draws a bordered, filled, shadowed box. On a phone that box is 44×44, so every message and every tool output carries a heavy square, while the read-aloud button next to it is borderless. Two such boxes stack beside one Bash call. | Borders only for structure; one treatment per control | 02 |
| LOW | layout | `ToolCard.tsx:129` | On a phone, a Bash call's command row reserves `min-h-[50px]` for its copy button, which leaves a blank band between `$ bun test src/refunds` and the output below it (visible in pair 02). | Group with space deliberately | not prototyped |
| MEDIUM | writing | `en.ts:517,520,558,1345` | Control labels and placeholders are lower case ("resume", "down", "prompt — the agent will start…", "what should get done in harbor-api?") while their neighbours are sentence case ("Unfold", "Fold", "Rotate", "Collapse finished", "Edit"). "down" is also not a verb. | One capitalization policy; verb-first buttons | 08 |
| LOW | typography | `FeedItem.tsx:161,180` | Agent prose ends paragraphs on a lone word ("…a key without its / row.", "…behave as / before."), most visibly in the narrow stage columns and on the phone. | `text-wrap: pretty` on short prose | 03 |
| LOW | typography | `kanbanBoard.css:1084` | The model chip in a pane header ("Opus 5", "gpt-5.6-sol") is set in bold monospace; the composer's model control below it ("Opus 5.5 · Light") uses the UI font. | Fewer fonts; one treatment per element type | 04 |

### Pipeline view (desktop `pipeline-desktop`, phone `pipeline-phone`)

| Sev | Domain | Location | Observed | Rule | Patch |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | typography | `kanbanBoard.css:385`, `:774`, `:1084` | Model names are bold monospace in every stage chip, graph node, stage row and pane header ("Opus 5.5", "5.6-Sol", "Sonnet"), and the stack is a literal `ui-monospace, SFMono-Regular, Menlo` instead of the `--font-mono` token. Monospace marks code, and a model name is a name; on this screen the monospace competes with the stage names for attention. | Fewer fonts; use a token only in its role | 04 |
| LOW | typography | `FeedItem.tsx:161` | The narrow stage columns strand single words at paragraph ends (see the conversation row). | `pretty` | 03 |
| LOW | layout | `pipelineBlock.css:228` | On the phone the stage-state words do not share a trailing edge: "passed" stops before a chevron, "running" runs to the card edge, "waiting" stops before a gear. | Align to shared edges | not prototyped |
| LOW | layout | `PipelineBlock.tsx:789` | On the phone, "Attach PR or issue…" is a bare accent-colored line of text, right-aligned in empty space while everything else on the screen aligns to the leading edge. | Controls distinct from content; shared edges | not prototyped |
| LOW | layout | `StagesSheet.tsx:283` | "Collapse finished" and "Expand all" are shapeless text beside icon-only chevrons; they read like labels. | Controls distinct from content | not prototyped |

### Orchestrator panel (desktop `orchestrator-desktop`, phone `orchestrator-phone`)

| Sev | Domain | Location | Observed | Rule | Patch |
| --- | --- | --- | --- | --- | --- |
| MEDIUM | ui | `CopyButton.tsx:74` | The same boxed copy button, beside the operator's bubble and each answer (same root cause as patch 02). | Borders for structure | 02 |
| LOW | layout | `McpCallCard.tsx:153`, `:187-195` | On the phone the MCP call row keeps its 36px desktop indent (other tool rows drop it on phones, `ToolCard.tsx:416`), and when the row wraps, its timestamp lands alone at the start of the second line under the badge. | Align to shared edges; group related items | 07 |
| LOW | writing | `en.ts:520` | The composer placeholder "what should get done in harbor-api?" is lower case (same root cause as patch 08). | One capitalization policy | 08 |

### Invisible in a still, noted for completeness

| Sev | Domain | Location | Observed | Rule |
| --- | --- | --- | --- | --- |
| LOW | ui | `SeatTickBody.tsx:253` | The one `transition-all` in the codebase (the seat-tick toggle's knob). | Transition only what changes |
| LOW | ui | whole app | No press feedback (`scale(0.96)`) on any button. | Scale on press |

Coverage: all five screens at both widths were rendered and read. Motion was
read from source only, and hover and focus states were not walked in a
browser, so claims about them are **not verified**. Contrast was not measured
here; `tokens.contrast.test.ts` already holds the text roles to 4.5:1, and
nothing in these patches changes a text color except patch 01, whose pill
text moves to `--color-secondary`, a role that test already covers on
`--surface-well`.

## Step three: the ranked changes

Ranked by visible gain per line of code. Every patch applies to the lane HEAD
alone and all eight stack without conflict (`git apply --check`, then applied
in order to an export). Each was built with `next build`, which also
typechecks. No test suite was run against them: that belongs to whichever
lane builds the chosen ones. The one test that pins a changed string is
named in its row.

The renders are in `~/Pictures/delegatus-review/interface-polish/`:
`NN-before.png` / `NN-after.png` are full frames of the primary screen,
`NN-pair.png` is the same pair side by side (cropped to the change where the
frame is large), and a second screen, where one exists, uses the same names
with a screen infix (`NN-phone-*`, `NN-card-*`, `NN-orchestrator-*`).

| # | Change | Why (rule) | Cost | Files | Patch |
|---|---|---|---|---|---|
| 1 | **Board cards: status pill goes neutral inside its column, with a dot in the status hue.** The column already names the status; the pill stays a control (it still opens the status menu) but stops flooding four hues across the board, and the accent violet stops meaning "Assigned". | better-colors: one color, one meaning; fill one action per view. better-interface: delete before adding. | 6 CSS lines. Text is `--color-secondary` on `--surface-well`, 7.14:1 dark. The list view and the phone keep their tinted pills. | `src/components/kanban/kanbanBoard.css` | `01-status-pill-neutral-in-columns.patch` |
| 2 | **Copy buttons become the ghost buttons their comment already describes.** The border, fill and shadow go; the 44px touch target stays, and hover gets a `bg-sunken` wash. On a phone this removes a heavy square from every message and every tool output. | better-ui: borders only for structure; one treatment for sibling controls (the read-aloud button beside it is already borderless). | 1 line. | `src/components/feed/CopyButton.tsx` | `02-ghost-copy-button.patch` |
| 3 | **Model names in the UI font.** Stage chips, graph nodes, stage rows and pane headers stop setting "Opus 5.5", "5.6-Sol" and "Sonnet" in bold monospace; the existing `min-width: 7ch` then lines the signal bars up in one column on the phone. | better-typography: fewer fonts, one treatment per element type. better-colors/tokens: use a token only in its role (the rules hard-coded a mono stack instead of a token). | 3 CSS lines. | `src/components/kanban/kanbanBoard.css` | `04-model-names-in-ui-font.patch` |
| 4 | **MCP call rows on the phone line up with the prose and stay on one line.** The 36px desktop indent is dropped below 768px (as the other tool rows already do), and the outcome, duration and time wrap as one group at the trailing edge. In the seeded orchestrator the row goes from two lines, with the time alone under the badge, to one. | better-layout: align to shared edges; group related items. | 6 lines. | `src/components/runtime/McpCallCard.tsx` | `07-mcp-row-phone-alignment.patch` |
| 5 | **Agent prose wraps with `text-wrap: pretty`.** Paragraphs stop ending on a lone word ("…without its / row.", "…behave as / before."). Most visible in the pipeline's narrow stage columns and on the phone. | better-typography: `pretty` on short prose. | 2 class additions. Chrome 117+ honours it; other browsers ignore it. | `src/components/feed/FeedItem.tsx` | `03-text-wrap-pretty-prose.patch` |
| 6 | **One capitalization policy for controls and composer placeholders.** "resume" → "Resume", "down" → "Jump to latest", "prompt — the agent will start…" → "Prompt — …", "what should get done in {project}?" → "What should…", with the Ukrainian catalog kept in step. | better-writing: one capitalization policy per element type; verb-first buttons. | 8 catalog strings, plus `LogFeed.mobileChrome.dom.test.tsx:264`, which expects "down". | `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | `08-sentence-case-controls.patch` |
| 7 | **Phone task screen: the pipeline head's chevron ends its row.** The spacer that shares the row on the board is hidden in the phone lane card, so the chevron sits at the end of the tappable head, beside the ⋯ menu, instead of in the middle of the card. It still stops about 47 CSS px short of the chevrons in the rows below, because the menu follows it; lining those up needs the menu moved, which is markup work. | better-layout: align to shared edges. | 1 CSS line. | `src/components/pipelines/pipelineBlock.css` | `05-phone-lane-chevron-ends-row.patch` |
| 8 | **"passed · pass" says it once.** The past-attempts summary drops the stage verdict when it only repeats the attempt's state (passed/pass, failed/fail), and keeps it when it adds something (a decision request, a pass on a failed attempt). | better-writing: delete every word that does no work. | 3 lines. No test pins the old text. | `src/components/kanban/PipelineSection.tsx` | `06-past-attempt-verdict-once.patch` |

Patch files are numbered in the order they were written; the table's rank is
the recommendation. Pairs on disk use the patch number:

| Rank | Patch | Before / after (primary) | Also |
|---|---|---|---|
| 1 | 01 | `01-before.png`, `01-after.png`, `01-pair.png` (board, desktop) | `01-card-before.png`, `01-card-after.png` |
| 2 | 02 | `02-before.png`, `02-after.png`, `02-pair.png` (conversation, phone) | `02-orchestrator-{before,after,pair}.png` |
| 3 | 04 | `04-before.png`, `04-after.png`, `04-pair.png` (pipeline, desktop) | `04-phone-{before,after,pair}.png` |
| 4 | 07 | `07-before.png`, `07-after.png`, `07-pair.png` (orchestrator, phone) | |
| 5 | 03 | `03-before.png`, `03-after.png`, `03-pair.png` (pipeline, desktop) | `03-phone-{before,after,pair}.png` |
| 6 | 08 | `08-before.png`, `08-after.png`, `08-pair.png` (conversation, desktop) | `08-phone-{before,after,pair}.png` |
| 7 | 05 | `05-before.png`, `05-after.png`, `05-pair.png` (task screen, phone) | |
| 8 | 06 | `06-before.png`, `06-after.png`, `06-pair.png` (task card, desktop) | |

Validated against the requirement: each row is an interaction or
visible-control change on one of the five named screens, each has a render
pair from the seeded home at the named widths, and none touches screen-reader
semantics. Nothing here needs a new token, dependency or component.

## Deferred — not currently justified

- **Merge the board's jump tabs into the column heads** (`KanbanBoard.tsx:2365`).
  It is the largest layout gain on the desktop board, but the tabs are also
  the navigation when columns scroll out of view. Which one survives is a
  product decision, and a `variant` run over the board header (tabs only,
  heads only, both) is the tool for making it.
- **Concentric column radius** (`kanbanBoard.css:142`). The rule asks for
  about 22px on the column. `tokens.css:38` fixes "exactly two" radii on
  purpose, and a third radius for one surface undoes that contract for a
  small gain.
- **A web font.** `--font-sans` falls back to the platform face (Noto Sans on
  the capture machine), so type differs by OS. Choosing and loading a face is
  a brand decision with a loading cost, and outside the scope of polish.
- **`scale(0.96)` press feedback** on buttons. It is invisible in a still, and
  the board's most frequent controls are exactly the high-frequency
  interactions the same skill tells you to leave unanimated.
- **`transition-all`** on the seat-tick knob (`SeatTickBody.tsx:253`). A
  one-word fix with no visible change; fold it into whichever lane touches
  that file next.
- **Phone pipeline trailing edge and the lone "Attach PR or issue…" link**
  (`pipelineBlock.css:228`, `PipelineBlock.tsx:789`), **"Collapse finished" /
  "Expand all" affordance** (`StagesSheet.tsx:283`), **the blank band under a
  phone Bash command** (`ToolCard.tsx:129`), and **the doubled chevron and ⋯
  on a card with a pipeline**. Each is real but smaller than the eight above,
  and the last one needs a decision about which menu owns what.
- **A `break` run** over the task card with long titles, many stages and
  many conversations would test patches 01 and 05 against worst-case content.
  It is worth doing once one of them is being built.

## Verification

- Every frame named above was captured from a production build of the lane
  HEAD (before) or of HEAD plus exactly one patch (after), served against a
  freshly seeded invented home, and each one was opened and read.
- `git apply --check` passes for each patch against HEAD, and the eight apply
  in sequence to one export.
- Each patched tree built with `next build --webpack`, which includes the
  TypeScript check.
- **Not verified:** the unit and DOM suites (not run; the one pinned string
  is named in row 6), hover and focus states in a browser, light scheme, and
  motion. Contrast was computed for the one new text/background pair.
