# Linked installs: one Delegatus reads another, peer to peer

Status: design, 2026-09-25, revised after review round 4. Read-only design
stage; nothing here is built yet. Every code claim was checked against
`origin/main` at `534edaf72` (PR #2159, activity records itself), and the
round-3 and round-4 revisions re-checked the cited files at `959a77d9c`:
`store.ts`, `pull.ts`, `continuous.ts`, `hostSources.ts`, `sameOrigin.ts`,
`proxy.ts` and `deploymentProxy.ts` are unchanged between the two. This branch's merge base
is the older `46f47bec1`; the branch changes only this document, so the
difference does not touch what is cited.

## Originating requirement

Pinned task specification, 2026-09-25 (operator direction relayed by the
orchestrator), verbatim:

> Operator direction, 2026-09-25: a user may run Delegatus on several machines
> (a laptop, a workstation, a stage/VPS box). One install must be able to read
> another's activity (and later other metadata: conversations, tasks, agent
> state) so /activity and the board see the whole picture. Other users have no
> ssh between their boxes and no server of ours, and a central user database is
> too heavy. So the link is local and peer to peer: one Delegatus pulls from
> another over an HTTP endpoint, configured by the user, and sync must be
> correct (no duplicates, no silent gaps, resumable).

Operator corrections relayed by the orchestrator during this stage,
2026-09-25, verbatim:

