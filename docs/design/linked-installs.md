# Linked installs: one Delegatus reads another, peer to peer

Status: design, 2026-09-25. Read-only design stage; nothing here is built yet.
Grounded in `main` at `534edaf72`, which is PR #2159 (activity records itself)
merged; every activity file cited below is on `main`.

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
| Own activity store | `src/lib/activity/store.ts` | `<state>/activity/records.sqlite` (0600, dir 0700). Rows keyed `(host, key)`; this host is `host = ''`. One counter `activity_meta.version` rises on every write of an input or a turn; `store_id` is a UUID minted with the file. `localRowsAfter(version, limit)` and `localTurnsAfter(version, limit)` already serve "everything written after a version". `upsertPulled` / `upsertPulledTurns` replace a row only when the sender's version is higher. `hostState` / `setHostState` hold each pulled host's `cursor` and `remoteStore`; `forgetHost` drops a pulled host. |
| ssh pull | `src/lib/activity/pull.ts` | `pullHost(store, host, config, transport)` pages by version cursor, detects a recreated remote store by `store_id` (or `latest < cursor`), takes each row whole or refuses the page (an unknown `type` fails `parseRemoteRow`, `pull.ts:300-306`, so the page is `malformed`), and takes the remote's read span only with the last page. The wire format is NDJSON: one `state` line (`v: 1`), then `input` / `turn` lines. Only the transport is ssh-specific (`sshTransport` at `pull.ts:129`, `REMOTE_READER`). |
| Host list | `src/lib/activity/hostSources.ts` | `activity/hosts.json` (`{ v: 1, local, hosts: [{ id, label, projects, since, pull? }] }`) names expected hosts; `storeSource("pull", …)` turns a pulled host's `activity_hosts` row into coverage, `readAt`, `error`. Host ids match `/^[a-z0-9][a-z0-9._-]{0,62}$/` (`validHostId`, `humanInput.ts`). |
| Schedule | `src/lib/activity/continuous.ts` | After each ingest pass, `startDuePulls` pulls every host whose interval passed, one at a time, beside the index queue. |
| Hosts table | `src/components/activity/ActivityDashboard.tsx`, `HostsTable` | One row per expected host with a line per source: last read, last error (`unreachable`, `timeout`, `no-ingest`, `malformed`), "not connected". |
| Access gate | `src/proxy.ts` | `LLV_TOKEN` unset: every request passes. Set: cookie `llv_auth`, `Authorization: Bearer`, or `?k=` link, compared with `tokensMatch` (`src/lib/authToken.ts`, sha256 + `timingSafeEqual`). `/api/artifact/frame/` is already exempt because it authorizes itself (`FRAME_PREFIX`, `proxy.ts:7`). |
| Host pin | `src/lib/sameOrigin.ts` | `rejectCrossOrigin` / `rejectForeignHost` admit only a `Host` of `localhost`, `127.0.0.1`, `::1` or `LLV_TS_HOST` (`allowedHostNames`, `sameOrigin.ts:32`). Every browser route calls it. |
| Gateway | `src/runtime-host/deploymentProxy.ts` | The runtime host's stable port (8898, bound to `127.0.0.1`). With `viewer-gateway.json` `{ remoteEntryPort, localEntry: "trusted" }`, `serveViewerLocalEntry` replaces the `Authorization` header of any request whose `Host` is loopback (`isLoopbackHost`, `:209`; `vouchedCredential`, `:274-302`) with the release's own credential. The remote entry (`remoteEntryPort`, also loopback, 8897 in `docs/docker.md`) is a raw pipe where the Viewer's gate decides. Every other header is forwarded as is (`forwardedHeaders`). `src/runtime-host/viewerEntries.ts` records which ports were bound (`readViewerEntries`). |
| Phone access | `src/lib/access/phoneAccess.ts`, `bin/tailscale.mjs` | Publishes the Viewer as `https://<machine>.<tailnet>.ts.net` through `tailscale serve`, turns `LLV_TOKEN` on, sets `LLV_TS_HOST` / `LLV_TS_URL` in the Viewer's environment and restores them at boot. `dockerTailnetEntry` (`phoneAccess.ts:137-154`) targets the remote entry, and the press refuses (`TRUSTED_ENTRY`, `:263`) to publish a stable port that is a trusted local entry. This is the pattern §3.1 reuses. |
| Onboarding | `src/components/onboarding/OnboardingDialog.tsx`, `src/lib/onboarding/steps.ts` | Steps `engines, agents, phone, voice, tour, check`; a marker written before a new step reads it as "not visited". Re-entry rows live in `ProjectRail.tsx` and `menuEntries.tsx`. |
| Settings | none | There is no Settings page or dialog in the app today (no `src/components/settings`, no `settings.*` i18n keys). The "Settings → Linked installs" place has to be created (§8.1). |

