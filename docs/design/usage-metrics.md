# Usage metrics: how many people install Delegatus, and what the site records

## Originating requirement

Operator, 2026-09-30, pinned to this task (Ukrainian, verbatim):

> запиши що терміново треба зробити щоб було зроз3уміло скільки встановлююдть
> в'ювер, і метрики по сайту щоб десь писалися, все зробии

Meaning: urgently, make it clear how many people install Delegatus, and have
the website's metrics recorded somewhere.

Constraint from the same spec: the product promises that nothing leaves the
user's machine (`docs/design/linked-installs.md` §5.2: "There is no relay,
rendezvous, telemetry or lookup service; nothing reaches any server run by the
Delegatus project"). Any install ping changes that promise and needs the
operator's explicit decision.

## Today's numbers (2026-09-30, no product change)

Every figure below was read on 2026-09-30 with bounded calls (commands in the
appendix). Dates are UTC.

### npm: `delegatus-cli`

| Day | Downloads | Published that day |
| --- | ---: | --- |
| 22.09 | 113 | 0.0.0 (the empty placeholder), 22:58 |
| 23.09 | 185 | 1.3.0 |
| 24.09 | 161 | 1.4.0 |
| 25.09 | 166 | 1.5.0 |
| 26.09 | **32** | none |
| 27.09 | **14** | none |
| 28.09 | 129 | 1.6.0, 19:34 |
| 29.09 | not in the API yet (it lags 1–2 days) | 1.7.0, 1.7.1 |

The same week, split by version: 0.0.0: 182, 1.3.0: 184, 1.4.0: 162, 1.5.0:
162, 1.6.0: 110. That adds up to exactly 800.

**How to read this.** Each new version draws 110–180 downloads in its first
week, about 110 of them within hours of publication. The empty placeholder
drew 182, including 113 in the hour after it was published, and 1.6.0 drew 110
in the 4½ hours left in its day. The old package shows the same shape:
`agent-log-viewer` got 439 on 19.09, when three versions were published (about
146 each), 951 on 08.07 with six versions (about 158 each), and 148–155 on
each single-release day in August. These bursts come from registry mirrors and
scanners that fetch every new tarball. With one or two releases a day, most of
the npm number is these bursts.

On the two days with no release, 26 and 27.09, `delegatus-cli` got 32 and 14
downloads. `agent-log-viewer`: 822 downloads over 30.08–28.09 (439 of them on
its release day). `live-log-viewer`: 29.

### Is it CI?

The operator, 2026-09-30 (translated from Ukrainian): "I think most of the npm
downloads are CI."

**Answer: most downloads are automation, and that automation is registry
mirrors and scanners. Our CI fetched the package zero times in 22–28.09.**
npm counts every HTTP 200 response that delivers a package tarball, with
mirrors, bots and CI included, and counts no metadata reads (npm's own
explanation of its download counts).

| Source, 22–28.09 | Fetches `delegatus-cli`? | Evidence | Downloads |
| --- | --- | --- | ---: |
| GitHub Actions in this repository: 4,542 runs, 330–1,234 a day | no | No workflow, `bun.lock` or `Dockerfile` names the package, and none did at any point since 15.09. `publish.yml` packs the checkout (`npm pack`) and reads metadata (`npm view`), and npm counts neither. | 0 |
| GitHub Actions in other repositories | none found | GitHub code search finds the name only in this repository, and in no workflow file anywhere | 0 |
| Docker image build (59 runs, all on 28.09) | no | the image installs Bun from npm and the repository's dependencies from `bun.lock` | 0 |
| Release smoke and install-script tests | none reach the registry | `scripts/npm-package-smoke.test.ts` packs the checkout locally and runs in no workflow; the site has no install script | 0 |
| Our deploys: production Docker, runtime-host releases, the stage server | no | all of them build from the git checkout; the stage server's Bun caches and temp directories hold no copy of the package | 0 |
| Self-update | no | a packaged install only tells its user to run `bunx delegatus-cli@latest`; checkout and Docker installs update from git | 0 |
| Our agents on this machine | once | Of the 679 agent transcripts from the week that mention the package, one lane ran `bunx delegatus-cli` against the public registry: a newcomer-journey audit, four runs from one fresh home, 24.09 22:07–22:14 UTC. A rename lane on 22.09 used a local test registry. Every other match was text inside an edit, a commit message or a `grep`. | 1–4 |
| Registry mirrors and scanners | every version | npmmirror holds all seven versions, the empty placeholder included, and serves them from its own CDN; deps.dev has indexed all seven. The placeholder drew 113 downloads in its first hour, and 1.6.0 drew 110 in its first 4½ hours. | about 110 per version within hours, plus a tail |