> the PRIMARY case is a Delegatus deployed on a real server with a public
> domain (HTTPS on the internet), not Tailscale; most users will not run
> Tailscale. Design for that first: (1) HTTPS is mandatory for any peer that is
> not loopback or a private LAN address, plain HTTP to a public address is
> refused; (2) the peer endpoints are closed to anyone without a paired token
> (no anonymous read, no enumeration, no difference in response between wrong
> token and unknown route beyond 401), with rate limiting on pairing attempts;
> (3) state exactly which fields leave a host (activity records carry no
> message text per #2159: say what they do carry) and that nothing is sent to
> any third party; (4) cover how an install behind a reverse proxy/domain
> learns and shows its own public URL for pairing. LAN, Tailscale and ssh stay
> secondary transports. The operator also asked whether the current ssh pull
> can leak their data: answer that explicitly in the doc (what travels, where
> it is stored, who can read it).

> setup must be fully in the UI, no config-file editing. Place it in (1)
> Settings, a "Linked installs" section: this install's own public URL, "Allow
> a connection" (shows the one-time code and its expiry), "Connect to another
> install" (URL + code), and a row per linked install with last read, lag,
> error, Revoke; (2) the existing onboarding flow: an optional "Do you run
> Delegatus on another machine?" step that opens the same connect form; (3)
> the /activity hosts table: an unread host row offers "Connect this machine"
> that opens the same form. Describe the error states the user sees (wrong
> code, expired code, HTTP refused for a public address, peer unreachable,
> token revoked) in plain words, en and uk. Keep one form component reused in
> all three places.

> once installs are linked, (a) sync projects: each install shows which
> projects the other has, with their boards readable; (b) send work to a
> linked install that has the resources (e.g. a server with more RAM, the repo
> checked out, other accounts): start an agent or a pipeline for a task THERE
> from here, and see its progress on this board. Design it as a separate,
> explicit grant per peer ("this machine may start agents on mine"), never
> implied by the read-only pairing; say what the remote side must advertise
> (projects and checkouts, free RAM, engines/accounts available, busy state),
> how a dispatched run is tracked and cancelled, what happens when the link
> drops mid-run, and the threat model for a peer that may run code on this
> machine. Put it after the activity slices in the slice plan.

Validation against these quotes is in [§12](#12-validation-against-the-requirement).

## Prior art searched

`search_transcripts` for "pairing code linked installs", "several machines sync
another Delegatus over HTTP", "peer token read-only feed other host", "central
server user database", "linked installs" and "pull over ssh stage box
activity hosts.json" returned nothing about peer pairing. The only relevant hits
are the #2159 delivery and review conversations, whose outcome is recorded in
`docs/design/activity-dashboard.md` ("Other hosts: the pull"). This design
builds on that pull.

## 1. What exists today

| Piece | Where | What it gives this design |
|---|---|---|
| Own activity store | `src/lib/activity/store.ts` | `<state>/activity/records.sqlite` (0600, dir 0700). Rows keyed `(host, key)`; this host is `host = ''`. One counter `activity_meta.version` rises on every write of an input or a turn; `store_id` is a UUID minted with the file. `localRowsAfter(version, limit)` and `localTurnsAfter(version, limit)` already serve "everything written after a version". `upsertPulled` / `upsertPulledTurns` replace a row only when the sender's version is higher (`store.ts:461-476`), whoever sends it. `hostState` / `setHostState` hold each pulled host's `cursor`, `remoteStore` and read span in an `activity_hosts` row. `forgetHost` (`store.ts:499-505`) deletes a pulled host's inputs and turns and **keeps** its `activity_hosts` row: cursor, remote store id and covered span stay. That fits its one caller, the recreated-store restart in `pullHost`, which re-reads from 0 and overwrites the span at the end; it is wrong for deleting history (§2.6). |
| ssh pull | `src/lib/activity/pull.ts` | `pullHost(store, host, config, transport)` pages by version cursor, detects a recreated remote store by `store_id` (or `latest < cursor`), takes each row whole or refuses the page (an unknown `type` fails `parseRemoteRow`, `pull.ts:300-306`, so the page is `malformed`), and takes the remote's read span only with the last page. The wire format is NDJSON: one `state` line (`v: 1`), then `input` / `turn` lines. Only the transport is ssh-specific (`sshTransport` at `pull.ts:129`, `REMOTE_READER`). |
| Host list | `src/lib/activity/hostSources.ts` | `activity/hosts.json` (`{ v: 1, local, hosts: [{ id, label, projects, since, pull? }] }`) names expected hosts; `storeSource("pull", …)` turns a pulled host's `activity_hosts` row into coverage, `readAt`, `error`. Host ids match `/^[a-z0-9][a-z0-9._-]{0,62}$/` (`validHostId`, `humanInput.ts`). |
| Schedule | `src/lib/activity/continuous.ts` | After each ingest pass, `startDuePulls` pulls every host whose interval passed, one at a time, beside the index queue. |
| Hosts table | `src/components/activity/ActivityDashboard.tsx`, `HostsTable` | One row per expected host with a line per source: last read, last error (`unreachable`, `timeout`, `no-ingest`, `malformed`), "not connected". |
| Access gate | `src/proxy.ts` | `LLV_TOKEN` unset: every request passes. Set: cookie `llv_auth`, `Authorization: Bearer`, or `?k=` link, compared with `tokensMatch` (`src/lib/authToken.ts`, sha256 + `timingSafeEqual`). `/api/artifact/frame/` is already exempt because it authorizes itself (`FRAME_PREFIX`, `proxy.ts:7`). |
| Host pin | `src/lib/sameOrigin.ts` | `rejectCrossOrigin` / `rejectForeignHost` admit only a `Host` of `localhost`, `127.0.0.1`, `::1` or `LLV_TS_HOST` (`allowedHostNames`, `sameOrigin.ts:32`). Not every route calls it: of 130 `route.ts` files, 79 call it directly, most of the rest reach it through a shared handler (spawn, runtime, conversation host, self-update, MCP), and 23 never do. Those 23 are nearly all reads, among them `/api/conversations`, `/api/files`, `/api/logs`, `/api/logs/stream`, `/api/timeline`, `/api/session`, `/api/search/transcripts` and `/api/accounts`; they answer any `Host`, and only `LLV_TOKEN` stands in front of them. |
| Gateway | `src/runtime-host/deploymentProxy.ts` | The runtime host's stable port (8898, bound to `127.0.0.1`). With `viewer-gateway.json` `{ remoteEntryPort, localEntry: "trusted" }`, `serveViewerLocalEntry` replaces the `Authorization` header of any request whose `Host` is loopback (`isLoopbackHost`, `:209`; `vouchedCredential`, `:274-302`) with the release's own credential. The remote entry (`remoteEntryPort`, also loopback, 8897 in `docs/docker.md`) is a raw pipe where the Viewer's gate decides. Every other header is forwarded as is (`forwardedHeaders`). `src/runtime-host/viewerEntries.ts` records which ports were bound (`readViewerEntries`). |
| Phone access | `src/lib/access/phoneAccess.ts`, `bin/tailscale.mjs` | Publishes the Viewer as `https://<machine>.<tailnet>.ts.net` through `tailscale serve`, turns `LLV_TOKEN` on, sets `LLV_TS_HOST` / `LLV_TS_URL` in the Viewer's environment and restores them at boot. `dockerTailnetEntry` (`phoneAccess.ts:137-154`) targets the remote entry, and the press refuses (`TRUSTED_ENTRY`, `:263`) to publish a stable port that is a trusted local entry. This is the pattern §3.1 reuses. |
| Onboarding | `src/components/onboarding/OnboardingDialog.tsx`, `src/lib/onboarding/steps.ts` | Steps `engines, agents, phone, voice, tour, check`; a marker written before a new step reads it as "not visited". Re-entry rows live in `ProjectRail.tsx` and `menuEntries.tsx`. |
| Settings | none | There is no Settings page or dialog in the app today (no `src/components/settings`, no `settings.*` i18n keys). The "Settings → Linked installs" place has to be created (§8.1). |

Four facts found in the code shape the primary case:

1. **A Delegatus behind a public domain answers 403 on every pinned route
   today.** A reverse proxy that keeps the public `Host` delivers
   `Host: delegatus.example.com`, which the pin refuses: every write and most
   reads (the board, pipelines, spawn) fail, while the 23 unpinned reads in
   the table above answer. The UI is broken, and what does answer is guarded
   by the access key alone. Nothing in the repo declares a public host: there
   is no `LLV_PUBLIC_URL`, and `x-forwarded-proto` is read only to mark a
   cookie `secure`. The public case therefore needs a declared public address
   before any peer work (§3.1). Pinning the 23 reads is outside this design
   (§14, item 11): the pin stops no direct caller (fact 4), and the key that
   §3.1 requires for any saved address is what guards them.
2. **The trusted local entry vouches for any request that says it is local.**
   `vouchedCredential` decides on the `Host` header alone. `docs/docker.md`
   recommends trusting the local entry, and agents on the Docker shape need it
   for HTTP MCP (`docs/docker.md:253, 314-323`). A public proxy aimed at 8898
   that passes the client's `Host` through (nginx `proxy_set_header Host
   $host`, where `$host` is whatever the client sent when the request lands on
   the default server) turns `curl https://delegatus.example.com/api/pipelines
   -H 'Host: 127.0.0.1'` into an operator request: board, spawn, and so code
   execution. An ssh tunnel to 8898 does the same for every process on the
   tunnel's machine. This exposure exists on `main` today for anyone who fronts
   8898 with such a proxy; publishing a public address for links makes it the
   normal setup, so §3.1 closes it.
3. **The gateway rewrites `Authorization` on loopback-Host requests.** A peer
   credential sent as `Authorization: Bearer` through the local entry would be
   replaced by the operator's own. The peer credential therefore travels in its
   own header (§2.4).
4. **Without the access key, the Host pin stops no direct caller.** The pin
   refuses a foreign `Host`, but a caller writes the `Host` it likes:
   `rejectForeignHost` (`sameOrigin.ts:43-47`) admits anyone who sends
   `Host: 127.0.0.1`, and `proxy()` (`proxy.ts:50-53`) lets every request
   through while `LLV_TOKEN` is unset. So any port of B that a stranger can
   reach (a LAN proxy, a public proxy, an ssh tunnel on another machine)
   gives that stranger the board and spawn, whatever address is saved. The
   key can also disappear at run time: `disablePhoneAccess` unsets it on a
   loopback CLI install (`phoneAccess.ts:398`). §3.1 therefore checks the key
   at every point where it is **used**: per request, per action and at
   boot.

## 2. Pairing

### 2.1 Roles and words

- **B** is the install being read (it grants). **A** is the install that reads.
- A **grant** lives on B: one peer, its scopes, the sha256 of its token.
- A **link** lives on A: one peer's address, transport, token, and the host id
  A files its rows under.
- A **host id** on A is unique across everything that names a host: every
  `activity_hosts` row, every `peers.json` entry whatever its state (active,
  failing, `revoked`, `awaiting-choice`, kept, inert), every push grant, and
  every `hosts.json` entry with a `pull`. A new link or push grant takes only
  a **free** id; a taken one is refused `name-taken`, and the form proposes
  the first free `{id}-2`, `{id}-3`, …. The one way to reuse a taken id is to
  continue that host, from its own row or through the confirmation (§2.6).
  A `hosts.json` entry without `pull` and without a row is free: it only
  says a host is expected, and "Connect this machine" (§8.3) links it.
- A **code** is minted on B for one pairing: a public id plus a secret, single
  use, 10 minutes.

To read both ways, pair twice (each side allows, each side connects). One-step
mutual pairing is deferred (§11).

### 2.2 Flow

```
 B (operator, in Settings)             A (operator, in the connect form)
 ─────────────────────────             ────────────────────────────────
 "Allow a connection", scopes ticked
 (refused without the access key)
   POST /api/links/codes      ──►  code R4TZ7M-K7QM9-XTD2P, expires 10:41
                                   operator reads it to A's screen
                                   types B's address + code
                                   POST /api/links/peers {url, code, name}
                                     A's server checks the URL policy (§3.2)
                                     and that a typed name is free (§2.1)
                  ◄── POST https://b/api/peer/v1/pair/probe {id}   ×3,
                      Host: 127.0.0.1 / localhost / [::1]  (§2.5)
 answer {vouched}; a vouched probe
 burns the code and marks this
 install open-to-internet   ──►        any vouched:true → stop, peer-open
                  ◄── POST https://b/api/peer/v1/pair {code, install:A}
 look up the code by its id; verify
 the secret hash, unexpired, unused,
 attempts left; mint token; store
 sha256(token) in the grant; burn it
                  ──► 200 {grant:{id, token, scopes}, install:B,
                           storeId, feeds}
                                     A refuses if storeId is its own store
                                     or a live link's; if it is a removed or
                                     revoked host's, A asks its operator
                                     before continuing that host (§4.4);
                                     stores the link (token 0600) under a
                                     free id and pulls at once
```

The browser on A never sees the token and never talks to B: A's Viewer makes
every peer request server-side, so CORS and cookies never enter it.

### 2.3 Code and token

- **Code:** `IIIIII-SSSSS-SSSSS` in Crockford base32, case-insensitive, `I`/`L`
  read as `1` and `O` as `0`. The first 6 symbols are the code's **public id**
  (a lookup handle, 30 bits); the next 10 are the **secret** (50 bits). The id
  is not a secret, but it is long enough that nobody finds an open code by
  scanning: at most a few codes are open at once, so hitting one takes about
  2³⁰ requests inside its 10 minutes, and a request naming no open code
  changes nothing (§2.5). With a 4-symbol id (2²⁰) a fast scanner could find
  the open code through its `429` and burn it; that denies pairing, never
  reveals the secret, and is what the longer id prevents.
  B stores the id in plain text and the secret as sha256, with the expiry,
  scopes, a remaining-attempts counter and a failed-attempts count, so a
  Viewer restart (a deploy) inside the 10 minutes keeps it and a read of B's
  files cannot recover it.
- **Token:** 32 random bytes, base64url. B keeps only its sha256 (compared with
  `tokensMatch`). A keeps it in plain text because it must send it.
- No expiry by default; revocable on either side (§2.6). Rotation is deferred.

### 2.4 How a peer request authenticates

```
X-Delegatus-Peer: <grantId>.<token>
```

- A dedicated header: the gateway forwards it untouched, and it can never be
  confused with the operator credential (`LLV_TOKEN`), which the peer routes
  never accept. The operator's cookie is ignored on peer routes too.
- A browser page cannot send a custom header cross-origin without a CORS
  preflight, and peer routes answer no preflight, so a drive-by page cannot
  call them with a stolen token or a guessed code. `POST /pair` also requires
  `content-type: application/json` for the same reason.
- `src/proxy.ts` gains `/api/peer/` beside the `/api/artifact/frame/`
  exemption: the `LLV_TOKEN` gate lets it through **because** every peer route
  authorizes itself. Peer routes skip `rejectCrossOrigin` (no browser calls
  them); they require the header whatever `LLV_TOKEN` says, so an install with
  no access key still keeps its peer feeds closed.

### 2.5 Closed to anyone without a token

All of `/api/peer/v1/*` sits behind one guard that runs before routing:

| Request | Answer |
|---|---|
| no header, malformed header, unknown `grantId`, wrong token, revoked grant | `401 {"error":"unauthorized"}`, same body, same headers |
| any unknown path under `/api/peer/` without a valid token | the same `401` |
| valid token, scope not granted | the same `401` |
| valid token, unknown path | `404 {"error":"not found"}` (the caller already proved itself) |
| `POST /pair` whose id names no open code (including when no code is open) | the same `401`; no counter anywhere moves |
| `POST /pair` naming an open code's id with a wrong secret | the same `401`; that code loses one attempt |
| `POST /pair` with the **exact** full code of an expired or used code | `410 {"error":"code-spent"}` |
| `POST /pair` naming a code that had 5 failures in the last minute | `429 {"error":"rate-limited"}`, `Retry-After`, for that code only |
| `POST /pair/probe` whose id names no open code | the same `401` |
| `POST /pair/probe` naming an open code's id | `200 {"vouched":false}`, or `200 {"vouched":true}` after burning that code (below) |

An unknown `grantId` or code id is compared against a dummy hash, so timing
does not tell "no such grant" from "wrong token". The `410` is visible only to
someone who holds the whole code, so it tells a guesser nothing, and it lets
the user see "expired" apart from "wrong" (§8.4). No endpoint answers
anonymously: there is no public "hello", version or install id.

**The pairing probe.** B's own self-check (§3.1) often cannot reach B's
public name, and then it can only say `unverified`. A reaches B from outside
by definition, so A runs the spoof test for it, just before pairing. A sends
`POST /api/peer/v1/pair/probe {"id":"<code id>"}` once per **loopback probe
name**, each over a connection aimed at B's checked address with SNI set to
B's name. The set samples what `isLoopbackHost` vouches for
(`deploymentProxy.ts:206-220`): it drops everything after the last colon
(any text, not only a port) and lowercases before comparing with
`localhost`, `127.0.0.1` and `::1`, so `LOCALHOST:8898`, `LocalHost` and
`localhost:0` are vouched as surely as `localhost`, while a proxy may route
each spelling differently. That is unboundedly many spellings, so the
probes are a representative set, not all of them: `127.0.0.1`,
`localhost`, `[::1]`, the same three with the port of B's public URL
appended (`127.0.0.1:443`), and `LOCALHOST`. A proxy that routes one
unprobed spelling to a trusted entry and none of the probed ones is left
to the other two layers: the trusted entry refusing to vouch for a request
with a forwarding header, and the `default_server` rule that closes unknown
names (§3.1). The set lives in one exported constant beside
`isLoopbackHost`, and a test holds every member to be loopback for that
function, so the probes and the gateway cannot drift apart. B's route answers `vouched: true` when the request carries
`Authorization: Bearer` equal to the gate key: the probe sent none, so only
the gateway can have added it. On `vouched: true`, B burns the code and
records its self-check state as `open-to-internet` (which disables "Allow a
connection", §3.2), and A stops with `peer-open` and sends nothing more. Any
other answer (a `421`, a `404` from another site, a closed connection,
`vouched: false`) means the spoof did not reach B as the operator, and A goes
on to `POST /pair` with B's real `Host`.

The probe carries only the code's public id. The secret stays off it,
because a request with a spoofed `Host` may be routed to another site on B's
box. It
tells its sender nothing a stranger cannot learn without it: anyone can send
`Host: 127.0.0.1` to B's proxy and see whether B's board answers. It costs no
attempt, and naming no open code gets the uniform `401`. The one thing the
id buys is burning a code, and only on a B that is open to the internet,
which is when the code should die.

**Pairing rate limit (in the Viewer process), per code:**

- Failures count only against the code whose id they name. A request that
  names no open code costs nothing and changes nothing, so a stranger cannot
  lock pairing: to spend a code's budget they must first know its id, which
  appears only on B's screen and A's form.
- At most 5 failures per code per minute (`429` for that code), 20 in total,
  after which the code is burned. At 20 guesses against a 50-bit secret the
  chance of a hit is about 2·10⁻¹⁴.
- B's "Allow a connection" panel shows the failed attempts on the open code
  ("2 wrong attempts"), and a burned code says "This code was burned after
  too many wrong attempts; make a new one." Wrong attempts on a code the
  operator is reading aloud are a signal worth seeing.
- There is no global counter. A flood of requests is the reverse proxy's
  concern; the guard costs one hash per request and stores nothing for a
  request that names nothing.

### 2.6 Revoke

- **On B:** remove the grant row. The next request from A gets `401`; A marks
  the link `revoked` and stops pulling. What A already read stays on A.
- **On A:** "Remove" calls `DELETE /api/peer/v1/grant` with its own token (B
  deletes that grant), then removes the link. If B is unreachable, A removes
  the link anyway and says "{B} could not be told; remove this install from its
  list too." B's row keeps showing "last used", so a stale grant is visible.
- **Rows already read from B** on removal: "Remove and keep its history" (the
  host stays on /activity as "no longer linked, read up to …") or "Remove and
  delete its history". Until slice 3 adds the choice, removal keeps the
  history (§13). A kept host keeps a greyed row in Settings with "Continue
  its history" and "Delete its history".
- **Deleting history drops the host whole.** `forgetHost` alone would leave
  the `activity_hosts` row behind (§1): /activity would read the old span as
  covered and empty, which is a silent gap, and a later link under the same
  id would resume from the old cursor and never read B's rows below it
  (`pullHost` starts at `held?.cursor`, `pull.ts:262-289`). Slice 3 adds one
  store method, `dropHost(host)`, which deletes the host's inputs, turns and
  its `activity_hosts` row in one `store.transaction`. The caller removes
  the host's `peers.json` entry first (the order is the next point's), and
  with both gone the id is free again (§2.1). With no row,
  `storeSource` answers `pending` (`hostSources.ts:279`), so the span shows
  as unknown, and a later link under that id reads from 0 (§4.4). The
  recreated-store restart keeps calling `forgetHost`, whose kept row it
  needs.
- **A removal never races a pull of the same host.** `pullHost` keeps its
  cursor in a local variable and writes it back with every page
  (`setHostState` inside each page's `store.transaction`, and again in
  `fail()`, `pull.ts:253-322`), and `setHostState` inserts the row when it is
  missing (`store.ts:526-535`). A `dropHost` that lands between two pages of
  a running pull would therefore see its row recreated by the next page, with
  the pre-drop cursor and only the rows above it: the covered-but-partial
  state deleting was meant to remove, which a later link under the same id
  would resume from. The schedule does not prevent it either:
  `startDuePulls` fixes its list of due hosts when the run starts and pulls
  them one after another (`continuous.ts:68-99`), so a host removed while an
  earlier one is being read is still pulled afterwards. So every write
  `pullHost` makes for a host (the page upserts and cursor, the `fail()`
  record, the recreated-store `forgetHost`) runs in a `store.transaction`
  that first asks whether the host still has a pulling link, through a
  `stillLinked(host)` callback the caller passes (for a link, "its
  `peers.json` entry is active or failing"; for a `hosts.json` entry, "it is
  still listed with `pull`"). When it has none, the pull stops and writes
  nothing. `store.transaction` does not nest (`BEGIN IMMEDIATE` on every
  call, `store.ts:296-306`), so the restart passes the guard to
  `forgetHost` as an argument instead of wrapping a transaction around it. Removal takes the entry out of the
  pulling states in `peers.json` first (deletes it, or marks it kept) and
  calls `dropHost` second, and `store.transaction` is `BEGIN IMMEDIATE`, so
  either a page commits before `dropHost` runs and is deleted by it, or it
  starts after the entry is gone and writes nothing. The same guard covers
  "Remove and keep its history": no page lands after the link is gone. A
  push POST checks, in its own transaction, that its grant still exists.
- **Connecting again** to a B whose host is still on A, removed with its
  history kept or `revoked`, is an explicit operator choice made on **that
  host's own row**: "Connect again" on a revoked row, "Continue its history"
  on a kept one. The row opens the connect form headed "Continue the history
  of {name}", naming the old host, its old address and the time it was read
  up to. When B's pair answer carries the same `storeId` the host holds, the
  new link takes the old host id and cursor and reads on from where the old
  one stopped, so no row is doubled (§4.4); a revoked link is replaced in
  place (new grant id, token and install id; `revoked` cleared). When the
  `storeId` differs, the address is not that install (or its store was
  recreated): nothing is taken over (`continue-mismatch`), and the form
  offers to save the link under a free id (§2.1), leaving the old host as it
  was. The pending link waits as `awaiting-choice`, as below; "Cancel", or no
  answer within 10 minutes, deletes it and the grant just made on B
  (`DELETE /grant`).
- **The generic connect form never takes a host over by itself.** Store and
  install ids are public (§2.7), so a peer can answer `/pair` with another
  host's `storeId`. When the generic form (Settings, onboarding, /activity)
  meets a `storeId` that a removed or revoked host holds, A takes nothing
  over and asks: "This install says it is {name}, last read at {old address}
  up to {time}. Continue {name}, or start fresh under a new id?" Meanwhile
  the new link is stored in `peers.json` as `awaiting-choice` and is never
  pulled; "Cancel", or no answer within 10 minutes, deletes it and B's grant
  (`DELETE /grant`). "Start fresh" saves the link under a **free** id: the
  dialog carries a name field prefilled with the first free `{label}-N`, and
  a taken id, the old host's among them, is refused `name-taken` (§2.1).
  The old host is left inert: it keeps its rows and span and gets no new
  rows, and it gives up its `remoteStore` claim so the per-page same-install
  check (§4.4) does not refuse the new host. Because the new link has its
  own id, it never lands on the old host's `activity_hosts` row, whose
  cursor it would otherwise inherit. The dialog says the cost: "If this is
  the same machine, its earlier activity counts twice until you delete
  {name}'s history."

### 2.7 Threat model (read and push grants)

| Threat | What happens | Mitigation |
|---|---|---|
| Internet caller sends `Host: 127.0.0.1` through B's proxy | if the proxy reaches a trusted local entry, the gateway vouches for it as the operator: full board and spawn | a public address is refused unless it maps to a non-vouching entry, and `needs-remote-entry` is re-evaluated at boot and on every Settings read, so a gateway changed after the save disables links (§3.1); the self-check sends exactly this request in a representative set of the spellings `isLoopbackHost` accepts (it accepts any case mix and any text after the last colon, so no finite set is every spelling), and fails loudly when one is vouched (§3.1); the spellings outside the set rest on the forwarding-header layer below and on the proxy's `default_server` closing unknown names (§3.1); when the self-check cannot reach B's own name, A's pairing probe sends it from outside and burns the code (§2.5); as a second layer the trusted entry stops vouching for a request carrying `Forwarded`, `X-Forwarded-For` or `X-Real-IP` (§3.1) |
| Any caller reaches B while B's access key is off (a LAN proxy, a public proxy, an ssh tunnel on A) | B's gate lets every request through and the Host pin admits `Host: 127.0.0.1`: board and spawn for everyone on that path | the key is checked where it is used (§3.1): no non-loopback address is saved or admitted, no code is minted and no check reports `ok` while it is off; turning phone access off keeps it while links need it |
| Token at rest on B | B holds hashes only | a copy of B's state yields no usable token |
| Token at rest on A | plain text in `<state>/links/peers.json` (0600, dir 0700, like `records.sqlite` and `service.env`) | readable by A's operator uid, root, the Viewer container, and every agent Delegatus runs on A as that uid. A keyring is not used: the Docker install has no Secret Service. Blast radius below. |
| Stolen read token | the thief reads B's activity feed (fields in §5) until revoked | read-only scope; no write, no transcript, no spawn; B shows per grant "last used" and request counts (today, last 7 days), so a second reader shows as a doubled count; revoke on B. B does not show a caller address: behind a same-box proxy every request arrives from `127.0.0.1`, and `X-Forwarded-For` is caller-written (§11). |
| Stolen push token | the thief writes invented rows into A's store under that host | per-grant daily row and byte budget and a total row cap per linked host (§4.6); A shows the stop; revoke on A |
| Stolen push token used to erase | each POST with a fresh `storeId` would make A forget the host and start again from 0, so a thief could wipe A's genuine copy of B over and over | one automatic reset per push grant per 7 days (§4.6); a second is held, erases nothing, and the host row asks A's operator to accept the new history or revoke. The one reset the budget allows replaces the copy with whatever the thief sends, which is the same power the token already gives to write invented rows; the row says when it happened. |
| Transport sniffing | HTTPS: nothing. LAN http: the code, the token and every page are readable on that network | plain HTTP only to loopback and RFC 1918 / link-local addresses (§3.2) with a visible warning; `100.64/10` is not among them; dispatch grants refuse plain HTTP outright (§10.3) |
| Replay | a replayed feed read returns the same or newer rows, which the thief could read with the token anyway; a replayed pair hits a burned code (`410`); a replayed push page is refused by its base check (§4.6) | HTTPS; single-use codes |
| Code guessing | 50-bit secret, 20 attempts per code, 5 per minute | §2.5 |
| Peer lies about its host id | nothing to lie with: A files B's rows under the host id **A** chose at pairing, never one B sends. B's label only prefills the name, and a label equal to a kept host's id would land the new link on that host's row, cursor included | rows can never land under `''` (A's own) or under any id already taken on A, live or not: a new link or push grant gets only a free id, a taken label becomes `{label}-2` (§2.1), and only continuing a host from its row or through the confirmation reuses its id (§2.6); `pullHost` writes only under its `host` argument |
| Peer claims another install's `storeId` or `installId` | both ids are **public**: every holder of a read grant on X sees X's `storeId` and `install` on each `state` line (§4.1, §5.1), so any of them can answer `/pair` with them. Were A to continue a kept or revoked host X on a `storeId` match alone, the impostor would inherit X's host id and cursor and, through the version-greater upsert (`store.ts:461-476`), overwrite X's rows with rows of its own using X's public keys | a matching id is never proof of identity. Continuing a host is operator trust, made explicit: it happens only from that host's own row, or after a confirmation in the generic form naming the old host, its old address and its read span (§2.6). A live host's id is never taken; a claim on one is refused `same-install`. |
| Peer sends forged or hostile data | B could invent activity; that is inside the trust the pairing grants | every row validated by `parseRemoteRow` / `parseRemoteTurn` (whole page or nothing), 64 MB answer cap, 90 s timeout, no redirects followed, the per-host row cap (§4.6) |
| Address now answers as another install | `install` differs from the one recorded at pairing | refused, error `install-changed`, nothing stored. This catches an accident (a reinstall, a re-pointed name); it proves nothing against a peer that copies a public `installId` |
| DNS rebinding of A's check | a name resolves to a private address at check and a public one at connect | A resolves once and connects to the address it checked, sending the name in `Host` / SNI |
| A is itself compromised | the attacker gets A's links (read tokens) | a link's reach is the scopes B granted; read scopes are read-only |

## 3. Reachability without a server of ours

### 3.1 Primary: B has a public HTTPS domain

B runs behind a reverse proxy (Caddy, nginx, Traefik) that terminates TLS for
`https://delegatus.example.com` and forwards to a port on the same box.

**The one rule for the proxy (and any tunnel):** it forwards to the
**public entry**, a port that never vouches:

| B's shape | Public entry |
|---|---|
| Docker install with a gateway remote entry (`viewer-entries.json` `remoteEntryPort`) | the remote entry, `127.0.0.1:8897` in `docs/docker.md` |
| Docker install, stable port is a plain pipe or an authenticated local entry | the stable port, 8898 |
| Docker install, stable port is a **trusted** local entry and no remote entry | **none**: a public address cannot be saved (`needs-remote-entry`) |
| CLI install (`bin/cli.mjs`, no runtime host) | the Viewer's own port |

This is `dockerTailnetEntry`'s rule (`phoneAccess.ts:137-154`), read the same
way (`readViewerEntries`, `readViewerGatewayConfig`, re-read per request
because trust changes without a restart). Slice 1 lifts it into one shared
function, `publicEntry()`, that phone access and links both call. The proxy
must also keep the `Host` header (so B's Host pin sees the public name), and
nginx should have a `default_server` that closes unknown names (`return
444;`) so a spoofed `Host` never reaches Delegatus at all. The Settings
screen shows the target: "Point your proxy at 127.0.0.1:8897 and keep the
Host header."

**This install's public address** (Settings → Linked installs → "This
install"):

- **Where it comes from.** Delegatus cannot learn it reliably by itself behind
  a proxy, so the operator states it, with two suggestions:
  - when the Settings page itself was opened at a non-loopback origin, the page
    offers that origin ("This page was opened at https://delegatus.example.com —
    use it?"). The browser's own address bar is the most truthful source;
  - when phone access is on, `LLV_TS_URL` is offered as the Tailscale address.
  `X-Forwarded-Host` is caller-written and is never used.
- **Where it lives.** `<state>/links/self.json`: `{ v: 1, installId, label,
  publicUrl, check }`, written atomically at 0600 like
  `recordViewerEntries` (`src/runtime-host/viewerEntries.ts`). On save, and at
  boot, the Viewer puts its host into its own environment as `LLV_PUBLIC_HOST`
  (the `phoneAccess.ts` pattern), and `allowedHostNames()` adds it beside
  `LLV_TS_HOST` **only while `LLV_TOKEN` is set**, read per request like
  every other part of the gate (`phoneAccess.ts:24-25`), so the operator can
  use B's UI at its domain.
- **The access key, checked where it is used.** Any address other than
  loopback, private LAN addresses included, means someone other than this
  machine's own processes can reach the Viewer, and fact 4 (§1) says the pin
  alone keeps nobody out. So `LLV_TOKEN` is read afresh at each of these
  points:
  - **saving** any non-loopback address (public or private) is refused with
    `needs-access-key` while the key is off;
  - **the Host pin** admits `LLV_PUBLIC_HOST` only while the key is on, per
    request. A saved address is not admitted while the key is missing, for
    whatever reason; the boot rule below puts the key back at every start, so
    this is the net for a key lost at run time;
  - **"Check this address"** reports `needs-access-key` without probing while
    the key is off, and never `ok`;
  - **minting a code** (every scope) is refused with `needs-access-key` while
    the key is off, and "Allow a connection" is disabled with that reason. A
    code means another machine is about to reach this one, by whatever path,
    including an ssh tunnel this install cannot see, so the key is a
    precondition of every link, whatever address it uses;
  - **turning phone access off** keeps the key while a non-loopback address
    is saved or any grant exists: `disablePhoneAccess` already keeps it for a
    non-loopback bind and on Docker (`phoneAccess.ts:394-398`), and gains this
    third reason;
  - **at boot**, a saved non-loopback address or any grant is a remembered
    choice that gates the process, exactly as the phone-access flag does
    (#2024): beside `restorePhoneAccessGate` in
    `src/lib/viewerInstrumentation.ts:812-814`, before the first request, a
    key the environment set is kept, otherwise the key file is read or
    minted (`getToken()`), and a key that cannot be put in place stops the
    Viewer (the `PhoneGateRefusal` rule), because the proxy or tunnel in
    front of it may be live. A CLI install started on loopback, whose
    launcher sets no key (`bin/cli.mjs:878-881` covers only a non-loopback
    bind), would otherwise come back from a restart open to that proxy.
    Whoever authenticates against a release it did not start (the runtime
    host's trusted local entry, the deploy adapter's health probes) finds
    that key through `viewerBootGateKey` (`src/lib/access/phoneAccessBootGate.ts:45-57`,
    used by `viewerReleaseCredentialResolver`, `deploymentProxy.ts:176-201`),
    which today reads the key file only while the phone-access flag exists.
    It gains the second condition, read from the same root: a saved
    non-loopback address in `links/self.json` or a grant in
    `links/grants.json` under the state directory the environment names.
    Without that, a Docker release gated by the links rule would lock the
    trusted local entry and the MCP clients behind it out.

  The Settings section shows the `needs-access-key` state as a red line with
  a "Turn on the access key" button, which puts the same key phone access
  uses in place (`getToken()`, as `enablePhoneAccess` does at
  `phoneAccess.ts:283-298`; on Docker the key `service.env` set is kept).
- **Other refusals when saving:**
  - a public address while `publicEntry()` is none (`needs-remote-entry`);
  - an `http://` address that is not loopback or private (`http-public`, §3.2).
- **`needs-remote-entry` is a standing state, not a save-time check.** The
  gateway file changes without the address being saved again: an operator
  who sets `localEntry: "trusted"` or drops `remoteEntryPort` after saving
  leaves a public address in front of a port that vouches. So the state is
  evaluated from the saved address and `publicEntry()` (re-read from the
  gateway and entries files each time) at boot, on every `GET /api/links`
  (each Settings read), before each code is minted and in every "Check".
  While it holds, Settings shows it as a red line with the fix, "Allow a
  connection" is disabled, minting is refused and the check reports it
  without probing. The Host pin is left alone: a spoofed request carries a
  loopback `Host`, which admitting or refusing the public name does not
  touch.
- **The trusted entry stops vouching for a proxied request.** A request a
  reverse proxy relays usually carries a header naming the client:
  `Forwarded`, `X-Forwarded-For` or `X-Real-IP`, which Caddy's and Traefik's
  proxies add by default and nginx adds when configured to. A local MCP
  client or CLI talking to 8898 sends none of them. Slice 1 makes
  `vouchedCredential` (`deploymentProxy.ts:274-287`) return `null` when a
  loopback-`Host` request carries any of the three; such a request then
  meets the Viewer's gate like any stranger. This is a second layer and is
  never counted as the proof: a proxy that adds none of them is still
  vouched for, which is what the spoof probes detect. The cost is a local
  tool that sends one of these headers to 8898 on purpose; it now has to
  present the key.
- **"Check this address"** runs a reach probe and seven spoof probes from B
  to its own public URL, each with a fresh one-time nonce in
  `X-Delegatus-Self`, all over `node:https`
  with the connection and SNI aimed at the public name:
  1. **Reach:** `POST {publicUrl}/api/peer/v1/self-check` with the public
     `Host`. The route answers a valid nonce with `200 {"host":"<Host it
     saw>","vouched":<bool>}`, where `vouched` is true when the request
     carries an `Authorization: Bearer` equal to the gate key. The probe sends
     no `Authorization`, so a credential on it can only have been added by the
     gateway.
  2. **Spoof:** the same request once per loopback probe name, the seven
     spellings of §2.5 (every one is loopback to `isLoopbackHost`, which
     ignores case and whatever follows the last colon, and a proxy may route
     each differently; the set is representative, §2.5). Each
     passes when the proxy refuses it (`421`, `444`, `404` from another
     site, a closed connection) or when it arrives with `vouched: false`.
     One arriving with `vouched: true` fails the check.

  Outcomes shown:
  - "Turn on the access key first" (`needs-access-key`): the key is off, so
    nothing is probed; every port a stranger can reach is open (§1, fact 4);
  - "Reachable at this address" (and the date checked): the key is on, probe
    1 answered with the public host and `vouched: false`, and all seven spoof
    probes passed;
  - **"Anyone on the internet can use this board as you"** (`open-to-internet`,
    red): a spoof probe arrived vouched, or probe 1 did. "Allow a
    connection" is disabled, and the message names the fix: point the proxy at
    the public entry port above, or stop trusting the local entry;
  - "Your proxy replaces the address it was called at" (`host-rewritten`):
    probe 1 arrived with a loopback `Host`. B's Host pin would then admit it
    only as a local request, and on a trusted entry that is the same open
    board; treated as `open-to-internet` when it also arrived vouched;
  - "The certificate is not valid" (TLS failure);
  - "This server could not reach its own address, so the proxy could not be
    checked here" (`unverified`): a server often cannot reach its own public
    name (hairpin NAT). This warns, shows the proxy rule with the port, and
    does not block minting, because the other install runs the same spoof
    test from outside before it pairs (the pairing probe, §2.5). A vouched
    probe there burns the code and turns this state into `open-to-internet`.

  The check runs on save, on "Check", and again before each code is minted, so
  a proxy changed after saving is caught at the next pairing. To anyone
  without the nonce the self-check route answers the §2.5 `401`.

**Install id.** `installId` (a UUID) and a label (the machine's hostname,
editable) are minted into `self.json` on first use. They name the install to
its peers; they are not the activity host id (A chooses that).

### 3.2 URL policy, enforced on the caller (A)

The token's secrecy is decided by whoever sends it, so A checks before any
request, and again after DNS resolution:

| Target | `https://` | `http://` |
|---|---|---|
| loopback (`127.0.0.0/8`, `::1`) | allowed | allowed (ssh tunnel, same box) |
| private: `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10` | allowed | allowed with the warning "anyone on this network can read what is sent" |
| anything else, including `100.64/10` | allowed, certificate verified against the system CAs | **refused**, error `http-public`, nothing sent |

- `100.64/10` is Tailscale's range **and** ISP carrier-grade NAT, and A cannot
  tell them apart from the address; plain http there may cross an ISP. A
  tailnet peer is linked by its `https://<machine>.<tailnet>.ts.net` name,
  which phone access already publishes with a valid certificate.
- A name counts as private only if **every** address it resolves to is
  private; A then connects to the resolved address.
- Redirects are never followed; a `3xx` is the error `not-delegatus`. An
  HTTPS peer therefore cannot bounce A to plain HTTP or to another host.
- There is no "ignore certificate errors" switch. A self-signed LAN box uses
  `http://` on its private address, or Tailscale; certificate pinning is
  deferred (§11).
- B adds rules of its own: "Allow a connection" is disabled while B's access
  key is off (`needs-access-key`, §3.1), its saved public address is plain
  `http://` on a public host, or its last check was `open-to-internet`.

### 3.3 Secondary transports

| Transport | How | Work needed |
|---|---|---|
| Tailscale | phone access already publishes B at `https://<machine>.<tailnet>.ts.net` through the remote entry, gated by `LLV_TOKEN`, with a valid certificate. For the link it is the public-HTTPS case exactly. | none beyond §3.1; "use the Tailscale address" is one suggestion |
| LAN | **Precondition: B's access key is on.** Without it, anyone on the network who reaches the proxy writes `Host: 127.0.0.1` and gets the board (§1, fact 4), so B refuses to save the LAN address and to mint a code (§3.1). On the Docker install the runtime host binds 8898 and the Viewer binds to `127.0.0.1`, so a LAN link needs a proxy on B that listens on the LAN address and targets the public entry (§3.1). A CLI install can instead bind `delegatus --hostname 0.0.0.0` (`bin/cli.mjs`), which has no trusted entry and whose launcher sets the key for any non-loopback bind (`bin/cli.mjs:878-881`). B saves `http://192.168.x.y:port` as its address; A links the same. | warning shown; the proxy rule is shown in Settings |
| ssh tunnel | **Precondition: B's access key is on.** A tunnel ends on A, so every process and account on A reaches B through it; with B's key off they are all B's operator. B cannot see a tunnel, which is why minting any code needs the key (§3.1). `ssh -L 18897:127.0.0.1:<public entry port> b` (8897 on a Docker install with a remote entry); A links `http://127.0.0.1:18897`. **Never** a tunnel to a trusted 8898: the gateway would vouch for every one of those processes even with the key on. The Settings screen shows the tunnel line with the right port. The user keeps the tunnel alive. | none |
| ssh pull | `pull.ts`, kept. The connect form's "Connect over ssh instead" writes an ssh link (an alias from the operator's ssh config) so no file is edited. `activity/hosts.json` `pull` entries keep working and show in the list as "set in hosts.json". Slice 3 hardens the ssh options (§6). | form option; links store reads both |
| push (B → A) | when B cannot be reached from A (a laptop behind NAT, A a public server), B sends its pages to A (§4.6) | slice 4 |

### 3.4 What the user sees when a peer is unreachable

The hosts table and the link row say, in words: "Could not reach {name} since
{time}. What was read before then is kept; the time after it shows as
unknown." The span after the last good read stays hatched "Unknown" on
/activity (existing `storeSource` behaviour), so a gap is never silent.
Retries follow the normal interval; "Read now" retries at once.

## 4. Sync protocol for activity

### 4.1 Pull endpoint (on B)

```
GET /api/peer/v1/activity?after=<version>&limit=<n>&types=input,turn
X-Delegatus-Peer: <grantId>.<token>
Accept: application/x-ndjson
```

`after` is clamped to `≥ 0`, `limit` to `1..5000` (the ssh page is 5000,
`PULL_PAGE_ROWS`). `types` names the row kinds A reads (§4.5); B drops kinds
it does not serve and answers only the rest. `200 application/x-ndjson`,
`Cache-Control: no-store`. The body is the ssh reader's format, so
`parseState`, `parseRemoteRow` and `parseRemoteTurn` in `pull.ts` read both
transports:

```
{"type":"state","v":1,"state":"read","install":"<installId>","now":1790300000000,
 "types":["input","turn"],"coveredFrom":…,"coveredUntil":…,"readAt":…,"excluded":{…},
 "latest":81234,"storeId":"<uuid>","more":true}
{"type":"input","key":"m:<64 hex>","version":81001,"at":…,"project":"repo-<32 hex>",
 "kind":"message","surface":"phone","hash":"<64 hex>","conversation":"<32 hex>","ids":["m:<64 hex>"]}
{"type":"turn","key":"t:<64 hex>","version":81002,"conversation":"<32 hex>","project":…,
 "engine":"codex","role":"architect","pipelineId":…,"stageId":…,"start":…,"end":…}
```

The handler reads in one read transaction with `localRowsAfter` and
`localTurnsAfter` for the requested kinds (limit + 1 each, merged by version,
cut to `limit`: the smallest `limit` versions of the union always lie inside
the first `limit + 1` of each table, as `REMOTE_READER` already does) and
`hostState('')`. A B with no activity store answers
`{"type":"state","v":1,"state":"no-ingest"}`.

Errors: the §2.5 `401`; `429` with `Retry-After` when B is busy (§4.5); `503`
when the store cannot be read.

### 4.2 Why the cursor never skips or doubles

- **Cursor = B's version.** Every write of a row, new or merged, takes the next
  value of the one counter inside `BEGIN IMMEDIATE` (`store.transaction`,
  `nextVersion`). SQLite admits one writer at a time, so a version is visible
  only after every lower one has committed: a reader that saw version N can
  never later meet a newly committed row below N. No gap. Filtering by kind
  keeps this: every row of a served kind above the cursor is still returned in
  version order.
- **A merged row reappears** with a new version, and A replaces its copy
  (`upsertPulled` updates only when the incoming version is higher). No
  duplicate, and a replayed or overlapping page changes nothing.
- **B never deletes its own rows** (`forgetHost` refuses host `''`). If a later
  retention rule deletes local rows, it ships a `gone` kind first; §4.5 makes
  sure an A that learns it reads every tombstone.
- **Resumable.** A stores the cursor with the rows of each page in one
  transaction (`pullHost`), so a pull cut at any point resumes after the last
  committed page. The read span moves only with the last page (`more:false`).
- **No transitive rows.** The feed serves host `''` only. If B pulls C, A does
  not receive C through B; A links C directly. That keeps one path per host
  and no laundering of a third install's data through a peer.

### 4.3 Clock skew

- The cursor and ordering use versions only, so skew cannot break
  correctness.
- Row times (`at`, `start`, `end`) are B's statement and are stored unchanged.
- The `state` line carries B's `now`. A computes the offset against the
  midpoint of its own request and stores it on the link. The link row shows
  "Its clock is 7 min ahead" when the offset exceeds 2 minutes, because
  activity on /activity lands shifted by that much.
- The "caught up" test (`storeSource`: `now − coveredUntil ≤ threshold`) uses
  `coveredUntil` corrected by the offset, so a fast or slow clock does not show
  a healthy peer as behind (or a stalled one as current).

### 4.4 A recreated store, a reinstalled peer, the same install twice

- **Store recreated** (`storeId` changed or `latest < cursor`): the existing
  rule, `forgetHost` and one full read (`pull.ts`).
- **Different install** (`install` ≠ the id recorded at pairing): refused
  (`install-changed`). A reinstall loses the grants file with the state, so
  the user pairs again anyway.
- **Same install under two host ids** (an HTTPS link and an ssh link to the same
  B, added in either order, would double every row and every hour on
  /activity). The store id is the one identity every transport returns (the
  ssh reader already sends it). The store gains one lookup,
  `hostWithRemoteStore(storeId)`, and the rule has two places:
  - **When a link is made**, A knows B's `storeId` before saving anything:
    the HTTPS pair answer carries it, and the ssh form reads the reader's
    `state` line first (one page, `LLV_ACTIVITY_LIMIT=1`; the reader clamps
    to `1..20000`, `pull.ts:55`). The id the link would be saved under is
    settled by the uniqueness rule (§2.1), never by the store id: a name
    typed in the form must be free, or A answers `name-taken` before it
    sends anything to B; a name left to B's label takes that label when it
    is free and the first free `{label}-N` otherwise, and the link row says
    so ("saved as laptop-2; laptop is taken here"). Then:

    | `hostWithRemoteStore(storeId)` finds | A does |
    |---|---|
    | nothing | saves the link under that free id |
    | A's own `activity_meta.store_id` | refuses, `same-install` "This is this install" |
    | a host with a **live** link: an active or failing link, a push grant, or a `hosts.json` `pull` entry | refuses, `same-install` "already linked as {name}" |
    | a host whose link was removed with its history kept, or whose link is `revoked`, and the pairing started from **that host's row** ("Connect again", "Continue its history") | **takes that host over**, the choice the operator already made on the row: the new link gets the old host id, and the host's `cursor`, `remoteStore` and kinds stay as they are, so the first pull reads on from the old cursor. A revoked link is replaced in place (§2.6). |
    | the same, but the pairing started from the **generic** form | takes nothing over, stores the link as `awaiting-choice` and asks (§2.6): "Continue {name}" takes over as in the row above; "Start fresh under a new id" saves under a free id (never the old host's) and leaves the old host inert, its `remoteStore` released |
    | nothing, because that host's history was **deleted** | there is no `activity_hosts` row left to match (`dropHost`, §2.6), and deleting also removed the host's kept `peers.json` entry, so its id is free again: this is the first row, and a link saved under an id that had been used before starts from cursor 0 and reads B whole |

    A takeover writes no row and resets nothing: the rows already under that
    host id are B's rows, and the cursor is B's version, which the same store
    id says is still valid. If B's store changed meanwhile, the id would not
    match and there is no takeover; if B's store rolled back under the same
    id, the existing `latest < cursor` rule re-reads it whole. The store id
    is only evidence that the operator's choice was a sensible one; it is
    public (§2.7), so it never decides a takeover on its own.
  - **On every page**, inside `pullHost` and before anything is written, for
    every transport: when the page's `storeId` equals a different host's
    `remoteStore`, the page is refused with `same-install` and nothing is
    stored; when it equals A's own store id, the same error says "This is
    this install". This is the net for what bypasses the form: a
    `hosts.json` entry written by hand, or B's store copied to another box.
    For a hand-written entry whose twin is only kept history, the message
    names the fix ("use Continue its history on {name}'s row in Settings, which
    can connect over ssh, or delete that history"). An inert host (its
    `remoteStore` released by "Start fresh") is no twin, and a deleted one
    has no row to compare.
  - **A hand-written id cannot land on a non-live host either.** A
    `hosts.json` `pull` entry written under the id of a kept, inert,
    `revoked` or `awaiting-choice` host would otherwise pull into that host's
    row: from its old cursor when its `remoteStore` is released, or, when the
    entry reaches a different store, through the recreated-store
    `forgetHost`, which erases the history the operator chose to keep. An id present in both files is the link
    whatever its state (§9), so such an entry is never pulled, and Settings
    lists it as "set in hosts.json · {id} is taken by {name}'s kept history".

### 4.5 Versions, row kinds and backpressure

- **Path version** `/api/peer/v1/`: a breaking change is `/v2/`, and B serves
  both while any supported version reads v1.
- **Line version** `state.v`: fields are only added within `v: 1`; A ignores
  unknown fields and refuses an unknown `v` with the error `version` ("{name}
  runs a Delegatus this one cannot read; update the older one").
- **Row kinds are negotiated, never skipped.** A cursor must cover only rows A
  understood, or rows of a kind added later would sit below the cursor forever
  once A upgrades. So:
  - A sends the kinds it reads in `types`; B serves only those it knows and
    echoes the served set in `state.types`;
  - A stores the served set beside the cursor (`activity_hosts`, one new
    column). When a page's `state.types` differs from the stored set (A
    upgraded and asks for more, or B upgraded and now serves a kind A already
    asked for), A reads that host from `after=0` once more, **without**
    `forgetHost`: the keyed upsert leaves known rows unchanged and adds the
    rows of the new kind written before either side learned it. A writes the
    new set and cursor 0 in one transaction, so a re-read cut short resumes
    instead of being forgotten; push follows the same rule (§4.6);
  - a row whose `type` is outside the requested set is B misbehaving and fails
    the page (`malformed`), as `pull.ts:300-306` does today.
  A full re-read is the whole history, about 15 MB (`activity-dashboard.md`),
  and happens once per upgrade that adds a kind. The ssh reader is A's own
  code, so its kinds are always A's; nothing changes there.
- **A pre-link Delegatus** answers `403 access denied: key required` (its gate
  has no exemption) or `404` at pairing; A reports `not-delegatus`: "That
  address answers, but not as a Delegatus that can link. Update it."
- **Backpressure on B:** at most one feed read per grant and four in total at
  a time; beyond that `429` with `Retry-After: 30`. Each read is an indexed
  range scan on `(host, version)`.
- **Backpressure on A:** pages are read one at a time, at most 40 pages per run
  (`PULL_MAX_PAGES`), a 64 MB answer cap and a 90 s timeout, exactly as the ssh
  pull; the rest continues on the next interval. `Retry-After` is obeyed.
- **Schedule:** HTTP links join `startDuePulls` (`continuous.ts`) beside ssh
  hosts, default every 5 minutes; "Read now" starts one out of turn.

### 4.6 Push (B sends to A, slice 4)

For B that A cannot reach. Paired the same way with the direction reversed: A
mints the code with "It will send its activity here" and names the host;
B connects with A's address and the code, and the pair answer tells B this
grant is `activity:push`, with the kinds A reads. The code's host is a free
id (§2.1; minting refuses a taken one with `name-taken`), unless A's
operator minted it from a kept host's row ("Continue its history"); a pushed `storeId` that a kept host holds is otherwise met with
the same confirmation as in the connect form (§2.6), shown on A.

```
GET  /api/peer/v1/push/activity   → {"v":1,"host":"laptop","cursor":81234,"storeId":"<uuid>"|null,
                                      "types":["input","turn"]}
POST /api/peer/v1/push/activity?after=81234&storeId=<uuid>
                                    body: one pull page (state line + rows, NDJSON, ≤ 16 MB);
                                    the state line carries "requested" (A's kinds as B last
                                    learned them) and "types" (the kinds B served)
     → 200 {"v":1,"cursor":83000,"changed":1766,"types":<A's kinds>}
     → 409 {"v":1,"cursor":<A's cursor>,"storeId":<A's held id or null>,"types":<A's kinds>}
                                    nothing stored
```

- **Every POST names its base.** `after` is the cursor B read from A and
  `storeId` is B's store. In one store transaction (`BEGIN IMMEDIATE`, so two
  A Viewer generations serialize too) A compares: the page is applied only
  when `storeId` equals the held one (or none is held and `after` is 0),
  `after` equals A's cursor, the page's `latest ≥ after`, and every row is
  above `after`. Then A upserts, moves the cursor to the page's last version
  and answers it. Otherwise A answers `409` with its cursor and stores nothing,
  and B re-reads its rows after that cursor. That closes both gaps a bare page
  would leave: a page from a stale base after A reset the host, and two B
  generations pushing from different cursors during a Viewer succession (the
  first wins, the second gets `409` and resumes from the new cursor).
- **A reset POST stores nothing.** A `storeId` different from the held one (or
  `latest` below A's cursor with the same id) makes A forget the host, record
  the new `storeId` with cursor 0, and answer `409 {cursor:0, storeId:<new>}`.
  The rows in that POST are never applied; B's next POST from `after=0` is.
- **Resets are budgeted per grant.** A store is recreated rarely (its file
  deleted, a restore from backup), so one automatic reset per push grant per
  7 days covers every honest case. A second reset inside the window is
  **held**: A forgets nothing, keeps the old `storeId` and cursor, answers
  `409 {"v":1,"error":"reset-held","cursor":<held>,"storeId":<held>}`, and
  the host row on A says "{name} started a new history again; receiving
  paused until you accept it", with "Accept the new history" (one reset
  then runs) and "Revoke". B shows the same state on its "Sends to" row and
  pauses pushing. Without the budget, a stolen push token could erase A's
  copy of B with every POST (§2.7). The row also records the last reset:
  "History restarted on {date}".
- **Row kinds are negotiated for push as for pulls (§4.5).** A pull states
  A's kinds on every request, so a pulled B always serves against A's
  current set. A push has no request from A to carry them: B learns A's
  kinds from `GET` and would keep pushing against that copy until it next
  reads it, so an A that upgrades between two `GET`s would see nothing
  change. Each page therefore names both sides of the negotiation: its
  `state.requested` is the set B believes A reads, and its `state.types` is
  the set B served. In the POST's transaction, before the base check, A
  compares:
  1. `state.requested` differs from the kinds A reads now (A upgraded, or
     downgraded): B's copy is stale. A applies none of the POST and answers
     `409` with its unchanged cursor and held `storeId` and its current
     `types`. B takes the new set (every `200` and `409` carries it, so B
     needs no second `GET`) and sends the page again, served against it.
  2. `state.types` differs from the set A stored for that host (in the same
     `activity_hosts` column the pull uses): the kinds actually received
     change, because A now reads a kind B serves, or B started serving a
     kind A already asked for. Rows of the new kind written before that
     moment lie below A's cursor, and a push that continued from the cursor
     would never send them. So A applies none of that POST, **does not**
     call `forgetHost`, records the new set, sets the host's cursor to 0 and
     answers `409 {"v":1,"cursor":0,"storeId":<held>,"types":<A's kinds>}`.
     B re-reads from `after=0`; the base check now admits `after=0` because
     it equals A's cursor, and the version-greater upsert leaves every known
     row unchanged while it adds the rows of the new kind. The held
     `storeId` is unchanged, so this is not a reset and does not count
     against the reset budget.
  Step 1 alone never rewinds: when A upgrades to `turn` and B does not know
  `turn`, the resent page names `requested: [input, turn]` and `types:
  [input]`, which matches what A stored, and the push goes on from the
  cursor. A downgrade shrinks the served set and rewinds once, which
  re-sends known rows and changes none. The re-read costs one full history
  (about 30 000 rows, 15 MB) against the daily budget below. A first
  backfill and a kind change on the same day come to about 60 000 rows,
  above the default 50 000, so the push pauses with `quota` until the next
  day and the host row says so; the span after the last page shows as
  unknown until then, as for any paused push. It is visible and it
  resumes, so the budget is not relaxed for rewinds, which a stolen push
  token could otherwise trigger at will by flipping `types`.
- **The same-install check** (§4.4) applies to the pushed `storeId`.
- Rows go under the host id bound to the grant on A, never a name B sends.
- **Volume bounds.** A push grant has a budget per day (default 50 000 rows
  and 32 MB of page bodies) and every linked host a total row cap (default
  500 000 rows). A full history is about 30 000 rows in about 15 MB
  (`activity-dashboard.md`, backfill measurement), so a first backfill fits
  in a day and the cap is about 15 full histories. Beyond either, A answers
  `429 {"error":"quota"}` with `Retry-After` until the budget resets, stores
  nothing, and the host row says "{name} sent more than its daily allowance;
  receiving paused until {time}" (or "reached its size limit"). The total cap
  also bounds pulled hosts, since the same store call writes both.
- B pushes on its own interval; A answers `429` when busy, and B obeys
  `Retry-After`.
- On A the host row reads "Sends here · last received {time}". When B has not
  sent for longer than its interval plus 10 minutes, the span after the last
  page shows as unknown, as with a failed pull.

## 5. What leaves a host, and to whom

### 5.1 The activity feed carries exactly these fields

Per input row (`activity_inputs`):

| Field | Content | Can it reveal text? |
|---|---|---|
| `key`, `ids` | `m:` + sha256 of an engine message id, prompt id or delivery key (`messageId`, `humanInput.ts`); `r:` a request-ledger key; `h:` / `k:` + sha256 over the host or conversation, the **text hash** and the time (`fallbackId`, `humanInput.ts:88`; `contentKey`, `store.ts:191`) | `m:` and `r:` no; `h:` / `k:` no more than `hash` below, since they are derived from it |
| `version` | B's write counter | no |
| `at` | when the input was sent (ms) | no |
| `project` | the project key: `repo-<32 hex>` (hash of the canonical remote), `dir-<32 hex>` (hash of the resolved directory path), an operator alias slug, or `project_unresolved` (`src/lib/projects/identity.ts`) | an alias slug is a name the operator chose; the hashed keys reveal only a path or remote someone already guesses exactly |
| `kind` | `message, dialog, answer, spawn, voice, decision, pipeline, task` | no |
| `surface` | `desktop, tablet, phone, other, terminal, unknown` | no |
| `hash` | sha256 of the normalized message text under a fixed domain string (`canonicalTextHash`) | **a holder can confirm a guessed short text** ("ok", "continue", "так"), because the domain string is public. Long texts are not recoverable. |
| `conversation` | 32 hex of sha256 over the registry conversation id or the transcript path (`conversationDigest`) | no (a guessed exact path can be confirmed) |

Per agent turn (`activity_turns`): `key`, `version`, `conversation` digest,
`project` key, `engine` (`claude`/`codex`), `role` id, `pipelineId`,
`stageId`, `start`, `end`.

Per page: B's read span (`coveredFrom`, `coveredUntil`, `readAt`), exclusion
counts by reason, `latest`, `storeId`, `install`, the served `types`, B's
clock `now`.

**Never:** message text, titles, file paths, cwd, account names or emails,
tokens, transcript content, project display names.

Pairing adds B's label (hostname by default, editable), `installId`,
`storeId`, Delegatus version and feed list, and A's label, `installId` and
version to B. The grant row on B records when it was last used and how many
requests it made.

### 5.2 No third party

Peer requests go directly from A's Viewer to the address the user typed.
There is no relay, rendezvous, telemetry or lookup service; nothing reaches
any server run by the Delegatus project. The reverse proxy (or Tailscale)
in front of B is the user's own. The Telegram connector is not a transport
for links (§11).

### 5.3 Where the copy lives on A

In A's `records.sqlite` under A's host id for B (0600, dir 0700). Who can read
it there: A's operator uid and root; the Viewer container (it shares the
operator's home); every agent Delegatus runs on A, since agents run as the
operator's uid; the spawn sandbox (`withAgentConfigSandbox`) moves only
`XDG_CONFIG_HOME`, and the file stays readable by its path. Through the UI, the
aggregate report at `/api/activity` (times, durations, project keys and
names, role and stage ids; no text) goes to whoever passes A's gate: anyone
once `LLV_TOKEN` is off, including other local accounts on a shared box.
There is no retention limit today; rows stay until the link is removed with
"delete its history" (which drops the host's rows and its read state
together, §2.6), bounded by the per-host cap (§4.6).

## 6. Answer: can the current ssh pull leak data?

The operator's question, about `pull.ts` as it stands on `main`.

**What travels from A to B** over the ssh connection: the reader script
(`REMOTE_READER`, code only, no data) on stdin, and a command line of
`env LLV_ACTIVITY_AFTER=<number> LLV_ACTIVITY_LIMIT=<number>
[LLV_ACTIVITY_STATE_DIR=<path>] bun run -`. That command line is visible to
other accounts on B through the process list for the second the reader runs;
it holds two numbers and, only if configured, B's state directory path. A's
ssh key identity and A's IP reach B's sshd and its logs, as with any ssh
login. Nothing from A's own activity is sent.

**What travels from B to A:** the fields of §5.1, encrypted by ssh end to end.
With a `ProxyJump` in the operator's ssh config, the jump host relays only
ciphertext. stderr is discarded.

**What runs on B:** the reader, as the operator's ssh user, with the Bun
named by the host's `pull.bun` in `activity/hosts.json` when one is set
(`config.bun`, quoted into the command, `pull.ts:132`), otherwise
`$HOME/.bun/bin/bun`, otherwise the `bun` on that user's PATH
(`pull.ts:133`). It opens only `activity/records.sqlite`, read-only, and
writes nothing. Anyone who controls that user's home or PATH on B (or the
file at a configured `pull.bun` path) controls that binary, but they already
control B's data. A `pull.bun` path also appears on B's process list with
the numbers above.

**Wrong host:** `sshTransport` (`pull.ts:129-141`) passes `-o BatchMode=yes`,
`ConnectTimeout`, `ServerAliveInterval` and `ServerAliveCountMax`, and nothing
else; everything else comes from the operator's ssh config. `BatchMode` never
prompts, so an unknown or changed host key fails the connection
(`unreachable`) **only while** `StrictHostKeyChecking` is `ask` or `yes`. If
the operator's config sets it to `accept-new` for that alias, a first
connection to an impostor is trusted and the reader runs there; with `no`, a
changed key is accepted too.

**Agent forwarding:** if the operator's config sets `ForwardAgent yes` for that
alias (or `Host *`), A's ssh agent is reachable from B for the length of every
pull, so root on B can use A's keys while the reader runs. The pull needs no
forwarding.

**Where it is stored and who can read it:** §5.3, the same file and readers as
any HTTP link.

**Third parties:** none. The only network path is the operator's own ssh to
the alias.

**Residual exposure, stated plainly:**

1. Short messages can be confirmed from `hash` (and the `h:`/`k:` keys
   derived from it) by anyone holding the rows (§5.1).
2. Every agent on A can read B's rows, because they run as the same uid.
3. Other local accounts on B see the pull's command line (numbers, maybe a
   path) while it runs.
4. With `LLV_TOKEN` off on A, other local accounts on A can read the
   aggregate report over loopback.
5. An ssh config with `StrictHostKeyChecking accept-new`/`no` or
   `ForwardAgent yes` for the alias weakens the pull as described above.

None of these sends message text, paths or credentials anywhere, and none
involves a third party. Items 1 and 2 hold equally for HTTP links. Slice 3
closes item 5 by adding `-o StrictHostKeyChecking=yes -o ForwardAgent=no
-o ClearAllForwardings=yes` to `sshTransport` (ssh takes the first value it
obtains, so command-line options beat the config file). The cost: an alias
whose host key was never recorded fails until the operator connects once from
a terminal, and the ssh form says so.

## 7. Extension path for other metadata

The protocol generalizes by feed name, scope and envelope, without a redesign:

- **One URL shape:** `GET /api/peer/v1/<feed>`, the same header, the same
  §2.5 guard, the same `state` line (`v`, `install`, `now`, `storeId`,
  `more`).
- **Two feed kinds:**
  - **log feeds** (large, append-mostly: activity, later conversation
    summaries): `?after=<version>&limit=&types=`, rows with `type`, `key`,
    `version`; A upserts by `(host, key)` and negotiates kinds as in §4.5.
    Anything whose source can delete rows emits `{"type":"gone","key",
    "version"}` tombstones, and an A that learns `gone` re-reads from 0 and so
    receives every earlier tombstone.
  - **snapshot feeds** (small, current state: projects, board, agent
    liveness, capacity): the whole list with an `ETag`; `If-None-Match` → `304`.
    A replaces its copy for that host. No cursor to go wrong.
- **Scopes per feed** on the grant: `activity:read` (this design),
  `projects:read`, `board:read`, `liveness:read`, then `dispatch` (§10), each
  ticked by B's operator when minting the code. `GET /api/peer/v1/info`
  (authenticated) answers `{ v, install, version, feeds: {activity: 1, …},
  scopes }` so A shows only what B offers and was granted.
- **A new feed must declare its fields** here the way §5.1 does. A feed that
  carries text (task titles, board card text) needs its own scope and says so
  on the "Allow a connection" screen, because it breaks the "no text" property
  of the activity feed.

## 8. UI

One component, `LinkConnectForm`, is the connect form everywhere. Props:
`{ suggestedName?: string; continueHost?: string; onLinked(link) }`. It holds
the address, the code, the name A files the host under (from
`suggestedName`, or left empty to take B's label after pairing), and (from
slice 3) a
disclosure "Connect over ssh instead" (an ssh alias). It posts to `POST
/api/links/peers` or `POST /api/links/peers/ssh` and renders the §8.4 errors
under the field they concern. The name is a host id, and only a free one is
accepted (§2.1): a typed name that is taken is refused `name-taken` under
the name field before anything is sent to B, with the first free `{name}-2`
offered in its place; an empty name takes B's label when it is free and
the first free `{label}-N` otherwise, so B's label never lands a new link on
a host that already exists here.

`continueHost` is set only by a host's own row ("Connect again", "Continue
its history"). The form is then headed "Continue the history of {name}"
with the old address and "read up to {time}" beneath, and prefills the old
address. Without it (Settings, onboarding, /activity), a pair answer whose
`storeId` a kept or revoked host holds turns the form into the confirmation
step of §2.6:

```
┌ This install says it is laptop ──────────────────┐
│ laptop was last read at https://laptop.example.net│
│ up to 12 Sep, 18:40. You connected to             │
│ https://laptop-new.example.net.                   │
│                                                   │
│ Continue laptop only if this is the same machine: │
│ it will add to and may change laptop's history.   │
│                                                   │
│ New id if you start fresh  [ laptop-2          ]  │
│                                                   │
│ [Cancel]   [Start fresh under a new id]           │
│                             [Continue laptop]     │
└───────────────────────────────────────────────────┘
```

A different address from the old one is spelled out, as above; the same
address reads "at the same address as before". The new-id field is
prefilled with the first free `{label}-N` and refuses a taken id
(`name-taken`), `laptop` among them.

### 8.1 Settings → Linked installs

There is no Settings surface today. Slice 1 adds a "Settings" row to the
desktop rail menu (`ProjectRail.tsx`, beside the guide, mapping and voice rows)
and to the phone menu (`menuEntries.tsx`). It opens a Settings dialog whose
first section is Linked installs. Other settings may move there later; this
design adds only this section.

```
┌ Settings ─────────────────────────────────────────────────────────┐
│ Linked installs                                                   │
│                                                                   │
│ This install                                                      │
│   Name      [ stage-box              ]                            │
│   Address   [ https://delegatus.example.com       ] [Check]       │
│             ✓ Reachable at this address · checked 10:31           │
│             Point your proxy at 127.0.0.1:8897, keep the Host     │
│             header.                                               │
│             (This page was opened at https://… — use it?)         │
│                                                                   │
│ [ Allow a connection ]      [ Connect to another install ]        │
│                                                                   │
│ Reads from                                                        │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ laptop · HTTPS  https://laptop.example.net                    │ │
│ │ Last read 4 min ago · caught up · 12 408 rows                 │ │
│ │                                   [Read now] [Rename] [Remove]│ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ workstation · LAN http  http://<lan-address>:8897             │ │
│ │ ⚠ Plain http on a local network: anyone on it can read this. │ │
│ │ Could not reach workstation since 09:12. Earlier data kept.   │ │
│ │                                   [Read now] [Rename] [Remove]│ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ old-vps · ssh  alias old-vps · set in hosts.json              │ │
│ │ Last read 2 min ago · caught up                               │ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ vps-1 · no longer linked · read up to 12 Sep                  │ │
│ │ was https://vps-1.example.net                                 │ │
│ │               [Continue its history] [Delete its history]     │ │
│ └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ Can read this install                                             │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ laptop · activity · since 25 Sep · last used 3 min ago        │ │
│ │ 288 requests today · 2 016 in 7 days                [Revoke]  │ │
│ └───────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

- **This install:** name, address, the last check's outcome in words (§3.1),
  and the proxy target line from `publicEntry()`. `open-to-internet` renders
  as a red banner above the section.
- **Link row fields:** name, transport badge (HTTPS, LAN http, Tailscale, ssh,
  "Sends here" for push), address; **last read** (A's time of the last pull
  that finished); **lag** ("caught up" when B's skew-corrected `coveredUntil`
  is within the interval plus 10 minutes of now, otherwise "{n} behind");
  **error** in words (§8.4); clock offset when above 2 minutes; row count.
  Actions: Read now, Rename (the display label only; the host id is fixed),
  Remove (with the keep or delete history choice from slice 3, §2.6); a
  `revoked` link shows "Connect again" instead of Read now (§2.6).
- **Kept-history rows** (greyed): name, "no longer linked · read up to
  {date}", the old address. Actions: "Continue its history" (the form with
  `continueHost`, §8) and, from slice 3, "Delete its history" (`dropHost`).
  These two rows, "Connect again" and "Continue its history", are the only
  places a takeover is offered without the confirmation step.
- **`needs-remote-entry`** renders on the "This install" block as a red line
  whenever it holds (§3.1), whether or not the address was just saved.
- **Grant row fields:** name, scopes, created, last used, requests today and
  in 7 days. Action: Revoke.
- **"Allow a connection"** opens:

```
┌ Allow a connection ─────────────────────────────┐
│ On the other machine, choose "Connect to another │
│ install" and enter:                              │
│   Address  https://delegatus.example.com  [Copy] │
│   Code     R4TZ7M-K7QM9-XTD2P             [Copy] │
│   Expires in 9:41 · works once                   │
│   No wrong attempts                              │
│ It may:  ☑ read this install's activity          │
│          ☐ send its activity here (push)         │
│                                    [Cancel code] │
└──────────────────────────────────────────────────┘
```

  Disabled, with the reason, while the access key is off
  (`needs-access-key`), this install has no saved address, its address is
  plain http on a public host, or its last check was `open-to-internet`. Opening it re-runs the check (§3.1). "No wrong
  attempts" becomes "2 wrong attempts" as they arrive. The countdown reaching
  zero turns the panel into "Expired" with "Make a new code". A successful
  pairing replaces the panel with "Connected: {name} can now read this
  install."
- **"Connect to another install"** opens `LinkConnectForm` inline.

### 8.2 Onboarding step "Other machines"

A new step id `machines` after `phone` in `ONBOARDING_STEP_IDS`. An existing
marker reads it as not visited, so returning users see it once
(`src/lib/onboarding/steps.ts` documents this). It never blocks: "Not now"
marks it `skipped`.

```
┌ Set up Delegatus · Other machines ───────────────┐
│ Do you run Delegatus on another machine?          │
│ Link it to see its activity here.                 │
│                                                   │
│ On that machine: Settings → Linked installs →     │
│ Allow a connection. It shows an address and a     │
│ code; enter them here.                            │
│                                                   │
│  [ LinkConnectForm: Address · Code · Name ]       │
│                                                   │
│  [Not now]                        [Connect]       │
└───────────────────────────────────────────────────┘
```

On success the step shows "Connected: {name}. Its activity appears on
/activity within a few minutes" and marks the step `done`.

### 8.3 /activity hosts table

`HostsTable` (`ActivityDashboard.tsx`) keeps its layout. Changes:

- A linked host's source line reads "Linked over HTTPS · last read 4 min ago
  · caught up", or the §8.4 error, with a "Manage" link to Settings.
- A host that is expected and not connected (`data-connected="false"`, today
  "not connected") shows **"Connect this machine"**. It opens a dialog with
  `LinkConnectForm`, `suggestedName` set to that host's id so the new link
  files rows under the host the table already expects.
- Below the table, "Add a machine" opens the same dialog.
- A link removed with its history kept reads "No longer linked · read up to
  {date}", with "Manage" leading to its Settings row, where "Continue its
  history" lives; the hosts table itself never offers a takeover.
- A host still expected (a `hosts.json` entry) whose history was deleted has
  no read state left: `dropHost` keeps no marker, so `storeSource` answers
  plain `pending` (`hostSources.ts:279`) and the line is the ordinary "Not
  connected" one, with "Connect this machine" and its span hatched as
  unknown.

```
Host          Read                                              Excluded
stage-box     This host · transcripts read to now               none
laptop        Linked over HTTPS · last read 4 min ago · caught up   none
workstation   Could not reach it since 09:12; later time unknown
              [Manage]
vps-2         Not connected                    [Connect this machine]
```

### 8.4 Error states, en and uk

| Code | English | Українською |
|---|---|---|
| `code-rejected` (401) | That code was not accepted. Check it on the other machine, or make a new one there. | Цей код не прийнято. Перевірте його на іншій машині або створіть там новий. |
| `code-spent` (410) | That code has expired or was already used. Make a new one on the other machine; a code works once, for 10 minutes. | Термін дії коду минув або його вже використано. Створіть новий на іншій машині: код діє один раз, 10 хвилин. |
| `rate-limited` (429) | Too many wrong attempts on this code. Wait a minute and try again, or make a new code. | Забагато хибних спроб із цим кодом. Зачекайте хвилину й спробуйте знову або створіть новий код. |
| `http-public` | This address is on the internet and starts with http://. Delegatus sends access keys to internet addresses only over https://. Enter the https:// address of that install. | Ця адреса в інтернеті й починається з http://. Delegatus надсилає ключі доступу на інтернет-адреси лише через https://. Вкажіть https://-адресу тієї інсталяції. |
| `tls` | The certificate at that address is not valid, so nothing was sent. | Сертифікат за цією адресою недійсний, тому нічого не надіслано. |
| `unreachable` / `timeout` | Could not reach {name} since {time}. What was read before then is kept; the time after it shows as unknown. | Не вдається з'єднатися з {name} з {time}. Прочитане раніше збережено; час після цього показано як невідомий. |
| `revoked` | {name} no longer lets this install read it: access was revoked there. Ask for a new code to connect again. | {name} більше не дозволяє цій інсталяції читати дані: доступ відкликано там. Попросіть новий код, щоб під'єднатися знову. |
| `not-delegatus` | That address answers, but not as a Delegatus that can link. Check the address, or update Delegatus there. | Ця адреса відповідає, але не як Delegatus, що підтримує зв'язування. Перевірте адресу або оновіть там Delegatus. |
| `version` | {name} runs a Delegatus version this one cannot read. Update the older one. | {name} працює на версії Delegatus, яку ця не може прочитати. Оновіть старішу. |
| `install-changed` | That address now answers as a different install. Nothing was read. If it was reinstalled, remove this link and connect again. | За цією адресою тепер інша інсталяція. Нічого не прочитано. Якщо її перевстановили, видаліть цей зв'язок і під'єднайтеся знову. |
| `same-install` (live link) | This is the same install as {name}, which is already linked. Nothing was stored. | Це та сама інсталяція, що й {name}, вона вже під'єднана. Нічого не збережено. |
| `same-install` (`hosts.json` entry, twin is kept history) | This is the same install as {name}, whose history is kept here. To continue that history, use "Continue its history" on {name} in Settings (it can connect over ssh), or delete that history first. | Це та сама інсталяція, що й {name}, чия історія тут збережена. Щоб продовжити ту історію, скористайтеся «Продовжити її історію» для {name} у налаштуваннях (можна під'єднатися через ssh) або спершу видаліть її. |
| `name-taken` | The name {name} is already used here, by a linked install or by kept history. Use {free}, or pick another name. | Назва {name} тут уже зайнята під'єднаною інсталяцією або збереженою історією. Використайте {free} або виберіть іншу назву. |
| name taken, label used (not an error) | Saved as {free}: {label} is already used here. Rename changes only how it is shown. | Збережено як {free}: {label} тут уже зайнято. Перейменування змінює лише відображення. |
| takeover from the host's row (not an error) | Continues the history of {name}, last read at {address} up to {time}. | Продовжує історію {name}, востаннє прочитану за адресою {address} до {time}. |
| `continue-mismatch` (row flow, other `storeId`) | This address does not hold {name}'s history: it is another install, or its records were recreated. Nothing of {name} was changed. Save it under a new name, or cancel. | За цією адресою немає історії {name}: це інша інсталяція, або її записи створено заново. Нічого з {name} не змінено. Збережіть її під новою назвою або скасуйте. |
| `confirm-continue` (generic form, `storeId` of a kept host) | This install says it is {name}, last read at {address} up to {time}. Continue {name} only if this is the same machine: it will add to and may change {name}'s history. | Ця інсталяція називає себе {name}, яку востаннє прочитано за адресою {address} до {time}. Продовжуйте {name}, лише якщо це та сама машина: вона доповнить і може змінити історію {name}. |
| start fresh, cost line | If this is the same machine, its earlier activity counts twice until you delete {name}'s history. | Якщо це та сама машина, її попередня активність рахуватиметься двічі, доки ви не видалите історію {name}. |
| `reset-held` | {name} started a new history again; receiving is paused until you accept it. Accepting replaces what was received from it. | {name} знову почав нову історію; приймання призупинено, доки ви її не приймете. Прийняття замінить отримане від нього. |
| `same-install` (own store) | This is this install. There is nothing to link. | Це ця сама інсталяція. Під'єднувати нічого. |
| `no-ingest` | {name} has not recorded any activity yet. Update it to a version that records activity. | {name} ще не записав жодної активності. Оновіть його до версії, що записує активність. |
| `malformed` | {name} sent data this install could not read. Nothing from that answer was stored. | {name} надіслав дані, які ця інсталяція не змогла прочитати. З цієї відповіді нічого не збережено. |
| `quota` | {name} sent more than its daily allowance; receiving is paused until {time}. | {name} надіслав більше за денну норму; приймання призупинено до {time}. |
| `quota` (total) | {name} reached its size limit here; nothing more is received from it. Remove its history or the link. | {name} досяг ліміту розміру тут; від нього більше нічого не приймається. Видаліть його історію або зв'язок. |
| LAN warning | Plain http on a local network: anyone on this network can read what is sent. | Звичайний http у локальній мережі: будь-хто в цій мережі може прочитати те, що передається. |
| `needs-access-key` | The access key is off, so anyone who can reach this install can open this board as you. Turn on the access key before giving it an address or letting another machine connect. | Ключ доступу вимкнено, тож будь-хто, хто може достукатися до цієї інсталяції, відкриє цю дошку від вашого імені. Увімкніть ключ доступу, перш ніж давати їй адресу чи дозволяти під'єднання іншої машини. |
| `needs-remote-entry` | This install trusts every request that arrives on port {port} from this machine, so a public proxy cannot point there. Connections are disabled until you add a remote entry port or stop trusting the local entry. | Ця інсталяція довіряє кожному запиту, що надходить на порт {port} з цієї машини, тож публічний проксі не можна спрямовувати туди. Під'єднання вимкнено, доки ви не додасте порт віддаленого входу або не вимкнете довіру до локального входу. |
| `open-to-internet` | Anyone on the internet can use this board as you: a request that claims to be local passed through your proxy and was trusted. Point the proxy at 127.0.0.1:{port} instead. Connections are disabled until the check passes. | Будь-хто в інтернеті може користуватися цією дошкою від вашого імені: запит, що видає себе за локальний, пройшов через ваш проксі й отримав довіру. Спрямуйте проксі на 127.0.0.1:{port}. Під'єднання вимкнено, доки перевірка не пройде. |
| `peer-open` (on A) | {address} is open to the internet: a request that claimed to be local reached it as its owner. Nothing was sent, and the code was cancelled there. Its owner must point the proxy at the port shown in its Settings, then make a new code. | {address} відкрита в інтернет: запит, що видавав себе за локальний, дістався до неї як до власника. Нічого не надіслано, а код там скасовано. Її власник має спрямувати проксі на порт, указаний у її налаштуваннях, і створити новий код. |
| `host-rewritten` | Your proxy replaces the address it was called at. Keep the Host header in the proxy and point it at 127.0.0.1:{port}. | Ваш проксі підміняє адресу, за якою до нього звернулися. Збережіть заголовок Host у проксі та спрямуйте його на 127.0.0.1:{port}. |
| `unverified` | This server could not reach its own address, so the proxy could not be checked from here. Make sure it points at 127.0.0.1:{port}. A machine that connects checks it again from outside. | Цей сервер не зміг звернутися до власної адреси, тому проксі звідси не перевірено. Переконайтеся, що він спрямований на 127.0.0.1:{port}. Машина, що під'єднується, перевірить його ще раз ззовні. |
| code burned | This code was burned after too many wrong attempts. Make a new one. | Цей код анульовано після забагатьох хибних спроб. Створіть новий. |

## 9. Operator-facing API (A's and B's own UI)

Same-origin browser routes, behind `rejectCrossOrigin` and the normal gate:

```
GET    /api/links                     self, links (outbound), grants (inbound), open codes
PUT    /api/links/self                {label?, publicUrl?}
                                      → self | {code: "http-public" | "needs-access-key" | "needs-remote-entry"}
POST   /api/links/self/check          → {state: "needs-access-key" | "ok" | "tls" | "unverified" | "host-rewritten"
                                                | "open-to-internet", checkedAt, entryPort}
POST   /api/links/access-key          → {on: true}   (the key phone access uses; §3.1)
POST   /api/links/codes               {scopes: ["activity:read"] | ["activity:push"], hostName?}
                                      → {id, code, expiresAt} | {code: "needs-access-key" | "open-to-internet"
                                                | "name-taken" | …}
DELETE /api/links/codes/<id>
POST   /api/links/peers               {url, code, name?, continueHost?}
                                      → link | {code: <§8.4 code>}
                                        | {confirm: {pendingId, host, label, address, readUpTo}}
POST   /api/links/peers/<pendingId>/choice   {choice: "continue" | "fresh" | "cancel", name?}
                                      → link | {} | {code: "name-taken", free}   (name: the free id for "fresh")
POST   /api/links/hosts/<host>/accept-reset  (push, after reset-held; §4.6)
POST   /api/links/peers/ssh           {alias, name}             → link
POST   /api/links/peers/<id>/read     → the pull result
DELETE /api/links/peers/<id>?history=keep|delete   (delete = dropHost, §2.6)
DELETE /api/links/hosts/<host>        a kept host's history (dropHost)
DELETE /api/links/grants/<id>
```

Peer routes (§2.5 guard): `POST /pair`, `POST /pair/probe`, `GET /info`, `GET /activity`,
`DELETE /grant`, `GET|POST /push/activity`, `POST /self-check`, all under
`/api/peer/v1/`.

Files, all under `<state>/links/`, 0600 in a 0700 directory, written
atomically: `self.json`, `peers.json` (links, tokens, and links in
`awaiting-choice` until the operator answers, §2.6), `grants.json` (grant
hashes, request counts, code ids and hashes). They are created on the first
operator action, never at startup, so no `assertStateStartupMutation` step is
involved; the Viewer (owner `viewer`) is the only writer. The boot gate
(§3.1) only reads them; the key file it may mint is the one
`restorePhoneAccessGate` already mints at the same point of the same boot. `readHostsConfig`
gains the links as expected hosts beside `activity/hosts.json`; an id present
in both is the link, whatever state the link is in, so a `hosts.json` `pull`
under a kept, inert, `revoked` or `awaiting-choice` host's id is never pulled
(§4.4). Deleting a host's history removes its kept `peers.json` entry with
the rows (`dropHost`), which frees its id (§2.1).

## 10. Later phase: projects and work on a linked install

After the activity slices, and only on top of them.

### 10.1 Projects and boards (read)

Two snapshot feeds (§7):

- `projects:read` → `GET /api/peer/v1/projects`: per project `{ key, name,
  checkout: true|false, defaultBranch?, remote? }`. `repo-` keys are the hash
  of the canonical remote, so the same repository has the **same key** on both
  installs; A merges it into its own project without a mapping. `dir-` keys
  hash a local path and never match across machines; A shows them under the
  peer's name. No filesystem path crosses.
- `board:read` → `GET /api/peer/v1/board?project=<key>`: the board projection
  B already builds for itself (`/api/board`) with task titles and states,
  pipeline and stage states, agent liveness. **It carries text** (titles, card
  text) and is its own scope for that reason (§7).

On A, a project that exists on B shows "also on {B}" and opens B's board read
only, labelled with B's name and read time.

### 10.2 Dispatch: start work there, from here

A **separate grant**, `dispatch`, minted by its own code with its own
checkbox on B:

```
☐ Start agents and pipelines on this machine
  Anything that install asks for runs here as you, with your accounts,
  your keys and your files. Allow only an install you control.
  Projects it may use: ☑ delegatus  ☐ billing-api  ☐ …
  At most [2] runs at a time
```

A read grant never implies it and is never upgraded into it; a peer holds a
read grant and a dispatch grant as two rows.

**What B advertises** (`GET /api/peer/v1/capacity`, snapshot, refreshed about
once a minute while A's dispatch picker is open):

| Field | Source on B |
|---|---|
| projects allowed for this grant, each with `checkout`, `defaultBranch`, whether the checkout is clean | the grant's project list + the scanner |
| memory: total, available; CPU count, load | `readResourcesWithDiagnostic` (`/api/resources`, `ResourcesPayload.system`) |
| live agents / cap, pipelines queued, "busy" | the spawn admission fence (`src/app/api/spawn/admission.ts`, `AGENT_SPAWN_LIVE_CHILD_CAP`) and the pipeline queue |
| engines installed; accounts as the operator's own labels with each account's usage windows (percent used, reset time); no emails, no tokens | accounts and `account_limits` |
| role presets offered | the role presets B already resolves |

**Dispatch request:**

```
POST /api/peer/v1/dispatch
{ "clientRequestId": "<uuid>", "kind": "pipeline" | "agent",
  "project": "repo-<32 hex>", "task": { "text": "…" },
  "prompt": "…", "preset": "implementer", "flow"?: "<template id>" }
→ 201 { "runId": "<uuid>", "taskId": "…", "pipelineId"?: "…", "conversationId"?: "…" }
```

- B creates the task on its own board, attributed "from {A}", and starts it
  through its own `createPipelineFromRequest` (`src/app/api/pipelines/route.ts`)
  or spawn path with a new caller kind `peer`, beside `operator` and `agent`
  (`AuthenticatedSpawnCaller`), so the admission fence, busy queue and
  role presets apply unchanged. **B** picks engine, model and account from its
  presets; A cannot pass a cwd, a path, environment, flags, MCP servers or an
  account.
- `clientRequestId` is the idempotency key, so a retried POST after a dropped
  answer returns the same run.
- Refused with the §2.5 `401` without a dispatch grant; `409 {code:"busy"}`
  at the grant's run limit; `422` for a project outside the grant.

**Tracking:** A keeps a card "running on {B}" linked to `runId` and reads a
log feed `GET /api/peer/v1/runs?after=<version>` (only this grant's runs):
state (`queued, running, waiting-decision, done, failed, cancelled`), current
stage and its summary, PR links, times. The run state rides the same cursor
rules as §4.2, so a reconnect catches up without gaps. Reading a dispatched
run's conversation (`conversation_messages` shape) is a further scope on the
same grant, limited to that grant's runs.

**Cancel:** `POST /api/peer/v1/runs/<runId>/cancel` (idempotent) → B's own
pipeline or agent stop. Only runs this grant started.

**When the link drops mid-run:** the run lives entirely on B and continues. A's
card says "Link to {B} lost at {time}; the run continues there", and catches up
from the runs cursor when the link returns. A decision the run waits on is
answered on B's own board in the first cut. A's card shows "Waiting for a
decision on {B}" with B's address; answering from A is deferred (§11).

**Revoking a dispatch grant** stops new dispatches at once. Running runs
continue unless B's operator chooses "Revoke and stop its runs".

### 10.3 Threat model for a peer that may run code here

- **A dispatch grant is remote code execution as B's operator.** Agents run
  with permissions bypassed; the prompt is free text; so whoever holds the
  token can make B run any command with B's accounts, ssh keys, `gh`
  credentials and files. The project list, presets and run limit bound what is
  started and make it visible. They do **not** stop a prompt from doing
  anything the operator's user can do. The grant screen says this in plain
  words.
- **Trust becomes transitive:** B is then as safe as A. Anyone who takes over
  A (or A's `peers.json`) takes over B's user.
- **Mitigations:**
  - separate code and grant, off by default, never an upgrade of a read grant;
  - HTTPS or loopback only: the private-network `http://` exemption does not
    apply, since a LAN sniffer with this token has a shell on B;
  - a dispatch grant can be minted only while B's last self-check is `ok`
    (§3.1), so the proxy in front of it is known not to vouch;
  - B chooses cwd, engine, model and account; A names only a project key and a
    preset;
  - per-grant run limit, on top of B's normal admission fence;
  - every dispatched task and run carries "from {A}" on B's board and in its
    lifecycle events;
  - revoke on B, optionally stopping the grant's runs;
  - "last used" and request counts per grant.
- Request signing and mutual TLS would stop a captured token being reused
  elsewhere. They are deferred (§11) because the cheaper rules above come
  first; the operator should revisit them before dispatch ships to other
  users.

## 11. Deferred — not currently justified

| Item | Why deferred |
|---|---|
| One-step mutual pairing | pairing twice is two short steps and keeps each grant's direction explicit |
| QR code for the code | both machines are usually computers; address and code have Copy buttons. Revisit when a phone is a pairing party. |
| Token rotation and expiry | revoke covers a leak; add rotation if tokens start living on many machines |
| Certificate pinning for self-signed HTTPS | LAN http and Tailscale cover the self-signed box |
| HMAC request signing, mutual TLS | HTTPS plus revoke for read grants; revisit before dispatch ships (§10.3) |
| Showing a caller address per grant, trusting `X-Forwarded-For` behind a declared proxy | behind a same-box proxy every caller is `127.0.0.1`, and the header is caller-written unless the proxy overwrites it; last-used time and request counts carry the signal without a new trust setting |
| A global or per-address pairing rate limit | a global counter lets a stranger lock pairing; per-address is meaningless behind a proxy; the per-code limit (§2.5) needs neither |
| A separate peer-only listener | the gateway's remote entry already is a non-vouching port (§3.1) |
| Relay, rendezvous or any hosted helper | excluded by the requirement: no server of ours |
| Telegram connector as a transport | it would route data through a third party (Telegram), against §5.2 |
| Transitive relay (A reads C through B) | one path per host keeps dedupe and trust simple (§4.2) |
| Retention limits on pulled rows beyond the per-host cap | the store is about 15 MB for a full history (`activity-dashboard.md` measurement) |
| Answering a remote run's decision from A | a write over the link; B's board answers it in the first cut |
| Other feeds (conversations, tasks, liveness) | extension path in §7; built only when a slice needs them |
| Keeping a push host's old copy until a reset's new history is read to its end | an eraser can send an empty history that ends at once, so a shadow copy stops nothing the reset budget does not already stop (§4.6), and it doubles the store for every honest reset |
| Proving an install's identity with a key pair instead of public ids | continuing a host is an operator choice made on that host's row or confirmed in the form (§2.6); signed identity comes back with request signing (above) |
| Moving `activity/hosts.json` into the links store | both are read; a migration would be a startup mutation for no user-visible gain |

## 12. Validation against the requirement

| Requirement | Where met |
|---|---|
| one install reads another's activity; /activity sees the whole picture | §4, §8.3 |
| later metadata (conversations, tasks, agent state) | §7, §10.1 |
| no ssh needed, no server of ours, no central user database | §2, §3, §5.2; ssh stays one transport (§3.3) |
| pull over an HTTP endpoint, configured by the user | §4.1; configured in the UI only (§8) |
| no duplicates | keyed upsert (§4.2); the same install under two host ids refused on every page; a reconnect continues the old host when the operator chooses it on that host's row or confirms it in the form, and "start fresh" states the double count it causes (§2.6, §4.4); a new link never lands on an existing host's id, live or kept (§2.1) |
| no silent gaps | version cursor (§4.2); kinds negotiated for pulls (§4.5) and for push, where each page names the kinds B believes A reads and the kinds it served, so an upgrade on either side is seen on the next POST and a change in what is received rewinds the push cursor to 0 without forgetting rows (§4.6); no row sits below a cursor unread; push pages carry their base (§4.6); deleted history drops the host's read state too, a pull already running cannot write it back, so its span reads unknown and a reconnect reads from 0 (§2.6, §4.4); a new link cannot inherit a kept host's cursor (§2.1); unreachable time shown as unknown (§3.4) |
| resumable | cursor committed with each page (§4.2, §4.6) |
| public HTTPS domain first; http refused for public addresses | §3.1, §3.2 |
| endpoints closed without a token; uniform 401; rate-limited pairing | §2.4, §2.5; the access key is required wherever the install is reachable, and the proxy cannot turn a stranger into the operator, checked from inside (§3.1) and from the pairing peer (§2.5) |
| exactly which fields leave; no third party | §5 |
| an install behind a proxy learns and shows its public URL | §3.1 |
| does the ssh pull leak data | §6 |
| Settings section, onboarding step, hosts-table entry; one form | §8 |
| error states in plain words, en and uk | §8.4 |
| projects sync and dispatch under a separate grant, after the activity slices | §10, slices 5 and 6 |

## 13. Slices

Every slice runs its tests by path, against isolated state directories
(`LLV_STATE_DIR` per install, ports bound to `0`), never the operator's live
state (AGENTS.md). UI slices bring rendered evidence through the existing
drivers (a `describe` block in
`src/components/mobile/issue1671Evidence.browser.test.tsx` for 390 px, the same
driver at desktop width), with no new driver file. Slices 1–4 are the activity
slices; 5 and 6 are the later phase.

### Slice 1 — this install's public address (fixes today's 403 on its own)

Scope: `self.json`; `LLV_PUBLIC_HOST` set on save and at boot and admitted by
`allowedHostNames()` only while `LLV_TOKEN` is set; the boot gate for a saved
non-loopback address and `disablePhoneAccess` keeping the key (§3.1); "Turn on
the access key"; refusals `needs-access-key`, `needs-remote-entry`,
`http-public`; `publicEntry()` shared with phone access
(`dockerTailnetEntry`); the `/api/peer/v1/self-check` route with its nonce and
the §2.5 `401` for anything else (the `/api/peer/` proxy exemption lands here,
with only this route behind it); the reach and spoof check with the loopback
probe names beside `isLoopbackHost`; `needs-remote-entry` as a standing state
(§3.1); `vouchedCredential` refusing to vouch for a loopback-`Host` request
that carries `Forwarded`, `X-Forwarded-For` or `X-Real-IP`; the Settings
dialog with the "This install" section only; en and uk strings for its
states. Slice 1 does not add the Host pin to the 23 routes that skip it
(§1, fact 1; §14, item 11).

Acceptance:
- a Viewer with a saved public address serves its **pinned** routes (among
  them `/api/pipelines`, `/api/spawn` and `/api/board`) at that `Host`;
  without one, the same `Host` is still refused there. The unpinned reads
  (§1) answer any `Host` before and after, and with `LLV_TOKEN` on they
  refuse a caller without the key either way;
- a public address saved while the entry was safe, followed by the gateway
  file switching to a trusted local entry with no remote entry, reads
  `needs-remote-entry` on the next Settings read and after a restart, and
  minting is refused, with no save in between;
- a loopback-`Host` request carrying `X-Forwarded-For`, `X-Real-IP` or
  `Forwarded` through a trusted local entry reaches the Viewer without the
  vouched `Authorization`; the same request without them is still vouched;
- no non-loopback address can be saved while `LLV_TOKEN` is off: saving
  `http://192.168.x.y:port` with the key off is refused `needs-access-key`,
  as is a public `https://` address; a public address cannot be saved while
  the stable port is a trusted local entry with no remote entry;
- with `LLV_PUBLIC_HOST` set and `LLV_TOKEN` unset (a saved address whose key
  was removed), a request with the public `Host` is refused and the check
  reports `needs-access-key` without probing;
- a Viewer that boots with a saved public address and no key in its
  environment gates itself before its first request (the key file is read
  or minted), or refuses to start when no key can be put in place; turning
  phone access off on a loopback CLI install keeps the key while an address
  is saved;
- behind a stand-in proxy that passes the client's `Host` through and adds
  no forwarding header, requests sent with each loopback probe name (§2.5,
  bare, with a port and in upper case) through the proxy aimed at the
  remote entry reach the Viewer **unvouched**, and the check reports `ok`;
- the same proxy aimed at a trusted local entry makes the check report
  `open-to-internet` (the red path is exercised beside the green one), and
  so does a probe name that only a case- or port-normalizing gateway
  vouches for (`LOCALHOST`, `127.0.0.1:443`);
- a proxy that rewrites `Host` to loopback reports `host-rewritten`; a
  public URL the server cannot reach reports `unverified` and does not block
  saving.

Tests: `sameOrigin` tests for `LLV_PUBLIC_HOST` with the key on and off; the
refusal table (private and public addresses, key on and off); the boot gate
beside the `restorePhoneAccessGate` tests, and `viewerBootGateKey` returning
the key file for a saved address with no phone flag, in an isolated state
directory; a
self-check test that boots a gateway (`serveViewerLocalEntry`, isolated
gateway file, port `0`) and a stand-in pass-through proxy in front of it,
once on each entry, asserting the `vouched` flag the route reports and that
the probe's custom `Host` arrives as sent with the connection aimed elsewhere
(this proves the `node:https` `servername` + `headers.host` split under the
pinned Bun); `deploymentProxy.test.ts` for the three forwarding headers and
for the probe-name constant held against `isLoopbackHost`; the standing
`needs-remote-entry` state from a gateway file rewritten after the save;
`src/proxy.test.ts` for the exemption; the Settings section rendered at
390 px and desktop.

### Slice 2 — pair and pull activity over HTTPS, managed in Settings

Scope: `peers.json` / `grants.json`; codes with public id (refused while the
key is off), the pairing probe, pairing, grants,
revoke on B, remove on A (keeps history: the host shows "No longer linked ·
read up to {date}"; the delete choice arrives in slice 3); continuing a
removed or revoked host only from its own row ("Connect again", "Continue
its history") or after the generic form's confirmation, with the
`awaiting-choice` link and its 10-minute expiry (§2.6, §4.4); host-id
uniqueness across rows, links, grants and `hosts.json` `pull` entries, with
`name-taken` and the `{label}-N` fallback (§2.1); the §2.5 guard and
per-code rate limit; URL policy; `GET /activity` with `types` and `GET
/info`; an HTTP transport for `pullHost` (the transport interface becomes
"fetch one page → NDJSON text"; ssh keeps shipping the reader); the served
kinds stored with the cursor; the same-install check inside `pullHost` for
every transport; links as expected hosts in `readHostsConfig`;
`startDuePulls` over links; "Allow a connection" (gated on the slice 1
check), "Connect to another install", link and grant rows with request
counts, `LinkConnectForm`; en and uk strings.

Acceptance:
- two isolated installs pair by address and code; A's /activity shows B's
  rows under the chosen host id within one interval;
- minting a code on B with `LLV_TOKEN` off is refused `needs-access-key`, and
  "Allow a connection" renders disabled with that reason;
- with a pass-through proxy in front of a **trusted** local entry and B's
  self-probe forced to `unverified`, pairing is refused: A's probe arrives
  vouched, A shows `peer-open`, B's code is burned and B shows
  `open-to-internet`; the same proxy in front of the remote entry pairs;
- a link removed with its history kept, then paired again to the same B
  from its row ("Continue its history"): rows continue under the old host id
  from the old cursor, with no duplicates and no refusal; the same after B
  revokes and A uses "Connect again". Both take over with no further
  question;
- the **generic** form never takes a host over without confirmation: a
  second install that answers `/pair` with the `storeId` and `install` of
  a kept host X gets the confirmation naming X, X's old address and its read
  span, and until the operator chooses, X's rows, cursor and `remoteStore`
  are byte-for-byte unchanged and nothing is pulled. "Start fresh" files the
  new rows under the new id and leaves X's rows as they were; "Cancel" and
  the 10-minute expiry delete the pending link and the grant on B; a row
  flow whose answer carries another `storeId` takes nothing over, and its
  "Cancel" deletes the grant on B as the generic one does;
- a new link never lands on a host id that exists here: a generic link to a
  B whose label equals a kept host X's id, left unnamed, is saved as
  `{label}-2`, and typed as X's id is refused `name-taken` before anything
  is sent; "Start fresh" with X's id is refused `name-taken`; in all three
  X's rows, cursor and `remoteStore` stay byte-for-byte unchanged. The same
  holds for revoked, inert and `awaiting-choice` hosts, for a push code
  minted under a taken id, and for a `hosts.json` `pull` entry written by
  hand under X's id, which is never pulled;
- a second live link to the same B is still refused `same-install`;
- wrong secret → `code-rejected` and the open code shows one wrong attempt; a
  request naming no open code changes no counter; a probe naming no open
  code gets the uniform `401` and costs no attempt; the 6th failure on a code
  within a minute → `rate-limited` for that code only while another code
  pairs; 20 failures burn it; the exact expired or used code → `code-spent`;
- every unauthenticated request under `/api/peer/` (no header, wrong token,
  unknown grant, unknown path, missing scope, unknown code id) gets a
  byte-identical `401`;
- `http://` to a public address, including `100.64/10`, is refused before any
  connection; `http://` to a private address works and shows the warning; a
  `3xx` is not followed;
- with `LLV_TOKEN` set, peer routes still require the peer header, and neither
  the operator cookie nor the operator bearer is accepted there;
- an ssh `pull` entry and an HTTPS link to the same B: whichever pulls second
  is refused `same-install` and stores nothing; a link to A's own address is
  refused as "this install";
- revoke on B → A shows `revoked` on its next pull; remove on A deletes B's
  grant and keeps the rows.

Tests: code mint, verify, expiry, single use, per-code limit and burn under
fake timers; guard uniformity (compare status, headers and bodies); URL policy
table including a name resolving to mixed public and private addresses;
`deploymentProxy.test.ts`: the trusted local entry forwards `X-Delegatus-Peer`
untouched while replacing `Authorization`; end-to-end: two installs, pull
across three pages with `limit=2`, a replayed page changes nothing, a
recreated store on B is re-read whole, `install` change refused, the same
store under two host ids refused in both orders; the takeover table of
§4.4 row by row, including a pull whose cursor was mid-history at removal,
and an impostor that replays a kept host's public `storeId`, `install` and
row keys with higher versions: through the generic form it changes no row
of that host without the confirmation, and a "Start fresh" whose prefilled
label is that host's id lands under `{label}-2` with that host untouched;
the id-uniqueness table (every `activity_hosts` row and every `peers.json`
state, push grants, `hosts.json` `pull` entries; an expected host without
`pull` stays free);
the pairing probe against both entries of a real gateway
(`serveViewerLocalEntry`, port `0`) behind the stand-in proxy, once per
loopback name; **kind negotiation**: an A
that reads only `input` pulls to the end, then learns `turn` and receives the
turns written before it learned them, with input rows unchanged; a row of an
unrequested kind fails the page; the Settings section in both viewports.

### Slice 3 — the same form in onboarding and on /activity; ssh in the UI; lag and skew

Scope: onboarding step `machines`; "Connect this machine" and "Add a machine"
on the hosts table; linked-source lines and "Manage"; "Connect over ssh
instead" writing an ssh link; hosts.json ssh entries listed as "set in
hosts.json"; the ssh hardening flags (§6); clock offset and skew-corrected
caught-up test; "Read now"; remove with keep or delete history, and
"Delete its history" on a kept row, both through the new store method
`dropHost` (§2.6), and the `stillLinked` guard on every `pullHost` write so
a pull already running cannot write a removed host back (§2.6).

Acceptance: the one `LinkConnectForm` renders in all three places (asserted by
a DOM test mounting each entry point); a not-connected host row links with
its own id prefilled; a peer 7 minutes ahead shows the offset and is not
reported behind; a marker from before the step lands on it once; an ssh link
made in the UI pulls exactly like a hosts.json entry, and one made for a B
whose HTTPS link was removed with its history kept continues that host
only through that host's row or the confirmation; `sshTransport` passes
`StrictHostKeyChecking=yes`, `ForwardAgent=no` and `ClearAllForwardings=yes`;
remove with delete leaves no rows **and no `activity_hosts` row** for that
host, so /activity shows its span as unknown, not as covered and empty;
connecting again under the same host id afterwards holds every row B has,
including those below the cursor the deleted host had reached; deleting a
host while its pull is between two pages (and while an earlier host of the
same `startDuePulls` run is being read) leaves no row and no
`activity_hosts` row once the pull ends, and the pull reports that it
stopped; a host expected in `hosts.json` whose history was deleted reads
"Not connected".

Tests: onboarding DOM test for the new step and marker compatibility;
`hostSources` tests for links as hosts, for skew in `storeSource` and for
`pending` after `dropHost`; a `store.test.ts` case that `dropHost` removes
inputs, turns and the host row in one transaction and still refuses `''`;
an end-to-end pull that deletes a mid-history host and re-links it under
the same id; a `pull.test.ts` case whose transport runs `dropHost` (and,
separately, removes the link) between page 1 and page 2, asserting that no
write reaches the store afterwards, `fail()` included;
`pull.test.ts` for the ssh argument list; dashboard DOM test for the row
states; rendered evidence at 390 px and desktop for the step, the hosts table
and the dialog.

### Slice 4 — push from an unreachable install

Scope: push scope on codes, `GET|POST /api/peer/v1/push/activity` with the
base check, the kind check on `state.requested` and `state.types` with A's
kinds in every answer (§4.6), the daily budget and the per-host cap, B's push scheduler,
"Sends here" rows on A, "Sends to" rows on B.

Acceptance: a B with no inbound route keeps A's /activity current; a resent
page changes nothing; a POST whose `after` is not A's cursor is refused `409`
and stores nothing; two senders pushing from the same cursor: one applies,
the other gets `409` and resumes without gaps or doubles; a POST carrying a
new `storeId` resets A's copy once and stores none of its own rows; a
second new `storeId` within 7 days is `reset-held`, erases nothing, and
resets only after A's operator accepts it; B's restart mid-push resumes; a
push over the daily budget gets `quota`, stores nothing, and A shows the
pause; a push without a push grant gets the uniform `401`. **Kind
negotiation**: B knows `turn` and pushes against A's `input`-only set to the
end; A then upgrades to read `turn` while B makes **no** `GET`. The next
POST, whose `state.requested` is the stale `[input]`, gets `409` with A's
cursor unchanged and `types: [input, turn]`; B's resent page, served against
the new set, gets `409 {cursor:0, storeId:<held>}` with nothing forgotten;
after B re-pushes from 0, A holds every turn written before the upgrade,
with input rows unchanged and no reset counted. The same with B upgrading
instead (A already asked for `turn`) rewinds on the first page that serves
it. An A upgrade that B cannot serve (B does not know `turn`) causes the
one stale-set `409` and no rewind. A first backfill and a kind change on
one day exceed the default row budget and pause with `quota` until the next
day, and A shows the pause; a grant revoked on A between two POSTs applies
nothing from the second.

Tests: end-to-end with B pushing to A (isolated), dropped answers and
resends, a stale-base POST after a reset, concurrent senders, the reset POST,
the reset budget and `reset-held` under fake timers, the push kind change
with no `GET` between the upgrade and the next POST, on either side,
the budget and cap under fake timers, `429` handling.

### Slice 5 — projects and boards from linked installs (later phase)

Scope: snapshot feeds `projects` and `board`, scopes `projects:read` and
`board:read` on the Allow screen with the "carries text" note, "also on {B}"
on A's projects, B's board opened read-only.

Acceptance: a `repo-` project on both installs appears once on A with "also on
{B}"; B's board renders read-only with B's name and read time; a grant without
`board:read` cannot read the board (uniform `401`); an unchanged snapshot
answers `304`.

Tests: feed tests for the projects and board payloads (no path in either,
`dir-` keys kept under the peer), ETag and `304`; scope tests on the guard;
a DOM test for the merged project and the read-only board; rendered evidence
at 390 px and desktop for "also on {B}" and the read-only board.

### Slice 6 — dispatch to a linked install (later phase)

Scope: the `dispatch` grant with project list and run limit, `capacity`,
`dispatch`, `runs` feed, `cancel`, caller kind `peer` through the existing
admission fence, the "running on {B}" card on A, "from {A}" on B's board.

Acceptance: A starts a pipeline for a task in an allowed project on B and sees
its stages on A's card; a retried dispatch returns the same run; cancel from
A stops it on B; the run continues and A catches up after the link drops;
a dispatch into a project outside the grant, above the run limit, or over
LAN http is refused; a dispatch grant cannot be minted unless B's self-check
is `ok`; revoke with "stop its runs" stops them.

Tests: isolated end-to-end with a stub engine; admission-fence tests for the
`peer` caller kind; the runs feed under reconnect.

## 14. What the repo cannot tell, to be observed or decided

Observed on the operator's machines before slice 1 is accepted:

1. **The public server's proxy.** Which reverse proxy fronts the public
   install, and which port it targets. The rule (§3.1) is that it targets the
   public entry, never a trusted 8898; the self-check's spoof probes detect a
   violation from inside when the server can reach its own name, and the
   pairing probe (§2.5) detects it from the connecting install otherwise. Until
   a first pairing, a server whose self-check says `unverified` is known only
   by a look from outside: `curl https://<domain>/api/pipelines -H 'Host:
   127.0.0.1'` (and with `localhost`, `[::1]`) should not be answered as the
   operator. That same request tells whether such a server is exposed
   **today**, before any link exists.
2. **Hairpin reachability.** Whether the release container can reach its own
   public name. It decides whether "Check this address" can verify the proxy
   there or only report `unverified`.
3. **`LLV_TOKEN` and the gateway file on the public install.** The first
   install to declare a public address must have the access key on and, if
   its local entry is trusted, a remote entry port; the operator should
   confirm that is how their server is run. On Docker, a key the boot gate
   mints reaches the trusted local entry through `viewerBootGateKey` (§3.1);
   the first deployment with a saved address and no `service.env` key should
   confirm MCP clients on 8898 keep working.

Decided by the operator (the design picks a default in each case):

4. **Which install should see the whole picture.** If the public server should
   show a laptop's activity, the laptop cannot be reached and slice 4 (push)
   is required; if only the laptop reads the server, slices 1–3 suffice.
   Default: build push as slice 4.
5. **Plain HTTP on private networks for read grants.** Default: allowed with a
   warning on RFC 1918 and link-local addresses, refused on `100.64/10` and
   for dispatch. The stricter choice is HTTPS or loopback only everywhere.
6. **Code shape and limits.** Default 6-symbol id + 10-symbol secret, 10
   minutes, single use, 5 failures a minute and 20 in total per code.
7. **Push budgets.** Default 50 000 rows and 32 MB per grant per day, 500 000
   rows per linked host.
8. **ssh hardening.** Default: slice 3 forces `StrictHostKeyChecking=yes`, so
   an alias never connected to from a terminal fails until it is. The
   operator may prefer to keep their own config's setting.
9. **Dispatch at all.** The operator asked for it as a later phase. §10.3
   states that a dispatch grant is code execution on the granting machine; the
   operator should confirm that trade before slice 6 starts, and whether
   request signing must ship with it.
10. **Where Settings lives.** No Settings surface exists; the default is a new
    dialog opened from the rail menu and the phone menu, with Linked installs
    as its first section.

Noticed on `main` while checking this design, outside its scope:

11. **23 routes skip the Host pin** (§1). They are nearly all reads
    (`/api/conversations`, `/api/files`, `/api/logs`, `/api/timeline`,
    `/api/session`, `/api/search/transcripts`, `/api/accounts`, …). With
    `LLV_TOKEN` off on a loopback install, a page on a DNS name rebound to
    `127.0.0.1` can read them from the operator's own browser, which is the
    attack `rejectCrossOrigin` names in its comment (`sameOrigin.ts:49-52`).
    Links do not change this: every link needs the key (§3.1), and the key
    stops the rebound page. It deserves its own issue, pinning them through
    the proxy or one route wrapper.
