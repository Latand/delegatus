# Landing research: onorca.dev, seen in a real browser, against our landing

## The requirement

Operator, 2026-10-09 about 11:35 Kyiv, orchestrator seat chat, verbatim:

> «https://www.onorca.dev/ - запусти ресерчера по лендінгу з браузером і щоб ми покращили власний ленгдинг - взяти прилкдді рішень і покращень (не копі а ідея)»

In English: send a researcher with a browser to that landing so we can improve our own;
take examples of their solutions and improvements, as ideas and never as copies.

This document is outcome 1 of the task: the research and a ranked list of ideas.
Outcome 2 (2–3 numbered variants for the operator to pick) and outcome 3 (the chosen
variant built) come after it, in later stages.

**Rule this document keeps:** nothing of theirs is reproduced here. No sentence of their
copy is quoted. Their layout is described only as far as needed to name an idea. Their
screenshots stay on this machine and never enter the repository.

## Method

- **Browser.** Headless Chromium 1243, started by its own PID through a playwright-core
  CDP connection and stopped by that PID after each run. Same day, 2026-10-09.
- **Widths.** 1440×900 desktop and 390×844 phone (touch, mobile user agent).
- **Scroll pass.** Every section, one screen at a time (85 % of a viewport per step). Each
  stop was shot twice, 1.6 s apart, to see what moves. Running animations were listed at
  every stop through `document.getAnimations()`.
- **Interaction pass on onorca.dev.**
  - Watched the hero for 30 s and clicked each hero tab.
  - Followed the moving pointer.
  - Clicked each tab of the feature switcher and opened a feature card.
  - Opened an FAQ item and the platform menu.
  - On the phone: opened the menu and the hero tabs.
  - Loaded once with `prefers-reduced-motion: reduce`.
- **Interaction pass on delegatus.org.** At both widths: pressed the demo's own send
  control and followed the hero script through all five steps. Measured the scale of each
  live frame and the type sizes inside the hero frame.
- **Source.** Our source was read in `landing/site/` (`index.html`, `copy.js`,
  `styles.css`, `main.js`, `README.md`). `landing/wrangler.jsonc` serves `landing/site/dist`
  as the `delegatus-landing` Worker on `delegatus.org` and `www.delegatus.org`. The live
  page carries the copy of #2389 and the version line the page reads from npm (1.10.0).
- **Frames.** About 170 frames, kept local under
  `$HOME/Projects/delegatus-wt/handoff/landing-onorca/` in four folders: `onorca-1440/`,
  `onorca-390/`, `delegatus-live-1440/` and `delegatus-live-390/`, with `interact/` beside
  them. Each folder holds `info.json` (outline, calls to action, media, fonts, timings) and
  `requests.json`.

Prior work: nothing relevant existed. search_transcripts (project, then unscoped) and
search_memory found no earlier onorca or competitor-landing research. The last landing copy
pass is #2389. It found two common misreadings: Delegatus as a way around the providers'
terms, and Delegatus as Claude Code with a new face. It answered both inside the hero
sentence.

## onorca.dev as a visitor sees it

### Structure and order

The desktop page is about 9 900 px tall; the phone page is about 15 100 px.

| # | Section | What it does |
| --- | --- | --- |
| 1 | Hero | Investor badge, a speed-claim headline, a two-line product sentence, a download button that names the visitor's detected OS, a GitHub button, and a line with the other platforms (it opens a menu) |
| 2 | Hero product window | A large desktop-app mock with five tabs over it. Each tab plays a scripted scene of the app, with a fake pointer moving through it. A phone mock peeks out from the right edge |
| 3 | Logo marquee | Company logos scroll sideways under a small "used by engineers at" style label |
| 4 | Feature switcher | Eight icon tabs. Each tab pairs a short heading and one sentence on the left with an animated miniature of that feature on the right |
| 5 | Agent wall | Every supported CLI agent as a chip (about 27), and a dashed chip for any other |
| 6 | Mobile companion | A tall phone mock beside the app-store and APK buttons |
| 7 | Feature grid | Thirteen cards, each a looping muted video with a title and two sentences. A click opens a lightbox carousel (01 / 13) with arrows and dots |
| 8 | Testimonials | Two large quotes and six small ones. Each carries a face, a handle and a role, and links to the original public post |
| 9 | Comparison table | A table of capabilities, ticked for them and marked "sometimes", "limited" or a dash for the alternatives as a class |
| 10 | FAQ | Ten closed accordion items |
| 11 | Closing call | Big product-name headline, two short claims, download plus community buttons, the platform line again |
| 12 | Footer | Three link columns |