Three facts found in the code shape the primary case:

1. **A Delegatus behind a public domain answers 403 on every browser route
   today.** A reverse proxy that keeps the public `Host` delivers
   `Host: delegatus.example.com`, which `rejectForeignHost` refuses. Nothing in
   the repo declares a public host: there is no `LLV_PUBLIC_URL`, and
   `x-forwarded-proto` is read only to mark a cookie `secure`. The public case
   therefore needs a declared public address before any peer work (§3.1). That
   same pin also keeps a public install with `LLV_TOKEN` unset from serving its
   board to the internet, so declaring a public address must require the
   access key.
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

## 2. Pairing

### 2.1 Roles and words

- **B** is the install being read (it grants). **A** is the install that reads.
- A **grant** lives on B: one peer, its scopes, the sha256 of its token.
- A **link** lives on A: one peer's address, transport, token, and the host id
  A files its rows under. A host id belongs to exactly one link or push grant;
  a second one cannot take it.
- A **code** is minted on B for one pairing: a public id plus a secret, single
  use, 10 minutes.

To read both ways, pair twice (each side allows, each side connects). One-step
mutual pairing is deferred (§11).

### 2.2 Flow

```
 B (operator, in Settings)             A (operator, in the connect form)
 ─────────────────────────             ────────────────────────────────
 "Allow a connection", scopes ticked
   POST /api/links/codes      ──►  code R4TZ-K7QM9-XTD2P, expires 10:41
                                   operator reads it to A's screen
                                   types B's address + code
                                   POST /api/links/peers {url, code, name}
                                     A's server checks the URL policy (§3.2)
                  ◄── POST https://b/api/peer/v1/pair {code, install:A}
 look up the code by its id; verify
 the secret hash, unexpired, unused,
 attempts left; mint token; store
 sha256(token) in the grant; burn it
                  ──► 200 {grant:{id, token, scopes}, install:B,
                           storeId, feeds}
                                     A refuses if storeId is its own store
                                     or another link's (§4.4), else stores
                                     the link (token 0600) and pulls at once
```

The browser on A never sees the token and never talks to B: A's Viewer makes
every peer request server-side, so CORS and cookies never enter it.

### 2.3 Code and token

- **Code:** `IIII-SSSSS-SSSSS` in Crockford base32, case-insensitive, `I`/`L`
  read as `1` and `O` as `0`. The first 4 symbols are the code's **public id**
  (a lookup handle that anyone may see); the next 10 are the **secret** (50 bits).
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

An unknown `grantId` or code id is compared against a dummy hash, so timing
does not tell "no such grant" from "wrong token". The `410` is visible only to
someone who holds the whole code, so it tells a guesser nothing, and it lets
the user see "expired" apart from "wrong" (§8.4). No endpoint answers
anonymously: there is no public "hello", version or install id.

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
  delete its history" (`forgetHost`). Until slice 3 adds the choice, removal
  keeps the history (§13).

### 2.7 Threat model (read and push grants)

