# Linked installs: one Delegatus reads another, peer to peer

Status: design, 2026-09-25. Read-only design stage; nothing here is built yet.
Grounded in `main` at `46f47bec1` and in PR #2159 (activity records itself),
read from its branch `pipeline/activity-records-itself-every-operator-i-999cc94b`
at `8e9f55fa6`. Files that exist only on that branch are marked *(#2159)*.

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
are the #2159 delivery and review conversations, whose outcome is already
recorded in the PR's `docs/design/activity-dashboard.md` ("Other hosts: the
pull"). This design builds on that pull.

## 1. What exists today

| Piece | Where | What it gives this design |
|---|---|---|
| Own activity store | `src/lib/activity/store.ts` *(#2159)* | `<state>/activity/records.sqlite` (0600, dir 0700). Rows keyed `(host, key)`; this host is `host = ''`. One counter `activity_meta.version` rises on every write of an input or a turn; `store_id` is a UUID minted with the file. `localRowsAfter(version, limit)` and `localTurnsAfter(version, limit)` already serve "everything written after a version". `upsertPulled` / `upsertPulledTurns` replace a row only when the sender's version is higher. `forgetHost` drops a pulled host. |
| ssh pull | `src/lib/activity/pull.ts` *(#2159)* | `pullHost(store, host, config, transport)` pages by version cursor, detects a recreated remote store by `store_id` (or `latest < cursor`), takes each row whole or refuses the page, and takes the remote's read span only with the last page. The wire format is NDJSON: one `state` line (`v: 1`), then `input` / `turn` lines. Only the transport is ssh-specific (`sshTransport`, `REMOTE_READER`). |
| Host list | `src/lib/activity/hostSources.ts` *(#2159)* | `activity/hosts.json` (`{ v: 1, local, hosts: [{ id, label, projects, since, pull? }] }`) names expected hosts; `storeSource("pull", …)` turns a pulled host's `activity_hosts` row into coverage, `readAt`, `error`. Host ids match `/^[a-z0-9][a-z0-9._-]{0,62}$/` (`validHostId`, `humanInput.ts`). |
| Schedule | `src/lib/activity/continuous.ts` *(#2159)* | After each ingest pass, `startDuePulls` pulls every host whose interval passed, one at a time, beside the index queue. |
| Hosts table | `src/components/activity/ActivityDashboard.tsx` *(#2159)*, `HostsTable` | One row per expected host with a line per source: last read, last error (`unreachable`, `timeout`, `no-ingest`, `malformed`), "not connected". |
| Access gate | `src/proxy.ts` | `LLV_TOKEN` unset: every request passes. Set: cookie `llv_auth`, `Authorization: Bearer`, or `?k=` link, compared with `tokensMatch` (`src/lib/authToken.ts`, sha256 + `timingSafeEqual`). `/api/artifact/frame/` is already exempt because it authorizes itself. |
| Host pin | `src/lib/sameOrigin.ts` | `rejectCrossOrigin` / `rejectForeignHost` admit only a `Host` of `localhost`, `127.0.0.1`, `::1` or `LLV_TS_HOST`. Every browser route calls it (`/api/activity`, `/api/pipelines`, `/api/resources`, …). |
| Gateway | `src/runtime-host/deploymentProxy.ts` | The runtime host's stable port (8898, bound to `127.0.0.1`). With `viewer-gateway.json` and `localEntry: "trusted"`, a request whose `Host` is loopback has its `Authorization` header **replaced** by the release's own credential; the optional remote entry port is a raw pipe where the Viewer's gate decides. Every other header is forwarded as is (`forwardedHeaders`). |
| Phone access | `src/lib/access/phoneAccess.ts`, `bin/tailscale.mjs` | Publishes the Viewer as `https://<machine>.<tailnet>.ts.net` through `tailscale serve`, turns `LLV_TOKEN` on, sets `LLV_TS_HOST` / `LLV_TS_URL` in the Viewer's own environment and restores them at boot. This is the pattern for "a setting that changes the gate, applied without a restart". |
| Onboarding | `src/components/onboarding/OnboardingDialog.tsx`, `src/lib/onboarding/steps.ts` | Steps `engines, agents, phone, voice, tour, check`; a marker written before a new step reads it as "not visited". Re-entry rows live in `ProjectRail.tsx` and `menuEntries.tsx`. |
| Settings | none | There is no Settings page or dialog in the app today (no `src/components/settings`, no `settings.*` i18n keys). The "Settings → Linked installs" place has to be created (§8.1). |

Two facts found in the code change the primary case:

1. **A Delegatus behind a public domain answers 403 on every browser route
   today.** A reverse proxy that keeps the public `Host` (the correct setting)
   delivers `Host: delegatus.example.com`, which `rejectForeignHost` refuses.
   Nothing in the repo declares a public host: there is no `LLV_PUBLIC_URL`,
   and `x-forwarded-proto` is read only to mark a cookie `secure`. The public
   case therefore needs a declared public address before any peer work
   (§3.1). That same pin is also what keeps a public install with `LLV_TOKEN`
   unset from serving its board to the internet, so declaring a public
   address must require the access key (§3.1).
2. **The gateway rewrites `Authorization` on loopback-Host requests.** A peer
   credential sent as `Authorization: Bearer` through an ssh tunnel or a
   Host-rewriting proxy would be replaced by the operator's own credential
   before it reaches the Viewer. The peer credential therefore travels in its
   own header (§2.4).

## 2. Pairing

### 2.1 Roles and words

- **B** is the install being read (it grants). **A** is the install that reads.
- A **grant** lives on B: one peer, its scopes, the sha256 of its token.
- A **link** lives on A: one peer's address, transport, token, and the host id
  A files its rows under.
- A **code** is minted on B for one pairing: short, single use, 10 minutes.

To read both ways, pair twice (each side allows, each side connects). One-step
mutual pairing is deferred (§11).

### 2.2 Flow

```
 B (operator, in Settings)             A (operator, in the connect form)
 ─────────────────────────             ────────────────────────────────
 "Allow a connection", scopes ticked
   POST /api/links/codes      ──►  code K7QM9-XTD2P, expires 10:41
                                   operator reads it to A's screen
                                   types B's address + code
                                   POST /api/links/peers {url, code, name}
                                     A's server checks the URL policy (§3.2)
                  ◄── POST https://b/api/peer/v1/pair {code, install:A}
 verify code: hash match, unexpired,
 unused, attempts left; mint token;
 store sha256(token) in the grant;
 burn the code
                  ──► 200 {grant:{id, token, scopes}, install:B, feeds}
                                     A stores the link (token 0600),
                                     refuses if B's storeId/installId is
                                     already linked (§4.4), pulls at once
```

The browser on A never sees the token and never talks to B: A's Viewer makes
every peer request server-side, so CORS and cookies never enter it.

### 2.3 Code and token

- **Code:** 10 symbols of Crockford base32 (50 bits), shown `K7QM9-XTD2P`,
  case-insensitive, `I`/`L` read as `1` and `O` as `0`. Stored on B as sha256
  with its expiry, scopes and a remaining-attempts counter, so a Viewer
  restart (a deploy) inside the 10 minutes keeps it and a read of B's files
  cannot recover it.
- **Token:** 32 random bytes, base64url. B keeps only its sha256 (compared with
  `tokensMatch`, `src/lib/authToken.ts`). A keeps it in plain text because it
  must send it.
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
| `POST /pair` with a code that matches nothing | the same `401` |
| `POST /pair` with the **exact** code of an expired or used code | `410 {"error":"code-spent"}` |
| `POST /pair` beyond the rate limit | `429 {"error":"rate-limited"}`, `Retry-After` |

An unknown `grantId` is compared against a dummy hash, so timing does not tell
"no such grant" from "wrong token". The `410` is visible only to someone who
already holds the code, so it tells a guesser nothing, and it lets the user
see "expired" apart from "wrong" (§8.4). No endpoint answers anonymously:
there is no public "hello", version or install id.

**Pairing rate limit (in the Viewer process):**

- At most 10 failed pairing attempts per minute in total → `429` for 60 s.
  The limit is global: behind a reverse proxy every caller arrives from the
  proxy's address and `X-Forwarded-For` is whatever the caller wrote, so a
  per-address limit is not trustworthy.
- Every failed attempt while codes are outstanding costs each outstanding code
  one of its 20 attempts; at zero the code is burned and B's screen says
  "This code was burned after too many wrong attempts; make a new one."
  At 20 guesses against 2^50 codes the chance of a hit is about 2·10⁻¹⁴.
- An attacker can burn codes to annoy the owner; the owner makes a new one.
  That trade is accepted.

### 2.6 Revoke

- **On B:** remove the grant row. The next request from A gets `401`; A marks
  the link `revoked` and stops pulling. What A already read stays on A.
- **On A:** "Remove" calls `DELETE /api/peer/v1/grant` with its own token (B
  deletes that grant), then removes the link. If B is unreachable, A removes
  the link anyway and says "{B} could not be told; remove this install from its
  list too." B's row keeps showing "last used", so a stale grant is visible.
- **Rows already read from B** on removal: the user chooses "Remove and keep
  its history" (the host stays on /activity as "no longer linked, read up to
  …") or "Remove and delete its history" (`forgetHost`).

### 2.7 Threat model (read grants)

| Threat | What happens | Mitigation |
|---|---|---|
| Token at rest on B | B holds hashes only | a copy of B's state yields no usable token |
| Token at rest on A | plain text in `<state>/links/peers.json` (0600, dir 0700, like `records.sqlite` and `service.env`) | readable by A's operator uid, root, the Viewer container, and every agent Delegatus runs on A as that uid. A keyring is not used: the Docker install has no Secret Service. Blast radius below. |
| Stolen token | the thief reads B's activity feed (fields in §5) until revoked | read-only scope; no write, no transcript, no spawn; B shows "last used" and the last caller address per grant; revoke on B |
| Transport sniffing | HTTPS: nothing. LAN http: the code, the token and every page are readable on that network | plain HTTP only to private addresses (§3.2) with a visible warning; dispatch grants refuse it outright (§10.4) |
| Replay | a replayed feed read returns the same or newer rows, which the thief could read with the token anyway; a replayed pair hits a burned code (`410`) | HTTPS; single-use codes |
| Code guessing | 50-bit code, 20 attempts per code, 10 failures/min globally | §2.5 |
| Peer lies about its host id | nothing to lie with: A files B's rows under the host id **A** chose at pairing, never one B sends | rows can never land under `''` (A's own) or another peer's id; `pullHost` writes only under its `host` argument |
| Peer sends forged or hostile data | B could invent activity; that is inside the trust the pairing grants | every row validated by `parseRemoteRow` / `parseRemoteTurn` (whole page or nothing), 64 MB answer cap, 90 s timeout, no redirects followed |
| Address now answers as another install | `install.id` differs from the one recorded at pairing | refused, error `install-changed`, nothing stored |
| DNS rebinding of A's check | a name resolves to a private address at check and a public one at connect | A resolves once and connects to the address it checked, sending the name in `Host` / SNI |
| A is itself compromised | the attacker gets A's links (read tokens) | a link's reach is the scopes B granted; read scopes are read-only |

## 3. Reachability without a server of ours

### 3.1 Primary: B has a public HTTPS domain

B runs behind a reverse proxy (Caddy, nginx, Traefik) that terminates TLS for
`https://delegatus.example.com` and forwards to the runtime host on the same
box.

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
  (the `phoneAccess.ts` pattern), and `allowedHostNames()` in
  `src/lib/sameOrigin.ts` adds it beside `LLV_TS_HOST`, so the operator can use
  B's UI at its domain.
- **Refusals when saving:**
  - a public address (neither loopback nor private) while `LLV_TOKEN` is unset
    is refused, because adding it to the Host pin would open the board to the
    internet. The message offers to turn the access key on, the same key phone
    access uses;
  - an `http://` address that is not loopback or private is refused (§3.2).
- **"Check this address".** B mints a one-time nonce, fetches
  `POST {publicUrl}/api/peer/v1/self-check` from itself with
  `X-Delegatus-Self: <nonce>`, and expects `204`. Outcomes shown:
  - "Reachable at this address" (and the date checked);
  - "The certificate is not valid" (TLS failure);
  - "This server could not reach its own address. Other machines may still
    reach it." A server often cannot reach its own public name (hairpin NAT),
    so a failed check warns and never blocks;
  - "Your proxy replaces the address it was called at": the self-check arrived
    at the Viewer with a loopback `Host`. With the gateway's trusted local
    entry that means **every internet request would be vouched for as the
    operator**. The message says to keep the `Host` header in the proxy
    (Caddy does by default; nginx needs `proxy_set_header Host $host`) or to
    point the proxy at the remote entry port. This is the one misconfiguration
    that turns a peer link into an open board, and the check is the only place
    that can see it.
  To anyone without the nonce the self-check route answers the §2.5 `401`.

**Install id.** `installId` (a UUID) and a label (the machine's hostname,
editable) are minted into `self.json` on first use. They name the install to
its peers; they are not the activity host id (A chooses that).

### 3.2 URL policy, enforced on the caller (A)

The token's secrecy is decided by whoever sends it, so A checks before any
request, and again after DNS resolution:

| Target | `https://` | `http://` |
|---|---|---|
| loopback (`127.0.0.0/8`, `::1`) | allowed | allowed (ssh tunnel, same box) |
| private: `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`, `100.64/10` (Tailscale, CGNAT) | allowed | allowed with the warning "anyone on this network can read what is sent" |
| anything else (public) | allowed, certificate verified against the system CAs | **refused**, error `http-public`, nothing sent |

- A name counts as private only if **every** address it resolves to is
  private; A then connects to the resolved address.
- Redirects are never followed; a `3xx` is the error `not-delegatus`. An
  HTTPS peer therefore cannot bounce A to plain HTTP or to another host.
- There is no "ignore certificate errors" switch. A self-signed LAN box uses
  `http://` on its private address, or Tailscale; certificate pinning is
  deferred (§11).
- B adds one rule of its own: "Allow a connection" is disabled while B's
  saved public address is plain `http://` on a public host, since no peer
  could legally reach it.

### 3.3 Secondary transports

| Transport | How | Work needed |
|---|---|---|
| Tailscale | phone access already publishes B at `https://<machine>.<tailnet>.ts.net`, gated by `LLV_TOKEN`, with a valid certificate. For the link it is the public-HTTPS case exactly; `100.64/10` also allows `http://` to a tailnet IP. | none beyond §3.1; "use the Tailscale address" is one suggestion |
| LAN | B binds a LAN address (`delegatus --hostname 0.0.0.0`, `bin/cli.mjs`) or a LAN proxy; A uses `http://192.168.x.y:port` | warning shown; nothing else |
| ssh tunnel | `ssh -L 18898:127.0.0.1:8898 b`; A links `http://127.0.0.1:18898`. The dedicated peer header survives the gateway (§2.4). The user keeps the tunnel alive. | none |
| ssh pull | #2159's `pull.ts`, kept as is. The connect form's "Connect over ssh instead" writes an ssh link (an alias from the operator's ssh config) so no file is edited. `activity/hosts.json` `pull` entries keep working and show in the list as "set in hosts.json". | form option; links store reads both |
| push (B → A) | when B cannot be reached from A (a laptop behind NAT, A a public server), B sends its pages to A (§4.6) | slice 3 |

### 3.4 What the user sees when a peer is unreachable

The hosts table and the link row say, in words: "Could not reach {name} since
{time}. What was read before then is kept; the time after it shows as
unknown." The span after the last good read stays hatched "Unknown" on
/activity (existing `storeSource` behaviour), so a gap is never silent.
Retries follow the normal interval; "Read now" retries at once.

## 4. Sync protocol for activity

### 4.1 Pull endpoint (on B)

```
GET /api/peer/v1/activity?after=<version>&limit=<n>
X-Delegatus-Peer: <grantId>.<token>
Accept: application/x-ndjson
```

`after` is clamped to `≥ 0`, `limit` to `1..5000` (the ssh page is 5000,
`PULL_PAGE_ROWS`). `200 application/x-ndjson`, `Cache-Control: no-store`. The
body is the ssh reader's format, so `parseState`, `parseRemoteRow` and
`parseRemoteTurn` in `pull.ts` read both transports:

```
{"type":"state","v":1,"state":"read","install":"<installId>","now":1790300000000,
 "coveredFrom":…,"coveredUntil":…,"readAt":…,"excluded":{…},
 "latest":81234,"storeId":"<uuid>","more":true}
{"type":"input","key":"m:<64 hex>","version":81001,"at":…,"project":"repo-<32 hex>",
 "kind":"message","surface":"phone","hash":"<64 hex>","conversation":"<32 hex>","ids":["m:<64 hex>"]}
{"type":"turn","key":"t:<64 hex>","version":81002,"conversation":"<32 hex>","project":…,
 "engine":"codex","role":"architect","pipelineId":…,"stageId":…,"start":…,"end":…}
```

The handler reads in one read transaction with `localRowsAfter` and
`localTurnsAfter` (limit + 1 each, merged by version, cut to `limit`: the
smallest `limit` versions of the union always lie inside the first `limit + 1`
of each table, as `REMOTE_READER` already does) and `hostState('')`. A B with
no activity store answers `{"type":"state","v":1,"state":"no-ingest"}`.

Errors: the §2.5 `401`; `429` with `Retry-After` when B is busy (§4.5); `503`
when the store cannot be read.

### 4.2 Why the cursor never skips or doubles

- **Cursor = B's version.** Every write of a row, new or merged, takes the next
  value of the one counter inside `BEGIN IMMEDIATE` (`store.transaction`,
  `nextVersion`). SQLite admits one writer at a time, so a version is visible
  only after every lower one has committed: a reader that saw version N can
  never later meet a newly committed row below N. No gap.
- **A merged row reappears** with a new version, and A replaces its copy
  (`upsertPulled` updates only when the incoming version is higher). No
  duplicate, and a replayed or overlapping page changes nothing.
- **B never deletes its own rows** (`forgetHost` refuses host `''`). If a later
  retention rule deletes local rows, the feed needs tombstone lines first
  (noted in §6).
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

### 4.4 A recreated store, a reinstalled peer, the same peer twice

- **Store recreated** (`storeId` changed or `latest < cursor`): the existing
  rule, `forgetHost` and one full read (`pull.ts`).
- **Different install** (`install` ≠ the id recorded at pairing): refused
  (`install-changed`). A reinstall loses the grants file with the state, so
  the user pairs again anyway.
- **Same install linked twice** (for example once over ssh and once over
  HTTPS under two host ids would double every row): A records each link's
  `storeId` (the ssh reader already returns it as `remoteStore`) and refuses a
  second link whose `storeId` or `installId` matches: "This is the same install
  as {name}, already linked."

### 4.5 Versions and backpressure

- **Path version** `/api/peer/v1/`: a breaking change is `/v2/`, and B serves
  both while any supported version reads v1.
- **Line version** `state.v`: fields are only added within `v: 1`; A ignores
  unknown fields and refuses an unknown `v` with the error `version` ("{name}
  runs a Delegatus this one cannot read; update the older one").
- **Unknown row types** are skipped but their `version` still advances the
  cursor, so a newer B that adds a row kind never stalls an older A. A known
  type that fails validation refuses the whole page (`malformed`), as today.
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

### 4.6 Push (B sends to A, slice 3)

For B that A cannot reach. Paired the same way with the direction reversed: A
mints the code with "It will send its activity here" and names the host;
B connects with A's address and the code, and the pair answer tells B this
grant is `activity:push`.

```
GET  /api/peer/v1/push/activity            → {"v":1,"host":"laptop","cursor":81234,"storeId":"<uuid>"|null}
POST /api/peer/v1/push/activity            body: one pull page (state line + rows, NDJSON, ≤ 16 MB)
                                           → {"v":1,"cursor":83000,"changed":1766}
```

- **A holds the cursor.** B asks where A is, then sends pages after it. A
  applies each page with the same `upsertPulled*` and cursor update as a pull
  and answers its new cursor, so a lost answer or a resent page changes
  nothing.
- A `storeId` that differs from the one A holds makes A forget the host and
  answer `cursor: 0`; B starts over.
- Rows go under the host id bound to the grant on A, never a name B sends.
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
| `key`, `ids` | `m:`/`h:`/`k:` + sha256 of an engine message id, prompt id, delivery key or request key under a fixed domain string (`humanInput.ts`) | no |
| `version` | B's write counter | no |
| `at` | when the input was sent (ms) | no |
| `project` | the project key: `repo-<32 hex>` (hash of the canonical remote), `dir-<32 hex>` (hash of the resolved directory path), an operator alias slug, or `project_unresolved` (`src/lib/projects/identity.ts`) | an alias slug is a name the operator chose; the hashed keys reveal only a path or remote someone already guesses exactly |
| `kind` | `message, dialog, answer, spawn, voice, decision, pipeline, task` | no |
| `surface` | `desktop, tablet, phone, other, terminal, unknown` | no |
| `hash` | sha256 of the normalized message text under a fixed domain string | **a holder can confirm a guessed short text** ("ok", "continue", "так"), because the domain string is public. Long texts are not recoverable. |
| `conversation` | 32 hex of sha256 over the registry conversation id or the transcript path | no (a guessed exact path can be confirmed) |

Per agent turn (`activity_turns`): `key`, `version`, `conversation` digest,
`project` key, `engine` (`claude`/`codex`), `role` id, `pipelineId`,
`stageId`, `start`, `end`.

Per page: B's read span (`coveredFrom`, `coveredUntil`, `readAt`), exclusion
counts by reason, `latest`, `storeId`, `installId`, B's clock `now`.

**Never:** message text, titles, file paths, cwd, account names or emails,
tokens, transcript content, project display names.

Pairing adds B's label (hostname by default, editable), `installId`, Delegatus
version and feed list, and A's label, `installId` and version to B. The grant
row on B also records the address the last request came from.

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
"delete its history".

## 6. Answer: can the current ssh pull leak data?

The operator's question, about #2159's `pull.ts` as it stands.

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

**What runs on B:** the reader, as the operator's ssh user, with
`$HOME/.bun/bin/bun` or the `bun` on that user's PATH. It opens only
`activity/records.sqlite`, read-only, and writes nothing. Anyone who controls
that user's home or PATH on B controls that binary, but they already control
B's data.

**Wrong host:** `-o BatchMode=yes` never prompts, so an unknown or changed host
key fails the connection (`unreachable`); the reader
cannot be sent to an impostor unless the operator's `known_hosts` already
trusts it.

**Where it is stored and who can read it:** §5.3, the same file and readers as
any HTTP link.

**Third parties:** none. The only network path is the operator's own ssh to
the alias.

**Residual exposure, stated plainly:**

1. Short messages can be confirmed from `hash` by anyone holding the rows
   (§5.1).
2. Every agent on A can read B's rows, because they run as the same uid.
3. Other local accounts on B see the pull's command line (numbers, maybe a
   path) while it runs.
4. With `LLV_TOKEN` off on A, other local accounts on A can read the
   aggregate report over loopback.

None of these sends message text, paths or credentials anywhere, and none
involves a third party. Items 1 and 2 hold equally for HTTP links.

## 7. Extension path for other metadata

The protocol generalizes by feed name, scope and envelope, without a redesign:

- **One URL shape:** `GET /api/peer/v1/<feed>`, the same header, the same
  §2.5 guard, the same `state` line (`v`, `install`, `now`, `storeId`,
  `more`).
- **Two feed kinds:**
  - **log feeds** (large, append-mostly: activity, later conversation
    summaries): `?after=<version>&limit=`, rows with `type`, `key`, `version`;
    A upserts by `(host, key)`. Anything whose source can delete rows emits
    `{"type":"gone","key","version"}` tombstones.
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
`{ suggestedName?: string; onLinked(link) }`. It holds the address, the code,
the name A files the host under (prefilled from B's label after pairing, or
from `suggestedName`), and a disclosure "Connect over ssh instead" (an ssh
alias). It posts to `POST /api/links/peers` or `POST /api/links/peers/ssh`
and renders the §8.4 errors under the field they concern.

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
│ │ workstation · LAN http  http://<lan-address>:8898             │ │
│ │ ⚠ Plain http on a local network: anyone on it can read this. │ │
│ │ Could not reach workstation since 09:12. Earlier data kept.   │ │
│ │                                   [Read now] [Rename] [Remove]│ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ old-vps · ssh  alias old-vps · set in hosts.json              │ │
│ │ Last read 2 min ago · caught up                               │ │
│ └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ Can read this install                                             │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ laptop · activity · since 25 Sep · last used 3 min ago        │ │
│ │ from 203.0.113.7                                    [Revoke]  │ │
│ └───────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

- **Link row fields:** name, transport badge (HTTPS, LAN http, Tailscale, ssh,
  "Sends here" for push), address; **last read** (A's time of the last pull
  that finished); **lag** ("caught up" when B's skew-corrected `coveredUntil`
  is within the interval plus 10 minutes of now, otherwise "{n} behind");
  **error** in words (§8.4); clock offset when above 2 minutes; row count.
  Actions: Read now, Rename (the display label only; the host id is fixed),
  Remove (with the keep or delete history choice, §2.6).
- **Grant row fields:** name, scopes, created, last used, last address. Action:
  Revoke.
- **"Allow a connection"** opens:

```
┌ Allow a connection ─────────────────────────────┐
│ On the other machine, choose "Connect to another │
│ install" and enter:                              │
│   Address  https://delegatus.example.com  [Copy] │
│   Code     K7QM9-XTD2P                    [Copy] │
│   Expires in 9:41 · works once                   │
│ It may:  ☑ read this install's activity          │
│          ☐ send its activity here (push)         │
│                                    [Cancel code] │
└──────────────────────────────────────────────────┘
```

  Disabled, with the reason, while this install has no saved address or its
  address is plain http on a public host. The countdown reaching zero turns
  the panel into "Expired" with "Make a new code". A successful pairing
  replaces the panel with "Connected: {name} can now read this install."
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
  {date}".

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
| `rate-limited` (429) | Too many attempts. Wait a minute, then make a new code. | Забагато спроб. Зачекайте хвилину, потім створіть новий код. |
| `http-public` | This address is on the internet and starts with http://. Delegatus sends access keys to internet addresses only over https://. Enter the https:// address of that install. | Ця адреса в інтернеті й починається з http://. Delegatus надсилає ключі доступу на інтернет-адреси лише через https://. Вкажіть https://-адресу тієї інсталяції. |
| `tls` | The certificate at that address is not valid, so nothing was sent. | Сертифікат за цією адресою недійсний, тому нічого не надіслано. |
| `unreachable` / `timeout` | Could not reach {name} since {time}. What was read before then is kept; the time after it shows as unknown. | Не вдається з'єднатися з {name} з {time}. Прочитане раніше збережено; час після цього показано як невідомий. |
| `revoked` | {name} no longer lets this install read it: access was revoked there. Ask for a new code to connect again. | {name} більше не дозволяє цій інсталяції читати дані: доступ відкликано там. Попросіть новий код, щоб під'єднатися знову. |
| `not-delegatus` | That address answers, but not as a Delegatus that can link. Check the address, or update Delegatus there. | Ця адреса відповідає, але не як Delegatus, що підтримує зв'язування. Перевірте адресу або оновіть там Delegatus. |
| `version` | {name} runs a Delegatus version this one cannot read. Update the older one. | {name} працює на версії Delegatus, яку ця не може прочитати. Оновіть старішу. |
| `install-changed` | That address now answers as a different install. Nothing was read. If it was reinstalled, remove this link and connect again. | За цією адресою тепер інша інсталяція. Нічого не прочитано. Якщо її перевстановили, видаліть цей зв'язок і під'єднайтеся знову. |
| `same-install` | This is the same install as {name}, which is already linked. | Це та сама інсталяція, що й {name}, вона вже під'єднана. |
| `no-ingest` | {name} has not recorded any activity yet. Update it to a version that records activity. | {name} ще не записав жодної активності. Оновіть його до версії, що записує активність. |
| `malformed` | {name} sent data this install could not read. Nothing from that answer was stored. | {name} надіслав дані, які ця інсталяція не змогла прочитати. З цієї відповіді нічого не збережено. |
| LAN warning | Plain http on a local network: anyone on this network can read what is sent. | Звичайний http у локальній мережі: будь-хто в цій мережі може прочитати те, що передається. |
| public address without key | A public address needs the access key on, or anyone on the internet could open this board. Turn on the access key first. | Для публічної адреси потрібен ключ доступу, інакше будь-хто в інтернеті зможе відкрити цю дошку. Спершу увімкніть ключ доступу. |
| proxy rewrites Host | Your proxy replaces the address it was called at. That can open this board to the internet. Keep the Host header in the proxy, or point it at the remote entry port. | Ваш проксі підміняє адресу, за якою до нього звернулися. Це може відкрити дошку для інтернету. Збережіть заголовок Host у проксі або спрямуйте його на порт віддаленого входу. |
| code burned | This code was burned after too many wrong attempts. Make a new one. | Цей код анульовано після забагатьох хибних спроб. Створіть новий. |

## 9. Operator-facing API (A's and B's own UI)

Same-origin browser routes, behind `rejectCrossOrigin` and the normal gate:

```
GET    /api/links                     self, links (outbound), grants (inbound), open codes
PUT    /api/links/self                {label?, publicUrl?}      → self | {code: "http-public" | "needs-access-key"}
POST   /api/links/self/check          → {state: "ok" | "tls" | "unreachable-from-self" | "host-rewritten", checkedAt}
POST   /api/links/codes               {scopes: ["activity:read"] | ["activity:push"], hostName?} → {id, code, expiresAt}
DELETE /api/links/codes/<id>
POST   /api/links/peers               {url, code, name}         → link | {code: <§8.4 code>}
POST   /api/links/peers/ssh           {alias, name}             → link
POST   /api/links/peers/<id>/read     → the pull result
DELETE /api/links/peers/<id>?history=keep|delete
DELETE /api/links/grants/<id>
```

Peer routes (§2.5 guard): `POST /pair`, `GET /info`, `GET /activity`,
`DELETE /grant`, `GET|POST /push/activity`, `POST /self-check`, all under
`/api/peer/v1/`.

Files, all under `<state>/links/`, 0600 in a 0700 directory, written
atomically: `self.json`, `peers.json` (links, tokens), `grants.json` (grant
hashes, code hashes). They are created on the first operator action, never at
startup, so no `assertStateStartupMutation` step is involved; the Viewer
(owner `viewer`) is the only writer. `readHostsConfig` gains the links as
expected hosts beside `activity/hosts.json`; an id present in both is the link.

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
  - B chooses cwd, engine, model and account; A names only a project key and a
    preset;
  - per-grant run limit, on top of B's normal admission fence;
  - every dispatched task and run carries "from {A}" on B's board and in its
    lifecycle events;
  - revoke on B, optionally stopping the grant's runs;
  - "last used" and last address per grant.
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
| Relay, rendezvous or any hosted helper | excluded by the requirement: no server of ours |
| Telegram connector as a transport | it would route data through a third party (Telegram), against §5.2 |
| Transitive relay (A reads C through B) | one path per host keeps dedupe and trust simple (§4.2) |
| Retention limits on pulled rows | the store is about 15 MB for a full history (#2159 measurement) |
| Answering a remote run's decision from A | a write over the link; B's board answers it in the first cut |
| Other feeds (conversations, tasks, liveness) | extension path in §7; built only when a slice needs them |
| Moving `activity/hosts.json` into the links store | both are read; a migration would be a startup mutation for no user-visible gain |

## 12. Validation against the requirement

| Requirement | Where met |
|---|---|
| one install reads another's activity; /activity sees the whole picture | §4, §8.3 |
| later metadata (conversations, tasks, agent state) | §7, §10.1 |
| no ssh needed, no server of ours, no central user database | §2, §3, §5.2; ssh stays one transport (§3.3) |
| pull over an HTTP endpoint, configured by the user | §4.1; configured in the UI only (§8) |
| no duplicates, no silent gaps, resumable | §4.2, §4.4, §3.4 |
| public HTTPS domain first; http refused for public addresses | §3.1, §3.2 |
| endpoints closed without a token; uniform 401; rate-limited pairing | §2.4, §2.5 |
| exactly which fields leave; no third party | §5 |
| an install behind a proxy learns and shows its public URL | §3.1 |
| does the ssh pull leak data | §6 |
| Settings section, onboarding step, hosts-table entry; one form | §8 |
| error states in plain words, en and uk | §8.4 |
| projects sync and dispatch under a separate grant, after the activity slices | §10, slices 4 and 5 |

## 13. Slices

Every slice runs its tests by path, against isolated state directories
(`LLV_STATE_DIR` per install, ports bound to `0`), never the operator's live
state (AGENTS.md). UI slices bring rendered evidence through the existing
drivers (a `describe` block in
`src/components/mobile/issue1671Evidence.browser.test.tsx` for 390 px, the same
driver at desktop width), with no new driver file.

### Slice 1 — pair and pull activity over HTTPS, managed in Settings

Scope: `self.json` / `peers.json` / `grants.json`; public address with the
access-key refusal, Host pin extension (`LLV_PUBLIC_HOST`) and self-check;
codes, pairing, grants, revoke; the `/api/peer/` proxy exemption and the §2.5
guard; rate limit; URL policy; `GET /activity` and `GET /info`; an HTTP
transport for `pullHost` (the transport interface becomes "fetch one page →
NDJSON text"; ssh keeps shipping the reader); links as expected hosts in
`readHostsConfig`; `startDuePulls` over links; the Settings dialog with
Linked installs (this install, Allow a connection, Connect, rows, Revoke),
`LinkConnectForm`, en and uk strings.

Acceptance:
- two isolated installs pair by address and code; A's /activity shows B's
  rows under the chosen host id within one interval;
- wrong code → `code-rejected`; the exact expired or used code → `code-spent`;
  11th failure in a minute → `rate-limited`; 20 failures burn open codes;
- every unauthenticated request under `/api/peer/` (no header, wrong token,
  unknown grant, unknown path, missing scope) gets a byte-identical `401`;
- `http://` to a public address is refused before any connection; `http://`
  to a private address works and shows the warning; a `3xx` is not followed;
- with `LLV_TOKEN` set, peer routes still require the peer header, and neither
  the operator cookie nor the operator bearer is accepted there;
- revoke on B → A shows `revoked` on its next pull; remove on A deletes B's
  grant;
- a public address cannot be saved while `LLV_TOKEN` is off.

Tests: code mint, verify, expiry, single use and burn under fake timers;
guard uniformity (compare status, headers and bodies); `src/proxy.test.ts`
for the exemption; URL policy table including a name resolving to mixed
public and private addresses; `deploymentProxy.test.ts`: the trusted local
entry forwards `X-Delegatus-Peer` untouched while replacing `Authorization`;
end-to-end: two installs, pull across three pages with `limit=2`, a replayed
page changes nothing, a recreated store on B is re-read whole, `install`
change refused, an unknown row type skipped with the cursor advanced, the
same store linked twice refused; the Settings section in both viewports.

### Slice 2 — the same form in onboarding and on /activity; ssh in the UI; lag and skew

Scope: onboarding step `machines`; "Connect this machine" and "Add a machine"
on the hosts table; linked-source lines and "Manage"; "Connect over ssh
instead" writing an ssh link; hosts.json ssh entries listed as "set in
hosts.json"; clock offset and skew-corrected caught-up test; "Read now";
remove with keep or delete history.

Acceptance: the one `LinkConnectForm` renders in all three places (asserted by
a DOM test mounting each entry point); a not-connected host row links with
its own id prefilled; a peer 7 minutes ahead shows the offset and is not
reported behind; a marker from before the step lands on it once; an ssh link
made in the UI pulls exactly like a hosts.json entry.

Tests: onboarding DOM test for the new step and marker compatibility;
`hostSources` tests for links as hosts and for skew in `storeSource`;
dashboard DOM test for the row states; rendered evidence at 390 px and
desktop for the step, the hosts table and the dialog.

### Slice 3 — push from an unreachable install

Scope: push scope on codes, `GET|POST /api/peer/v1/push/activity`, B's push
scheduler, "Sends here" rows on A, "Sends to" rows on B.

Acceptance: a B with no inbound route keeps A's /activity current; a resent
page changes nothing; B recreating its store resets A's copy once; A holds
the cursor, so B's restart mid-push resumes without gaps or doubles; a push
without a push grant gets the uniform `401`.

Tests: end-to-end with B pushing to A (isolated), dropped answers and resends,
the store-id reset, `429` handling.

### Slice 4 — projects and boards from linked installs (later phase)

Scope: snapshot feeds `projects` and `board`, scopes `projects:read` and
`board:read` on the Allow screen with the "carries text" note, "also on {B}"
on A's projects, B's board opened read-only.

Acceptance: a `repo-` project on both installs appears once on A with "also on
{B}"; B's board renders read-only with B's name and read time; a grant without
`board:read` cannot read the board (uniform `401`).

### Slice 5 — dispatch to a linked install (later phase)

Scope: the `dispatch` grant with project list and run limit, `capacity`,
`dispatch`, `runs` feed, `cancel`, caller kind `peer` through the existing
admission fence, the "running on {B}" card on A, "from {A}" on B's board.

Acceptance: A starts a pipeline for a task in an allowed project on B and sees
its stages on A's card; a retried dispatch returns the same run; cancel from
A stops it on B; the run continues and A catches up after the link drops;
a dispatch into a project outside the grant, above the run limit, or over
LAN http is refused; revoke with "stop its runs" stops them.

Tests: isolated end-to-end with a stub engine; admission-fence tests for the
`peer` caller kind; the runs feed under reconnect.

## 14. What the repo cannot tell, to be observed or decided

Observed on the operator's machines before slice 1 is accepted:

1. **The public server's proxy.** Which reverse proxy fronts the public
   install, whether it keeps `Host`, and which port it targets (the stable
   port with a trusted local entry, or the remote entry). The self-check
   (§3.1) detects the dangerous combination; the first real deployment still
   needs to be looked at once.
2. **Hairpin reachability.** Whether the release container can reach its own
   public name. It decides whether "Check this address" can succeed there;
   the design only warns when it fails.
3. **`LLV_TOKEN` on the public install.** Today a public-domain install is
   blocked by the Host pin; the first install to declare a public address must
   have the access key on, and the operator should confirm that is how their
   server is run.

Decided by the operator (the design picks a default in each case):

4. **Which install should see the whole picture.** If the public server should
   show a laptop's activity, the laptop cannot be reached and slice 3 (push)
   is required; if only the laptop reads the server, slices 1–2 suffice.
   Default: build push as slice 3.
5. **Plain HTTP on private networks for read grants.** Default: allowed with a
   warning, refused for dispatch. The stricter choice is HTTPS or loopback
   only everywhere.
6. **Code length and life.** Default 10 symbols, 10 minutes, single use, 20
   attempts.
7. **Dispatch at all.** The operator asked for it as a later phase. §10.3
   states that a dispatch grant is code execution on the granting machine; the
   operator should confirm that trade before slice 5 starts, and whether
   request signing must ship with it.
8. **Where Settings lives.** No Settings surface exists; the default is a new
   dialog opened from the rail menu and the phone menu, with Linked installs
   as its first section.