The phone page keeps the same order. Two changes are deliberate:

- **The hero's actions become phone actions.** The primary button is the mobile app, then
  the APK, then a "also on desktop" link, then GitHub.
- **A sticky bottom bar** holds the same three phone actions once the hero has scrolled away.

### Hero and value statement

- The headline is a speed promise with a number. The sentence under it lists the agents by
  name and the four things in the window.
- A large primary button names the action and the visitor's platform. The other platforms
  are one quiet line below it.
- The headline is the largest contentful paint, at 248 ms on desktop and 220 ms on the
  phone: text first, product second.

### How the product is shown

- **The hero window is a hand-built replica of the app** (HTML, crisp at 1:1). It does not
  embed the app.
  - Each of its five tabs is a short scene: a task fans out, a review happens, a browser
    pane shows a form.
  - A soft white dot plays a pointer and walks to what changes. A thin progress line under
    the active tab fills while the scene plays. The tab advances by itself when the scene
    ends (about 10 s for the first scene, about 18 s for the second).
  - A click jumps to a scene.
- **The feature switcher repeats the trick at a smaller scale.** Each miniature is a
  simplified card stack that animates the one idea in its heading: rows appearing,
  spinners, a parent task with two children.
- **The feature grid uses real screen recordings.** Thirteen MP4s autoplay muted on a loop
  once in view; one video is 75–640 KB.
- **On the phone, the hero window is the same desktop replica scaled to the width.** Its
  text is unreadable there.

### Proof and trust

- An investor badge above the headline.
- A star count in the header (in the tens of thousands).
- A logo marquee.
- Eight attributed quotes, each linking to its public original.
- A comparison table.
- "Free and open source" in the closing block.
- An FAQ that answers comparison and pricing questions head-on.

### Calls to action

- **One primary verb, repeated:** download for the detected platform. It appears in the
  header, the hero and the closing block. The phone gets the app instead.
- **Secondary actions:** GitHub, then community chat at the end.
- **Calls are placed at decision points:** after the hero, after the mobile section, at the
  close.

### Motion and visual system