| Threat | What happens | Mitigation |
|---|---|---|
| Internet caller sends `Host: 127.0.0.1` through B's proxy | if the proxy reaches a trusted local entry, the gateway vouches for it as the operator: full board and spawn | a public address is refused unless it maps to a non-vouching entry, and the self-check sends exactly this request and fails loudly when it is vouched (§3.1) |
| Token at rest on B | B holds hashes only | a copy of B's state yields no usable token |
| Token at rest on A | plain text in `<state>/links/peers.json` (0600, dir 0700, like `records.sqlite` and `service.env`) | readable by A's operator uid, root, the Viewer container, and every agent Delegatus runs on A as that uid. A keyring is not used: the Docker install has no Secret Service. Blast radius below. |
| Stolen read token | the thief reads B's activity feed (fields in §5) until revoked | read-only scope; no write, no transcript, no spawn; B shows per grant "last used" and request counts (today, last 7 days), so a second reader shows as a doubled count; revoke on B. B does not show a caller address: behind a same-box proxy every request arrives from `127.0.0.1`, and `X-Forwarded-For` is caller-written (§11). |
| Stolen push token | the thief writes invented rows into A's store under that host | per-grant daily row and byte budget and a total row cap per linked host (§4.6); A shows the stop; revoke on A |
| Transport sniffing | HTTPS: nothing. LAN http: the code, the token and every page are readable on that network | plain HTTP only to loopback and RFC 1918 / link-local addresses (§3.2) with a visible warning; `100.64/10` is not among them; dispatch grants refuse plain HTTP outright (§10.3) |
| Replay | a replayed feed read returns the same or newer rows, which the thief could read with the token anyway; a replayed pair hits a burned code (`410`); a replayed push page is refused by its base check (§4.6) | HTTPS; single-use codes |
| Code guessing | 50-bit secret, 20 attempts per code, 5 per minute | §2.5 |
| Peer lies about its host id | nothing to lie with: A files B's rows under the host id **A** chose at pairing, never one B sends | rows can never land under `''` (A's own) or another peer's id; `pullHost` writes only under its `host` argument |
| Peer sends forged or hostile data | B could invent activity; that is inside the trust the pairing grants | every row validated by `parseRemoteRow` / `parseRemoteTurn` (whole page or nothing), 64 MB answer cap, 90 s timeout, no redirects followed, the per-host row cap (§4.6) |
| Address now answers as another install | `install` differs from the one recorded at pairing | refused, error `install-changed`, nothing stored |
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
  `LLV_TS_HOST`, so the operator can use B's UI at its domain.
- **Refusals when saving:**
  - a public address (neither loopback nor private) while `LLV_TOKEN` is unset
    (`needs-access-key`), because adding it to the Host pin would open the
    board to the internet. The message offers to turn the access key on, the
    same key phone access uses;
  - a public address while `publicEntry()` is none (`needs-remote-entry`);
  - an `http://` address that is not loopback or private (`http-public`, §3.2).
- **"Check this address"** runs two probes from B to its own public URL, each
  with a fresh one-time nonce in `X-Delegatus-Self`, both over `node:https`
  with the connection and SNI aimed at the public name:
  1. **Reach:** `POST {publicUrl}/api/peer/v1/self-check` with the public
     `Host`. The route answers a valid nonce with `200 {"host":"<Host it
     saw>","vouched":<bool>}`, where `vouched` is true when the request
     carries an `Authorization: Bearer` equal to the gate key. The probe sends
     no `Authorization`, so a credential on it can only have been added by the
     gateway.
  2. **Spoof:** the same request with `Host: 127.0.0.1`. It passes when the
     proxy refuses it (`421`, `444`, `404` from another site, a closed
     connection) or when it arrives with `vouched: false`. It fails when it
     arrives with `vouched: true`.

  Outcomes shown:
  - "Reachable at this address" (and the date checked): probe 1 answered with
    the public host and `vouched: false`, and probe 2 passed;
  - **"Anyone on the internet can use this board as you"** (`open-to-internet`,
    red): probe 2 arrived vouched, or probe 1 arrived vouched. "Allow a
    connection" is disabled, and the message names the fix: point the proxy at
    the public entry port above, or stop trusting the local entry;
  - "Your proxy replaces the address it was called at" (`host-rewritten`):
    probe 1 arrived with a loopback `Host`. B's Host pin would then admit it
    only as a local request, and on a trusted entry that is the same open
    board; treated as `open-to-internet` when it also arrived vouched;
  - "The certificate is not valid" (TLS failure);
  - "This server could not reach its own address, so the proxy could not be
    checked" (`unverified`): a server often cannot reach its own public name
    (hairpin NAT). This warns, shows the proxy rule with the port, and does not
    block, because nothing more can be seen from inside.

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
- B adds one rule of its own: "Allow a connection" is disabled while B's
  saved public address is plain `http://` on a public host, or its last check
  was `open-to-internet`.