Two more checks point the same way. Downloads track releases (correlation
with the number of releases that day r = 0.93) and barely track Actions runs
(r = 0.47, and runs are also higher on release days); 27.09 had 330 runs and
14 downloads. `agent-log-viewer` had four days in September with zero
downloads (03, 07, 08 and 15.09), which a CI job that installs the package
would never leave.

**Corrected numbers.** The estimate takes about 110 per release as the fast
wave from mirrors and scanners, and 10–20 a day as their tail. The tail comes
from the placeholder: nobody had a reason to fetch it after its first hour,
and it still drew 69 more downloads over the next six days.

| Day | Raw npm | Releases | Mirrors and scanners (est.) | Our CI | Our agents | Likely people (range) |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 22.09 | 113 | 0.0.0 at 22:58 | 113 | 0 | 0 | 0 |
| 23.09 | 185 | 1.3.0 | 120–130 | 0 | 0 | 55–65 |
| 24.09 | 161 | 1.4.0 | 120–130 | 0 | 1–4 | 27–40 |
| 25.09 | 166 | 1.5.0 | 120–130 | 0 | 0 | 36–46 |
| 26.09 | 32 | none | 10–20 | 0 | 0 | 12–22 |
| 27.09 | 14 | none | 10–20 | 0 | 0 | 0–4 |
| 28.09 | 129 | 1.6.0 at 19:34 | 120–129 | 0 | 0 | 0–9 |
| Week | 800 | 5 | 613–672 | 0 | 1–4 | 130–185 |

"People" means new installs, updates and reinstalls together. Every user who
starts Delegatus with `bunx` fetches each new version once, so new installs
are only part of this column. The weekly figure averages 19–26 a day, most of
it on 23–26.09, when the rename was announced and the landing was posted.

**Confidence.**

- CI contributes nothing: **high.** Every workflow, the lockfile and the
  Dockerfile were checked for the whole week, the downloads do not move with
  the run count, and the old package has days with zero downloads.
- About 110 per release comes from mirrors and scanners: **high.** It was
  measured within hours of publication on two versions, one of them an empty
  placeholder, and the old package shows 120–160 per version on its release
  days.
- The 10–20 a day tail: **medium to low.** It rests on one version.
- The people ranges: **medium** as ranges and **low** as point values. npm
  cannot tell a new install from an update.

### GitHub (the API keeps only 14 days: 16–29.09)

| Metric | Value | Use |
| --- | --- | --- |
| Repository page views | 464 views, 86 unique visitors | interest |
| Referrers (unique visitors) | github.com 19, **delegatus.org 16**, Google 9, a Teams link 6, youtube.com 3, Telegram web 1, t.co 1, perplexity.ai 1 | shows that the site sends people to the code |
| Clones | 18,788 clones, 1,686 unique cloners | unusable as installs: almost certainly CI checkouts, pipeline worktrees and update checks (the API gives no split) |
| Stars / forks | 20 / 6 in total; 2 / 2 since 22.09 | weak signal |
| Releases | 7 releases, none with assets | GitHub counts no downloads for them |

### Container image

The public package page for the image named in the README's Docker section
shows **Total downloads 0** and 0 downloads per version. The maintainer builds
images locally. The `gh` token on this machine lacks `read:packages`, so the
count was read from the page. It is not known whether that counter includes
anonymous pulls.

### Install-script hits on the site

There are none, and there can be none today, because delegatus.org serves no
install script. Its install box copies a prompt for the visitor's agent that
runs Bun's own installer (from bun.com) and `bun add -g delegatus-cli` (npm).

### delegatus.org

**Site metrics are already recorded.** The zone was added to Cloudflare on
2026-09-26 at 07:09:28. Cloudflare created a Web Analytics site for it with
automatic setup two seconds later, and the served HTML carries the
`cloudflareinsights.com` beacon (checked by fetching the page). It was switched
on automatically, and the site does not mention it.