- **Colour and type.** Near-black background (#08090A), white type, one sans family for
  everything (72 px / weight 500 / tight tracking on desktop, 40 px on the phone) and one
  mono for code. No accent colour beyond agent and status colours inside the mocks.
- **Motion is all inside the product mocks:** scene playback, spinners, the pointer, a
  progress line, autoplaying clips, the logo marquee. The page chrome itself is still.
- **Reduced motion.** Under `prefers-reduced-motion: reduce`, 15 animations were still
  running three seconds after load (spinners, the marquee).

### Performance feel

- **Desktop:** DOMContentLoaded at 83 ms, load at 454 ms, network idle at 1.3 s. About
  64 requests and 5.1 MB, almost all of it the 13 feature videos.
- **Phone:** the phone fetched every video twice (26 media requests).
- **Hosting:** a static Next.js build. The page feels instant because text paints first and
  the heavy media sits far below the fold.

## Our landing as a visitor sees it (delegatus.org, source in `landing/site/`)

| # | Section | What it does |
| --- | --- | --- |
| 1 | Hero | Our headline and a sentence on what runs. A second line says free, open source, the official CLIs on your machine with your logins. The install box: Claude Code / Codex tabs, "Copy prompt", the prompt, and "I still use a terminal" |
| 2 | Hero live frame | The real interface, bundled, on invented harbor-api data, with Board/Orchestrator tabs. Five step chips. The visitor presses the product's own send button, then the script plays steps 2–5 about every 5 s. Full-screen control. Mascot on the frame |
| 3 | It runs the work | Four capability lines. A live pipeline frame with tabs for the Build→Review→Verify pipeline and for a decision |
| 4 | Every conversation, open | Four vertical tabs (conversation, search, accounts, activity) driving one live frame |
| 5 | It finds you | Three lines (phone in your tailnet, decision on its card, Telegram). A live phone frame with Board, Decision and Reports tabs |
| 6 | Footer band | Cream band: free and open source, what the prompt does, requirements, the install box again. Links, version, analytics disclosure |

The desktop page is about 5 450 px tall; the phone page is about 5 770 px. The largest
contentful paint is the headline at 184 ms (desktop) and the sub line at 148 ms (phone).
There are 82 requests.

What already works better than onorca:

- **Every picture of the product is the product.** It is live and clickable, and it holds
  at the phone width as a real phone layout. Their phone hero is a shrunken desktop.
- **The hero script tells a story in five steps:** request, task and pipeline, build passed,
  review passed, it needs you. Their scenes show activity without a beginning and an end.
- **The install path is one copy action that hands the work to the visitor's own agent.**
  It is shorter than download, install, open, configure.
- **The page is short.** It has four ideas, and nothing repeats.
- **Our analytics disclosure is honest and visible.** Theirs loads a product-analytics
  flag endpoint on first paint.

## Section-by-section comparison

| Topic | onorca.dev | Delegatus today | Gap |
| --- | --- | --- | --- |
| Value statement | Numeric speed promise. The product sentence names the agents and the window's parts | A command-style headline. The sub line names the board, the two engines, seeing and stepping in | Ours is clear. It never says who it is for or what changes for them in time or attention |
| Primary call | Download for the detected OS; phone visitors get the phone app | Copy the install prompt for Claude Code or Codex | Ours gives a phone visitor nothing they can do on the phone |
| Platforms and requirements | One quiet line under the button, plus a menu | Only in the footer band | Requirements are far from the first call |
| What it works with | A wall of 27 agent chips | Named inside sentences (Claude Code, Codex; Copilot reading in section 4) | No at-a-glance answer to "does it work with what I have" |
| Product in the hero | Replica scenes at 1:1, auto-advancing, a pointer and a progress line | The real interface, waiting for a press; steps advance about every 5 s after it | **Ours is rendered at 0.70 scale on desktop** (measured below), so most of its text is unreadable without full screen |
| Feature depth | Switcher with eight tabs, then a grid of 13 clips in a lightbox | Two sections with tabs (two pipeline views; four open views) | Ours shows fewer capabilities. Several real ones are missing: multiple accounts beyond one tab, the review round budget, Telegram reports, voice |
| Proof | Investor badge, stars, logos, eight linked quotes, comparison table | A star count (22) in the header | Almost no proof. A small star count beside "GitHub" reads as weak proof |
| Misreadings and objections | Ten-item FAQ, plus a comparison table aimed at the category | Two clauses in the hero sentence (#2389) | The misreadings #2389 found have no place to be answered fully |
| Closing call | Big closing headline and two buttons | Cream footer band with the install box | Comparable. Ours is good |
| Phone | Sticky bottom bar with phone-appropriate actions | No sticky action. The hero leads with a prompt that needs a computer | See the primary-call row |
| Motion | Inside the mocks only. Spinners keep going under reduced motion | Inside the frames only; the page honours reduced motion (`.still`) | Ours is calmer. Keep it |
| Weight | 5.1 MB, mostly video, below the fold | Light page; four live frames, each loading `demo.js` | Ours wastes requests (below) |

## Our weakest points, measured

1. **The hero demo is too small to read on desktop.** At 1440 the hero iframe is 1820 px
   wide, scaled by 0.699 into a 1273 px box. Inside it, 72 text runs are 11 px and 16 are
   10 px. On screen that is 7.7 px and 7.0 px. The proof the page rests on reads as texture.
   - Shown by: the computed `transform` of `[data-live="hero"] iframe`.
   - Frame: `delegatus-live-1440/01-first-screen.png`.
2. **The misreadings have no full answer.** #2389 found two misreadings: a way around the
   providers' terms, and Claude Code with a new face. They are answered by one clause each
   in the hero. Nowhere on the page can a doubtful visitor read the longer answer: what
   runs, whose accounts, what stays on the machine, what merges by itself, what it costs.
3. **There is next to no proof.** The only social signal is a star count of 22 next to
   "GitHub". There is no release history, no changelog link, no sign that the project ships
   often or that anyone uses it.
4. **The phone visitor has no action.** On the phone the first call is "Copy prompt", a
   prompt for an agent on a computer. The phone hero frame also truncates: the active step
   chip shows "Send the req…" (its label is clipped at 390, measured as
   `scrollWidth > clientWidth`), and the frame header shows "Orchestra…".
5. **Compatibility and requirements sit far from the first call.** "Does it work with my
   setup" is answered only in the footer band (OS, Bun, Claude Code or Codex).
6. **Each page load makes 52 failed requests and 4 redirects.** Each of the four demo
   iframes asks for the product's 13 sound cues under `/audio/cues/*.mp3`, which the
   landing does not ship. Every one answers 404 and logs a console error (13 errors per
   frame).
   - Each iframe src is also built as `demo/index.html?…` (`landing/site/main.js:362`).
     The asset host answers it with a 307 to `demo/?…`.
   - This is cheap to fix and invisible to visitors. It is still noise in every visitor's
     console and in our own captures.
7. **The hero waits for a press, then plays.** The design is deliberate: `demo_start`
   counts visitors who send. A visitor who does not press sees a still step 1. While it
   plays, the only progress cue is a text line; the chips show no time remaining.

## Strong ideas from onorca.dev, in our words

Each idea names what it gives a visitor and how it would look on Delegatus, on our own type
(Unbounded / Geologica / Martian Mono), our dark tokens, our cream band and our mascot.

1. **Make the shown product readable at the size it is shown.**
   - *Their idea:* a mock built at 1:1 so every word in the hero is legible.
   - *What it gives:* the visitor reads what the agents are saying, which is the proof.
   - *For us:* keep the real interface. Stop shrinking a 1820 px layout into 1273 px.
     - Render the hero frame at its box width, or close to it (scale ≥ 0.9), showing the
       orchestrator chat and two or three board columns.
     - Or let the frame follow the script: at each step, zoom gently to the region that just
       changed (the chat on step 1, the new card on step 2, the stage chip on steps 3–4,
       the decision card on step 5).
     - Both use the frame we have; neither needs a replica.
2. **Give the doubts a home: a short FAQ.**
   - *Their idea:* a closed accordion that answers comparison, platform and price questions
     without lengthening the page.
   - *What it gives:* a doubtful visitor finds the answer without leaving. Search engines
     and answer engines find it too.
   - *For us:* six to eight questions written from #2389's misreadings and the README:
     - Does it get around the providers' terms? (It runs the official CLIs, signed in with
       your own accounts.)
     - Is it Claude Code with a new face? (What the board, the orchestrator and the
       reviewers add.)
     - What leaves my machine?
     - Does it merge by itself? (Off by default.)
     - Windows? (WSL 2.)
     - What does it cost? (Free, MIT; your own subscriptions.)
     - Can I use only Claude Code or only Codex?
     - How do I reach it from my phone? (Your tailnet.)
   - It goes before the footer band, in both languages.
3. **Answer "does it work with what I have" at a glance, next to the first call.**
   - *Their idea:* a wall of agent chips, and a quiet platform line under the button.
   - *What it gives:* compatibility settles in one glance at the moment of acting.
   - *For us:* a single quiet row under the hero install box: macOS · Linux · Windows (WSL 2)
     · Claude Code · Codex · reads Copilot sessions · Bun 1.4+.
     - Truthful and short. A long wall would overclaim: we run two engines.
     - The footer band keeps its full sentence.
4. **Proof we can stand behind: show the project shipping.**
   - *Their idea:* a stack of social proof (stars, logos, quotes) near the top and in the
     middle.
   - *What it gives:* the visitor sees the project is alive and used.
   - *For us:* we have no logos or quotes to show, and inventing them is out of the question.
     What we do have and can verify from public data:
     - the release cadence: the current version and how many days since the last release,
       next to a link to the releases or changelog;
     - the fact, if the operator confirms it, that the project's own changes are built and
       reviewed through Delegatus pipelines, linked to the merged pull requests;
     - Telegram/GitHub links.
   - The star count moves out of the hero chrome until it helps.
   - A real-quotes section is deferred until real quotes exist.
5. **A phone visitor gets a phone action.**
   - *Their idea:* the phone hero leads with the action that makes sense on a phone, and a
     sticky bottom bar keeps it in reach.
   - *What it gives:* a phone visitor (from Telegram, X, a chat link) can act now.
   - *For us:* at phone widths the hero's first action becomes "send this to my computer".
     - It is the system share sheet (`navigator.share`) with the page link, falling back to
       copy link.
     - "Copy prompt" sits right under it for visitors who run an agent from the phone.
     - A slim sticky bar with the same action appears once the hero has scrolled away. It
       hides over the footer band, where the install box already is.
6. **Show that the demo is moving, and where it is going.**
   - *Their idea:* the active tab carries a thin progress line, scenes advance on their
     own, and a soft pointer leads the eye to what changes.
   - *What it gives:* the visitor knows the picture is alive, how long a step lasts, and
     where to look.
   - *For us:* keep the visitor's press as the start; it is what `demo_start` measures.
     - While the script plays, the active step chip fills like a progress bar.
     - A soft highlight (our accent, no fake cursor) rings the element that just changed
       inside the frame.
     - Under reduced motion, both are off, as the rest of the page already is.
7. **A plain comparison: Delegatus beside a coding agent in a terminal.**
   - *Their idea:* a capability table against the category, without naming anyone.
   - *What it gives:* the "is it just a new face" reader sees what is added, row by row.
   - *For us:* columns "a coding agent in a terminal" and "the same agent under Delegatus".
     Rows we can prove today:
     - one orchestrator agent that runs a board;
     - a worktree per task;
     - a fresh read-only reviewer on the other engine;
     - failed reviews return within a round budget;
     - decisions wait on their card;
     - every conversation readable and searchable;
     - several accounts with their limits;
     - phone and Telegram.
   - It fits as a compact block in "It runs the work". It never names a competitor.
8. **A capability gallery that opens the real thing.**
   - *Their idea:* a grid of short clips. A click opens a large view with next and previous.
   - *What it gives:* depth for the curious without lengthening the page for everyone.
   - *For us:* our proof is the live interface, so each card would open the existing frame in
     our existing full-screen overlay, at the right view. Telegram reports, accounts and
     limits, search, activity, review rounds and the phone would each get a card.
   - No video files.

## Ranked ideas for our landing

Ranked by visitor value per unit of work, and by how directly each answers a measured weak
point above.

1. **Readable hero demo** (idea 1). Changes **the hero live frame** (section 1/2): a scale
   near 1 with a cropped view, or step-following zoom.
   - *Why:* the page's whole argument is "this is the real interface". At 7–8 px on
     desktop, the argument does not land.
   - Weak point 1.
2. **FAQ for the misreadings** (idea 2). Adds a **new section before the footer band**.
   - *Why:* #2389 found the misreadings and answered them in one clause each. A visitor who
     still doubts has nowhere to read more.
   - Weak point 2.
3. **Phone visitors get a phone action** (idea 5). Changes **the hero install slot at phone
   widths**, plus a sticky bar.
   - *Why:* phone traffic arrives from chat links and can do nothing today.
   - Weak point 4. The clipped step chip and frame header get fixed in the same pass.
4. **Compatibility row under the install box** (idea 3). Changes **the hero install slot**
   (desktop and phone).
   - *Why:* it settles "will this work for me" at the moment of acting. It is cheap and
     strictly truthful.
   - Weak point 5.
5. **Proof from the project's own shipping** (idea 4). Changes **the header** (star count)
   and adds **a release/changelog line in the footer band**, or a slim strip under the hero.
   - *Why:* we have no logos or quotes, but a living release history is real proof.
   - Weak point 3.
6. **Delegatus beside a bare agent, as a table** (idea 7). Changes **"It runs the work"**
   (section 2).
   - *Why:* it answers the "new face" misreading row by row, beside the live pipeline that
     proves it.
   - Weak point 2.
7. **Step progress and a change highlight** (idea 6). Changes **the hero step chips and
   frame**.
   - *Why:* the demo looks alive and guides the eye, and `demo_start` keeps its meaning.
   - Weak point 7.
8. **Quiet the demo's console** (no onorca idea; found while measuring). Changes **the demo
   build and `main.js`**: link `demo/?…` directly and give the demo no sound cues (or ship
   them).
   - *Why:* 52 failed requests and 4 redirects per visit cost nothing to remove.
   - Weak point 6.
   - It is a small fix; it can ride with any variant, or go as its own lane.

Variants for outcome 2 would naturally combine these:

- one variant around the **hero** (ideas 1, 3, 4, 7);
- one around **trust** (ideas 2, 5, 6);
- a third that does both with the least new chrome.

The operator picks.

## Deferred — not currently justified

- **Logo marquee and testimonials.** We have no verified users to show. Invented or implied
  logos would break "our copy stays truthful". Revisit when real, linkable quotes exist.
- **Investor or backer badge.** Nothing true to show.
- **A wall of every agent.** We run Claude Code and Codex and read Copilot sessions. A long
  chip wall would overclaim.
- **Autoplaying the hero script without a press.** It would change what `demo_start`
  measures and fight the "press send" moment the hero is built around. Idea 6 gets most of
  the benefit without it.
- **Screen-recorded video clips.** Our live frames are better proof. Clips add megabytes
  and go stale with every UI change.
- **OS-detecting download button.** We have no binary to download. Our install is a prompt
  given to the visitor's agent; the compatibility row (idea 3) covers the need.
- **A separate replica of the app for the hero.** It would duplicate the product and drift
  from it. Idea 1 makes the real interface readable instead.
- **A long feature grid.** It doubles the page length on the phone (theirs is 15 000 px).
  Idea 8 stays optional, after the first five.

## Gaps and notes

- **Engine.** All rendering was headless Chromium with a mobile user agent and touch. Real
  iOS Safari was not used: no device is attached to this session. Their phone layout and
  ours were judged from Chromium at 390×844.
- **Language.** onorca.dev was seen in English only; it offers no other language. Our
  landing was seen in English live. The Ukrainian copy was read in `landing/site/copy.js`
  only, and the variants will render both.
- **Proof idea 4 needs a fact checked.** Before any variant says the project is built
  through its own pipelines, the operator should confirm the wording. The data is public in
  the repository history.

## Outcome

The operator picked variant 3 (prototype review, 2026-10-09): the readable hero, the
compatibility row, the phone's send-the-link action, a six-question FAQ and the release
freshness in the footer's version line. In the same review the operator asked for the
hero's board to become a demo that plays one flow by itself, with a visible pointer and
no interaction. That reverses "a separate replica of the app for the hero" above: the hero
is now a board drawn in the product's own look over invented data (`landing/site/boardDemo.js`),
animated on the compositor only. Every frame below the hero is still the product.