### 3.3 Secondary transports

| Transport | How | Work needed |
|---|---|---|
| Tailscale | phone access already publishes B at `https://<machine>.<tailnet>.ts.net` through the remote entry, gated by `LLV_TOKEN`, with a valid certificate. For the link it is the public-HTTPS case exactly. | none beyond §3.1; "use the Tailscale address" is one suggestion |
| LAN | On the Docker install the runtime host binds 8898 and the Viewer binds to `127.0.0.1`, so a LAN link needs a proxy on B that listens on the LAN address and targets the public entry (§3.1). A CLI install can instead bind `delegatus --hostname 0.0.0.0` (`bin/cli.mjs`), which has no trusted entry. A uses `http://192.168.x.y:port`. | warning shown; the proxy rule is shown in Settings |
| ssh tunnel | `ssh -L 18897:127.0.0.1:<public entry port> b` (8897 on a Docker install with a remote entry); A links `http://127.0.0.1:18897`. **Never** a tunnel to a trusted 8898: every process and account on A would reach B as its operator. The Settings screen shows the tunnel line with the right port. The user keeps the tunnel alive. | none |
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
  ssh reader already sends it), so the check lives in `pullHost` and runs on
  **every page**, before anything is written: when the page's `storeId` equals
  another host's `remoteStore`, the page is refused with `same-install` and
  nothing is stored; when it equals A's own `activity_meta.store_id`, the same
  error says "This is this install". The pair answer carries `storeId` too, so
  an HTTPS pairing is refused before a link is saved. The store gains one
  lookup, `hostWithRemoteStore(storeId)`.

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
    rows of the new kind written before either side learned it;
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
grant is `activity:push`, with the kinds A reads.

