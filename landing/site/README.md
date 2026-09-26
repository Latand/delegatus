# The Delegatus landing (delegatus.org)

The final landing, built on prototype A (`landing/opus/`, left as it was) with
the operator's feedback and [`docs/landing/critique.md`](../../docs/landing/critique.md).
Every picture of the product on the page is the product: Delegatus's own
interface, bundled for the browser and running over invented data, in an
iframe the visitor can click through.

## Build and open

```
bun landing/site/build.ts          # → landing/site/dist/, a static site
bunx serve landing/site/dist       # any static host serves it the same way
```

The demo is an ES module that answers the interface's requests inside the
page, so the site has to be served over HTTP; a `file://` page cannot load it.
`?lang=uk` or `?lang=en` picks the language; the switch in the header
remembers the choice, and so does the switch inside the demo.

Renders for review (never committed):

```
bun landing/site/capture.ts        # → ~/Pictures/delegatus-review/landing/final/
```

It takes 1440×900 and 390×844 in English and Ukrainian: the full page, the
first screen, each section, the hero's script step by step (it presses the
product's own send control, as a visitor does), every tab of every frame, and
the legacy install. `report.json` beside the PNGs lists page errors, requests
the demo left unanswered, and sideways overflow.

## Files

| file | what it holds |
| --- | --- |
| `index.html` | the four sections, the footer band and the install-box template |
| `styles.css` | the page: type, the product's dark tokens, the frames around the demo |
| `copy.js` | every visible string of the page in English and Ukrainian, and the two install prompts |
| `mascot.js` | the mascot's three poses (unchanged from A) |
| `main.js` | language, install boxes, the legacy giggle, and the controller of the live frames |
| `demo/demo.tsx` | the demo: the real `Viewer`, the answers to its requests, the scripted steps, the views |
| `demo/world.ts` | the invented harbor-api world at each step, in both languages |
| `demo/taskIcons.json` | the lucide drawings of the demo's task icons, written by the build |
| `build.ts` | bundles the demo, compiles the product stylesheet, assembles `dist/` |
| `capture.ts` | the render driver |

## How the demo works

`demo/demo.tsx` renders `@/components/Viewer`, the same component the product
serves, and replaces `fetch` and `EventSource` so every request is answered
from `demo/world.ts`: files, tasks, pipelines, transcripts, the orchestrator's
seat and report log, accounts and limits, message search. The build stubs
`"use server"` modules the way Next does for a client bundle, compiles
`src/app/globals.css` through Tailwind and pins it to the dark palette.

The world is a function of the step and the language. The hero's frame opens
at step 0 with the request typed into the orchestrator's composer and its send
control breathing. When the visitor sends it, the product's own send goes out,
the demo answers it, and the script runs: the orchestrator answers, a task and
its pipeline appear on the board, Build passes and a report lands, Codex
passes the review, and another task stops on a decision under Needs you. Each
step moves the world forward and tells the board through the runtime stream,
the way a running Delegatus does.

The page talks to each frame by message: which step to jump to, which view to
show. A view is reached by pressing the product's own controls (fold the
orchestrator, dock it at the side, open a pipeline, open a conversation, the
accounts trigger, `/` for search), found by their labels in the product's own
dictionaries, so both languages work. The hero switches views in place; the
other frames load a fresh frame per view and swap it in once it has drawn.

## Decisions where the brief was open

- **Frames, not captures.** The product in an iframe keeps its own layout,
  styles and language, and it is clickable; the page scales a frame only when
  the column is narrower than the width the product needs.
- **The hero's two views** are the orchestrator docked at the side of the
  board (the default, so the request, the answer and the new card are in one
  picture) and the orchestrator on top with its report log. While the script
  plays, the frame turns to where each step happened; a tab the visitor picks
  wins from then on.
- **On a phone** every frame runs the product's phone interface at 390 px.
  The hero's script starts from the board's "Tell the orchestrator" dock.
- **Activity** is the product's Overview: the cards someone is working on
  right now, across every project.
- **Telegram** has no drawn cards: the product has no Telegram surface to show
  with invented data, so it stays one line of copy.
- **Fonts** still load from Google Fonts, as in A: the publication gate
  refuses committed binaries.
- **Size.** The demo bundle is about 3.5 MB minified; the hero's frame loads
  with the page and the others as they come near.