Visits to `/`, excluding headless Chrome (the landing's own render driver):

| Day | 26.09 | 27.09 | 28.09 | 29.09 | 30.09 (partial) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visits | 50 | 40 | 30 | 10 | 30 |

- Countries (visits): Ukraine 90, United States 60, Moldova 10.
- Devices (visits): desktop 100, mobile 60.
- Referrer: every visit arrived without one (messengers and apps strip it),
  so Web Analytics cannot say where visitors come from on this site.
- All page loads, 26–30.09: 1,150. Of these, 950 are `/demo/` iframes (each
  landing view loads up to four demo frames) and 140 came from headless Chrome.
  Counting page loads therefore overstates traffic about six times.
- **The numbers are sampled.** The API reports a sample interval of 10–12.5
  for these days, so every figure moves in steps of about 10, and a small day
  is noise. (Cloudflare's FAQ says the last 7 days are unsampled. The API says
  otherwise.)

Not readable with the token on this machine: zone HTTP analytics (all
requests, bots included), because the token lacks Zone Analytics read. The
operator sees these in the Cloudflare dashboard. Worker invocations since 24.09:
none, because the Worker serves static assets only (no script, no bindings),
and asset requests do not run a script.

### What we can say today

- **Installs:** of the 800 npm downloads over 22–28.09, about 610–670 came
  from mirrors and scanners, none from our CI and 1–4 from one of our agents.
  About 130–185 were people: 0–65 a day, about 20 on average, mostly on
  23–26.09. npm cannot tell new installs from updates, and no source counts
  installs that are still running.
- **Site:** 10–50 visits a day since 26.09, about 160 in five days, mostly
  from Ukraine and the US, desktop two to one. The site sent 16 people to the
  GitHub repository in the 14-day window.

## 1. Installs

### 1.1 Sources that need no product change

| Source | Counts | Noise | Verdict |
| --- | --- | --- | --- |
| npm downloads API (`downloads/range`, `versions/…/last-week`) | tarball fetches per day and per version | about 110 per release plus a tail of 10–20 a day from mirrors and scanners; our CI adds none; people's updates and new installs look alike | keep; report the corrected estimate from "Is it CI?" beside the raw number |
| GitHub traffic | page views, referrers, clones (14 days only) | clones are all machinery; views are interest | keep views and referrers, and store them daily, since GitHub forgets after 14 days |
| GitHub release assets | none exist | — | nothing to read |
| ghcr pulls | page counter shows 0 | unknown semantics | glance occasionally |
| Site install script | none exists | — | see Deferred |
| Copy clicks on the site's install box | not recorded today | close to install intent, with no identifiers | recommended in §2 |

None of these can say how many installs exist or are in use. Only a signal
from the install itself can.

### 1.2 Options that change the product

| Option | What we learn | Privacy cost | Trade-off |
| --- | --- | --- | --- |
| **A. No ping** (today) | the numbers above, no better | none | the question stays unanswered |
| **B. Opt-in ping, asked once** | active and new installs among those who say yes: a hard lower bound | only for users who say yes (below) | undercounts; npm gives the loose upper bound |
| **C. Opt-out ping, on by default** | close to all active installs | every install that does not act, including every existing install, which was promised that nothing leaves | best numbers; it breaks the promise for people who never read the notice, and that is hard to take back |
| D. Ping at install time (npm `postinstall`) | would count installs | as B or C | Bun runs no lifecycle scripts for installed packages by default (Bun docs), so it would not fire on the documented `bunx` / `bun add -g` path |

**Recommendation: B.** Delegatus asks once and sends nothing until the answer
is yes. Starting opt-in and moving to opt-out later is possible. The reverse
is a trust incident with no undo.

**What the ping carries, and nothing else:**

| Field | Example | Why |
| --- | --- | --- |
| `id` | random UUID created for this purpose only, stored in the state directory | tells new installs from returning ones and counts distinct active installs. It is never the linked-installs `installId` (`src/lib/links/self.ts`), so a peer that knows one cannot join it to the other. |
| `v` | `1.7.1` | version adoption |
| `os`, `arch` | `linux`, `x64` | which platforms to support |
| `kind` | `packaged`, `checkout`, `docker` | install path, as `src/lib/selfUpdate/mode.ts` already decides it |

It never carries paths, host or user names, project names or keys, account
names, engines, models, message counts or anything about use.

**When:** once per UTC day while the Viewer runs, starting a minute after
boot, with a 5-second timeout and no retry. Only the process whose state owner
is `viewer` sends it. Tests, builds, `next dev` and the Docker test profile
never do.

**Where it lands:** `POST https://delegatus.org/api/ping`. The landing Worker
gains a small script that runs only for `/api/*` (`run_worker_first`), while
every other path stays a free static asset. The script checks the body
against the four fields (any other field is refused), adds the country that
Cloudflare derives from the request (`request.cf.country`), and writes one
data point to Workers Analytics Engine. It stores no IP address. Analytics
Engine keeps data for three months (Cloudflare docs), and the daily totals
from §3 keep the history.

**How it is asked and disclosed:**

- The setup guide's last step asks, with two buttons and neither preselected:
  "Count this install? Once a day Delegatus sends delegatus.org a random
  install id, its version and your OS. Nothing about your projects, files,
  accounts or agents." / "Рахувати це встановлення? Раз на день Delegatus
  надсилає на delegatus.org випадковий id встановлення, версію та ОС. Нічого
  про твої проєкти, файли, акаунти чи агентів." An install that never answers
  sends nothing.
- An existing install sees the same question once, as a notice on the
  Overview.
- The README gains a short "What leaves your machine" section. §5.2 of
  `docs/design/linked-installs.md` and the CHANGELOG say the same.

**How a user turns it off:** a switch in Settings; `DELEGATUS_TELEMETRY=0`;
`DO_NOT_TRACK=1`. The environment always wins over the stored answer.

**The privacy cost, stated plainly.** For a user who says yes, their Delegatus
contacts delegatus.org once a day. Cloudflare, which runs the site, sees their
IP address and the time, as with any web request. The project stores a random
id, the version, OS, architecture, install kind and country for three months.
The id shows that the same install was active on different days, and the
country narrows where it is. For a user who says no or never answers, nothing
changes. The product's sentence becomes "nothing reaches any server run by the
Delegatus project unless you turn on install counting."

## 2. Site metrics

| Option | Records | Cookies and consent | Cost | Viewed in | State |
| --- | --- | --- | --- | --- | --- |
| **Web Analytics beacon** | visits, page views, paths, referrers, countries, devices, browsers, OS, Core Web Vitals; sampled about 1 in 10; no custom events (FAQ: "Not yet") and no query strings | Cloudflare says it uses no cookies or localStorage and does not fingerprint | free; soft limit of 10 sites per account (4 in use) | Cloudflare dashboard, GraphQL | **on since 26.09** |
| **Analytics Engine events written by the Worker** | exactly what the page sends: copy-prompt clicks (per agent and language), copy of the legacy command, the visitor starting the hero demo, full screen opened; plus country | no cookie and no id, sent with `navigator.sendBeacon` | Workers Free includes 100,000 script requests and 100,000 data points a day; Analytics Engine is not billed yet (docs) | SQL API only, since Analytics Engine has no dashboard, so the §3 script reads it | needs a Worker script and binding, plus a few lines in `landing/site/main.js` |
| Rows in D1 / objects in R2 | whatever we write | same as above if no id | D1 Free: 100,000 writes a day | D1 console, SQL | R2 is not enabled on the account (the API says so); the token cannot list D1. Heavier: a schema and a retention job. |
| Workers Logs | each script run | — | free, 200,000 events a day | dashboard | kept for 3 days: useless for history |
| Zone HTTP analytics | all requests, bots included | none | free | dashboard | on; this token cannot read it |

**Recommendation:** keep Web Analytics as it is. Add Analytics Engine events
for the four clicks, because copying the install prompt is the closest thing
to an install that the site can see. Add one footer line in both languages,
for example: "This site counts visits with Cloudflare Web Analytics (no
cookies) and counts clicks on its copy buttons." Cost: $0.