```
GET  /api/peer/v1/push/activity   → {"v":1,"host":"laptop","cursor":81234,"storeId":"<uuid>"|null,
                                      "types":["input","turn"]}
POST /api/peer/v1/push/activity?after=81234&storeId=<uuid>
                                    body: one pull page (state line + rows, NDJSON, ≤ 16 MB)
     → 200 {"v":1,"cursor":83000,"changed":1766}
     → 409 {"v":1,"cursor":<A's cursor>,"storeId":<A's held id or null>}   nothing stored
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
"delete its history", bounded by the per-host cap (§4.6).

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

**What runs on B:** the reader, as the operator's ssh user, with
`$HOME/.bun/bin/bun` or the `bun` on that user's PATH. It opens only
`activity/records.sqlite`, read-only, and writes nothing. Anyone who controls
that user's home or PATH on B controls that binary, but they already control
B's data.

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
`{ suggestedName?: string; onLinked(link) }`. It holds the address, the code,
the name A files the host under (prefilled from B's label after pairing, or
from `suggestedName`), and (from slice 3) a disclosure "Connect over ssh
instead" (an ssh alias). It posts to `POST /api/links/peers` or `POST
/api/links/peers/ssh` and renders the §8.4 errors under the field they
concern.

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
  Remove (with the keep or delete history choice from slice 3, §2.6).
- **Grant row fields:** name, scopes, created, last used, requests today and
  in 7 days. Action: Revoke.
- **"Allow a connection"** opens:

```
┌ Allow a connection ─────────────────────────────┐
│ On the other machine, choose "Connect to another │
│ install" and enter:                              │
│   Address  https://delegatus.example.com  [Copy] │
│   Code     R4TZ-K7QM9-XTD2P               [Copy] │
│   Expires in 9:41 · works once                   │
│   No wrong attempts                              │
│ It may:  ☑ read this install's activity          │
│          ☐ send its activity here (push)         │
│                                    [Cancel code] │
└──────────────────────────────────────────────────┘
```

  Disabled, with the reason, while this install has no saved address, its
  address is plain http on a public host, or its last check was
  `open-to-internet`. Opening it re-runs the check (§3.1). "No wrong
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
| `rate-limited` (429) | Too many wrong attempts on this code. Wait a minute and try again, or make a new code. | Забагато хибних спроб із цим кодом. Зачекайте хвилину й спробуйте знову або створіть новий код. |
| `http-public` | This address is on the internet and starts with http://. Delegatus sends access keys to internet addresses only over https://. Enter the https:// address of that install. | Ця адреса в інтернеті й починається з http://. Delegatus надсилає ключі доступу на інтернет-адреси лише через https://. Вкажіть https://-адресу тієї інсталяції. |
| `tls` | The certificate at that address is not valid, so nothing was sent. | Сертифікат за цією адресою недійсний, тому нічого не надіслано. |
| `unreachable` / `timeout` | Could not reach {name} since {time}. What was read before then is kept; the time after it shows as unknown. | Не вдається з'єднатися з {name} з {time}. Прочитане раніше збережено; час після цього показано як невідомий. |
| `revoked` | {name} no longer lets this install read it: access was revoked there. Ask for a new code to connect again. | {name} більше не дозволяє цій інсталяції читати дані: доступ відкликано там. Попросіть новий код, щоб під'єднатися знову. |
| `not-delegatus` | That address answers, but not as a Delegatus that can link. Check the address, or update Delegatus there. | Ця адреса відповідає, але не як Delegatus, що підтримує зв'язування. Перевірте адресу або оновіть там Delegatus. |
| `version` | {name} runs a Delegatus version this one cannot read. Update the older one. | {name} працює на версії Delegatus, яку ця не може прочитати. Оновіть старішу. |
| `install-changed` | That address now answers as a different install. Nothing was read. If it was reinstalled, remove this link and connect again. | За цією адресою тепер інша інсталяція. Нічого не прочитано. Якщо її перевстановили, видаліть цей зв'язок і під'єднайтеся знову. |
| `same-install` | This is the same install as {name}, which is already linked. Nothing was stored. | Це та сама інсталяція, що й {name}, вона вже під'єднана. Нічого не збережено. |
| `same-install` (own store) | This is this install. There is nothing to link. | Це ця сама інсталяція. Під'єднувати нічого. |
| `no-ingest` | {name} has not recorded any activity yet. Update it to a version that records activity. | {name} ще не записав жодної активності. Оновіть його до версії, що записує активність. |
| `malformed` | {name} sent data this install could not read. Nothing from that answer was stored. | {name} надіслав дані, які ця інсталяція не змогла прочитати. З цієї відповіді нічого не збережено. |
| `quota` | {name} sent more than its daily allowance; receiving is paused until {time}. | {name} надіслав більше за денну норму; приймання призупинено до {time}. |
| `quota` (total) | {name} reached its size limit here; nothing more is received from it. Remove its history or the link. | {name} досяг ліміту розміру тут; від нього більше нічого не приймається. Видаліть його історію або зв'язок. |
| LAN warning | Plain http on a local network: anyone on this network can read what is sent. | Звичайний http у локальній мережі: будь-хто в цій мережі може прочитати те, що передається. |
| `needs-access-key` | A public address needs the access key on, or anyone on the internet could open this board. Turn on the access key first. | Для публічної адреси потрібен ключ доступу, інакше будь-хто в інтернеті зможе відкрити цю дошку. Спершу увімкніть ключ доступу. |
| `needs-remote-entry` | This install trusts every request that arrives on port {port} from this machine, so a public proxy cannot point there. Add a remote entry port, or stop trusting the local entry, then save again. | Ця інсталяція довіряє кожному запиту, що надходить на порт {port} з цієї машини, тож публічний проксі не можна спрямовувати туди. Додайте порт віддаленого входу або вимкніть довіру до локального входу, потім збережіть знову. |
| `open-to-internet` | Anyone on the internet can use this board as you: a request that claims to be local passed through your proxy and was trusted. Point the proxy at 127.0.0.1:{port} instead. Connections are disabled until the check passes. | Будь-хто в інтернеті може користуватися цією дошкою від вашого імені: запит, що видає себе за локальний, пройшов через ваш проксі й отримав довіру. Спрямуйте проксі на 127.0.0.1:{port}. Під'єднання вимкнено, доки перевірка не пройде. |
| `host-rewritten` | Your proxy replaces the address it was called at. Keep the Host header in the proxy and point it at 127.0.0.1:{port}. | Ваш проксі підміняє адресу, за якою до нього звернулися. Збережіть заголовок Host у проксі та спрямуйте його на 127.0.0.1:{port}. |
| `unverified` | This server could not reach its own address, so the proxy could not be checked. Make sure it points at 127.0.0.1:{port}. Other machines may still reach it. | Цей сервер не зміг звернутися до власної адреси, тому проксі не перевірено. Переконайтеся, що він спрямований на 127.0.0.1:{port}. Інші машини все одно можуть до нього достукатися. |
| code burned | This code was burned after too many wrong attempts. Make a new one. | Цей код анульовано після забагатьох хибних спроб. Створіть новий. |

## 9. Operator-facing API (A's and B's own UI)

Same-origin browser routes, behind `rejectCrossOrigin` and the normal gate:

```
GET    /api/links                     self, links (outbound), grants (inbound), open codes
PUT    /api/links/self                {label?, publicUrl?}
                                      → self | {code: "http-public" | "needs-access-key" | "needs-remote-entry"}