## 3. Where the numbers are seen

| Option | For | Against |
| --- | --- | --- |
| Cloudflare dashboard | Web Analytics has a UI | npm, GitHub and Analytics Engine live elsewhere; Analytics Engine has no UI |
| A `/stats` page on the Worker | one link | needs Cloudflare Access (a Zero Trust setup) or public numbers, and more code |
| A Delegatus view | inside the product | puts a panel only the maintainer needs, plus calls to npm, GitHub and Cloudflare with the maintainer's token, into every user's install; against the promise |
| **Script plus a daily message** | one table from every source; no product change | there is no page to open: the operator reads the message or runs one command |

**Recommendation:** `bun scripts/usage-metrics.ts` prints one table from npm,
GitHub, Web Analytics and, later, Analytics Engine. `--line` prints the same
numbers as one message. The project's seat sends that line once a day to the
operator's **private** chat with the Delegatus bot (already allowlisted; the
bot can post there). The script also appends each day's totals to a history
file outside the repository and outside the Viewer's state, so GitHub's
14-day and Analytics Engine's 3-month windows lose nothing. For detail on
visitors, the message links to the Web Analytics dashboard.

The project's orchestrator reports already go to a public community group.
A metrics line there publishes the numbers, so it goes there only if the
operator says so.

Example line:

```
📈 Delegatus 28.09 · npm 129, з них людей ≈0–9 (реліз 1.6.0) · встановлення: — · сайт: 30 візитів, копій промпту: — · GitHub: 19 відвідувачів
```

## 4. Build plan

| # | Slice | Acceptance | Size | Operator decision first? |
| --- | --- | --- | --- | --- |
| S1 | `scripts/usage-metrics.ts`: npm range and per-version split, with the corrected estimate from "Is it CI?" (raw minus about 110 per release that day, minus the tail), GitHub views, referrers and stars, and Web Analytics visits to `/` without headless browsers; table and `--line`; appends to the history file; every call bounded (30 s) | reproduces this document's figures for every date still inside each source's window, with Web Analytics within its sampling steps; a failing source is named and the rest still prints; no token appears in output or errors; one test over recorded fixtures | S | no |
| S2 | Daily line: one line in the seat's monitor note that runs S1 with `--line` and sends it with `telegram_bot_send` | a message in the private chat on two days in a row; nothing posted to the public group | XS | **yes: where it goes** (decision 2) |
| S3 | Move the Worker's `wrangler.jsonc` from the maintainer's deploy directory into `landing/` (no account id), update the deploy steps in `landing/site/README.md`, add the footer disclosure in both languages | `wrangler deploy --dry-run` from the repository describes the Worker that runs today; footer renders in EN/UK at 1440 and 390 through `landing/site/capture.ts` | S | no |
| S4 | Site events: a Worker script behind `run_worker_first: ["/api/*"]`, `POST /api/event` → Analytics Engine dataset `site_events`; `sendBeacon` for the four clicks; S1 reads them | a handler test: a valid event writes one data point with the expected fields, an invalid one answers 400 and writes nothing, and `/` still comes from assets; after deploy, a copy click shows in S1 within minutes. First confirm which token permission the Analytics Engine SQL API needs, since this token's read got "Authorization error". | S | no |
| S5 | Ping endpoint: `POST /api/ping` → dataset `installs`, strict four-field schema | handler tests: an unknown field or a malformed id answers 400 and writes nothing; country added; no IP written | S | **yes** (decision 1) |
| S6 | Ping in the product: stored answer and id, the setup-guide question, a notice for existing installs, the daily sender in the `viewer` process, the Settings switch, `DELEGATUS_TELEMETRY` / `DO_NOT_TRACK`, and the README, §5.2 and CHANGELOG disclosure; `viewer-test` in `docker-compose.yml` sets `DELEGATUS_TELEMETRY=0` | tests: no request while the answer is unset or no, under either variable, or outside the `viewer` owner; with yes, one request per UTC day carrying exactly the four fields; the id differs from the links `installId`; the question rendered in EN/UK on desktop and phone | M | **yes** (decision 1) |
| S7 | S1 reports active installs per day and week, and new installs (`count(DISTINCT id)` in Analytics Engine SQL) | the line shows installs once S6 has shipped | XS | after S5–S6 |

S1, S3 and S4 can start now. S2 waits on decision 2, and S5–S7 wait on
decision 1.

### Decisions for the operator