POST   /api/links/self/check          → {state: "ok" | "tls" | "unverified" | "host-rewritten" | "open-to-internet",
                                         checkedAt, entryPort}
POST   /api/links/codes               {scopes: ["activity:read"] | ["activity:push"], hostName?}
                                      → {id, code, expiresAt} | {code: "open-to-internet" | …}
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
hashes, request counts, code ids and hashes). They are created on the first
operator action, never at startup, so no `assertStateStartupMutation` step is
involved; the Viewer (owner `viewer`) is the only writer. `readHostsConfig`
gains the links as expected hosts beside `activity/hosts.json`; an id present
in both is the link.

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
| Moving `activity/hosts.json` into the links store | both are read; a migration would be a startup mutation for no user-visible gain |

## 12. Validation against the requirement

| Requirement | Where met |
|---|---|
| one install reads another's activity; /activity sees the whole picture | §4, §8.3 |
| later metadata (conversations, tasks, agent state) | §7, §10.1 |
| no ssh needed, no server of ours, no central user database | §2, §3, §5.2; ssh stays one transport (§3.3) |
| pull over an HTTP endpoint, configured by the user | §4.1; configured in the UI only (§8) |
| no duplicates | keyed upsert (§4.2); the same install under two host ids refused on every page (§4.4) |
| no silent gaps | version cursor (§4.2); kinds negotiated so no row sits below a cursor unread (§4.5); push pages carry their base (§4.6); unreachable time shown as unknown (§3.4) |
| resumable | cursor committed with each page (§4.2, §4.6) |
| public HTTPS domain first; http refused for public addresses | §3.1, §3.2 |
| endpoints closed without a token; uniform 401; rate-limited pairing | §2.4, §2.5; the proxy cannot turn a stranger into the operator (§3.1) |
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
`allowedHostNames()`; refusals `needs-access-key`, `needs-remote-entry`,
`http-public`; `publicEntry()` shared with phone access
(`dockerTailnetEntry`); the `/api/peer/v1/self-check` route with its nonce and
the §2.5 `401` for anything else (the `/api/peer/` proxy exemption lands here,
with only this route behind it); the two-probe check; the Settings dialog with
the "This install" section only; en and uk strings for its states.

Acceptance:
- a Viewer with a saved public address serves its browser routes at that
  `Host`; without one, the same `Host` is still refused;
- a public address cannot be saved while `LLV_TOKEN` is off, or while the
  stable port is a trusted local entry with no remote entry;
- behind a stand-in proxy that passes the client's `Host` through, a request
  sent with `Host: 127.0.0.1` through the proxy aimed at the remote entry
  reaches the Viewer **unvouched**, and the check reports `ok`;
- the same proxy aimed at a trusted local entry makes the check report
  `open-to-internet` (the red path is exercised beside the green one);
- a proxy that rewrites `Host` to loopback reports `host-rewritten`; a
  public URL the server cannot reach reports `unverified` and does not block
  saving.

Tests: `sameOrigin` tests for `LLV_PUBLIC_HOST`; the refusal table; a
self-check test that boots a gateway (`serveViewerLocalEntry`, isolated
gateway file, port `0`) and a stand-in pass-through proxy in front of it,
once on each entry, asserting the `vouched` flag the route reports and that
the probe's custom `Host` arrives as sent with the connection aimed elsewhere
(this proves the `node:https` `servername` + `headers.host` split under the
pinned Bun); `src/proxy.test.ts` for the exemption; the Settings section
rendered at 390 px and desktop.

### Slice 2 — pair and pull activity over HTTPS, managed in Settings

Scope: `peers.json` / `grants.json`; codes with public id, pairing, grants,
revoke on B, remove on A (keeps history: the host shows "No longer linked ·
read up to {date}"; the delete choice arrives in slice 3); the §2.5 guard and
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
- wrong secret → `code-rejected` and the open code shows one wrong attempt; a
  request naming no open code changes no counter; the 6th failure on a code
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
store under two host ids refused in both orders; **kind negotiation**: an A
that reads only `input` pulls to the end, then learns `turn` and receives the
turns written before it learned them, with input rows unchanged; a row of an
unrequested kind fails the page; the Settings section in both viewports.

### Slice 3 — the same form in onboarding and on /activity; ssh in the UI; lag and skew

Scope: onboarding step `machines`; "Connect this machine" and "Add a machine"
on the hosts table; linked-source lines and "Manage"; "Connect over ssh
instead" writing an ssh link; hosts.json ssh entries listed as "set in
hosts.json"; the ssh hardening flags (§6); clock offset and skew-corrected
caught-up test; "Read now"; remove with keep or delete history.

Acceptance: the one `LinkConnectForm` renders in all three places (asserted by
a DOM test mounting each entry point); a not-connected host row links with
its own id prefilled; a peer 7 minutes ahead shows the offset and is not
reported behind; a marker from before the step lands on it once; an ssh link
made in the UI pulls exactly like a hosts.json entry; `sshTransport` passes
`StrictHostKeyChecking=yes`, `ForwardAgent=no` and `ClearAllForwardings=yes`;
remove with delete leaves no rows for that host.

Tests: onboarding DOM test for the new step and marker compatibility;
`hostSources` tests for links as hosts and for skew in `storeSource`;
`pull.test.ts` for the ssh argument list; dashboard DOM test for the row
states; rendered evidence at 390 px and desktop for the step, the hosts table
and the dialog.

### Slice 4 — push from an unreachable install

Scope: push scope on codes, `GET|POST /api/peer/v1/push/activity` with the
base check, the daily budget and the per-host cap, B's push scheduler,
"Sends here" rows on A, "Sends to" rows on B.

Acceptance: a B with no inbound route keeps A's /activity current; a resent
page changes nothing; a POST whose `after` is not A's cursor is refused `409`
and stores nothing; two senders pushing from the same cursor: one applies,
the other gets `409` and resumes without gaps or doubles; a POST carrying a
new `storeId` resets A's copy once and stores none of its own rows; B's
restart mid-push resumes; a push over the daily budget gets `quota`, stores
nothing, and A shows the pause; a push without a push grant gets the uniform
`401`.

Tests: end-to-end with B pushing to A (isolated), dropped answers and
resends, a stale-base POST after a reset, concurrent senders, the reset POST,
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
   public entry, never a trusted 8898; the self-check's spoof probe detects a
   violation only when the server can reach its own name. The first real
   deployment should be looked at once by sending `curl
   https://<domain>/api/pipelines -H 'Host: 127.0.0.1'` from outside and
   confirming it is not answered as the operator. That same probe tells
   whether such a server is exposed **today**, before any link exists.
2. **Hairpin reachability.** Whether the release container can reach its own
   public name. It decides whether "Check this address" can verify the proxy
   there or only report `unverified`.
3. **`LLV_TOKEN` and the gateway file on the public install.** The first
   install to declare a public address must have the access key on and, if
   its local entry is trusted, a remote entry port; the operator should
   confirm that is how their server is run.

Decided by the operator (the design picks a default in each case):

4. **Which install should see the whole picture.** If the public server should
   show a laptop's activity, the laptop cannot be reached and slice 4 (push)
   is required; if only the laptop reads the server, slices 1–3 suffice.
   Default: build push as slice 4.
5. **Plain HTTP on private networks for read grants.** Default: allowed with a
   warning on RFC 1918 and link-local addresses, refused on `100.64/10` and
   for dispatch. The stricter choice is HTTPS or loopback only everywhere.
6. **Code shape and limits.** Default 4-symbol id + 10-symbol secret, 10
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