- **Decision 1: install ping.** (a) none; (b) opt-in, asked once in the setup guide,
  as in §1.2; (c) opt-out with a notice. **Recommended: (b).**
- **Decision 2: where the daily line goes.** (a) the operator's private chat with the
  bot; (b) also the public community group; (c) nowhere, run the script on
  demand. **Recommended: (a).**

## Deferred — not currently justified

- Per-tab and per-step demo analytics, scroll depth, session replay.
- A `/stats` page, public or behind Cloudflare Access.
- A metrics view inside Delegatus.
- Engines, models, agent counts or feature use in the ping.
- An install script on delegatus.org (`curl | bash`) as a way to count
  installs: it adds a supply-chain surface to count something the ping counts
  better.
- A `postinstall` ping (option D).
- Raw request logs in D1 or R2.
- A `delegatus telemetry` CLI subcommand: the switch and the variables cover
  it.
- A Viewer-side scheduler for the daily line, to build only if the seat misses
  days.

## Checked against the requirement

- "Make it clear how many install": today's numbers are at the top, together
  with the limit of what they can show. S1 makes them one command, and decision 1
  plus S5–S7 give a real count of installs.
- "Site metrics recorded somewhere": this has been true since 26.09 through
  Web Analytics. S4 adds the copy clicks, and S1 and S2 put the numbers in one
  place every day.
- "Urgently, do everything": S1, S3 and S4 need no decision. The two
  decisions above are the only blockers.

## Appendix: how each number was observed

- npm: `curl -s -m 30 https://api.npmjs.org/downloads/range/last-month/<pkg>`,
  `…/downloads/point/last-month/<pkg>`, `…/versions/<pkg>/last-week`, and
  `https://registry.npmjs.org/<pkg>` for publish times.
- GitHub: `gh api repos/<owner>/<repo>/traffic/{views,clones,popular/referrers}`,
  `…/stargazers` with `application/vnd.github.star+json`, `…/forks`,
  `…/releases`.
- Container image: the public package page, parsed for "Total downloads".
- Is it CI: per-workflow run counts per UTC day from
  `gh api repos/<owner>/<repo>/actions/workflows/<id>/runs?created=<day>`
  (`total_count`, with any window that hits the 1,000-result search cap split
  in two); `git log -p` over `.github/workflows` and `Dockerfile` since 15.09;
  `gh search code delegatus-cli`; a scan of the week's agent transcripts for
  executed `bunx`, `bun add`, `npm i` and `npx` commands naming the package;
  a read-only listing of Bun caches and temp directories on this machine and
  the stage server; `registry.npmmirror.com/delegatus-cli` and its tarball
  redirect; `api.deps.dev/v3/systems/npm/packages/delegatus-cli`; npm's blog
  post on how download counts work.
- Cloudflare, with the maintainer's deploy token and read calls only:
  `zones?name=delegatus.org` (plan "Free Website", created 2026-09-26
  07:09:28), `rum/site_info/list` (a delegatus.org site with auto-install,
  created 07:09:30), `workers/scripts/delegatus-landing/settings` (no
  bindings), GraphQL `rumPageloadEventsAdaptiveGroups` filtered on the site,
  `requestPath: "/"` and `userAgentBrowser_neq: "ChromeHeadless"`, and
  `workersInvocationsAdaptive` (empty).
- Cloudflare facts from its docs, read on 2026-09-30: Web Analytics FAQ,
  metrics and product page; Analytics Engine pricing, limits and SQL aggregate
  functions; Workers pricing; static-assets billing and `run_worker_first`
  routing. Bun lifecycle scripts: Bun's install docs.
- Not observed: the Workers plan (the billing endpoint refused the token);
  whether Analytics Engine is usable with this token (its SQL API answered
  "Authorization error"); D1 on the account (the token cannot list it); zone
  HTTP analytics (no permission); whether the ghcr counter includes anonymous
  pulls; whether GitHub counts `git ls-remote` update checks as clones.
- Earlier conversations: `search_transcripts` for install metrics, telemetry,
  npm downloads, Web Analytics, the Cloudflare beacon and two Ukrainian
  phrasings found no earlier discussion of install counts, telemetry or site
  analytics. The only related hit is the 2026-09-26 orchestrator session that
  set up the landing Worker and its deploy config.
